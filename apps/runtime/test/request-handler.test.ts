import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { sha } from '../src/operations/file/file-operations'
import path from 'node:path'
import { handleGatewayMessage, type RequestContext } from '../src/requests/request-handler'
import { activeServer, migrateConfig } from '../src/workspace/state'
import { WriteApprovalQueue } from '../src/requests/write-approvals'
import { LocalEvents } from '../src/local/local-events'
import { logger } from '../src/logger'
import { commandExecutionProvider } from '../src/operations/command/command-provider'
import {
  COMMAND_MAX_TIMEOUT_MS,
  COMMAND_RPC_TIMEOUT_MS,
  RPC_APPROVAL_TIMEOUT_MS,
} from '@rcm/protocol'

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
  await rm(dir, { recursive: true, force: true, maxRetries: 3 })
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

/** 二进制删除使用原始字节摘要，且无需对普通单文件执行逐次审批。 */
test('二进制文件可使用 SHA-256 删除，缺失和过期摘要均被拒绝', async () => {
  const filename = path.join(dir, 'icon.png')
  const buffer = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128, 42])
  await writeFile(filename, buffer)
  const hash = createHash('sha256').update(buffer).digest('hex')

  const missing = await handleGatewayMessage(rpc('file.delete', { path: 'icon.png' }), context)
  expect(missing).toMatchObject({
    success: false,
    error: { code: 'EXPECTED_SHA256_REQUIRED', message: 'EXPECTED_SHA256_REQUIRED' },
  })
  const conflict = await handleGatewayMessage(
    rpc('file.delete', { path: 'icon.png', expectedSha256: 'a'.repeat(64) }),
    context,
  )
  expect(conflict).toMatchObject({ success: false, error: { code: 'FILE_CONFLICT' } })
  expect(await readFile(filename)).toEqual(buffer)

  const deleted = await handleGatewayMessage(
    rpc('file.delete', { path: 'icon.png', expectedSha256: hash }),
    context,
  )
  expect(deleted).toMatchObject({ success: true, data: { deleted: true } })
  await expect(readFile(filename)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(context.approvals.list()).toHaveLength(0)
})

test('大于文本工具限制的二进制文件仍可以通过内容摘要安全删除', async () => {
  const filename = path.join(dir, 'image.bin')
  const buffer = Buffer.alloc(600 * 1024, 255)
  await writeFile(filename, buffer)
  const deleted = await handleGatewayMessage(
    rpc('file.delete', {
      path: 'image.bin',
      expectedSha256: createHash('sha256').update(buffer).digest('hex'),
    }),
    context,
  )
  expect(deleted).toMatchObject({ success: true })
  await expect(readFile(filename)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('RPC 拒绝权限和未知异常只返回安全错误码，不回传本机路径', async () => {
  context.server.workspaces[0].permissions.write = false
  const denied = await handleGatewayMessage(
    rpc('file.delete', { path: 'README.md', expectedSha256: sha('before') }),
    context,
  )
  expect(denied).toMatchObject({
    success: false,
    error: { code: 'PERMISSION_DENIED', message: 'PERMISSION_DENIED' },
  })
  context.server.workspaces[0].permissions.write = true
  const unknown = await handleGatewayMessage(
    rpc('file.delete', { path: 'absent.png', expectedSha256: 'a'.repeat(64) }),
    context,
  )
  expect(unknown).toMatchObject({
    success: false,
    error: { code: 'FILE_OPERATION_FAILED', message: 'FILE_OPERATION_FAILED' },
  })
  expect(JSON.stringify(unknown)).not.toContain(dir)
})

test('审批明确拒绝时传递安全业务错误码，文件保持原样', async () => {
  context.server.workspaces[0].policies.file = 'approval'
  const pending = handleGatewayMessage(
    rpc('file.delete', { path: 'README.md', expectedSha256: sha('before') }),
    context,
  )
  for (let i = 0; i < 40 && !context.approvals.list().length; i++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  expect(context.approvals.list()).toHaveLength(1)
  context.approvals.answer(context.approvals.list()[0].id, false)
  expect(await pending).toMatchObject({
    success: false,
    error: { code: 'APPROVAL_DENIED', message: 'APPROVAL_DENIED' },
  })
  expect(await readFile(path.join(dir, 'README.md'), 'utf8')).toBe('before')
})

test.each([
  [{ exitCode: 2, timedOut: false }, 'COMMAND_EXIT_NONZERO'],
  [{ exitCode: null, timedOut: false }, 'COMMAND_PROCESS_TERMINATED'],
  [{ exitCode: 0, timedOut: true }, 'COMMAND_TIMEOUT'],
] as const)('区分已启动的命令失败并保留部分结果：%s => %s', async (state, code) => {
  const provider = jest.spyOn(commandExecutionProvider, 'run').mockResolvedValue({
    ...state,
    output: '私有输出',
    truncated: true,
  })
  try {
    const response = await handleGatewayMessage(rpc('command.run', { command: 'build' }), context)
    expect(response).toMatchObject({
      success: false,
      error: { code, message: code },
      data: { command: 'build', output: '私有输出', truncated: true, exitCode: state.exitCode },
      commandAudit: { executable: 'pnpm', args: ['run', 'build'] },
    })
    expect(response?.data).not.toHaveProperty('timedOut')
  } finally {
    provider.mockRestore()
  }
})

test('命令启动失败在本地记录原始原因，RPC 只返回稳定错误码', async () => {
  const debug = jest.spyOn(logger, 'debug').mockImplementation(() => undefined)
  const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true)
  const provider = jest
    .spyOn(commandExecutionProvider, 'run')
    .mockRejectedValue(Error('private-token ' + dir))
  try {
    const request = rpc('command.run', { command: 'build' })
    const { id } = JSON.parse(request)
    const response = await handleGatewayMessage(request, context)
    expect(response).toMatchObject({ success: false, error: { code: 'COMMAND_START_FAILED' } })
    expect(response).not.toHaveProperty('data')
    expect(debug).toHaveBeenCalledWith('rpc.received', expect.objectContaining({ requestId: id }))
    expect(debug).toHaveBeenCalledWith(
      'rpc.execution.started',
      expect.objectContaining({ requestId: id }),
    )
    expect(JSON.parse(String(stderr.mock.calls[0][0]))).toMatchObject({
      level: 'error',
      event: 'rpc.failed',
      requestId: id,
      stage: 'execution',
      code: 'COMMAND_START_FAILED',
      durationMs: expect.any(Number),
      err: {
        message: expect.stringContaining('private-token ' + dir),
        stack: expect.stringContaining('private-token ' + dir),
      },
    })
    const serialized = JSON.stringify(response)
    expect(serialized).not.toContain('private-token')
    expect(serialized).not.toContain(JSON.stringify(dir).slice(1, -1))
  } finally {
    provider.mockRestore()
    stderr.mockRestore()
    debug.mockRestore()
  }
})

test('参数无效、未知命令和领域执行错误使用不同的公开错误码', async () => {
  await expect(
    handleGatewayMessage(rpc('file.read', { path: 123 }), context),
  ).resolves.toMatchObject({
    error: { code: 'INVALID_TOOL_ARGUMENTS' },
  })
  await expect(
    handleGatewayMessage(rpc('file.read', { path: 'missing.txt' }), context),
  ).resolves.toMatchObject({
    error: { code: 'FILE_OPERATION_FAILED' },
  })
  await expect(handleGatewayMessage(rpc('git.status', {}), context)).resolves.toMatchObject({
    error: { code: 'GIT_OPERATION_FAILED' },
  })
  await expect(
    handleGatewayMessage(rpc('command.run', { command: 'not-registered' }), context),
  ).resolves.toMatchObject({
    error: { code: 'COMMAND_NOT_ALLOWED' },
  })
})

test('文件读取失败的绝对路径和系统错误只进入本地日志', async () => {
  const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true)
  try {
    const missing = path.join(dir, 'missing.txt')
    const response = await handleGatewayMessage(rpc('file.read', { path: 'missing.txt' }), context)
    const entry = JSON.parse(String(stderr.mock.calls[0][0]))
    expect(entry).toMatchObject({
      event: 'rpc.failed',
      operation: 'file.read',
      err: { code: 'ENOENT', path: missing, stack: expect.stringContaining('ENOENT') },
    })
    expect(response).toMatchObject({
      success: false,
      error: { code: 'FILE_OPERATION_FAILED', message: 'FILE_OPERATION_FAILED' },
    })
    expect(JSON.stringify(response)).not.toMatch(/missing\.txt|ENOENT|stack/)
  } finally {
    stderr.mockRestore()
  }
})

test('接近审批期限批准后，本机登记命令仍有完整的二十分钟执行预算', async () => {
  jest.useFakeTimers()
  const provider = jest.spyOn(commandExecutionProvider, 'run')
  try {
    context.server.workspaces[0].policies.command = 'approval'
    context.config.workspaces[0].commands = [
      {
        id: 'long-task',
        name: '长任务',
        executable: 'node',
        args: ['--version'],
        timeoutMs: COMMAND_MAX_TIMEOUT_MS,
      },
    ]
    let notifyApproval!: () => void
    const enqueued = new Promise<void>((resolve) => {
      notifyApproval = resolve
    })
    context.approvals = new WriteApprovalQueue(notifyApproval)
    let notifyExecution!: () => void
    const running = new Promise<void>((resolve) => {
      notifyExecution = resolve
    })
    provider.mockImplementation(
      ({ timeoutMs }) =>
        new Promise((resolve) => {
          setTimeout(
            () => resolve({ exitCode: 0, output: '完成', truncated: false, timedOut: false }),
            timeoutMs - 1,
          )
          notifyExecution()
        }),
    )
    const request = JSON.parse(rpc('command.run', { command: 'long-task' }))
    request.deadlineAt = Date.now() + COMMAND_RPC_TIMEOUT_MS
    const pending = handleGatewayMessage(JSON.stringify(request), context)
    await enqueued
    await jest.advanceTimersByTimeAsync(RPC_APPROVAL_TIMEOUT_MS - 1)
    expect(provider).not.toHaveBeenCalled()
    expect(context.approvals.answer(context.approvals.list()[0].id, true)).toBe(true)
    await running
    expect(provider).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: COMMAND_MAX_TIMEOUT_MS }),
    )
    await jest.advanceTimersByTimeAsync(COMMAND_MAX_TIMEOUT_MS - 1)
    expect(Date.now()).toBeLessThan(request.deadlineAt)
    await expect(pending).resolves.toMatchObject({ success: true, data: { exitCode: 0 } })
  } finally {
    provider.mockRestore()
    jest.useRealTimers()
  }
})
