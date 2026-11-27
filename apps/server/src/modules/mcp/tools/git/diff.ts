import { McpToolInputs, McpToolOutputs } from '@rcm/protocol'
import type { McpToolDefinition } from '../register'

/** 查看已授权工作区内允许访问的文件的未暂存 Git 差异。 */
export const gitDiff = {
  name: 'git_diff',
  description: '查看已授权工作区内允许访问的文件的未暂存 Git 差异',
  inputSchema: McpToolInputs['git.diff'],
  outputSchema: McpToolOutputs['git.diff'],
  execute({ workspaceId, ...payload }, { hub, userId, clientId }) {
    return hub.execute(userId, clientId, workspaceId, 'git.diff', payload)
  },
} satisfies McpToolDefinition<(typeof McpToolInputs)['git.diff'], unknown>
