import 'reflect-metadata'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import type { Request } from 'express'
import type { RpcRequest } from '@rcm/protocol'
import { NestFactory } from '@nestjs/core'
import { AccountController } from '../src/account.controller'
import { DeviceHub } from '../src/device-hub'
import { Identity } from '../src/identity'
import { Store } from '../src/store'

const workspace = {
  id: '7ea14392-437e-40db-a10d-9261d7814f87',
  deviceId: 'device',
  userId: 'owner',
  name: '测试工作区',
  localEnabled: true,
  localRead: true,
  localWrite: true,
  localFilePolicy: 'allow',
  localGitPolicy: 'approval',
  localCommandPolicy: 'deny',
}

/** 查询替身只提供数据库结果，权限计算和请求转发仍调用真实代码。 */
function database(rows = [workspace]) {
  const query = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve),
  }
  return { select: jest.fn(() => query) }
}

test.each([
  [true, true, true, true, true],
  [false, true, true, false, false],
  [true, false, true, false, false],
  [true, true, false, true, false],
])(
  '云端展示本地启用=%s、读=%s、写=%s的有效权限',
  async (enabled, read, write, effectiveRead, effectiveWrite) => {
    const identity = { requireUser: jest.fn().mockResolvedValue({ id: 'owner' }) }
    const store = {
      db: database([{ ...workspace, localEnabled: enabled, localRead: read, localWrite: write }]),
    }
    const controller = new AccountController(
      identity as unknown as Identity,
      store as unknown as Store,
      {} as DeviceHub,
    )
    const request = {} as Request
    await expect(controller.workspaces(request)).resolves.toEqual([
      {
        id: workspace.id,
        deviceId: 'device',
        name: '测试工作区',
        enabled,
        read: effectiveRead,
        write: effectiveWrite,
        policies: { file: 'allow', git: 'approval', command: 'deny' },
      },
    ])
    expect(identity.requireUser).toHaveBeenCalledWith(request)
  },
)

test('云端工作区接口只读，修改策略或停用的请求返回 404', async () => {
  const app = await NestFactory.create(
    {
      module: class TestModule {},
      controllers: [AccountController],
      providers: [
        {
          provide: Identity,
          useValue: { requireUser: jest.fn().mockResolvedValue({ id: 'owner' }) },
        },
        { provide: Store, useValue: { db: database() } },
        { provide: DeviceHub, useValue: {} },
      ],
    },
    { logger: false },
  )
  try {
    await app.listen(0, '127.0.0.1')
    const base = await app.getUrl()
    const read = await fetch(base + '/api/me/workspaces')
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual([
      expect.objectContaining({ policies: { file: 'allow', git: 'approval', command: 'deny' } }),
    ])
    const update = await fetch(base + '/api/me/workspaces/' + workspace.id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false, policies: { file: 'deny' } }),
    })
    expect(update.status).toBe(404)
  } finally {
    await app.close()
  }
})

test('Gateway 转发工具请求不附加云端审批，本地只读权限仍生效', async () => {
  const device = { id: 'device', userId: 'owner', status: 'active' }
  const store = {
    db: database(),
    one: jest
      .fn()
      .mockResolvedValueOnce({ deviceId: 'device', revokedAt: null })
      .mockResolvedValueOnce(device)
      .mockResolvedValueOnce({ id: 'owner', status: 'active' }),
    logOperation: jest.fn().mockResolvedValue(undefined),
  }
  const hub = new DeviceHub(store as unknown as Store)
  const server = createServer()
  hub.attach(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const client = new WebSocket(
    `ws://127.0.0.1:${(server.address() as AddressInfo).port}/agent/connect`,
    { headers: { Authorization: 'Bearer test' } },
  )
  try {
    await once(client, 'open')
    const requests: RpcRequest[] = []
    client.on('message', (raw) => {
      const request = JSON.parse(raw.toString()) as RpcRequest
      requests.push(request)
      client.send(
        JSON.stringify({
          kind: 'response',
          id: request.id,
          success: true,
          data: { done: true },
          commandAudit: { executable: 'pnpm', args: ['run', 'build'] },
        }),
      )
    })
    // 三档策略都交给 Runtime 判断，Gateway 不另设审批或拒绝策略。
    for (const policy of ['allow', 'approval', 'deny']) {
      store.one
        .mockResolvedValueOnce({ ...workspace, localFilePolicy: policy })
        .mockResolvedValueOnce(device)
      await expect(
        hub.execute('owner', 'ai-client', workspace.id, 'file.write', {
          path: 'sample.txt',
          content: '更新',
        }),
      ).resolves.toEqual({ done: true })
    }
    expect(requests).toHaveLength(3)
    for (const [record] of store.logOperation.mock.calls) {
      expect(record.commandAudit).toBeUndefined()
    }
    store.one.mockResolvedValueOnce(workspace).mockResolvedValueOnce(device)
    await hub.execute('owner', 'ai-client', workspace.id, 'command.run', { command: 'build' })
    expect(store.logOperation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        toolName: 'command_run',
        commandAudit: { executable: 'pnpm', args: ['run', 'build'] },
      }),
    )
    for (const request of requests.slice(0, 3)) {
      expect(request).not.toHaveProperty('approvalRequired')
      expect(request).toMatchObject({ workspaceId: workspace.id, operation: 'file.write' })
    }
    store.one.mockResolvedValueOnce({ ...workspace, localWrite: false })
    await expect(hub.execute('owner', 'ai-client', workspace.id, 'file.write', {})).rejects.toThrow(
      'PERMISSION_DENIED',
    )
    expect(requests).toHaveLength(4)
  } finally {
    const closed = once(client, 'close')
    client.close()
    await closed
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
