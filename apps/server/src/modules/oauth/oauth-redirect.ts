import { env } from '../../config/env'

/** 回调类型决定授权页面展示与 CSP 来源，不改变注册地址精确匹配规则。 */
export type OAuthRedirectType = 'https' | 'loopback' | 'custom-scheme'

/** 解析并校验回调地址；自定义协议必须命中服务端配置的主机和路径规则。 */
export function parseOAuthRedirect(uri: string): {
  type: OAuthRedirectType
  url: URL
  cspSource: string
  displayTarget: string
} | null {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return null
  }
  if (url.username || url.password || uri.includes('#')) return null
  if (url.protocol === 'https:') {
    return { type: 'https', url, cspSource: url.origin, displayTarget: url.origin }
  }
  if (url.protocol === 'http:') {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null
    return { type: 'loopback', url, cspSource: url.origin, displayTarget: url.origin }
  }
  // 深链的 URL.origin 为 null，CSP 必须使用协议源表达式。
  if (
    url.port ||
    !env.oauthCustomRedirectRules.some(
      (rule) =>
        url.protocol === rule.scheme + ':' &&
        url.hostname === rule.hostname &&
        url.pathname.startsWith(rule.pathPrefix),
    )
  )
    return null
  return {
    type: 'custom-scheme',
    url,
    cspSource: url.protocol,
    displayTarget: url.protocol + '//' + url.host + url.pathname,
  }
}
