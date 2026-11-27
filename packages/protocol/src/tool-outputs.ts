import { z } from 'zod'
import type { Operation } from './operations'
import { FileReadModeSchema } from './tool-inputs'

/** 命令合并输出的 UTF-8 字节上限，不包含响应的其他字段。 */
export const COMMAND_OUTPUT_LIMIT_BYTES = 48 * 1024

/** Server 与 Runtime 共享的原始操作结果；MCP 的 value 包装由 MCP 契约派生。 */
export const ToolOutputs = {
  'file.list': z.array(
    z.object({
      name: z.string().describe('文件或子目录名称'),
      type: z.enum(['directory', 'file']).describe('目录项类型：directory 为目录，file 为文件'),
    }),
  ),
  'file.stat': z.object({
    path: z.string().describe('工作区内文件或目录的相对路径'),
    type: z.enum(['file', 'directory']).describe('目标类型'),
    size: z.number().int().nonnegative().optional().describe('普通文件的大小，单位为字节'),
  }),
  'file.read': z.object({
    content: z.string().optional().describe('完整 UTF-8 文本正文，仅 utf8 模式返回此字段'),
    encoding: FileReadModeSchema.describe('读取方式：文本、原文件流或内联文件内容'),
    mimeType: z
      .string()
      .describe('文本为 text/plain；二进制按内容识别，未知时为 application/octet-stream'),
    size: z.number().int().nonnegative().describe('原始文件大小，单位为字节'),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .describe('原始文件字节的 SHA-256 摘要，可用于后续写入或删除时的 expectedSha256'),
    originalSize: z
      .number()
      .int()
      .optional()
      .describe('仅缩略图预览提供，表示原图字节数，此时 size 和 sha256 属于缩略图'),
  }),
  'file.search': z.array(
    z.object({
      path: z.string().describe('匹配文件的工作区相对路径'),
      line: z.number().int().min(1).describe('从 1 开始的匹配行号'),
      text: z.string().describe('匹配行的前 250 个字符'),
    }),
  ),
  'file.write': z.object({
    path: z.string().describe('已写入文件的工作区相对路径'),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .describe('写入后原始文件字节的 SHA-256 摘要'),
    written: z.literal(true).describe('文件已成功写入'),
  }),
  'file.mkdir': z.object({
    path: z.string().describe('目标目录的工作区相对路径'),
    created: z.boolean().describe('是否新建了目录；目录已存在时为 false'),
  }),
  'file.move': z.object({
    from: z.string().describe('原文件或目录的工作区相对路径'),
    to: z.string().describe('移动后文件或目录的工作区相对路径'),
    moved: z.literal(true).describe('文件或目录已成功移动'),
  }),
  'file.delete': z.object({
    path: z.string().describe('已删除文件或目录的工作区相对路径'),
    deleted: z.literal(true).describe('文件或目录已成功删除'),
  }),
  'git.status': z.string().describe('Git 工作区状态文本'),
  'git.log': z.array(
    z.object({
      hash: z.string().describe('提交的短哈希'),
      date: z.string().describe('提交日期，格式为 YYYY-MM-DD'),
      author: z.string().describe('提交作者名称'),
      subject: z.string().describe('提交标题，最多 300 个字符'),
    }),
  ),
  'git.diff': z.string().describe('允许访问的文件的未暂存差异文本'),
  'git.add': z.object({
    staged: z.array(z.string()).describe('已暂存文件的工作区相对路径列表'),
    output: z.string().describe('Git 暂存操作的输出文本'),
  }),
  'git.commit': z.object({
    committed: z.array(z.string()).describe('本次提交涉及的工作区相对路径列表'),
    tree: z.string().describe('本次提交所使用的暂存区 Git 树对象 ID'),
    output: z.string().describe('Git 提交操作的输出文本'),
  }),
  'command.list': z.array(
    z.object({
      id: z.string().describe('本地登记的命令 ID，可作为 command.run 的 command 参数'),
      name: z.string().describe('命令显示名称'),
    }),
  ),
  'command.run': z.object({
    command: z.string().describe('登记命令 ID 或临时命令的可执行程序'),
    exitCode: z.number().int().nullable().describe('进程退出码；进程因信号终止等情况可能为 null'),
    output: z.string().describe('标准输出与标准错误的合并文本，最多 48 KiB；超时由错误码表示'),
    truncated: z.boolean().describe('输出是否因达到大小限制而截断'),
  }),
} satisfies Record<Operation, z.ZodType>

/** 指定操作返回的原始业务结果类型，供执行器及其调用方复用。 */
export type ToolOutput<T extends Operation = Operation> = z.infer<(typeof ToolOutputs)[T]>
