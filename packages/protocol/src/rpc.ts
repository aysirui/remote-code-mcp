import { z } from 'zod'
import { Operations } from './operations'
import { WorkspacePublicSchema } from './workspace'

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
] as const

/** 只允许预先确认不含本地隐私信息的业务错误码跨越设备边界。 */
export function rpcPublicErrorCode(message: string | undefined): string {
  return message && (RpcPublicErrorCodes as readonly string[]).includes(message)
    ? message
    : 'EXECUTION_FAILED'
}

/**
 * Gateway 向 Runtime 发起的 RPC 请求。
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
 * 使用请求 ID 关联待处理请求；Gateway 仍需验证连接归属。
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

/** Gateway 发给设备的请求类型。 */
export type RpcRequest = z.infer<typeof RpcRequestSchema>

/** 设备返回给 Gateway 的响应类型。 */
export type RpcResponse = z.infer<typeof RpcResponseSchema>
