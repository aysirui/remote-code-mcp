import { z } from 'zod'

/** 登记命令使用 ID；临时命令使用程序和完整参数，必须单次审批。两种形式不能混用。 */
export const CommandRunInputSchema = z.union([
  z
    .object({
      command: z
        .string()
        .regex(/^[a-z][a-z0-9_-]{1,39}$/)
        .describe('本地登记的命令 ID；与 executable、args 互斥'),
    })
    .strict(),
  z
    .object({
      executable: z
        .string()
        .trim()
        .min(1)
        .max(260)
        .regex(/^[^\r\n\0]+$/)
        .describe('临时命令的可执行程序；此形式始终需要本机单次审批'),
      args: z
        .array(
          z
            .string()
            .max(500)
            .regex(/^[^\r\n\0]*$/),
        )
        .max(20)
        .default([])
        .describe('临时命令的完整参数数组，默认空数组；仅与 executable 一起使用'),
    })
    .strict(),
])
/** 命令执行参数，区分登记命令与临时程序两种互斥形式。 */
export type CommandRunInput = z.infer<typeof CommandRunInputSchema>

/**
 * 所有工具的参数校验 Schema。
 * 外部输入必须先经过 Zod 检验，再由 Runtime 进行路径和权限安全校验。
 */
export const ToolInputs = {
  'file.list': z.object({
    path: z.string().default('.').describe('相对于工作区根目录的目录路径，默认工作区根目录'),
  }),
  'file.read': z.object({ path: z.string().min(1).describe('相对于工作区根目录的文件路径') }),
  'file.search': z.object({
    path: z
      .string()
      .default('.')
      .describe('搜索起点的工作区相对路径，可为文件或目录，默认工作区根目录'),
    query: z
      .string()
      .min(1)
      .max(200)
      .describe('区分大小写的搜索文本，长度为 1 至 200 个字符，不支持正则表达式'),
  }),
  'file.write': z.object({
    path: z.string().min(1).describe('待写入文件的工作区相对路径'),
    content: z
      .string()
      .max(1024 * 512)
      .describe('待写入的完整正文；Runtime 还会限制 UTF-8 字节数不超过 512 KiB'),
    expectedSha256: z
      .string()
      .optional()
      .describe('原文件的 SHA-256 摘要；覆盖已有文件时必须提供，新建文件时省略'),
  }),
  'file.mkdir': z.object({
    path: z.string().min(1).max(500).describe('待创建目录的工作区相对路径'),
    recursive: z.boolean().default(false).describe('是否递归创建缺失的父目录，默认 false'),
  }),
  'file.move': z.object({
    from: z.string().min(1).max(500).describe('源文件或目录的工作区相对路径'),
    to: z.string().min(1).max(500).describe('目标工作区相对路径，不覆盖已有目标'),
  }),
  'file.delete': z.object({
    path: z.string().min(1).max(500).describe('待删除文件或目录的工作区相对路径'),
    /** 目录默认只允许删除空目录；递归删除按本机策略和真实目录项数量决定审批。 */
    recursive: z
      .boolean()
      .default(false)
      .describe('是否递归删除目录，默认 false；递归删除遵循本机风险评估与审批规则'),
    expectedSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
      .describe('待删除文件的 SHA-256 摘要，用于检查版本；删除文件时必须提供'),
  }),
  'git.status': z.object({}),
  'git.log': z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe('返回的最近提交数量，范围 1 至 50，默认 10'),
  }),
  'git.diff': z.object({}),
  'git.add': z.object({
    paths: z
      .array(z.string().min(1).max(500))
      .min(1)
      .max(50)
      .describe('待暂存文件的工作区相对路径列表，最多 50 项'),
  }),
  'git.commit': z.object({
    message: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe('提交说明，去除首尾空白后为 1 至 500 个字符'),
  }),
  'command.list': z.object({}),
  'command.run': CommandRunInputSchema,
}
