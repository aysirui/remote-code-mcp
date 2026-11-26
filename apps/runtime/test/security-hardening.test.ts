import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { execute } from '../src/operations/executors'
import { readFileBytes } from '../src/workspace/io'
import {
  inspectDeleteTarget,
  moveChecked,
  mkdirChecked,
} from '../src/operations/file/file-operations'
import { gitAdd, gitDiff, gitStatus } from '../src/operations/git/git-operations'
import { startLocalServer } from '../src/local/local-server'
import { LocalEvents } from '../src/local/local-events'
import { WriteApprovalQueue } from '../src/requests/write-approvals'
import type { LocalWorkspace } from '../src/workspace/state'
import type { RpcRequest } from '@rcm/protocol'
import { logger } from '../src/logger'

let base: string
let root: string
const workspace = (): LocalWorkspace => ({
  id: 'security-test',
  name: '安全测试',
  root,
  enabled: true,
  permissions: { read: true, write: true },
  policies: { file: 'allow', git: 'allow', command: 'allow' },
})
const rpc = (operation: RpcRequest['operation'], payload: unknown): RpcRequest => ({
  kind: 'request',
  version: 1,
  id: 'test',
  workspaceId: 'security-test',
  operation,
  payload,
  deadlineAt: Date.now() + 10000,
})
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString()
const initGit = async () => {
  git('init')
  git('config', 'user.name', '安全测试')
  git('config', 'user.email', 'audit@example.invalid')
  await fs.writeFile(path.join(root, 'sample.txt'), 'baseline')
  git('add', 'sample.txt')
  git(
    '-c',
    'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
    'commit',
    '-m',
    'baseline',
  )
}

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'rcm-hardening-'))
  root = path.join(base, 'workspace')
  await fs.mkdir(root)
})
afterEach(async () => {
  // 仅删除本用例创建的临时树。
  if (
    path.dirname(base) !== path.resolve(os.tmpdir()) ||
    !path.basename(base).startsWith('rcm-hardening-')
  )
    throw Error('INVALID_TEST_CLEANUP')
  await fs.rm(base, { recursive: true, force: true })
})

test('本地管理 API 的大小写变体均不能绕过令牌，写入审批也受保护', async () => {
  const approvals = new WriteApprovalQueue()
  const pending = approvals.request(
    rpc('file.write', { path: 'sample.txt', content: 'safe' }),
    workspace(),
  )
  const approval = approvals.list()[0]
  let statusError = false
  const server = startLocalServer({
    port: 0,
    localKey: 'test-local-key',
    config: { version: 2, name: '测试', activeServerId: 'server', servers: [], workspaces: [] },
    approvals,
    events: new LocalEvents(),
    status: () => {
      if (statusError) throw Error('private-status-value')
      return { private: 'status' }
    },
    disconnect: () => {},
    connect: () => {},
    sync: async () => {},
  })
  await new Promise<void>((resolve) => server.on('listening', resolve))
  const port = (server.address() as { port: number }).port
  const request = (url: string, token?: string, post = false) =>
    new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: url,
          method: post ? 'POST' : 'GET',
          headers: {
            Host: '127.0.0.1:0',
            'Content-Type': 'application/json',
            ...(token ? { Authorization: 'Bearer ' + token } : {}),
          },
        },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode!))
        },
      )
      req.on('error', reject)
      req.end(post ? JSON.stringify({ approve: true }) : undefined)
    })
  const logs = jest.spyOn(logger, 'error').mockImplementation(() => undefined)
  const debug = jest.spyOn(logger, 'debug').mockImplementation(() => undefined)
  try {
    for (const prefix of ['/local/api', '/LOCAL/API', '/Local/Api']) {
      expect(await request(prefix + '/status')).toBe(401)
      expect(await request(prefix + '/write-approvals/' + approval.id, undefined, true)).toBe(401)
    }
    expect(approvals.list()).toHaveLength(1)
    expect(await request('/local/api/status', 'wrong-key')).toBe(401)
    expect(await request('/local/api/status?view=full', 'test-local-key')).toBe(200)
    expect(debug).toHaveBeenCalledWith(
      'local.request.completed',
      expect.objectContaining({
        url: '/local/api/status?view=full',
        query: { view: 'full' },
      }),
    )
    statusError = true
    expect(await request('/local/api/status?token=private-query', 'test-local-key')).toBe(500)
    expect(logs).toHaveBeenCalledWith(
      'local.request.exception',
      expect.objectContaining({
        code: 'LOCAL_INTERNAL_ERROR',
        url: '/local/api/status?token=private-query',
        query: { token: 'private-query' },
        error: { message: 'private-status-value' },
      }),
    )
    expect(logs).toHaveBeenCalledWith(
      'local.request.failed',
      expect.objectContaining({
        httpStatus: 500,
        route: '/status',
        method: 'GET',
        url: '/local/api/status?token=private-query',
        query: { token: 'private-query' },
      }),
    )
    expect(logs).toHaveBeenCalledWith(
      'local.request.failed',
      expect.objectContaining({
        httpStatus: 401,
        method: 'POST',
        url: `/LOCAL/API/write-approvals/${approval.id}`,
        body: { approve: true },
      }),
    )
    expect(JSON.stringify([logs.mock.calls, debug.mock.calls])).not.toMatch(
      /wrong-key|test-local-key/,
    )
  } finally {
    debug.mockRestore()
    logs.mockRestore()
    approvals.cancelAll()
    await pending
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('硬链接不能被读取、搜索、写入、移动、递归检查或 Git 暂存', async () => {
  await initGit()
  const outside = path.join(base, 'private.txt')
  await fs.writeFile(outside, 'PRIVATE_CANARY')
  await fs.link(outside, path.join(root, 'alias.txt'))
  await expect(readFileBytes(workspace(), 'alias.txt', 512 * 1024)).rejects.toThrow(
    'HARD_DENY_HARDLINK',
  )
  await expect(execute(workspace(), rpc('file.read', { path: 'alias.txt' }))).rejects.toThrow(
    'HARD_DENY_HARDLINK',
  )
  const matches = await execute(
    workspace(),
    rpc('file.search', { path: '.', query: 'PRIVATE_CANARY' }),
  )
  expect(matches).toEqual([])
  await expect(
    execute(workspace(), rpc('file.write', { path: 'alias.txt', content: 'changed' })),
  ).rejects.toThrow('HARD_DENY_HARDLINK')
  await expect(moveChecked(workspace(), 'alias.txt', 'renamed.txt')).rejects.toThrow(
    'HARD_DENY_HARDLINK',
  )
  await expect(inspectDeleteTarget(root)).rejects.toThrow()
  await expect(gitAdd(workspace(), ['alias.txt'])).rejects.toThrow('HARD_DENY_HARDLINK')
  expect(await fs.readFile(outside, 'utf8')).toBe('PRIVATE_CANARY')
})

test('Git diff 不能通过受跟踪的硬链接泄露工作区外内容', async () => {
  await initGit()
  await fs.unlink(path.join(root, 'sample.txt'))
  const outside = path.join(base, 'private.txt')
  await fs.writeFile(outside, 'PRIVATE_CANARY')
  await fs.link(outside, path.join(root, 'sample.txt'))
  await expect(gitDiff(workspace())).rejects.toThrow('HARD_DENY_HARDLINK')
})

test('Git 暂存安全检查保留二进制内容，正常文件 Diff 仍然可用', async () => {
  await initGit()
  const content = Buffer.from([0, 255, 128, 1, 42])
  await fs.writeFile(path.join(root, 'asset.bin'), content)
  await gitAdd(workspace(), ['asset.bin'])
  const staged = execFileSync('git', ['show', ':asset.bin'], { cwd: root })
  expect(staged).toEqual(content)
  await fs.writeFile(path.join(root, 'sample.txt'), 'ordinary changed')
  expect(await gitDiff(workspace())).toContain('ordinary changed')
})

test.each([false, true])('所有 Git 查询拒绝外部 filter，包括 include 配置：%s', async (include) => {
  await initGit()
  await fs.writeFile(
    path.join(root, 'filter.cjs'),
    "require('node:fs').writeFileSync('marker.txt','executed');process.stdin.pipe(process.stdout)",
  )
  if (include) {
    await fs.writeFile(
      path.join(root, '.git', 'filter-config'),
      '[filter "audit"]\n clean = node filter.cjs\n',
    )
    git('config', 'include.path', 'filter-config')
  } else git('config', 'filter.audit.clean', 'node filter.cjs')
  await fs.writeFile(path.join(root, '.gitattributes'), 'sample.txt filter=audit\n')
  await fs.writeFile(path.join(root, 'sample.txt'), 'modified content')
  for (const query of [gitDiff, gitStatus])
    await expect(query(workspace())).rejects.toThrow('GIT_FILTERS_NOT_ALLOWED')
  await expect(fs.stat(path.join(root, 'marker.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('默认凭据目录及其内部子目录不能作为授权根目录', async () => {
  const privateDir = path.join(root, '.remote-code-mcp')
  await fs.mkdir(path.join(privateDir, 'nested'), { recursive: true })
  await fs.writeFile(path.join(privateDir, 'config.json'), '{"deviceToken":"FAKE"}')
  await expect(
    readFileBytes(workspace(), '.remote-code-mcp/config.json', 512 * 1024),
  ).rejects.toThrow()
  await expect(
    readFileBytes({ ...workspace(), root: privateDir }, 'config.json', 512 * 1024),
  ).rejects.toThrow()
  await expect(
    execute(
      { ...workspace(), root: path.join(privateDir, 'nested') },
      rpc('file.list', { path: '.' }),
    ),
  ).rejects.toThrow()
})

test('工作区祖先被替换为链接时不能重新解释原授权根目录', async () => {
  const originalRoot = root
  const parent = path.join(base, 'parent')
  await fs.mkdir(parent)
  root = path.join(parent, 'project')
  await fs.mkdir(root)
  await fs.writeFile(path.join(root, 'sample.txt'), 'safe')
  const w = workspace()
  const outside = path.join(base, 'outside')
  await fs.mkdir(path.join(outside, 'project'), { recursive: true })
  await fs.writeFile(path.join(outside, 'project', 'sample.txt'), 'PRIVATE_CANARY')
  await fs.rename(parent, path.join(base, 'original-parent'))
  await fs.symlink(outside, parent, process.platform === 'win32' ? 'junction' : 'dir')
  try {
    await expect(readFileBytes(w, 'sample.txt', 512 * 1024)).rejects.toThrow(
      'HARD_DENY_WORKSPACE_ROOT_CHANGED',
    )
  } finally {
    await fs.unlink(parent)
    root = originalRoot
  }
})

test('自定义 Runtime 数据目录按真实路径保护，不能通过重命名或单独授权绕过', async () => {
  const custom = path.join(root, 'custom-runtime-data')
  await fs.mkdir(custom)
  await fs.writeFile(path.join(custom, 'config.json'), 'FAKE_TOKEN')
  const previous = process.env.RUNTIME_DATA_DIR
  let safety!: typeof import('../src/workspace/path-safety')
  try {
    process.env.RUNTIME_DATA_DIR = custom
    jest.isolateModules(() => {
      safety = jest.requireActual('../src/workspace/path-safety')
    })
  } finally {
    if (previous === undefined) delete process.env.RUNTIME_DATA_DIR
    else process.env.RUNTIME_DATA_DIR = previous
  }
  await expect(safety.resolveSafe(workspace(), 'custom-runtime-data/config.json')).rejects.toThrow(
    'HARD_DENY_RUNTIME_DATA',
  )
  await expect(safety.resolveSafe({ ...workspace(), root: custom }, '.')).rejects.toThrow(
    'HARD_DENY_RUNTIME_DATA',
  )
})

test('底层目录创建和移动也拒绝 Windows ADS 与尾随点', async () => {
  await fs.writeFile(path.join(root, 'sample.txt'), 'safe')
  for (const destination of ['file:stream', 'trailing.', 'CON']) {
    await expect(mkdirChecked(workspace(), destination, true)).rejects.toThrow()
    await expect(moveChecked(workspace(), 'sample.txt', destination)).rejects.toThrow()
  }
})

test('Command allow 策略允许已登记程序执行', async () => {
  const marker = path.join(root, 'command-marker.txt')
  const w = {
    ...workspace(),
    commands: [
      {
        id: 'unsafe',
        name: '测试',
        executable: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed')`],
      },
    ],
  }
  await expect(execute(w, rpc('command.run', { command: 'unsafe' }))).resolves.toMatchObject({
    exitCode: 0,
  })
  expect(await fs.readFile(marker, 'utf8')).toBe('executed')
})
