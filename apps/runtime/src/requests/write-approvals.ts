import { createHash, randomUUID } from 'node:crypto'
import { ToolInputs, type RpcRequest } from '@rcm/protocol'
import type { LocalWorkspace } from '../workspace/state'
import { resolveCommandRequest, commandFingerprint } from '../operations/command/command-operations'
import { gitApprovalContext } from '../operations/git/git-operations'
import { inspectDeleteTarget, HIGH_RISK_DELETE_THRESHOLD } from '../operations/file/file-operations'
import { resolveSafe, assertSafeRelativePath } from '../operations/file/path-safety'

/** 本地审批页面可展示的待处理任务；详情只驻留 Runtime 内存，不上传或落库。 */
export interface WriteApprovalInfo {
  id: string
  workspaceId: string
  /** 审批卡片使用的工作区显示名；审批详情与该字段不上传，云端只接收独立的工作区公开名称。 */
  workspaceName: string
  path: string
  operation: string
  bytes: number
  preview: string
  truncated: boolean
  /** 目录删除影响条目数；仅本地审批 UI 可见。 */
  itemCount: number
  /** normal / high；风险等级由 Runtime 根据本地资源计算。 */
  riskLevel: 'normal' | 'high'
  createdAt: number
  expiresAt: number
}

interface ApprovalDecision {
  approved: boolean
  requestHash: string
  resourceHash?: string
}

/** 队列内部状态：保存一次性参数指纹和 Promise 回调，不会序列化到磁盘或发送到 Gateway。 */
interface PendingApproval extends WriteApprovalInfo {
  requestHash: string
  resourceHash?: string
  resolve: (decision: ApprovalDecision) => void
  timeout: ReturnType<typeof setTimeout>
}

/** 单次审批最多等待五分钟；审批上下文只在本机内存短暂展示。 */
export const WRITE_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

/** 审批上下文不传到 Gateway，不写入数据库；断线、撤销或超时后立即清理。 */
export class WriteApprovalQueue {
  private readonly pending = new Map<string, PendingApproval>()

  /** 由 Runtime 注入本地事件通知器；队列变化时通知审批页面刷新。 */
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
        itemCount,
        riskLevel,
        createdAt,
        expiresAt,
      }) => ({
        id,
        workspaceId,
        workspaceName,
        path,
        operation,
        bytes,
        preview,
        truncated,
        itemCount,
        riskLevel,
        createdAt,
        expiresAt,
      }),
    )
  }

  /** 远程写入请求进入本地审批队列，超时自动拒绝。 */
  async request(req: RpcRequest, workspace: LocalWorkspace): Promise<ApprovalDecision> {
    if (this.pending.size >= 20) throw Error('TOO_MANY_PENDING_WRITE_APPROVALS')
    let pathLabel = ''
    let preview = ''
    let bytes = 0
    let previewTruncated = false
    let itemCount = 0
    let riskLevel: 'normal' | 'high' = 'normal'
    let resourceHash: string | undefined
    if (req.operation === 'file.write') {
      const payload = ToolInputs['file.write'].parse(req.payload)
      pathLabel = payload.path
      preview = payload.content.slice(0, 2000)
      previewTruncated = payload.content.length > 2000
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
      assertSafeRelativePath(payload.path)
      pathLabel = payload.path
      const target = await resolveSafe(workspace, payload.path)
      const snapshot = await inspectDeleteTarget(target)
      itemCount = snapshot.entryCount
      resourceHash = snapshot.fingerprint
      riskLevel = payload.recursive && itemCount > HIGH_RISK_DELETE_THRESHOLD ? 'high' : 'normal'
      preview = payload.recursive
        ? `递归删除目录（影响 ${itemCount} 个目录项，不可撤销）`
        : '删除文件或空目录（不可撤销）'
    } else if (req.operation === 'command.run') {
      const { command: selected, registered } = resolveCommandRequest(workspace, req.payload)
      resourceHash = commandFingerprint(selected)
      // 已登记命令在 approval 策略下属于常规审批；未登记命令始终高风险。
      riskLevel = registered ? 'normal' : 'high'
      pathLabel = registered ? selected.name + ' (' + selected.id + ')' : selected.name
      preview =
        '程序：' +
        selected.executable +
        '\n参数：' +
        JSON.stringify(selected.args) +
        '\n工作区：' +
        workspace.name +
        '\n工作目录：' +
        workspace.root +
        (registered
          ? '\n授权范围：已登记命令，本次操作需确认。'
          : '\n授权范围：仅本次执行，不会自动登记命令。') +
        '\n风险：程序将以 Runtime 当前账号权限运行，无文件、网络及 CPU/内存隔离；可能读写项目外文件、访问凭据、连接外网或内网、启动其他程序并消耗系统资源。审批仅确认程序与参数，不保证项目脚本及依赖的实际行为。'
    } else if (req.operation === 'file.list') {
      const payload = ToolInputs['file.list'].parse(req.payload)
      pathLabel = payload.path
      preview = '读取目录清单'
    } else if (req.operation === 'file.read') {
      const payload = ToolInputs['file.read'].parse(req.payload)
      pathLabel = payload.path
      preview = '读取文件内容'
    } else if (req.operation === 'file.search') {
      const payload = ToolInputs['file.search'].parse(req.payload)
      pathLabel = payload.path
      preview = '在工作区内搜索文本：' + payload.query
    } else if (req.operation === 'git.status') {
      pathLabel = 'Git 工作区'
      preview = '读取 Git 工作区状态'
    } else if (req.operation === 'git.log') {
      const payload = ToolInputs['git.log'].parse(req.payload)
      pathLabel = 'Git 提交历史'
      preview = '读取最近 ' + payload.limit + ' 条提交记录'
    } else if (req.operation === 'git.diff') {
      pathLabel = 'Git 工作区 Diff'
      preview = '读取当前未暂存变更差异'
    } else if (req.operation === 'git.add' || req.operation === 'git.commit') {
      const context = await gitApprovalContext(workspace, req.operation, req.payload)
      pathLabel = context.path
      preview = context.preview
      resourceHash = context.fingerprint
    } else if (req.operation === 'command.list') {
      ToolInputs['command.list'].parse(req.payload)
      pathLabel = '本地命令注册表'
      preview = '列出已登记的固定命令'
    } else throw Error('UNSUPPORTED_APPROVAL_OPERATION')

    const id = randomUUID()
    // 绑定审批时的工作区、操作类型和完整参数；Hash 只保存在本机内存。
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          workspaceId: req.workspaceId,
          operation: req.operation,
          payload: req.payload,
        }),
      )
      .digest('hex')
    const createdAt = Date.now()
    const expiresAt = createdAt + WRITE_APPROVAL_TIMEOUT_MS
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        this.notify()
        resolve({ approved: false, requestHash })
      }, WRITE_APPROVAL_TIMEOUT_MS)
      this.pending.set(id, {
        id,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        path: pathLabel,
        operation: req.operation,
        bytes,
        preview,
        truncated: previewTruncated,
        itemCount,
        riskLevel,
        requestHash,
        resourceHash,
        createdAt,
        expiresAt,
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
    approval.resolve({
      approved,
      requestHash: approval.requestHash,
      resourceHash: approved ? approval.resourceHash : undefined,
    })
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
