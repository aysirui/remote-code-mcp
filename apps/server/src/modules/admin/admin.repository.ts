import { Injectable } from '@nestjs/common'
import { eq, desc, count } from 'drizzle-orm'
import { Store } from '../../infrastructure/database/store'
import * as S from '../../infrastructure/database/schema'

/** 管理后台数据访问层：仅供完成管理员身份校验的业务服务调用。 */
@Injectable()
export class AdminRepository {
  constructor(private readonly store: Store) {}

  /** 查询用户摘要，避免返回密码摘要等敏感字段。 */
  async users(paging?: { page: number; pageSize: number; offset: number }) {
    const query = this.store.db
      .select({
        id: S.users.id,
        email: S.users.email,
        role: S.users.role,
        status: S.users.status,
        createdAt: S.users.createdAt,
      })
      .from(S.users)
      .orderBy(desc(S.users.createdAt), desc(S.users.id))
    if (!paging) return query.limit(500)
    const [items, totals] = await Promise.all([
      query.limit(paging.pageSize).offset(paging.offset),
      this.store.db.select({ total: count() }).from(S.users),
    ])
    return { items, total: Number(totals[0].total), page: paging.page, pageSize: paging.pageSize }
  }

  /** 读取设备元数据，在线状态由业务服务实时补充。 */
  async devices(paging?: { page: number; pageSize: number; offset: number }) {
    const query = this.store.db
      .select()
      .from(S.devices)
      .orderBy(desc(S.devices.lastSeenAt), desc(S.devices.id))
    if (!paging) return query.limit(500)
    const [items, totals] = await Promise.all([
      query.limit(paging.pageSize).offset(paging.offset),
      this.store.db.select({ total: count() }).from(S.devices),
    ])
    return { items, total: Number(totals[0].total), page: paging.page, pageSize: paging.pageSize }
  }

  /** 安全审计只查询结构化事件元数据，不读取工具参数和对话正文。 */
  async securityAudits(paging?: { page: number; pageSize: number; offset: number }) {
    const query = this.store.db
      .select()
      .from(S.securityAudits)
      .orderBy(desc(S.securityAudits.createdAt), desc(S.securityAudits.id))
    if (!paging) return query.limit(200)
    const [items, totals] = await Promise.all([
      query.limit(paging.pageSize).offset(paging.offset),
      this.store.db.select({ total: count() }).from(S.securityAudits),
    ])
    return { items, total: Number(totals[0].total), page: paging.page, pageSize: paging.pageSize }
  }

  /** 统计概览只获取标识字段，不查询用户敏感信息。 */
  async overview() {
    const [users, devices, workspaces] = await Promise.all([
      this.store.db.select({ id: S.users.id }).from(S.users),
      this.store.db.select({ id: S.devices.id }).from(S.devices),
      this.store.db.select({ id: S.workspaces.id }).from(S.workspaces),
    ])
    return { users, devices, workspaces }
  }
  /** 查询目标用户，供 Service 执行管理员角色层级校验。 */
  async userById(userId: string) {
    return this.store.one(
      this.store.db.select().from(S.users).where(eq(S.users.id, userId)).limit(1),
    )
  }

  /**
   * 用户状态与凭据变更在同一事务内提交，失败时全部回滚。
   * 禁用时同时清理 Session、OAuth Grant、Access Token 与 Refresh Token family。
   * 仅返回待断连的设备 ID，网络副作用必须在事务提交后执行。
   */
  async updateUserStatus(userId: string, status: 'active' | 'disabled') {
    return this.store.db.transaction(async (tx) => {
      await tx.update(S.users).set({ status }).where(eq(S.users.id, userId))
      if (status !== 'disabled') return [] as string[]

      await tx.delete(S.sessions).where(eq(S.sessions.userId, userId))
      const devices = await tx
        .select({ id: S.devices.id })
        .from(S.devices)
        .where(eq(S.devices.userId, userId))
      const grants = await tx
        .select({ id: S.oauthGrants.id })
        .from(S.oauthGrants)
        .where(eq(S.oauthGrants.userId, userId))
      const revokedAt = new Date()
      for (const grant of grants) {
        await tx
          .update(S.oauthRefreshTokens)
          .set({ revokedAt })
          .where(eq(S.oauthRefreshTokens.grantId, grant.id))
      }
      await tx.update(S.oauthGrants).set({ revokedAt }).where(eq(S.oauthGrants.userId, userId))
      await tx.update(S.oauthTokens).set({ revokedAt }).where(eq(S.oauthTokens.userId, userId))
      return devices.map((device) => device.id)
    })
  }

  /** 查询待撤销设备，未找到时交由 Service 返回 404。 */
  async deviceById(deviceId: string) {
    return this.store.one(
      this.store.db.select().from(S.devices).where(eq(S.devices.id, deviceId)).limit(1),
    )
  }

  /** 原子撤销设备与全部设备令牌；事务提交后由 Service 断开实时连接。 */
  async revokeDevice(deviceId: string) {
    // 事务外仅定位归属；事务内按用户 -> 设备顺序加锁并再次验证。
    const candidates = await this.store.db
      .select({ userId: S.devices.userId })
      .from(S.devices)
      .where(eq(S.devices.id, deviceId))
      .limit(1)
    if (!candidates[0]) return false
    return this.store.db.transaction(async (tx) => {
      const users = await tx
        .select({ id: S.users.id })
        .from(S.users)
        .where(eq(S.users.id, candidates[0].userId))
        .limit(1)
        .for('update')
      if (!users[0]) return false
      const devices = await tx
        .select({ id: S.devices.id, userId: S.devices.userId })
        .from(S.devices)
        .where(eq(S.devices.id, deviceId))
        .limit(1)
        .for('update')
      if (!devices[0] || devices[0].userId !== candidates[0].userId) return false
      const revokedAt = new Date()
      await tx
        .update(S.deviceTokens)
        .set({ revokedAt })
        .where(eq(S.deviceTokens.deviceId, deviceId))
      await tx.update(S.devices).set({ status: 'revoked' }).where(eq(S.devices.id, deviceId))
      return true
    })
  }
}
