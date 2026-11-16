import {
  Controller,
  Get,
  Patch,
  Delete,
  Req,
  Param,
  Body,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common'
import type { Request } from 'express'
import { eq, and, desc, isNull, count } from 'drizzle-orm'
import { Identity } from './identity'
import { Store } from './store'
import { DeviceHub } from './device-hub'
import { csrf } from './http-security'
import * as S from './schema'
import { parsePagination } from './pagination'

/** 当前登录用户的设备、工作区、OAuth 授权与个人操作记录接口。 */
@Controller('api')
export class AccountController {
  constructor(
    private readonly id: Identity,
    private readonly store: Store,
    private readonly hub: DeviceHub,
  ) {}

  /** 仅返回当前用户自己的设备与在线状态。 */
  @Get('me/devices') async devices(@Req() req: Request) {
    const u = await this.id.requireUser(req)
    return (await this.store.db.select().from(S.devices).where(eq(S.devices.userId, u.id))).map(
      (d) => ({ ...d, online: this.hub.isOnline(d.id) }),
    )
  }

  /** 仅允许用户修改自己设备的名称。 */
  @Patch('me/devices/:id') async rename(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() b: { name?: unknown },
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

  /** 撤销用户自己的设备和全部设备凭据，并断开连接。 */
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
    await this.store.securityAudit({
      actorType: 'user',
      actorId: u.id,
      eventType: 'device.revoke',
      resourceType: 'device',
      resourceId: id,
      result: 'success',
    })
    return { ok: true }
  }

  /** 计算本地与云端授权交集；响应只包含工作区显示名和权限，不包含目录信息。 */
  @Get('me/workspaces') async workspaces(@Req() req: Request) {
    const u = await this.id.requireUser(req)
    return (
      await this.store.db.select().from(S.workspaces).where(eq(S.workspaces.userId, u.id))
    ).map((w) => ({
      id: w.id,
      deviceId: w.deviceId,
      name: w.name,
      enabled: w.localEnabled && w.cloudEnabled,
      read: w.localEnabled && w.cloudEnabled && w.localRead && w.cloudRead,
      write:
        w.localEnabled &&
        w.cloudEnabled &&
        w.localRead &&
        w.cloudRead &&
        w.localWrite &&
        w.cloudWrite,
      localPolicies: {
        file: w.localFilePolicy,
        git: w.localGitPolicy,
        command: w.localCommandPolicy,
      },
      cloudPolicies: {
        file: w.cloudFilePolicy,
        git: w.cloudGitPolicy,
        command: w.cloudCommandPolicy,
      },
    }))
  }

  /** 用户可独立配置云端策略；云端策略不能覆盖 Runtime 本地策略或 Hard Deny。 */
  @Patch('me/workspaces/:id') async restrictWorkspace(
    @Req() req: Request,
    @Param('id') id: string,
    @Body()
    b: {
      enabled?: unknown
      write?: unknown
      read?: unknown
      policies?: { file?: unknown; git?: unknown; command?: unknown }
    },
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
    const patch: {
      cloudEnabled?: boolean
      cloudWrite?: boolean
      cloudRead?: boolean
      cloudFilePolicy?: string
      cloudGitPolicy?: string
      cloudCommandPolicy?: string
    } = {}
    if (b.enabled === false) patch.cloudEnabled = false
    if (b.write === false) patch.cloudWrite = false
    if (b.read === false) patch.cloudRead = false
    const policyUpdates = b.policies
    const allowedPolicies = ['deny', 'approval', 'allow']
    if (policyUpdates !== undefined) {
      if (!policyUpdates || typeof policyUpdates !== 'object')
        throw new BadRequestException('Invalid workspace policies')
      for (const domain of ['file', 'git', 'command'] as const) {
        const value = policyUpdates[domain]
        if (value === undefined) continue
        if (!allowedPolicies.includes(String(value)))
          throw new BadRequestException('Invalid ' + domain + ' policy')
        if (domain === 'file') patch.cloudFilePolicy = value as string
        if (domain === 'git') patch.cloudGitPolicy = value as string
        if (domain === 'command') patch.cloudCommandPolicy = value as string
      }
    }
    if (!Object.keys(patch).length)
      throw new BadRequestException('No valid workspace policy update')
    await this.store.db.update(S.workspaces).set(patch).where(eq(S.workspaces.id, id))
    await this.store.securityAudit({
      actorType: 'user',
      actorId: u.id,
      eventType: policyUpdates ? 'workspace.policy.update' : 'workspace.restrict',
      resourceType: 'workspace',
      resourceId: id,
      result: 'success',
    })
    return { ok: true }
  }

  /** 持久授权关系不随 Access Token 到期而消失。 */
  @Get('me/oauth-grants') async oauthGrants(@Req() req: Request) {
    const u = await this.id.requireUser(req)
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
      .where(and(eq(S.oauthGrants.userId, u.id), isNull(S.oauthGrants.revokedAt)))
  }

  /** 撤销授权、所有 Access Tokens 和所有 Refresh Token family。 */
  @Delete('me/oauth-grants/:clientId') async revokeOauth(
    @Req() req: Request,
    @Param('clientId') clientId: string,
  ) {
    csrf(req)
    const u = await this.id.requireUser(req)
    await this.store.db.transaction(async (tx) => {
      const grants = await tx
        .select()
        .from(S.oauthGrants)
        .where(and(eq(S.oauthGrants.userId, u.id), eq(S.oauthGrants.clientId, clientId)))
      for (const grant of grants)
        await tx
          .update(S.oauthRefreshTokens)
          .set({ revokedAt: new Date() })
          .where(eq(S.oauthRefreshTokens.grantId, grant.id))
      await tx
        .update(S.oauthGrants)
        .set({ revokedAt: new Date() })
        .where(and(eq(S.oauthGrants.userId, u.id), eq(S.oauthGrants.clientId, clientId)))
      await tx
        .update(S.oauthTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(S.oauthTokens.userId, u.id), eq(S.oauthTokens.clientId, clientId)))
    })
    await this.store.securityAudit({
      actorType: 'user',
      actorId: u.id,
      eventType: 'oauth.grant.revoke',
      resourceType: 'oauth_client',
      resourceId: clientId,
      result: 'success',
    })
    return { ok: true }
  }

  /** 当前用户自己的 MCP 工具执行记录；只返回最小化元数据。 */
  @Get('me/operation-logs') async operationLogs(@Req() req: Request) {
    const u = await this.id.requireUser(req)
    const paging = parsePagination(req.query)
    const filter = eq(S.operationLogs.userId, u.id)
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
