import {
  Injectable,
  BadRequestException,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common'
import { HttpAdapterHost } from '@nestjs/core'
import { WebSocketServer, WebSocket } from 'ws'
import type { Server as HttpServer, IncomingMessage } from 'node:http'
import { URL } from 'node:url'
import type { RpcRequest } from '@rcm/protocol'
import { type CommandAudit } from '@rcm/protocol'
import { Store } from '../../infrastructure/database/store'
import { uid } from '../../common/security'
import { authenticateDevice } from './device-auth'
import { authorizeDeviceRpc } from './device-rpc-authorization'
import { synchronizeDeviceHello, StaleDeviceConnectionError } from './device-workspace-sync'
import { DeviceRpcPending } from './device-rpc-pending'
import { recordDeviceOperation } from './device-operation-audit'

const RPC_TIMEOUT_MS = 5 * 60 * 1000

/** 设备通道与 RPC 路由服务；不持久化任何工具参数或执行结果正文。 */
@Injectable()
export class DeviceHub implements OnApplicationBootstrap, OnApplicationShutdown {
  private sockets = new Map<string, WebSocket>()
  private wss: WebSocketServer | undefined
  private upgradeHandler:
    ((req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => void) | undefined
  private readonly rpc = new DeviceRpcPending()

  constructor(
    public store: Store,
    @Optional() private readonly httpAdapter?: HttpAdapterHost,
  ) {}

  /** NestJS 初始化完成后挂载升级握手，无需在 main.ts 手动装配。 */
  onApplicationBootstrap() {
    if (this.httpAdapter?.httpAdapter)
      this.attach(this.httpAdapter.httpAdapter.getHttpServer() as HttpServer)
  }

  /** 应用关闭时停止接受升级连接，并释放设备 WebSocket 与心跳。 */
  onApplicationShutdown() {
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

  /** 为 HTTP Server 挂载设备 WSS 握手认证，验证设备凭据和账号状态。 */
  attach(http: HttpServer) {
    if (this.wss) return
    const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
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
  }

  /** 由管理员或用户主动撤销设备连接。 */
  disconnect(deviceId: string) {
    this.sockets.get(deviceId)?.close(4003, 'Device revoked')
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
      deviceId = await authorizeDeviceRpc(this.store, userId, workspaceId, operation)
      const socket = this.sockets.get(deviceId)
      if (!socket || socket.readyState !== WebSocket.OPEN)
        throw new BadRequestException('DEVICE_OFFLINE')
      const request: RpcRequest = {
        kind: 'request',
        version: 1,
        id: operationId,
        workspaceId,
        operation,
        payload,
        deadlineAt: Date.now() + RPC_TIMEOUT_MS,
      }
      const result = await this.rpc.send(socket, deviceId, request, RPC_TIMEOUT_MS, (command) => {
        if (operation === 'command.run') commandAudit = command
      })
      status = 'success'
      return result
    } catch (error) {
      const candidate = error instanceof Error ? error.message : ''
      errorCode = /^[A-Z][A-Z0-9_]{1,63}$/.test(candidate) ? candidate : 'EXECUTION_FAILED'
      throw error
    } finally {
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
