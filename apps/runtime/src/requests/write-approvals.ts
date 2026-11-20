import { createHash, randomUUID } from 'node:crypto'
import {
  RPC_APPROVAL_TIMEOUT_MS,
  ToolInputs,
  type ApprovalEvent,
  type ApprovalNotice,
  type RpcRequest,
} from '@rcm/protocol'
import type { LocalWorkspace } from '../workspace/state'
import {
  resolveCommandRequest,
  commandFingerprint,
  formatApprovalCommand,
  commandCanBeDisplayedInApproval,
} from '../operations/command/command-operations'
import { gitApprovalContext } from '../operations/git/git-operations'
import { inspectDeleteTarget } from '../operations/file/file-operations'
import { resolveSafe, assertSafeRelativePath } from '../operations/file/path-safety'

/** 本地审批页面可展示的完整任务；不会把此对象上传或落库。 */
export interface WriteApprovalInfo {
  id: string
  workspaceId: string
  /** 本地审批显示名；启用渠道通知时可作为摘要的一部分。 */
  workspaceName: string
  path: string
  operation: string
  bytes: number
  preview: string
  truncated: boolean
  /** 目录删除影响条目数；可包含在通知摘要中。 */
  itemCount: number
  /** 仅供本机 UI 展示的命令详情，不直接序列化到渠道。 */
  command?: { text: string; purpose: string; risk: string; cwd: string; registered: boolean }
  createdAt: number
  expiresAt: number
}

/** 终止审批的明确原因，不对外暴露本地审批详情。 */
type ApprovalErrorCode =
  'APPROVAL_DENIED' | 'APPROVAL_EXPIRED' | 'CONNECTION_REPLACED' | 'WORKSPACE_PERMISSION_REVOKED'

interface ApprovalDecision {
  approved: boolean
  /** 未通过时用于区分用户拒绝、超时和授权失效。 */
  errorCode?: ApprovalErrorCode
  requestHash: string
  resourceHash?: string
}

/** 队列内部状态：保存一次性参数指纹和 Promise 回调，不会序列化到磁盘或发送到 Server。 */
interface PendingApproval extends WriteApprovalInfo {
  requestHash: string
  resourceHash?: string
  resolve: (decision: ApprovalDecision) => void
  timeout: ReturnType<typeof setTimeout>
  /** 发卡关联及远程决定所需的临时状态，不落盘。 */
  remote?: { notice: ApprovalNotice; send: (event: ApprovalEvent) => void }
}

/** 单次审批最多等待五分钟；审批上下文只在本机内存短暂展示。 */
export const WRITE_APPROVAL_TIMEOUT_MS = RPC_APPROVAL_TIMEOUT_MS

/** 完整审批上下文仅驻留本机；启用通知时只转发单独构造的摘要。 */
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
        command,
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
        command,
        createdAt,
        expiresAt,
      }),
    )
  }

  /** 远程写入请求进入本地审批队列，超时自动拒绝。 */
  async request(
    req: RpcRequest,
    workspace: LocalWorkspace,
    send?: (event: ApprovalEvent) => void,
  ): Promise<ApprovalDecision> {
    if (this.pending.size >= 20) throw Error('TOO_MANY_PENDING_WRITE_APPROVALS')
    let pathLabel = ''
    let preview = ''
    let bytes = 0
    let previewTruncated = false
    let itemCount = 0
    let command: WriteApprovalInfo['command']
    let resourceHash: string | undefined
    let externalDetails = ''
    if (req.operation === 'file.write') {
      const payload = ToolInputs['file.write'].parse(req.payload)
      pathLabel = payload.path
      preview = payload.content.slice(0, 2000)
      previewTruncated = payload.content.length > 2000
      bytes = Buffer.byteLength(payload.content, 'utf8')
      externalDetails = `路径：${payload.path}\n写入大小：${bytes} 字节（正文仅本机可见）`
    } else if (req.operation === 'file.mkdir') {
      const payload = ToolInputs['file.mkdir'].parse(req.payload)
      pathLabel = payload.path
      preview = '创建目录' + (payload.recursive ? '（含父目录）' : '')
      externalDetails = `路径：${payload.path}\n${preview}`
    } else if (req.operation === 'file.move') {
      const payload = ToolInputs['file.move'].parse(req.payload)
      pathLabel = payload.from + ' → ' + payload.to
      preview = '移动或重命名本地文件/目录，不覆盖目标'
      externalDetails = `源路径：${payload.from}\n目标路径：${payload.to}\n${preview}`
    } else if (req.operation === 'file.delete') {
      const payload = ToolInputs['file.delete'].parse(req.payload)
      assertSafeRelativePath(payload.path)
      pathLabel = payload.path
      const target = await resolveSafe(workspace, payload.path)
      const snapshot = await inspectDeleteTarget(target)
      itemCount = snapshot.entryCount
      resourceHash = snapshot.fingerprint
      preview = payload.recursive
        ? `递归删除目录（影响 ${itemCount} 个目录项，不可撤销）`
        : '删除文件或空目录（不可撤销）'
      externalDetails = `路径：${payload.path}\n${preview}\n影响项数：${itemCount}`
    } else if (req.operation === 'command.run') {
      const { command: selected, registered } = resolveCommandRequest(workspace, req.payload)
      resourceHash = commandFingerprint(selected)
      const builtin = registered && commandCanBeDisplayedInApproval(selected.id)
      const text = formatApprovalCommand(selected.executable, selected.args)
      const purpose = builtin
        ? `运行项目的 ${selected.args[1]} 脚本。`
        : registered
          ? `运行本机登记任务「${selected.name}」。`
          : '运行未登记命令，用途请结合命令本身核对。'
      const risk =
        '以 Runtime 账号权限运行，无系统隔离，可能读写项目内外文件、访问网络或启动其他进程。'
      command = { text, purpose, risk, cwd: workspace.root, registered }
      externalDetails = builtin
        ? `完整命令：${text}\n用途：${purpose}\n执行影响：${risk}`
        : '完整命令可能包含私密信息，仅在 Runtime 可见。批准前请先核对。'
    } else if (req.operation === 'file.list') {
      const payload = ToolInputs['file.list'].parse(req.payload)
      pathLabel = payload.path
      preview = '读取目录清单'
      externalDetails = `路径：${payload.path}\n${preview}`
    } else if (req.operation === 'file.read') {
      const payload = ToolInputs['file.read'].parse(req.payload)
      pathLabel = payload.path
      preview = '读取文件内容'
      externalDetails = `路径：${payload.path}\n${preview}`
    } else if (req.operation === 'file.search') {
      const payload = ToolInputs['file.search'].parse(req.payload)
      pathLabel = payload.path
      preview = '在工作区内搜索文本：' + payload.query
      externalDetails = `路径：${payload.path}\n搜索词仅本机可见。`
    } else if (req.operation === 'git.status') {
      pathLabel = 'Git 工作区'
      preview = '读取 Git 工作区状态'
    } else if (req.operation === 'git.log') {
      const payload = ToolInputs['git.log'].parse(req.payload)
      pathLabel = 'Git 提交历史'
      preview = '读取最近 ' + payload.limit + ' 条提交记录'
      externalDetails = preview
    } else if (req.operation === 'git.diff') {
      pathLabel = 'Git 工作区 Diff'
      preview = '读取当前未暂存变更差异'
    } else if (req.operation === 'git.add' || req.operation === 'git.commit') {
      const context = await gitApprovalContext(workspace, req.operation, req.payload)
      pathLabel = context.path
      preview = context.preview
      resourceHash = context.fingerprint
      if (req.operation === 'git.add')
        externalDetails = '路径：' + ToolInputs['git.add'].parse(req.payload).paths.join('、')
      else externalDetails = '暂存文件：' + context.path + '\n提交说明仅本机可见。'
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
    // 普通 RPC 与审批共享等待预算，预留一秒回传审批超时；命令 RPC 已单独预留回传时间。
    const waitMs =
      req.operation === 'command.run'
        ? WRITE_APPROVAL_TIMEOUT_MS
        : Math.min(WRITE_APPROVAL_TIMEOUT_MS, Math.max(0, req.deadlineAt - createdAt - 1000))
    const expiresAt = createdAt + waitMs
    const safeToDisplay = !/[\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u.test(
      workspace.name + externalDetails,
    )
    const source = [
      `工作区：${workspace.name.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim() || '未命名工作区'}`,
      `操作：${req.operation}`,
    ].join('\n')
    const summary = externalDetails ? source + '\n' + externalDetails : source
    const showDetails = safeToDisplay && summary.length <= 3000
    const remote =
      req.notifyApproval && send && waitMs > 0
        ? {
            send,
            notice: {
              kind: 'approval-notice' as const,
              requestId: req.id,
              approvalId: id,
              expiresAt,
              summary: showDetails
                ? summary
                : source + '\n此详情无法安全显示，请在 Runtime 中查看。',
            },
          }
        : undefined
    return new Promise((resolve) => {
      const timeout = setTimeout(() => this.complete(id, 'APPROVAL_EXPIRED'), waitMs)
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
        command,
        requestHash,
        resourceHash,
        createdAt,
        expiresAt,
        resolve,
        timeout,
        remote,
      })
      this.notify()
      remote?.send(remote.notice)
    })
  }

  /** 接收本地用户的明确决定；任务只允许完成一次。 */
  answer(id: string, approved: boolean): boolean {
    const pending = this.pending.get(id)
    if (!pending) return false
    if (pending.expiresAt <= Date.now()) {
      this.complete(id, 'APPROVAL_EXPIRED')
      return false
    }
    return this.complete(id, approved ? undefined : 'APPROVAL_DENIED')
  }

  /** 渠道入口与本机共用一次性审批；只处理匹配的待审批 RPC。 */
  answerRemote(requestId: string, approvalId: string, approved: boolean): boolean {
    const notice = this.pending.get(approvalId)?.remote?.notice
    if (!notice || notice.requestId !== requestId) return false
    return this.answer(approvalId, approved)
  }

  /** 完成指定审批并清理计时器；无错误码表示批准，返回值表明任务是否仍在队列。 */
  private complete(id: string, errorCode?: ApprovalErrorCode): boolean {
    const approval = this.pending.get(id)
    if (!approval) return false
    const approved = errorCode === undefined
    this.pending.delete(id)
    clearTimeout(approval.timeout)
    this.notify()
    approval.resolve({
      approved,
      errorCode,
      requestHash: approval.requestHash,
      resourceHash: approved ? approval.resourceHash : undefined,
    })
    approval.remote?.send({
      kind: 'approval-closed',
      requestId: approval.remote.notice.requestId,
      approvalId: id,
      status: approved
        ? 'approved'
        : errorCode === 'APPROVAL_DENIED'
          ? 'denied'
          : errorCode === 'APPROVAL_EXPIRED'
            ? 'expired'
            : 'cancelled',
    })
    return true
  }

  /** 用户移除工作区时拒绝对应任务，防止旧授权继续生效。 */
  rejectWorkspace(workspaceId: string): void {
    for (const approval of this.pending.values()) {
      if (approval.workspaceId === workspaceId)
        this.complete(approval.id, 'WORKSPACE_PERMISSION_REVOKED')
    }
  }

  /** 设备断开时取消所有未完成的审批。 */
  cancelAll(): void {
    for (const id of this.pending.keys()) this.complete(id, 'CONNECTION_REPLACED')
  }
}
