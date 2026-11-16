import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common'
import { hash, uid, secret } from '../../common/security'
import { redirectOk } from './oauth-utils'
import { oauthLog } from './oauth-telemetry'
import { canonicalResource } from './oauth-utils'
import { OAuthRepository } from './oauth.repository'

/** OAuth 凭据校验服务：校验 Token 摘要、到期时间、受众和 Scope。 */
@Injectable()
export class OAuthService {
  constructor(private readonly repository: OAuthRepository) {}

  /** 验证 MCP Token 并返回用户与当前授权客户端 ID。 */
  async token(raw: string) {
    const t = await this.repository.accessToken(hash(raw))
    if (
      !t ||
      t.revokedAt ||
      t.resource !== canonicalResource() ||
      !t.scope.split(' ').includes('mcp:tools')
    )
      throw new UnauthorizedException('Invalid MCP token')
    // 新版 Token 必须关联仍有效的持久授权；grantId 为空仅兼容历史迁移前签发的 Token。
    if (t.grantId) {
      const grant = await this.repository.activeGrant(t.grantId)
      if (!grant || grant.userId !== t.userId || grant.clientId !== t.clientId)
        throw new UnauthorizedException('OAuth authorization revoked')
    }
    const u = await this.repository.user(t.userId)
    if (!u || u.status !== 'active') throw new UnauthorizedException()
    return { ...u, clientId: t.clientId }
  }

  /** 查询动态注册的客户端元数据，供授权流程校验回调 URI。 */
  async client(id: string) {
    return this.repository.client(id)
  }
  /** 动态客户端注册：限制回调数量、URI 和认证模式。 */
  async registerClient(body: Record<string, unknown>) {
    const uris = body.redirect_uris
    if (
      !Array.isArray(uris) ||
      !uris.length ||
      uris.length > 8 ||
      !uris.every((uri: unknown) => typeof uri === 'string' && redirectOk(uri))
    )
      throw new BadRequestException('Invalid redirect URIs')
    if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== 'none')
      throw new BadRequestException('Public PKCE clients only')
    const clientId = uid()
    const clientName = String(body.client_name || 'MCP Client')
    await this.repository.registerClient({
      clientId,
      redirectUris: uris as string[],
      clientName: clientName.slice(0, 255),
    })
    oauthLog('client.registered', { clientId, clientName: clientName.slice(0, 100) })
    return {
      client_id: clientId,
      client_name: body.client_name || 'MCP Client',
      redirect_uris: uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }
  }
  /** 验证刷新请求参数后执行原子旋转，结果由 HTTP 层映射为 OAuth 错误。 */
  async rotateRefreshToken(clientId: string, refreshToken: string) {
    return this.repository.rotateRefreshToken(hash(refreshToken), clientId)
  }
  /** 查询授权码，兑换前由调用方验证 PKCE 和客户端参数。 */
  async authorizationCode(rawCode: string) {
    return this.repository.authorizationCode(hash(rawCode))
  }

  /** 原子消费授权码，避免并发重复签发凭据。 */
  async redeemAuthorizationCode(params: {
    codeId: string
    clientId: string
    redirectUri: string
    resource: string
    codeChallenge: string
    access: string
    refresh: string
  }) {
    return this.repository.redeemAuthorizationCode(params)
  }
  /** 创建浏览器授权确认状态，数据库只保存 CSRF 摘要。 */
  async createConsent(csrf: string, userId: string) {
    await this.repository.createConsent(hash(csrf), userId, new Date(Date.now() + 300000))
  }

  /** 原子消费授权确认并签发授权码；相同确认只能成功一次。 */
  async confirmConsent(userId: string, csrf: string, body: Record<string, string>) {
    const client = await this.client(String(body.client_id || ''))
    if (
      !client ||
      !JSON.parse(client.redirectUris).includes(body.redirect_uri) ||
      body.code_challenge_method !== 'S256' ||
      !/^[A-Za-z0-9_-]{43}$/.test(String(body.code_challenge || '')) ||
      body.response_type !== 'code' ||
      body.resource !== canonicalResource()
    )
      return null
    const code = secret()
    const consumed = await this.repository.consumeConsentAndCreateCode({
      csrfHash: hash(csrf),
      userId,
      codeHash: hash(code),
      clientId: client.clientId,
      redirectUri: body.redirect_uri,
      codeChallenge: body.code_challenge,
      scope: 'mcp:tools',
      resource: canonicalResource(),
      expiresAt: new Date(Date.now() + 300000),
    })
    return consumed ? { code, clientId: client.clientId } : null
  }
}
