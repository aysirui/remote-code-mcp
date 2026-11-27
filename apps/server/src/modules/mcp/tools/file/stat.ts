import { McpToolInputs, McpToolOutputs } from '@rcm/protocol'
import type { McpToolDefinition } from '../register'

/** 查询路径类型及文件原始字节数，可用于核对读取上限。 */
export const fileStat = {
  name: 'file_stat',
  description: '查询路径类型及文件原始字节数，可在读取前核对大小上限',
  inputSchema: McpToolInputs['file.stat'],
  outputSchema: McpToolOutputs['file.stat'],
  execute({ workspaceId, ...payload }, { hub, userId, clientId }) {
    return hub.execute(userId, clientId, workspaceId, 'file.stat', payload)
  },
} satisfies McpToolDefinition<(typeof McpToolInputs)['file.stat'], unknown>
