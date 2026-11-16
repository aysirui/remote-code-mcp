import { eq } from 'drizzle-orm'
import * as S from '../../infrastructure/database/schema'
import { Store } from '../../infrastructure/database/store'
import { hash } from '../../common/security'

/** 校验设备握手令牌、设备状态和所属账号状态；不记录原始凭据。 */
export async function authenticateDevice(store: Store, authorization: string): Promise<string> {
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
  if (!token) throw new Error('No token')
  const credential = await store.one(
    store.db
      .select()
      .from(S.deviceTokens)
      .where(eq(S.deviceTokens.tokenHash, hash(token)))
      .limit(1),
  )
  if (!credential || credential.revokedAt) throw new Error('Credential revoked')
  const device = await store.one(
    store.db.select().from(S.devices).where(eq(S.devices.id, credential.deviceId)).limit(1),
  )
  if (!device || device.status !== 'active') throw new Error('Device revoked')
  const owner = await store.one(
    store.db.select().from(S.users).where(eq(S.users.id, device.userId)).limit(1),
  )
  if (!owner || owner.status !== 'active') throw new Error('Account suspended')
  return device.id
}
