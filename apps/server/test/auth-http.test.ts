import { Module, HttpException, type INestApplication } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AuthController } from '../src/modules/auth/auth.controller'
import { AuthService } from '../src/modules/auth/auth.service'
import { configureHttp } from '../src/http-bootstrap'
import { env } from '../src/config/env'

const auth = {
  activateEmail: jest.fn().mockResolvedValue({ ok: true }),
  resendActivation: jest.fn(),
}
/** 挂载真实认证路由及 HTTP 安全中间件，不连接数据库和 SMTP。 */
@Module({ controllers: [AuthController], providers: [{ provide: AuthService, useValue: auth }] })
class AuthHttpTestModule {}
let app: INestApplication
let url: string
beforeAll(async () => {
  app = await NestFactory.create(AuthHttpTestModule, { logger: false })
  configureHttp(app)
  await app.listen(0, '127.0.0.1')
  url = await app.getUrl()
})
afterAll(async () => {
  await app?.close()
})

test('激活接口拒绝缺失 CSRF，合法公开请求不创建 Session', async () => {
  const rejected = await fetch(url + '/api/auth/activate-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: env.consoleUrl },
    body: JSON.stringify({ token: 'preview' }),
  })
  expect(rejected.status).toBe(403)
  expect(auth.activateEmail).not.toHaveBeenCalled()
  const csrf = await fetch(url + '/api/auth/csrf')
  const { csrfToken } = (await csrf.json()) as { csrfToken: string }
  const res = await fetch(url + '/api/auth/activate-email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: env.consoleUrl,
      Cookie: `rcm_csrf=${csrfToken}`,
      'x-csrf-token': csrfToken,
    },
    body: JSON.stringify({ token: 'preview' }),
  })
  expect(res.ok).toBe(true)
  expect(await res.json()).toEqual({ ok: true })
  expect(res.headers.get('set-cookie')).toBeNull()
  expect(auth.activateEmail).toHaveBeenCalledWith('preview')
})

test('重发接口保留服务端冷却状态码与剩余秒数', async () => {
  auth.resendActivation.mockRejectedValueOnce(
    new HttpException({ message: '请稍后重试', retryAfter: 42 }, 429),
  )
  const csrf = await fetch(url + '/api/auth/csrf')
  const { csrfToken } = (await csrf.json()) as { csrfToken: string }
  const res = await fetch(url + '/api/auth/resend-activation', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: env.consoleUrl,
      Cookie: `rcm_csrf=${csrfToken}`,
      'x-csrf-token': csrfToken,
    },
    body: JSON.stringify({ email: 'user@example.com', password: 'test-password' }),
  })
  expect(res.status).toBe(429)
  expect(await res.json()).toMatchObject({ retryAfter: 42 })
})

test('重发是密码验证入口，沿用认证限流以限制连续尝试', async () => {
  const statuses: number[] = []
  for (let attempt = 0; attempt < 20; attempt++) {
    const res = await fetch(url + '/api/auth/resend-activation', { method: 'POST' })
    statuses.push(res.status)
    await res.text()
  }
  expect(statuses.slice(0, -1)).toEqual(Array(19).fill(403))
  expect(statuses.at(-1)).toBe(429)
})
