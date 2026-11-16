import { and, eq } from 'drizzle-orm'
import { HelloSchema } from '@rcm/protocol'
import * as S from '../../infrastructure/database/schema'
import { Store } from '../../infrastructure/database/store'

/** 旧连接在数据库事务提交前失效时，必须回滚整次工作区同步。 */
export class StaleDeviceConnectionError extends Error {}

/**
 * 将 Runtime hello 快照与服务端授权状态合并。
 * 连接有效性由 DeviceHub 提供；撤销墓碑始终优先于 Runtime 的旧授权。
 */
export async function synchronizeDeviceHello(
  store: Store,
  deviceId: string,
  message: unknown,
  isCurrent: () => boolean,
): Promise<Set<string> | null> {
  const h = HelloSchema.parse(message)
  const d = await store.one(
    store.db.select().from(S.devices).where(eq(S.devices.id, deviceId)).limit(1),
  )
  // 已撤销设备或被替换的连接不得继续同步工作区，避免迟到的 hello 恢复旧权限。
  if (!d || d.status !== 'active' || !isCurrent()) return null
  const owner = await store.one(
    store.db
      .select({ status: S.users.status })
      .from(S.users)
      .where(eq(S.users.id, d.userId))
      .limit(1),
  )
  if (!owner || owner.status !== 'active' || !isCurrent()) return null
  // 与主动撤销使用相同的工作区行锁；事务内查询墓碑并更新快照，避免半同步状态。
  const revokedIds = await store.db.transaction(async (tx) => {
    // 统一按用户 -> 设备 -> 工作区获取锁，避免与管理员禁用用户形成锁循环。
    const users = await tx
      .select({ status: S.users.status })
      .from(S.users)
      .where(eq(S.users.id, d.userId))
      .limit(1)
      .for('update')
    if (!users[0] || users[0].status !== 'active' || !isCurrent()) return null
    const devices = await tx
      .select({ id: S.devices.id, status: S.devices.status })
      .from(S.devices)
      .where(and(eq(S.devices.id, deviceId), eq(S.devices.userId, d.userId)))
      .limit(1)
      .for('update')
    // 等待设备锁期间可能发生连接替换或设备撤销，必须再次检查。
    if (!devices[0] || devices[0].status !== 'active' || !isCurrent()) return null
    // 设备状态在取得行锁后再次确认；元数据更新与工作区同步共同提交。
    await tx
      .update(S.devices)
      .set({ runtimeVersion: h.runtimeVersion, lastSeenAt: new Date() })
      .where(and(eq(S.devices.id, deviceId), eq(S.devices.status, 'active')))
    const ids = new Set(h.workspaces.map((x) => x.id))
    const existing = await tx
      .select()
      .from(S.workspaces)
      .where(eq(S.workspaces.deviceId, deviceId))
      .for('update')
    for (const w of existing) {
      if (!ids.has(w.id))
        await tx
          .delete(S.workspaces)
          .where(and(eq(S.workspaces.id, w.id), eq(S.workspaces.deviceId, deviceId)))
    }
    // Server 已撤销的授权属于持久拒绝列表，不能被 Runtime 的旧 hello 快照覆盖。
    const revocations = await tx
      .select({ id: S.workspaceRevocations.id })
      .from(S.workspaceRevocations)
      .where(eq(S.workspaceRevocations.deviceId, deviceId))
    const revokedIds = new Set(revocations.map((item) => item.id))
    for (const w of h.workspaces) {
      if (revokedIds.has(w.id)) continue
      const old = existing.find((x) => x.id === w.id)
      if (old) {
        await tx
          .update(S.workspaces)
          .set({
            name: w.name,
            localRead: w.permissions.read,
            localWrite: w.permissions.write,
            localEnabled: w.enabled,
            localFilePolicy: w.policies.file,
            localGitPolicy: w.policies.git,
            localCommandPolicy: w.policies.command,
          })
          .where(and(eq(S.workspaces.id, w.id), eq(S.workspaces.deviceId, deviceId)))
      } else {
        await tx.insert(S.workspaces).values({
          id: w.id,
          deviceId,
          userId: d.userId,
          name: w.name,
          localRead: w.permissions.read,
          localWrite: w.permissions.write,
          localEnabled: w.enabled,
          localFilePolicy: w.policies.file,
          localGitPolicy: w.policies.git,
          localCommandPolicy: w.policies.command,
        })
      }
    }
    // 同步期间连接可能被替换；提交前最后检查，失败则抛错让事务整体回滚。
    if (!isCurrent()) throw new StaleDeviceConnectionError()
    return revokedIds
  })
  return revokedIds
}
