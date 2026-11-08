import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common'
import { drizzle } from 'drizzle-orm/mysql2'
import mysql from 'mysql2/promise'
import { and, eq, gt, desc } from 'drizzle-orm'
import { randomBytes, createHash, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto'
import * as bcrypt from 'bcryptjs'
import * as S from './schema'
import type { Request } from 'express'
import type { RpcRequest, RpcResponse, WorkspacePublic } from '@rcm/protocol'
import { RpcResponseSchema, HelloSchema, operationRequiresWrite } from '@rcm/protocol'
import { WebSocketServer, WebSocket } from 'ws'
import type { Server as HttpServer, IncomingMessage } from 'node:http'
import { URL } from 'node:url'

export const uid = () => randomUUID()
export const secret = () => randomBytes(32).toString('base64url')
export const hash = (str: string) => createHash('sha256').update(str).digest('hex')
const encrypt = (v: string) => {
  const key = createHash('sha256')
    .update(process.env.APP_SECRET || '')
    .digest()
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([c.update(v, 'utf8'), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64')
}
const decrypt = (v: string) => {
  const data = Buffer.from(v, 'base64'),
    key = createHash('sha256')
      .update(process.env.APP_SECRET || '')
      .digest()
  const d = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12))
  d.setAuthTag(data.subarray(12, 28))
  return Buffer.concat([d.update(data.subarray(28)), d.final()]).toString('utf8')
}
const within = (n: number) => new Date(Date.now() + n * 1000)
@Injectable()
export class Store {
  readonly pool = mysql.createPool(process.env.DATABASE_URL!)
  readonly db = drizzle(this.pool)
  async one<T>(query: Promise<T[]>): Promise<T | undefined> {
    return (await query)[0]
  }
  async audit(
    operation: string,
    status: string,
    userId?: string,
    deviceId?: string,
    workspaceId?: string,
  ) {
    await this.db
      .insert(S.auditLogs)
      .values({ id: uid(), operation, status, userId, deviceId, workspaceId })
  }
}
@Injectable()
export class Identity {
  constructor(public store: Store) {}
  async userBySession(req: Request) {
    const sid = req.cookies?.rcm_session
    if (!sid) return null
    const s = await this.store.one(
      this.store.db
        .select()
        .from(S.sessions)
        .where(and(eq(S.sessions.id, hash(sid)), gt(S.sessions.expiresAt, new Date())))
        .limit(1),
    )
    if (!s) return null
    return this.store.one(
      this.store.db.select().from(S.users).where(eq(S.users.id, s.userId)).limit(1),
    )
  }
  async requireUser(req: Request) {
    const u = await this.userBySession(req)
    if (!u || u.status !== 'active') throw new UnauthorizedException('Login required')
    if (u.passwordChangeRequired) throw new ForbiddenException('PASSWORD_CHANGE_REQUIRED')
    return u
  }
  async requireAdmin(req: Request) {
    const u = await this.requireUser(req)
    if (!['admin', 'super_admin'].includes(u.role)) throw new ForbiddenException()
    return u
  }
  async register(email: string, password: string) {
    email = email.trim().toLowerCase()
    if (!/^\S+@\S+\.\S+$/.test(email) || Buffer.byteLength(password, 'utf8') < 12 ||
        Buffer.byteLength(password, 'utf8') > 72)
      throw new BadRequestException('Valid email and password (12–72 UTF-8 bytes) required')
    // ADMIN_EMAIL is reserved for the out-of-band administrator initializer.
    if (email === process.env.ADMIN_EMAIL?.trim().toLowerCase())
      throw new ForbiddenException('Reserved administrator address')
    const user = {
      id: uid(),
      email,
      passwordHash: await bcrypt.hash(password, 12),
      role: 'user',
      status: 'active',
    }
    try {
      await this.store.db.insert(S.users).values(user)
    } catch {
      throw new BadRequestException('Account already exists')
    }
    return user
  }
  async login(email: string, password: string) {
    const user = await this.store.one(
      this.store.db
        .select()
        .from(S.users)
        .where(eq(S.users.email, email.trim().toLowerCase()))
        .limit(1),
    )
    if (!user || user.status !== 'active' || !(await bcrypt.compare(password, user.passwordHash)))
      throw new UnauthorizedException('Invalid credentials')
    const raw = secret()
    await this.store.db
      .insert(S.sessions)
      .values({ id: hash(raw), userId: user.id, expiresAt: within(60 * 60 * 24 * 7) })
    return { user, raw }
  }
  async changePassword(req: Request, currentPassword: string, nextPassword: string) {
    const user = await this.userBySession(req)
    if (!user || user.status !== 'active') throw new UnauthorizedException('Login required')
    if (!await bcrypt.compare(currentPassword, user.passwordHash))
      throw new UnauthorizedException('Invalid current password')
    const bytes = Buffer.byteLength(nextPassword, 'utf8')
    if (bytes < 12 || bytes > 72 || currentPassword === nextPassword)
      throw new BadRequestException('New password must differ and contain 12–72 UTF-8 bytes')
    const passwordHash = await bcrypt.hash(nextPassword, 12)
    await this.store.db.update(S.users)
      .set({ passwordHash, passwordChangeRequired: false })
      .where(eq(S.users.id, user.id))
    await this.store.db.delete(S.sessions).where(eq(S.sessions.userId, user.id))
    // Force reauthentication after credential rotation.
    return { ok: true }
  }

  async logOut(req: Request) {
    const sid = req.cookies?.rcm_session
    if (sid) await this.store.db.delete(S.sessions).where(eq(S.sessions.id, hash(sid)))
  }
}
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
  isOnline(id: string) {
    return this.sockets.get(id)?.readyState === WebSocket.OPEN
  }
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
              await this.store.db.delete(S.workspaces)
                .where(and(eq(S.workspaces.id, w.id), eq(S.workspaces.deviceId, deviceId)))
          }
          for (const w of h.workspaces) {
            const old = existing.find((x) => x.id === w.id)
            if (old)
              await this.store.db
                .update(S.workspaces)
                .set({
                  name: w.name,
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
          r.success
            ? p.resolve(r.data)
            : p.reject(new Error(r.error?.code + ': ' + r.error?.message))
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
  disconnect(deviceId: string) {
    this.sockets.get(deviceId)?.close(4003, 'Device revoked')
  }
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
      if (!ws.localRead || !ws.cloudRead ||
          (operationRequiresWrite(operation) && (!ws.localWrite || !ws.cloudWrite)))
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
      void this.store.audit(operation, 'success', userId, device.id, workspaceId).catch(console.error)
      return result
    } catch (error) {
      void this.store.audit(operation, 'failed', userId, undefined, workspaceId).catch(console.error)
      throw error
    }
  }
}
