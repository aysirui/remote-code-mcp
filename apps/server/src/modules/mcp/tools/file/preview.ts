import { readFileSync } from 'node:fs'
import path from 'node:path'
import { McpToolInputs, ToolOutputs } from '@rcm/protocol'
import { z } from 'zod'
import type { McpToolContext } from '../register'

/** 组件资源随 Server 分发，URI 同时用于宿主缓存。 */
export const filePreviewResource = {
  name: '文件预览',
  uri: 'ui://rcm/file-preview-v3.html',
  mimeType: 'text/html;profile=mcp-app',
  description: '在 MCP Apps 客户端显示已授权的图片、音频和视频',
  text: readFileSync(
    path.resolve(__dirname, '../../../../../assets/mcp/file-preview.html'),
    'utf8',
  ),
}

const inputSchema = McpToolInputs['file.read'].pick({ workspaceId: true, path: true })
/** 模型可见的预览元数据，媒体数据由 MCP Apps 宿主交给组件。 */
const outputSchema = ToolOutputs['file.read']
  .pick({ mimeType: true, size: true, sha256: true, originalSize: true })
  .extend({ name: z.string().describe('预览媒体的文件名') })

/** 沿用工作区读取授权，取得原媒体或缩略图以及卡片所需的元数据。 */
async function previewFile(
  { workspaceId, path: relative }: z.output<typeof inputSchema>,
  { hub, userId, clientId }: McpToolContext,
  signal: AbortSignal,
) {
  const preview = await hub.files.readInline(
    (transfer) =>
      hub.execute(userId, clientId, workspaceId, 'file.read', {
        path: relative,
        encoding: 'inline',
        mediaPreview: true,
        transfer,
      }),
    signal,
  )
  return {
    bytes: preview.bytes,
    originalFile:
      preview.metadata.originalSize === undefined ? undefined : { workspaceId, path: relative },
    metadata: outputSchema.parse({
      ...preview.metadata,
      name: path.posix.basename(relative),
    }),
  }
}

/** file_preview 的工具契约及组件专用响应。 */
export const filePreview = {
  name: 'file_preview',
  description:
    '在对话中展示媒体时使用。小媒体展示原文件，大图展示缩略图并提供原图下载。要分析、编辑或处理原文件时，使用 file_read 获取完整内容',
  inputSchema,
  outputSchema,
  execute: previewFile,
  meta: { ui: { resourceUri: filePreviewResource.uri } },
  formatResult: ({ bytes, metadata, originalFile }: Awaited<ReturnType<typeof previewFile>>) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(metadata) }],
    structuredContent: metadata,
    _meta: { 'rcm/previewMedia': bytes.toString('base64'), 'rcm/originalFile': originalFile },
  }),
}
