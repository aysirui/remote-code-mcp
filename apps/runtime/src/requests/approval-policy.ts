import { operationRequiresLocalApproval, type RpcRequest } from '@rcm/protocol'
import { commandRequiresApproval } from '../operations/command/command-operations'
import { inspectDeleteTarget, HIGH_RISK_DELETE_THRESHOLD } from '../operations/file/file-operations'
import { resolveSafe } from '../workspace/path-safety'
import { policyForOperation, type LocalWorkspace } from '../workspace/state'

/**
 * 统一决定一次请求是否需要本机审批。
 * 工作区授权与 deny 由调用方先行校验；本函数只负责审批策略和明确的高风险操作。
 */
export async function requiresApproval(
  workspace: LocalWorkspace,
  req: RpcRequest,
): Promise<boolean> {
  if (policyForOperation(workspace, req.operation) === 'approval') return true
  if (operationRequiresLocalApproval(req.operation)) return true
  if (req.operation === 'command.run') return commandRequiresApproval(workspace, req.payload)
  if (req.operation === 'file.delete') {
    const payload = req.payload as { path: string; recursive: boolean }
    if (!payload.recursive) return false
    const snapshot = await inspectDeleteTarget(await resolveSafe(workspace, payload.path))
    return snapshot.entryCount > HIGH_RISK_DELETE_THRESHOLD
  }
  return false
}
