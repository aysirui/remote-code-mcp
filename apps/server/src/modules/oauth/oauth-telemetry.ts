import type { Request, Response } from 'express'
import { randomUUID } from 'node:crypto'

/**
 * OAuth 结构化安全事件。绝不输出请求体、Cookie、code、token、PKCE verifier 或 CSRF。
 * 事件 ID 可用于和浏览器错误页面、WAF 日志关联。
 */
export function oauthLog(
  event: string,
  fields: Record<string, string | number | boolean | undefined> = {},
) {
  const safe = Object.fromEntries(
    Object.entries(fields).filter(([key]) =>
      [
        'clientId',
        'userId',
        'requestId',
        'clientName',
        'reason',
        'tokenId',
        'nextTokenId',
        'familyId',
        'grantId',
        'consumedAt',
        'expiresAt',
        'statusCode',
        'durationMs',
        'headersSent',
        'writableFinished',
        'hasClientId',
        'hasRefreshToken',
        'hasResource',
        'hasScope',
      ].includes(key),
    ),
  )
  console.info(JSON.stringify({ subsystem: 'oauth', event, at: new Date().toISOString(), ...safe }))
}

/**
 * 为一次刷新请求生成服务端关联编号并监听响应生命周期，返回供业务日志复用的 requestId。
 * finish 仅表示响应已交给本机 HTTP 层，不能证明代理已转发或客户端已保存新令牌。
 */
export function trackOAuthRefresh(req: Request, res: Response, body: Record<string, string>) {
  const requestId = randomUUID()
  const startedAt = performance.now()
  const fields = {
    requestId,
    clientId: typeof body.client_id === 'string' ? body.client_id : undefined,
  }
  res.set('X-Request-Id', requestId)
  oauthLog('token.refresh_received', {
    ...fields,
    hasClientId: body.client_id !== undefined,
    hasRefreshToken: body.refresh_token !== undefined,
    hasResource: body.resource !== undefined,
    hasScope: body.scope !== undefined,
  })
  /** 记录响应状态与耗时，不读取响应正文或底层异常消息。 */
  const logResponse = (event: string) =>
    oauthLog(event, {
      ...fields,
      statusCode: res.statusCode,
      durationMs: Math.round(performance.now() - startedAt),
      headersSent: res.headersSent,
      writableFinished: res.writableFinished,
    })
  /** 响应结束或断连后清理其余监听，避免同一响应重复结算。 */
  const cleanup = () => {
    res.off('finish', onFinish)
    res.off('close', onClose)
    res.off('error', onError)
    req.off('aborted', onAborted)
  }
  /** HTTP 层完成写出；无法据此确认客户端收到了响应。 */
  const onFinish = () => {
    logResponse('token.refresh_response_finished')
    cleanup()
  }
  /** finish 前连接关闭，刷新事务可能已经提交。 */
  const onClose = () => {
    logResponse('token.refresh_response_closed')
    cleanup()
  }
  /** 仅记录响应流失败事件，避免异常正文泄露令牌或 SQL 参数。 */
  const onError = () => {
    logResponse('token.refresh_response_error')
    cleanup()
  }
  /** 请求体传输中断与响应断连分别记录，随后由响应事件结算。 */
  const onAborted = () => logResponse('token.refresh_request_aborted')
  res.once('finish', onFinish)
  res.once('close', onClose)
  res.once('error', onError)
  req.once('aborted', onAborted)
  return requestId
}

/** 返回标准 OAuth 错误；传入 requestId 时沿用本次请求编号，否则生成新编号。 */
export function oauthError(
  res: Response,
  status: number,
  code: string,
  message: string,
  event: string,
  requestId = randomUUID(),
) {
  oauthLog(event, { requestId, statusCode: status, reason: code })
  res.set('X-Request-Id', requestId)
  res.set('Cache-Control', 'no-store')
  return res.status(status).json({ error: code, error_description: message, request_id: requestId })
}
