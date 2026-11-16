import { Controller, Get, Patch, Delete, Req, Param, Body } from '@nestjs/common'
import type { Request } from 'express'
import { Identity } from '../core/identity'
import { AccountService } from './account.service'
import { csrf } from '../../common/http-security'
import { parsePagination } from '../../common/pagination'

/** 当前登录用户的设备、工作区、OAuth 授权与个人操作记录接口。 */
@Controller('api')
export class AccountController {
  /** 通过 NestJS 注入业务服务，不在 Controller 中手动创建实例。 */
  constructor(
    private readonly id: Identity,
    private readonly account: AccountService,
  ) {}

  /** 仅返回当前用户自己的设备与在线状态。 */
  @Get('me/devices') async devices(@Req() req: Request) {
    const u = await this.id.requireUser(req)
    return this.account.devices(u.id)
  }

  /** 仅允许用户修改自己设备的名称。 */
  @Patch('me/devices/:id') async rename(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() b: { name?: unknown },
  ) {
    csrf(req)
    const u = await this.id.requireUser(req)
    return this.account.renameDevice(u.id, id, b.name)
  }

  /** 撤销用户自己的设备和全部设备凭据，并断开连接。 */
  @Delete('me/devices/:id') async revoke(@Req() req: Request, @Param('id') id: string) {
    csrf(req)
    const u = await this.id.requireUser(req)
    return this.account.revokeDevice(u.id, id)
  }

  /** 展示 Runtime 同步的工作区权限与策略，不包含本地目录信息。 */
  @Get('me/workspaces') async workspaces(@Req() req: Request) {
    const u = await this.id.requireUser(req)
    return this.account.workspaces(u.id)
  }

  /** 仅允许当前用户撤销自己的远程工作区授权，不影响本地目录。 */
  @Delete('me/workspaces/:id') async revokeWorkspace(@Req() req: Request, @Param('id') id: string) {
    csrf(req)
    const u = await this.id.requireUser(req)
    return this.account.revokeWorkspace(u.id, id)
  }

  /** 持久授权关系不随 Access Token 到期而消失。 */
  @Get('me/oauth-grants') async oauthGrants(@Req() req: Request) {
    const u = await this.id.requireUser(req)
    return this.account.oauthGrants(u.id)
  }

  /** 撤销授权、所有 Access Tokens 和所有 Refresh Token family。 */
  @Delete('me/oauth-grants/:clientId') async revokeOauth(
    @Req() req: Request,
    @Param('clientId') clientId: string,
  ) {
    csrf(req)
    const u = await this.id.requireUser(req)
    return this.account.revokeOauth(u.id, clientId)
  }

  /** 当前用户自己的 MCP 工具执行记录，包含元数据及脱敏命令摘要。 */
  @Get('me/operation-logs') async operationLogs(@Req() req: Request) {
    const u = await this.id.requireUser(req)
    return this.account.operationLogs(u.id, parsePagination(req.query))
  }
}
