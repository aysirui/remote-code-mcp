import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { McpToolInputs, McpToolOutputs, ToolOutputs, type ToolOutput } from '@rcm/protocol'
import type { z } from 'zod'
import { env } from '../../../../config/env'
import { DeviceRpcError } from '../../../device/device-rpc-pending'
import type { McpToolContext } from '../register'

const inputSchema = McpToolInputs['file.read']

/** 读取文本、通过设备流取得内联字节，或签发原文件下载地址。 */
async function readFile(
  { workspaceId, ...payload }: z.output<typeof inputSchema>,
  { hub, userId, clientId, authorizeDownload }: McpToolContext,
  signal: AbortSignal,
) {
  if (payload.encoding === 'stream') {
    const ticket = await hub.prepareFileTransfer(
      userId,
      clientId,
      workspaceId,
      'file.read',
      payload,
      env.publicUrl,
      authorizeDownload,
    )
    return { encoding: 'stream', ...ticket }
  }
  if (payload.encoding === 'inline') {
    return hub.files.readInline(
      (transfer) =>
        hub.execute(userId, clientId, workspaceId, 'file.read', { ...payload, transfer }),
      signal,
    )
  }

  const result = ToolOutputs['file.read'].safeParse(
    await hub.execute(userId, clientId, workspaceId, 'file.read', payload),
  )
  if (!result.success || result.data.encoding !== 'utf8' || result.data.content === undefined)
    throw new DeviceRpcError('INVALID_TOOL_RESULT')
  return result.data
}

/** 将已校验的字节编码为 MCP 内容块，结构化结果只保留文件元数据。 */
function formatInlineFile(bytes: Buffer, metadata: ToolOutput<'file.read'>): CallToolResult {
  const { mimeType, sha256 } = metadata
  const base64 = bytes.toString('base64')
  let file: CallToolResult['content'][number]
  if (mimeType.startsWith('image/')) {
    file = { type: 'image', data: base64, mimeType }
  } else if (mimeType.startsWith('audio/')) {
    file = { type: 'audio', data: base64, mimeType }
  } else {
    // 按文件摘要标识内嵌资源，客户端可直接取得完整内容。
    file = { type: 'resource', resource: { uri: 'urn:sha256:' + sha256, mimeType, blob: base64 } }
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(metadata) }, file],
    structuredContent: metadata,
  }
}

/** file_read 的工具契约及内联响应。 */
export const fileRead = {
  name: 'file_read',
  description:
    '读取工作区原始文件。utf8 读取文本；inline 在 MCP 内容块中返回最多 512 KiB 的完整字节；stream 签发下载地址，须实际 GET 才取得完整原文件，最多 64 MiB。大小未知时可查 file_stat。仅在对话中查看媒体时使用 file_preview',
  inputSchema,
  outputSchema: McpToolOutputs['file.read'],
  execute: readFile,
  formatResult: (result: Awaited<ReturnType<typeof readFile>>) =>
    'bytes' in result ? formatInlineFile(result.bytes, result.metadata) : undefined,
}
