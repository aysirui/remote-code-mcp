import { RpcRequestSchema, rpcPublicErrorCode, type CommandAudit } from '@rcm/protocol'
import { serverWorkspaces, type Config, type ServerProfile } from '../workspace/state'
import { execute, validateOperationSafety, assertRequestAccess } from '../operations/executors'
import { requiresApproval } from './approval-policy'
import { WriteApprovalQueue } from './write-approvals'
import { LocalEvents } from '../local/local-events'
import { handleWorkspaceRevocations } from './workspace-revocations'
import { verifyApprovalResource } from './approval-verification'

/** RPC 业务处理与 WebSocket 生命周期分离；依赖均由连接层提供。 */
export interface RequestContext {
  config: Config
  server: ServerProfile
  approvals: WriteApprovalQueue
  events: LocalEvents
  isConnected: () => boolean
}

/** 只处理业务消息，返回 RPC 响应；连接层负责发送。 */
export async function handleGatewayMessage(
  raw: string,
  context: RequestContext,
): Promise<Record<string, unknown> | undefined> {
  const message: unknown = JSON.parse(raw)
  if (
    message &&
    typeof message === 'object' &&
    'kind' in message &&
    message.kind === 'workspace-revocations'
  ) {
    await handleWorkspaceRevocations(message as Record<string, unknown>, context)
    return
  }

  const req = RpcRequestSchema.parse(message)
  let commandAudit: CommandAudit | undefined
  try {
    const workspace = serverWorkspaces(context.config, context.server).find(
      (item) => item.id === req.workspaceId,
    )
    if (!workspace) throw Error('WORKSPACE_NOT_FOUND')
    assertRequestAccess(workspace, req)

    // 执行器负责操作参数与路径安全；审批策略只决定是否需要本机确认。
    await validateOperationSafety(workspace, req)
    let approvalResourceHash: string | undefined
    if (await requiresApproval(workspace, req)) {
      const decision = await context.approvals.request(req, workspace)
      if (!decision.approved) throw Error('APPROVAL_DENIED_OR_EXPIRED')
      approvalResourceHash = decision.resourceHash
      // 审批展示与执行对象一致性由独立的资源指纹校验负责。
      await verifyApprovalResource(workspace, req, approvalResourceHash)
    }

    // 用户等待审批期间可能撤销授权；以最新工作区授权作为执行依据。
    if (!context.isConnected()) throw Error('CONNECTION_REPLACED')
    const currentWorkspace = serverWorkspaces(context.config, context.server).find(
      (item) => item.id === req.workspaceId,
    )
    if (!currentWorkspace) throw Error('WORKSPACE_PERMISSION_REVOKED')
    // 审批期间可能变更权限或策略，实际执行前必须重新校验最新授权。
    assertRequestAccess(currentWorkspace, req)
    const data = await execute(currentWorkspace, req, approvalResourceHash, (command) => {
      commandAudit = command
    })
    return { kind: 'response', id: req.id, success: true, data, commandAudit }
  } catch (error: unknown) {
    // 只发送稳定业务错误码；原始异常可能包含工作区绝对路径或命令信息。
    const code = rpcPublicErrorCode(error instanceof Error ? error.message : undefined)
    return {
      kind: 'response',
      id: req.id,
      success: false,
      commandAudit,
      error: {
        code,
        message: code,
      },
    }
  }
}
