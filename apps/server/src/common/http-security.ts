import { env } from '../config/env'
import type { Request, Response } from 'express'
import { ForbiddenException } from '@nestjs/common'

/** Gateway 的公网地址，用于安全 Cookie 与 Origin 校验。 */
export const base = () => env.publicUrl

/** 用户 Console 的公网地址；OAuth 和配对流程使用此地址。 */
export const consoleUrl = () => env.consoleUrl

/** 只向浏览器写入 HttpOnly Session Cookie，不暴露给 JS 读取。 */
export function setCookie(res: Response, name: string, value: string, ttl = 604800) {
  res.cookie(name, value, {
    httpOnly: true,
    secure: base().startsWith('https:'),
    sameSite: 'lax',
    path: '/',
    maxAge: ttl * 1000,
  })
}

/** 阻止不可信站点通过浏览器发起跨源写操作。 */
export function checkOrigin(req: Request) {
  const origin = req.headers.origin
  if (origin) {
    const allowed = [new URL(base()).origin, new URL(consoleUrl()).origin]
    if (!allowed.includes(origin)) throw new ForbiddenException('Invalid origin')
  }
}

/**
 * 写请求双重提交 CSRF 校验。
 * Origin 缺失时只能使用可信 Referer；Cookie 与请求头必须完全匹配。
 */
export function csrf(req: Request) {
  checkOrigin(req)
  if (!req.headers.origin) {
    try {
      const referer = new URL(req.headers.referer || '')
      const allowed = [new URL(base()).origin, new URL(consoleUrl()).origin]
      if (!allowed.includes(referer.origin)) throw Error('Untrusted referer')
    } catch {
      throw new ForbiddenException('Origin or trusted Referer required')
    }
  }
  const cookieToken = req.cookies?.rcm_csrf
  const headerToken = req.headers['x-csrf-token']
  if (!cookieToken || headerToken !== cookieToken)
    throw new ForbiddenException('CSRF token required')
}
