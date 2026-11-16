import { Injectable } from '@nestjs/common'
import type { Request } from 'express'
import { Identity } from '../core/identity'

/** 认证业务服务：封装注册、登录、改密和会话生命周期；HTTP Cookie/CSRF 留在 Controller。 */
@Injectable()
export class AuthService {
  constructor(private readonly identity: Identity) {}

  /** 公开注册仅创建普通账号，角色与密码规则由 Identity 统一校验。 */
  async register(email: string, password: string) {
    const user = await this.identity.register(email, password)
    return { id: user.id, email: user.email }
  }

  /** 验证凭据并返回会话 Token；明文 Token 仅交给 Controller 写入 HttpOnly Cookie。 */
  async login(email: string, password: string) {
    return this.identity.login(email, password)
  }

  /** 修改密码时撤销既有会话，要求用户重新登录。 */
  async changePassword(req: Request, currentPassword: string, newPassword: string) {
    await this.identity.changePassword(req, currentPassword, newPassword)
  }

  /** 退出当前会话。 */
  async logout(req: Request) {
    await this.identity.logOut(req)
  }

  /** 查询当前用户，强制改密及会话校验继续由 Identity 处理。 */
  async currentUser(req: Request) {
    const user = await this.identity.requireUser(req)
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
      passwordChangeRequired: user.passwordChangeRequired,
    }
  }
}
