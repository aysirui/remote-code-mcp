import type { Response } from 'express'
import { randomUUID } from 'node:crypto'

/**
 * OAuth 结构化安全事件。绝不输出请求体、Cookie、code、token、PKCE verifier 或 CSRF。
 * 事件 ID 可用于和浏览器错误页面、WAF 日志关联。
 */
export function oauthLog(event: string, fields: Record<string, string | undefined> = {}) {
  const safe = Object.fromEntries(
    Object.entries(fields).filter(([key]) =>
      ['clientId', 'userId', 'requestId', 'clientName'].includes(key),
    ),
  )
  console.info(JSON.stringify({ subsystem: 'oauth', event, at: new Date().toISOString(), ...safe }))
}
export function oauthError(
  res: Response,
  status: number,
  code: string,
  message: string,
  event: string,
) {
  const requestId = randomUUID()
  oauthLog(event, { requestId })
  res.set('X-Request-Id', requestId)
  res.set('Cache-Control', 'no-store')
  return res.status(status).json({ error: code, error_description: message, request_id: requestId })
}
