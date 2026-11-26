import { z } from 'zod'

/** 文件工具的 UTF-8 正文上限，单位为原始字节。 */
export const FILE_TEXT_LIMIT_BYTES = 512 * 1024

/** 单次原文件流传输上限，单位为字节。 */
export const FILE_BINARY_LIMIT_BYTES = 64 * 1024 * 1024

/** MCP inline 图片预览的原始字节上限。 */
export const FILE_PREVIEW_LIMIT_BYTES = 512 * 1024

/** 控制消息中的短期设备传输凭证；Relay URL 始终由 Runtime 根据当前 Server 生成。 */
export const FileTransferSchema = z.object({
  id: z.uuid().describe('本次文件传输的唯一标识'),
  key: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .describe('仅对应设备 RPC 可见的一次性传输凭证'),
})

/** 文件读取支持文本、原文件流和有大小上限的 MCP 图片预览。 */
export const FileReadModeSchema = z.enum(['utf8', 'stream', 'preview'])

/** MCP 文件读取参数；省略 encoding 时读取 UTF-8 文本。 */
export const FileReadInputSchema = z.object({
  path: z.string().min(1).max(500).describe('相对于工作区根目录的文件路径'),
  encoding: FileReadModeSchema.default('utf8').describe(
    '读取方式：utf8 返回文本，stream 获取原文件下载地址，preview 返回小图片预览',
  ),
})

/** 写入字段共用于 MCP 和设备 RPC，原文件字节通过独立 HTTP 请求传输。 */
export const FileWriteInputSchema = z
  .object({
    path: z.string().min(1).max(500).describe('待写入文件的工作区相对路径'),
    encoding: z
      .enum(['utf8', 'stream'])
      .default('utf8')
      .describe('写入方式：utf8 提交文本正文，stream 获取原文件上传地址'),
    content: z
      .string()
      .max(FILE_TEXT_LIMIT_BYTES)
      .optional()
      .describe('UTF-8 正文，最多 512 KiB；仅 utf8 模式填写'),
    size: z
      .number()
      .int()
      .min(0)
      .max(FILE_BINARY_LIMIT_BYTES)
      .optional()
      .describe('上传文件的精确原始字节数，最多 64 MiB；仅 stream 模式填写'),
    expectedSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
      .describe('原文件字节的 SHA-256；覆盖已有文件时必须提供，新建文件时省略'),
  })
  .superRefine(({ encoding, content, size }, context) => {
    if (encoding === 'utf8') {
      if (
        content === undefined ||
        content.includes('\0') ||
        new TextEncoder().encode(content).byteLength > FILE_TEXT_LIMIT_BYTES ||
        size !== undefined
      )
        context.addIssue({
          code: 'custom',
          path: ['content'],
          message: '请提供不含 NUL 且不超过 512 KiB 的 UTF-8 正文，省略 size',
        })
    } else if (size === undefined || content !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['size'],
        message: '请提供上传文件的原始字节数，省略 content',
      })
    }
  })

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
  'file.read': FileReadInputSchema.extend({ transfer: FileTransferSchema.optional() }),
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
  'file.write': FileWriteInputSchema.safeExtend({ transfer: FileTransferSchema.optional() }),
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
