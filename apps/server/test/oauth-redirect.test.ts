import { parseOAuthRedirect } from '../src/modules/oauth/oauth-redirect'
import { Env } from '../src/config/env'
import { renderOAuthConsent } from '../src/modules/oauth/oauth-consent-page'

describe('OAuth 回调地址策略', () => {
  test.each([
    ['https://chatgpt.com/connector/oauth/test', 'https', 'https://chatgpt.com'],
    ['http://localhost:8080/callback', 'loopback', 'http://localhost:8080'],
    ['http://127.0.0.1:8080/callback', 'loopback', 'http://127.0.0.1:8080'],
    ['http://[::1]:8080/callback', 'loopback', 'http://[::1]:8080'],
    ['workbuddy://workbuddy/mcp/test', 'custom-scheme', 'workbuddy:'],
  ])('允许 %s 并生成正确 CSP', (uri, type, source) => {
    expect(parseOAuthRedirect(uri)).toMatchObject({ type, cspSource: source })
  })

  test.each([
    'http://example.com/callback',
    'ftp://localhost/callback',
    'javascript:alert(1)',
    'file:///tmp/callback',
    'data:text/plain,test',
    'other://app/callback',
    'workbuddy://other/mcp/test',
    'workbuddy://workbuddy/other/test',
    'workbuddy://workbuddy:8080/mcp/test',
    'https://user:password@example.com/callback',
    'https://example.com/callback#fragment',
  ])('拒绝 %s', (uri) => {
    expect(parseOAuthRedirect(uri)).toBeNull()
  })

  test('部署者可追加深链规则，危险协议不允许配置', () => {
    const config = new Env(
      {
        OAUTH_CUSTOM_REDIRECT_RULES: JSON.stringify([
          { scheme: 'example-ai', hostname: 'oauth', pathPrefix: '/callback/' },
        ]),
      },
      [],
    )
    expect(config.oauthCustomRedirectRules).toContainEqual({
      scheme: 'example-ai',
      hostname: 'oauth',
      pathPrefix: '/callback/',
    })
    expect(
      () =>
        new Env(
          {
            OAUTH_CUSTOM_REDIRECT_RULES:
              '[{"scheme":"javascript","hostname":"oauth","pathPrefix":"/callback/"}]',
          },
          [],
        ).oauthCustomRedirectRules,
    ).toThrow()
  })

  test('深链页面展示真实目标并转义客户端名称', () => {
    const html = renderOAuthConsent({
      clientName: '<script>test</script>',
      email: 'user@example.com',
      target: 'workbuddy://workbuddy/mcp/test',
      type: 'custom-scheme',
      fields: '',
      csrf: 'csrf',
      issuedAt: '123',
      signature: 'sig',
    })
    expect(html).toContain('workbuddy://workbuddy/mcp/test')
    expect(html).toContain('本地应用深链')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })
})
