import { z } from 'zod'
export const Operations = [
  'file.list',
  'file.read',
  'file.search',
  'file.write',
  'git.status',
  'git.diff',
] as const
export type Operation = (typeof Operations)[number]
export const PermissionSchema = z.object({ read: z.boolean(), write: z.boolean() })
export const WorkspacePublicSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(128),
  permissions: PermissionSchema,
  enabled: z.boolean(),
})
export const RpcRequestSchema = z.object({
  kind: z.literal('request'),
  version: z.literal(1),
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  operation: z.enum(Operations),
  payload: z.unknown(),
  deadlineAt: z.number(),
})
export const RpcResponseSchema = z.object({
  kind: z.literal('response'),
  id: z.string(),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
})
export const HelloSchema = z.object({
  kind: z.literal('hello'),
  workspaces: z.array(WorkspacePublicSchema).max(100),
  runtimeVersion: z.string(),
})
export type RpcRequest = z.infer<typeof RpcRequestSchema>
export type RpcResponse = z.infer<typeof RpcResponseSchema>
export type WorkspacePublic = z.infer<typeof WorkspacePublicSchema>
export type Permissions = z.infer<typeof PermissionSchema>
export const ToolInputs = {
  'file.list': z.object({ path: z.string().default('.') }),
  'file.read': z.object({ path: z.string().min(1) }),
  'file.search': z.object({ path: z.string().default('.'), query: z.string().min(1).max(200) }),
  'file.write': z.object({
    path: z.string().min(1),
    content: z.string().max(1024 * 512),
    expectedSha256: z.string().optional(),
  }),
  'git.status': z.object({}),
  'git.diff': z.object({}),
}
export const operationRequiresWrite = (op: Operation) => op === 'file.write'
