import type { RpcRequest } from '@rcm/protocol'
import type { LocalWorkspace } from '../workspace/state'
import { commandFingerprint, resolveCommandRequest } from '../operations/command/command-operations'
import { inspectDeleteTarget } from '../operations/file/file-operations'
import { gitApprovalContext } from '../operations/git/git-operations'
import { resolveSafe } from '../operations/file/path-safety'

/** 审批确认后重新计算资源指纹，确保实际执行对象与用户看到的一致。 */
export async function verifyApprovalResource(
  workspace: LocalWorkspace,
  req: RpcRequest,
  approvalResourceHash: string | undefined,
) {
  if (approvalResourceHash === undefined) return
  let currentHash: string
  if (req.operation === 'file.delete') {
    const payload = req.payload as { path: string }
    currentHash = (await inspectDeleteTarget(await resolveSafe(workspace, payload.path)))
      .fingerprint
  } else if (req.operation === 'command.run') {
    currentHash = commandFingerprint(resolveCommandRequest(workspace, req.payload).command)
  } else {
    currentHash = (await gitApprovalContext(workspace, req.operation, req.payload)).fingerprint
  }
  if (currentHash !== approvalResourceHash) throw Error('APPROVAL_RESOURCE_CHANGED')
}
