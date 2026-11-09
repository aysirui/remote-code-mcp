import { z } from 'zod'

/**
 * 所有工具的参数校验 Schema。
 * 外部输入必须先经过 Zod 检验，再由 Runtime 进行路径和权限安全校验。
 */
export const ToolInputs = {
  'file.list': z.object({ path: z.string().default('.') }),
  'file.read': z.object({ path: z.string().min(1) }),
  'file.search': z.object({
    path: z.string().default('.'),
    query: z.string().min(1).max(200),
  }),
  'file.write': z.object({
    path: z.string().min(1),
    content: z.string().max(1024 * 512),
    expectedSha256: z.string().optional(),
  }),
  'file.mkdir': z.object({
    path: z.string().min(1).max(500),
    recursive: z.boolean().default(false),
  }),
  'file.move': z.object({
    from: z.string().min(1).max(500),
    to: z.string().min(1).max(500),
  }),
  'file.delete': z.object({
    path: z.string().min(1).max(500),
    /** 目录默认只允许删除空目录，递归删除必须逐次本机审批。 */
    recursive: z.boolean().default(false),
    expectedSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  }),
  'command.list': z.object({}),
  'command.run': z.object({
    /** AI 只能传命令 ID，不能携带任意 executable、args 或 Shell 文本。 */
    command: z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/),
  }),
  'git.status': z.object({}),
  'git.diff': z.object({}),
}
