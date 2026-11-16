import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CommandRunInputSchema, type RpcRequest } from '@rcm/protocol'
import { commandRequiresApproval, resolveCommandRequest } from '../src/command-operations'
import { execute } from '../src/executors'
import type { LocalWorkspace } from '../src/state'
import { WriteApprovalQueue, WRITE_APPROVAL_TIMEOUT_MS } from '../src/write-approvals'

let root: string
const registered = {
  id: 'echo-test',
  name: '输出测试',
  executable: process.execPath,
  args: ['-e', 'process.stdout.write("registered-ok")'],
}
const workspace = (command: 'deny' | 'approval' | 'allow' = 'allow'): LocalWorkspace => ({
  id: 'test-workspace',
  name: '测试工作区',
  root,
  enabled: true,
  permissions: { read: true, write: true },
  policies: { file: 'allow', git: 'allow', command },
  commands: [registered],
})
const rpc = (payload: unknown): RpcRequest => ({
  kind: 'request',
  version: 1,
  id: 'test-request',
  workspaceId: 'test-workspace',
  operation: 'command.run',
  payload,
  deadlineAt: Date.now() + 10000,
})
const temporary = () => ({
  executable: process.execPath,
  args: ['-e', 'process.stdout.write("temporary-ok")'],
})
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'rcm-command-'))
})
afterEach(async () => {
  jest.useRealTimers()
  await fs.rm(root, { recursive: true, force: true })
})

test('内置和已登记命令遵循策略，临时命令在 allow 下仍需审批', () => {
  for (const command of ['build', registered.id]) {
    expect(commandRequiresApproval(workspace('allow'), { command })).toBe(false)
    expect(commandRequiresApproval(workspace('approval'), { command })).toBe(true)
  }
  expect(commandRequiresApproval(workspace('allow'), temporary())).toBe(true)
  expect(commandRequiresApproval(workspace('approval'), temporary())).toBe(true)
})

test('已登记命令 allow 下直接运行，approval 下没有本机批准不能运行', async () => {
  await expect(execute(workspace(), rpc({ command: registered.id }))).resolves.toMatchObject({
    exitCode: 0,
    output: 'registered-ok',
  })
  await expect(execute(workspace('approval'), rpc({ command: registered.id }))).rejects.toThrow(
    'COMMAND_APPROVAL_REQUIRED',
  )
})

test('执行回调只提供脱敏命令，审批被拒绝时没有执行记录', async () => {
  const record = jest.fn()
  await execute(workspace(), rpc({ command: registered.id }), undefined, record)
  expect(record).toHaveBeenCalledWith({ executable: 'node', args: ['[已隐藏]', '[已隐藏]'] })
  record.mockClear()
  await expect(
    execute(workspace('approval'), rpc({ command: registered.id }), undefined, record),
  ).rejects.toThrow('COMMAND_APPROVAL_REQUIRED')
  expect(record).not.toHaveBeenCalled()
})

test('临时命令必须先审批，完整程序与参数、工作目录和风险全部可见，批准只消费一次', async () => {
  const w = workspace()
  const request = rpc(temporary())
  await expect(execute(w, request)).rejects.toThrow('COMMAND_APPROVAL_REQUIRED')
  const queue = new WriteApprovalQueue()
  const pending = queue.request(request, w)
  const [item] = queue.list()
  expect(item.riskLevel).toBe('high')
  expect(item.truncated).toBe(false)
  for (const value of [
    process.execPath,
    JSON.stringify(temporary().args),
    root,
    '网络',
    '本次',
    '凭据',
  ])
    expect(item.preview).toContain(value)
  expect(queue.answer(item.id, true)).toBe(true)
  expect(queue.answer(item.id, true)).toBe(false)
  const decision = await pending
  expect(decision.approved).toBe(true)
  await expect(execute(w, request, decision.resourceHash)).resolves.toMatchObject({
    exitCode: 0,
    output: 'temporary-ok',
  })
  expect(w.commands).toEqual([registered])
  expect(queue.list()).toHaveLength(0)
})

test('已登记命令也能经审批后执行，审批指纹不能用于不同参数或程序', async () => {
  const w = workspace('approval')
  const request = rpc({ command: registered.id })
  const queue = new WriteApprovalQueue()
  const pending = queue.request(request, w)
  queue.answer(queue.list()[0].id, true)
  const { resourceHash } = await pending
  await expect(execute(w, request, resourceHash)).resolves.toMatchObject({
    output: 'registered-ok',
  })
  const changed = { ...w, commands: [{ ...registered, args: ['--version'] }] }
  await expect(execute(changed, request, resourceHash)).rejects.toThrow('COMMAND_APPROVAL_REQUIRED')
  await expect(
    execute(w, rpc({ ...temporary(), args: ['--version'] }), resourceHash),
  ).rejects.toThrow('COMMAND_APPROVAL_REQUIRED')
})

test('deny 和只读权限不能被本机审批指纹绕过', async () => {
  const queue = new WriteApprovalQueue()
  const request = rpc(temporary())
  const pending = queue.request(request, workspace())
  queue.answer(queue.list()[0].id, true)
  const { resourceHash } = await pending
  await expect(execute(workspace('deny'), request, resourceHash)).rejects.toThrow('POLICY_DENIED')
  await expect(
    execute({ ...workspace(), permissions: { read: true, write: false } }, request, resourceHash),
  ).rejects.toThrow('PERMISSION_DENIED')
})

test.each(['拒绝', '超时', '断线', '撤销'] as const)(
  '%s 后临时命令未获得执行授权',
  async (action) => {
    jest.useFakeTimers()
    const queue = new WriteApprovalQueue()
    const request = rpc(temporary())
    const w = workspace()
    const pending = queue.request(request, w)
    const id = queue.list()[0].id
    if (action === '拒绝') queue.answer(id, false)
    if (action === '超时') jest.advanceTimersByTime(WRITE_APPROVAL_TIMEOUT_MS)
    if (action === '断线') queue.cancelAll()
    if (action === '撤销') queue.rejectWorkspace(w.id)
    const decision = await pending
    expect(decision.approved).toBe(false)
    expect(queue.answer(id, true)).toBe(false)
    expect(decision.resourceHash).toBeUndefined()
    jest.useRealTimers()
    await expect(execute(w, request, decision.resourceHash)).rejects.toThrow(
      'COMMAND_APPROVAL_REQUIRED',
    )
  },
)

test('命令 ID 与临时程序参数互斥，不允许悄悄覆盖固定参数或传入未知字段', () => {
  for (const input of [
    {},
    { command: 'build', args: ['--help'] },
    { command: 'build', executable: 'other' },
    { executable: 'node', shell: true },
    { executable: 'node', args: ['bad\0arg'] },
  ])
    expect(() => CommandRunInputSchema.parse(input)).toThrow()
  expect(() => resolveCommandRequest(workspace(), { command: 'not-registered' })).toThrow(
    'COMMAND_NOT_ALLOWED',
  )
  expect(resolveCommandRequest(workspace(), { executable: 'node' })).toMatchObject({
    registered: false,
    command: { args: [] },
  })
})

test('命令保持参数数组语义，空格、引号与控制符按原样传递', async () => {
  const args = ['space value', '"quoted"', 'a&b', '%PATH%', 'a|b', '']
  const w = workspace()
  const request = rpc({
    executable: process.execPath,
    args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...args],
  })
  const queue = new WriteApprovalQueue()
  const pending = queue.request(request, w)
  queue.answer(queue.list()[0].id, true)
  const { resourceHash } = await pending
  await expect(execute(w, request, resourceHash)).resolves.toMatchObject({
    exitCode: 0,
    output: JSON.stringify(args),
  })
})

test('内置 pnpm 命令可以启动项目脚本，包括 Windows 命令启动器', async () => {
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ scripts: { build: 'node build.cjs' } }),
  )
  await fs.writeFile(path.join(root, 'build.cjs'), 'process.stdout.write("builtin-build-ok")')
  await expect(execute(workspace(), rpc({ command: 'build' }))).resolves.toMatchObject({
    exitCode: 0,
    output: expect.stringContaining('builtin-build-ok'),
  })
})
