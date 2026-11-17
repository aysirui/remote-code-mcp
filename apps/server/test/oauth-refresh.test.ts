import { OAuthController } from '../src/modules/oauth/oauth.controller'
import { getTableConfig } from 'drizzle-orm/mysql-core'
import * as S from '../src/infrastructure/database/schema'
import { oauthError, trackOAuthRefresh } from '../src/modules/oauth/oauth-telemetry'
import { OAuthService } from '../src/modules/oauth/oauth.service'
import { hash } from '../src/common/security'
import { EventEmitter } from 'node:events'

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
  const log = jest.spyOn(console, 'info').mockImplementation(() => undefined)
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
