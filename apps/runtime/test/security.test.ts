import { execute, resolveSafe } from '../src/executors'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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
    await expect(resolveSafe(ws(), 'link/secret.txt')).rejects.toThrow('SYMLINK_DENIED')
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
  await expect(execute(ws(), rpc('file.read', { path: '.env' }))).rejects.toThrow('INVALID_PATH')
})
