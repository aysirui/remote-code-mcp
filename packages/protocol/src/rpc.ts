import { z } from 'zod'
import { Operations } from './operations'
import { WorkspacePublicSchema } from './workspace'

/** 普通 RPC 等待预算，也是 Runtime 本机单次审批的最长等待时间。 */
export const RPC_APPROVAL_TIMEOUT_MS = 5 * 60_000

/** 仅本机登记项可设置的命令执行上限；远程工具参数不接受超时配置。 */
export const COMMAND_MAX_TIMEOUT_MS = 20 * 60_000

/** 包含完整审批、执行及 15 秒清理和回传余量的命令 RPC 预算。 */
export const COMMAND_RPC_TIMEOUT_MS = RPC_APPROVAL_TIMEOUT_MS + COMMAND_MAX_TIMEOUT_MS + 15_000

/** 已启动的命令在这些失败情形下仍可返回部分结果，但不得持久化。 */
export const CommandResultErrorCodeSchema = z.enum([
  'COMMAND_EXIT_NONZERO',
  'COMMAND_PROCESS_TERMINATED',
  'COMMAND_TIMEOUT',
])

/** 可携带命令结果的稳定错误码。 */
export type CommandResultErrorCode = z.infer<typeof CommandResultErrorCodeSchema>

/**
 * 可向 MCP 客户端公开的稳定执行错误码。
 * 本地文件绝对路径、原始异常正文和命令参数不得经此通道上传。
 */
export const RpcPublicErrorCodes = [
  'WORKSPACE_NOT_FOUND',
  'WORKSPACE_DISABLED',
  'WORKSPACE_PERMISSION_REVOKED',
  'WORKSPACE_ID_MISMATCH',
  'PERMISSION_DENIED',
  'POLICY_DENIED',
  'REQUEST_EXPIRED',
  'CONNECTION_REPLACED',
  'APPROVAL_DENIED_OR_EXPIRED',
  'APPROVAL_DENIED',
  'APPROVAL_EXPIRED',
  'APPROVAL_RESOURCE_CHANGED',
  'EXPECTED_SHA256_REQUIRED',
  'FILE_CONFLICT',
  'FILE_CHANGED',
  'FILE_TOO_LARGE',
  'FILE_TOO_LARGE_OR_UNSUPPORTED',
  'NOT_DIRECTORY',
  'INVALID_PATH',
  'INVALID_MOVE',
  'DESTINATION_EXISTS',
  'WORKSPACE_ROOT_PROTECTED',
  'SYMLINK_DENIED',
  'SENSITIVE_PATH_DENIED',
  'HARD_DENY_HARDLINK',
  'HARD_DENY_RUNTIME_DATA',
  'HARD_DENY_WORKSPACE_ROOT_CHANGED',
  'OUTSIDE_WORKSPACE',
  'HIGH_RISK_DELETE_REQUIRES_APPROVAL',
  'DELETE_TARGET_CHANGED_DURING_APPROVAL',
  'DELETE_SNAPSHOT_TOO_LARGE',
  'TOO_MANY_ENTRIES',
  'UNSUPPORTED_FILE_TYPE',
  'INVALID_FILE_HASH',
  'TOO_MANY_PENDING_WRITE_APPROVALS',
  'UNSUPPORTED_OPERATION',
  'INVALID_TOOL_ARGUMENTS',
  'INVALID_TOOL_RESULT',
  'FILE_OPERATION_FAILED',
  'GIT_OPERATION_FAILED',
  'COMMAND_CONFIGURATION_FAILED',
  'COMMAND_NOT_ALLOWED',
  'COMMAND_APPROVAL_REQUIRED',
  'INVALID_COMMAND',
  'INVALID_COMMAND_TIMEOUT',
  'SHELL_EXECUTABLE_DENIED',
  'WORKSPACE_NOT_DIRECTORY',
  'COMMAND_START_FAILED',
  ...CommandResultErrorCodeSchema.options,
  'HARD_DENY_INVALID_PARENT',
  'HARD_DENY_SENSITIVE_GIT_PATH',
  'GIT_REPOSITORY_OUTSIDE_WORKSPACE',
  'GIT_FILTERS_NOT_ALLOWED',
  'GIT_TOO_MANY_FILES',
  'GIT_NOTHING_STAGED',
  'GIT_TOO_MANY_STAGED_FILES',
  'GIT_ADD_REGULAR_FILES_ONLY',
  'GIT_ADD_FILE_TOO_LARGE',
  'GIT_ADD_TOTAL_TOO_LARGE',
  'GIT_STATE_CHANGED_DURING_APPROVAL',
] as const

/** 识别允许跨越设备边界的错误码，无法匹配时返回指定的安全兜底码。 */
export function rpcPublicErrorCode(
  message: string | undefined,
  fallback: (typeof RpcPublicErrorCodes)[number] | 'EXECUTION_FAILED' = 'EXECUTION_FAILED',
): string {
  return message && (RpcPublicErrorCodes as readonly string[]).includes(message)
    ? message
    : fallback
}

/**
 * Server 向 Runtime 发起的 RPC 请求。
 * deadlineAt 是毫秒时间戳，过期请求必须在执行前拒绝。
 */
export const RpcRequestSchema = z.object({
  kind: z.literal('request'),
  version: z.literal(1),
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  operation: z.enum(Operations),
  payload: z.unknown(),
  deadlineAt: z.number(),
})

/**
 * Runtime 返回的 RPC 响应。
 * 使用请求 ID 关联待处理请求；Server 仍需验证连接归属。
 * data 通常仅在成功时使用；已启动命令的特定失败可携带部分执行结果。
 */
export const RpcResponseSchema = z.object({
  kind: z.literal('response'),
  id: z.string(),
  success: z.boolean(),
  data: z.unknown().optional(),
  commandAudit: z
    .object({ executable: z.string().max(260), args: z.array(z.string().max(500)).max(20) })
    .optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
})

/** 设备连接建立后同步的状态快照，最多包含 100 个工作区。 */
export const HelloSchema = z.object({
  kind: z.literal('hello'),
  workspaces: z.array(WorkspacePublicSchema).max(100),
  runtimeVersion: z.string(),
})

/** Server 发给设备的请求类型。 */
export type RpcRequest = z.infer<typeof RpcRequestSchema>

/** 设备返回给 Server 的响应类型。 */
export type RpcResponse = z.infer<typeof RpcResponseSchema>
