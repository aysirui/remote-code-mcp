import { Controller, Get, Post, Req, Res, Body, Query, BadRequestException } from '@nestjs/common'
import type { Request, Response } from 'express'
import { and, eq, isNull } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { Identity } from './identity'
import { Store } from './store'
import { hash, uid, secret } from './security'
import { OAuthService } from './oauth-service'
import {
  origin,
  frontend,
  esc,
  redirectOk,
  canonicalResource,
  oauthConsentSignature,
  equals,
} from './oauth-utils'
import * as S from './schema'
import { oauthLog, oauthError } from './oauth-telemetry'

/** 保留统一导出入口，供 MCP 和 NestJS Provider 引用。 */
export { OAuthService } from './oauth-service'

/**
 * OAuth 元数据、动态客户端注册、授权确认与 Token 兑换入口。
 * 授权码由数据库事务一次性消费，PKCE 校验在发放令牌前执行。
 */
@Controller()
export class OAuthController {
  constructor(
    private auth: Identity,
    private store: Store,
    private oauth: OAuthService,
  ) {}
  /** 发布 MCP Protected Resource 元数据。 */
  @Get('.well-known/oauth-protected-resource') resource(@Res() res: Response) {
    res.json({
      resource: canonicalResource(),
      authorization_servers: [origin()],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp:tools'],
    })
  }
  /** 发布 OAuth 授权服务器发现元数据。 */
  @Get('.well-known/oauth-authorization-server') discovery(@Res() res: Response) {
    res.json({
      issuer: origin(),
      authorization_endpoint: origin() + '/oauth/authorize',
      token_endpoint: origin() + '/oauth/token',
      registration_endpoint: origin() + '/oauth/register',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp:tools'],
    })
  }
  /** 注册公共 OAuth 客户端并验证允许的回调 URI。 */
  @Post('oauth/register') async dcr(@Body() b: Record<string, unknown>, @Res() res: Response) {
    const uris = b.redirect_uris
    if (
      !Array.isArray(uris) ||
      !uris.length ||
      uris.length > 8 ||
      !uris.every((x: unknown) => typeof x === 'string' && redirectOk(x))
    )
      throw new BadRequestException('Invalid redirect URIs')
    if (b.token_endpoint_auth_method && b.token_endpoint_auth_method !== 'none')
      throw new BadRequestException('Public PKCE clients only')
    const clientId = uid()
    await this.store.db.insert(S.oauthClients).values({
      id: uid(),
      clientId,
      redirectUris: JSON.stringify(uris),
      clientName: String(b.client_name || 'MCP Client').slice(0, 255),
    })
    oauthLog('client.registered', {
      clientId,
      clientName: String(b.client_name || 'MCP Client').slice(0, 100),
    })
    res.status(201).json({
      client_id: clientId,
      client_name: b.client_name || 'MCP Client',
      redirect_uris: uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    })
  }
  /** 校验 PKCE 和客户端参数，展示用户确认的授权详情。 */
  @Get('oauth/authorize') async authorize(
    @Req() req: Request,
    @Res() res: Response,
    @Query() q: Record<string, string>,
  ) {
    const required = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'resource']
    if (required.some((k) => typeof q[k] !== 'string' || !q[k]))
      return oauthError(
        res,
        400,
        'invalid_request',
        'Missing OAuth parameters',
        'authorize.missing_parameters',
      )
    const client = await this.oauth.client(q.client_id)
    if (
      !client ||
      !JSON.parse(client.redirectUris).includes(q.redirect_uri) ||
      q.code_challenge_method !== 'S256' ||
      !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge) ||
      q.response_type !== 'code' ||
      q.resource !== canonicalResource() ||
      !(q.scope || 'mcp:tools').split(' ').includes('mcp:tools')
    )
      return oauthError(
        res,
        400,
        'invalid_request',
        'Invalid OAuth request',
        'authorize.invalid_request',
      )
    oauthLog('authorize.view', { clientId: q.client_id })
    const current = await this.auth.userBySession(req)
    if (!current || current.status !== 'active' || current.passwordChangeRequired) {
      const next = encodeURIComponent(
        origin() + '/oauth/authorize?' + new URLSearchParams(q).toString(),
      )
      return res.redirect(frontend() + '/login?returnTo=' + next)
    }
    // 仅允许提交到本站以及已经通过 client_id + redirect_uris 精确匹配的回调源。
    // Chromium 会对表单 POST 后的重定向链校验 form-action；只设 'self' 会拦截 OAuth 回跳。
    const callbackOrigin = new URL(q.redirect_uri).origin
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' " +
        callbackOrigin +
        "; frame-ancestors 'none'; base-uri 'none'",
    )
    const csrf = secret()
    res.cookie('rcm_oauth_csrf', hash(csrf), {
      httpOnly: true,
      secure: origin().startsWith('https:'),
      sameSite: 'lax',
      path: '/oauth',
      maxAge: 300000,
    })
    const issuedAt = String(Date.now())
    const signature = oauthConsentSignature(q, current.id, csrf, issuedAt)
    const fields = Object.entries(q)
      .filter(([, value]) => typeof value === 'string')
      .map(
        ([name, value]) =>
          `<input type="hidden" name="${esc(name)}" value="${esc(String(value))}">`,
      )
      .join('')
    res
      .type('html')
      .send(
        `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>授权 MCP 客户端</title><style>body{font:16px system-ui;background:#f6f8fb;display:grid;place-items:center;min-height:90vh}main{background:white;border:1px solid #e5e7eb;padding:32px;border-radius:14px;max-width:430px}button{background:#2563eb;color:white;border:0;padding:12px 20px;border-radius:8px;cursor:pointer}</style><main><h2>授权 AI 客户端</h2><p>${esc(client.clientName || 'MCP Client')} 请求读取你已授权工作区的文件和工具能力。</p><p>登录账号：${esc(current.email)}</p><p>授权回调：<strong>${esc(new URL(q.redirect_uri).origin)}</strong></p><p>访问权限：mcp:tools。实际文件权限仍由本地 Runtime 控制。</p><form method="POST" action="/oauth/authorize">${fields}<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="issued_at" value="${issuedAt}"><input type="hidden" name="consent_sig" value="${signature}"><button type="submit">同意并继续</button></form><p><small>不信任此客户端？关闭此页面即可拒绝。</small></p></main></html>`,
      )
  }
  /** 校验一次性授权确认的 CSRF/HMAC 绑定，生成授权码。 */
  @Post('oauth/authorize') async accept(
    @Req() req: Request,
    @Res() res: Response,
    @Body() b: Record<string, string>,
  ) {
    const user = await this.auth.requireUser(req)
    if (
      !req.cookies?.rcm_oauth_csrf ||
      !equals(hash(String(b.csrf || '')), req.cookies.rcm_oauth_csrf)
    )
      return oauthError(
        res,
        403,
        'invalid_csrf',
        'Authorization confirmation expired or missing',
        'authorize.csrf_rejected',
      )
    const issuedAt = String(b.issued_at || '')
    if (
      !/^\d{13}$/.test(issuedAt) ||
      Date.now() - Number(issuedAt) > 300000 ||
      Number(issuedAt) > Date.now() + 30000 ||
      !equals(
        String(b.consent_sig || ''),
        oauthConsentSignature(b, user.id, String(b.csrf), issuedAt),
      )
    )
      return oauthError(
        res,
        403,
        'invalid_consent',
        'Authorization confirmation invalid or expired',
        'authorize.consent_rejected',
      )
    // Invalidate the one-time browser consent before issuing an authorization code.
    res.clearCookie('rcm_oauth_csrf', { path: '/oauth' })
    const client = await this.oauth.client(String(b.client_id || ''))
    if (
      !client ||
      !JSON.parse(client.redirectUris).includes(b.redirect_uri) ||
      b.code_challenge_method !== 'S256' ||
      !/^[A-Za-z0-9_-]{43}$/.test(String(b.code_challenge || '')) ||
      b.response_type !== 'code' ||
      b.resource !== canonicalResource()
    )
      return res.status(400).send('Invalid OAuth request')
    const raw = secret()
    await this.store.db.insert(S.oauthCodes).values({
      id: uid(),
      codeHash: hash(raw),
      clientId: client.clientId,
      userId: user.id,
      redirectUri: b.redirect_uri,
      codeChallenge: b.code_challenge,
      scope: 'mcp:tools',
      resource: canonicalResource(),
      expiresAt: new Date(Date.now() + 300000),
    })

    const dest = new URL(b.redirect_uri)
    dest.searchParams.set('code', raw)
    dest.searchParams.set('state', String(b.state || ''))
    oauthLog('authorize.approved', { clientId: client.clientId, userId: user.id })
    // POST/Redirect/GET：303 明确要求浏览器以 GET 打开客户端回调，避免转发 POST 表单数据。
    res.redirect(303, dest.toString())
  }
  /** 单次授权可签发 access/refresh；refresh 使用事务行锁与一次性旋转。 */
  @Post('oauth/token') async token(
    @Req() req: Request,
    @Res() res: Response,
    @Body() b: Record<string, string>,
  ) {
    res.set('Cache-Control', 'no-store')
    res.set('Pragma', 'no-cache')
    const failure = (code: string, event: string) =>
      oauthError(
        res,
        400,
        code,
        code === 'invalid_grant'
          ? 'Authorization or refresh token invalid'
          : 'Invalid OAuth token request',
        event,
      )
    if (b.grant_type === 'refresh_token') {
      if (!b.refresh_token || !b.client_id)
        return failure('invalid_request', 'token.refresh_invalid_request')
      const tokenHash = hash(String(b.refresh_token))
      const result = await this.store.db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(S.oauthRefreshTokens)
          .where(eq(S.oauthRefreshTokens.tokenHash, tokenHash))
          .limit(1)
          .for('update')
        const old = rows[0]
        if (!old || old.clientId !== b.client_id) return null
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
          grant.clientId !== b.client_id ||
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
        await tx
          .update(S.oauthGrants)
          .set({ lastUsedAt: now })
          .where(eq(S.oauthGrants.id, grant.id))
        return { access, refresh: nextRefresh, scope: grant.scope }
      })
      if (!result || 'replay' in result) {
        oauthLog(result ? 'token.refresh_replay' : 'token.refresh_denied', {
          clientId: b.client_id,
        })
        return failure('invalid_grant', 'token.refresh_failed')
      }
      oauthLog('token.refreshed', { clientId: b.client_id })
      return res.json({
        access_token: result.access,
        refresh_token: result.refresh,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: result.scope,
      })
    }
    if (b.grant_type !== 'authorization_code' || !b.code || !b.code_verifier || !b.client_id)
      return failure(
        b.grant_type === 'authorization_code' ? 'invalid_request' : 'unsupported_grant_type',
        'token.code_invalid_request',
      )
    const code = await this.store.one(
      this.store.db
        .select()
        .from(S.oauthCodes)
        .where(eq(S.oauthCodes.codeHash, hash(String(b.code))))
        .limit(1),
    )
    if (
      !code ||
      code.expiresAt < new Date() ||
      code.clientId !== b.client_id ||
      code.redirectUri !== b.redirect_uri ||
      b.resource !== code.resource
    )
      return failure('invalid_grant', 'token.code_invalid')
    const verifier = String(b.code_verifier)
    if (
      verifier.length < 43 ||
      verifier.length > 128 ||
      !/^[A-Za-z0-9._~-]+$/.test(verifier) ||
      createHash('sha256').update(verifier).digest('base64url') !== code.codeChallenge
    )
      return failure('invalid_grant', 'token.pkce_invalid')
    const client = await this.oauth.client(code.clientId)
    if (!client) return failure('invalid_client', 'token.client_invalid')
    const access = secret()
    const refresh = secret()
    const redeemed = await this.store.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(S.oauthCodes)
        .where(eq(S.oauthCodes.id, code.id))
        .limit(1)
        .for('update')
      const locked = rows[0]
      if (
        !locked ||
        locked.expiresAt <= new Date() ||
        locked.clientId !== b.client_id ||
        locked.redirectUri !== b.redirect_uri ||
        locked.resource !== b.resource ||
        locked.codeChallenge !== code.codeChallenge
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
        // 将首次授权审计与授权关系、令牌放在同一事务中，避免授权成功却缺少审计记录。
        await tx.insert(S.securityAudits).values({
          id: uid(),
          actorType: 'user',
          actorId: locked.userId,
          eventType: existing[0] ? 'oauth.grant.reauthorized' : 'oauth.grant.created',
          resourceType: 'oauth_client',
          resourceId: locked.clientId,
          result: 'success',
        })
      }
      await tx.insert(S.oauthTokens).values({
        id: uid(),
        tokenHash: hash(access),
        clientId: locked.clientId,
        userId: locked.userId,
        grantId,
        scope: locked.scope,
        resource: locked.resource,
        expiresAt: new Date(Date.now() + 3600_000),
      })
      await tx.insert(S.oauthRefreshTokens).values({
        id: uid(),
        tokenHash: hash(refresh),
        familyId: uid(),
        grantId,
        clientId: locked.clientId,
        expiresAt: new Date(Date.now() + 30 * 86400_000),
      })
      return true
    })
    if (!redeemed) return failure('invalid_grant', 'token.code_replayed')
    // 重新确认已有授权不会重复记为首次授权；普通 Access Token 签发和 Refresh 不记安全审计。
    oauthLog('token.issued', { clientId: code.clientId, userId: code.userId })
    return res.json({
      access_token: access,
      refresh_token: refresh,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: code.scope,
    })
  }
}
