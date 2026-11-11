import { resolveSafe, execute } from '../src/executors'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
let dir: string
const ws = () => ({
  id: 'test',
  name: 'test',
  root: dir,
  permissions: { read: true, write: false },
  policies: { file: 'allow', git: 'allow', command: 'approval' } as const,
  enabled: true,
})
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'rcm-test-'))
  await writeFile(path.join(dir, 'README.md'), 'hello')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})
test('blocks path traversal', async () => {
  await expect(resolveSafe(ws(), '../outside')).rejects.toThrow('HARD_DENY_PATH_SEGMENT')
})
test('reads and hashes file', async () => {
  const r = await execute(ws(), {
    kind: 'request',
    id: 'x',
    workspaceId: 'test',
    version: 1,
    operation: 'file.read',
    payload: { path: 'README.md' },
    approvalRequired: false,
    deadlineAt: Date.now() + 1000,
  })
  expect(r).toHaveProperty('content', 'hello')
  expect(r).toHaveProperty('sha256')
})
test('denies write in read-only workspace', async () => {
  await expect(
    execute(ws(), {
      kind: 'request',
      id: 'x',
      workspaceId: 'test',
      version: 1,
      operation: 'file.write',
      payload: { path: 'README.md', content: 'hacked' },
      approvalRequired: false,
      deadlineAt: Date.now() + 1000,
    }),
  ).rejects.toThrow('PERMISSION_DENIED')
})
