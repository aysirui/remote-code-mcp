import {
  Injectable,
  HttpException,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common'
import { HttpAdapterHost } from '@nestjs/core'
import { WebSocketServer, WebSocket } from 'ws'
import type { Server as HttpServer, IncomingMessage } from 'node:http'
import { URL } from 'node:url'
import {
  COMMAND_RPC_TIMEOUT_MS,
  RPC_APPROVAL_TIMEOUT_MS,
  RPC_MESSAGE_LIMIT_BYTES,
  ApprovalNoticeSchema,
  ApprovalClosedSchema,
  type RpcRequest,
  type CommandAudit,
} from '@rcm/protocol'
import { Store } from '../../infrastructure/database/store'
import { uid } from '../../common/security'
import { authenticateDevice } from './device-auth'
import { authorizeDeviceRpc } from './device-rpc-authorization'
import { synchronizeDeviceHello, StaleDeviceConnectionError } from './device-workspace-sync'
import { DeviceRpcError, DeviceRpcPending } from './device-rpc-pending'
import { FileTransfers } from './file-transfers'
import { recordDeviceOperation } from './device-operation-audit'
import { ApprovalChannelService, type ApprovalRecipient } from './approval-channel.service'
import type { CardRef } from '@rcm/bot-sdk/cards'
import type { ApprovalNotice, ApprovalEvent } from '@rcm/protocol'

/** 连接身份和卡片关联均仅在当前 RPC 内存中有效。 */
interface ApprovalRoute {
  socket: WebSocket
  /** 原始 RPC 授权的设备及其控制台显示名，只用于通知。 */
  deviceName: string
  recipients: ApprovalRecipient[]
  deadlineAt: number
  workspaceId: string
  operation: RpcRequest['operation']
  approvalId?: string
  expiresAt?: number
  deliveries?: Array<Promise<CardRef | undefined>>
}

/** 设备通道与 RPC 路由服务；不持久化任何工具参数或执行结果正文。 */
@Injectable()
export class DeviceHub implements OnApplicationBootstrap, OnApplicationShutdown {
  /** 传输地址与设备流仅驻留在当前 Server 实例内。 */
  readonly files = new FileTransfers()
  private sockets = new Map<string, WebSocket>()
  private wss: WebSocketServer | undefined
  private upgradeHandler:
    ((req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => void) | undefined
  private readonly rpc = new DeviceRpcPending()
  private readonly approvalRoutes = new Map<string, ApprovalRoute>()

  constructor(
    public store: Store,
    @Optional() private readonly httpAdapter?: HttpAdapterHost,
    @Optional() private readonly channels?: ApprovalChannelService,
  ) {}

  /** NestJS 初始化完成后挂载升级握手，无需在 main.ts 手动装配。 */
  onApplicationBootstrap() {
    if (this.httpAdapter?.httpAdapter)
      this.attach(this.httpAdapter.httpAdapter.getHttpServer() as HttpServer)
  }

  /** 应用关闭时停止接受升级连接，并释放设备 WebSocket 与心跳。 */
  onApplicationShutdown() {
    this.files.close()
    const http = this.httpAdapter?.httpAdapter?.getHttpServer() as HttpServer | undefined
    if (this.upgradeHandler && http) http.off('upgrade', this.upgradeHandler)
    for (const socket of this.sockets.values()) socket.terminate()
    this.sockets.clear()
    this.wss?.close()
    this.wss = undefined
    this.upgradeHandler = undefined
  }

  /** 检查指定设备是否保持有效 WebSocket 连接。 */
  isOnline(id: string) {
    return this.sockets.get(id)?.readyState === WebSocket.OPEN
  }

  /** 核对归属和权限后创建一次性地址；领取地址时 execute 会再核对当前授权。 */
  async prepareFileTransfer(
    userId: string,
    clientId: string,
    workspaceId: string,
    operation: 'file.read' | 'file.write',
    payload: Record<string, unknown>,
    publicUrl: string,
  ) {
    try {
      const device = await authorizeDeviceRpc(this.store, userId, workspaceId, operation)
      if (!this.isOnline(device.id)) throw new DeviceRpcError('DEVICE_OFFLINE')
    } catch (error) {
      if (error instanceof HttpException) throw new DeviceRpcError(error.message)
      throw error
    }
    return this.files.prepare(
      {
        userId,
        clientId,
        method: operation === 'file.read' ? 'GET' : 'PUT',
        size: operation === 'file.write' ? Number(payload.size) : undefined,
        run: (transfer) =>
          this.execute(userId, clientId, workspaceId, operation, { ...payload, transfer }),
      },
      publicUrl,
    )
  }

  /** 为 HTTP Server 挂载设备 WSS 握手认证，验证设备凭据和账号状态。 */
  attach(http: HttpServer) {
    if (this.wss) return
    const wss = new WebSocketServer({ noServer: true, maxPayload: RPC_MESSAGE_LIMIT_BYTES })
    this.wss = wss
    const upgradeHandler = async (
      req: IncomingMessage,
      socket: import('node:stream').Duplex,
      head: Buffer,
    ) => {
      const u = new URL(req.url || '', 'http://localhost')
      if (u.pathname !== '/agent/connect') {
        socket.destroy()
        return
      }
      try {
        const deviceId = await authenticateDevice(this.store, req.headers.authorization || '')
        wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, deviceId))
      } catch {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
      }
    }
    this.upgradeHandler = upgradeHandler
    http.on('upgrade', upgradeHandler)
  }

  /** 接受设备连接并管理心跳、工作区同步及 RPC 响应关联。 */
  private accept(ws: WebSocket, deviceId: string) {
    this.sockets.get(deviceId)?.close(4001, 'Replaced')
    this.sockets.set(deviceId, ws)
    let alive = true
    ws.on('pong', () => {
      alive = true
    })
    const interval = setInterval(() => {
      if (!alive) {
        ws.terminate()
        return
      }
      alive = false
      ws.ping()
    }, 25000)
    // 同一连接的 hello 按接收顺序串行执行，防止异步查询导致旧快照最后覆盖新快照。
    let helloQueue = Promise.resolve()
    ws.on('message', (raw) => {
      // 旧 WebSocket 即使迟到消息，也不得覆盖当前设备连接的状态或 RPC 结果。
      if (this.sockets.get(deviceId) !== ws) return
      let m: unknown
      try {
        m = JSON.parse(raw.toString())
      } catch {
        console.warn('Invalid agent message', 'SyntaxError')
        return
      }
      const handle = async () => {
        if (this.sockets.get(deviceId) !== ws) return
        try {
          if (!m || typeof m !== 'object' || !('kind' in m)) return
          if (m.kind === 'hello') {
            const revokedIds = await synchronizeDeviceHello(
              this.store,
              deviceId,
              m,
              () => this.sockets.get(deviceId) === ws,
            )
            // 校验失败不发送空撤销列表，避免 Runtime 将失败误认为同步成功。
            if (
              revokedIds !== null &&
              this.sockets.get(deviceId) === ws &&
              ws.readyState === WebSocket.OPEN
            ) {
              ws.send(JSON.stringify({ kind: 'workspace-revocations', ids: [...revokedIds] }))
            }
            return
          }
          if (m.kind === 'response') {
            this.rpc.accept(m, deviceId, ws)
          }
          if (m.kind === 'approval-notice')
            await this.approvalNotice(ApprovalNoticeSchema.parse(m), ws, deviceId)
          if (m.kind === 'approval-closed') {
            const event = ApprovalClosedSchema.parse(m)
            const route = this.approvalRoutes.get(event.requestId)
            if (route?.socket === ws && route.approvalId === event.approvalId)
              this.closeApproval(event.requestId, event.status)
          }
        } catch (e) {
          if (e instanceof StaleDeviceConnectionError) return
          // 不输出 Runtime 异常正文，避免路径或参数进入服务端日志。
          console.warn('Invalid agent message', e instanceof Error ? e.name : 'UnknownError')
        }
      }
      if (m && typeof m === 'object' && 'kind' in m && m.kind === 'hello') {
        helloQueue = helloQueue.then(handle, handle)
      } else {
        void handle()
      }
    })
    ws.on('close', () => {
      clearInterval(interval)
      if (this.sockets.get(deviceId) === ws) this.sockets.delete(deviceId)
      this.rpc.disconnect(deviceId, ws)
    })
    // 协议错误（包括超过消息上限）由 ws 关闭该连接，记录类型供排查。
    ws.on('error', (error) => console.warn('设备 WebSocket 消息失败', error.name))
  }

  /** 由管理员或用户主动撤销设备连接。 */
  disconnect(deviceId: string) {
    this.sockets.get(deviceId)?.close(4003, 'Device revoked')
  }

  /** 仅为原始 RPC 及原始连接发卡；连接、工作区和绑定在提交决定前再次核验。 */
  private async approvalNotice(notice: ApprovalNotice, socket: WebSocket, deviceId: string) {
    const { requestId, approvalId, expiresAt } = notice
    const route = this.approvalRoutes.get(requestId)
    if (
      !this.channels ||
      !route ||
      route.socket !== socket ||
      route.approvalId ||
      expiresAt <= Date.now() ||
      expiresAt > route.deadlineAt
    )
      return
    route.approvalId = approvalId
    route.expiresAt = expiresAt
    const channels = this.channels
    route.deliveries = route.recipients.map((recipient) =>
      channels
        .deliver(recipient, notice, route.deviceName, async (approved) => {
          const currentDevice = await authorizeDeviceRpc(
            this.store,
            recipient.userId,
            route.workspaceId,
            route.operation,
          )
          const current = await channels.isCurrent(recipient)
          if (
            currentDevice.id !== deviceId ||
            !current ||
            this.approvalRoutes.get(requestId) !== route ||
            this.sockets.get(deviceId) !== socket ||
            socket.readyState !== WebSocket.OPEN ||
            expiresAt <= Date.now()
          )
            return false
          return await new Promise<boolean>((resolve) =>
            socket.send(
              JSON.stringify({
                kind: 'approval-answer',
                requestId,
                approvalId,
                approved,
              }),
              (error) => {
                if (error) console.warn('审批决定转发失败')
                resolve(!error)
              },
            ),
          )
        })
        .catch(() => {
          console.warn('审批卡片投递失败', recipient.channel)
          return undefined
        }),
    )
  }

  /** 先清理路由；即使结算早于卡片发出，投递完成后也要同步结果。 */
  private closeApproval(
    requestId: string,
    status: Extract<ApprovalEvent, { kind: 'approval-closed' }>['status'] = 'cancelled',
  ) {
    const route = this.approvalRoutes.get(requestId)
    if (!route) return
    this.approvalRoutes.delete(requestId)
    for (const delivery of route.deliveries ?? [])
      void delivery
        .then((ref) => ref && this.channels?.close(ref, status))
        .catch(() => {
          console.warn('审批卡片更新失败')
        })
  }

  /**
   * 执行远程 RPC，记录元数据及 Runtime 生成的脱敏命令。
   * payload 只用于转发到 Runtime，绝不传给持久化日志方法。
   */
  async execute(
    userId: string,
    clientId: string,
    workspaceId: string,
    operation: RpcRequest['operation'],
    payload: unknown,
  ) {
    const operationId = uid()
    const startedAt = Date.now()
    let deviceId: string | undefined
    let status: 'success' | 'failed' = 'failed'
    let errorCode: string | undefined
    let commandAudit: CommandAudit | undefined
    try {
      const device = await authorizeDeviceRpc(this.store, userId, workspaceId, operation)
      deviceId = device.id
      const socket = this.sockets.get(deviceId)
      if (!socket || socket.readyState !== WebSocket.OPEN)
        throw new DeviceRpcError('DEVICE_OFFLINE')
      const timeoutMs =
        operation === 'command.run' ? COMMAND_RPC_TIMEOUT_MS : RPC_APPROVAL_TIMEOUT_MS
      const recipients =
        (await this.channels?.recipients(userId).catch(() => {
          console.warn('审批渠道绑定查询失败')
          return []
        })) ?? []
      if (this.sockets.get(deviceId) !== socket || socket.readyState !== WebSocket.OPEN)
        throw new DeviceRpcError('DEVICE_OFFLINE')
      const request: RpcRequest = {
        kind: 'request',
        version: 1,
        id: operationId,
        workspaceId,
        operation,
        payload,
        deadlineAt: Date.now() + timeoutMs,
        ...(recipients.length ? { notifyApproval: true } : {}),
      }
      if (recipients.length)
        this.approvalRoutes.set(request.id, {
          socket,
          deviceName: device.name,
          recipients,
          deadlineAt: request.deadlineAt,
          workspaceId,
          operation,
        })
      const result = await this.rpc.send(socket, deviceId, request, timeoutMs, (command) => {
        if (operation === 'command.run') commandAudit = command
      })
      status = 'success'
      return result
    } catch (error) {
      if (error instanceof DeviceRpcError) {
        errorCode = error.message
        throw error
      }
      const candidate = error instanceof HttpException ? error.message : ''
      errorCode = ['WORKSPACE_NOT_FOUND', 'PERMISSION_DENIED', 'DEVICE_REVOKED'].includes(candidate)
        ? candidate
        : 'EXECUTION_FAILED'
      throw new DeviceRpcError(errorCode)
    } finally {
      const route = this.approvalRoutes.get(operationId)
      this.closeApproval(
        operationId,
        route?.expiresAt && route.expiresAt <= Date.now() ? 'expired' : 'cancelled',
      )
      // 保留在响应前等待一次审计写入的既有行为。
      await recordDeviceOperation(this.store, {
        operationId,
        userId,
        deviceId,
        workspaceId,
        clientId,
        operation,
        status,
        durationMs: Date.now() - startedAt,
        errorCode,
        commandAudit,
      })
    }
  }
}
