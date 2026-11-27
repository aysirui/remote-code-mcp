import { McpToolInputs, McpToolOutputs, ToolInputs } from '@rcm/protocol'
import type { McpToolDefinition } from '../register'

/** command_run 的工具契约，区分登记命令和临时程序。 */
export const commandRun = {
  name: 'command_run',
  description:
    '在已授权工作区内运行登记命令或临时程序；登记命令遵循本机策略，临时程序始终需要本机单次审批',
  inputSchema: McpToolInputs['command.run'],
  outputSchema: McpToolOutputs['command.run'],
  readOnly: false,
  execute({ workspaceId, ...payload }, { hub, userId, clientId }) {
    // 校验两种命令参数的互斥关系，并补齐临时命令的默认参数。
    return hub.execute(
      userId,
      clientId,
      workspaceId,
      'command.run',
      ToolInputs['command.run'].parse(payload),
    )
  },
} satisfies McpToolDefinition<(typeof McpToolInputs)['command.run'], unknown>
