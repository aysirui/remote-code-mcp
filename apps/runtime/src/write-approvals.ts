import { randomUUID } from 'node:crypto'
import { ToolInputs, type RpcRequest } from '@rcm/protocol'
import type { LocalWorkspace } from './state'

/** 本地管理员页面可展示的待写入任务摘要，不包含完整的文件内容。 */
export interface WriteApprovalInfo {
  id: string
  workspaceId: string
  workspaceName: string
  path: string
  bytes: number
  preview: string
  truncated: boolean
  createdAt: number
}

/** 正在等待用户决定的请求；完整请求仍保留在 WebSocket 调用流程内。 */
interface PendingApproval extends WriteApprovalInfo {
  resolve: (approved: boolean) => void
  timeout: ReturnType<typeof setTimeout>
}

/**
 * 本地文件写入审批队列。
 * - 每个请求最多等待 30 秒；
 * - 队列满时拒绝请求，避免远程滥用造成内存积压；
 * - 断线、移除工作区时必须取消相应审批；
 * - 审批通过后，执行层仍须重新确认工作区权限和文件 Hash。
 */
export class WriteApprovalQueue {
  private readonly pending = new Map<string, PendingApproval>()

  /** 由 Runtime 注入事件通知器，审批队列变化时推送给本地管理页面。 */
  constructor(private readonly notify: () => void = () => {}) {}

  /** 获取本地 UI 可用的待处理任务，避免泄露 Promise 处理器。 */
  list(): WriteApprovalInfo[] {
    return [...this.pending.values()].map(
      ({ id, workspaceId, workspaceName, path, bytes, preview, truncated, createdAt }) => ({
        id,
        workspaceId,
        workspaceName,
        path,
        bytes,
        preview,
        truncated,
        createdAt,
      }),
    )
  }

  /** 远程写入请求进入审批队列，超时自动拒绝。 */
  request(req: RpcRequest, workspace: LocalWorkspace): Promise<boolean> {
    if (this.pending.size >= 20) throw Error('TOO_MANY_PENDING_WRITE_APPROVALS')
    const payload = ToolInputs['file.write'].parse(req.payload)
    const id = randomUUID()
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        this.notify()
        resolve(false)
      }, 30000)
      this.pending.set(id, {
        id,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        path: payload.path,
        bytes: Buffer.byteLength(payload.content, 'utf8'),
        preview: payload.content.slice(0, 2000),
        truncated: payload.content.length > 2000,
        createdAt: Date.now(),
        resolve,
        timeout,
      })
      this.notify()
    })
  }

  /** 接收本地用户的明确决定；任务只允许完成一次。 */
  answer(id: string, approved: boolean): boolean {
    const approval = this.pending.get(id)
    if (!approval) return false
    this.pending.delete(id)
    clearTimeout(approval.timeout)
    this.notify()
    approval.resolve(approved)
    return true
  }

  /** 用户移除工作区时拒绝对应任务，防止旧授权继续生效。 */
  rejectWorkspace(workspaceId: string): void {
    for (const approval of this.pending.values()) {
      if (approval.workspaceId === workspaceId) this.answer(approval.id, false)
    }
  }

  /** 设备断开时取消所有未完成的审批。 */
  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.answer(id, false)
  }
}
