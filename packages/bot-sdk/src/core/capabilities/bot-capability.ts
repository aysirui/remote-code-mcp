import type { BotAdapter, Capability, CapabilityContext, Conversation } from '../contracts.js'
import { UnsupportedCapabilityError } from '../errors.js'

/** 文本、卡片等能力共享的连接归属校验。 */
export abstract class BotCapability<
  T extends { connection: BotAdapter; stop(): Promise<void> },
> implements Capability {
  abstract readonly id: string
  private adapter?: T
  private subscribed = false
  private owner?: CapabilityContext

  /** 解析当前连接为本能力提供的平台实现。 */
  constructor(private readonly resolve: (connection: BotAdapter) => T | undefined) {}

  /** 安装时校验能力使用的是当前机器人自己的连接。 */
  attach(context: CapabilityContext) {
    if (this.owner) throw new Error('能力已安装到 Bot')
    const adapter = this.resolve(context.adapter)
    if (adapter && adapter.connection !== context.adapter)
      throw new Error('能力的连接不属于当前 Bot')
    this.adapter = adapter
    this.owner = context
  }

  /** 登记本能力的监听，供平台连接启动。 */
  async start() {
    if (!this.adapter) return
    this.subscribed = true
    await this.subscribe(this.adapter)
  }

  /** 释放本能力登记的监听。 */
  async stop() {
    if (!this.subscribed) return
    this.subscribed = false
    await this.adapter?.stop()
  }

  /** 由具体能力声明接收的事件。 */
  protected abstract subscribe(adapter: T): Promise<void>

  /** 获取已安装能力所属的机器人环境。 */
  protected get context(): CapabilityContext {
    if (!this.owner) throw new Error('能力尚未安装')
    return this.owner
  }

  /** 查询当前连接对该能力的实现。 */
  protected getAdapter(): T | undefined {
    return this.adapter
  }

  /** 用户 ID 默认使用此连接，回调提供的会话也可直接用于回复。 */
  protected recipient(to: Conversation | string): Conversation {
    return typeof to === 'string' ? { botId: this.context.adapter.id, userId: to } : to
  }

  /** 出站操作要求当前机器人在线，且会话所属机器人与当前实例一致。 */
  protected requireAdapter(botId: string, operation: string): T {
    if (this.context.adapter.id !== botId) throw new Error('目标会话不属于当前 Bot')
    if (!this.context.running) throw new Error('机器人尚未启动')
    if (!this.adapter) throw new UnsupportedCapabilityError(operation)
    return this.adapter
  }
}
