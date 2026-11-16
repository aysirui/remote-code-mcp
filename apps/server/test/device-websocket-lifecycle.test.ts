import { createServer } from 'node:http'
import { WebSocket } from 'ws'
import { DeviceHub } from '../src/modules/device/device-hub'

jest.mock('../src/modules/device/device-auth', () => ({
  authenticateDevice: jest.fn().mockResolvedValue('device-1'),
}))

/** 使用真实 HTTP Upgrade 与 WebSocket 验证 Nest 生命周期装配和关闭。 */
test('设备连接在应用初始化时注册，关闭后释放 WebSocket', async () => {
  const http = createServer()
  const adapter = { httpAdapter: { getHttpServer: () => http } }
  const hub = new DeviceHub({} as never, adapter as never)
  hub.onApplicationBootstrap()
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const address = http.address()
  if (!address || typeof address === 'string') throw Error('INVALID_TEST_ADDRESS')
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/agent/connect`)
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    expect(hub.isOnline('device-1')).toBe(true)
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()))
    hub.onApplicationShutdown()
    await closed
    expect(hub.isOnline('device-1')).toBe(false)
    expect(http.listenerCount('upgrade')).toBe(0)
  } finally {
    ws.terminate()
    hub.onApplicationShutdown()
    await new Promise<void>((resolve) => http.close(() => resolve()))
  }
})
