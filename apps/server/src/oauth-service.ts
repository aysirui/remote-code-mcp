import { Injectable, UnauthorizedException } from '@nestjs/common'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { Store } from './store'
import { hash } from './security'
import * as S from './schema'
import { canonicalResource } from './oauth-utils'

/** OAuth 凭据校验服务：校验 Token 摘要、到期时间、受众和 Scope。 */
@Injectable()
export class OAuthService {
  constructor(private store: Store) {}

  /** 验证 MCP Token 并返回用户与当前授权客户端 ID。 */
  async token(raw: string) {
    const t = await this.store.one(
      this.store.db
        .select()
        .from(S.oauthTokens)
        .where(and(eq(S.oauthTokens.tokenHash, hash(raw)), gt(S.oauthTokens.expiresAt, new Date())))
        .limit(1),
    )
    if (
      !t ||
      t.revokedAt ||
      t.resource !== canonicalResource() ||
      !t.scope.split(' ').includes('mcp:tools')
    )
      throw new UnauthorizedException('Invalid MCP token')
    // 新版 Token 必须关联仍有效的持久授权；grantId 为空仅兼容历史迁移前签发的 Token。
    if (t.grantId) {
      const grant = await this.store.one(
        this.store.db
          .select()
          .from(S.oauthGrants)
          .where(and(eq(S.oauthGrants.id, t.grantId), isNull(S.oauthGrants.revokedAt)))
          .limit(1),
      )
      if (!grant || grant.userId !== t.userId || grant.clientId !== t.clientId)
        throw new UnauthorizedException('OAuth authorization revoked')
    }
    const u = await this.store.one(
      this.store.db.select().from(S.users).where(eq(S.users.id, t.userId)).limit(1),
    )
    if (!u || u.status !== 'active') throw new UnauthorizedException()
    return { ...u, clientId: t.clientId }
  }

  /** 查询动态注册的客户端元数据，供授权流程校验回调 URI。 */
  async client(id: string) {
    return this.store.one(
      this.store.db.select().from(S.oauthClients).where(eq(S.oauthClients.clientId, id)).limit(1),
    )
  }
}
