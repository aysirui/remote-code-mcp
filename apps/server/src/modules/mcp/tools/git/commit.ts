import { McpToolInputs, McpToolOutputs } from '@rcm/protocol'
import type { McpToolDefinition } from '../register'

/** 提交已授权工作区的当前 Git 暂存区，遵循本机 Git 权限和审批策略。 */
export const gitCommit = {
  name: 'git_commit',
  description: '提交已授权工作区的当前 Git 暂存区，遵循本机 Git 权限和审批策略',
  inputSchema: McpToolInputs['git.commit'],
  outputSchema: McpToolOutputs['git.commit'],
  readOnly: false,
  execute({ workspaceId, ...payload }, { hub, userId, clientId }) {
    return hub.execute(userId, clientId, workspaceId, 'git.commit', payload)
  },
} satisfies McpToolDefinition<(typeof McpToolInputs)['git.commit'], unknown>
