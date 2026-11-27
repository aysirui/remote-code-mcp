import { McpToolInputs, McpToolOutputs } from '@rcm/protocol'
import type { McpToolDefinition } from '../register'

/** 查看已授权工作区的最近 Git 提交，返回提交哈希、日期、作者和标题。 */
export const gitLog = {
  name: 'git_log',
  description: '查看已授权工作区的最近 Git 提交，返回提交哈希、日期、作者和标题',
  inputSchema: McpToolInputs['git.log'],
  outputSchema: McpToolOutputs['git.log'],
  execute({ workspaceId, ...payload }, { hub, userId, clientId }) {
    return hub.execute(userId, clientId, workspaceId, 'git.log', payload)
  },
} satisfies McpToolDefinition<(typeof McpToolInputs)['git.log'], unknown>
