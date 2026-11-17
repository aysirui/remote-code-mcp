import { MySqlDialect } from 'drizzle-orm/mysql-core'
import type { SQL } from 'drizzle-orm'
import { hash } from '../src/common/security'
import * as bcrypt from 'bcryptjs'
import * as S from '../src/infrastructure/database/schema'
import type { Store } from '../src/infrastructure/database/store'
import { Identity } from '../src/modules/core/identity'
import { AuthService } from '../src/modules/auth/auth.service'
import type { MailService } from '../src/modules/mail/mail.service'

/** 用内存记录执行真实查询条件，并串行模拟用户行锁保护的事务。 */
function setup() {
  const user = {
    id: 'user-1',
    email: 'user@example.com',
    passwordHash: bcrypt.hashSync('password-123456', 4),
    emailVerified: false,
    status: 'active',
  }
  let activation: { userId: string; tokenHash: string; expiresAt: Date; sentAt: Date } | undefined
  const dialect = new MySqlDialect()
  const select = jest.fn(() => ({
    from: (table: unknown) => {
      let condition: SQL | undefined
      interface Query {
        where: (value: SQL) => Query
        limit: () => Query
        for: jest.Mock
        then: (resolve: (rows: unknown[]) => unknown) => Promise<unknown>
      }
      const query: Query = {
        where: (value: SQL) => {
          condition = value
          return query
        },
        limit: () => query,
        for: jest.fn(() => query),
        then: (resolve: (rows: unknown[]) => unknown) => {
          const source = table === S.users ? user : activation
          if (!source) return Promise.resolve([]).then(resolve)
          const rendered = condition ? dialect.sqlToQuery(condition) : { sql: '', params: [] }
          const params = rendered.params
          const hasExpiry = rendered.sql.includes('expires_at')
          const identityParams = hasExpiry ? params.slice(0, -1) : params
          const row = source as unknown as Record<string, unknown>
          const matches = identityParams.every((value) => Object.values(row).includes(value))
          const valid =
            !hasExpiry ||
            (!!activation &&
              activation.expiresAt.getTime() >
                new Date(String(params.at(-1)).replace(' ', 'T') + 'Z').getTime())
          return Promise.resolve(matches && valid ? [source] : []).then(resolve)
        },
      }
      return query
    },
  }))
  const insert = jest.fn((table: unknown) => ({
    values: (values: typeof activation) => {
      if (table === S.emailActivations) activation = values
      return { onDuplicateKeyUpdate: async () => undefined }
    },
  }))
  const update = jest.fn(() => ({
    set: (values: Partial<typeof user>) => ({
      where: async () => {
        Object.assign(user, values)
      },
    }),
  }))
  const remove = jest.fn(() => ({
    where: async () => {
      activation = undefined
    },
  }))
  const tx = { select, insert, update, delete: remove }
  let tail = Promise.resolve()
  const transaction = jest.fn((work: (db: typeof tx) => Promise<void>) => {
    const result = tail.then(() => work(tx))
    tail = result.catch(() => undefined)
    return result
  })
  const store = {
    one: async (query: Promise<unknown[]>) => (await query)[0],
    db: { ...tx, transaction },
  } as unknown as Store
  const identity = new Identity(store)
  const mail = { sendActivation: jest.fn().mockResolvedValue(undefined) }
  const auth = new AuthService(identity, mail as unknown as MailService)
  return { user, identity, auth, mail, insert, getActivation: () => activation }
}

beforeEach(() => {
  process.env.SMTP_HOST = 'smtp.example.com'
  process.env.SMTP_USER = 'sender@example.com'
  process.env.SMTP_PASSWORD = 'test-password'
})
afterEach(() => jest.restoreAllMocks())

test('未激活账号凭据正确也不能建立会话，存量已验证账号仍可登录', async () => {
  const s = setup()
  await expect(s.identity.login(s.user.email, 'password-123456')).rejects.toThrow('请先激活邮箱')
  expect(s.insert).not.toHaveBeenCalled()
  s.user.emailVerified = true
  await expect(s.identity.login(s.user.email, 'password-123456')).resolves.toHaveProperty('raw')
})

test('重发仅保存摘要，24 小时有效；60 秒内不允许并发重复发送', async () => {
  const s = setup()
  const results = await Promise.allSettled([
    s.auth.resendActivation(s.user.email, 'password-123456'),
    s.auth.resendActivation(s.user.email, 'password-123456'),
  ])
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(s.mail.sendActivation).toHaveBeenCalledTimes(1)
  const token = s.mail.sendActivation.mock.calls[0][1] as string
  expect(s.getActivation()?.tokenHash).toBe(hash(token))
  expect(s.getActivation()?.tokenHash).not.toBe(token)
  expect(s.getActivation()!.expiresAt.getTime() - s.getActivation()!.sentAt.getTime()).toBe(
    86400000,
  )
})

test('有效激活令牌原子消费，并发重复激活只有一次成功', async () => {
  const s = setup()
  await s.auth.resendActivation(s.user.email, 'password-123456')
  const token = s.mail.sendActivation.mock.calls[0][1] as string
  const results = await Promise.allSettled([
    s.auth.activateEmail(token),
    s.auth.activateEmail(token),
  ])
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(s.user.emailVerified).toBe(true)
  expect(s.getActivation()).toBeUndefined()
})

test('过期或重发前的旧令牌无法激活，新链接仍可用', async () => {
  const s = setup()
  await s.auth.resendActivation(s.user.email, 'password-123456')
  const old = s.mail.sendActivation.mock.calls[0][1] as string
  s.getActivation()!.expiresAt = new Date(Date.now() - 1)
  await expect(s.auth.activateEmail(old)).rejects.toThrow('无效或已过期')
  s.getActivation()!.sentAt = new Date(Date.now() - 61000)
  await s.auth.resendActivation(s.user.email, 'password-123456')
  await expect(s.auth.activateEmail(old)).rejects.toThrow('无效或已过期')
  await expect(
    s.auth.activateEmail(s.mail.sendActivation.mock.calls[1][1] as string),
  ).resolves.toEqual({ ok: true })
})

test('SMTP 失败后保留账号与记录，可在冷却结束后恢复', async () => {
  const s = setup()
  s.mail.sendActivation.mockRejectedValueOnce(new Error('SMTP failure'))
  await expect(s.auth.resendActivation(s.user.email, 'password-123456')).rejects.toThrow('发送失败')
  expect(s.user.emailVerified).toBe(false)
  s.getActivation()!.sentAt = new Date(Date.now() - 61000)
  await expect(s.auth.resendActivation(s.user.email, 'password-123456')).resolves.toEqual({
    ok: true,
  })
})

test('激活不会解除管理员禁用，密码错误或禁用账号不能重发', async () => {
  const s = setup()
  await expect(s.auth.resendActivation(s.user.email, 'wrong')).rejects.toThrow('邮箱或密码错误')
  await s.auth.resendActivation(s.user.email, 'password-123456')
  s.user.status = 'disabled'
  await s.auth.activateEmail(s.mail.sendActivation.mock.calls[0][1] as string)
  expect(s.user.status).toBe('disabled')
  await expect(s.auth.resendActivation(s.user.email, 'password-123456')).rejects.toThrow('已禁用')
})

test('公开注册显式创建未验证账号，注册邮件投递失败返回可恢复业务码', async () => {
  const values = jest.fn().mockResolvedValue(undefined)
  const identity = new Identity({ db: { insert: () => ({ values }) } } as unknown as Store)
  const created = await identity.register('New@Example.com', 'password-123456')
  expect(created.emailVerified).toBe(false)
  expect(values).toHaveBeenCalledWith(
    expect.objectContaining({ email: 'new@example.com', emailVerified: false, role: 'user' }),
  )
  const s = setup()
  s.user.id = created.id
  jest.spyOn(s.identity, 'register').mockResolvedValue(created)
  s.mail.sendActivation.mockRejectedValueOnce(new Error('SMTP unavailable'))
  await expect(s.auth.register('new@example.com', 'password-123456')).rejects.toMatchObject({
    response: expect.objectContaining({ code: 'ACCOUNT_ACTIVATION_SEND_FAILED', retryAfter: 60 }),
  })
})
