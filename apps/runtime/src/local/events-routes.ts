import type { Router } from 'express'
import { workspaceViews, type Config } from '../workspace/state'
import type { WriteApprovalQueue } from '../requests/write-approvals'
import type { LocalEvents, LocalEventName } from './local-events'

/** 注册本地状态订阅接口；由外层 Router 统一校验 Bearer Token。 */
export function registerEventsRoutes(
  api: Router,
  config: Config,
  approvals: WriteApprovalQueue,
  events: LocalEvents,
  status: () => object,
) {
  /**
   * 本地状态 SSE 订阅：不把启动 Token 放在 URL 查询参数。
   * 首次发送完整快照，后续只推送变化资源，连接关闭后清理订阅与心跳。
   */
  api.get('/events', (req, res) => {
    res.status(200)
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    const send = (name: LocalEventName) => {
      if (res.destroyed || res.writableEnded) return
      const payload =
        name === 'status'
          ? status()
          : name === 'workspaces'
            ? workspaceViews(config)
            : approvals.list()
      res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`)
    }

    send('status')
    send('workspaces')
    send('write-approvals')

    const unsubscribe = events.subscribe(send)
    const heartbeat = setInterval(() => {
      if (!res.destroyed && !res.writableEnded) res.write(': keepalive\n\n')
    }, 25000)
    req.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  })
}
