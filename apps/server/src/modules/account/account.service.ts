import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common'
import { Store } from '../../infrastructure/database/store'
import { DeviceHub } from '../device/device-hub'
import { AccountRepository } from './account.repository'

/** 当前用户的设备与工作区只读业务视图；仅按已认证 userId 查询。 */
@Injectable()
export class AccountService {
  constructor(
    private readonly store: Store,
    private readonly hub: DeviceHub,
    private readonly repository: AccountRepository,
  ) {}

  /** 只返回用户自己的设备，在线状态取自实时连接管理器。 */
  async devices(userId: string) {
    return (await this.repository.devices(userId)).map((device) => ({
      ...device,
      online: this.hub.isOnline(device.id),
    }))
  }

  /** 工作区视图不包含本机绝对路径，避免将 Runtime 私有信息同步到平台。 */
  async workspaces(userId: string) {
    return (await this.repository.workspaces(userId)).map((w) => ({
      id: w.id,
      deviceId: w.deviceId,
      name: w.name,
      enabled: w.localEnabled,
      read: w.localEnabled && w.localRead,
      write: w.localEnabled && w.localRead && w.localWrite,
      policies: {
        file: w.localFilePolicy,
        git: w.localGitPolicy,
        command: w.localCommandPolicy,
      },
    }))
  }
  /** Server 撤销工作区授权不会删除 Runtime 本地目录；旧快照不得恢复授权。 */
  async revokeWorkspace(userId: string, workspaceId: string) {
    const revoked = await this.repository.revokeWorkspace(userId, workspaceId)
    if (!revoked) throw new NotFoundException()
    await this.store.securityAudit({
      actorType: 'user',
      actorId: userId,
      eventType: 'workspace.revoke',
      resourceType: 'workspace',
      resourceId: workspaceId,
      result: 'success',
    })
    return { ok: true }
  }

  /** 校验名称并限制长度；设备 ID 必须属于当前用户。 */
  async renameDevice(userId: string, deviceId: string, rawName: unknown) {
    const name = String(rawName || '')
      .trim()
      .slice(0, 128)
    if (!name) throw new BadRequestException()
    await this.repository.renameDevice(userId, deviceId, name)
    return { ok: true }
  }

  /** 撤销设备凭据、断开实时连接并记录安全审计。 */
  async revokeDevice(userId: string, deviceId: string) {
    const device = await this.repository.ownedDevice(userId, deviceId)
    if (!device) throw new NotFoundException()
    const revoked = await this.repository.revokeDevice(userId, deviceId)
    if (!revoked) throw new NotFoundException()
    this.hub.disconnect(deviceId)
    await this.store.securityAudit({
      actorType: 'user',
      actorId: userId,
      eventType: 'device.revoke',
      resourceType: 'device',
      resourceId: deviceId,
      result: 'success',
    })
    return { ok: true }
  }

  /** 持久授权列表仅返回未撤销的当前用户授权。 */
  async oauthGrants(userId: string) {
    return this.repository.oauthGrants(userId)
  }

  /** 完成 Token family 撤销后记录安全审计。 */
  async revokeOauth(userId: string, clientId: string) {
    const revoked = await this.repository.revokeOauth(userId, clientId)
    if (!revoked) throw new NotFoundException()
    await this.store.securityAudit({
      actorType: 'user',
      actorId: userId,
      eventType: 'oauth.grant.revoke',
      resourceType: 'oauth_client',
      resourceId: clientId,
      result: 'success',
    })
    return { ok: true }
  }

  /** 用户操作日志不返回 MCP 会话内容。 */
  async operationLogs(userId: string, paging?: { page: number; pageSize: number; offset: number }) {
    return this.repository.operationLogs(userId, paging)
  }
}
