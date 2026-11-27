import { McpToolInputs, McpToolOutputs } from '@rcm/protocol'
import type { McpToolDefinition } from '../register'

/** 将已授权工作区内的指定文件加入 Git 暂存区，遵循本机 Git 权限和审批策略。 */
export const gitAdd = {
  name: 'git_add',
  description: '将已授权工作区内的指定文件加入 Git 暂存区，遵循本机 Git 权限和审批策略',
  inputSchema: McpToolInputs['git.add'],
  outputSchema: McpToolOutputs['git.add'],
  readOnly: false,
  execute({ workspaceId, ...payload }, { hub, userId, clientId }) {
    return hub.execute(userId, clientId, workspaceId, 'git.add', payload)
  },
} satisfies McpToolDefinition<(typeof McpToolInputs)['git.add'], unknown>
