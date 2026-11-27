import { FILE_BINARY_LIMIT_BYTES, McpToolInputs, McpToolOutputs } from '@rcm/protocol'
import { env } from '../../../../config/env'
import { DeviceRpcError } from '../../../device/device-rpc-pending'
import type { McpToolDefinition } from '../register'

/** 短链接最多跳转三次，每一跳都必须属于已配置的 HTTPS 源。 */
const ATTACHMENT_REDIRECT_LIMIT = 3

/** 校验初始附件地址或重定向目标，只允许 Server 已配置的 HTTPS 源。 */
function resolveAttachmentUrl(url: URL): URL {
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

/**
 * 供设备写入流读取附件，只接受完整响应，并在访问下一跳前检查其 HTTPS 源。
 * @param initialUrl 已校验的初始附件地址。
 * @param mimeType 客户端声明的附件类型，用于识别图片链接返回的网页。
 * @param signal 设备传输的中断信号。
 * @returns 上游附件的原始字节流。
 */
async function* readAttachment(initialUrl: URL, mimeType: string | undefined, signal: AbortSignal) {
  let url = initialUrl
  try {
    for (let redirects = 0; ; redirects++) {
      const response = await fetch(url, { signal, redirect: 'manual' })
      const location = response.headers.get('location')
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel()
        if (!location || redirects >= ATTACHMENT_REDIRECT_LIMIT) {
          console.warn('附件下载重定向无效或超限', response.status)
          throw new DeviceRpcError('FILE_ATTACHMENT_DOWNLOAD_FAILED')
        }
        url = resolveAttachmentUrl(new URL(location, url))
        continue
      }
      const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
      // 图片短链接可能返回 HTTP 200 的预览页，不能把网页正文当作图片落盘。
      const imageLandingPage =
        mimeType?.toLowerCase().startsWith('image/') &&
        (contentType === 'text/html' || contentType === 'application/xhtml+xml')
      if (response.status !== 200 || !response.body || imageLandingPage) {
        await response.body?.cancel()
        // 只记录状态和失败类型，附件地址可能包含临时凭据。
        console.warn(
          imageLandingPage ? '图片附件地址返回网页' : '附件下载响应不可用',
          response.status,
        )
        throw new DeviceRpcError('FILE_ATTACHMENT_DOWNLOAD_FAILED')
      }
      const length = response.headers.get('content-length')
      if (length !== null && Number(length) > FILE_BINARY_LIMIT_BYTES) {
        await response.body.cancel()
        throw new DeviceRpcError('FILE_TOO_LARGE')
      }
      yield* response.body
      return
    }
  } catch (error) {
    if (error instanceof DeviceRpcError) throw error
    if (!signal.aborted) console.warn('附件下载连接或字节流中断')
    throw new DeviceRpcError('FILE_ATTACHMENT_DOWNLOAD_FAILED')
  }
}

/** file_write 的契约，支持文本、签发上传地址和附件写入。 */
export const fileWrite = {
  name: 'file_write',
  description:
    '将实际内容写入工作区。attachment 从服务端信任的附件地址取回并写入；utf8 写入文本；stream 签发五分钟内有效的一次性地址，直接 PUT 完整原始字节，无需 OAuth 请求头。覆盖须提供基于原版本的 expectedSha256；written=true 表示文件落盘',
  inputSchema: McpToolInputs['file.write'],
  outputSchema: McpToolOutputs['file.write'],
  readOnly: false,
  // ChatGPT 可识别此扩展并填入文件参数；其他客户端按同一输入契约传参。
  meta: { 'openai/fileParams': ['file'] },
  async execute(
    { workspaceId, file, ...payload },
    { hub, userId, clientId, authorizeTransfer },
    signal,
  ) {
    if (payload.encoding === 'attachment') {
      // 附件地址留在 Server，Runtime 只接收写入参数和设备传输凭据。
      const { download_url, mime_type } = file!
      const url = resolveAttachmentUrl(new URL(download_url))
      return hub.files.writeFromSource(
        (transferSignal) => readAttachment(url, mime_type, transferSignal),
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
        authorizeTransfer,
      )
      return { path: payload.path, ...ticket }
    }
    return hub.execute(userId, clientId, workspaceId, 'file.write', payload)
  },
} satisfies McpToolDefinition<(typeof McpToolInputs)['file.write'], unknown>
