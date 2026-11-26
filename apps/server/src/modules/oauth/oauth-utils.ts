import { env } from '../../config/env'
import { createHmac, timingSafeEqual } from 'node:crypto'

/** OAuth 授权服务与客户端交互时共享的验证工具。 */
export const origin = () => env.publicUrl
export const frontend = () => env.consoleUrl
export const esc = (s: string) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
export const canonicalResource = () => origin().replace(/\/$/, '') + '/mcp'
export const oauthConsentSignature = (
  fields: Record<string, unknown>,
  userId: string,
  nonce: string,
  issuedAt: string,
) => {
  const names = [
    'client_id',
    'redirect_uri',
    'state',
    'code_challenge',
    'code_challenge_method',
    'response_type',
    'resource',
    'scope',
  ]
  const serialized = JSON.stringify([
    userId,
    nonce,
    issuedAt,
    ...names.map((name) => String(fields[name] ?? '')),
  ])
  return createHmac('sha256', env.appSecret).update(serialized).digest('hex')
}
export const equals = (left: string, right: string) => {
  const l = Buffer.from(left, 'utf8'),
    r = Buffer.from(right, 'utf8')
  return l.length === r.length && timingSafeEqual(l, r)
}
