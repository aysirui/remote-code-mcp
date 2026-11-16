import { Injectable, BadRequestException, UnauthorizedException } from '@nestjs/common'
import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto'
import { env } from '../../config/env'
import { DeviceHub } from '../device/device-hub'
import { hash, secret, uid } from '../../common/security'
import { consoleUrl } from '../../common/http-security'
import { PairingRepository } from './pairing.repository'

/** 设备配对业务服务：原始私有凭据仅在创建时返回给 Runtime。 */
@Injectable()
export class PairingService {
  constructor(
    private readonly hub: DeviceHub,
    private readonly repository: PairingRepository,
  ) {}

  /** Runtime 使用设备 Bearer 凭据撤销绑定；断连发生在数据库事务提交后。 */
  async unpair(authorization: string) {
    const raw = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
    if (!raw) throw new UnauthorizedException()
    const token = await this.repository.tokenByHash(hash(raw))
    if (!token) throw new UnauthorizedException('设备凭据无效')
    await this.repository.revokeDevice(token.deviceId)
    this.hub.disconnect(token.deviceId)
    return { ok: true }
  }

  /** 生成短时一次性配对码，保持原有长度、格式和十分钟有效期。 */
  async startPair(body: Record<string, unknown>) {
    const name = String(body.name || '')
      .trim()
      .slice(0, 128)
    const platform = String(body.platform || 'unknown').slice(0, 64)
    if (!name || name.length < 2) throw new BadRequestException()
    const code = (
      randomBytes(6).toString('hex').slice(0, 6) +
      '-' +
      randomBytes(6).toString('hex').slice(0, 6)
    ).toUpperCase()
    const privateSecret = secret()
    const id = uid()
    await this.repository.createPairing({
      id,
      codeHash: hash(code),
      secretHash: hash(privateSecret),
      deviceName: name,
      platform,
      expiresAt: new Date(Date.now() + 10 * 60000),
    })
    return { id, code, privateSecret, activationUrl: consoleUrl() + '/activate', expiresIn: 600 }
  }

  /** 审批配对：令牌加密仅在数据库行锁确认有效后执行。 */
  async approvePair(userId: string, rawCode: unknown) {
    const code = String(rawCode || '')
      .trim()
      .toUpperCase()
    if (!/^[0-9A-F]{6}-[0-9A-F]{6}$/.test(code))
      throw new BadRequestException('Invalid pairing code')
    const deviceId = uid()
    const token = secret()
    await this.repository.approve(hash(code), userId, deviceId, hash(token), () => {
      const iv = randomBytes(12)
      const key = createHash('sha256').update(env.appSecret).digest()
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
    })
    return { ok: true, deviceId }
  }

  /** Runtime 使用私有凭据领取令牌，成功领取后配对记录不可再次消费。 */
  async completePair(body: Record<string, unknown>) {
    const id = String(body.id || '')
    const providedSecret = String(body.privateSecret || '')
    if (!id || !providedSecret) throw new UnauthorizedException()
    return this.repository.complete(id, hash(providedSecret), (ciphertext) => {
      const bytes = Buffer.from(ciphertext, 'base64')
      const key = createHash('sha256').update(env.appSecret).digest()
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      decipher.setAuthTag(bytes.subarray(12, 28))
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
    })
  }
}
