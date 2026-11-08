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
  'git.status': z.object({}),
  'git.diff': z.object({}),
}
