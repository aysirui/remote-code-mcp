/** 平台会话仅在指定机器人连接内使用；群 ID 与用户 ID 明确区分。 */
export type Conversation = {
  /** 已注册的机器人实例 ID。 */
  readonly botId: string
} & (
  | {
      /** 私聊类型；省略时保持原有用户目标写法。 */
      readonly type?: 'private'
      /** 平台用户标识。 */
      readonly userId: string
    }
  | {
      /** 群聊目标必须显式声明，不能把群 ID 当作用户 ID。 */
      readonly type: 'group'
      /** 平台群会话标识，如飞书 chat_id、企微 chatid、钉钉 openConversationId。 */
      readonly chatId: string
    }
)

/** 当前 Bot 内的发送目标；无需重复填写机器人 ID，入站 Conversation 也可直接传入。 */
export type Recipient =
  | string
  | Conversation
  | {
      /** 省略类型时表示私聊。 */
      readonly type?: 'private'
      /** 当前平台用户标识。 */
      readonly userId: string
    }
  | {
      /** 群聊须显式指定类型。 */
      readonly type: 'group'
      /** 当前平台群会话标识。 */
      readonly chatId: string
    }

/** 平台连接的生命周期，不依赖任何业务能力。 */
export interface BotAdapter {
  /** 连接所属的机器人实例 ID。 */
  readonly id: string
  /** 适配器持有的原生客户端；自定义适配器可以不提供。 */
  readonly native?: unknown
  /** 建立并认证连接，可向 Bot 汇报不含业务内容的诊断。 */
  start(report: (error: Error) => void): Promise<void>
  /** 释放平台连接；部分启动失败后也应允许关闭。 */
  stop(): Promise<void>
}

/** Bot 向能力提供的基础运行环境。 */
export interface CapabilityContext {
  /** Bot 是否正在运行。 */
  readonly running: boolean
  /** 此 Bot 管理的唯一平台连接。 */
  readonly adapter: BotAdapter
  /** 汇报不含业务正文和凭证的错误。 */
  error(error: Error): void
}

/** 可独立安装的能力，启动时先注册监听，再由 Bot 建立连接。 */
export interface Capability {
  /** 用于防止同一种能力重复安装。 */
  readonly id: string
  /** 保存所属 Bot 的运行环境，平台监听和外部资源由 start 启动。 */
  attach(context: CapabilityContext): void
  /** 在连接启动前登记监听。 */
  start(): Promise<void>
  /** 连接关闭后清理监听和本次启动产生的状态。 */
  stop(): Promise<void>
}
