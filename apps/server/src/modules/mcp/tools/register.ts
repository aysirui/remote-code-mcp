import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { Store } from '../../../infrastructure/database/store'
import type { DeviceHub } from '../../device/device-hub'
import { DeviceRpcError } from '../../device/device-rpc-pending'

/** 一次已认证 MCP 请求中的设备路由与授权信息。 */
export interface McpToolContext {
  /** 已连接设备及文件传输服务。 */
  hub: DeviceHub
  /** 查询当前用户的设备和工作区。 */
  store: Store
  /** 当前账号 ID。 */
  userId: string
  /** 当前 OAuth 客户端 ID。 */
  clientId: string
  /** 领取原文件传输地址时复查签发授权。 */
  authorizeTransfer: () => Promise<void>
}

/** 工具文件提供契约与执行逻辑，由 MCP 入口统一注册。 */
export interface McpToolDefinition<Input extends z.ZodObject, Result> {
  /** MCP 客户端调用的工具名称。 */
  name: string
  /** 工具用途及适用场景。 */
  description: string
  /** SDK 在执行前校验的参数对象。 */
  inputSchema: Input
  /** MCP 客户端可发现的结构化结果契约。 */
  outputSchema: z.ZodObject
  /** 接收已校验的参数、请求身份和取消信号，返回业务结果。 */
  execute: (args: z.output<Input>, context: McpToolContext, signal: AbortSignal) => Promise<Result>
  /** MCP 客户端使用的只读提示，默认 true。 */
  readOnly?: boolean
  /** 原生内容块等专用响应由工具提供，否则使用统一包装。 */
  formatResult?: (data: Result) => CallToolResult | undefined
  /** 随工具描述符发布的客户端扩展元数据。 */
  meta?: Record<string, unknown>
}

/**
 * 统一包装 MCP 工具的文本、结构化结果和异常；需要图片等内容块时由操作自定义结果。
 * @param server 已创建的 MCP 服务实例。
 * @param tool 由领域文件导出的工具定义。
 * @param context 已认证请求的身份及路由信息。
 * @returns SDK 注册后的工具。
 */
export function register<Input extends z.ZodObject, Result>(
  server: McpServer,
  tool: McpToolDefinition<Input, Result>,
  context: McpToolContext,
) {
  // 只读提示默认开启，修改状态的工具在定义中显式声明 false。
  const { readOnly = true } = tool

  return server.registerTool<z.ZodObject, z.ZodObject>(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: { readOnlyHint: readOnly },
      _meta: tool.meta,
    },
    async (args, extra) => {
      try {
        // SDK 已按传入的同一份 Schema 校验参数，其通用回调类型只保留对象形状。
        const data = await tool.execute(args as z.output<Input>, context, extra?.signal)

        // 自定义响应直接交给 SDK，保留原生内容块和组件元数据。
        const formatted = tool.formatResult?.(data)
        if (formatted) return formatted

        // 结构化响应始终是对象。业务对象保留原字段，数组和其他值使用 value 字段。
        let structuredContent: Record<string, unknown> = { value: data }
        if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
          structuredContent = data as Record<string, unknown>
        }

        // 文本块直接使用字符串，包括空字符串。其他值序列化为 JSON，无表示时使用 null 文本。
        let text = 'null'
        if (typeof data === 'string') {
          text = data
        } else {
          const serialized = JSON.stringify(data)
          if (serialized !== undefined) text = serialized
        }
        return {
          content: [{ type: 'text' as const, text }],
          structuredContent,
        }
      } catch (error: unknown) {
        // 未分类异常使用稳定错误码，避免将内部异常正文交给客户端。
        let text = 'TOOL_EXECUTION_FAILED'
        if (error instanceof DeviceRpcError) {
          text = error.message
          // 命令失败时，仅向发起调用的客户端补充已校验的命令结果。
          if (error.commandResult) {
            text = JSON.stringify({ code: error.message, ...error.commandResult })
          }
        } else if (error instanceof z.ZodError) {
          text = 'INVALID_TOOL_ARGUMENTS'
        }
        return {
          content: [{ type: 'text' as const, text }],
          isError: true,
        }
      }
    },
  )
}
