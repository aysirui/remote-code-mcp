import { McpToolInputs, McpToolOutputs } from '@rcm/protocol'
import type { McpToolDefinition } from '../register'

/** 在已授权工作区内创建目录，可选择递归创建父目录。 */
export const fileMkdir = {
  name: 'file_mkdir',
  description: '在已授权工作区内创建目录，可选择递归创建父目录',
  inputSchema: McpToolInputs['file.mkdir'],
  outputSchema: McpToolOutputs['file.mkdir'],
  readOnly: false,
  execute({ workspaceId, ...payload }, { hub, userId, clientId }) {
    return hub.execute(userId, clientId, workspaceId, 'file.mkdir', payload)
  },
} satisfies McpToolDefinition<(typeof McpToolInputs)['file.mkdir'], unknown>
