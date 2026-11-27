import { FILE_BINARY_LIMIT_BYTES, McpToolInputs, McpToolOutputs } from '@rcm/protocol'
import { env } from '../../../../config/env'
import { DeviceRpcError } from '../../../device/device-rpc-pending'
import type { McpToolDefinition } from '../register'

/** 检查客户端提供的附件地址，只允许 Server 已配置的 HTTPS 源。 */
function resolveAttachmentUrl(downloadUrl: string): URL {
  const url = new URL(downloadUrl)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    !env.mcpAttachmentOrigins.includes(url.origin)
  )
    throw new DeviceRpcError('FILE_ATTACHMENT_URL_DENIED')
  return url
}

/** 产出完整原始字节；重定向、不完整响应、取消及超限均中止中继。 */
async function* readAttachment(url: URL, signal: AbortSignal) {
  try {
    const response = await fetch(url, { signal, redirect: 'error' })
    const length = response.headers.get('content-length')
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel()
      throw new DeviceRpcError('FILE_ATTACHMENT_DOWNLOAD_FAILED')
    }
    if (length !== null && Number(length) > FILE_BINARY_LIMIT_BYTES) {
      await response.body.cancel()
      throw new DeviceRpcError('FILE_TOO_LARGE')
    }
    yield* response.body
  } catch (error) {
    if (error instanceof DeviceRpcError) throw error
    throw new DeviceRpcError('FILE_ATTACHMENT_DOWNLOAD_FAILED')
  }
}

/** file_write 的契约，支持文本、签发上传地址和附件写入。 */
export const fileWrite = {
  name: 'file_write',
  description:
    '将实际内容写入工作区。attachment 从服务端信任的附件地址取回并写入；utf8 写入文本；stream 签发地址，由带 OAuth 凭据的客户端 PUT 完整字节。覆盖须提供基于原版本的 expectedSha256；written=true 表示文件落盘',
  inputSchema: McpToolInputs['file.write'],
  outputSchema: McpToolOutputs['file.write'],
  readOnly: false,
  // ChatGPT 可识别此扩展并填入文件参数；其他客户端按同一输入契约传参。
  meta: { 'openai/fileParams': ['file'] },
  async execute(
    { workspaceId, file, ...payload },
    { hub, userId, clientId, authorizeDownload },
    signal,
  ) {
    if (payload.encoding === 'attachment') {
      // 附件地址留在 Server，Runtime 只接收写入参数和设备传输凭据。
      const url = resolveAttachmentUrl(file!.download_url)
      return hub.files.writeFromSource(
        (transferSignal) => readAttachment(url, transferSignal),
        (transfer) =>
          hub.execute(userId, clientId, workspaceId, 'file.write', {
            path: payload.path,
            encoding: 'stream',
            expectedSha256: payload.expectedSha256,
            transfer,
          }),
        signal,
      )
    }
    if (payload.encoding === 'stream') {
      const ticket = await hub.prepareFileTransfer(
        userId,
        clientId,
        workspaceId,
        'file.write',
        payload,
        env.publicUrl,
        authorizeDownload,
      )
      return { path: payload.path, ...ticket }
    }
    return hub.execute(userId, clientId, workspaceId, 'file.write', payload)
  },
} satisfies McpToolDefinition<(typeof McpToolInputs)['file.write'], unknown>
