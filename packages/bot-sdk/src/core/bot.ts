import type {
  BotAdapter,
  Capability,
  CapabilityContext,
  Recipient,
  Conversation,
} from './contracts.js'
import { TextCapability } from './capabilities/text/capability.js'
import type { TextEvent } from './capabilities/text/contracts.js'
import { CardCapability } from './capabilities/cards/capability.js'
import type { Card, CardRef, ActionEvent } from './capabilities/cards/contracts.js'

/** 统一更新的结果：accepted 表示已交付平台回调，最终回执错误由 onError 报告。 */
export type CardUpdateResult = 'updated' | 'accepted' | 'unavailable'

/** 文字事件提供统一回复方法，自动使用原会话。 */
export interface MessageEvent extends TextEvent {
  /** 向当前私聊或群聊回复文字。 */
  reply(text: string): Promise<void>
}

/** 业务按钮事件隐藏平台的回调等待机制。 */
export interface CardActionEvent extends Omit<ActionEvent, 'deferCardUpdate'> {
  /** 使用 SDK 保存的原卡配置更新当前卡片；不能主动更新且回调已过期时返回 unavailable。 */
  update(card: Card): Promise<CardUpdateResult>
}

/** 各平台共用的高频文字 API。 */
export interface MessagesApi {
  /** 向用户或群发送纯文本。 */
  send(to: Recipient, text: string): Promise<void>
  /** 订阅文字并返回取消订阅函数；授权和是否回复由业务决定。 */
  onMessage(handler: (event: MessageEvent) => void | Promise<void>): () => void
}

/** 各平台共用的交互卡片 API，平台模板配置由 adapter 持有。 */
export interface CardsApi {
  /** 发送通用卡片并返回更新所需的引用。 */
  send(to: Recipient, card: Card): Promise<CardRef>
  /** 自动选择主动更新或当前有效的按钮回调；不会隐式补发消息。 */
  update(ref: CardRef, card: Card): Promise<CardUpdateResult>
  /** 订阅按钮；可同时由多个业务模块订阅，各自核验卡片和点击者。 */
  onAction(handler: (event: CardActionEvent) => void | Promise<void>): () => void
}

/** 单个机器人的连接配置和诊断回调。 */
export interface BotOptions<A extends BotAdapter = BotAdapter> {
  /** 该机器人使用的平台连接。 */
  adapter: A
  /** 记录平台或能力报告的异步错误。 */
  onError?: (error: Error) => void
}

/** 管理一条平台连接和安装在该连接上的能力。 */
export class Bot<A extends BotAdapter = BotAdapter> {
  /** 机器人在 BotManager 内使用的名字。 */
  readonly id: string
  private readonly capabilities = new Map<string, Capability>()
  private readonly actionHandlers = new Set<(event: CardActionEvent) => void | Promise<void>>()
  private cardsApi?: CardsApi
  private messagesApi?: MessagesApi
  private readonly context: CapabilityContext
  private lifecycle = Promise.resolve()
  private transitions = 0
  private running = false

  /** 创建 Bot，自动提供常用消息与卡片 API，连接在 start 时打开。 */
  constructor(private readonly options: BotOptions<A>) {
    const { adapter, onError } = options
    if (!adapter.id) throw new Error('机器人 ID 不能为空')
    this.id = adapter.id
    const isRunning = () => this.running
    this.context = Object.freeze({
      adapter,
      get running() {
        return isRunning()
      },
      error(error: Error) {
        onError?.(error)
      },
    })
  }

  /** 原生客户端保留具体平台类型；与统一 API 共用同一连接，由 Bot 负责启停。 */
  get native(): A['native'] {
    return this.options.adapter.native
  }

  /** 常用文字能力自动装配，调用方无需 install。 */
  get messages(): MessagesApi {
    if (!this.messagesApi) {
      const text = this.standardText()
      this.messagesApi = {
        send: (to, content) => text.send(this.recipient(to), content),
        onMessage: (handler) =>
          text.onMessage((event) =>
            handler({
              ...event,
              reply: (content) => text.send(event.conversation, content),
            }),
          ),
      }
    }
    return this.messagesApi
  }

  /** 常用卡片能力自动装配，平台差异留在适配器和内部能力实现中。 */
  get cards(): CardsApi {
    if (!this.cardsApi) {
      const cards = this.standardCards()
      const update = async (ref: CardRef, card: Card): Promise<CardUpdateResult> => {
        const result = await cards.settle(ref, card)
        return result === 'callback' ? 'accepted' : result
      }
      cards.onAction(async (event) => {
        if (!this.actionHandlers.size) return
        // 在交付业务事件前保留平台允许的更新窗口，业务无需识别回调或主动更新渠道。
        const cancel = event.deferCardUpdate?.()
        const { deferCardUpdate: _, ...action } = event
        try {
          for (const handler of this.actionHandlers)
            await handler({
              ...action,
              update: (card) => update(cards.reference(event.cardId), card),
            })
        } catch (error) {
          cancel?.()
          throw error
        }
      })
      this.cardsApi = {
        send: (to, card) => cards.send(this.recipient(to), card),
        update,
        onAction: (handler) => {
          this.actionHandlers.add(handler)
          return () => {
            this.actionHandlers.delete(handler)
          }
        },
      }
    }
    return this.cardsApi
  }

  /** 当前 Bot 已确定路由，普通调用不用重复提供 botId；显式跨 Bot 目标仍由能力拒绝。 */
  private recipient(to: Recipient): Conversation | string {
    return typeof to === 'string' ? to : { botId: this.id, ...to }
  }

  /** 复用已安装的底层文本实现，仅供扩展机制与默认 API 共用。 */
  private standardText(): TextCapability {
    return (this.capabilities.get('text') as TextCapability) ?? this.install(new TextCapability())
  }

  /** 复用已安装的底层卡片实现，避免重复注册平台监听。 */
  private standardCards(): CardCapability {
    return (this.capabilities.get('cards') as CardCapability) ?? this.install(new CardCapability())
  }

  /** 查询本次启动是否已完成。 */
  isConnected(): boolean {
    return this.running
  }

  /** 在停止状态安装能力，返回用于发送和订阅的实例。 */
  install<T extends Capability>(capability: T): T {
    this.prepareInstall(capability)()
    return capability
  }

  /** @internal 先绑定能力，待整批校验通过后再登记。 */
  prepareInstall(capability: Capability): () => void {
    if (this.running || this.transitions) throw new Error('请在启动前安装能力')
    if (!capability.id || this.capabilities.has(capability.id))
      throw new Error('能力 ID 为空或重复')
    capability.attach(this.context)
    return () => {
      this.capabilities.set(capability.id, capability)
    }
  }

  /** 登记能力监听并打开连接，认证失败时回收本次启动的资源。 */
  start(): Promise<void> {
    this.standardText()
    this.standardCards()
    return this.transition(async () => {
      if (this.running) return
      const started: Capability[] = []
      let opening = false
      try {
        for (const capability of this.capabilities.values()) {
          started.push(capability)
          await capability.start()
        }
        opening = true
        await this.context.adapter.start(this.context.error)
        this.running = true
      } catch (error) {
        if (opening) await Promise.allSettled([this.closeConnection()])
        await Promise.allSettled(started.map(async (capability) => capability.stop()))
        throw error
      }
    })
  }

  /** 先关闭平台连接，再释放所有能力监听。 */
  stop(): Promise<void> {
    return this.transition(async () => {
      if (!this.running) return
      this.running = false
      const connection = await Promise.allSettled([this.closeConnection()])
      const capabilities = await Promise.allSettled(
        [...this.capabilities.values()].map(async (capability) => capability.stop()),
      )
      const failure = [...connection, ...capabilities].find(
        (result) => result.status === 'rejected',
      )
      if (failure) throw failure.reason
    })
  }

  /** 统一把同步和异步关闭异常交给启停流程收集。 */
  private async closeConnection() {
    await this.context.adapter.stop()
  }

  /** 串行化同一连接的启停。 */
  private transition(task: () => Promise<void>) {
    this.transitions++
    const result = this.lifecycle.then(task).finally(() => {
      this.transitions--
    })
    this.lifecycle = result.catch(() => undefined)
    return result
  }
}

/** 创建一个平台机器人。 */
export function createBot<A extends BotAdapter>(options: BotOptions<A>): Bot<A> {
  return new Bot(options)
}
