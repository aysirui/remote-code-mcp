import type { Bot } from './bot.js'
import type { Capability } from './contracts.js'

/** 多机器人进程的启停配置。 */
export interface BotManagerOptions {
  /** 将要统一管理的机器人，ID 在此管理器中必须唯一。 */
  bots: readonly Bot[]
  /** 首次连接失败后的重试间隔，单位毫秒，省略时只尝试一次。 */
  retryAfterMs?: number
  /** 汇报每个机器人的连接结果。 */
  onConnectionState?: (botId: string, connected: boolean) => void
}

/** 按名字查找机器人，批量安装能力并管理启停及重试。 */
export class BotManager {
  private readonly bots = new Map<string, Bot>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly attempts = new Map<string, Promise<void>>()
  private lifecycle = Promise.resolve()
  private transitions = 0
  private running = false

  /** 接收已创建的机器人，各机器人可安装不同能力。 */
  constructor(private readonly options: BotManagerOptions) {
    const { retryAfterMs } = options
    if (retryAfterMs !== undefined && (!Number.isFinite(retryAfterMs) || retryAfterMs < 1))
      throw new Error('连接重试间隔必须为正数')
    for (const bot of options.bots) {
      if (this.bots.has(bot.id)) throw new Error('机器人 ID 不得重复')
      this.bots.set(bot.id, bot)
    }
  }

  /** 按 ID 查找已经登记的机器人。 */
  get(botId: string): Bot | undefined {
    return this.bots.get(botId)
  }

  /** 在停止状态为每个 Bot 创建并安装独立能力，返回按 Bot ID 索引的实例。 */
  install<T extends Capability>(createCapability: (bot: Bot) => T): ReadonlyMap<string, T> {
    if (this.running || this.transitions) throw new Error('请在启动前安装能力')
    const installed = new Map<string, T>()
    const instances = new Set<T>()
    const commit: Array<() => void> = []
    for (const bot of this.bots.values()) {
      const capability = createCapability(bot)
      if (instances.has(capability)) throw new Error('每个 Bot 需要独立的能力实例')
      instances.add(capability)
      commit.push(bot.prepareInstall(capability))
      installed.set(bot.id, capability)
    }
    // 任一工厂或能力绑定失败时，所有 Bot 的能力登记保持一致。
    for (const install of commit) install()
    return installed
  }

  /** 并行启动，单个机器人连接失败时由管理器记录并按配置重试。 */
  start(): Promise<void> {
    return this.transition(async () => {
      if (this.running) return
      this.running = true
      await Promise.allSettled([...this.bots.values()].map((bot) => this.connect(bot)))
    })
  }

  /** 停止重试，等待正在连接的机器人并关闭全部连接。 */
  stop(): Promise<void> {
    return this.transition(async () => {
      if (!this.running) return
      this.running = false
      for (const timer of this.timers.values()) clearTimeout(timer)
      this.timers.clear()
      await Promise.allSettled(this.attempts.values())
      const results = await Promise.allSettled([...this.bots.values()].map((bot) => bot.stop()))
      const failure = results.find((result) => result.status === 'rejected')
      if (failure) throw failure.reason
    })
  }

  /** 启动单个机器人，失败时只安排该机器人重试。 */
  private async connect(bot: Bot) {
    const { retryAfterMs, onConnectionState } = this.options
    let connected = false
    try {
      await bot.start()
      connected = true
    } catch {
      if (this.running && retryAfterMs !== undefined) {
        const timer = setTimeout(() => {
          this.timers.delete(bot.id)
          const attempt = this.connect(bot).finally(() => this.attempts.delete(bot.id))
          this.attempts.set(bot.id, attempt)
          // 调用方的状态回调异常不应终止其他机器人的重试。
          void attempt.catch(() => undefined)
        }, retryAfterMs)
        timer.unref()
        this.timers.set(bot.id, timer)
      }
    }
    onConnectionState?.(bot.id, connected)
  }

  /** 避免同一批机器人被重复启动或在关闭期间再次打开。 */
  private transition(task: () => Promise<void>) {
    this.transitions++
    const result = this.lifecycle.then(task).finally(() => {
      this.transitions--
    })
    this.lifecycle = result.catch(() => undefined)
    return result
  }
}
