import { mkdtemp, readFile, readdir, realpath, rm, truncate, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { randomUUID, createHash } from 'node:crypto'
import path from 'node:path'
import sharp from 'sharp'
import { handleGatewayMessage, type RequestContext } from '../src/requests/request-handler'
import { activeServer, migrateConfig } from '../src/workspace/state'
import { WriteApprovalQueue } from '../src/requests/write-approvals'
import { LocalEvents } from '../src/local/local-events'
import { logger } from '../src/logger'
import { commandExecutionProvider } from '../src/operations/command/command-provider'
import {
  COMMAND_MAX_TIMEOUT_MS,
  COMMAND_RPC_TIMEOUT_MS,
  FILE_BINARY_LIMIT_BYTES,
  FILE_INLINE_LIMIT_BYTES,
  FILE_THUMBNAIL_MAX_EDGE,
  RPC_APPROVAL_TIMEOUT_MS,
} from '@rcm/protocol'

let dir: string
let workspaceId: string
let context: RequestContext
let relay: Server | undefined
beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'rcm-request-')))
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
  if (relay) {
    relay.closeAllConnections()
    await new Promise<void>((resolve) => relay!.close(() => resolve()))
    relay = undefined
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 3 })
})

/** 计算测试文本实际写入字节的 SHA-256。 */
const shaText = (content: string) => createHash('sha256').update(content).digest('hex')

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
      expectedSha256: shaText('before'),
    }),
    context,
  )
  expect(write).toMatchObject({ kind: 'response', success: true })
  expect(await readFile(path.join(dir, 'README.md'), 'utf8')).toBe('after')
  const read = await handleGatewayMessage(rpc('file.read', { path: 'README.md' }), context)
  expect(read).toMatchObject({ success: true, data: { content: 'after' } })
  expect(context.approvals.list()).toHaveLength(0)
})

/** 本机 HTTP 中继替身只发送或接收原始字节；请求处理器和文件系统均使用实际实现。 */
async function startRelay() {
  const uploads = new Map<string, Buffer>()
  const downloads = new Map<string, Buffer>()
  relay = createServer(async (req, res) => {
    const id = req.url!.split('/')[3]
    if (req.method === 'GET') {
      res.end(uploads.get(id))
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    downloads.set(id, Buffer.concat(chunks))
    res.statusCode = 204
    res.end()
  })
  relay.listen(0, '127.0.0.1')
  await once(relay, 'listening')
  context.server.gateway = 'http://127.0.0.1:' + (relay.address() as AddressInfo).port
  return { uploads, downloads }
}

/** 每次传输使用独立的 ID 和仅设备可见的凭据。 */
function transferRef() {
  return { id: randomUUID(), key: 'a'.repeat(64) }
}

/** PNG、GIF 和 WebP 为单像素样本；JPEG 样本覆盖两个常用扩展名。 */
const pixelPng =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAALSURBVBhXY2AAAgAABQABqtXIUQAAAABJRU5ErkJggg=='

test.each([
  ['pixel.png', 'image/png', pixelPng],
  ['pixel.jpg', 'image/jpeg', undefined],
  ['pixel.jpeg', 'image/jpeg', undefined],
  ['pixel.gif', 'image/gif', 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'],
  ['pixel.webp', 'image/webp', 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA=='],
  ['误命名.png', 'application/octet-stream', '/wABAg=='],
  ['empty.bin', 'application/octet-stream', ''],
])('原始字节流无损读写 %s，并按内容识别 MIME', async (filename, mimeType, base64) => {
  const { uploads, downloads } = await startRelay()
  const bytes =
    base64 !== undefined
      ? Buffer.from(base64, 'base64')
      : await readFile(path.join(__dirname, 'fixtures', 'pixel.jpg'))
  const upload = transferRef()
  const download = transferRef()
  uploads.set(upload.id, bytes)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const target = { path: filename, encoding: 'stream' }
  const write = await handleGatewayMessage(
    rpc('file.write', { ...target, transfer: upload, size: bytes.length }),
    context,
  )
  expect(write).toMatchObject({ success: true, data: { sha256, written: true } })
  expect(await readFile(path.join(dir, filename))).toEqual(bytes)
  const read = await handleGatewayMessage(
    rpc('file.read', { ...target, transfer: download }),
    context,
  )
  expect(read).toMatchObject({
    success: true,
    data: { encoding: 'stream', mimeType, size: bytes.length, sha256 },
  })
  expect(read?.data).not.toHaveProperty('content')
  expect(downloads.get(download.id)).toEqual(bytes)
})

test('同一旧版本的并发流式覆盖只能成功一次', async () => {
  const { uploads } = await startRelay()
  const target = { path: 'pixel.png', encoding: 'stream' }
  const original = Buffer.from(pixelPng, 'base64')
  await writeFile(path.join(dir, target.path), original)
  const expectedSha256 = createHash('sha256').update(original).digest('hex')
  const contents = [Buffer.from([1, 2, 3]), Buffer.from([4, 5, 6])]
  const writes = await Promise.all(
    contents.map((bytes) => {
      const transfer = transferRef()
      uploads.set(transfer.id, bytes)
      return handleGatewayMessage(
        rpc('file.write', {
          ...target,
          expectedSha256,
          transfer,
          size: bytes.length,
        }),
        context,
      )
    }),
  )
  expect(writes.filter((write) => write?.success)).toHaveLength(1)
  expect(writes.find((write) => !write?.success)).toMatchObject({
    error: { code: 'FILE_CONFLICT' },
  })
  expect(await readFile(path.join(dir, target.path))).toEqual(
    contents[writes.findIndex((write) => write?.success)],
  )
})

test('上传审批通过前不落盘，批准后写入原始字节', async () => {
  const { uploads } = await startRelay()
  context.server.workspaces[0].policies.file = 'approval'
  const filename = 'pixel.png'
  const bytes = Buffer.from(pixelPng, 'base64')
  const transfer = transferRef()
  uploads.set(transfer.id, bytes)
  const pending = handleGatewayMessage(
    rpc('file.write', { path: filename, size: bytes.length, transfer, encoding: 'stream' }),
    context,
  )
  for (let i = 0; i < 40 && !context.approvals.list().length; i++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  expect(context.approvals.list()).toEqual([
    expect.objectContaining({ path: filename, bytes: bytes.length, preview: '写入二进制文件' }),
  ])
  expect(await readdir(dir)).toEqual(['README.md'])
  context.approvals.answer(context.approvals.list()[0].id, true)
  expect(await pending).toMatchObject({ success: true })
  expect(await readFile(path.join(dir, filename))).toEqual(bytes)
})

test('上传长度不足时保留原文件并清理临时文件', async () => {
  const { uploads } = await startRelay()
  const transfer = transferRef()
  uploads.set(transfer.id, Buffer.from([1, 2]))
  const result = await handleGatewayMessage(
    rpc('file.write', {
      path: 'README.md',
      encoding: 'stream',
      transfer,
      size: 3,
      expectedSha256: shaText('before'),
    }),
    context,
  )
  expect(result).toMatchObject({ success: false, error: { code: 'FILE_SIZE_MISMATCH' } })
  expect(await readFile(path.join(dir, 'README.md'), 'utf8')).toBe('before')
  expect(await readdir(dir)).toEqual(['README.md'])
})

test('文本模式拒绝无效 UTF-8，原字节仍可下载', async () => {
  const { downloads } = await startRelay()
  const filename = 'legacy.txt'
  const bytes = Buffer.from([0xff, 0x41])
  await writeFile(path.join(dir, filename), bytes)
  expect(await handleGatewayMessage(rpc('file.read', { path: filename }), context)).toMatchObject({
    success: false,
    error: { code: 'INVALID_UTF8' },
  })
  const transfer = transferRef()
  expect(
    await handleGatewayMessage(
      rpc('file.read', { path: filename, encoding: 'stream', transfer }),
      context,
    ),
  ).toMatchObject({
    success: true,
    data: { sha256: createHash('sha256').update(bytes).digest('hex') },
  })
  expect(downloads.get(transfer.id)).toEqual(bytes)
})

test('文件流限制为 64 MiB 原始字节', async () => {
  const target = { path: 'large.bin', encoding: 'stream', transfer: transferRef() }
  expect(
    await handleGatewayMessage(
      rpc('file.write', { ...target, size: FILE_BINARY_LIMIT_BYTES + 1 }),
      context,
    ),
  ).toMatchObject({ success: false, error: { code: 'INVALID_TOOL_ARGUMENTS' } })
  await expect(readFile(path.join(dir, target.path))).rejects.toMatchObject({ code: 'ENOENT' })
  await writeFile(path.join(dir, target.path), '')
  await truncate(path.join(dir, target.path), FILE_BINARY_LIMIT_BYTES + 1)
  expect(await handleGatewayMessage(rpc('file.read', target), context)).toMatchObject({
    success: false,
    error: { code: 'FILE_TOO_LARGE' },
  })
})

test('查询大图大小，普通内联明确拒绝超限，预览只中继缩略图', async () => {
  const { downloads } = await startRelay()
  const filename = 'photo.png'
  const original = await sharp({
    create: { width: 1200, height: 900, channels: 3, background: '#247' },
  })
    .png({ compressionLevel: 0 })
    .toBuffer()
  expect(original.length).toBeGreaterThan(FILE_INLINE_LIMIT_BYTES)
  await writeFile(path.join(dir, filename), original)
  expect(await handleGatewayMessage(rpc('file.stat', { path: filename }), context)).toMatchObject({
    success: true,
    data: { path: filename, type: 'file', size: original.length },
  })
  expect(await handleGatewayMessage(rpc('file.stat', { path: '.' }), context)).toMatchObject({
    success: true,
    data: { type: 'directory' },
  })
  const transfer = transferRef()
  const args = { path: filename, encoding: 'inline', transfer }
  expect(await handleGatewayMessage(rpc('file.read', args), context)).toMatchObject({
    success: false,
    error: { code: 'FILE_TOO_LARGE' },
  })
  expect(downloads.has(transfer.id)).toBe(false)
  const viewed = await handleGatewayMessage(
    rpc('file.read', { ...args, mediaPreview: true }),
    context,
  )
  const thumb = downloads.get(transfer.id)!
  expect(viewed).toMatchObject({
    success: true,
    data: {
      mimeType: 'image/webp',
      size: thumb.length,
      originalSize: original.length,
      sha256: createHash('sha256').update(thumb).digest('hex'),
    },
  })
  expect(thumb.length).toBeLessThan(FILE_INLINE_LIMIT_BYTES)
  expect((await sharp(thumb).metadata()).width).toBe(FILE_THUMBNAIL_MAX_EDGE)
  expect(await readFile(path.join(dir, filename))).toEqual(original)
})

test('受控附件流可省略长度，仍校验目标版本并写入完整文件', async () => {
  const { uploads } = await startRelay()
  const transfer = transferRef()
  const bytes = Buffer.from(pixelPng, 'base64')
  uploads.set(transfer.id, bytes)
  const args = { path: 'README.md', encoding: 'stream', transfer }
  expect(
    await handleGatewayMessage(
      rpc('file.write', { ...args, expectedSha256: shaText('wrong') }),
      context,
    ),
  ).toMatchObject({ success: false, error: { code: 'FILE_CONFLICT' } })
  expect(await readFile(path.join(dir, 'README.md'), 'utf8')).toBe('before')
  expect(
    await handleGatewayMessage(
      rpc('file.write', { ...args, expectedSha256: shaText('before') }),
      context,
    ),
  ).toMatchObject({ success: true, data: { written: true } })
  expect(await readFile(path.join(dir, 'README.md'))).toEqual(bytes)
})

test('无声明长度的附件传输中断时保留原文件', async () => {
  await startRelay()
  relay!.removeAllListeners('request')
  relay!.on('request', (_request, response) => {
    // 已送达部分有效字节时切断响应，模拟上游下载中断。
    response.write(Buffer.alloc(64 * 1024, 0x41), () => response.destroy())
  })
  const result = await handleGatewayMessage(
    rpc('file.write', {
      path: 'README.md',
      encoding: 'stream',
      transfer: transferRef(),
      expectedSha256: shaText('before'),
    }),
    context,
  )
  expect(result).toMatchObject({ success: false })
  expect(await readFile(path.join(dir, 'README.md'), 'utf8')).toBe('before')
  expect(await readdir(dir)).toEqual(['README.md'])
})

test('approval 策略等待本地决定后执行', async () => {
  context.server.workspaces[0].policies.file = 'approval'
  const pending = handleGatewayMessage(
    rpc('file.write', {
      path: 'README.md',
      content: 'approved',
      expectedSha256: shaText('before'),
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
      expectedSha256: shaText('before'),
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
      expectedSha256: shaText('before'),
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
    rpc('file.delete', { path: 'README.md', expectedSha256: shaText('before') }),
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
    rpc('file.delete', { path: 'README.md', expectedSha256: shaText('before') }),
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
  const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true)
  const args = ['run', 'build', '--token', 'private-argument']
  context.config.workspaces[0].commands = [
    { id: 'build-local', name: '本机构建', executable: 'pnpm', args, timeoutMs: 120_000 },
  ]
  const provider = jest.spyOn(commandExecutionProvider, 'run').mockResolvedValue({
    ...state,
    output: '私有输出',
    truncated: true,
  })
  try {
    const request = rpc('command.run', { command: 'build-local' })
    const { id } = JSON.parse(request)
    const response = await handleGatewayMessage(request, context)
    expect(response).toMatchObject({
      success: false,
      error: { code, message: code },
      data: {
        command: 'build-local',
        output: '私有输出',
        truncated: true,
        exitCode: state.exitCode,
      },
      commandAudit: { executable: 'pnpm' },
    })
    expect(response?.data).not.toHaveProperty('timedOut')
    expect(JSON.stringify(response)).not.toMatch(/private-argument|--token|"cwd"|"timeoutMs"/)
    expect(JSON.parse(String(stderr.mock.calls[0][0]))).toMatchObject({
      event: 'command.failed',
      requestId: id,
      command: { id: 'build-local', executable: 'pnpm', args, cwd: dir, timeoutMs: 120_000 },
      ...state,
      output: '私有输出',
      truncated: true,
    })
  } finally {
    provider.mockRestore()
    stderr.mockRestore()
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
      event: 'command.start_failed',
      requestId: id,
      command: { id: 'build', executable: 'pnpm', args: ['run', 'build'], cwd: dir },
    })
    expect(JSON.parse(String(stderr.mock.calls[1][0]))).toMatchObject({
      level: 'error',
      event: 'rpc.failed',
      requestId: id,
      stage: 'execution',
      code: 'COMMAND_START_FAILED',
      durationMs: expect.any(Number),
      error: {
        message: expect.stringContaining('private-token ' + dir),
      },
    })
    expect(String(stderr.mock.calls[0][0])).not.toContain('"stack"')
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
      error: { code: 'ENOENT', path: missing, message: expect.stringContaining('ENOENT') },
    })
    expect(entry.error).not.toHaveProperty('stack')
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
