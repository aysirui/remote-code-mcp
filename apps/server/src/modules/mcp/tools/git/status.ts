import { McpToolInputs, McpToolOutputs } from '@rcm/protocol'
import type { McpToolDefinition } from '../register'

/** 查看已授权工作区的 Git 状态。 */
export const gitStatus = {
  name: 'git_status',
  description: '查看已授权工作区的 Git 状态',
  inputSchema: McpToolInputs['git.status'],
  outputSchema: McpToolOutputs['git.status'],
  execute({ workspaceId, ...payload }, { hub, userId, clientId }) {
    return hub.execute(userId, clientId, workspaceId, 'git.status', payload)
  },
} satisfies McpToolDefinition<(typeof McpToolInputs)['git.status'], unknown>
