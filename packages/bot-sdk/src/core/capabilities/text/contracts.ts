import type { BotAdapter, Conversation } from '../../contracts.js'

/** 平台为当前连接提供文本实现的扩展键。 */
export const textAdapter = Symbol('bot-sdk.text')

/** 提供文本能力的连接，工厂只在安装能力时调用。 */
export interface TextConnection extends BotAdapter {
  /** 为本连接创建文本适配器。 */
  [textAdapter]?: () => TextAdapter
}

/** 文字消息及所属会话；会话目标与实际发送者分别提供。 */
export interface TextEvent {
  /** 可直接用于回复的私聊或群聊目标。 */
  conversation: Conversation
  /** 实际发送者的平台用户标识；群聊中不能用群 ID 代替。 */
  actorId: string
  /** 平台入站消息 ID，可用于排重。 */
  messageId: string
  /** 消息纯文本。 */
  text: string
}

/** 文本适配器的事件出口。 */
export interface TextAdapterEvents {
  /** 交付平台允许机器人接收的文字，不在 SDK 中限定业务场景。 */
  message(event: TextEvent): Promise<void>
  /** 汇报不含正文和凭证的错误。 */
  error(error: Error): void
}

/** 文本能力所需的平台实现。 */
export interface TextAdapter {
  /** 文本收发共用的已注册连接。 */
  readonly connection: BotAdapter
  /** 在连接启动前订阅平台事件。 */
  start(events: TextAdapterEvents): Promise<void>
  /** 取消文本订阅。 */
  stop(): Promise<void>
  /** 向指定会话发送文字，群聊与私聊使用各平台对应接口。 */
  send(to: Conversation, text: string): Promise<void>
}
