/** OAuth 登录回跳决策：只允许公开 Server 的授权入口，保留完整授权参数。 */
export function resolveOAuthReturn(
  returnTo: unknown,
  publicApiUrl: string,
  consoleUrl: string,
  development: boolean,
): { target?: string; error?: string } {
  if (returnTo === undefined) return {}
  if (typeof returnTo !== 'string' || !returnTo)
    return { error: 'OAuth 回跳地址无效，请重新发起授权' }
  let target: URL
  try {
    target = new URL(returnTo)
  } catch {
    return { error: 'OAuth 回跳地址无效，请重新发起授权' }
  }
  const consoleOrigin = new URL(consoleUrl)
  const server = new URL(publicApiUrl || consoleOrigin.origin)
  if (
    target.origin !== server.origin ||
    target.pathname !== '/oauth/authorize' ||
    target.username ||
    target.password ||
    target.hash
  )
    return { error: 'OAuth 回跳地址不受信任，请检查 VITE_API_URL 并重新发起授权' }

  // 开发模式通过 Vite 同源代理登录，Cookie 属于浏览器访问的主机而非代理目标。
  // localhost 的不同端口可以共享 Cookie，但 localhost 与公网隧道不能。
  if (
    development &&
    (consoleOrigin.hostname !== server.hostname || consoleOrigin.protocol !== server.protocol)
  )
    return { error: 'OAuth 联调地址不一致，请使用公网 MCP 域名打开 Console 后重新发起授权' }

  return { target: target.href }
}
