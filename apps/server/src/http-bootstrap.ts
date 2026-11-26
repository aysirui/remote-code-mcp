import type { INestApplication } from '@nestjs/common'
import cookieParser from 'cookie-parser'
import { json, urlencoded, type Request, type Response, type NextFunction } from 'express'
import { RPC_MESSAGE_LIMIT_BYTES } from '@rcm/protocol'
import { env } from './config/env'

/** 集中装配全局 HTTP 安全头、请求体限制、Cookie、CORS 与认证入口限流。 */
export function configureHttp(app: INestApplication) {
  // MCP JSON 请求允许携带 Base64 文件；其他 JSON 接口和 OAuth 表单使用各自的上限。
  app.use('/mcp', json({ limit: RPC_MESSAGE_LIMIT_BYTES }))
  app.use(json({ limit: '1mb' }))
  app.use(urlencoded({ extended: false, limit: '16kb' }))
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    // OAuth 授权页 CSP 由 OAuthController 校验 redirect_uri 后设置。
    // 静态 form-action 'self' 会阻止 Chromium 在 POST 后跨域重定向。
    next()
  })
  app.use(cookieParser())
  app.enableCors({
    origin: [env.consoleUrl, env.publicUrl],
    credentials: true,
    allowedHeaders: ['content-type', 'x-csrf-token', 'authorization'],
  })
  // 进程内限流仅作为轻量保护；生产部署应配合共享限流或 WAF。
  const hits = new Map<string, { n: number; until: number }>()
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (
      !/\/api\/(auth\/(login|register|resend-activation|activate-email)|device\/pairing)|\/oauth\/(register|token)/.test(
        req.path,
      )
    )
      return next()
    if (hits.size >= 10000) {
      const now = Date.now()
      for (const [key, value] of hits) if (value.until <= now) hits.delete(key)
      // 达到内存上限时拒绝请求，不让计数器无限增长。
      if (hits.size >= 10000) return res.status(429).json({ error: 'rate_limited' })
    }
    const key = (req.ip || '') + req.path
    let h = hits.get(key)
    if (!h || h.until < Date.now()) {
      h = { n: 0, until: Date.now() + 60000 }
      hits.set(key, h)
    }
    if (++h.n > 20) return res.status(429).json({ error: 'rate_limited' })
    next()
  })
}
