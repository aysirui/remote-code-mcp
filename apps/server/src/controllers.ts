import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Req,
  Res,
  Query,
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
  Headers,
  Module,
} from '@nestjs/common'
import type { Request, Response } from 'express'
import { eq, and, desc } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import { Identity, Store, DeviceHub, secret, hash, uid } from './core'
import * as S from './schema'
import { createHash, timingSafeEqual } from 'node:crypto'
const base = () => process.env.PUBLIC_URL || 'http://localhost:3000'
const consoleUrl = () => process.env.CONSOLE_URL || 'http://localhost:5173'
const safe = (v: string) =>
  String(v).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
const json = <T>(x: T) => JSON.parse(JSON.stringify(x))
function setCookie(res: Response, name: string, value: string, ttl = 604800) {
  res.cookie(name, value, {
    httpOnly: true,
    secure: base().startsWith('https:'),
    sameSite: 'lax',
    path: '/',
    maxAge: ttl * 1000,
  })
}
function checkOrigin(req: Request) {
  const origin = req.headers.origin
  if (origin) {
    const allowed = [new URL(base()).origin, new URL(consoleUrl()).origin]
    if (!allowed.includes(origin)) throw new ForbiddenException('Invalid origin')
  }
}
function csrf(req: Request) {
  checkOrigin(req)
  // A mutating browser request must originate from one of our configured UIs.
  // Referer is only a fallback for clients/proxies that do not send Origin.
  if (!req.headers.origin) {
    try {
      const referer = new URL(req.headers.referer || '')
      const allowed = [new URL(base()).origin, new URL(consoleUrl()).origin]
      if (!allowed.includes(referer.origin)) throw Error('Untrusted referer')
    } catch {
      throw new ForbiddenException('Origin or trusted Referer required')
    }
  }
  const c = req.cookies?.rcm_csrf
  const h = req.headers['x-csrf-token']
  if (!c || h !== c) throw new ForbiddenException('CSRF token required')
}
@Controller('api')
export class ApiController {
  constructor(
    private id: Identity,
    private store: Store,
    private hub: DeviceHub,
  ) {}
  @Get('auth/csrf') async csrfToken(@Req() req: Request, @Res() res: Response) {
    let token = req.cookies?.rcm_csrf
    if (!token) {
      token = secret()
      res.cookie('rcm_csrf', token, {
        httpOnly: false,
        secure: base().startsWith('https:'),
        sameSite: 'lax',
        path: '/',
      })
    }
    res.json({ csrfToken: token })
  }
  @Post('auth/register') async register(@Req() req: Request, @Body() b: any) {
    csrf(req)
    const u = await this.id.register(String(b.email || ''), String(b.password || ''))
    return { id: u.id, email: u.email }
  }
  @Post('auth/login') async login(@Req() req: Request, @Res() res: Response, @Body() b: any) {
    csrf(req)
    const { user, raw } = await this.id.login(String(b.email || ''), String(b.password || ''))
    setCookie(res, 'rcm_session', raw)
    res.json({ id: user.id, email: user.email, role: user.role, passwordChangeRequired: user.passwordChangeRequired })
  }
  @Post('auth/change-password') async changePassword(@Req() req: Request, @Res() res: Response, @Body() b: any) {
    csrf(req)
    await this.id.changePassword(req, String(b.currentPassword || ''), String(b.newPassword || ''))
    res.clearCookie('rcm_session')
    res.json({ ok: true, reauthenticate: true })
  }
  @Post('auth/logout') async logout(@Req() req: Request, @Res() res: Response) {
    csrf(req)
    await this.id.logOut(req)
    res.clearCookie('rcm_session')
    res.json({ ok: true })
  }
  @Get('auth/me') async me(@Req() req: Request) {
    const u = await this.id.requireUser(req)
    return { id: u.id, email: u.email, role: u.role, status: u.status, passwordChangeRequired: u.passwordChangeRequired }
  }
  @Get('me/devices') async devices(@Req() req: Request) {
    const u = await this.id.requireUser(req)
    return (await this.store.db.select().from(S.devices).where(eq(S.devices.userId, u.id))).map(
      (d) => ({ ...d, online: this.hub.isOnline(d.id) }),
    )
  }
  @Patch('me/devices/:id') async rename(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() b: any,
  ) {
    csrf(req)
    const u = await this.id.requireUser(req)
    const name = String(b.name || '')
      .trim()
      .slice(0, 128)
    if (!name) throw new BadRequestException()
    await this.store.db
      .update(S.devices)
      .set({ name })
      .where(and(eq(S.devices.id, id), eq(S.devices.userId, u.id)))
    return { ok: true }
  }
  @Delete('me/devices/:id') async revoke(@Req() req: Request, @Param('id') id: string) {
    csrf(req)
    const u = await this.id.requireUser(req)
    const d = await this.store.one(
      this.store.db
        .select()
        .from(S.devices)
        .where(and(eq(S.devices.id, id), eq(S.devices.userId, u.id)))
        .limit(1),
    )
    if (!d) throw new NotFoundException()
    await this.store.db.update(S.devices).set({ status: 'revoked' }).where(eq(S.devices.id, id))
    await this.store.db
      .update(S.deviceTokens)
      .set({ revokedAt: new Date() })
      .where(eq(S.deviceTokens.deviceId, id))
    this.hub.disconnect(id)
    await this.store.audit('device.revoke', 'success', u.id, id)
    return { ok: true }
  }
  @Get('me/workspaces') async workspaces(@Req() req: Request) {
    const u = await this.id.requireUser(req)
    return (
      await this.store.db.select().from(S.workspaces).where(eq(S.workspaces.userId, u.id))
    ).map((w) => ({
      ...w,
      enabled: w.localEnabled && w.cloudEnabled,
      read: w.localEnabled && w.cloudEnabled && w.localRead && w.cloudRead,
      write: w.localEnabled && w.cloudEnabled && w.localRead && w.cloudRead && w.localWrite && w.cloudWrite,
    }))
  }
  @Patch('me/workspaces/:id') async restrictWorkspace(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() b: any,
  ) {
    csrf(req)
    const u = await this.id.requireUser(req)
    const w = await this.store.one(
      this.store.db
        .select()
        .from(S.workspaces)
        .where(and(eq(S.workspaces.id, id), eq(S.workspaces.userId, u.id)))
        .limit(1),
    )
    if (!w) throw new NotFoundException()
    const patch: any = {}
    if (b.enabled === false) patch.cloudEnabled = false
    if (b.write === false) patch.cloudWrite = false
    if (b.read === false) patch.cloudRead = false
    if (!Object.keys(patch).length)
      throw new BadRequestException('Console can only reduce workspace permissions')
    await this.store.db.update(S.workspaces).set(patch).where(eq(S.workspaces.id, id))
    await this.store.audit('workspace.restrict', 'success', u.id, w.deviceId, id)
    return { ok: true }
  }
  @Get('me/oauth-grants') async oauthGrants(@Req() req: Request) {
    const u = await this.id.requireUser(req)
    const ts = await this.store.db
      .select()
      .from(S.oauthTokens)
      .where(eq(S.oauthTokens.userId, u.id))
    const active = ts.filter((t) => !t.revokedAt && t.expiresAt > new Date())
    return [
      ...new Map(
        active.map((t) => [
          t.clientId,
          { clientId: t.clientId, scope: t.scope, expiresAt: t.expiresAt },
        ]),
      ).values(),
    ]
  }
  @Delete('me/oauth-grants/:clientId') async revokeOauth(
    @Req() req: Request,
    @Param('clientId') clientId: string,
  ) {
    csrf(req)
    const u = await this.id.requireUser(req)
    await this.store.db
      .update(S.oauthTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(S.oauthTokens.userId, u.id), eq(S.oauthTokens.clientId, clientId)))
    await this.store.audit('oauth.revoke', 'success', u.id)
    return { ok: true }
  }
  @Get('me/audit-logs') async logs(@Req() req: Request) {
    const u = await this.id.requireUser(req)
    return this.store.db
      .select()
      .from(S.auditLogs)
      .where(eq(S.auditLogs.userId, u.id))
      .orderBy(desc(S.auditLogs.createdAt))
      .limit(100)
  }
  @Get('admin/users') async users(@Req() req: Request) {
    await this.id.requireAdmin(req)
    return this.store.db
      .select({
        id: S.users.id,
        email: S.users.email,
        role: S.users.role,
        status: S.users.status,
        createdAt: S.users.createdAt,
      })
      .from(S.users)
      .limit(500)
  }
  @Patch('admin/users/:id/status') async userStatus(
    @Req() req: Request,
    @Param('id') target: string,
    @Body() b: any,
  ) {
    csrf(req)
    const u = await this.id.requireAdmin(req)
    if (u.id === target) throw new ForbiddenException('Cannot disable self')
    const status = b.status
    if (!['active', 'disabled'].includes(status)) throw new BadRequestException()
    const old = await this.store.one(
      this.store.db.select().from(S.users).where(eq(S.users.id, target)).limit(1),
    )
    if (!old || old.role === 'super_admin' || (old.role === 'admin' && u.role !== 'super_admin'))
      throw new ForbiddenException()
    await this.store.db.update(S.users).set({ status }).where(eq(S.users.id, target))
    if (status === 'disabled') {
      await this.store.db.delete(S.sessions).where(eq(S.sessions.userId, target))
      const ds = await this.store.db.select().from(S.devices).where(eq(S.devices.userId, target))
      for (const d of ds) this.hub.disconnect(d.id)
      await this.store.db
        .update(S.oauthTokens)
        .set({ revokedAt: new Date() })
        .where(eq(S.oauthTokens.userId, target))
    }
    await this.store.audit('admin.user_status', 'success', u.id)
    return { ok: true }
  }
  @Get('admin/devices') async adminDevices(@Req() req: Request) {
    await this.id.requireAdmin(req)
    return (await this.store.db.select().from(S.devices).limit(500)).map((d) => ({
      ...d,
      online: this.hub.isOnline(d.id),
    }))
  }
  @Post('admin/devices/:id/revoke') async adminRevokeDevice(
    @Req() req: Request,
    @Param('id') deviceId: string,
  ) {
    csrf(req)
    const u = await this.id.requireAdmin(req)
    const d = await this.store.one(
      this.store.db.select().from(S.devices).where(eq(S.devices.id, deviceId)).limit(1),
    )
    if (!d) throw new NotFoundException()
    await this.store.db
      .update(S.devices)
      .set({ status: 'revoked' })
      .where(eq(S.devices.id, deviceId))
    await this.store.db
      .update(S.deviceTokens)
      .set({ revokedAt: new Date() })
      .where(eq(S.deviceTokens.deviceId, deviceId))
    this.hub.disconnect(deviceId)
    await this.store.audit('admin.device_revoke', 'success', u.id, deviceId)
    return { ok: true }
  }
  @Get('admin/audit-logs') async adminLogs(@Req() req: Request) {
    await this.id.requireAdmin(req)
    return this.store.db.select().from(S.auditLogs).orderBy(desc(S.auditLogs.createdAt)).limit(200)
  }
  @Get('admin/overview') async overview(@Req() req: Request) {
    await this.id.requireAdmin(req)
    const [users, devices, workspaces] = await Promise.all([
      this.store.db.select({ id: S.users.id }).from(S.users),
      this.store.db.select({ id: S.devices.id }).from(S.devices),
      this.store.db.select({ id: S.workspaces.id }).from(S.workspaces),
    ])
    return {
      users: users.length,
      devices: devices.length,
      online: devices.filter((d) => this.hub.isOnline(d.id)).length,
      workspaces: workspaces.length,
    }
  }
  @Post('device/pairing/start') async startPair(@Req() req: Request, @Body() b: any) {
    checkOrigin(req)
    const name = String(b.name || '')
        .trim()
        .slice(0, 128),
      platform = String(b.platform || 'unknown').slice(0, 64)
    if (!name || name.length < 2) throw new BadRequestException()
    const code = (
        randomBytes(6).toString('hex').slice(0, 6) +
        '-' +
        randomBytes(6).toString('hex').slice(0, 6)
      ).toUpperCase(),
      privateSecret = secret(),
      id = uid()
    await this.store.db.insert(S.pairings).values({
      id,
      codeHash: hash(code),
      secretHash: hash(privateSecret),
      deviceName: name,
      platform,
      status: 'pending',
      expiresAt: new Date(Date.now() + 10 * 60000),
    })
    return { id, code, privateSecret, activationUrl: consoleUrl() + '/activate', expiresIn: 600 }
  }
  @Post('device/pairing/approve') async approvePair(@Req() req: Request, @Body() b: any) {
    csrf(req)
    const u = await this.id.requireUser(req)
    const code = String(b.code || '').trim().toUpperCase()
    if (!/^[0-9A-F]{6}-[0-9A-F]{6}$/.test(code))
      throw new BadRequestException('Invalid pairing code')
    const { createCipheriv, createHash, randomBytes } = await import('node:crypto')
    const deviceId = uid()
    const token = secret()
    // Lock the pairing row before creating anything: one approval can win.
    await this.store.db.transaction(async (tx) => {
      const matches = await tx.select().from(S.pairings)
        .where(eq(S.pairings.codeHash, hash(code))).limit(1).for('update')
      const pairing = matches[0]
      if (!pairing || pairing.status !== 'pending' || pairing.expiresAt <= new Date())
        throw new BadRequestException('Invalid/expired code')
      const iv = randomBytes(12)
      const key = createHash('sha256').update(process.env.APP_SECRET!).digest()
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
      const stored = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
      await tx.insert(S.devices).values({
        id: deviceId, userId: u.id, name: pairing.deviceName,
        platform: pairing.platform, status: 'active',
      })
      await tx.insert(S.deviceTokens).values({ id: uid(), deviceId, tokenHash: hash(token) })
      await tx.update(S.pairings)
        .set({ status: 'approved', deviceId, tokenCiphertext: stored })
        .where(eq(S.pairings.id, pairing.id))
    })
    return { ok: true, deviceId }
  }

  @Post('device/pairing/complete') async completePair(@Body() b: any) {
    const id = String(b.id || '')
    const providedSecret = String(b.privateSecret || '')
    if (!id || !providedSecret) throw new UnauthorizedException()
    return this.store.db.transaction(async (tx) => {
      const matches = await tx.select().from(S.pairings)
        .where(eq(S.pairings.id, id)).limit(1).for('update')
      const p = matches[0]
      if (!p || hash(providedSecret) !== p.secretHash) throw new UnauthorizedException()
      if (p.expiresAt <= new Date()) throw new BadRequestException('Expired')
      if (p.status === 'pending') return { status: 'pending' as const }
      if (p.status !== 'approved' || !p.tokenCiphertext || !p.deviceId)
        throw new BadRequestException('Used')
      const { createDecipheriv, createHash } = await import('node:crypto')
      const bytes = Buffer.from(p.tokenCiphertext, 'base64')
      const key = createHash('sha256').update(process.env.APP_SECRET!).digest()
      const dec = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      dec.setAuthTag(bytes.subarray(12, 28))
      const token = Buffer.concat([dec.update(bytes.subarray(28)), dec.final()]).toString('utf8')
      await tx.update(S.pairings)
        .set({ status: 'consumed', tokenCiphertext: null })
        .where(eq(S.pairings.id, p.id))
      return { status: 'complete' as const, deviceId: p.deviceId, token }
    })
  }

}
