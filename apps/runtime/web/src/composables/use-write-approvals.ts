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
  /** 提交本机用户对单次请求的批准或拒绝；高风险操作再次展示明确确认信息。 */
  async function answerWriteApproval(id: string, approve: boolean) {
    try {
      if (approve) {
        const item = writeApprovals.value.find((x) => x.id === id)
        const operation = item?.operation
        const sensitive =
          item?.riskLevel === 'high' ||
          ['command.run', 'git.add', 'git.commit'].includes(operation || '')
        const message =
          operation === 'command.run'
            ? `${item?.preview || ''}\n\n批准仅对本次请求有效，是否执行？`
            : operation === 'file.delete'
              ? item?.riskLevel === 'high'
                ? `这将递归删除 ${item.itemCount} 个目录项，且无法保证撤销。请再次核对目标路径和影响范围。`
                : '这项操作将删除指定文件或空目录。请核对路径后再批准。'
              : operation === 'git.add'
                ? '将把列出的普通文件加入 Git 暂存区。请核对文件路径和内容是否符合预期。'
                : operation === 'git.commit'
                  ? '将提交当前暂存区中的全部变更。请核对暂存文件列表和提交说明。'
                  : ['file.write', 'file.mkdir', 'file.move'].includes(operation || '')
                    ? '批准后，当前远程请求将修改授权工作区中的文件。只批准你明确认识的请求。'
                    : '此请求会读取本地文件或 Git 信息，并将结果返回 AI 客户端。请确认是否允许读取。'
        await ElMessageBox.confirm(message, sensitive ? '确认高风险本地操作' : '确认本地操作', {
          type: 'warning',
          confirmButtonText: sensitive ? '批准执行' : '允许本次操作',
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
