import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import { WebSocketServer, WebSocket } from 'ws'
import type { Server as HttpServer, IncomingMessage } from 'node:http'
import { URL } from 'node:url'
import type { RpcRequest } from '@rcm/protocol'
import { RpcResponseSchema, HelloSchema, operationRequiresWrite } from '@rcm/protocol'
import * as S from './schema'
import { Store } from './store'
import { uid, hash } from './security'

/**
 * 设备通道与 RPC 路由服务。
 * 云端先验证用户、设备、工作区及有效权限，Runtime 再执行本地授权检查。
 * Pending RPC 绑定具体 WebSocket，旧连接不得影响新连接。
 */
@Injectable()
export class DeviceHub {
  private sockets = new Map<string, WebSocket>()
  private pending = new Map<
    string,
    {
      resolve: (v: unknown) => void
      reject: (e: Error) => void
      timer: NodeJS.Timeout
      deviceId: string
      connection: WebSocket
    }
  >()
  constructor(public store: Store) {}
  /** 检查指定设备是否保持有效 WebSocket 连接。 */
  isOnline(id: string) {
    return this.sockets.get(id)?.readyState === WebSocket.OPEN
  }
  /** 为 HTTP Server 挂载设备 WSS 握手认证，验证设备凭据和账号状态。 */
  attach(http: HttpServer) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
    http.on('upgrade', async (req: IncomingMessage, socket, head) => {
      const u = new URL(req.url || '', 'http://localhost')
      if (u.pathname !== '/agent/connect') {
        socket.destroy()
        return
      }
      try {
        const header = req.headers.authorization || ''
        const token = header.startsWith('Bearer ') ? header.slice(7) : ''
        if (!token) throw Error('No token')
        const t = await this.store.one(
          this.store.db
            .select()
            .from(S.deviceTokens)
            .where(and(eq(S.deviceTokens.tokenHash, hash(token))))
            .limit(1),
        )
        if (!t || t.revokedAt) throw Error('Credential revoked')
        const d = await this.store.one(
          this.store.db.select().from(S.devices).where(eq(S.devices.id, t.deviceId)).limit(1),
        )
        if (!d || d.status !== 'active') throw Error('Device revoked')
        const user = await this.store.one(
          this.store.db.select().from(S.users).where(eq(S.users.id, d.userId)).limit(1),
        )
        if (!user || user.status !== 'active') throw Error('Account suspended')
        wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, d.id))
      } catch {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
      }
    })
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
    ws.on('message', async (raw) => {
      // Ignore messages from superseded connections, including stale "hello" updates.
      if (this.sockets.get(deviceId) !== ws) return
      try {
        const m = JSON.parse(raw.toString())
        if (m.kind === 'hello') {
          const h = HelloSchema.parse(m)
          const d = await this.store.one(
            this.store.db.select().from(S.devices).where(eq(S.devices.id, deviceId)).limit(1),
          )
          if (!d) return
          await this.store.db
            .update(S.devices)
            .set({ runtimeVersion: h.runtimeVersion, lastSeenAt: new Date() })
            .where(eq(S.devices.id, deviceId))
          const ids = h.workspaces.map((x) => x.id)
          const existing = await this.store.db
            .select()
            .from(S.workspaces)
            .where(eq(S.workspaces.deviceId, deviceId))
          for (const w of existing) {
            if (!ids.includes(w.id))
              await this.store.db
                .delete(S.workspaces)
                .where(and(eq(S.workspaces.id, w.id), eq(S.workspaces.deviceId, deviceId)))
          }
          for (const w of h.workspaces) {
            const old = existing.find((x) => x.id === w.id)
            if (old)
              await this.store.db
                .update(S.workspaces)
                .set({
                  name: w.name,
                  directoryName: w.directoryName ?? null,
                  localRead: w.permissions.read,
                  localWrite: w.permissions.write,
                  localEnabled: w.enabled,
                })
                .where(and(eq(S.workspaces.id, w.id), eq(S.workspaces.deviceId, deviceId)))
            else
              await this.store.db.insert(S.workspaces).values({
                id: w.id,
                deviceId,
                userId: d.userId,
                name: w.name,
                directoryName: w.directoryName ?? null,
                localRead: w.permissions.read,
                localWrite: w.permissions.write,
                localEnabled: w.enabled,
              })
          }
          return
        }
        if (m.kind === 'response') {
          const r = RpcResponseSchema.parse(m)
          const p = this.pending.get(r.id)
          if (!p || p.deviceId !== deviceId || p.connection !== ws) return
          clearTimeout(p.timer)
          this.pending.delete(r.id)
          if (r.success) {
            p.resolve(r.data)
          } else {
            p.reject(new Error(r.error?.code + ': ' + r.error?.message))
          }
        }
      } catch (e) {
        console.warn('Invalid agent message', String(e))
      }
    })
    ws.on('close', () => {
      clearInterval(interval)
      if (this.sockets.get(deviceId) === ws) this.sockets.delete(deviceId)
      for (const [id, p] of this.pending) {
        if (p.deviceId === deviceId && p.connection === ws) {
          clearTimeout(p.timer)
          p.reject(new Error('DEVICE_OFFLINE'))
          this.pending.delete(id)
        }
      }
    })
  }
  /** 由管理员或用户主动撤销设备连接。 */
  disconnect(deviceId: string) {
    this.sockets.get(deviceId)?.close(4003, 'Device revoked')
  }
  /** 执行远程 RPC 前检查用户/设备/工作区的权限交集，并记录审计日志。 */
  async execute(
    userId: string,
    workspaceId: string,
    operation: RpcRequest['operation'],
    payload: unknown,
  ) {
    try {
      const ws = await this.store.one(
        this.store.db
          .select()
          .from(S.workspaces)
          .where(
            and(
              eq(S.workspaces.id, workspaceId),
              eq(S.workspaces.userId, userId),
              eq(S.workspaces.localEnabled, true),
              eq(S.workspaces.cloudEnabled, true),
            ),
          )
          .limit(1),
      )
      if (!ws) throw new NotFoundException('WORKSPACE_NOT_FOUND')
      if (
        !ws.localRead ||
        !ws.cloudRead ||
        (operationRequiresWrite(operation) && (!ws.localWrite || !ws.cloudWrite))
      )
        throw new ForbiddenException('PERMISSION_DENIED')
      const device = await this.store.one(
        this.store.db
          .select()
          .from(S.devices)
          .where(and(eq(S.devices.id, ws.deviceId), eq(S.devices.userId, userId)))
          .limit(1),
      )
      if (!device || device.status !== 'active') throw new ForbiddenException('DEVICE_REVOKED')
      const socket = this.sockets.get(device.id)
      if (!socket || socket.readyState !== WebSocket.OPEN)
        throw new BadRequestException('DEVICE_OFFLINE')
      const id = uid()
      const request: RpcRequest = {
        kind: 'request',
        version: 1,
        id,
        workspaceId,
        operation,
        payload,
        deadlineAt: Date.now() + 60000,
      }
      const result = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new Error('EXECUTION_TIMEOUT'))
        }, 60000)
        this.pending.set(id, { resolve, reject, timer, deviceId: device.id, connection: socket })
        socket.send(JSON.stringify(request), (error) => {
          if (error) {
            clearTimeout(timer)
            this.pending.delete(id)
            reject(error)
          }
        })
      })
      void this.store
        .audit(operation, 'success', userId, device.id, workspaceId)
        .catch(console.error)
      return result
    } catch (error) {
      void this.store
        .audit(operation, 'failed', userId, undefined, workspaceId)
        .catch(console.error)
      throw error
    }
  }
}
