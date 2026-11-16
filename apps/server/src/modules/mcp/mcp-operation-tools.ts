import { operationRequiresWrite, type RpcRequest } from '@rcm/protocol'
import { z } from 'zod'
import { DeviceHub } from '../device/device-hub'
import { createMcpToolRegistrar } from './mcp-tool-registration'

/** 注册文件、Git 与命令 RPC 工具，参数校验和权限提示沿用既有 MCP 契约。 */
export function registerMcpOperationTools(
  simple: ReturnType<typeof createMcpToolRegistrar>,
  hub: DeviceHub,
  userId: string,
  clientId: string,
) {
  const exec = (op: RpcRequest['operation'], fields: Record<string, z.ZodTypeAny>) =>
    simple(
      op.replace('.', '_'),
      `Execute ${op} on your authorized local workspace`,
      { workspaceId: z.string(), ...fields },
      async (args) => {
        const { workspaceId, ...payload } = args
        return hub.execute(userId, clientId, String(workspaceId), op, payload)
      },
      !operationRequiresWrite(op) && op !== 'command.run',
    )

  exec('file.list', { path: z.string().default('.') })
  exec('file.read', { path: z.string() })
  exec('file.search', { path: z.string().default('.'), query: z.string() })
  exec('file.write', {
    path: z.string(),
    content: z.string().max(524288),
    expectedSha256: z.string().optional(),
  })
  exec('file.mkdir', { path: z.string().min(1).max(500), recursive: z.boolean().default(false) })
  exec('file.move', { from: z.string().min(1).max(500), to: z.string().min(1).max(500) })
  exec('file.delete', {
    path: z.string().min(1).max(500),
    recursive: z.boolean().default(false),
    expectedSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  exec('git.status', {})
  exec('git.log', { limit: z.number().int().min(1).max(50).default(10) })
  exec('git.diff', {})
  exec('git.add', { paths: z.array(z.string().min(1).max(500)).min(1).max(50) })
  exec('git.commit', { message: z.string().trim().min(1).max(500) })
  exec('command.list', {})
  exec('command.run', {
    command: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{1,39}$/)
      .optional()
      .describe('本地登记的命令 ID；与 executable、args 互斥'),
    executable: z
      .string()
      .trim()
      .min(1)
      .max(260)
      .optional()
      .describe('未登记命令的可执行程序；此形式始终需要本机单次审批'),
    args: z
      .array(z.string().max(500))
      .max(20)
      .optional()
      .describe('临时命令的完整参数数组；仅与 executable 一起使用'),
  })
}
