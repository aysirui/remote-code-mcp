import { OAuthController } from '../src/modules/oauth/oauth.controller'
import { getTableConfig } from 'drizzle-orm/mysql-core'
import * as S from '../src/infrastructure/database/schema'
import { oauthError, trackOAuthRefresh } from '../src/modules/oauth/oauth-telemetry'
import { OAuthService } from '../src/modules/oauth/oauth.service'
import { hash } from '../src/common/security'
import { EventEmitter } from 'node:events'
import { Module, type INestApplication } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { Identity } from '../src/modules/core/identity'
import { canonicalResource } from '../src/modules/oauth/oauth-utils'
import { createHash } from 'node:crypto'

describe('OAuth Token 端点真实 HTTP 状态码', () => {
  const verifier = 'v'.repeat(43)
  const oauth = {
    rotateRefreshToken: jest
      .fn()
      .mockResolvedValue({ access: 'new-access', refresh: 'new-refresh', scope: 'mcp:tools' }),
    authorizationCode: jest.fn(async () => ({
      id: 'code-1',
      clientId: 'client-1',
      userId: 'user-1',
      redirectUri: 'https://client.example/callback',
      resource: canonicalResource(),
      scope: 'mcp:tools',
      expiresAt: new Date(Date.now() + 60000),
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
    })),
    client: jest.fn().mockResolvedValue({ clientId: 'client-1' }),
    redeemAuthorizationCode: jest.fn().mockResolvedValue(true),
    registerClient: jest.fn().mockResolvedValue({ client_id: 'client-1' }),
  }
  /** 使用真实 NestJS 路由与 Express 响应，覆盖直接调用 Controller 无法发现的默认 POST 201。 */
  @Module({
    controllers: [OAuthController],
    providers: [
      { provide: Identity, useValue: {} },
      { provide: OAuthService, useValue: oauth },
    ],
  })
  class TokenHttpTestModule {}

  let app: INestApplication
  let baseUrl: string
  let log: jest.SpyInstance
  beforeAll(async () => {
    log = jest.spyOn(console, 'info').mockImplementation(() => undefined)
    app = await NestFactory.create(TokenHttpTestModule, { logger: false })
    await app.listen(0, '127.0.0.1')
    baseUrl = await app.getUrl()
  })
  afterAll(async () => {
    await app?.close()
    log.mockRestore()
  })

  test.each<Record<string, string>>([
    { grant_type: 'refresh_token', refresh_token: 'old-refresh', client_id: 'client-1' },
    {
      grant_type: 'authorization_code',
      code: 'code',
      code_verifier: verifier,
      client_id: 'client-1',
      redirect_uri: 'https://client.example/callback',
      resource: canonicalResource(),
    },
  ])('$grant_type 成功返回 200、两种令牌及禁止缓存响应头', async (body) => {
    const res = await fetch(baseUrl + '/oauth/token', {
      method: 'POST',
      body: new URLSearchParams(body),
    })
    const result = await res.json()
    expect(res.status).toBe(200)
    expect(result).toEqual(
      expect.objectContaining({
        access_token: expect.any(String),
        refresh_token: expect.any(String),
        token_type: 'Bearer',
        expires_in: 3600,
      }),
    )
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('pragma')).toBe('no-cache')
  })

  test('刷新凭据被拒绝仍返回 400，错误正文与响应头关联编号一致', async () => {
    oauth.rotateRefreshToken.mockResolvedValueOnce(null)
    const res = await fetch(baseUrl + '/oauth/token', {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'revoked' }),
    })
    const result = await res.json()
    expect(res.status).toBe(400)
    expect(result).toEqual(
      expect.objectContaining({
        error: 'invalid_grant',
        request_id: res.headers.get('x-request-id'),
      }),
    )
  })

  test('动态客户端注册仍返回 201', async () => {
    const res = await fetch(baseUrl + '/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://client.example/callback'] }),
    })
    await res.json()
    expect(res.status).toBe(201)
  })
})

/** 模拟刷新 HTTP 响应的事件和状态，供诊断生命周期测试手动触发完成或断连。 */
function refreshResponse() {
  return Object.assign(new EventEmitter(), {
    statusCode: 200,
    headersSent: false,
    writableFinished: false,
    set: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  })
}

describe('公共客户端刷新请求兼容性', () => {
  let log: jest.SpyInstance
  beforeAll(() => {
    log = jest.spyOn(console, 'info').mockImplementation(() => undefined)
  })
  afterAll(() => log.mockRestore())

  test.each([undefined, 'client-1'])('client_id 为 %s 时通过服务层按摘要刷新', async (clientId) => {
    const repository = {
      rotateRefreshToken: jest.fn(async () => ({
        access: 'new-access',
        refresh: 'new-refresh',
        scope: 'mcp:tools',
      })),
    }
    const service = new OAuthService(repository as never)
    const controller = new OAuthController({} as never, service)
    const response = refreshResponse()
    await controller.token(new EventEmitter() as never, response as never, {
      grant_type: 'refresh_token',
      refresh_token: 'old-refresh',
      ...(clientId === undefined ? {} : { client_id: clientId }),
    })
    expect(repository.rotateRefreshToken).toHaveBeenCalledWith(
      hash('old-refresh'),
      clientId,
      expect.any(String),
    )
    expect(response.json).toHaveBeenCalledWith({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'mcp:tools',
    })
    expect(response.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
  })

  test.each<Record<string, string>>([
    { grant_type: 'refresh_token' },
    { grant_type: 'refresh_token', refresh_token: 'old-refresh', client_id: '' },
  ])('缺少令牌或显式提供空 client_id 时拒绝刷新', async (body) => {
    const service = { rotateRefreshToken: jest.fn() }
    const controller = new OAuthController({} as never, service as never)
    const response = refreshResponse()
    await controller.token(new EventEmitter() as never, response as never, body)
    expect(response.status).toHaveBeenCalledWith(400)
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'invalid_request', request_id: expect.any(String) }),
    )
    expect(service.rotateRefreshToken).not.toHaveBeenCalled()
    const requestId = response.set.mock.calls.find(([key]) => key === 'X-Request-Id')![1]
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ request_id: requestId }))
  })
})

describe('刷新响应诊断', () => {
  let log: jest.SpyInstance
  beforeEach(() => {
    log = jest.spyOn(console, 'info').mockImplementation(() => undefined)
  })
  afterEach(() => log.mockRestore())

  test.each([
    ['finish', 'token.refresh_response_finished'],
    ['close', 'token.refresh_response_closed'],
    ['error', 'token.refresh_response_error'],
  ])('%s 事件关联入口编号且不泄露请求正文', (event, expected) => {
    const req = new EventEmitter()
    const res = refreshResponse()
    const requestId = trackOAuthRefresh(req as never, res as never, {
      client_id: 'client-1',
      refresh_token: 'secret-refresh',
      resource: 'private-resource',
      scope: 'private-scope',
    })
    res.headersSent = true
    res.writableFinished = event === 'finish'
    res.emit(event, new Error('secret-stream-error'))
    res.emit('close')
    const entries = log.mock.calls.map(([line]) => JSON.parse(line))
    expect(entries).toEqual([
      expect.objectContaining({
        event: 'token.refresh_received',
        requestId,
        hasRefreshToken: true,
      }),
      expect.objectContaining({
        event: expected,
        requestId,
        statusCode: 200,
        durationMs: expect.any(Number),
      }),
    ])
    expect(req.listenerCount('aborted')).toBe(0)
    const output = JSON.stringify(entries)
    for (const secret of [
      'secret-refresh',
      'private-resource',
      'private-scope',
      'secret-stream-error',
    ]) {
      expect(output).not.toContain(secret)
    }
  })

  test('数据库异常保留原异常并记录关联编号，不记录异常正文', async () => {
    const error = new Error('secret-sql-parameters', {
      cause: Object.assign(new Error('secret-driver-message'), { code: 'ER_LOCK_DEADLOCK' }),
    })
    const service = { rotateRefreshToken: jest.fn().mockRejectedValue(error) }
    const controller = new OAuthController({} as never, service as never)
    const res = refreshResponse()
    await expect(
      controller.token(new EventEmitter() as never, res as never, {
        grant_type: 'refresh_token',
        refresh_token: 'secret-refresh',
      }),
    ).rejects.toBe(error)
    const entries = log.mock.calls.map(([line]) => JSON.parse(line))
    expect(entries[1]).toEqual(
      expect.objectContaining({
        event: 'token.refresh_transaction_failed',
        requestId: entries[0].requestId,
        reason: 'ER_LOCK_DEADLOCK',
      }),
    )
    expect(JSON.stringify(entries)).not.toContain('secret-sql-parameters')
    expect(JSON.stringify(entries)).not.toContain('secret-refresh')
  })
})

describe('OAuth refresh token contracts', () => {
  test('refresh tokens are persisted as hashes with family/revocation metadata', () => {
    const config = getTableConfig(S.oauthRefreshTokens)
    expect(config.columns.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'token_hash',
        'family_id',
        'grant_id',
        'expires_at',
        'consumed_at',
        'revoked_at',
      ]),
    )
  })

  test('grants are independent of access token lifetime', () => {
    const config = getTableConfig(S.oauthGrants)
    const names = config.columns.map((c) => c.name)
    expect(names).toContain('revoked_at')
    expect(names).not.toContain('expires_at')
  })

  test('unsupported grant type returns OAuth error without leaking request parameters', async () => {
    const controller = new OAuthController({} as never, {} as never)
    const response = {
      set: jest.fn().mockReturnThis(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    }
    const log = jest.spyOn(console, 'info').mockImplementation(() => undefined)
    try {
      await controller.token({} as never, response as never, {
        grant_type: 'password',
        client_id: 'clientA',
      })
      expect(response.status).toHaveBeenCalledWith(400)
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'unsupported_grant_type',
          request_id: expect.any(String),
        }),
      )
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining('secret-verifier'))
    } finally {
      log.mockRestore()
    }
  })

  test('error response includes a correlation ID without sensitive content', () => {
    const res = {
      set: jest.fn().mockReturnThis(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    }
    const log = jest.spyOn(console, 'info').mockImplementation(() => undefined)
    try {
      oauthError(res as never, 403, 'invalid_csrf', 'Authorization expired', 'authorize.rejected')
      expect(res.set).toHaveBeenCalledWith('X-Request-Id', expect.any(String))
      expect(res.status).toHaveBeenCalledWith(403)
      expect(log).toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
  })
})
