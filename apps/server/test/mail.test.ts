import nodemailer from 'nodemailer'
import { MailService } from '../src/modules/mail/mail.service'
import { Env } from '../src/config/env'

jest.mock('nodemailer', () => ({ __esModule: true, default: { createTransport: jest.fn() } }))

test('SMTP 配置映射、收件人和中文激活邮件，不把令牌放入查询字符串', async () => {
  Object.assign(process.env, {
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '587',
    SMTP_SECURE: 'false',
    SMTP_USER: 'sender@example.com',
    SMTP_PASSWORD: 'password',
    CONSOLE_URL: 'https://console.example.com',
  })
  const sendMail = jest.fn().mockResolvedValue({ accepted: ['recipient@example.com'] })
  const close = jest.fn()
  ;(nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail, close })
  const mail = new MailService()
  await mail.sendActivation('recipient@example.com', 'private-token')
  expect(nodemailer.createTransport).toHaveBeenCalledWith(
    expect.objectContaining({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: 'sender@example.com', pass: 'password' },
    }),
  )
  const message = sendMail.mock.calls[0][0]
  expect(message.to).toBe('recipient@example.com')
  expect(message.text).toContain('24 小时')
  expect(message.text).toContain('https://console.example.com/activate-email#token=private-token')
  expect(message.html).toContain('激活账号')
  mail.onModuleDestroy()
  expect(close).toHaveBeenCalled()
})

test('SMTP 必填配置、端口与布尔值校验，465 默认使用 TLS', () => {
  const source = {
    SMTP_HOST: 'smtp.example.com',
    SMTP_USER: 'sender@example.com',
    SMTP_PASSWORD: 'password',
    SMTP_PORT: '465',
  }
  expect(new Env(source, []).mail).toMatchObject({
    port: 465,
    secure: true,
    from: source.SMTP_USER,
  })
  expect(() => new Env({}, []).mail).toThrow('SMTP_HOST')
  expect(() => new Env({ ...source, SMTP_PORT: '0' }, []).mail).toThrow('SMTP_PORT')
  expect(() => new Env({ ...source, SMTP_SECURE: 'yes' }, []).mail).toThrow('SMTP_SECURE')
})
