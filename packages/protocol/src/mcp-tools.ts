import { z } from 'zod'
import { ToolInputs } from './tool-inputs'
import { ToolOutputs } from './tool-outputs'
import { WorkspacePoliciesSchema } from './workspace'

/** MCP 操作的目标工作区标识；不包含 Runtime 本地路径。 */
const workspaceId = z.string().describe('已授权的工作区 ID，通过 workspace_list 获取')

/** MCP 输入契约：从 RPC 参数派生，仅增加工作区路由字段。 */
export const McpToolInputs = {
  device_list: z.object({}),
  workspace_list: z.object({}),
  'file.list': ToolInputs['file.list'].extend({ workspaceId }),
  'file.read': ToolInputs['file.read'].extend({ workspaceId }),
  'file.search': ToolInputs['file.search'].extend({ workspaceId }),
  'file.write': ToolInputs['file.write'].extend({ workspaceId }),
  'file.mkdir': ToolInputs['file.mkdir'].extend({ workspaceId }),
  'file.move': ToolInputs['file.move'].extend({ workspaceId }),
  'file.delete': ToolInputs['file.delete'].extend({ workspaceId }),
  'git.status': ToolInputs['git.status'].extend({ workspaceId }),
  'git.log': ToolInputs['git.log'].extend({ workspaceId }),
  'git.diff': ToolInputs['git.diff'].extend({ workspaceId }),
  'git.add': ToolInputs['git.add'].extend({ workspaceId }),
  'git.commit': ToolInputs['git.commit'].extend({ workspaceId }),
  'command.list': ToolInputs['command.list'].extend({ workspaceId }),
  // MCP SDK 要求对象输入；字段复用联合契约，两种形式的互斥校验在转发前使用原契约执行。
  'command.run': z
    .object({
      workspaceId,
      command: ToolInputs['command.run'].options[0].shape.command.optional(),
      executable: ToolInputs['command.run'].options[1].shape.executable.optional(),
      args: ToolInputs['command.run'].options[1].shape.args
        .unwrap()
        .optional()
        .describe(ToolInputs['command.run'].options[1].shape.args.description!),
    })
    .strict(),
}

/** MCP 输出契约：对象沿用原结果，数组和字符串保留既有的 value 包装。 */
export const McpToolOutputs = {
  device_list: z.object({
    value: z
      .array(
        z.object({
          id: z.string().describe('设备 ID'),
          name: z.string().describe('设备显示名称'),
          online: z.boolean().describe('设备当前是否在线'),
          status: z.string().describe('设备登记状态'),
        }),
      )
      .describe('当前用户的设备列表'),
  }),
  workspace_list: z.object({
    value: z
      .array(
        z.object({
          workspaceId: z.string().describe('已授权的工作区 ID，用于调用工作区工具'),
          name: z.string().describe('工作区显示名称'),
          deviceId: z.string().describe('工作区所属设备 ID'),
          read: z.boolean().describe('工作区当前是否允许读取'),
          write: z.boolean().describe('工作区当前是否允许写入'),
          enabled: z.boolean().describe('工作区授权是否已启用'),
          policies: WorkspacePoliciesSchema.describe('文件、Git 和命令的本机访问策略'),
          online: z.boolean().describe('工作区所属设备当前是否在线'),
        }),
      )
      .describe('当前用户的已授权工作区列表，不包含本地绝对路径'),
  }),
  'file.list': z.object({ value: ToolOutputs['file.list'].describe('指定目录的可访问目录项列表') }),
  'file.read': ToolOutputs['file.read'],
  'file.search': z.object({ value: ToolOutputs['file.search'].describe('搜索匹配结果列表') }),
  'file.write': ToolOutputs['file.write'],
  'file.mkdir': ToolOutputs['file.mkdir'],
  'file.move': ToolOutputs['file.move'],
  'file.delete': ToolOutputs['file.delete'],
  'git.status': z.object({ value: ToolOutputs['git.status'] }),
  'git.log': z.object({ value: ToolOutputs['git.log'].describe('最近的 Git 提交列表') }),
  'git.diff': z.object({ value: ToolOutputs['git.diff'] }),
  'git.add': ToolOutputs['git.add'],
  'git.commit': ToolOutputs['git.commit'],
  'command.list': z.object({
    value: ToolOutputs['command.list'].describe('可用登记命令的公开信息列表'),
  }),
  'command.run': ToolOutputs['command.run'],
}
