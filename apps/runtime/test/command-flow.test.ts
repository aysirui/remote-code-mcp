import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import type { RpcResponse } from '@rcm/protocol'
import type { WriteApprovalInfo } from '../src/requests/write-approvals'

/** 启动真正的 Runtime，用临时 Server 与本机审批 API 验证完整执行路径。 */
test('远程临时命令必须经本机审批；拒绝、过期和权限撤销均不执行', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'rcm-command-flow-'))
  const root = path.join(base, 'project')
  const data = path.join(base, 'runtime-data')
  await fs.mkdir(root)
  await fs.mkdir(data)
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = (probe.address() as { port: number }).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  const gateway = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(gateway, 'listening')
  const workspaceId = randomUUID()
  const serverId = randomUUID()
  await fs.writeFile(
    path.join(data, 'config.json'),
    JSON.stringify({
      version: 2,
      name: '集成测试',
      activeServerId: serverId,
      workspaces: [
        {
          id: workspaceId,
          name: '临时项目',
          root,
          commands: [
            {
              id: 'registered-echo',
              name: '已登记测试',
              executable: process.execPath,
              args: ['-e', 'process.stdout.write("registered")'],
            },
          ],
        },
      ],
      servers: [
        {
          id: serverId,
          name: '测试 Server',
          gateway: `http://127.0.0.1:${(gateway.address() as { port: number }).port}`,
          deviceId: randomUUID(),
          deviceToken: 'test-device-token',
          paused: false,
          workspaces: [
            {
              workspaceId,
              id: workspaceId,
              authorized: true,
              enabled: true,
              permissions: { read: true, write: true },
              policies: { file: 'allow', git: 'allow', command: 'allow' },
            },
          ],
        },
      ],
    }),
  )
  const responses = new Map<string, RpcResponse>()
  let socket: WebSocket | undefined
  let ready = false
  gateway.on('connection', (ws) => {
    socket = ws
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString())
      if (message.kind === 'hello') ready = true
      if (message.kind === 'response') responses.set(message.id, message)
    })
  })
  const child = spawn(
    process.execPath,
    ['--require', require.resolve('tsx/cjs'), path.resolve(__dirname, '../src/main.ts')],
    {
      env: { ...process.env, RUNTIME_PORT: String(port), RUNTIME_DATA_DIR: data },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  let token = ''
  let stdout = ''
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk)
    token = stdout.match(/#token=([A-Za-z0-9_-]+)/)?.[1] || ''
  })
  child.stderr.resume()
  async function waitFor<T>(read: () => T | Promise<T>): Promise<NonNullable<T>> {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const value = await read()
      if (value) return value as NonNullable<T>
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw Error('等待 Runtime 测试状态超时')
  }
  async function api(endpoint: string, body?: object, method = 'POST') {
    const response = await fetch(`http://127.0.0.1:${port}/local/api/${endpoint}`, {
      method: body ? method : 'GET',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    expect(response.ok).toBe(true)
    return response.json()
  }
  function send(payload: unknown, ttl = 30000) {
    const id = randomUUID()
    socket!.send(
      JSON.stringify({
        kind: 'request',
        version: 1,
        id,
        workspaceId,
        operation: 'command.run',
        payload,
        deadlineAt: Date.now() + ttl,
      }),
    )
    return id
  }
  const approval = () =>
    waitFor(async () => ((await api('write-approvals')) as WriteApprovalInfo[])[0])
  const payload = (marker: string) => ({
    executable: process.execPath,
    args: [
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(path.join(root, marker))},'ran')`,
    ],
  })
  try {
    await waitFor(() => ready && token)
    const registeredId = send({ command: 'registered-echo' })
    expect(await waitFor(() => responses.get(registeredId))).toMatchObject({
      success: true,
      data: { output: 'registered' },
    })
    const approvedId = send(payload('approved.txt'))
    const item = await approval()
    expect(item.preview).toContain('approved.txt')
    expect(item.riskLevel).toBe('high')
    await expect(fs.stat(path.join(root, 'approved.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await api('write-approvals/' + item.id, { approve: true })
    expect(await waitFor(() => responses.get(approvedId))).toMatchObject({
      success: true,
      data: { exitCode: 0 },
    })
    expect(await fs.readFile(path.join(root, 'approved.txt'), 'utf8')).toBe('ran')
    const deniedId = send(payload('denied.txt'))
    await api('write-approvals/' + (await approval()).id, { approve: false })
    expect(await waitFor(() => responses.get(deniedId))).toMatchObject({
      success: false,
      error: { message: 'APPROVAL_DENIED' },
    })
    const expiredId = send(payload('expired.txt'), 150)
    const expiring = await approval()
    await new Promise((resolve) => setTimeout(resolve, 180))
    await api('write-approvals/' + expiring.id, { approve: true })
    expect(await waitFor(() => responses.get(expiredId))).toMatchObject({
      success: false,
      error: { message: 'REQUEST_EXPIRED' },
    })
    const revokedId = send(payload('revoked.txt'))
    await approval()
    await api('workspaces/' + workspaceId, { serverId, policies: { command: 'deny' } }, 'PATCH')
    expect(await waitFor(() => responses.get(revokedId))).toMatchObject({ success: false })
    const forbiddenId = send(payload('forbidden.txt'))
    expect(await waitFor(() => responses.get(forbiddenId))).toMatchObject({
      success: false,
      error: { message: 'POLICY_DENIED' },
    })
    expect(await api('write-approvals')).toEqual([])
    for (const marker of ['denied.txt', 'expired.txt', 'revoked.txt', 'forbidden.txt'])
      await expect(fs.stat(path.join(root, marker))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
    for (const client of gateway.clients) client.terminate()
    await new Promise<void>((resolve) => gateway.close(() => resolve()))
    await fs.rm(base, { recursive: true, force: true })
  }
}, 20000)
