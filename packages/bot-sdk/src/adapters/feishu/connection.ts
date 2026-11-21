import { createLarkChannel, type PolicyConfig } from '@larksuite/channel'
import type { BotAdapter, Conversation } from '../../core/index.js'

/** 国内飞书应用机器人配置。 */
export interface FeishuOptions {
  /** 在 BotManager 内使用的名字，默认 feishu。 */
  id?: string
  /** 飞书应用 App ID。 */
  appId: string
  /** 飞书应用 App Secret。 */
  appSecret: string
  /** 可选平台消息策略，如群白名单、是否要求提及；默认交付私聊及可接收的群消息。 */
  messagePolicy?: PolicyConfig
}

/** 平台连接的认证、基础接口及资源由实例管理。 */
export class FeishuConnection implements BotAdapter {
  /** SDK 内唯一的机器人实例标识。 */
  readonly id: string
  /** @internal SDK 客户端，由已安装能力使用。 */
  readonly channel: ReturnType<typeof createLarkChannel>
  private unsubscribe?: () => void

  /** 初始化连接所需的客户端及凭证。 */
  constructor({ id = 'feishu', appId, appSecret, messagePolicy }: FeishuOptions) {
    this.id = id
    this.channel = createLarkChannel({
      appId,
      appSecret,
      transport: 'websocket',
      policy: { dmMode: 'open', requireMention: false, ...messagePolicy },
      safety: { chatQueue: { cardActions: 'separate' } },
      logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    })
  }

  /** 建立并确认平台连接。 */
  async start(report: (error: Error) => void) {
    this.unsubscribe = this.channel.on({ error: () => report(new Error('飞书连接或事件处理失败')) })
    await this.channel.connect()
  }
  /** 断开连接并取消本连接的错误订阅。 */
  async stop() {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    await this.channel.disconnect()
  }

  /** @internal 将明确的私聊或群聊目标转换为飞书支持的 ID。 */
  recipient(to: Conversation) {
    if (to.type === 'group') {
      if (!to.chatId.startsWith('oc_')) throw new Error('飞书群聊目标必须是 chat_id')
      return to.chatId
    }
    if (!to.userId.startsWith('ou_')) throw new Error('飞书私聊目标必须是用户 open_id')
    return to.userId
  }
}
