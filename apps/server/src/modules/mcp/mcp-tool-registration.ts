import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

/** 统一包装 MCP 工具的文本结果、结构化结果和异常响应，保持现有协议格式。 */
export function createMcpToolRegistrar(server: McpServer) {
  return (
    name: string,
    description: string,
    inputSchema: Record<string, z.ZodTypeAny>,
    handler: (args: Record<string, unknown>) => Promise<unknown>,
    readOnly = true,
  ) =>
    server.registerTool(
      name,
      { description, inputSchema, annotations: { readOnlyHint: readOnly } },
      async (args) => {
        try {
          const data = await handler(args)
          const objectData =
            typeof data === 'object' && data !== null && !Array.isArray(data)
              ? (data as Record<string, unknown>)
              : null
          const readable =
            objectData && typeof objectData.content === 'string'
              ? objectData.content +
                (typeof objectData.sha256 === 'string' ? '\n\nSHA-256: ' + objectData.sha256 : '')
              : typeof data === 'string'
                ? data
                : (JSON.stringify(data) ?? 'null')
          return {
            content: [{ type: 'text' as const, text: readable }],
            structuredContent: objectData ?? { value: data },
          }
        } catch (error: unknown) {
          return {
            content: [
              {
                type: 'text' as const,
                text: error instanceof Error ? error.message : String(error),
              },
            ],
            isError: true,
          }
        }
      },
    )
}
