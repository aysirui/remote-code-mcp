import { WebSocket } from 'ws'
import {
  RpcResponseSchema,
  rpcPublicErrorCode,
  COMMAND_OUTPUT_LIMIT_BYTES,
  CommandResultErrorCodeSchema,
  ToolOutputs,
  type CommandAudit,
  type RpcRequest,
  type ToolOutput,
} from '@rcm/protocol'

/** 安全的 Server 工具执行错误；可附带仅供原 MCP 调用读取的命令结果。 */
export class DeviceRpcError extends Error {
  /** @param code 已校验的公开错误码。 @param commandResult 已校验的限长命令结果，不得写入审计。 */
  constructor(
    code: string,
    readonly commandResult?: ToolOutput<'command.run'>,
  ) {
    super(code)
  }
}

/** 每条 RPC 与发送时的 WebSocket 绑定，禁止重连后的旧响应完成新请求。 */
interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  deviceId: string
  connection: WebSocket
  /** 原始操作类型，仅命令执行允许在失败时携带部分结果。 */
  operation: RpcRequest['operation']
  onCommandAudit: (command?: CommandAudit) => void
}

/** 管理 RPC 请求发送、超时、响应匹配及连接断开后的清理，不保存请求正文。 */
export class DeviceRpcPending {
  private readonly pending = new Map<string, PendingRequest>()

  /** 发送请求并等待匹配的 Runtime 响应。 */
  send(
    socket: WebSocket,
    deviceId: string,
    request: RpcRequest,
    timeoutMs: number,
    onCommandAudit: (command?: CommandAudit) => void,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id)
        reject(new DeviceRpcError('EXECUTION_TIMEOUT'))
      }, timeoutMs)
      this.pending.set(request.id, {
        resolve,
        reject,
        timer,
        deviceId,
        connection: socket,
        operation: request.operation,
        onCommandAudit,
      })
      socket.send(JSON.stringify(request), (error) => {
        if (error) {
          clearTimeout(timer)
          this.pending.delete(request.id)
          reject(new DeviceRpcError('DEVICE_SEND_FAILED'))
        }
      })
    })
  }

  /** 仅接受来源设备及连接均一致的 RPC 响应。 */
  accept(message: unknown, deviceId: string, socket: WebSocket): void {
    const response = RpcResponseSchema.parse(message)
    const request = this.pending.get(response.id)
    if (!request || request.deviceId !== deviceId || request.connection !== socket) return
    clearTimeout(request.timer)
    this.pending.delete(response.id)
    request.onCommandAudit(response.commandAudit)
    if (response.success) {
      request.resolve(response.data)
      return
    }
    const code = rpcPublicErrorCode(response.error?.code)
    // 只有匹配请求来自 command.run 且错误类型可附带结果时才接受失败正文。
    if (
      request.operation === 'command.run' &&
      CommandResultErrorCodeSchema.safeParse(code).success
    ) {
      const result = ToolOutputs['command.run'].safeParse(response.data)
      if (
        result.success &&
        Buffer.byteLength(result.data.output, 'utf8') <= COMMAND_OUTPUT_LIMIT_BYTES
      ) {
        request.reject(new DeviceRpcError(code, result.data))
        return
      }
    }
    request.reject(new DeviceRpcError(code))
  }

  /** 连接断开时只清理该连接上的请求，不影响同设备的新连接。 */
  disconnect(deviceId: string, socket: WebSocket): void {
    for (const [id, request] of this.pending) {
      if (request.deviceId !== deviceId || request.connection !== socket) continue
      clearTimeout(request.timer)
      request.reject(new DeviceRpcError('DEVICE_OFFLINE'))
      this.pending.delete(id)
    }
  }
}
