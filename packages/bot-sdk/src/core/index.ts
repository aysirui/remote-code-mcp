/** 单聊目标；用户标识在指定机器人实例及其平台身份范围内使用。 */
export interface Conversation {
  /** SDK 内唯一的机器人实例标识。 */
  readonly botId: string
  /** 平台用户标识，不是应用账号 ID。 */
  readonly userId: string
}

/** 本 Bot 返回的卡片引用；更新需传回原对象。 */
export interface CardRef extends Conversation {
  /** 平台消息 ID 或适配器生成的投放 ID。 */
  readonly cardId: string
}

/** 平台无关的卡片内容。 */
export interface Card {
  /** 卡片标题。 */
  title: string
  /** 卡片正文；只传允许向接收者披露的内容。 */
  body: string
  /** 原生按钮；空数组表示不可操作的状态卡。 */
  buttons: readonly {
    /** 业务动作标识，在同一张卡内唯一。 */
    id: string
    /** 用户可见的按钮名称。 */
    label: string
    /** 支持样式的平台可区分主要按钮与次要按钮；省略时使用平台默认样式。 */
    style?: 'primary' | 'secondary'
  }[]
}

/** 单聊文字及其发送方。 */
export interface TextEvent {
  /** 发送者的私聊目标，可直接用于回复。 */
  conversation: Conversation
  /** 平台入站消息 ID，可用于应用排重。 */
  messageId: string
  /** 消息纯文本。 */
  text: string
}

/** 原生按钮点击；平台身份不能替代应用授权。 */
export interface ActionEvent {
  /** 发卡的机器人实例。 */
  botId: string
  /** 平台确认的点击者标识。 */
  actorId: string
  /** 卡片标识，与发送结果对应。 */
  cardId: string
  /** 被点击按钮的业务标识。 */
  actionId: string
}

/** 点击回调响应；仅支持回调内更新的平台可使用。 */
export interface ActionResponse {
  /** 在本次点击回调内替换原卡。 */
  card: Card
}

/** 适配器向应用交付事件的接口。 */
export interface AdapterEvents {
  /** 交付单聊文字。 */
  message(event: TextEvent): Promise<void>
  /** 交付按钮点击，返回可选原卡替换。 */
  action(event: ActionEvent): Promise<ActionResponse | void>
  /** 汇报异步错误；不要包含凭证或消息正文。 */
  error(error: Error): void
}

/** 平台适配器契约；每个实例独立管理连接及凭证。 */
export interface BotAdapter {
  /** 应用分配的唯一机器人实例标识。 */
  readonly id: string
  /** 是否支持在点击回调内替换卡片。 */
  readonly callbackCardUpdate: boolean
  /** 注册事件并建立连接；认证成功后返回。 */
  start(events: AdapterEvents): Promise<void>
  /** 清理监听并关闭连接；部分启动失败时也可调用。 */
  stop(): Promise<void>
  /** 向平台用户主动发送文字。 */
  sendText(userId: string, text: string): Promise<void>
  /** 向平台用户主动发卡，返回用于关联点击和更新的 ID。 */
  sendCard(userId: string, card: Card): Promise<string>
  /** 可选：不依赖点击，更新已投放的卡片。 */
  updateCard?(ref: CardRef, card: Card): Promise<void>
}

/** 创建 Bot 所需的适配器与可选错误回调。 */
export interface BotOptions {
  /** 机器人实例 ID 不得重复。 */
  adapters: readonly BotAdapter[]
  /** 接收不含凭证及消息正文的异步错误。 */
  onError?: (botId: string, error: Error) => void
}

/** 上层使用的统一机器人 API。 */
export interface Bot {
  /** 建立连接；部分启动失败时关闭已尝试的连接。 */
  start(): Promise<void>
  /** 关闭所有连接，返回后可再次启动。 */
  stop(): Promise<void>
  /** 订阅文字；返回取消订阅函数。 */
  onMessage(handler: (event: TextEvent) => void | Promise<void>): () => void
  /** 注册唯一按钮处理器；返回取消订阅函数。 */
  onAction(
    handler: (event: ActionEvent) => ActionResponse | void | Promise<ActionResponse | void>,
  ): () => void
  /** 查询指定机器人的主动更新和点击回调内更新能力。 */
  capabilities(botId: string): { proactiveCardUpdate: boolean; callbackCardUpdate: boolean }
  /** 向目标用户主动发送文字。 */
  sendText(to: Conversation, text: string): Promise<void>
  /** 向目标用户主动发卡，返回卡片引用。 */
  sendCard(to: Conversation, card: Card): Promise<CardRef>
  /** 更新本 Bot 发出的卡片；能力不足或引用不匹配时拒绝。 */
  updateCard(ref: CardRef, card: Card): Promise<void>
}

/** 创建统一 Bot；平台连接由显式注入的适配器提供。 */
export function createBot({ adapters, onError }: BotOptions): Bot {
  type ActionHandler = Parameters<Bot['onAction']>[0]
  const instances = new Map<string, BotAdapter>()
  const issuedCards = new WeakSet<CardRef>()
  const messages = new Set<Parameters<Bot['onMessage']>[0]>()
  let actionHandler: ActionHandler | undefined
  let lifecycle = Promise.resolve()
  let running = false

  for (const adapter of adapters) {
    if (!adapter.id || instances.has(adapter.id)) throw new Error('机器人实例 ID 为空或重复')
    instances.set(adapter.id, adapter)
  }

  /** 查找实例；发送只在 Bot 完成启动后开放。 */
  function instance(botId: string, requireRunning = true) {
    const adapter = instances.get(botId)
    if (!adapter) throw new Error('机器人实例不存在')
    if (requireRunning && !running) throw new Error('机器人尚未启动')
    return adapter
  }

  /** 串行化启停，避免连接建立与关闭交错。 */
  function transition(task: () => Promise<void>) {
    const result = lifecycle.then(task)
    lifecycle = result.catch(() => undefined)
    return result
  }

  return {
    start: () =>
      transition(async () => {
        if (running) return
        const attempted: BotAdapter[] = []
        try {
          for (const adapter of instances.values()) {
            attempted.push(adapter)
            await adapter.start({
              async message(event) {
                if (!running || event.conversation.botId !== adapter.id) return
                for (const handler of messages) await handler(event)
              },
              async action(event) {
                if (!running || event.botId !== adapter.id) return
                const response = await actionHandler?.(event)
                if (response && !adapter.callbackCardUpdate)
                  throw new Error('此机器人不支持在点击回调内更新卡片')
                return response
              },
              error: (error) => onError?.(adapter.id, error),
            })
          }
          running = true
        } catch (error) {
          await Promise.allSettled(attempted.map(async (adapter) => adapter.stop()))
          throw error
        }
      }),
    stop: () =>
      transition(async () => {
        if (!running) return
        running = false
        const results = await Promise.allSettled(
          [...instances.values()].map(async (adapter) => adapter.stop()),
        )
        const failed = results.find((result) => result.status === 'rejected')
        if (failed) throw failed.reason
      }),
    onMessage(handler) {
      messages.add(handler)
      return () => {
        messages.delete(handler)
      }
    },
    onAction(handler) {
      if (actionHandler) throw new Error('按钮处理器已注册')
      actionHandler = handler
      return () => {
        if (actionHandler === handler) actionHandler = undefined
      }
    },
    capabilities(botId) {
      const adapter = instance(botId, false)
      return {
        proactiveCardUpdate: Boolean(adapter.updateCard),
        callbackCardUpdate: adapter.callbackCardUpdate,
      }
    },
    async sendText({ botId, userId }, text) {
      await instance(botId).sendText(userId, text)
    },
    async sendCard({ botId, userId }, card) {
      const cardId = await instance(botId).sendCard(userId, card)
      const ref = Object.freeze({ botId, userId, cardId })
      issuedCards.add(ref)
      return ref
    },
    async updateCard(ref, card) {
      if (!issuedCards.has(ref)) throw new Error('卡片引用不属于当前 Bot')
      const adapter = instance(ref.botId)
      if (!adapter.updateCard) throw new Error('此机器人不支持主动更新卡片')
      await adapter.updateCard(ref, card)
    },
  }
}
