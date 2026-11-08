import { z } from 'zod'
import { Operations } from './operations'
import { WorkspacePublicSchema } from './workspace'

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
