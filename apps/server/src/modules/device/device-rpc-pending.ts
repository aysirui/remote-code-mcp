import { WebSocket } from 'ws'
import {
  RpcResponseSchema,
  rpcPublicErrorCode,
  type CommandAudit,
  type RpcRequest,
} from '@rcm/protocol'

/** 每条 RPC 与发送时的 WebSocket 绑定，禁止重连后的旧响应完成新请求。 */
interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  deviceId: string
  connection: WebSocket
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
        reject(new Error('EXECUTION_TIMEOUT'))
      }, timeoutMs)
      this.pending.set(request.id, {
        resolve,
        reject,
        timer,
        deviceId,
        connection: socket,
        onCommandAudit,
      })
      socket.send(JSON.stringify(request), (error) => {
        if (error) {
          clearTimeout(timer)
          this.pending.delete(request.id)
          reject(new Error('DEVICE_SEND_FAILED'))
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
    if (response.success) request.resolve(response.data)
    else request.reject(new Error(rpcPublicErrorCode(response.error?.code)))
  }

  /** 连接断开时只清理该连接上的请求，不影响同设备的新连接。 */
  disconnect(deviceId: string, socket: WebSocket): void {
    for (const [id, request] of this.pending) {
      if (request.deviceId !== deviceId || request.connection !== socket) continue
      clearTimeout(request.timer)
      request.reject(new Error('DEVICE_OFFLINE'))
      this.pending.delete(id)
    }
  }
}
