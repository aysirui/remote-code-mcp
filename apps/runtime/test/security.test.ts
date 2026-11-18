import { execute, resolveSafe } from '../src/operations/executors'
import { mkdtemp, rm, symlink, writeFile, mkdir, stat, utimes } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  gitAdd,
  gitCommit,
  gitApprovalContext,
  gitStatus,
} from '../src/operations/git/git-operations'
import { runCheckedCommand } from '../src/operations/command/command-operations'
import {
  inspectDeleteTarget,
  deleteChecked,
  HIGH_RISK_DELETE_THRESHOLD,
} from '../src/operations/file/file-operations'
import { createHash } from 'node:crypto'
import type { RpcRequest } from '@rcm/protocol'

let workspaceRoot: string
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const ws = (write = false) => ({
  id: 'workspace-test',
  name: 'test',
  enabled: true,
  root: workspaceRoot,
  permissions: { read: true, write },
  policies: { file: 'allow', git: 'allow', command: 'approval' } as const,
})
const rpc = (operation: RpcRequest['operation'], payload: unknown): RpcRequest => ({
  kind: 'request',
  version: 1,
  id: 'test-request',
  workspaceId: 'workspace-test',
  operation,
  payload,
  deadlineAt: Date.now() + 15000,
})

beforeEach(async () => {
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'rcm-security-'))
  await writeFile(path.join(workspaceRoot, 'README.md'), 'original')
})
afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true })
})

test('rejects directory traversal and absolute paths', async () => {
  for (const requested of [
    '../private.txt',
    '/etc/passwd',
    '.git/config',
    '.env',
    '.npmrc',
    'nested/.env.production',
  ]) {
    await expect(resolveSafe(ws(), requested)).rejects.toThrow()
  }
})

test('rejects symlink pointing outside authorized directory', async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), 'rcm-out-'))
  try {
    await writeFile(path.join(outside, 'secret.txt'), 'secret')
    await symlink(outside, path.join(workspaceRoot, 'link'), 'junction')
    await expect(resolveSafe(ws(), 'link/secret.txt')).rejects.toThrow('HARD_DENY_SYMLINK')
    await expect(execute(ws(), rpc('file.read', { path: 'link/secret.txt' }))).rejects.toThrow()
  } finally {
    await rm(outside, { recursive: true, force: true })
  }
})

test('write is rejected for read-only workspace', async () => {
  await expect(
    execute(
      ws(false),
      rpc('file.write', {
        path: 'README.md',
        content: 'different',
        expectedSha256: sha('original'),
      }),
    ),
  ).rejects.toThrow('PERMISSION_DENIED')
})

test('write requires current hash, and stale hash fails', async () => {
  await execute(
    ws(true),
    rpc('file.write', {
      path: 'README.md',
      content: 'replaced',
      expectedSha256: sha('original'),
    }),
  )
  await expect(
    execute(
      ws(true),
      rpc('file.write', {
        path: 'README.md',
        content: 'stale',
        expectedSha256: sha('original'),
      }),
    ),
  ).rejects.toThrow('FILE_CONFLICT')
  const read = await execute(ws(), rpc('file.read', { path: 'README.md' }))
  expect(read).toHaveProperty('content', 'replaced')
})

test('sensitive files cannot be read directly', async () => {
  await writeFile(path.join(workspaceRoot, '.env'), 'SECRET=DO_NOT_EXPOSE')
  await expect(execute(ws(), rpc('file.read', { path: '.env' }))).rejects.toThrow(
    'HARD_DENY_PATH_SEGMENT',
  )
})

test('Git add and commit use dedicated operations and bind staged file content to approval', async () => {
  execFileSync('git', ['init'], { cwd: workspaceRoot })
  execFileSync('git', ['config', 'user.name', 'Runtime Test'], { cwd: workspaceRoot })
  execFileSync('git', ['config', 'user.email', 'runtime-test@example.invalid'], {
    cwd: workspaceRoot,
  })

  const before = await gitApprovalContext(ws(true), 'git.add', { paths: ['README.md'] })
  await writeFile(path.join(workspaceRoot, 'README.md'), 'changed while approval was pending')
  const after = await gitApprovalContext(ws(true), 'git.add', { paths: ['README.md'] })
  expect(after.fingerprint).not.toBe(before.fingerprint)

  const staged = await gitAdd(ws(true), ['README.md'])
  expect(staged.staged).toEqual(['README.md'])
  const commit = await gitCommit(ws(true), 'Add README')
  expect(commit.committed).toEqual(['README.md'])
  expect(commit.output).toContain('Add README')
})

test('Git add rejects sensitive files and directories', async () => {
  execFileSync('git', ['init'], { cwd: workspaceRoot })
  await writeFile(path.join(workspaceRoot, '.env'), 'TOKEN=secret')
  await expect(gitAdd(ws(true), ['.env'])).rejects.toThrow()
  await expect(gitAdd(ws(true), ['.'])).rejects.toThrow()
})

test('Git tools reject a repository rooted outside the authorized workspace', async () => {
  execFileSync('git', ['init'], { cwd: workspaceRoot })
  const nested = path.join(workspaceRoot, 'nested')
  await mkdir(nested)
  await expect(gitStatus({ ...ws(), root: nested })).rejects.toThrow(
    'GIT_REPOSITORY_OUTSIDE_WORKSPACE',
  )
})

test('Git add rejects repositories with configured external filters', async () => {
  execFileSync('git', ['init'], { cwd: workspaceRoot })
  execFileSync('git', ['config', 'filter.test.clean', 'type nul'], { cwd: workspaceRoot })
  await expect(gitAdd(ws(true), ['README.md'])).rejects.toThrow('GIT_FILTERS_NOT_ALLOWED')
})

test('已登记命令在 allow 下可以运行，并保留超时终止', async () => {
  const command = {
    id: 'long-running',
    name: '超时测试',
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
  }
  const result = await runCheckedCommand(
    {
      ...ws(true),
      policies: { file: 'allow', git: 'allow', command: 'allow' },
      commands: [command],
    },
    { command: 'long-running' },
    undefined,
    150,
  )
  expect(result.timedOut).toBe(true)
})

test('普通文件和小目录删除不达到高危阈值，批量目录删除超过 20 项触发高危判定', async () => {
  const small = path.join(workspaceRoot, 'small')
  await mkdir(small)
  await writeFile(path.join(small, 'one.txt'), '1')
  const smallSnapshot = await inspectDeleteTarget(small)
  expect(smallSnapshot.entryCount).toBe(1)
  expect(smallSnapshot.entryCount > HIGH_RISK_DELETE_THRESHOLD).toBe(false)

  const batch = path.join(workspaceRoot, 'batch')
  await mkdir(batch)
  for (let index = 0; index < HIGH_RISK_DELETE_THRESHOLD + 1; index++) {
    await writeFile(path.join(batch, 'file-' + index + '.txt'), String(index))
  }
  const batchSnapshot = await inspectDeleteTarget(batch)
  expect(batchSnapshot.entryCount).toBe(21)
  expect(batchSnapshot.entryCount > HIGH_RISK_DELETE_THRESHOLD).toBe(true)
  await expect(deleteChecked(ws(true), 'batch', true)).rejects.toThrow(
    'HIGH_RISK_DELETE_REQUIRES_APPROVAL',
  )
})

test('目录内容在审批等待期间变化时，删除执行必须拒绝旧资源快照', async () => {
  const batch = path.join(workspaceRoot, 'approved')
  await mkdir(batch)
  await writeFile(path.join(batch, 'one.txt'), 'one')
  const snapshot = await inspectDeleteTarget(batch)
  await writeFile(path.join(batch, 'two.txt'), 'two')
  await expect(
    deleteChecked(ws(true), 'approved', true, undefined, snapshot.fingerprint),
  ).rejects.toThrow('DELETE_TARGET_CHANGED_DURING_APPROVAL')
  await expect(resolveSafe(ws(), 'approved')).resolves.toBe(batch)
})

test('递归删除工作区根目录始终被 Hard Deny 拒绝', async () => {
  await expect(deleteChecked(ws(true), '.', true)).rejects.toThrow()
})

test('allow 策略下单文件与 20 项以内的小目录删除无需额外审批', async () => {
  const fileHash = sha('original')
  await deleteChecked(ws(true), 'README.md', false, fileHash)
  await expect(resolveSafe(ws(), 'README.md')).rejects.toThrow()

  const small = path.join(workspaceRoot, 'small-delete')
  await mkdir(small)
  await writeFile(path.join(small, 'one.txt'), 'one')
  await deleteChecked(ws(true), 'small-delete', true)
  await expect(resolveSafe(ws(), 'small-delete')).rejects.toThrow()
})

test('审批快照拒绝同长度内容改写，即使恢复修改时间', async () => {
  const folder = path.join(workspaceRoot, 'same-size')
  await mkdir(folder)
  const filename = path.join(folder, 'data.txt')
  await writeFile(filename, 'before')
  const before = await stat(filename)
  const snapshot = await inspectDeleteTarget(folder)
  await writeFile(filename, 'after!')
  await utimes(filename, before.atime, before.mtime)
  await expect(
    deleteChecked(ws(true), 'same-size', true, undefined, snapshot.fingerprint),
  ).rejects.toThrow('DELETE_TARGET_CHANGED_DURING_APPROVAL')
})

test('20 项允许直接删除，21 项审批快照不变后允许执行', async () => {
  for (const count of [20, 21]) {
    const name = 'boundary-' + count
    const folder = path.join(workspaceRoot, name)
    await mkdir(folder)
    for (let i = 0; i < count; i++) await writeFile(path.join(folder, i + '.txt'), 'x')
    const snapshot = await inspectDeleteTarget(folder)
    expect(snapshot.entryCount).toBe(count)
    await expect(
      deleteChecked(ws(true), name, true, undefined, count > 20 ? snapshot.fingerprint : undefined),
    ).resolves.toMatchObject({ deleted: true })
  }
})

test('删除树中的敏感项不能通过审批放行', async () => {
  const folder = path.join(workspaceRoot, 'sensitive-delete')
  await mkdir(folder)
  await writeFile(path.join(folder, '.env'), 'secret')
  await expect(inspectDeleteTarget(folder)).rejects.toThrow('SENSITIVE_PATH_DENIED')
  await expect(
    deleteChecked(ws(true), 'sensitive-delete', true, undefined, 'approved'),
  ).rejects.toThrow('SENSITIVE_PATH_DENIED')
})
