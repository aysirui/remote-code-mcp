import { Injectable } from '@nestjs/common'
import { eq, and, desc, isNull, count } from 'drizzle-orm'
import { Store } from '../../infrastructure/database/store'
import * as S from '../../infrastructure/database/schema'

/** Account 数据访问层：所有查询必须以当前认证用户 ID 为过滤条件。 */
@Injectable()
export class AccountRepository {
  constructor(private readonly store: Store) {}

  /** 按用户 ID 查询设备，不允许跨用户枚举。 */
  async devices(userId: string) {
    return this.store.db.select().from(S.devices).where(eq(S.devices.userId, userId))
  }

  /** 仅查询同步的工作区权限元数据，不读取 Runtime 私有绝对路径。 */
  async workspaces(userId: string) {
    return this.store.db.select().from(S.workspaces).where(eq(S.workspaces.userId, userId))
  }
  /** 持久撤销当前用户的工作区授权，墓碑与删除在同一事务提交。 */
  async revokeWorkspace(userId: string, workspaceId: string) {
    // 设备定位放在事务外，避免 MySQL REPEATABLE READ 提前创建一致性快照。
    // 事务内部首先锁设备，再用当前读重新校验工作区归属。
    const candidates = await this.store.db
      .select({ deviceId: S.workspaces.deviceId })
      .from(S.workspaces)
      .where(and(eq(S.workspaces.id, workspaceId), eq(S.workspaces.userId, userId)))
      .limit(1)
    if (!candidates[0]) return false
    return this.store.db.transaction(async (tx) => {
      // 用户 -> 设备 -> 工作区的锁顺序与 hello、账号禁用保持一致。
      const users = await tx
        .select({ id: S.users.id })
        .from(S.users)
        .where(eq(S.users.id, userId))
        .limit(1)
        .for('update')
      if (!users[0]) return false
      const devices = await tx
        .select({ id: S.devices.id })
        .from(S.devices)
        .where(and(eq(S.devices.id, candidates[0].deviceId), eq(S.devices.userId, userId)))
        .limit(1)
        .for('update')
      if (!devices[0]) return false
      const rows = await tx
        .select({ id: S.workspaces.id, deviceId: S.workspaces.deviceId })
        .from(S.workspaces)
        .where(and(eq(S.workspaces.id, workspaceId), eq(S.workspaces.userId, userId)))
        .limit(1)
        .for('update')
      const workspace = rows[0]
      if (!workspace || workspace.deviceId !== candidates[0].deviceId) return false
      await tx.insert(S.workspaceRevocations).values({
        id: workspace.id,
        deviceId: workspace.deviceId,
        userId,
      })
      await tx
        .delete(S.workspaces)
        .where(and(eq(S.workspaces.id, workspaceId), eq(S.workspaces.userId, userId)))
      return true
    })
  }

  /** 按用户和设备双重条件修改设备名称。 */
  async renameDevice(userId: string, deviceId: string, name: string) {
    await this.store.db
      .update(S.devices)
      .set({ name })
      .where(and(eq(S.devices.id, deviceId), eq(S.devices.userId, userId)))
  }

  /** 只允许查找当前用户自己的设备。 */
  async ownedDevice(userId: string, deviceId: string) {
    return this.store.one(
      this.store.db
        .select()
        .from(S.devices)
        .where(and(eq(S.devices.id, deviceId), eq(S.devices.userId, userId)))
        .limit(1),
    )
  }

  /** 事务内再次校验设备归属，原子撤销设备及其凭据，防止检查与写入之间的竞态。 */
  async revokeDevice(userId: string, deviceId: string) {
    return this.store.db.transaction(async (tx) => {
      // 与 hello 统一先锁用户再锁设备，避免并发禁用账号时出现反向等待。
      const users = await tx
        .select({ id: S.users.id })
        .from(S.users)
        .where(eq(S.users.id, userId))
        .limit(1)
        .for('update')
      if (!users[0]) return false
      const rows = await tx
        .select({ id: S.devices.id })
        .from(S.devices)
        .where(and(eq(S.devices.id, deviceId), eq(S.devices.userId, userId)))
        .limit(1)
        .for('update')
      if (!rows[0]) return false
      const revokedAt = new Date()
      await tx
        .update(S.deviceTokens)
        .set({ revokedAt })
        .where(eq(S.deviceTokens.deviceId, deviceId))
      await tx
        .update(S.devices)
        .set({ status: 'revoked' })
        .where(and(eq(S.devices.id, deviceId), eq(S.devices.userId, userId)))
      return true
    })
  }

  /** 仅返回未撤销的当前用户 OAuth 授权。 */
  async oauthGrants(userId: string) {
    return this.store.db
      .select({
        id: S.oauthGrants.id,
        clientId: S.oauthGrants.clientId,
        clientName: S.oauthClients.clientName,
        scope: S.oauthGrants.scope,
        createdAt: S.oauthGrants.createdAt,
        lastUsedAt: S.oauthGrants.lastUsedAt,
      })
      .from(S.oauthGrants)
      .leftJoin(S.oauthClients, eq(S.oauthGrants.clientId, S.oauthClients.clientId))
      .where(and(eq(S.oauthGrants.userId, userId), isNull(S.oauthGrants.revokedAt)))
  }

  /** 锁定当前用户授权并原子撤销 Grant、Access 与 Refresh，未找到时不写入。 */
  async revokeOauth(userId: string, clientId: string) {
    return this.store.db.transaction(async (tx) => {
      const grants = await tx
        .select({ id: S.oauthGrants.id })
        .from(S.oauthGrants)
        .where(and(eq(S.oauthGrants.userId, userId), eq(S.oauthGrants.clientId, clientId)))
        .limit(1)
        .for('update')
      const grant = grants[0]
      if (!grant) return false
      const revokedAt = new Date()
      await tx
        .update(S.oauthRefreshTokens)
        .set({ revokedAt })
        .where(eq(S.oauthRefreshTokens.grantId, grant.id))
      await tx
        .update(S.oauthTokens)
        .set({ revokedAt })
        .where(and(eq(S.oauthTokens.userId, userId), eq(S.oauthTokens.clientId, clientId)))
      await tx.update(S.oauthGrants).set({ revokedAt }).where(eq(S.oauthGrants.id, grant.id))
      return true
    })
  }

  /** 读取当前用户操作日志；未传分页时保留原有数组响应。 */
  async operationLogs(userId: string, paging?: { page: number; pageSize: number; offset: number }) {
    const filter = eq(S.operationLogs.userId, userId)
    const query = this.store.db
      .select()
      .from(S.operationLogs)
      .where(filter)
      .orderBy(desc(S.operationLogs.createdAt), desc(S.operationLogs.id))
    if (!paging) return query.limit(100)
    const [items, totals] = await Promise.all([
      query.limit(paging.pageSize).offset(paging.offset),
      this.store.db.select({ total: count() }).from(S.operationLogs).where(filter),
    ])
    return { items, total: Number(totals[0].total), page: paging.page, pageSize: paging.pageSize }
  }
}
