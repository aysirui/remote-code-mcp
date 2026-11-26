import { Controller, Get, Post, Req, Res, Body, Query, HttpCode } from '@nestjs/common'
import type { Request, Response } from 'express'
import { createHash } from 'node:crypto'
import { Identity } from '../core/identity'
import { hash, secret } from '../../common/security'
import { OAuthService } from './oauth.service'
import { parseOAuthRedirect } from './oauth-redirect'
import { renderOAuthConsent } from './oauth-consent-page'
import {
  origin,
  frontend,
  esc,
  canonicalResource,
  oauthConsentSignature,
  equals,
} from './oauth-utils'
import { oauthLog, oauthError, trackOAuthRefresh } from './oauth-telemetry'

/** 保留统一导出入口，供 MCP 和 NestJS Provider 引用。 */
export { OAuthService } from './oauth.service'

/**
 * OAuth 元数据、动态客户端注册、授权确认与 Token 兑换入口。
 * 授权码由数据库事务一次性消费，PKCE 校验在发放令牌前执行。
 */
@Controller()
export class OAuthController {
  constructor(
    private auth: Identity,
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
  /** 注册公共 OAuth 客户端，参数校验和持久化委托业务服务。 */
  @Post('oauth/register') async dcr(@Body() body: Record<string, unknown>, @Res() res: Response) {
    const result = await this.oauth.registerClient(body)
    res.status(201).json(result)
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
    const redirect = parseOAuthRedirect(q.redirect_uri)
    const client = await this.oauth.client(q.client_id)
    if (
      !redirect ||
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
    const callbackOrigin = redirect.cspSource
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' " +
        callbackOrigin +
        "; frame-ancestors 'none'; base-uri 'none'",
    )
    const csrf = secret()
    await this.oauth.createConsent(csrf, current.id)
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
    res.set('Cache-Control', 'no-store')
    res.set('Referrer-Policy', 'no-referrer')
    res.type('html').send(
      renderOAuthConsent({
        clientName: client.clientName || 'MCP Client',
        email: current.email,
        target: redirect.displayTarget,
        type: redirect.type,
        fields,
        csrf,
        issuedAt,
        signature,
      }),
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
    const issued = await this.oauth.confirmConsent(user.id, String(b.csrf), b)
    res.clearCookie('rcm_oauth_csrf', { path: '/oauth' })
    if (!issued)
      return oauthError(
        res,
        400,
        'invalid_grant',
        'Authorization confirmation already used or expired',
        'authorize.consent_consumed',
      )

    const dest = new URL(b.redirect_uri)
    dest.searchParams.set('code', issued.code)
    dest.searchParams.set('state', String(b.state || ''))
    oauthLog('authorize.approved', { clientId: issued.clientId, userId: user.id })
    // POST/Redirect/GET：303 明确要求浏览器以 GET 打开客户端回调，避免转发 POST 表单数据。
    res.redirect(303, dest.toString())
  }
  /** 授权码兑换与刷新成功均返回 OAuth 规定的 200；刷新使用事务行锁与一次性旋转。 */
  @Post('oauth/token')
  @HttpCode(200)
  async token(@Req() req: Request, @Res() res: Response, @Body() b: Record<string, string>) {
    res.set('Cache-Control', 'no-store')
    res.set('Pragma', 'no-cache')
    const requestId = b.grant_type === 'refresh_token' ? trackOAuthRefresh(req, res, b) : undefined
    /** OAuth 拒绝响应沿用刷新请求编号，便于关联入口、事务决策与 HTTP 结束事件。 */
    const failure = (code: string, event: string) =>
      oauthError(
        res,
        400,
        code,
        code === 'invalid_grant'
          ? 'Authorization or refresh token invalid'
          : 'Invalid OAuth token request',
        event,
        requestId,
      )
    if (b.grant_type === 'refresh_token') {
      // 公共客户端刷新不强制提供 client_id；若提供，仓储仍校验它与令牌归属一致。
      if (
        typeof b.refresh_token !== 'string' ||
        !b.refresh_token ||
        (b.client_id !== undefined && (typeof b.client_id !== 'string' || !b.client_id))
      )
        return failure('invalid_request', 'token.refresh_invalid_request')
      // 异常继续交给 NestJS 处理；日志只标记失败阶段，不输出可能含 SQL 参数的异常正文。
      const result = await this.oauth
        .rotateRefreshToken(b.client_id, b.refresh_token, requestId)
        .catch((error: unknown) => {
          // Drizzle 将驱动异常放在 cause；只允许固定错误码，绝不记录 message、SQL 或参数。
          const driverError = error instanceof Error && error.cause ? error.cause : error
          const code =
            typeof driverError === 'object' && driverError !== null && 'code' in driverError
              ? driverError.code
              : undefined
          const reason =
            typeof code === 'string' &&
            [
              'ER_LOCK_DEADLOCK',
              'ER_LOCK_WAIT_TIMEOUT',
              'ER_DUP_ENTRY',
              'ER_NO_SUCH_TABLE',
              'ER_BAD_FIELD_ERROR',
              'ER_CON_COUNT_ERROR',
              'ECONNRESET',
              'ECONNREFUSED',
              'ETIMEDOUT',
              'PROTOCOL_CONNECTION_LOST',
            ].includes(code)
              ? code
              : 'database_error'
          oauthLog('token.refresh_transaction_failed', { requestId, clientId: b.client_id, reason })
          throw error
        })
      if (!result || 'replay' in result) {
        oauthLog(result ? 'token.refresh_replay' : 'token.refresh_denied', {
          clientId: b.client_id,
          requestId,
        })
        return failure('invalid_grant', 'token.refresh_failed')
      }
      // 此事件表示数据库事务已提交；HTTP 写出结果由响应生命周期事件记录。
      oauthLog('token.refreshed', { clientId: b.client_id, requestId })
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
    const code = await this.oauth.authorizationCode(String(b.code))
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
    const redeemed = await this.oauth.redeemAuthorizationCode({
      codeId: code.id,
      clientId: b.client_id,
      redirectUri: b.redirect_uri,
      resource: b.resource,
      codeChallenge: code.codeChallenge,
      access,
      refresh,
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
