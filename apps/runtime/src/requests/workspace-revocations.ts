import {
  applyWorkspaceRevocations,
  save,
  type Config,
  type ServerProfile,
} from '../workspace/state'
import type { WriteApprovalQueue } from './write-approvals'
import type { LocalEvents } from '../local/local-events'
import { logger } from '../logger'

/** Server 撤销授权时只更新对应服务器的授权，保留本地目录定义。 */
export async function handleWorkspaceRevocations(
  message: Record<string, unknown>,
  context: {
    config: Config
    server: ServerProfile
    approvals: WriteApprovalQueue
    events: LocalEvents
  },
) {
  const ids = message.ids
  if (
    !Array.isArray(ids) ||
    ids.length > 10000 ||
    !ids.every((id) => typeof id === 'string' && id.length <= 128)
  )
    throw Error('INVALID_WORKSPACE_REVOCATIONS')
  const removed = applyWorkspaceRevocations(context.server, ids as string[])
  if (!removed.length) return
  for (const id of removed) context.approvals.rejectWorkspace(id)
  await save(context.config)
  logger.info('workspace.revocations.applied', { workspaceCount: removed.length })
  context.events.publish('workspaces')
  context.events.publish('status')
}
