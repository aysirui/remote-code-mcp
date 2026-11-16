import { z } from 'zod'

/** 登记命令使用 ID；临时命令使用程序和完整参数，必须单次审批。两种形式不能混用。 */
export const CommandRunInputSchema = z.union([
  z.object({ command: z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/) }).strict(),
  z
    .object({
      executable: z
        .string()
        .trim()
        .min(1)
        .max(260)
        .regex(/^[^\r\n\0]+$/),
      args: z
        .array(
          z
            .string()
            .max(500)
            .regex(/^[^\r\n\0]*$/),
        )
        .max(20)
        .default([]),
    })
    .strict(),
])
export type CommandRunInput = z.infer<typeof CommandRunInputSchema>

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
  'git.status': z.object({}),
  'git.log': z.object({ limit: z.number().int().min(1).max(50).default(10) }),
  'git.diff': z.object({}),
  'git.add': z.object({
    paths: z.array(z.string().min(1).max(500)).min(1).max(50),
  }),
  'git.commit': z.object({
    message: z.string().trim().min(1).max(500),
  }),
  'command.list': z.object({}),
  'command.run': CommandRunInputSchema,
}
