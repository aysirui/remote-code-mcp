import { z } from 'zod'

/** 每个工具域的独立访问策略。deny 永远拒绝；approval 要求本地用户确认；allow 免逐次确认。 */
export const AccessPolicySchema = z.enum(['deny', 'approval', 'allow'])
export const WorkspacePoliciesSchema = z.object({
  file: AccessPolicySchema,
  git: AccessPolicySchema,
  command: AccessPolicySchema,
})

/** Runtime 本地可读写权限；云端策略与本地策略必须同时满足。 */
export const PermissionSchema = z.object({
  read: z.boolean(),
  write: z.boolean(),
})

/** 设备同步到 Gateway 的最小工作区公开信息，不包含任何本地路径或项目结构。 */
export const WorkspacePublicSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(128),
  permissions: PermissionSchema,
  policies: WorkspacePoliciesSchema,
  enabled: z.boolean(),
})

export type AccessPolicy = z.infer<typeof AccessPolicySchema>
export type WorkspacePolicies = z.infer<typeof WorkspacePoliciesSchema>
export type Permissions = z.infer<typeof PermissionSchema>
export type WorkspacePublic = z.infer<typeof WorkspacePublicSchema>
