import { z } from 'zod'

/** Runtime 本地可读写权限；云端再与自己的授权策略取交集。 */
export const PermissionSchema = z.object({
  read: z.boolean(),
  write: z.boolean(),
})

/**
 * 设备同步到 Gateway 的工作区公开信息。
 * 故意不包含本地绝对路径，避免云端存储开发者的文件系统结构。
 */
export const WorkspacePublicSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(128),
  /** 仅同步目录末级名称，不泄露本地绝对路径。 */
  directoryName: z.string().min(1).max(255).optional(),
  permissions: PermissionSchema,
  enabled: z.boolean(),
})

/** 工作区授权状态。 */
export type Permissions = z.infer<typeof PermissionSchema>

/** 允许通过 WSS 同步的工作区摘要。 */
export type WorkspacePublic = z.infer<typeof WorkspacePublicSchema>
