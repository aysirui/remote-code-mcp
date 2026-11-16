import { requiresApproval } from '../src/requests/approval-policy'
import type { LocalWorkspace } from '../src/workspace/state'
import type { RpcRequest, Operation } from '@rcm/protocol'

const workspace = (policies: LocalWorkspace['policies']): LocalWorkspace => ({
  id: 'workspace',
  name: 'demo',
  root: '/tmp/demo',
  enabled: true,
  permissions: { read: true, write: true },
  policies,
})
const request = (operation: Operation, payload: unknown = {}): RpcRequest => ({
  kind: 'request',
  version: 1,
  id: 'request',
  workspaceId: 'workspace',
  operation,
  payload,
  deadlineAt: Date.now() + 60000,
})

test('allow 下常规文件操作与已登记命令无需审批', async () => {
  const w = workspace({ file: 'allow', git: 'allow', command: 'allow' })
  await expect(
    requiresApproval(w, request('file.write', { path: 'a', content: 'x' })),
  ).resolves.toBe(false)
  await expect(requiresApproval(w, request('command.run', { command: 'test' }))).resolves.toBe(
    false,
  )
})

test('approval 策略要求确认，Git 写操作即使 allow 也要求确认', async () => {
  const w = workspace({ file: 'approval', git: 'allow', command: 'allow' })
  await expect(requiresApproval(w, request('file.read', { path: 'a' }))).resolves.toBe(true)
  await expect(requiresApproval(w, request('git.add', { paths: ['a'] }))).resolves.toBe(true)
  await expect(requiresApproval(w, request('git.commit', { message: 'test' }))).resolves.toBe(true)
})

test('未登记临时命令必须审批，非递归删除在 allow 下无需审批', async () => {
  const w = workspace({ file: 'allow', git: 'allow', command: 'allow' })
  await expect(
    requiresApproval(
      w,
      request('command.run', {
        executable: 'pnpm',
        args: ['test'],
      }),
    ),
  ).resolves.toBe(true)
  await expect(
    requiresApproval(
      w,
      request('file.delete', {
        path: 'a',
        recursive: false,
      }),
    ),
  ).resolves.toBe(false)
})
