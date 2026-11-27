import { McpToolInputs, McpToolOutputs } from '@rcm/protocol'
import type { McpToolDefinition } from '../register'

/** 列出已授权工作区内指定目录的文件和子目录。 */
export const fileList = {
  name: 'file_list',
  description: '列出已授权工作区内指定目录的文件和子目录',
  inputSchema: McpToolInputs['file.list'],
  outputSchema: McpToolOutputs['file.list'],
  execute({ workspaceId, ...payload }, { hub, userId, clientId }) {
    return hub.execute(userId, clientId, workspaceId, 'file.list', payload)
  },
} satisfies McpToolDefinition<(typeof McpToolInputs)['file.list'], unknown>
