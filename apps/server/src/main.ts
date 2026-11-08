import 'reflect-metadata'
import dotenv from 'dotenv'
import path from 'node:path'
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') })
import { NestFactory } from '@nestjs/core'
import { Module } from '@nestjs/common'
import { Identity, Store, DeviceHub } from './core'
import {
  AuthController,
  AccountController,
  AdminController,
  PairingController,
} from './controllers'
import { OAuthController, OAuthService } from './oauth'
import { installMcp } from './mcp'
import cookieParser from 'cookie-parser'
import { json, urlencoded, type Request, type Response, type NextFunction } from 'express'
@Module({
  controllers: [
    AuthController,
    AccountController,
    AdminController,
    PairingController,
    OAuthController,
  ],
  providers: [Store, Identity, DeviceHub, OAuthService],
})
class AppModule {}
async function main() {
  if (!process.env.APP_SECRET || process.env.APP_SECRET.length < 32)
    throw new Error('APP_SECRET must contain at least 32 characters')
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required')
  const app = await NestFactory.create(AppModule, { bodyParser: false })
  // Keep MCP file payloads bounded while accepting OAuth form submissions.
  app.use(json({ limit: '1mb' }))
  app.use(urlencoded({ extended: false, limit: '16kb' }))
  const express = app.getHttpAdapter().getInstance()
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    if (req.path === '/oauth/authorize') {
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      )
    }
    next()
  })
  app.use(cookieParser())
  app.enableCors({
    origin: [
      process.env.CONSOLE_URL || 'http://localhost:5173',
      process.env.PUBLIC_URL || 'http://localhost:3000',
    ],
    credentials: true,
    allowedHeaders: ['content-type', 'x-csrf-token', 'authorization'],
  })
  // Small in-process rate limiter: production deployments should use a shared WAF/rate limit store.
  const hits = new Map<string, { n: number; until: number }>()
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!/\/api\/(auth\/(login|register)|device\/pairing)|\/oauth\/(register|token)/.test(req.path))
      return next()
    if (hits.size >= 10000) {
      const now = Date.now()
      for (const [key, value] of hits) if (value.until <= now) hits.delete(key)
      // Fail closed rather than allow unbounded per-process memory growth.
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
  const hub = app.get(DeviceHub),
    oauth = app.get(OAuthService),
    store = app.get(Store)
  installMcp(express, oauth, hub, store)
  app
    .getHttpAdapter()
    .getInstance()
    .get('/health', (_req: Request, res: Response) => res.json({ ok: true }))
  await app.listen(Number(process.env.PORT || 3000), '0.0.0.0')
  hub.attach(app.getHttpServer())
  console.log('Remote Code MCP listening', process.env.PUBLIC_URL || 'http://localhost:3000')
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
