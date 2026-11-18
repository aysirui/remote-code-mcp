import { EventEmitter } from 'node:events'

/** 本地管理页事件类型，仅传输状态摘要，不包含设备 Token 或完整写入内容。 */
export type LocalEventName = 'status' | 'workspaces' | 'write-approvals'

/**
 * Runtime 与本地管理页面之间的事件总线。
 * 由 SSE 订阅者监听；事件只通知已授权的本地浏览器，不转发到 Server。
 */
export class LocalEvents {
  private readonly emitter = new EventEmitter()

  /** 广播某类本地状态已发生变化。 */
  publish(name: LocalEventName): void {
    this.emitter.emit('change', name)
  }

  /** 注册事件订阅，返回取消订阅函数，确保 SSE 断开后释放监听器。 */
  subscribe(listener: (name: LocalEventName) => void): () => void {
    this.emitter.on('change', listener)
    return () => this.emitter.off('change', listener)
  }
}
