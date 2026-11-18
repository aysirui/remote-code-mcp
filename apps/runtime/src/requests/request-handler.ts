import { RpcRequestSchema, rpcPublicErrorCode, type CommandAudit } from '@rcm/protocol'
import { ZodError } from 'zod'
import { serverWorkspaces, type Config, type ServerProfile } from '../workspace/state'
import { execute, validateOperationSafety, assertRequestAccess } from '../operations/executors'
import { requiresApproval } from './approval-policy'
import { WriteApprovalQueue } from './write-approvals'
import { LocalEvents } from '../local/local-events'
import { handleWorkspaceRevocations } from './workspace-revocations'
import { verifyApprovalResource } from './approval-verification'
import { CommandResultError } from '../operations/command/command-operations'
import { logger } from '../logger'

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
  const startedAt = Date.now()
  const logContext = { requestId: req.id, operation: req.operation }
  const fallback = req.operation.startsWith('file.')
    ? 'FILE_OPERATION_FAILED'
    : req.operation.startsWith('git.')
      ? 'GIT_OPERATION_FAILED'
      : 'COMMAND_CONFIGURATION_FAILED'
  let stage: 'authorization' | 'validation' | 'approval' | 'execution' = 'authorization'
  let commandAudit: CommandAudit | undefined
  logger.debug('rpc.received', logContext)
  try {
    const workspace = serverWorkspaces(context.config, context.server).find(
      (item) => item.id === req.workspaceId,
    )
    if (!workspace) throw Error('WORKSPACE_NOT_FOUND')
    assertRequestAccess(workspace, req)
    logger.debug('rpc.authorized', { ...logContext, stage })

    // 执行器负责操作参数与路径安全；审批策略只决定是否需要本机确认。
    stage = 'validation'
    await validateOperationSafety(workspace, req)
    let approvalResourceHash: string | undefined
    if (await requiresApproval(workspace, req)) {
      stage = 'approval'
      logger.debug('rpc.approval.waiting', { ...logContext, stage })
      const decision = await context.approvals.request(req, workspace)
      if (decision.errorCode) throw Error(decision.errorCode)
      approvalResourceHash = decision.resourceHash
      // 审批展示与执行对象一致性由独立的资源指纹校验负责。
      await verifyApprovalResource(workspace, req, approvalResourceHash)
      logger.debug('rpc.approval.granted', { ...logContext, stage })
    }

    // 用户等待审批期间可能撤销授权；以最新工作区授权作为执行依据。
    stage = 'authorization'
    if (!context.isConnected()) throw Error('CONNECTION_REPLACED')
    const currentWorkspace = serverWorkspaces(context.config, context.server).find(
      (item) => item.id === req.workspaceId,
    )
    if (!currentWorkspace) throw Error('WORKSPACE_PERMISSION_REVOKED')
    // 审批期间可能变更权限或策略，实际执行前必须重新校验最新授权。
    assertRequestAccess(currentWorkspace, req)
    stage = 'execution'
    logger.debug('rpc.execution.started', { ...logContext, stage })
    const data = await execute(currentWorkspace, req, approvalResourceHash, (command) => {
      commandAudit = command
    })
    logger.info('rpc.completed', { ...logContext, durationMs: Date.now() - startedAt })
    return { kind: 'response', id: req.id, success: true, data, commandAudit }
  } catch (error: unknown) {
    // 只发送稳定业务错误码；原始异常可能包含工作区绝对路径或命令信息。
    const code =
      error instanceof ZodError
        ? 'INVALID_TOOL_ARGUMENTS'
        : rpcPublicErrorCode(error instanceof Error ? error.message : undefined, fallback)
    const result = error instanceof CommandResultError ? error.result : undefined
    logger.error('rpc.failed', {
      ...logContext,
      stage: error instanceof ZodError ? 'validation' : stage,
      code,
      durationMs: Date.now() - startedAt,
      exitCode: result?.exitCode,
      truncated: result?.truncated,
      err: error,
    })
    return {
      kind: 'response',
      id: req.id,
      success: false,
      ...(result ? { data: result } : {}),
      commandAudit,
      error: {
        code,
        message: code,
      },
    }
  }
}
