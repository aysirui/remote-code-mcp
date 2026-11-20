import type { BotAdapter, Capability, CapabilityContext } from './contracts.js'

/** 单个机器人的连接配置和诊断回调。 */
export interface BotOptions {
  /** 该机器人使用的平台连接。 */
  adapter: BotAdapter
  /** 记录平台或能力报告的异步错误。 */
  onError?: (error: Error) => void
}

/** 管理一条平台连接和安装在该连接上的能力。 */
export class Bot {
  /** 机器人在 BotManager 内使用的名字。 */
  readonly id: string
  private readonly capabilities = new Map<string, Capability>()
  private readonly context: CapabilityContext
  private lifecycle = Promise.resolve()
  private transitions = 0
  private running = false

  /** 创建 Bot，等待调用方安装能力并打开连接。 */
  constructor({ adapter, onError }: BotOptions) {
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
export function createBot(options: BotOptions): Bot {
  return new Bot(options)
}
