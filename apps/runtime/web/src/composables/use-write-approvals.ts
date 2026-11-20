import { type Ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { WriteApprovalView } from '../types/runtime'

/** 本机审批交互仅处理单次请求，敏感详情不进入服务器持久化日志。 */
export function useWriteApprovals(
  writeApprovals: Ref<WriteApprovalView[]>,
  api: (
    path: string,
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    data?: unknown,
  ) => Promise<unknown>,
  refresh: () => Promise<void>,
  reportError: (error: unknown) => void,
) {
  /** 提交本机用户对单次请求的批准或拒绝；确认框只补充操作效果。 */
  async function answerWriteApproval(id: string, approve: boolean) {
    try {
      if (approve) {
        const item = writeApprovals.value.find((x) => x.id === id)
        const operation = item?.operation
        const message =
          operation === 'command.run'
            ? '将以 Runtime 账号权限执行上方命令。批准仅对本次请求有效。'
            : operation === 'file.delete'
              ? `将删除指定目标（影响 ${item?.itemCount ?? 0} 项），请确认路径，删除后可能无法恢复。`
              : operation === 'git.add'
                ? '将把列出的普通文件加入 Git 暂存区。请核对文件路径和内容是否符合预期。'
                : operation === 'git.commit'
                  ? '将提交当前暂存区中的全部变更。请核对暂存文件列表和提交说明。'
                  : ['file.write', 'file.mkdir', 'file.move'].includes(operation || '')
                    ? '批准后，当前远程请求将修改授权工作区中的文件。只批准你明确认识的请求。'
                    : '此请求会读取本地文件或 Git 信息，并将结果返回 AI 客户端。请确认是否允许读取。'
        await ElMessageBox.confirm(message, '确认本地操作', {
          type: 'warning',
          confirmButtonText: '批准本次操作',
        })
      }
      await api('write-approvals/' + encodeURIComponent(id), 'POST', { approve })
      await refresh()
      ElMessage.success(approve ? '已批准本次操作' : '已拒绝本次操作')
    } catch (error: unknown) {
      reportError(error)
    }
  }

  return { answerWriteApproval }
}
