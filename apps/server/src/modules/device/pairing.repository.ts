import { Injectable, BadRequestException, UnauthorizedException } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { Store } from '../../infrastructure/database/store'
import * as S from '../../infrastructure/database/schema'
import { uid } from '../../common/security'

/** 设备配对持久化层；凭据撤销必须在事务内同步更新设备状态。 */
@Injectable()
export class PairingRepository {
  constructor(private readonly store: Store) {}

  /** 根据令牌摘要查询设备凭据，不保存或返回原始令牌。 */
  async tokenByHash(tokenHash: string) {
    return this.store.one(
      this.store.db
        .select()
        .from(S.deviceTokens)
        .where(eq(S.deviceTokens.tokenHash, tokenHash))
        .limit(1),
    )
  }

  /** 在同一事务内撤销设备及其全部凭据。 */
  async revokeDevice(deviceId: string) {
    await this.store.db.transaction(async (tx) => {
      await tx
        .update(S.deviceTokens)
        .set({ revokedAt: new Date() })
        .where(eq(S.deviceTokens.deviceId, deviceId))
      await tx.update(S.devices).set({ status: 'revoked' }).where(eq(S.devices.id, deviceId))
    })
  }

  /** 创建待批准的短期配对请求，数据库仅保存 Code 和私有凭据的摘要。 */
  async createPairing(data: {
    id: string
    codeHash: string
    secretHash: string
    deviceName: string
    platform: string
    expiresAt: Date
  }) {
    await this.store.db.insert(S.pairings).values({ ...data, status: 'pending' })
  }

  /** 行锁保护批准操作：只有 pending 且未过期的配对可以创建凭据。 */
  async approve(
    codeHash: string,
    userId: string,
    deviceId: string,
    tokenHash: string,
    encryptToken: () => string,
  ) {
    await this.store.db.transaction(async (tx) => {
      const matches = await tx
        .select()
        .from(S.pairings)
        .where(eq(S.pairings.codeHash, codeHash))
        .limit(1)
        .for('update')
      const pairing = matches[0]
      if (!pairing || pairing.status !== 'pending' || pairing.expiresAt <= new Date())
        throw new BadRequestException('Invalid/expired code')
      const stored = encryptToken()
      await tx.insert(S.devices).values({
        id: deviceId,
        userId,
        name: pairing.deviceName,
        platform: pairing.platform,
        status: 'active',
      })
      await tx.insert(S.deviceTokens).values({ id: uid(), deviceId, tokenHash })
      await tx
        .update(S.pairings)
        .set({ status: 'approved', deviceId, tokenCiphertext: stored })
        .where(eq(S.pairings.id, pairing.id))
    })
  }

  /** 行锁保证一次性领取：解密成功后清空密文，避免重复领取。 */
  async complete(
    id: string,
    providedSecretHash: string,
    decryptToken: (ciphertext: string) => string,
  ) {
    return this.store.db.transaction(async (tx) => {
      const matches = await tx
        .select()
        .from(S.pairings)
        .where(eq(S.pairings.id, id))
        .limit(1)
        .for('update')
      const pairing = matches[0]
      if (!pairing || providedSecretHash !== pairing.secretHash) throw new UnauthorizedException()
      if (pairing.expiresAt <= new Date()) throw new BadRequestException('Expired')
      if (pairing.status === 'pending') return { status: 'pending' as const }
      if (pairing.status !== 'approved' || !pairing.tokenCiphertext || !pairing.deviceId)
        throw new BadRequestException('Used')
      const token = decryptToken(pairing.tokenCiphertext)
      await tx
        .update(S.pairings)
        .set({ status: 'consumed', tokenCiphertext: null })
        .where(eq(S.pairings.id, pairing.id))
      return { status: 'complete' as const, deviceId: pairing.deviceId, token }
    })
  }
}
