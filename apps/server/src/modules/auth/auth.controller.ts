import { Controller, Get, Post, Req, Res, Body } from '@nestjs/common'
import type { Request, Response } from 'express'
import { AuthService } from './auth.service'
import { secret } from '../../common/security'
import { base, csrf, setCookie } from '../../common/http-security'

/** 平台用户注册、登录、会话及修改密码接口；不得通过公开注册授予管理员角色。 */
@Controller('api')
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  /** 下发浏览器双重提交 CSRF Token。 */
  @Get('auth/csrf') async csrfToken(@Req() req: Request, @Res() res: Response) {
    let token = req.cookies?.rcm_csrf
    if (!token) {
      token = secret()
      res.cookie('rcm_csrf', token, {
        httpOnly: false,
        secure: base().startsWith('https:'),
        sameSite: 'lax',
        path: '/',
      })
    }
    res.json({ csrfToken: token })
  }
  /** 验证 CSRF 并仅创建普通用户账号。 */
  @Post('auth/register') async register(@Req() req: Request, @Body() b: Record<string, unknown>) {
    csrf(req)
    return this.auth.register(String(b.email || ''), String(b.password || ''))
  }
  /** 验证 CSRF 后消费邮箱激活令牌，不创建登录会话。 */
  @Post('auth/activate-email') async activateEmail(
    @Req() req: Request,
    @Body() b: Record<string, unknown>,
  ) {
    csrf(req)
    return this.auth.activateEmail(String(b.token || ''))
  }
  /** 验证账号凭据并按冷却期重发激活邮件。 */
  @Post('auth/resend-activation') async resendActivation(
    @Req() req: Request,
    @Body() b: Record<string, unknown>,
  ) {
    csrf(req)
    return this.auth.resendActivation(String(b.email || ''), String(b.password || ''))
  }
  /** 服务端验证密码后写入 HttpOnly Session Cookie。 */
  @Post('auth/login') async login(
    @Req() req: Request,
    @Res() res: Response,
    @Body() b: Record<string, unknown>,
  ) {
    csrf(req)
    const { user, raw } = await this.auth.login(String(b.email || ''), String(b.password || ''))
    setCookie(res, 'rcm_session', raw)
    res.json({
      id: user.id,
      email: user.email,
      role: user.role,
      passwordChangeRequired: user.passwordChangeRequired,
    })
  }
  /** 强制改密及主动改密入口；完成后要求重新认证。 */
  @Post('auth/change-password') async changePassword(
    @Req() req: Request,
    @Res() res: Response,
    @Body() b: Record<string, unknown>,
  ) {
    csrf(req)
    await this.auth.changePassword(
      req,
      String(b.currentPassword || ''),
      String(b.newPassword || ''),
    )
    res.clearCookie('rcm_session')
    res.json({ ok: true, reauthenticate: true })
  }
  /** 清除 Session 与浏览器 Cookie。 */
  @Post('auth/logout') async logout(@Req() req: Request, @Res() res: Response) {
    csrf(req)
    await this.auth.logout(req)
    res.clearCookie('rcm_session')
    res.json({ ok: true })
  }
  /** 获取当前登录用户和首次改密状态。 */
  @Get('auth/me') async me(@Req() req: Request) {
    return this.auth.currentUser(req)
  }
}
