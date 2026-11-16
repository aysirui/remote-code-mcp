import http from 'node:http'
import axios from 'axios'
import { startLocalServer } from '../src/local/local-server'
import { LocalEvents } from '../src/local/local-events'
import { WriteApprovalQueue } from '../src/requests/write-approvals'
import { save, type Config } from '../src/workspace/state'

jest.mock('../src/workspace/state', () => ({
  ...jest.requireActual('../src/workspace/state'),
  save: jest.fn().mockResolvedValue(undefined),
}))

afterEach(() => jest.restoreAllMocks())

async function fixture() {
  const config: Config = {
    version: 2,
    name: '测试设备',
    activeServerId: 'active',
    servers: ['active', 'other'].map((id) => ({
      id,
      name: id,
      gateway: 'https://gateway.example.invalid',
      deviceId: id + '-device',
      deviceToken: id + '-token',
      paused: false,
      workspaces: [],
    })),
    workspaces: [],
  }
  const disconnect = jest.fn()
  const events = new LocalEvents()
  const publish = jest.spyOn(events, 'publish')
  const server = startLocalServer({
    port: 0,
    localKey: 'test-key',
    config,
    approvals: new WriteApprovalQueue(),
    events,
    status: () => ({ paired: !!config.servers[0].deviceToken }),
    disconnect,
    connect: jest.fn(),
    sync: async () => {},
  })
  await new Promise<void>((resolve) => server.on('listening', resolve))
  const port = (server.address() as { port: number }).port
  const request = (body: object, key = 'test-key', method = 'POST', route = '/unpair') =>
    new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/local/api' + route,
          method,
          headers: {
            Host: '127.0.0.1:0',
            Authorization: 'Bearer ' + key,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(JSON.stringify(body)),
          },
        },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode!))
        },
      )
      req.on('error', reject)
      req.end(JSON.stringify(body))
    })
  return {
    config,
    disconnect,
    publish,
    request,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

test.each(['成功', '数据库已清空'])('正常解绑兼容%s，并保存配置及推送状态', async (scenario) => {
  const post = jest.spyOn(axios, 'post')
  if (scenario === '成功') post.mockResolvedValue({ data: { ok: true } })
  else
    post.mockRejectedValue({
      isAxiosError: true,
      response: { status: 401, data: { message: '设备凭据无效' } },
    })
  const f = await fixture()
  try {
    expect(await f.request({ serverId: 'active' })).toBe(200)
    expect(f.config.servers[0].deviceToken).toBeUndefined()
    expect(f.config.servers[0].deviceId).toBeUndefined()
    expect(f.config.servers[1].deviceToken).toBe('other-token')
    expect(f.disconnect).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(f.config)
    expect(f.publish).toHaveBeenCalledWith('status')
  } finally {
    await f.close()
  }
})

test.each([
  { isAxiosError: true, response: { status: 401, data: { message: 'Unauthorized' } } },
  { isAxiosError: true, code: 'ECONNREFUSED' },
])('远端拒绝或离线时保留凭据，明确选择本地清除后才允许重置', async (error) => {
  const post = jest.spyOn(axios, 'post').mockRejectedValue(error)
  const f = await fixture()
  try {
    expect(await f.request({ serverId: 'active' })).toBe(400)
    expect(f.config.servers[0].deviceToken).toBe('active-token')
    expect(f.disconnect).not.toHaveBeenCalled()
    post.mockClear()
    expect(await f.request({ serverId: 'active', localOnly: true })).toBe(200)
    expect(post).not.toHaveBeenCalled()
    expect(f.config.servers[0].deviceToken).toBeUndefined()
    expect(f.config.servers[0].deviceId).toBeUndefined()
    expect(f.config.servers[1].deviceToken).toBe('other-token')
    expect(f.disconnect).toHaveBeenCalledTimes(1)
    // 本地凭据清除后即可移除失效服务器，不再依赖远端认证。
    expect(await f.request({}, 'test-key', 'DELETE', '/servers/active')).toBe(200)
    expect(f.config.servers.map((item) => item.id)).toEqual(['other'])
  } finally {
    await f.close()
  }
})

test('本地清除仍校验页面凭据及布尔选项，非当前服务器不打断当前连接', async () => {
  const post = jest.spyOn(axios, 'post')
  const f = await fixture()
  try {
    expect(await f.request({ serverId: 'active', localOnly: true }, 'old-key')).toBe(401)
    expect(await f.request({ serverId: 'active', localOnly: 'true' })).toBe(400)
    expect(f.config.servers[0].deviceToken).toBe('active-token')
    expect(await f.request({ serverId: 'other', localOnly: true })).toBe(200)
    expect(f.config.servers[1].deviceToken).toBeUndefined()
    expect(f.config.servers[0].deviceToken).toBe('active-token')
    expect(f.disconnect).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  } finally {
    await f.close()
  }
})
