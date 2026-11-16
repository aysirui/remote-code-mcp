import type { RpcRequest, CommandAudit } from '@rcm/protocol'
import { Store } from '../../infrastructure/database/store'

/** 仅保存执行元数据与 Runtime 提供的脱敏命令审计，不记录工具参数或结果正文。 */
export async function recordDeviceOperation(
  store: Store,
  entry: {
    operationId: string
    userId: string
    deviceId?: string
    workspaceId: string
    clientId: string
    operation: RpcRequest['operation']
    status: 'success' | 'failed'
    durationMs: number
    errorCode?: string
    commandAudit?: CommandAudit
  },
): Promise<void> {
  const prefix = entry.operation.split('.')[0]
  const operationType = prefix === 'file' || prefix === 'git' ? prefix : 'command'
  // 日志失败只记录异常类型，不影响 RPC 的执行结果。
  try {
    await store.logOperation({
      operationId: entry.operationId,
      userId: entry.userId,
      deviceId: entry.deviceId,
      workspaceId: entry.workspaceId,
      clientId: entry.clientId,
      toolName: entry.operation.replace('.', '_'),
      operationType,
      status: entry.status,
      durationMs: entry.durationMs,
      errorCode: entry.errorCode,
      commandAudit: entry.commandAudit,
    })
  } catch (logError: unknown) {
    console.error(
      'Operation metadata write failed',
      logError instanceof Error ? logError.name : 'UnknownError',
    )
  }
}
