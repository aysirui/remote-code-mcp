import { McpToolInputs, McpToolOutputs } from '@rcm/protocol'
import type { McpToolDefinition } from '../register'

/** 删除已授权工作区内的文件或目录；递归删除需设置 recursive，并遵循本机审批策略。 */
export const fileDelete = {
  name: 'file_delete',
  description: '删除已授权工作区内的文件或目录；递归删除需设置 recursive，并遵循本机审批策略',
  inputSchema: McpToolInputs['file.delete'],
  outputSchema: McpToolOutputs['file.delete'],
  readOnly: false,
  execute({ workspaceId, ...payload }, { hub, userId, clientId }) {
    return hub.execute(userId, clientId, workspaceId, 'file.delete', payload)
  },
} satisfies McpToolDefinition<(typeof McpToolInputs)['file.delete'], unknown>
