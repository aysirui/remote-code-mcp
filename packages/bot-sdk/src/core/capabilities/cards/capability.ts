import type { Conversation } from '../../contracts.js'
import { BotPlatformError, UnsupportedCapabilityError } from '../../errors.js'
import { BotCapability } from '../bot-capability.js'
import type {
  ActionEvent,
  ActionResponse,
  Card,
  CardAdapter,
  CardOptions,
  CardConnection,
  CardClient,
  CardRef,
  CardSettleOptions,
  CardSettlement,
} from './contracts.js'
import { cardAdapter } from './contracts.js'

/** 可选的结果通知出口，应用可注入文本能力或自定义发送器。 */
export interface CardCapabilityOptions {
  /** 在请求补发结果时向原卡接收者发送正文。 */
  sendText?: (to: Conversation, text: string) => Promise<void>
}

/** 可独立安装的卡片能力，管理场景配置、投放引用和点击更新。 */
export class CardCapability extends BotCapability<CardAdapter> implements CardClient {
  /** 同一个 Bot 共用一个卡片引用和点击路由。 */
  readonly id = 'cards'
  private readonly issued = new WeakMap<CardRef, { binding?: CardOptions }>()
  private readonly optionsByCard = new Map<string, CardOptions>()
  private readonly pending = new Map<string, (response?: ActionResponse) => boolean>()
  private handler?: Parameters<CardClient['onAction']>[0]

  /** 为当前机器人安装卡片实现，可选注入结果发送器。 */
  constructor(private readonly options: CardCapabilityOptions = {}) {
    super((connection: CardConnection) => connection[cardAdapter]?.())
  }

  /** 为当前场景设置默认发卡选项，继续使用原来的机器人和回调。 */
  withOptions(options: CardOptions): CardClient {
    return {
      send: (to, card, override) => this.send(to, card, override ?? options),
      update: (ref, card) => this.update(ref, card),
      settle: (ref, card, options) => this.settle(ref, card, options),
      onAction: (handler) => this.onAction(handler),
    }
  }

  /** 查询当前机器人是否能主动更新原卡或通过点击回调更新原卡。 */
  capabilities() {
    const adapter = this.getAdapter()
    return {
      proactiveCardUpdate: Boolean(adapter?.update),
      callbackCardUpdate: Boolean(adapter?.callbackUpdate),
    }
  }

  /** 向目标用户发卡，预先登记模板配置供快速回调使用。 */
  async send(to: Conversation | string, card: Card, options?: CardOptions): Promise<CardRef> {
    const { botId, userId } = this.recipient(to)
    const adapter = this.requireAdapter(botId, 'cards.send')
    let registered: string | undefined
    try {
      const binding = adapter.prepareOptions ? adapter.prepareOptions(options) : options
      const register = (cardId: string) => {
        if (!binding) return
        registered = cardId
        this.optionsByCard.set(cardId, binding)
        if (this.optionsByCard.size > 10_000)
          this.optionsByCard.delete(this.optionsByCard.keys().next().value!)
      }
      const cardId = await adapter.send(userId, card, binding, register)
      if (!registered) register(cardId)
      const ref = Object.freeze({ botId, userId, cardId })
      this.issued.set(ref, { binding })
      return ref
    } catch (error) {
      if (registered) this.optionsByCard.delete(registered)
      this.context.error(error instanceof BotPlatformError ? error : new Error('卡片发送失败'))
      throw error
    }
  }

  /** 用原卡绑定主动更新，拒绝其他能力实例的引用。 */
  async update(ref: CardRef, card: Card) {
    const { binding } = this.requireIssued(ref)
    const adapter = this.requireAdapter(ref.botId, 'cards.update')
    if (!adapter.update) throw new UnsupportedCapabilityError('cards.update')
    await adapter.update(ref, card, binding)
  }

  /** 优先主动更新；回调渠道可使用等待中的点击窗口并按需补发结果。 */
  async settle(ref: CardRef, card: Card, options?: CardSettleOptions): Promise<CardSettlement> {
    this.requireIssued(ref)
    const adapter = this.requireAdapter(ref.botId, 'cards.settle')
    if (adapter.update) {
      await this.update(ref, card)
      return 'updated'
    }
    const handedOff = this.pending.get(ref.cardId)?.({ card })
    const text = await options?.resultText?.()
    if (text) {
      if (!this.options.sendText) throw new UnsupportedCapabilityError('text.send')
      await this.options.sendText(ref, text)
    }
    return handedOff ? 'callback' : 'unavailable'
  }

  /** 注册唯一的应用点击处理器，返回取消订阅函数。 */
  onAction(handler: Parameters<CardClient['onAction']>[0]): () => void {
    if (this.handler) throw new Error('按钮处理器已注册')
    this.handler = handler
    return () => {
      if (this.handler === handler) this.handler = undefined
    }
  }

  /** 释放本次启动的回调等待与平台监听。 */
  override async stop() {
    for (const complete of this.pending.values()) complete()
    await super.stop()
  }

  /** 连接事件交给卡片能力统一校验和处理。 */
  protected subscribe(adapter: CardAdapter) {
    return adapter.start({
      action: (event) => this.dispatch(adapter, event),
      cardOptions: (cardId) => this.optionsByCard.get(cardId),
      error: (error) => this.context.error(error),
    })
  }

  /** 回调预算从收到点击开始计时，只在应用授权后为该卡保留响应窗口。 */
  private async dispatch(adapter: CardAdapter, event: ActionEvent): Promise<ActionResponse | void> {
    if (!this.context.running || event.botId !== adapter.connection.id || !this.handler) return
    const waitMs = adapter.callbackUpdateWaitMs
    const key = event.cardId
    const deadline = Date.now() + (waitMs ?? 0)
    let waiting: Promise<ActionResponse | undefined> | undefined
    let cancel: (() => void) | undefined
    const deferCardUpdate = () => {
      if (waiting || this.pending.has(key) || !this.context.running || Date.now() >= deadline)
        return
      waiting = new Promise((resolve) => {
        const timer = setTimeout(() => complete(), deadline - Date.now())
        const complete = (response?: ActionResponse) => {
          clearTimeout(timer)
          this.pending.delete(key)
          const active = Date.now() < deadline
          resolve(active ? response : undefined)
          return active && Boolean(response)
        }
        this.pending.set(key, complete)
        // 已完成的回调不应取消同一张卡后续的点击。
        cancel = () => {
          if (this.pending.get(key) === complete) complete()
        }
      })
      return cancel
    }
    try {
      const response = await this.handler(
        adapter.callbackUpdate && waitMs && !adapter.update ? { ...event, deferCardUpdate } : event,
      )
      if (response && !adapter.callbackUpdate) throw new UnsupportedCapabilityError('cards.respond')
      if (response) return response
      return await waiting
    } finally {
      cancel?.()
    }
  }

  /** 验证引用来源并取得原卡场景配置。 */
  private requireIssued(ref: CardRef) {
    const issued = this.issued.get(ref)
    if (!issued) throw new Error('卡片引用不属于当前 Bot')
    return issued
  }
}
