import { McpToolInputs, McpToolOutputs, ToolOutputs } from '@rcm/protocol'
import type { z } from 'zod'
import { env } from '../../../../config/env'
import { DeviceRpcError } from '../../../device/device-rpc-pending'
import type { McpToolContext } from '../register'

const inputSchema = McpToolInputs['file.read']

/**
 * 读取文本或签发原文件下载地址。
 * @param input 目标工作区、相对路径和读取方式。
 * @param context 请求身份、设备路由及下载授权复查。
 * @returns 文本正文及摘要，或一次性下载凭据。
 */
async function readFile(
  { workspaceId, ...payload }: z.output<typeof inputSchema>,
  { hub, userId, clientId, authorizeDownload }: McpToolContext,
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
  // 文本读取必须包含正文，空文件的正文为空字符串。
  const result = ToolOutputs['file.read'].safeParse(
    await hub.execute(userId, clientId, workspaceId, 'file.read', payload),
  )
  if (!result.success || result.data.encoding !== 'utf8' || result.data.content === undefined)
    throw new DeviceRpcError('INVALID_TOOL_RESULT')
  return result.data
}

// 旧 inline 模式通过 MCP content 返回 ImageContent（type: 'image'），structuredContent 只含元数据。
// 部分 AI 客户端未将图片块传给模型，模型只能读取元数据，无法据此分析图片。
/** file_read 向 MCP 客户端提供文本读取和原文件下载。 */
export const fileRead = {
  name: 'file_read',
  description:
    '读取工作区文件。默认 utf8 读取最多 512 KiB 的文本。stream 签发一次性下载地址，须实际 GET 才能取得最多 64 MiB 的原文件。支持 MCP Apps 的客户端可用 file_preview 展示媒体',
  inputSchema,
  outputSchema: McpToolOutputs['file.read'],
  execute: readFile,
}
