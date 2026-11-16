import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { Store } from '../../infrastructure/database/store'
import { DeviceHub } from '../device/device-hub'
import { AdminRepository } from './admin.repository'

/** 管理后台业务层：组合实时设备状态与数据库查询结果。 */
@Injectable()
export class AdminService {
  constructor(
    private readonly store: Store,
    private readonly hub: DeviceHub,
    private readonly repository: AdminRepository,
  ) {}

  /** 管理员用户列表仅返回必要的公开摘要字段。 */
  async users(paging?: { page: number; pageSize: number; offset: number }) {
    return this.repository.users(paging)
  }

  /** 保留未分页数组和分页对象两种兼容响应形式。 */
  async devices(paging?: { page: number; pageSize: number; offset: number }) {
    const result = await this.repository.devices(paging)
    if (Array.isArray(result)) return result.map((d) => ({ ...d, online: this.hub.isOnline(d.id) }))
    return {
      ...result,
      items: result.items.map((d) => ({ ...d, online: this.hub.isOnline(d.id) })),
    }
  }

  /** 审计记录不包含 MCP 对话或工具参数。 */
  async securityAudits(paging?: { page: number; pageSize: number; offset: number }) {
    return this.repository.securityAudits(paging)
  }

  /** 组合持久化数量和实时在线设备数量。 */
  async overview() {
    const { users, devices, workspaces } = await this.repository.overview()
    return {
      users: users.length,
      devices: devices.length,
      online: devices.filter((d) => this.hub.isOnline(d.id)).length,
      workspaces: workspaces.length,
    }
  }
  /** 修改用户状态前校验角色边界，禁用时撤销凭据并断开在线设备。 */
  async changeUserStatus(actor: { id: string; role: string }, target: string, status: unknown) {
    if (actor.id === target) throw new ForbiddenException('Cannot disable self')
    if (status !== 'active' && status !== 'disabled') throw new BadRequestException()
    const old = await this.repository.userById(target)
    if (
      !old ||
      old.role === 'super_admin' ||
      (old.role === 'admin' && actor.role !== 'super_admin')
    )
      throw new ForbiddenException()
    // 先提交数据库事务，再断开在线设备；事务失败不得提前执行断连副作用。
    const deviceIds = await this.repository.updateUserStatus(target, status)
    for (const deviceId of deviceIds) this.hub.disconnect(deviceId)
    await this.store.securityAudit({
      actorType: 'admin',
      actorId: actor.id,
      eventType: 'user.status.change',
      resourceType: 'user',
      resourceId: target,
      result: 'success',
    })
    return { ok: true }
  }

  /** 管理员撤销设备凭据、断开连接并写入安全审计。 */
  async revokeDevice(actorId: string, deviceId: string) {
    const device = await this.repository.deviceById(deviceId)
    if (!device) throw new NotFoundException()
    // 事务内复查失败不能误报成功，更不能断开其他用户的设备。
    if (!(await this.repository.revokeDevice(deviceId))) throw new NotFoundException()
    this.hub.disconnect(deviceId)
    await this.store.securityAudit({
      actorType: 'admin',
      actorId,
      eventType: 'device.revoke',
      resourceType: 'device',
      resourceId: deviceId,
      result: 'success',
    })
    return { ok: true }
  }
}
