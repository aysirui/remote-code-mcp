import { execute, resolveSafe } from '../src/executors'
import { mkdtemp, rm, symlink, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { gitAdd, gitCommit, gitApprovalContext, gitStatus } from '../src/git-operations'
import { runCheckedCommand } from '../src/command-operations'
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
  approvalRequired: false,
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

test('Command timeout terminates the process group instead of only the direct child', async () => {
  const command = {
    id: 'long-running',
    name: 'Long running test',
    executable: process.execPath,
    args: [
      '-e',
      "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); setInterval(() => {}, 1000)",
    ],
  }
  const result = await runCheckedCommand(
    {
      ...ws(true),
      commands: [command],
    },
    'long-running',
    150,
  )
  expect(result.output).toContain('COMMAND_TIMEOUT')
  expect(result.exitCode).not.toBe(0)
})
