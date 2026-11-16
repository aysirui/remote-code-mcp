import { Injectable } from '@nestjs/common'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { Store } from '../../infrastructure/database/store'
import * as S from '../../infrastructure/database/schema'
import { uid, hash, secret } from '../../common/security'
import { canonicalResource } from './oauth-utils'

/** OAuth 持久化仓储：封装凭据查询、事务行锁和原子状态变更。 */
@Injectable()
export class OAuthRepository {
  constructor(private readonly store: Store) {}

  /** 根据 Token 摘要和有效期读取 Access Token。 */
  async accessToken(tokenHash: string) {
    return this.store.one(
      this.store.db
        .select()
        .from(S.oauthTokens)
        .where(and(eq(S.oauthTokens.tokenHash, tokenHash), gt(S.oauthTokens.expiresAt, new Date())))
        .limit(1),
    )
  }

  /** 仅返回尚未撤销的持久授权。 */
  async activeGrant(grantId: string) {
    return this.store.one(
      this.store.db
        .select()
        .from(S.oauthGrants)
        .where(and(eq(S.oauthGrants.id, grantId), isNull(S.oauthGrants.revokedAt)))
        .limit(1),
    )
  }

  /** 校验 Token 归属用户当前状态。 */
  async user(userId: string) {
    return this.store.one(
      this.store.db.select().from(S.users).where(eq(S.users.id, userId)).limit(1),
    )
  }

  /** 根据公开 client_id 查找动态注册客户端。 */
  async client(clientId: string) {
    return this.store.one(
      this.store.db
        .select()
        .from(S.oauthClients)
        .where(eq(S.oauthClients.clientId, clientId))
        .limit(1),
    )
  }
  /** 注册公共客户端，仅持久化经过业务层验证的回调 URI。 */
  async registerClient(data: { clientId: string; redirectUris: string[]; clientName: string }) {
    await this.store.db.insert(S.oauthClients).values({
      id: uid(),
      clientId: data.clientId,
      redirectUris: JSON.stringify(data.redirectUris),
      clientName: data.clientName,
    })
  }
  /** 刷新令牌事务：行锁串行化旋转；已消费令牌重放时撤销整个令牌族。 */
  async rotateRefreshToken(tokenHash: string, clientId: string) {
    return this.store.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(S.oauthRefreshTokens)
        .where(eq(S.oauthRefreshTokens.tokenHash, tokenHash))
        .limit(1)
        .for('update')
      const old = rows[0]
      if (!old || old.clientId !== clientId) return null
      const grantRows = await tx
        .select()
        .from(S.oauthGrants)
        .where(eq(S.oauthGrants.id, old.grantId))
        .limit(1)
        .for('update')
      const grant = grantRows[0]
      const accountRows = grant
        ? await tx.select().from(S.users).where(eq(S.users.id, grant.userId)).limit(1)
        : []
      if (!accountRows[0] || accountRows[0].status !== 'active') return null
      if (
        !grant ||
        grant.revokedAt ||
        grant.clientId !== clientId ||
        grant.resource !== canonicalResource() ||
        old.expiresAt <= new Date() ||
        old.revokedAt
      )
        return null
      // A consumed token is a replay: revoke the whole family and its active access tokens.
      if (old.consumedAt) {
        await tx
          .update(S.oauthRefreshTokens)
          .set({ revokedAt: new Date() })
          .where(eq(S.oauthRefreshTokens.familyId, old.familyId))
        await tx
          .update(S.oauthTokens)
          .set({ revokedAt: new Date() })
          .where(and(eq(S.oauthTokens.grantId, grant.id), isNull(S.oauthTokens.revokedAt)))
        return { replay: true as const }
      }
      const now = new Date()
      const nextRefresh = secret()
      const access = secret()
      await tx
        .update(S.oauthRefreshTokens)
        .set({ consumedAt: now })
        .where(eq(S.oauthRefreshTokens.id, old.id))
      await tx.insert(S.oauthRefreshTokens).values({
        id: uid(),
        tokenHash: hash(nextRefresh),
        familyId: old.familyId,
        grantId: grant.id,
        clientId: grant.clientId,
        expiresAt: old.expiresAt,
      })
      await tx.insert(S.oauthTokens).values({
        id: uid(),
        tokenHash: hash(access),
        clientId: grant.clientId,
        userId: grant.userId,
        grantId: grant.id,
        scope: grant.scope,
        resource: grant.resource,
        expiresAt: new Date(Date.now() + 3600_000),
      })
      await tx.update(S.oauthGrants).set({ lastUsedAt: now }).where(eq(S.oauthGrants.id, grant.id))
      return { access, refresh: nextRefresh, scope: grant.scope }
    })
  }
  /** 按授权码摘要查询未消费的授权码，供 PKCE 预校验。 */
  async authorizationCode(codeHash: string) {
    return this.store.one(
      this.store.db.select().from(S.oauthCodes).where(eq(S.oauthCodes.codeHash, codeHash)).limit(1),
    )
  }

  /** 锁定并一次性消费授权码，授权关系与 Token 签发在同一事务内提交。 */
  async redeemAuthorizationCode(params: {
    codeId: string
    clientId: string
    redirectUri: string
    resource: string
    codeChallenge: string
    access: string
    refresh: string
  }) {
    return this.store.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(S.oauthCodes)
        .where(eq(S.oauthCodes.id, params.codeId))
        .limit(1)
        .for('update')
      const locked = rows[0]
      if (
        !locked ||
        locked.expiresAt <= new Date() ||
        locked.clientId !== params.clientId ||
        locked.redirectUri !== params.redirectUri ||
        locked.resource !== params.resource ||
        locked.codeChallenge !== params.codeChallenge
      )
        return false
      await tx.delete(S.oauthCodes).where(eq(S.oauthCodes.id, locked.id))
      // Re-consent activates an existing grant, preserving client identity.
      const existing = await tx
        .select()
        .from(S.oauthGrants)
        .where(
          and(eq(S.oauthGrants.userId, locked.userId), eq(S.oauthGrants.clientId, locked.clientId)),
        )
        .limit(1)
        .for('update')
      const grantId = existing[0]?.id || uid()
      if (existing[0]) {
        await tx
          .update(S.oauthGrants)
          .set({
            scope: locked.scope,
            resource: locked.resource,
            revokedAt: null,
            lastUsedAt: new Date(),
          })
          .where(eq(S.oauthGrants.id, grantId))
      } else {
        await tx.insert(S.oauthGrants).values({
          id: grantId,
          userId: locked.userId,
          clientId: locked.clientId,
          scope: locked.scope,
          resource: locked.resource,
          lastUsedAt: new Date(),
        })
        // 首次授权审计与授权关系、令牌放在同一事务中，避免授权成功却缺少审计记录。
        await tx.insert(S.securityAudits).values({
          id: uid(),
          actorType: 'user',
          actorId: locked.userId,
          eventType: 'oauth.grant.created',
          resourceType: 'oauth_client',
          resourceId: locked.clientId,
          result: 'success',
        })
      }
      await tx.insert(S.oauthTokens).values({
        id: uid(),
        tokenHash: hash(params.access),
        clientId: locked.clientId,
        userId: locked.userId,
        grantId,
        scope: locked.scope,
        resource: locked.resource,
        expiresAt: new Date(Date.now() + 3600_000),
      })
      await tx.insert(S.oauthRefreshTokens).values({
        id: uid(),
        tokenHash: hash(params.refresh),
        familyId: uid(),
        grantId,
        clientId: locked.clientId,
        expiresAt: new Date(Date.now() + 30 * 86400_000),
      })
      return true
    })
  }
  /** 保存一次性浏览器授权确认状态，仅持久化 CSRF 摘要。 */
  async createConsent(csrfHash: string, userId: string, expiresAt: Date) {
    await this.store.db.insert(S.oauthConsents).values({
      id: uid(),
      csrfHash,
      userId,
      expiresAt,
    })
  }

  /** 在同一事务中消费确认状态并创建授权码，防止并发重复同意。 */
  async consumeConsentAndCreateCode(data: {
    csrfHash: string
    userId: string
    codeHash: string
    clientId: string
    redirectUri: string
    codeChallenge: string
    scope: string
    resource: string
    expiresAt: Date
  }) {
    return this.store.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(S.oauthConsents)
        .where(eq(S.oauthConsents.csrfHash, data.csrfHash))
        .limit(1)
        .for('update')
      const consent = rows[0]
      if (
        !consent ||
        consent.userId !== data.userId ||
        consent.consumedAt ||
        consent.expiresAt <= new Date()
      )
        return false
      const clients = await tx
        .select()
        .from(S.oauthClients)
        .where(eq(S.oauthClients.clientId, data.clientId))
        .limit(1)
      const client = clients[0]
      if (!client || !JSON.parse(client.redirectUris).includes(data.redirectUri)) return false
      await tx
        .update(S.oauthConsents)
        .set({ consumedAt: new Date() })
        .where(eq(S.oauthConsents.id, consent.id))
      await tx.insert(S.oauthCodes).values({
        id: uid(),
        codeHash: data.codeHash,
        clientId: data.clientId,
        userId: data.userId,
        redirectUri: data.redirectUri,
        codeChallenge: data.codeChallenge,
        scope: data.scope,
        resource: data.resource,
        expiresAt: data.expiresAt,
      })
      return true
    })
  }
}
