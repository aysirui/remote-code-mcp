import {
  Controller,
  Get,
  Post,
  Req,
  Res,
  Body,
  Query,
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common'
import type { Request, Response } from 'express'
import { eq, and, gt } from 'drizzle-orm'
import { Identity, Store, hash, uid, secret } from './core'
import * as S from './schema'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
const origin = () => process.env.PUBLIC_URL || 'http://localhost:3000'
const frontend = () => process.env.CONSOLE_URL || 'http://localhost:5173'
const esc = (s: string) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
const redirectOk = (u: string) => {
  try {
    const x = new URL(u)
    return x.protocol === 'https:' || x.hostname === '127.0.0.1' || x.hostname === 'localhost'
  } catch {
    return false
  }
}
const canonicalResource = () => origin().replace(/\/$/, '') + '/mcp'
const oauthConsentSignature = (fields: Record<string, unknown>, userId: string, nonce: string, issuedAt: string) => {
  const names = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'response_type', 'resource', 'scope']
  const serialized = JSON.stringify([userId, nonce, issuedAt, ...names.map(name => String(fields[name] ?? ''))])
  return createHmac('sha256', process.env.APP_SECRET!).update(serialized).digest('hex')
}
const equals = (left: string, right: string) => {
  const l = Buffer.from(left, 'utf8'), r = Buffer.from(right, 'utf8')
  return l.length === r.length && timingSafeEqual(l, r)
}

@Injectable()
export class OAuthService {
  constructor(private store: Store) {}
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
    const u = await this.store.one(
      this.store.db.select().from(S.users).where(eq(S.users.id, t.userId)).limit(1),
    )
    if (!u || u.status !== 'active') throw new UnauthorizedException()
    return u
  }
  async client(id: string) {
    return this.store.one(
      this.store.db.select().from(S.oauthClients).where(eq(S.oauthClients.clientId, id)).limit(1),
    )
  }
}
@Controller()
export class OAuthController {
  constructor(
    private auth: Identity,
    private store: Store,
    private oauth: OAuthService,
  ) {}
  @Get('.well-known/oauth-protected-resource') resource(@Res() res: Response) {
    res.json({
      resource: canonicalResource(),
      authorization_servers: [origin()],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp:tools'],
    })
  }
  @Get('.well-known/oauth-authorization-server') discovery(@Res() res: Response) {
    res.json({
      issuer: origin(),
      authorization_endpoint: origin() + '/oauth/authorize',
      token_endpoint: origin() + '/oauth/token',
      registration_endpoint: origin() + '/oauth/register',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp:tools'],
    })
  }
  @Post('oauth/register') async dcr(@Body() b: any, @Res() res: Response) {
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
    res.status(201).json({
      client_id: clientId,
      client_name: b.client_name || 'MCP Client',
      redirect_uris: uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    })
  }
  @Get('oauth/authorize') async authorize(
    @Req() req: Request,
    @Res() res: Response,
    @Query() q: any,
  ) {
    const required = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'resource']
    if (required.some((k) => typeof q[k] !== 'string' || !q[k]))
      return res.status(400).send('Missing OAuth parameters')
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
      return res.status(400).send('Invalid OAuth request')
    const current = await this.auth.userBySession(req)
    if (!current || current.status !== 'active' || current.passwordChangeRequired) {
      const next = encodeURIComponent(
        origin() + '/oauth/authorize?' + new URLSearchParams(q).toString(),
      )
      return res.redirect(frontend() + '/login?returnTo=' + next)
    }
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
      .filter(([k, v]) => typeof v === 'string')
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(String(v))}">`)
      .join('')
    res
      .type('html')
      .send(
        `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>授权 MCP 客户端</title><style>body{font:16px system-ui;background:#f6f8fb;display:grid;place-items:center;min-height:90vh}main{background:white;border:1px solid #e5e7eb;padding:32px;border-radius:14px;max-width:430px}button{background:#2563eb;color:white;border:0;padding:12px 20px;border-radius:8px;cursor:pointer}</style><main><h2>授权 AI 客户端</h2><p>${esc(client.clientName || 'MCP Client')} 请求读取你已授权工作区的文件和工具能力。</p><p>登录账号：${esc(current.email)}</p><p>授权回调：<strong>${esc(new URL(q.redirect_uri).origin)}</strong></p><p>访问权限：mcp:tools。实际文件权限仍由本地 Runtime 控制。</p><form method="POST" action="/oauth/authorize">${fields}<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="issued_at" value="${issuedAt}"><input type="hidden" name="consent_sig" value="${signature}"><button type="submit">同意并继续</button></form><p><small>不信任此客户端？关闭此页面即可拒绝。</small></p></main></html>`,
      )
  }
  @Post('oauth/authorize') async accept(@Req() req: Request, @Res() res: Response, @Body() b: any) {
    const user = await this.auth.requireUser(req)
    if (!req.cookies?.rcm_oauth_csrf || !equals(hash(String(b.csrf || '')), req.cookies.rcm_oauth_csrf))
      return res.status(403).send('Invalid CSRF')
    const issuedAt = String(b.issued_at || '')
    if (!/^\d{13}$/.test(issuedAt) || Date.now() - Number(issuedAt) > 300000 ||
        Number(issuedAt) > Date.now() + 30000 ||
        !equals(String(b.consent_sig || ''), oauthConsentSignature(b, user.id, String(b.csrf), issuedAt)))
      return res.status(403).send('Invalid OAuth consent')
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
    res.redirect(dest.toString())
  }
  @Post('oauth/token') async token(@Req() req: Request, @Res() res: Response, @Body() b: any) {
    if (b.grant_type !== 'authorization_code' || !b.code || !b.code_verifier || !b.client_id)
      return res.status(400).json({ error: 'invalid_request' })
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
      return res.status(400).json({ error: 'invalid_grant' })
    const verifier = String(b.code_verifier)
    if (
      verifier.length < 43 ||
      verifier.length > 128 ||
      !/^[A-Za-z0-9._~-]+$/.test(verifier) ||
      createHash('sha256').update(verifier).digest('base64url') !== code.codeChallenge
    )
      return res.status(400).json({ error: 'invalid_grant' })
    const client = await this.oauth.client(code.clientId)
    if (!client) return res.status(400).json({ error: 'invalid_client' })
    const access = secret()
    // A row lock ensures the same authorization code cannot be redeemed concurrently.
    const redeemed = await this.store.db.transaction(async (tx) => {
      const rows = await tx.select().from(S.oauthCodes)
        .where(eq(S.oauthCodes.id, code.id)).limit(1).for('update')
      const locked = rows[0]
      if (!locked || locked.expiresAt <= new Date()) return false
      if (locked.clientId !== b.client_id || locked.redirectUri !== b.redirect_uri ||
          locked.resource !== b.resource || locked.codeChallenge !== code.codeChallenge) return false
      await tx.delete(S.oauthCodes).where(eq(S.oauthCodes.id, locked.id))
      await tx.insert(S.oauthTokens).values({
        id: uid(),
        tokenHash: hash(access),
        clientId: locked.clientId,
        userId: locked.userId,
        scope: locked.scope,
        resource: locked.resource,
        expiresAt: new Date(Date.now() + 3600 * 1000),
      })
      return true
    })
    if (!redeemed) return res.status(400).json({ error: 'invalid_grant' })
    res.set('Cache-Control', 'no-store')
    res.json({ access_token: access, token_type: 'Bearer', expires_in: 3600, scope: code.scope })
  }
}
