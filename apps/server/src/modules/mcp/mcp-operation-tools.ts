import {
  ToolInputs,
  ToolOutputs,
  McpToolInputs,
  McpToolOutputs,
  operationRequiresWrite,
  type Operation,
} from '@rcm/protocol'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { env } from '../../config/env'
import { DeviceHub } from '../device/device-hub'
import { DeviceRpcError } from '../device/device-rpc-pending'
import { createMcpToolRegistrar } from './mcp-tool-registration'

/** 只在 MCP 图片块中编码有上限的预览，原文件下载工具仅返回地址。 */
function formatFileRead(data: unknown): CallToolResult | undefined {
  if (data && typeof data === 'object' && 'url' in data) return
  if (
    data &&
    typeof data === 'object' &&
    'metadata' in data &&
    'bytes' in data &&
    Buffer.isBuffer(data.bytes)
  ) {
    const metadata = ToolOutputs['file.read'].parse(data.metadata)
    return {
      content: [
        { type: 'text', text: JSON.stringify(metadata) },
        { type: 'image', data: data.bytes.toString('base64'), mimeType: metadata.mimeType },
      ],
      structuredContent: metadata,
    }
  }
  const result = ToolOutputs['file.read'].safeParse(data)
  if (!result.success || result.data.encoding !== 'utf8' || result.data.content === undefined)
    throw new DeviceRpcError('INVALID_TOOL_RESULT')
}

/**
 * 注册文件、Git 与命令工具，输入输出均使用 protocol 中的共享契约。
 * @param simple MCP 工具注册入口。
 * @param hub 将操作转发到已认证设备的连接管理器。
 * @param userId 当前已认证用户 ID。
 * @param clientId 当前 OAuth 客户端 ID。
 */
export function registerMcpOperationTools(
  simple: ReturnType<typeof createMcpToolRegistrar>,
  hub: DeviceHub,
  userId: string,
  clientId: string,
) {
  /** 按共享契约注册指定操作，并在转发前校验与规范化 RPC 参数。 */
  const exec = (op: Operation, description: string) =>
    simple(
      op.replace('.', '_'),
      description,
      McpToolInputs[op],
      McpToolOutputs[op],
      async (args, signal) => {
        const { workspaceId, ...payload } = args
        const workspace = String(workspaceId)
        if ((op === 'file.read' || op === 'file.write') && payload.encoding === 'stream') {
          const ticket = await hub.prepareFileTransfer(
            userId,
            clientId,
            workspace,
            op,
            payload,
            env.publicUrl,
          )
          return op === 'file.read'
            ? { encoding: 'stream', ...ticket }
            : { path: payload.path, ...ticket }
        }
        if (op === 'file.read' && payload.encoding === 'preview') {
          return hub.files.preview(
            (transfer) => hub.execute(userId, clientId, workspace, op, { ...payload, transfer }),
            signal,
          )
        }
        // 普通操作已由 SDK 使用共享对象 Schema 校验；命令联合参数在此校验互斥形式并补齐默认值。
        const input = op === 'command.run' ? ToolInputs[op].parse(payload) : payload
        return hub.execute(userId, clientId, workspace, op, input)
      },
      !operationRequiresWrite(op) && op !== 'command.run',
      op === 'file.read' ? formatFileRead : undefined,
    )

  exec('file.list', '列出已授权工作区内指定目录的文件和子目录')
  exec(
    'file.read',
    '默认读取 UTF-8 文本及 SHA-256；encoding=stream 返回原文件下载地址，encoding=preview 返回不超过 512 KiB 的图片预览',
  )
  exec('file.search', '在已授权工作区内搜索包含指定文本的行，返回相对路径、行号和匹配文本')
  exec(
    'file.write',
    '默认写入 UTF-8 文本；原文件上传使用 encoding=stream 并提供精确 size，随后使用原 OAuth Bearer Token 向返回的地址 PUT 原始字节。覆盖必须提供原文件 expectedSha256',
  )
  exec('file.mkdir', '在已授权工作区内创建目录，可选择递归创建父目录')
  exec('file.move', '移动或重命名已授权工作区内的文件或目录')
  exec(
    'file.delete',
    '删除已授权工作区内的文件或目录；递归删除需设置 recursive，并遵循本机审批策略',
  )
  exec('git.status', '查看已授权工作区的 Git 状态')
  exec('git.log', '查看已授权工作区的最近 Git 提交，返回提交哈希、日期、作者和标题')
  exec('git.diff', '查看已授权工作区内允许访问的文件的未暂存 Git 差异')
  exec('git.add', '将已授权工作区内的指定文件加入 Git 暂存区，遵循本机 Git 权限和审批策略')
  exec('git.commit', '提交已授权工作区的当前 Git 暂存区，遵循本机 Git 权限和审批策略')
  exec('command.list', '列出已授权工作区内可用的登记命令，仅返回命令 ID 和名称')
  exec(
    'command.run',
    '在已授权工作区内运行登记命令或临时程序；登记命令遵循本机策略，临时程序始终需要本机单次审批',
  )
}
