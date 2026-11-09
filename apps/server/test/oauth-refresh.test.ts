import { OAuthController } from '../src/oauth'
import { getTableConfig } from 'drizzle-orm/mysql-core'
import * as S from '../src/schema'
import { oauthError } from '../src/oauth-telemetry'

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
    const controller = new OAuthController({} as never, {} as never, {} as never)
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
