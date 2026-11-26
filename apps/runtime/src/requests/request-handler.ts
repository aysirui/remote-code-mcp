import {
  RpcRequestSchema,
  ApprovalAnswerSchema,
  rpcPublicErrorCode,
  type ApprovalEvent,
  type CommandAudit,
} from '@rcm/protocol'
import { ZodError } from 'zod'
import { serverWorkspaces, type Config, type ServerProfile } from '../workspace/state'
import { execute, validateOperationSafety, assertRequestAccess } from '../operations/executors'
import { requiresApproval } from './approval-policy'
import { WriteApprovalQueue } from './write-approvals'
import { LocalEvents } from '../local/local-events'
import { handleWorkspaceRevocations } from './workspace-revocations'
import { verifyApprovalResource } from './approval-verification'
import { CommandResultError } from '../operations/command/command-operations'
import { logger, summarizeError } from '../logger'

/** RPC 业务处理与 WebSocket 生命周期分离；依赖均由连接层提供。 */
export interface RequestContext {
  config: Config
  server: ServerProfile
  approvals: WriteApprovalQueue
  events: LocalEvents
  isConnected: () => boolean
  /** 设备连接关闭时取消正在进行的文件流。 */
  connectionSignal?: AbortSignal
  /** 将临时审批通知发送到提交当前请求的设备连接。 */
  sendApproval?: (event: ApprovalEvent) => void
}

/** 只处理业务消息，返回 RPC 响应；连接层负责发送。 */
export async function handleGatewayMessage(
  raw: string,
  context: RequestContext,
): Promise<Record<string, unknown> | undefined> {
  const message: unknown = JSON.parse(raw)
  const decision = ApprovalAnswerSchema.safeParse(message)
  if (decision.success) {
    if (context.isConnected())
      context.approvals.answerRemote(
        decision.data.requestId,
        decision.data.approvalId,
        decision.data.approved,
      )
    return
  }
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
  // 文件正文和一次性流传输凭证不写入诊断日志。
  const usesFileContent = req.operation === 'file.read' || req.operation === 'file.write'
  const logPayload = usesFileContent ? undefined : req.payload
  const fallback = req.operation.startsWith('file.')
    ? 'FILE_OPERATION_FAILED'
    : req.operation.startsWith('git.')
      ? 'GIT_OPERATION_FAILED'
      : 'COMMAND_CONFIGURATION_FAILED'
  let stage: 'authorization' | 'validation' | 'approval' | 'execution' = 'authorization'
  let commandAudit: CommandAudit | undefined
  logger.debug('rpc.received', { ...logContext, payload: logPayload })
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
      const decision = await context.approvals.request(req, workspace, context.sendApproval)
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
    // 长时间上传结束后再次检查授权与目录绑定，防止临时文件落到已撤销的工作区。
    const fileTransfer = usesFileContent
      ? {
          gateway: context.server.gateway,
          signal: AbortSignal.any([
            AbortSignal.timeout(Math.max(1, req.deadlineAt - Date.now())),
            ...(context.connectionSignal ? [context.connectionSignal] : []),
          ]),
          assertActive: () => {
            if (!context.isConnected()) throw Error('CONNECTION_REPLACED')
            const latest = serverWorkspaces(context.config, context.server).find(
              (item) => item.id === req.workspaceId,
            )
            if (!latest || latest.root !== currentWorkspace.root)
              throw Error('WORKSPACE_PERMISSION_REVOKED')
            assertRequestAccess(latest, req)
          },
        }
      : undefined
    const data = await execute(
      currentWorkspace,
      req,
      approvalResourceHash,
      (command) => {
        commandAudit = command
      },
      fileTransfer,
    )
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
      payload: logPayload,
      stage: error instanceof ZodError ? 'validation' : stage,
      code,
      durationMs: Date.now() - startedAt,
      exitCode: result?.exitCode,
      truncated: result?.truncated,
      error: summarizeError(error),
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
