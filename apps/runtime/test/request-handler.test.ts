import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { sha } from '../src/operations/file/file-operations'
import path from 'node:path'
import { handleGatewayMessage, type RequestContext } from '../src/requests/request-handler'
import { activeServer, migrateConfig } from '../src/workspace/state'
import { WriteApprovalQueue } from '../src/requests/write-approvals'
import { LocalEvents } from '../src/local/local-events'

let dir: string
let workspaceId: string
let context: RequestContext
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'rcm-request-'))
  await writeFile(path.join(dir, 'README.md'), 'before')
  const config = migrateConfig({
    gateway: 'https://example.com',
    name: 'local',
    workspaces: [
      {
        id: randomUUID(),
        name: 'project',
        root: dir,
        enabled: true,
        permissions: { read: true, write: true },
        policies: { file: 'allow', git: 'allow', command: 'allow' },
      },
    ],
  })
  workspaceId = activeServer(config).workspaces[0].id
  context = {
    config,
    server: activeServer(config),
    approvals: new WriteApprovalQueue(),
    events: new LocalEvents(),
    isConnected: () => true,
  }
})
afterEach(async () => {
  context.approvals.cancelAll()
  await rm(dir, { recursive: true, force: true })
})

const rpc = (operation: string, payload: unknown) =>
  JSON.stringify({
    kind: 'request',
    version: 1,
    id: randomUUID(),
    workspaceId,
    operation,
    payload,
    deadlineAt: Date.now() + 60000,
  })

/** 真实文件与授权配置贯通请求处理器，不模拟工具执行结果。 */
test('allow 策略直接读写文件，不产生本机审批', async () => {
  const write = await handleGatewayMessage(
    rpc('file.write', {
      path: 'README.md',
      content: 'after',
      expectedSha256: sha('before'),
    }),
    context,
  )
  expect(write).toMatchObject({ kind: 'response', success: true })
  expect(await readFile(path.join(dir, 'README.md'), 'utf8')).toBe('after')
  const read = await handleGatewayMessage(rpc('file.read', { path: 'README.md' }), context)
  expect(read).toMatchObject({ success: true, data: { content: 'after' } })
  expect(context.approvals.list()).toHaveLength(0)
})

test('approval 策略等待本地决定后执行', async () => {
  context.server.workspaces[0].policies.file = 'approval'
  const pending = handleGatewayMessage(
    rpc('file.write', {
      path: 'README.md',
      content: 'approved',
      expectedSha256: sha('before'),
    }),
    context,
  )
  // 请求先执行异步路径校验，再进入审批队列。
  for (let i = 0; i < 20 && context.approvals.list().length === 0; i++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  expect(context.approvals.list()).toHaveLength(1)
  context.approvals.answer(context.approvals.list()[0].id, true)
  expect(await pending).toMatchObject({ success: true })
  expect(await readFile(path.join(dir, 'README.md'), 'utf8')).toBe('approved')
})

test('只读授权拒绝写入，deny 策略拒绝读取', async () => {
  context.server.workspaces[0].permissions.write = false
  const write = await handleGatewayMessage(
    rpc('file.write', {
      path: 'README.md',
      content: 'no',
    }),
    context,
  )
  expect(write).toMatchObject({ success: false, error: { message: 'PERMISSION_DENIED' } })
  context.server.workspaces[0].policies.file = 'deny'
  const read = await handleGatewayMessage(rpc('file.read', { path: 'README.md' }), context)
  expect(read).toMatchObject({ success: false, error: { message: 'POLICY_DENIED' } })
  expect(await readFile(path.join(dir, 'README.md'), 'utf8')).toBe('before')
})

/** 真实审批队列贯通 RPC 执行器，验证等待期间撤销授权不会执行写入。 */
test('审批等待期间撤销写权限，批准后仍拒绝执行', async () => {
  context.server.workspaces[0].policies.file = 'approval'
  const pending = handleGatewayMessage(
    rpc('file.write', {
      path: 'README.md',
      content: 'must-not-write',
      expectedSha256: sha('before'),
    }),
    context,
  )
  for (let i = 0; i < 40 && !context.approvals.list().length; i++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  expect(context.approvals.list()).toHaveLength(1)
  context.server.workspaces[0].permissions.write = false
  context.approvals.answer(context.approvals.list()[0].id, true)
  expect(await pending).toMatchObject({ success: false, error: { message: 'PERMISSION_DENIED' } })
  expect(await readFile(path.join(dir, 'README.md'), 'utf8')).toBe('before')
})

test('审批期间修改目标文件，批准后不能覆盖新内容', async () => {
  context.server.workspaces[0].policies.file = 'approval'
  const pending = handleGatewayMessage(
    rpc('file.write', {
      path: 'README.md',
      content: 'must-not-write',
      expectedSha256: sha('before'),
    }),
    context,
  )
  for (let i = 0; i < 40 && !context.approvals.list().length; i++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  expect(context.approvals.list()).toHaveLength(1)
  await writeFile(path.join(dir, 'README.md'), 'changed-during-approval')
  context.approvals.answer(context.approvals.list()[0].id, true)
  expect(await pending).toMatchObject({ success: false })
  expect(await readFile(path.join(dir, 'README.md'), 'utf8')).toBe('changed-during-approval')
})
