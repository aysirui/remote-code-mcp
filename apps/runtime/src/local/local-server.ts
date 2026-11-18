import express, { type ErrorRequestHandler } from 'express'
import { registerWorkspaceRoutes } from './workspace-routes'
import { registerServerRoutes } from './server-routes'
import { registerEventsRoutes } from './events-routes'
import path from 'node:path'
import { styleText } from 'node:util'
import type { Config } from '../workspace/state'
import type { WriteApprovalQueue } from '../requests/write-approvals'
import type { LocalEvents } from './local-events'
import { logger } from '../logger'

/** 本地管理 HTTP Server 的外部依赖，由 Runtime 主入口注入以避免全局状态耦合。 */
export interface LocalServerOptions {
  port: number
  localKey: string
  config: Config
  approvals: WriteApprovalQueue
  events: LocalEvents
  status: () => object
  disconnect: () => void
  connect: () => void
  sync: () => Promise<void>
}

/**
 * 启动仅监听 127.0.0.1 的本地管理服务。
 * 所有 /local/api 请求必须带启动时生成的 Bearer Token，
 * 并强制 Host / Origin 校验，避免 DNS Rebinding 与跨站滥用。
 */
export function startLocalServer(options: LocalServerOptions) {
  const { port, localKey, config, approvals, events, status, disconnect, connect, sync } = options
  const app = express()
  app.enable('case sensitive routing')
  app.disable('x-powered-by')
  app.use((req, res, next) => {
    if (/^\/local\/api(?:\/|$)/i.test(req.path)) {
      const startedAt = Date.now()
      const url = req.originalUrl
      res.once('finish', () => {
        // 本地诊断保留原始 URL 和已解析的参数；不读取认证请求头。
        const route: unknown = req.route?.path
        const details = {
          method: req.method,
          url,
          query: req.query,
          body: req.body as unknown,
          route: typeof route === 'string' ? route : undefined,
          httpStatus: res.statusCode,
          durationMs: Date.now() - startedAt,
          err: res.locals.diagnosticError as unknown,
        }
        if (res.statusCode >= 400) logger.error('local.request.failed', details)
        else logger.debug('local.request.completed', details)
      })
    }
    next()
  })
  app.use(express.json({ limit: '1mb' }))

  /** 同源检查必须优先于 API 路由处理；Token 不得被转发至外部域名。 */
  app.use((req, res, next) => {
    if (req.get('host') !== `127.0.0.1:${port}`) {
      res.status(403).json({ error: 'invalid host' })
      return
    }
    const origin = req.get('origin')
    if (origin && origin !== `http://127.0.0.1:${port}`) {
      res.status(403).json({ error: 'origin denied' })
      return
    }
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Cache-Control', 'no-store')
    next()
  })

  // 所有管理接口只注册到此 Router，鉴权与路由共用 Express 的挂载语义。
  const api = express.Router({ caseSensitive: true })
  app.use(/^\/local\/api(?=\/|$)/i, api)
  api.use((req, res, next) => {
    if (req.headers.authorization !== 'Bearer ' + localKey) {
      res.status(401).json({
        code: 'LOCAL_AUTH_REQUIRED',
        error:
          '本地管理凭据无效，请打开当前 Runtime 启动终端中的完整链接；找不到链接时，请重启 Runtime 后使用新链接。',
      })
      return
    }
    next()
  })

  registerEventsRoutes(api, config, approvals, events, status)

  /** 当前设备连接状态，不包含原始设备凭据。 */
  api.get('/status', (_req, res) => res.json(status()))

  /** 获取本地用户尚未批准的文件写入任务。 */
  api.get('/write-approvals', (_req, res) => res.json(approvals.list()))

  /** 只接受布尔决定，每个审批请求只允许完成一次。 */
  api.post('/write-approvals/:id', (req, res) => {
    if (typeof req.body?.approve !== 'boolean') {
      res.status(400).json({ error: 'approve must be a boolean' })
      return
    }
    if (!approvals.answer(String(req.params.id), req.body.approve)) {
      res.status(404).json({ error: 'Approval expired or already handled' })
      return
    }
    res.json({ ok: true })
  })

  const { requireActiveServer, publishConfig, fail } = registerServerRoutes({
    api,
    config,
    approvals,
    events,
    status,
    disconnect,
    connect,
  })

  registerWorkspaceRoutes({
    api,
    config,
    approvals,
    events,
    sync,
    requireActiveServer,
    publishConfig,
    fail,
  })

  // 开发使用 src/，发布编译后使用 dist/server/；静态页面统一位于 dist/web/。
  const ui = path.resolve(
    __dirname,
    path.basename(path.dirname(__dirname)) === 'server' ? '../../web' : '../../dist/web',
  )
  app.use(express.static(ui))
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(ui, 'index.html')))

  /** Express 捕获的异常不属于进程崩溃；只返回固定错误码，不把异常栈写入 HTTP 响应。 */
  const handleLocalError: ErrorRequestHandler = (error: unknown, req, res, _next) => {
    const status =
      error && typeof error === 'object' && 'status' in error ? error.status : undefined
    const httpStatus =
      typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 600
        ? status
        : 500
    const code = httpStatus >= 500 ? 'LOCAL_INTERNAL_ERROR' : 'LOCAL_REQUEST_INVALID'
    logger.error('local.request.exception', {
      code,
      httpStatus,
      method: req.method,
      url: req.originalUrl,
      query: req.query,
      body: req.body as unknown,
      err: error,
    })
    if (res.headersSent) res.destroy()
    else
      res
        .status(httpStatus)
        .json({ code, error: httpStatus >= 500 ? '本地服务内部错误' : '本地请求无效' })
  }
  app.use(handleLocalError)

  const server = app.listen(port, '127.0.0.1', () => {
    const address = server.address()
    const listeningPort = address && typeof address === 'object' ? address.port : port
    logger.info('runtime.local_server.listening', { port: listeningPort })
    // 启动提示与结构化日志分开；终端不支持颜色时仍保留空行及缩进。
    const link = `Local UI: http://127.0.0.1:${listeningPort}/#token=${localKey}`
    const warning = 'This URL is private; do not share its token.'
    const useColor =
      process.stdout.isTTY && process.stdout.hasColors() && process.env.NO_COLOR === undefined
    console.log(
      `\n  ${useColor ? styleText(['bold', 'cyan'], link) : link}\n  ${useColor ? styleText(['bold', 'yellow'], warning) : warning}\n`,
    )
  })
  return server
}
