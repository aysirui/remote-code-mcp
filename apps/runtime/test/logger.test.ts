import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { logger } from '../src/logger'

test.each([
  [undefined, ['startup']],
  ['debug', ['receiving', 'startup']],
  ['error', []],
  ['invalid', ['startup']],
] as const)('日志级别 %s 只打印匹配级别，故障始终输出到标准错误', (level, events) => {
  const env = { ...process.env }
  if (level) env.RUNTIME_LOG_LEVEL = level
  else delete env.RUNTIME_LOG_LEVEL
  const replaced = jest.replaceProperty(process, 'env', env)
  const output = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
  const errors = jest.spyOn(process.stderr, 'write').mockReturnValue(true)
  try {
    jest.isolateModules(() => {
      const { logger } = jest.requireActual<typeof import('../src/logger')>('../src/logger')
      logger.debug('receiving')
      logger.info('startup')
      logger.error('failed', { code: 'COMMAND_TIMEOUT' })
    })
    expect(output.mock.calls.map(([line]) => JSON.parse(String(line)).event)).toEqual(events)
    expect(JSON.parse(String(errors.mock.calls[0][0]))).toEqual({
      timestamp: expect.any(String),
      level: 'error',
      event: 'failed',
      code: 'COMMAND_TIMEOUT',
    })
  } finally {
    output.mockRestore()
    errors.mockRestore()
    replaced.restore()
  }
})
test('本地日志保留原始消息、堆栈、原因和系统字段，不展开 HTTP 请求对象', () => {
  const filepath = path.resolve('unreadable.txt')
  const cause = Object.assign(new Error('无法读取 ' + filepath), {
    code: 'EACCES',
    path: filepath,
    syscall: 'open',
  })
  const error = Object.assign(new TypeError('读取失败', { cause }), {
    config: { headers: { Authorization: 'private-request-token' } },
  })
  const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true)
  try {
    logger.error('test.failed', { err: error })
    const line = String(stderr.mock.calls[0][0])
    expect(JSON.parse(line).err).toMatchObject({
      type: 'TypeError',
      message: expect.stringContaining(cause.message),
      stack: expect.stringContaining('Error: ' + cause.message),
      code: 'EACCES',
      path: filepath,
      syscall: 'open',
    })
    expect(line).not.toContain('private-request-token')
  } finally {
    stderr.mockRestore()
  }
})

test('终端用可读格式展示事件、请求详情和多行异常，重定向的输出流仍使用 JSON', () => {
  const previousTTY = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY')
  Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true })
  const output = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
  const errors = jest.spyOn(process.stderr, 'write').mockReturnValue(true)
  try {
    jest.isolateModules(() => {
      const { logger } = jest.requireActual<typeof import('../src/logger')>('../src/logger')
      logger.info('runtime.starting')
      logger.error('local.request.failed', {
        method: 'GET',
        url: '/local/api/status?view=full',
        httpStatus: 502,
        durationMs: 2,
        query: { view: 'full' },
        body: { enabled: false },
        err: new Error('读取失败'),
      })
      logger.error('rpc.failed', {
        operation: 'command.run',
        code: 'COMMAND_TIMEOUT',
        durationMs: 0,
        requestId: 'req-1',
        exitCode: null,
        truncated: false,
      })
      logger.error('local.request.exception', {
        url: '/local/api/status',
      })
    })
    expect(JSON.parse(String(output.mock.calls[0][0])).event).toBe('runtime.starting')
    const line = String(errors.mock.calls[0][0])
    expect(line).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] ERROR: local\.request\.failed\r?\n/)
    expect(line).toContain('method: "GET"')
    expect(line).toContain('url: "/local/api/status?view=full"')
    expect(line).toContain('httpStatus: 502')
    expect(line).toContain('durationMs: 2')
    expect(line).toContain('"view": "full"')
    expect(line).toContain('"enabled": false')
    expect(line).toContain('Error: 读取失败')
    expect(line).toContain('"stack":')
    const rpc = String(errors.mock.calls[1][0])
    expect(rpc).toContain('ERROR: rpc.failed')
    expect(rpc).toContain('operation: "command.run"')
    expect(rpc).toContain('code: "COMMAND_TIMEOUT"')
    expect(rpc).toContain('durationMs: 0')
    expect(rpc).toContain('requestId: "req-1"')
    expect(rpc).toContain('exitCode: null')
    expect(rpc).toContain('truncated: false')
    expect(String(errors.mock.calls[2][0])).toContain('url: "/local/api/status"')
  } finally {
    errors.mockRestore()
    output.mockRestore()
    if (previousTTY) Object.defineProperty(process.stderr, 'isTTY', previousTTY)
    else Reflect.deleteProperty(process.stderr, 'isTTY')
  }
})

test.each([
  [
    'throw new TypeError("original-error")',
    'UNCAUGHT_EXCEPTION',
    {
      type: 'TypeError',
      message: 'original-error',
      stack: expect.stringContaining('TypeError: original-error'),
    },
  ],
])('进程级故障 %s 同步输出原始错误后退出', (statement, code, err) => {
  const child = spawnSync(
    process.execPath,
    [
      '--require',
      require.resolve('tsx/cjs'),
      '-e',
      `require(${JSON.stringify(path.resolve(__dirname, '../src/main.ts'))}); setImmediate(() => { ${statement} });`,
    ],
    {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        RUNTIME_PORT: '0',
        RUNTIME_LOG_LEVEL: 'error',
        RUNTIME_DATA_DIR: path.join(tmpdir(), randomUUID()),
      },
    },
  )
  expect(child.error).toBeUndefined()
  expect(child.status).toBe(1)
  expect(JSON.parse(child.stderr.trim())).toMatchObject({ event: 'runtime.fatal', code, err })
})

test('未处理的异步异常保留堆栈，后续任务仍继续执行', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--require',
      require.resolve('tsx/cjs'),
      '-e',
      `require(${JSON.stringify(path.resolve(__dirname, '../src/main.ts'))});
      setImmediate(() => {
        void Promise.reject(new Error('async-error'));
        setTimeout(() => {
          void Promise.reject(new Error('second-error'));
          setImmediate(() => process.emit('SIGINT'));
        }, 50);
      });`,
    ],
    {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        RUNTIME_PORT: '0',
        RUNTIME_LOG_LEVEL: 'info',
        NODE_OPTIONS: '--unhandled-rejections=throw',
        RUNTIME_DATA_DIR: path.join(tmpdir(), randomUUID()),
      },
    },
  )
  expect(child.error).toBeUndefined()
  expect(child.status).toBe(0)
  const logs = child.stderr
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line))
  expect(logs).toEqual(
    ['async-error', 'second-error'].map((message) =>
      expect.objectContaining({
        event: 'runtime.unhandled_rejection',
        code: 'UNHANDLED_REJECTION',
        err: expect.objectContaining({
          message,
          stack: expect.stringContaining('Error: ' + message),
        }),
      }),
    ),
  )
  expect(child.stdout).toContain('runtime.stopping')
})
