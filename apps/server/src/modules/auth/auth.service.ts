import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { and, eq, gt } from 'drizzle-orm'
import * as bcrypt from 'bcryptjs'
import * as S from '../../infrastructure/database/schema'
import { hash, secret } from '../../common/security'
import { MailService } from '../mail/mail.service'
import { env } from '../../config/env'
import type { Request } from 'express'
import { Identity } from '../core/identity'

/** 认证业务服务：封装注册、登录、改密和会话生命周期；HTTP Cookie/CSRF 留在 Controller。 */
@Injectable()
export class AuthService {
  constructor(
    private readonly identity: Identity,
    private readonly mail: MailService,
  ) {}

  /** 公开注册创建未验证的普通账号并发送激活邮件；返回账号摘要与需激活标记。 */
  async register(email: string, password: string) {
    void env.mail
    const user = await this.identity.register(email, password)
    await this.sendActivation(user.id, user.email, true)
    return { id: user.id, email: user.email, activationRequired: true }
  }

  /**
   * 为指定用户生成并发送一次性链接，持有用户行锁限制重发；返回时 SMTP 已接受邮件。
   * registering 区分首次注册与重发的失败文案；事务提交后发信，失败不丢失待激活账号。
   */
  private async sendActivation(userId: string, email: string, registering = false) {
    const raw = secret()
    await this.identity.store.db.transaction(async (tx) => {
      const [user] = await tx.select().from(S.users).where(eq(S.users.id, userId)).for('update')
      if (!user || user.status !== 'active' || user.emailVerified)
        throw new BadRequestException('账号无需激活或已禁用')
      const [previous] = await tx
        .select()
        .from(S.emailActivations)
        .where(eq(S.emailActivations.userId, userId))
      const now = new Date()
      if (previous) {
        const retryAfter = Math.ceil((previous.sentAt.getTime() + 60000 - now.getTime()) / 1000)
        if (retryAfter > 0)
          throw new HttpException({ message: `请在 ${retryAfter} 秒后重试`, retryAfter }, 429)
      }
      const values = {
        tokenHash: hash(raw),
        expiresAt: new Date(now.getTime() + 86400000),
        sentAt: now,
      }
      await tx
        .insert(S.emailActivations)
        .values({ userId, ...values })
        .onDuplicateKeyUpdate({ set: values })
    })
    try {
      await this.mail.sendActivation(email, raw)
    } catch {
      throw new ServiceUnavailableException({
        code: registering ? 'ACCOUNT_ACTIVATION_SEND_FAILED' : 'ACTIVATION_SEND_FAILED',
        message: registering
          ? '账号已创建，激活邮件发送失败，请稍后重发'
          : '激活邮件发送失败，请稍后重发',
        retryAfter: 60,
      })
    }
  }

  /** 验证邮箱与密码后重发，仅未激活且未禁用的账号可以发送。 */
  async resendActivation(email: string, password: string) {
    const user = await this.identity.store.one(
      this.identity.store.db
        .select()
        .from(S.users)
        .where(eq(S.users.email, email.trim().toLowerCase()))
        .limit(1),
    )
    if (!user || !(await bcrypt.compare(password, user.passwordHash)))
      throw new UnauthorizedException('邮箱或密码错误')
    if (user.status !== 'active') throw new ForbiddenException('账号已禁用')
    await this.sendActivation(user.id, user.email)
    return { ok: true }
  }

  /** 原子消费未过期的激活令牌；只更新邮箱验证状态，不能解除管理员禁用。 */
  async activateEmail(token: string) {
    if (!token || token.length > 256) throw new BadRequestException('激活链接无效或已过期')
    const digest = hash(token)
    const candidate = await this.identity.store.one(
      this.identity.store.db
        .select()
        .from(S.emailActivations)
        .where(eq(S.emailActivations.tokenHash, digest))
        .limit(1),
    )
    if (!candidate) throw new BadRequestException('激活链接无效或已过期')
    await this.identity.store.db.transaction(async (tx) => {
      // 与重发统一按用户加锁，防止旧链接在重发后被并发消费。
      const [user] = await tx
        .select()
        .from(S.users)
        .where(eq(S.users.id, candidate.userId))
        .for('update')
      const [activation] = await tx
        .select()
        .from(S.emailActivations)
        .where(
          and(
            eq(S.emailActivations.userId, candidate.userId),
            eq(S.emailActivations.tokenHash, digest),
            gt(S.emailActivations.expiresAt, new Date()),
          ),
        )
      if (!user || !activation || user.emailVerified)
        throw new BadRequestException('激活链接无效或已过期')
      await tx.update(S.users).set({ emailVerified: true }).where(eq(S.users.id, user.id))
      await tx.delete(S.emailActivations).where(eq(S.emailActivations.userId, user.id))
    })
    return { ok: true }
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
