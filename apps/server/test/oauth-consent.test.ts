import { OAuthController } from '../src/modules/oauth/oauth.controller'
import { hash } from '../src/common/security'
import {
  canonicalResource,
  frontend,
  origin,
  oauthConsentSignature,
} from '../src/modules/oauth/oauth-utils'

/** 授权确认入口安全回归：拒绝请求不得创建授权码或重定向到客户端。 */
function setup() {
  const user = { id: 'user-1' }
  const auth = { requireUser: jest.fn(async () => user) }
  const oauth = {
    createConsent: jest.fn(async () => undefined),
    confirmConsent: jest.fn(async () => ({ code: 'issued-code', clientId: 'client-1' })),
  }
  const controller = new OAuthController(auth as never, oauth as never)
  const response = {
    set: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    clearCookie: jest.fn().mockReturnThis(),
    redirect: jest.fn().mockReturnThis(),
  }
  const csrf = 'csrf-secret'
  const body = {
    csrf,
    issued_at: String(Date.now()),
    client_id: 'client-1',
    redirect_uri: 'https://client.example/callback',
    code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256',
    response_type: 'code',
    resource: canonicalResource(),
    state: 'opaque-state',
  }
  const signedBody = {
    ...body,
    consent_sig: oauthConsentSignature(body, user.id, csrf, body.issued_at),
  }
  const req = { cookies: { rcm_oauth_csrf: hash(csrf) } }
  return { controller, auth, oauth, response, body: signedBody, req }
}

describe('OAuth 授权确认安全边界', () => {
  let log: jest.SpyInstance
  beforeEach(() => {
    log = jest.spyOn(console, 'info').mockImplementation(() => undefined)
  })
  afterEach(() => log.mockRestore())

  test('缺少 CSRF Cookie 时拒绝授权', async () => {
    const state = setup()
    await state.controller.accept({ cookies: {} } as never, state.response as never, state.body)
    expect(state.response.status).toHaveBeenCalledWith(403)
    expect(state.oauth.confirmConsent).not.toHaveBeenCalled()
    expect(state.response.redirect).not.toHaveBeenCalled()
  })

  test('篡改授权字段后 HMAC 校验失败', async () => {
    const state = setup()
    await state.controller.accept(state.req as never, state.response as never, {
      ...state.body,
      redirect_uri: 'https://attacker.example/callback',
    })
    expect(state.response.status).toHaveBeenCalledWith(403)
    expect(state.oauth.confirmConsent).not.toHaveBeenCalled()
  })

  test('超过五分钟的授权确认被拒绝', async () => {
    const state = setup()
    const body = { ...state.body, issued_at: String(Date.now() - 301000) }
    body.consent_sig = oauthConsentSignature(body, 'user-1', body.csrf, body.issued_at)
    await state.controller.accept(state.req as never, state.response as never, body)
    expect(state.response.status).toHaveBeenCalledWith(403)
    expect(state.oauth.confirmConsent).not.toHaveBeenCalled()
  })

  test('合法确认清理 Cookie 并以 303 跳转，状态参数原样传递', async () => {
    const state = setup()
    await state.controller.accept(state.req as never, state.response as never, state.body)
    expect(state.response.clearCookie).toHaveBeenCalledWith('rcm_oauth_csrf', { path: '/oauth' })
    expect(state.oauth.confirmConsent).toHaveBeenCalledWith('user-1', 'csrf-secret', state.body)
    expect(state.response.redirect).toHaveBeenCalledWith(
      303,
      'https://client.example/callback?code=issued-code&state=opaque-state',
    )
  })
  test('深链确认以 303 携带授权码及 state 唤起客户端', async () => {
    const state = setup()
    const body = { ...state.body, redirect_uri: 'workbuddy://workbuddy/mcp/test' }
    body.consent_sig = oauthConsentSignature(body, 'user-1', body.csrf, body.issued_at)
    await state.controller.accept(state.req as never, state.response as never, body)
    expect(state.response.redirect).toHaveBeenCalledWith(
      303,
      'workbuddy://workbuddy/mcp/test?code=issued-code&state=opaque-state',
    )
  })
})

describe('OAuth 未登录及首次改密回跳', () => {
  test.each([null, { id: 'user-1', status: 'active', passwordChangeRequired: true }])(
    '未完成登录的账号进入 Console 并保留完整授权参数：%j',
    async (user) => {
      const query = {
        client_id: 'client-1',
        redirect_uri: 'https://client.example/callback',
        state: 'opaque&state',
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'S256',
        response_type: 'code',
        resource: canonicalResource(),
        scope: 'mcp:tools',
      }
      const auth = { userBySession: jest.fn().mockResolvedValue(user) }
      const oauth = {
        client: jest.fn().mockResolvedValue({ redirectUris: JSON.stringify([query.redirect_uri]) }),
        createConsent: jest.fn(),
      }
      const response = { redirect: jest.fn() }
      const controller = new OAuthController(auth as never, oauth as never)
      await controller.authorize({} as never, response as never, query)
      const destination = new URL(response.redirect.mock.calls[0][0])
      expect(destination.origin).toBe(new URL(frontend()).origin)
      expect(destination.pathname).toBe('/console')
      const target = new URL(destination.searchParams.get('returnTo')!)
      expect(target.origin).toBe(new URL(origin()).origin)
      expect(target.pathname).toBe('/oauth/authorize')
      expect(Object.fromEntries(target.searchParams)).toEqual(query)
      expect(oauth.createConsent).not.toHaveBeenCalled()
    },
  )
})
