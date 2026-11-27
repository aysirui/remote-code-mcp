import { McpToolInputs, McpToolOutputs } from '@rcm/protocol'
import type { McpToolDefinition } from '../register'

/** 在已授权工作区内搜索包含指定文本的行，返回相对路径、行号和匹配文本。 */
export const fileSearch = {
  name: 'file_search',
  description: '在已授权工作区内搜索包含指定文本的行，返回相对路径、行号和匹配文本',
  inputSchema: McpToolInputs['file.search'],
  outputSchema: McpToolOutputs['file.search'],
  execute({ workspaceId, ...payload }, { hub, userId, clientId }) {
    return hub.execute(userId, clientId, workspaceId, 'file.search', payload)
  },
} satisfies McpToolDefinition<(typeof McpToolInputs)['file.search'], unknown>
