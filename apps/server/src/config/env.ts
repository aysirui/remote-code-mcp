import dotenv from 'dotenv'
import path from 'node:path'

// src 与 dist 位于同一级，源码和构建产物均不依赖启动时的工作目录。
const envFiles = [
  path.resolve(__dirname, '../../.env'),
  path.resolve(__dirname, '../../../../.env'),
]

/** 自定义 OAuth 深链的协议、主机和路径范围。 */
export interface OAuthRedirectRule {
  scheme: string
  hostname: string
  pathPrefix: string
}

/** SMTP 发送配置，服务启动、注册和重发时校验完整性。 */
export interface MailConfig {
  /** 邮件服务器主机名。 */
  host: string
  /** SMTP 端口，默认 587。 */
  port: number
  /** 认证账号，通常为完整邮箱地址。 */
  user: string
  /** SMTP 密码或服务商授权码，不得输出日志。 */
  password: string
  /** 服务商允许的发件地址，默认使用认证账号。 */
  from: string
  /** true 使用隐式 TLS；false 必须升级 STARTTLS。 */
  secure: boolean
}

/** 统一配置入口：进程环境变量 > Server 本地 .env > 仓库根目录 .env > 默认值。 */
export class Env {
  constructor(
    private readonly source: NodeJS.ProcessEnv = process.env,
    files: string[] = envFiles,
  ) {
    dotenv.config({ path: files, processEnv: source, override: false, quiet: true })
  }

  /** Schema 生成不需要数据库连接，因此允许按需读取可选连接地址。 */
  get optionalDatabaseUrl(): string | undefined {
    return this.source.DATABASE_URL || undefined
  }

  /** 运行服务和执行数据库迁移时，数据库连接地址必须存在。 */
  get databaseUrl(): string {
    const value = this.optionalDatabaseUrl
    if (!value) throw new Error('必须配置 DATABASE_URL')
    return value
  }

  get appSecret(): string {
    const value = this.source.APP_SECRET
    if (!value || value.length < 32) throw new Error('APP_SECRET 必须至少包含 32 个字符')
    return value
  }

  get publicUrl(): string {
    return this.source.PUBLIC_URL || 'http://localhost:3000'
  }

  get consoleUrl(): string {
    return this.source.CONSOLE_URL || 'http://localhost:5173'
  }

  /** Server 可请求的附件 HTTPS 源，逗号分隔；默认不信任任何远程源。 */
  get mcpAttachmentOrigins(): string[] {
    return (this.source.MCP_ATTACHMENT_ORIGINS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => {
        const url = URL.canParse(value) ? new URL(value) : undefined
        if (!url || url.protocol !== 'https:' || url.href !== url.origin + '/')
          throw new Error('MCP_ATTACHMENT_ORIGINS 只能配置不含凭据、路径或参数的 HTTPS 源')
        return url.origin
      })
  }

  /** 公开官网首页，供企微结果卡跳转；未单独配置时与 Compose 一样使用 PUBLIC_URL 的根路径。 */
  get websiteUrl(): string {
    return new URL('/', this.source.WEBSITE_URL || this.publicUrl).href
  }

  /** 内置 WorkBuddy 深链规则与部署者追加的 JSON 规则；错误配置阻止启动。 */
  get oauthCustomRedirectRules(): OAuthRedirectRule[] {
    const extra: unknown = JSON.parse(this.source.OAUTH_CUSTOM_REDIRECT_RULES || '[]')
    if (
      !Array.isArray(extra) ||
      !extra.every(
        (r) =>
          r &&
          typeof r.scheme === 'string' &&
          /^[a-z][a-z0-9+.-]*$/.test(r.scheme) &&
          ![
            'http',
            'https',
            'file',
            'ftp',
            'javascript',
            'data',
            'blob',
            'about',
            'chrome',
            'edge',
            'mailto',
            'tel',
            'intent',
            'ws',
            'wss',
          ].includes(r.scheme) &&
          typeof r.hostname === 'string' &&
          /^[a-z0-9.-]+$/.test(r.hostname) &&
          typeof r.pathPrefix === 'string' &&
          /^\/[a-zA-Z0-9/_.~-]*\/$/.test(r.pathPrefix),
      )
    )
      throw new Error('OAUTH_CUSTOM_REDIRECT_RULES 必须为合法的深链规则数组')
    return [{ scheme: 'workbuddy', hostname: 'workbuddy', pathPrefix: '/mcp/' }, ...extra]
  }

  /** 可选飞书企业自建应用；凭证不下发到 Console 或 Runtime。 */
  get feishuApproval() {
    const appId = this.source.FEISHU_APP_ID
    const appSecret = this.source.FEISHU_APP_SECRET
    const botLink = this.source.FEISHU_BOT_LINK
    if (!appId || !appSecret || !botLink) return undefined
    const url = new URL(botLink)
    if (
      url.protocol !== 'https:' ||
      !['applink.feishu.cn', 'open.feishu.cn'].includes(url.hostname) ||
      url.username ||
      url.password
    )
      throw new Error('FEISHU_BOT_LINK 必须是飞书官方 HTTPS 链接')
    return { appId, appSecret, botLink: url.href }
  }

  /** 可选企业微信智能机器人配置；缺少必要项时不启用。 */
  get wecomApproval() {
    const botId = this.source.WECOM_BOT_ID
    const secret = this.source.WECOM_SECRET
    const botLink = this.source.WECOM_BOT_LINK
    if (!botId || !secret) return undefined
    return {
      botId,
      secret,
      botLink: botLink ? this.approvalLink(botLink, ['work.weixin.qq.com']) : undefined,
    }
  }

  /** 可选钉钉企业内部应用配置；缺少必要项时不启用。 */
  get dingtalkApproval() {
    const clientId = this.source.DINGTALK_CLIENT_ID
    const clientSecret = this.source.DINGTALK_CLIENT_SECRET
    const corpId = this.source.DINGTALK_CORP_ID
    const cardTemplateId = this.source.DINGTALK_CARD_TEMPLATE_ID
    const robotCode = this.source.DINGTALK_ROBOT_CODE || clientId
    const botLink = this.source.DINGTALK_BOT_LINK
    if (!clientId || !clientSecret || !corpId || !cardTemplateId) return undefined
    return {
      clientId,
      clientSecret,
      corpId,
      cardTemplateId,
      robotCode,
      botLink: botLink ? this.approvalLink(botLink, ['dingtalk.com']) : undefined,
    }
  }

  /** 可选私聊链接仅允许所属平台的 HTTPS 域名，不允许链接内嵌凭据。 */
  private approvalLink(value: string, domains: string[]) {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !domains.some((domain) => url.hostname === domain || url.hostname.endsWith('.' + domain))
    )
      throw new Error('机器人分享链接必须使用所属平台的官方 HTTPS 域名')
    return url.href
  }

  get adminEmail(): string {
    return (this.source.ADMIN_EMAIL || '').trim().toLowerCase()
  }

  get port(): number {
    const value = Number(this.source.PORT || 3000)
    if (!Number.isInteger(value) || value < 1 || value > 65535)
      throw new Error('PORT 必须是 1 到 65535 之间的整数')
    return value
  }

  /** SMTP 配置：465 使用直接 TLS，其他端口强制 STARTTLS；启动时及发送前校验。 */
  get mail(): MailConfig {
    const host = this.source.SMTP_HOST || ''
    const user = this.source.SMTP_USER || ''
    const password = this.source.SMTP_PASSWORD || ''
    const from = this.source.MAIL_FROM || user
    const port = Number(this.source.SMTP_PORT || 587)
    const secureValue = this.source.SMTP_SECURE || (port === 465 ? 'true' : 'false')
    if (!host || !user || !password || !from)
      throw new Error('必须配置 SMTP_HOST、SMTP_USER、SMTP_PASSWORD 和发件地址')
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('SMTP_PORT 必须为有效端口')
    if (!['true', 'false'].includes(secureValue))
      throw new Error('SMTP_SECURE 必须为 true 或 false')
    return { host, port, user, password, from, secure: secureValue === 'true' }
  }

  /** 启动时校验基础、邮件及可选的附件和集成配置；运维命令只校验所需配置。 */
  validateServer(): void {
    void this.databaseUrl
    void this.appSecret
    void this.port
    void this.mail
    void this.oauthCustomRedirectRules
    void this.mcpAttachmentOrigins
    void this.feishuApproval
    void this.wecomApproval
    void this.dingtalkApproval
  }
}

// 导入模块时同步加载，保证数据库连接等初始化操作能读取本地配置。
export const env = new Env()
