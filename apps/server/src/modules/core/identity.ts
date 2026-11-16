import { env } from '../../config/env'
import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common'
import { and, eq, gt } from 'drizzle-orm'
import * as bcrypt from 'bcryptjs'
import type { Request } from 'express'
import * as S from '../../infrastructure/database/schema'
import { Store } from '../../infrastructure/database/store'
import { uid, secret, hash } from '../../common/security'

const within = (seconds: number) => new Date(Date.now() + seconds * 1000)

/**
 * 用户身份与会话服务。
 * 保护边界：密码只存 bcrypt Hash；强制改密账号不得访问普通 API；
 * Session 原文不落库，改密时撤销该用户所有 Session。
 */
@Injectable()
export class Identity {
  constructor(public store: Store) {}
  /** 用 Cookie 中的随机会话令牌摘要查询有效 Session 和用户。 */
  async userBySession(req: Request) {
    const sid = req.cookies?.rcm_session
    if (!sid) return null
    const s = await this.store.one(
      this.store.db
        .select()
        .from(S.sessions)
        .where(and(eq(S.sessions.id, hash(sid)), gt(S.sessions.expiresAt, new Date())))
        .limit(1),
    )
    if (!s) return null
    return this.store.one(
      this.store.db.select().from(S.users).where(eq(S.users.id, s.userId)).limit(1),
    )
  }
  /** 验证当前账户有效且已完成首次密码修改。 */
  async requireUser(req: Request) {
    const u = await this.userBySession(req)
    if (!u || u.status !== 'active') throw new UnauthorizedException('Login required')
    if (u.passwordChangeRequired) throw new ForbiddenException('PASSWORD_CHANGE_REQUIRED')
    return u
  }
  /** 在登录态验证通过后检查管理员角色。 */
  async requireAdmin(req: Request) {
    const u = await this.requireUser(req)
    if (!['admin', 'super_admin'].includes(u.role)) throw new ForbiddenException()
    return u
  }
  /** 普通用户注册；保留 ADMIN_EMAIL，不允许公开注册提权。 */
  async register(email: string, password: string) {
    email = email.trim().toLowerCase()
    if (
      !/^\S+@\S+\.\S+$/.test(email) ||
      Buffer.byteLength(password, 'utf8') < 12 ||
      Buffer.byteLength(password, 'utf8') > 72
    )
      throw new BadRequestException('Valid email and password (12–72 UTF-8 bytes) required')
    // ADMIN_EMAIL is reserved for the out-of-band administrator initializer.
    if (email === env.adminEmail) throw new ForbiddenException('Reserved administrator address')
    const user = {
      id: uid(),
      email,
      passwordHash: await bcrypt.hash(password, 12),
      role: 'user',
      status: 'active',
    }
    try {
      await this.store.db.insert(S.users).values(user)
    } catch {
      throw new BadRequestException('Account already exists')
    }
    return user
  }
  /** 使用 bcrypt 校验密码并创建服务器 Session；客户端只收到随机 Cookie。 */
  async login(email: string, password: string) {
    const user = await this.store.one(
      this.store.db
        .select()
        .from(S.users)
        .where(eq(S.users.email, email.trim().toLowerCase()))
        .limit(1),
    )
    if (!user || user.status !== 'active' || !(await bcrypt.compare(password, user.passwordHash)))
      throw new UnauthorizedException('Invalid credentials')
    const raw = secret()
    await this.store.db
      .insert(S.sessions)
      .values({ id: hash(raw), userId: user.id, expiresAt: within(60 * 60 * 24 * 7) })
    return { user, raw }
  }
  /** 校验旧密码并更新 Hash；撤销该用户全部 Session。 */
  async changePassword(req: Request, currentPassword: string, nextPassword: string) {
    const user = await this.userBySession(req)
    if (!user || user.status !== 'active') throw new UnauthorizedException('Login required')
    if (!(await bcrypt.compare(currentPassword, user.passwordHash)))
      throw new UnauthorizedException('Invalid current password')
    const bytes = Buffer.byteLength(nextPassword, 'utf8')
    if (bytes < 12 || bytes > 72 || currentPassword === nextPassword)
      throw new BadRequestException('New password must differ and contain 12–72 UTF-8 bytes')
    const passwordHash = await bcrypt.hash(nextPassword, 12)
    await this.store.db
      .update(S.users)
      .set({ passwordHash, passwordChangeRequired: false })
      .where(eq(S.users.id, user.id))
    await this.store.db.delete(S.sessions).where(eq(S.sessions.userId, user.id))
    // Force reauthentication after credential rotation.
    return { ok: true }
  }

  /** 删除当前会话记录，避免旧 Cookie 继续有效。 */
  async logOut(req: Request) {
    const sid = req.cookies?.rcm_session
    if (sid) await this.store.db.delete(S.sessions).where(eq(S.sessions.id, hash(sid)))
  }
}
