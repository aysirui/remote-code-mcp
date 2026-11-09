import {
  Controller,
  Get,
  Patch,
  Post,
  Req,
  Param,
  Body,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import type { Request } from 'express'
import { eq, desc } from 'drizzle-orm'
import { Identity } from './identity'
import { Store } from './store'
import { DeviceHub } from './device-hub'
import { csrf } from './http-security'
import * as S from './schema'

/** 管理员用户、设备和审计接口；业务处理前必须验证管理员角色与目标权限。 */
@Controller('api')
export class AdminController {
  constructor(
    private readonly id: Identity,
    private readonly store: Store,
    private readonly hub: DeviceHub,
  ) {}
  /** 列出管理员允许查看的用户摘要。 */
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
  /** 修改目标用户状态，阻止自禁用和低权限管理员操作高权限角色。 */
  @Patch('admin/users/:id/status') async userStatus(
    @Req() req: Request,
    @Param('id') target: string,
    @Body() b: { status?: string },
  ) {
    csrf(req)
    const u = await this.id.requireAdmin(req)
    if (u.id === target) throw new ForbiddenException('Cannot disable self')
    const status = b.status
    if (status !== 'active' && status !== 'disabled') throw new BadRequestException()
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
      await this.store.db.transaction(async (tx) => {
        const grants = await tx.select().from(S.oauthGrants).where(eq(S.oauthGrants.userId, target))
        for (const grant of grants)
          await tx
            .update(S.oauthRefreshTokens)
            .set({ revokedAt: new Date() })
            .where(eq(S.oauthRefreshTokens.grantId, grant.id))
        await tx
          .update(S.oauthGrants)
          .set({ revokedAt: new Date() })
          .where(eq(S.oauthGrants.userId, target))
        await tx
          .update(S.oauthTokens)
          .set({ revokedAt: new Date() })
          .where(eq(S.oauthTokens.userId, target))
      })
    }
    await this.store.audit('admin.user_status', 'success', u.id)
    return { ok: true }
  }
  /** 列出设备与在线状态，不授予跨用户文件访问能力。 */
  @Get('admin/devices') async adminDevices(@Req() req: Request) {
    await this.id.requireAdmin(req)
    return (await this.store.db.select().from(S.devices).limit(500)).map((d) => ({
      ...d,
      online: this.hub.isOnline(d.id),
    }))
  }
  /** 管理员撤销指定设备凭据和连接。 */
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
  /** 查询平台操作审计记录。 */
  @Get('admin/audit-logs') async adminLogs(@Req() req: Request) {
    await this.id.requireAdmin(req)
    return this.store.db.select().from(S.auditLogs).orderBy(desc(S.auditLogs.createdAt)).limit(200)
  }
  /** 聚合平台用户、设备和工作区数量。 */
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
}
