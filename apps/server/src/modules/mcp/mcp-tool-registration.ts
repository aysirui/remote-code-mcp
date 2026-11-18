import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { DeviceRpcError } from '../device/device-rpc-pending'

/**
 * 统一包装 MCP 工具的文本结果、结构化结果和异常响应，保持现有协议格式。
 * @param server 已创建的 MCP 服务实例。
 * @returns 工具注册函数，接收名称、中文描述、共享输入输出 Schema、执行回调和只读提示。
 */
export function createMcpToolRegistrar(server: McpServer) {
  return (
    name: string,
    description: string,
    inputSchema: z.ZodObject,
    outputSchema: z.ZodObject,
    handler: (args: Record<string, unknown>) => Promise<unknown>,
    readOnly = true,
  ) =>
    server.registerTool(
      name,
      { description, inputSchema, outputSchema, annotations: { readOnlyHint: readOnly } },
      async (args) => {
        try {
          const data = await handler(args)
          const objectData =
            typeof data === 'object' && data !== null && !Array.isArray(data)
              ? (data as Record<string, unknown>)
              : null
          // 对象结果保留字段边界，避免将文件摘要等元数据混入正文。
          const readable = typeof data === 'string' ? data : (JSON.stringify(data) ?? 'null')
          return {
            content: [{ type: 'text' as const, text: readable }],
            structuredContent: objectData ?? { value: data },
          }
        } catch (error: unknown) {
          const code =
            error instanceof DeviceRpcError
              ? error.message
              : error instanceof z.ZodError
                ? 'INVALID_TOOL_ARGUMENTS'
                : 'TOOL_EXECUTION_FAILED'
          const result = error instanceof DeviceRpcError ? error.commandResult : undefined
          return {
            content: [
              {
                type: 'text' as const,
                // 命令失败仍回传已校验的结果，仅供本次调用读取；其他异常只回传公开错误码。
                text: result ? JSON.stringify({ code, ...result }) : code,
              },
            ],
            isError: true,
          }
        }
      },
    )
}
