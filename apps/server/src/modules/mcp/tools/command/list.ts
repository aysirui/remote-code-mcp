import { McpToolInputs, McpToolOutputs } from '@rcm/protocol'
import type { McpToolDefinition } from '../register'

/** 列出已授权工作区内可用的登记命令，仅返回命令 ID 和名称。 */
export const commandList = {
  name: 'command_list',
  description: '列出已授权工作区内可用的登记命令，仅返回命令 ID 和名称',
  inputSchema: McpToolInputs['command.list'],
  outputSchema: McpToolOutputs['command.list'],
  execute({ workspaceId, ...payload }, { hub, userId, clientId }) {
    return hub.execute(userId, clientId, workspaceId, 'command.list', payload)
  },
} satisfies McpToolDefinition<(typeof McpToolInputs)['command.list'], unknown>
