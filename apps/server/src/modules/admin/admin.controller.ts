import { Controller, Get, Patch, Post, Req, Param, Body } from '@nestjs/common'
import type { Request } from 'express'
import { Identity } from '../core/identity'
import { AdminService } from './admin.service'
import { csrf } from '../../common/http-security'
import { parsePagination } from '../../common/pagination'

/** 管理员用户、设备和安全审计接口；业务处理前必须验证管理员角色。 */
@Controller('api')
export class AdminController {
  /** 通过 NestJS 注入业务服务，不在 Controller 中手动创建实例。 */
  constructor(
    private readonly id: Identity,
    private readonly admin: AdminService,
  ) {}

  /** 列出管理员允许查看的用户摘要。 */
  @Get('admin/users') async users(@Req() req: Request) {
    await this.id.requireAdmin(req)
    return this.admin.users(parsePagination(req.query))
  }

  /** 修改目标用户状态，阻止自禁用和低权限管理员操作高权限角色。 */
  @Patch('admin/users/:id/status') async userStatus(
    @Req() req: Request,
    @Param('id') target: string,
    @Body() b: { status?: string },
  ) {
    csrf(req)
    const user = await this.id.requireAdmin(req)
    return this.admin.changeUserStatus(user, target, b.status)
  }

  /** 列出设备与在线状态，不授予跨用户文件访问能力。 */
  @Get('admin/devices') async adminDevices(@Req() req: Request) {
    await this.id.requireAdmin(req)
    return this.admin.devices(parsePagination(req.query))
  }

  /** 管理员撤销指定设备凭据和连接。 */
  @Post('admin/devices/:id/revoke') async adminRevokeDevice(
    @Req() req: Request,
    @Param('id') deviceId: string,
  ) {
    csrf(req)
    const user = await this.id.requireAdmin(req)
    return this.admin.revokeDevice(user.id, deviceId)
  }

  /** 仅管理员可查询平台安全审计，不包含 MCP 对话或工具参数。 */
  @Get('admin/security-audits') async securityAudits(@Req() req: Request) {
    await this.id.requireAdmin(req)
    return this.admin.securityAudits(parsePagination(req.query))
  }

  /** 聚合平台用户、设备和工作区数量。 */
  @Get('admin/overview') async overview(@Req() req: Request) {
    await this.id.requireAdmin(req)
    return this.admin.overview()
  }
}
