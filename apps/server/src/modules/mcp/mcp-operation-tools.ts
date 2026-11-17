import {
  ToolInputs,
  McpToolInputs,
  McpToolOutputs,
  operationRequiresWrite,
  type Operation,
} from '@rcm/protocol'
import { DeviceHub } from '../device/device-hub'
import { createMcpToolRegistrar } from './mcp-tool-registration'

/**
 * 注册文件、Git 与命令工具，输入输出均使用 protocol 中的共享契约。
 * @param simple MCP 工具注册入口。
 * @param hub 将操作转发到已认证设备的连接管理器。
 * @param userId 当前已认证用户 ID。
 * @param clientId 当前 OAuth 客户端 ID。
 */
export function registerMcpOperationTools(
  simple: ReturnType<typeof createMcpToolRegistrar>,
  hub: DeviceHub,
  userId: string,
  clientId: string,
) {
  /** 按共享契约注册指定操作，并在转发前校验与规范化 RPC 参数。 */
  const exec = (op: Operation, description: string) =>
    simple(
      op.replace('.', '_'),
      description,
      McpToolInputs[op],
      McpToolOutputs[op],
      async (args) => {
        const { workspaceId, ...payload } = args
        // 普通操作已由 SDK 使用共享对象 Schema 校验；命令联合参数在此校验互斥形式并补齐默认值。
        const input = op === 'command.run' ? ToolInputs[op].parse(payload) : payload
        return hub.execute(userId, clientId, String(workspaceId), op, input)
      },
      !operationRequiresWrite(op) && op !== 'command.run',
    )

  exec('file.list', '列出已授权工作区内指定目录的文件和子目录')
  exec('file.read', '读取已授权工作区内的文件，返回原始正文和 SHA-256 摘要')
  exec('file.search', '在已授权工作区内搜索包含指定文本的行，返回相对路径、行号和匹配文本')
  exec(
    'file.write',
    '向已授权工作区内写入文件；可通过 expectedSha256 检查原文件版本，返回写入后的摘要',
  )
  exec('file.mkdir', '在已授权工作区内创建目录，可选择递归创建父目录')
  exec('file.move', '移动或重命名已授权工作区内的文件或目录')
  exec(
    'file.delete',
    '删除已授权工作区内的文件或目录；递归删除需设置 recursive，并遵循本机审批策略',
  )
  exec('git.status', '查看已授权工作区的 Git 状态')
  exec('git.log', '查看已授权工作区的最近 Git 提交，返回提交哈希、日期、作者和标题')
  exec('git.diff', '查看已授权工作区内允许访问的文件的未暂存 Git 差异')
  exec('git.add', '将已授权工作区内的指定文件加入 Git 暂存区，遵循本机 Git 权限和审批策略')
  exec('git.commit', '提交已授权工作区的当前 Git 暂存区，遵循本机 Git 权限和审批策略')
  exec('command.list', '列出已授权工作区内可用的登记命令，仅返回命令 ID 和名称')
  exec(
    'command.run',
    '在已授权工作区内运行登记命令或临时程序；登记命令遵循本机策略，临时程序始终需要本机单次审批',
  )
}
