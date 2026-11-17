import { Injectable, OnModuleDestroy } from '@nestjs/common'
import nodemailer from 'nodemailer'
import { env } from '../../config/env'

/** 复用 SMTP 发送器，不记录密码、邮件正文或激活链接。 */
@Injectable()
export class MailService implements OnModuleDestroy {
  private transporter?: ReturnType<typeof nodemailer.createTransport>

  /** 向指定邮箱发送账号激活链接；成功只代表 SMTP 接受投递。 */
  async sendActivation(email: string, token: string): Promise<void> {
    const config = env.mail
    this.transporter ??= nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      requireTLS: !config.secure,
      auth: { user: config.user, pass: config.password },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 10000,
    })
    const link = new URL('/activate-email', env.consoleUrl)
    link.hash = new URLSearchParams({ token }).toString()
    // URL 作为 HTML 属性时转义，避免配置中的特殊字符破坏邮件结构。
    const escaped = link.href
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
    const result = await this.transporter.sendMail({
      from: config.from,
      to: email,
      subject: '激活 Remote Code 账号',
      text: `请打开以下链接并点击“激活账号”，激活后才能登录。链接有效期为 24 小时。\n${link.href}\n如非本人操作，请忽略此邮件。`,
      html: `<p>请点击链接进入页面并确认激活，激活后才能登录。链接有效期为 24 小时。</p><p><a href="${escaped}">激活账号</a></p><p>如非本人操作，请忽略此邮件。</p>`,
    })
    if (!result.accepted.length) throw new Error('邮件服务器未接受收件人')
  }

  /** 应用关闭时释放 SMTP 连接资源。 */
  onModuleDestroy(): void {
    this.transporter?.close()
  }
}
