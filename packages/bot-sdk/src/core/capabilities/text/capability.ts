import type { Conversation } from '../../contracts.js'
import { BotCapability } from '../bot-capability.js'
import { textAdapter, type TextConnection, type TextAdapter, type TextEvent } from './contracts.js'

/** 可独立安装的私聊文本能力。 */
export class TextCapability extends BotCapability<TextAdapter> {
  /** 同一个 Bot 只安装一个文本路由。 */
  readonly id = 'text'
  private readonly handlers = new Set<(event: TextEvent) => void | Promise<void>>()

  /** 为当前机器人连接安装文本实现。 */
  constructor() {
    super((connection: TextConnection) => connection[textAdapter]?.())
  }

  /** 订阅单聊文字，返回取消订阅函数。 */
  onMessage(handler: (event: TextEvent) => void | Promise<void>): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  /** 发送文字，可传平台用户 ID 或入站会话。 */
  async send(to: Conversation | string, text: string) {
    const { botId, userId } = this.recipient(to)
    await this.requireAdapter(botId, 'text.send').send(userId, text)
  }

  /** 只交付来自当前连接的文字事件。 */
  protected subscribe(adapter: TextAdapter) {
    const { id } = adapter.connection
    return adapter.start({
      message: async (event) => {
        if (!this.context.running || event.conversation.botId !== id) return
        for (const handler of this.handlers) await handler(event)
      },
      error: (error) => this.context.error(error),
    })
  }
}
