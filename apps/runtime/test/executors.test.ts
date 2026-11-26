import { execute } from '../src/operations/executors'
import { resolveSafe } from '../src/workspace/path-safety'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
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
      deadlineAt: Date.now() + 1000,
    }),
  ).rejects.toThrow('PERMISSION_DENIED')
})

test('搜索通过文件执行器递归匹配文本，并跳过敏感和超限文件', async () => {
  await mkdir(path.join(dir, 'src'))
  await writeFile(path.join(dir, 'src', 'sample.txt'), 'Hello\nhello\n' + 'hello'.repeat(60))
  await writeFile(path.join(dir, '.env'), 'hello')
  await writeFile(path.join(dir, 'large.txt'), 'hello'.repeat(60000))
  const result = await execute(ws(), {
    kind: 'request',
    id: 'search',
    workspaceId: 'test',
    version: 1,
    operation: 'file.search',
    payload: { path: '.', query: 'hello' },
    deadlineAt: Date.now() + 10000,
  })
  expect(result).toEqual([
    { path: 'README.md', line: 1, text: 'hello' },
    { path: 'src/sample.txt', line: 2, text: 'hello' },
    { path: 'src/sample.txt', line: 3, text: 'hello'.repeat(50) },
  ])
})
