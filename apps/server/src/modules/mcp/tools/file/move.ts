import { McpToolInputs, McpToolOutputs } from '@rcm/protocol'
import type { McpToolDefinition } from '../register'

/** 移动或重命名已授权工作区内的文件或目录。 */
export const fileMove = {
  name: 'file_move',
  description: '移动或重命名已授权工作区内的文件或目录',
  inputSchema: McpToolInputs['file.move'],
  outputSchema: McpToolOutputs['file.move'],
  readOnly: false,
  execute({ workspaceId, ...payload }, { hub, userId, clientId }) {
    return hub.execute(userId, clientId, workspaceId, 'file.move', payload)
  },
} satisfies McpToolDefinition<(typeof McpToolInputs)['file.move'], unknown>
