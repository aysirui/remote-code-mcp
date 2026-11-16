import { OAuthService } from '../src/modules/oauth/oauth.service'
import type { OAuthRepository } from '../src/modules/oauth/oauth.repository'
import { hash } from '../src/common/security'
import { canonicalResource } from '../src/modules/oauth/oauth-utils'

/** 授权码签发服务测试：只允许已注册客户端的精确回调与 S256 请求。 */
function setup(redirectUris = ['https://client.example/callback']) {
  const repository = {
    createConsent: jest.fn(async () => undefined),
    consumeConsentAndCreateCode: jest.fn(async () => true),
    client: jest.fn(async () => ({
      clientId: 'client-1',
      redirectUris: JSON.stringify(redirectUris),
    })),
    registerClient: jest.fn(),
  }
  const service = new OAuthService(repository as unknown as OAuthRepository)
  const body = {
    client_id: 'client-1',
    redirect_uri: 'https://client.example/callback',
    response_type: 'code',
    code_challenge_method: 'S256',
    code_challenge: 'A'.repeat(43),
    resource: canonicalResource(),
    scope: 'mcp:tools',
  }
  return { service, repository, body }
}

test('有效客户端与 PKCE 请求创建授权码摘要，不保存原始授权码', async () => {
  const state = setup()
  const result = await state.service.confirmConsent('user-1', 'csrf-token', state.body)
  expect(result).toEqual({ code: expect.any(String), clientId: 'client-1' })
  expect(state.repository.consumeConsentAndCreateCode).toHaveBeenCalledWith(
    expect.objectContaining({
      csrfHash: hash('csrf-token'),
      codeHash: hash(result!.code),
      clientId: 'client-1',
      userId: 'user-1',
      redirectUri: state.body.redirect_uri,
      codeChallenge: state.body.code_challenge,
      scope: 'mcp:tools',
      resource: canonicalResource(),
      expiresAt: expect.any(Date),
    }),
  )
})

test.each([
  ['unknown client', { client_id: 'missing' }],
  ['unregistered redirect URI', { redirect_uri: 'https://attacker.example/callback' }],
  ['wrong PKCE method', { code_challenge_method: 'plain' }],
  ['malformed challenge', { code_challenge: 'short' }],
  ['wrong response type', { response_type: 'token' }],
  ['wrong resource', { resource: 'https://attacker.example/mcp' }],
] as const)('%s is rejected without creating an authorization code', async (_name, override) => {
  const state = setup()
  if ('client_id' in override) state.repository.client.mockResolvedValueOnce(null as never)
  await expect(
    state.service.confirmConsent('user-1', 'csrf-token', { ...state.body, ...override }),
  ).resolves.toBeNull()
  expect(state.repository.consumeConsentAndCreateCode).not.toHaveBeenCalled()
})
