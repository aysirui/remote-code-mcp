import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'
import type { RpcRequest } from '@rcm/protocol'
import { DeviceRpcPending } from '../src/modules/device/device-rpc-pending'

/** 模拟 WebSocket 发送与重连，确保请求只由对应连接完成。 */
function socket() {
  const ws = new EventEmitter() as EventEmitter & { send: jest.Mock }
  ws.send = jest.fn((_message: string, callback: (error?: Error) => void) => callback())
  return ws as unknown as WebSocket
}

function request(id: string): RpcRequest {
  return {
    kind: 'request',
    version: 1,
    id,
    workspaceId: 'workspace-1',
    operation: 'file.list',
    payload: { path: '.' },
    deadlineAt: Date.now() + 1000,
  }
}

describe('DeviceRpcPending 请求生命周期', () => {
  test('忽略旧连接的迟到响应，当前连接可完成请求', async () => {
    const pending = new DeviceRpcPending()
    const oldSocket = socket()
    const currentSocket = socket()
    const result = pending.send(currentSocket, 'device-1', request('rpc-1'), 1000, jest.fn())
    pending.accept(
      { kind: 'response', version: 1, id: 'rpc-1', success: true, data: 'old' },
      'device-1',
      oldSocket,
    )
    pending.accept(
      { kind: 'response', version: 1, id: 'rpc-1', success: true, data: 'current' },
      'device-1',
      currentSocket,
    )
    await expect(result).resolves.toBe('current')
  })

  test('断开旧连接不会取消新连接请求', async () => {
    const pending = new DeviceRpcPending()
    const oldSocket = socket()
    const currentSocket = socket()
    const oldResult = pending.send(oldSocket, 'device-1', request('old'), 1000, jest.fn())
    const currentResult = pending.send(currentSocket, 'device-1', request('new'), 1000, jest.fn())
    pending.disconnect('device-1', oldSocket)
    await expect(oldResult).rejects.toThrow('DEVICE_OFFLINE')
    pending.accept(
      { kind: 'response', version: 1, id: 'new', success: true, data: 42 },
      'device-1',
      currentSocket,
    )
    await expect(currentResult).resolves.toBe(42)
  })

  test('超时后拒绝请求且忽略迟到响应', async () => {
    jest.useFakeTimers()
    try {
      const pending = new DeviceRpcPending()
      const ws = socket()
      const audit = jest.fn()
      const result = pending.send(ws, 'device-1', request('timeout'), 50, audit)
      const rejected = expect(result).rejects.toThrow('EXECUTION_TIMEOUT')
      jest.advanceTimersByTime(50)
      await rejected
      pending.accept(
        { kind: 'response', version: 1, id: 'timeout', success: true, data: true },
        'device-1',
        ws,
      )
      expect(audit).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })
})
