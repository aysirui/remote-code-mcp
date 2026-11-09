import { randomUUID } from 'node:crypto'
import { ToolInputs, type RpcRequest } from '@rcm/protocol'
import type { LocalWorkspace } from './state'
import { resolveCommand } from './command-operations'

/** 本地管理员页面可展示的待写入任务摘要，不包含完整的文件内容。 */
export interface WriteApprovalInfo {
  id: string
  workspaceId: string
  workspaceName: string
  path: string
  operation: string
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
      ({
        id,
        workspaceId,
        workspaceName,
        path,
        operation,
        bytes,
        preview,
        truncated,
        createdAt,
      }) => ({
        id,
        workspaceId,
        workspaceName,
        path,
        operation,
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
    let pathLabel = ''
    let preview = ''
    let bytes = 0
    if (req.operation === 'file.write') {
      const payload = ToolInputs['file.write'].parse(req.payload)
      pathLabel = payload.path
      preview = payload.content.slice(0, 2000)
      bytes = Buffer.byteLength(payload.content, 'utf8')
    } else if (req.operation === 'file.mkdir') {
      const payload = ToolInputs['file.mkdir'].parse(req.payload)
      pathLabel = payload.path
      preview = '创建目录' + (payload.recursive ? '（含父目录）' : '')
    } else if (req.operation === 'file.move') {
      const payload = ToolInputs['file.move'].parse(req.payload)
      pathLabel = payload.from + ' → ' + payload.to
      preview = '移动或重命名本地文件/目录，不覆盖目标'
    } else if (req.operation === 'file.delete') {
      const payload = ToolInputs['file.delete'].parse(req.payload)
      pathLabel = payload.path
      preview = payload.recursive ? '递归删除目录（不可撤销）' : '删除文件或空目录（不可撤销）'
    } else if (req.operation === 'command.run') {
      const payload = ToolInputs['command.run'].parse(req.payload)
      const selected = resolveCommand(workspace, payload.command)
      pathLabel = selected.name + ' (' + selected.id + ')'
      preview =
        '程序：' +
        selected.executable +
        '\\n参数：' +
        JSON.stringify(selected.args) +
        '\\n工作区：' +
        workspace.name +
        '\\n执行此程序可能访问工作区外的数据，请只批准可信命令。'
    } else throw Error('UNSUPPORTED_APPROVAL_OPERATION')
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
        path: pathLabel,
        operation: req.operation,
        bytes,
        preview,
        truncated: preview.length > 2000,
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
