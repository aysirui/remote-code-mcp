import type { WecomCardOptions } from './cards.js'
import { WSClient } from '@wecom/aibot-node-sdk'
import type { BotAdapter } from '../../core/index.js'
/** 企业微信智能机器人长连接配置，不是自建应用凭证。 */
export interface WecomOptions {
  /** 在 BotManager 内使用的名字，默认 wecom。 */
  id?: string
  /** 智能机器人的 Bot ID。 */
  botId: string
  /** 智能机器人的长连接 Secret。 */
  secret: string
  /** 默认卡片渲染配置；业务发卡无需传入平台字段。 */
  cards?: WecomCardOptions
  /** 本地调试时接收固定阶段提示和企微数字错误码，不输出回调或卡片内容。 */
  onDiagnostic?: (message: string) => void
}

/** 官方 SDK 拒绝时可能返回回执帧；仅提取数字错误码，避免记录响应正文。 */
export function describeFailure(stage: string, error: unknown): string {
  const code = error && typeof error === 'object' && 'errcode' in error ? error.errcode : undefined
  return typeof code === 'number' && Number.isInteger(code) ? `${stage}（errcode=${code}）` : stage
}

/** 平台连接的认证、基础接口及资源由实例管理。 */
export class WecomConnection implements BotAdapter {
  /** SDK 内唯一的机器人实例标识。 */
  readonly id: string
  /** @internal 平台能力共用的客户端。 */
  readonly client: WSClient
  /** @internal 校验入站事件的机器人身份。 */
  readonly botId: string
  /** @internal 记录固定诊断信息。 */
  readonly onDiagnostic?: WecomOptions['onDiagnostic']
  /** 原生平台客户端；统一 API 不覆盖的操作可直接使用，启停仍由 Bot 管理。 */
  get native() {
    return this.client
  }
  private connectionError?: () => void

  /** 初始化连接所需的客户端及凭证。 */
  constructor({ id = 'wecom', botId, secret, onDiagnostic }: WecomOptions) {
    this.id = id
    this.botId = botId
    this.onDiagnostic = onDiagnostic
    this.client = new WSClient({
      botId,
      secret,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    })
  }

  /** 建立并确认平台连接。 */
  async start(report: (error: Error) => void) {
    const { client, onDiagnostic } = this
    client.on('error', (this.connectionError = () => report(new Error('企微连接失败'))))
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => failed(), 15_000)
      /** 认证结束后取消启动监听及计时器，不影响 SDK 的重连。 */
      function cleanup() {
        clearTimeout(timeout)
        client.off('authenticated', authenticated)
        client.off('error', failed)
      }
      /** 认证成功后才允许发送。 */
      function authenticated() {
        cleanup()
        onDiagnostic?.('企微长连接认证成功')
        resolve()
      }
      /** 认证失败或超时时结束启动，外层负责关闭连接。 */
      function failed() {
        cleanup()
        reject(new Error('企微机器人未能完成认证'))
      }
      client.once('authenticated', authenticated)
      client.once('error', failed)
      try {
        client.connect()
      } catch {
        failed()
      }
    })
  }
  /** 关闭连接并移除本连接的错误监听。 */
  async stop() {
    this.client.disconnect()
    if (this.connectionError) this.client.off('error', this.connectionError)
    this.connectionError = undefined
  }
}
