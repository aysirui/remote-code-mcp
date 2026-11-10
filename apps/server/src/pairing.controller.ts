import { env } from './env'
import {
  Controller,
  Post,
  Req,
  Body,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common'
import type { Request } from 'express'
import { eq } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import { Identity } from './identity'
import { Store } from './store'
import { DeviceHub } from './device-hub'
import { secret, hash, uid } from './security'
import { csrf, checkOrigin, consoleUrl } from './http-security'
import * as S from './schema'

/** 设备配对流程；创建一次性配对码，通过事务与行锁保护批准及凭据领取。 */
@Controller('api')
export class PairingController {
  constructor(
    private readonly id: Identity,
    private readonly store: Store,
    private readonly hub: DeviceHub,
  ) {}
  /** Runtime 用自己的设备凭据撤销绑定；重复撤销安全，无法操作其他设备。 */
  @Post('device/unpair') async unpair(@Req() req: Request) {
    const header = req.headers.authorization || ''
    const raw = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!raw) throw new UnauthorizedException()
    const token = await this.store.one(
      this.store.db
        .select()
        .from(S.deviceTokens)
        .where(eq(S.deviceTokens.tokenHash, hash(raw)))
        .limit(1),
    )
    if (!token) throw new UnauthorizedException('设备凭据无效')
    await this.store.db.transaction(async (tx) => {
      await tx
        .update(S.deviceTokens)
        .set({ revokedAt: new Date() })
        .where(eq(S.deviceTokens.deviceId, token.deviceId))
      await tx.update(S.devices).set({ status: 'revoked' }).where(eq(S.devices.id, token.deviceId))
    })
    this.hub.disconnect(token.deviceId)
    return { ok: true }
  }
  /** 生成短时一次性配对码和私有领取凭据。 */
  @Post('device/pairing/start') async startPair(
    @Req() req: Request,
    @Body() b: Record<string, unknown>,
  ) {
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
  /** 用户批准配对并在事务行锁内创建设备凭据。 */
  @Post('device/pairing/approve') async approvePair(
    @Req() req: Request,
    @Body() b: Record<string, unknown>,
  ) {
    csrf(req)
    const u = await this.id.requireUser(req)
    const code = String(b.code || '')
      .trim()
      .toUpperCase()
    if (!/^[0-9A-F]{6}-[0-9A-F]{6}$/.test(code))
      throw new BadRequestException('Invalid pairing code')
    const { createCipheriv, createHash, randomBytes } = await import('node:crypto')
    const deviceId = uid()
    const token = secret()
    // Lock the pairing row before creating anything: one approval can win.
    await this.store.db.transaction(async (tx) => {
      const matches = await tx
        .select()
        .from(S.pairings)
        .where(eq(S.pairings.codeHash, hash(code)))
        .limit(1)
        .for('update')
      const pairing = matches[0]
      if (!pairing || pairing.status !== 'pending' || pairing.expiresAt <= new Date())
        throw new BadRequestException('Invalid/expired code')
      const iv = randomBytes(12)
      const key = createHash('sha256').update(env.appSecret).digest()
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
      const stored = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
      await tx.insert(S.devices).values({
        id: deviceId,
        userId: u.id,
        name: pairing.deviceName,
        platform: pairing.platform,
        status: 'active',
      })
      await tx.insert(S.deviceTokens).values({ id: uid(), deviceId, tokenHash: hash(token) })
      await tx
        .update(S.pairings)
        .set({ status: 'approved', deviceId, tokenCiphertext: stored })
        .where(eq(S.pairings.id, pairing.id))
    })
    return { ok: true, deviceId }
  }

  /** Runtime 通过私有凭据一次性领取设备令牌，事务中消费配对。 */
  @Post('device/pairing/complete') async completePair(@Body() b: Record<string, unknown>) {
    const id = String(b.id || '')
    const providedSecret = String(b.privateSecret || '')
    if (!id || !providedSecret) throw new UnauthorizedException()
    return this.store.db.transaction(async (tx) => {
      const matches = await tx
        .select()
        .from(S.pairings)
        .where(eq(S.pairings.id, id))
        .limit(1)
        .for('update')
      const p = matches[0]
      if (!p || hash(providedSecret) !== p.secretHash) throw new UnauthorizedException()
      if (p.expiresAt <= new Date()) throw new BadRequestException('Expired')
      if (p.status === 'pending') return { status: 'pending' as const }
      if (p.status !== 'approved' || !p.tokenCiphertext || !p.deviceId)
        throw new BadRequestException('Used')
      const { createDecipheriv, createHash } = await import('node:crypto')
      const bytes = Buffer.from(p.tokenCiphertext, 'base64')
      const key = createHash('sha256').update(env.appSecret).digest()
      const dec = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      dec.setAuthTag(bytes.subarray(12, 28))
      const token = Buffer.concat([dec.update(bytes.subarray(28)), dec.final()]).toString('utf8')
      await tx
        .update(S.pairings)
        .set({ status: 'consumed', tokenCiphertext: null })
        .where(eq(S.pairings.id, p.id))
      return { status: 'complete' as const, deviceId: p.deviceId, token }
    })
  }
}
