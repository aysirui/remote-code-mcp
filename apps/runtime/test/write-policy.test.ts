import { getWritePolicy, requiresWriteApproval, type LocalWorkspace } from '../src/state'
import { WriteApprovalQueue } from '../src/write-approvals'
import type { RpcRequest } from '@rcm/protocol'

/** 构造有写入权限的工作区，用于验证旧配置与独立策略。 */
const workspace = (policy?: LocalWorkspace['writePolicy']): LocalWorkspace => ({
  id: 'workspace-test',
  name: 'demo',
  root: '/tmp/demo',
  enabled: true,
  permissions: { read: true, write: true },
  ...(policy ? { writePolicy: policy } : {}),
})

const request: RpcRequest = {
  kind: 'request',
  version: 1,
  id: 'request-test',
  workspaceId: 'workspace-test',
  operation: 'file.write',
  payload: { path: 'README.md', content: 'updated' },
  deadlineAt: Date.now() + 60000,
}

test('旧版工作区缺少策略字段时保持逐次审批', () => {
  expect(getWritePolicy(workspace())).toBe('approval')
  expect(requiresWriteApproval(workspace())).toBe(true)
})

test('工作区可独立选择自动写入和逐次审批', () => {
  const a = workspace('auto')
  const b = workspace('approval')
  expect(requiresWriteApproval(a)).toBe(false)
  expect(requiresWriteApproval(b)).toBe(true)
  expect(getWritePolicy({ ...a, writePolicy: 'unexpected' as 'auto' })).toBe('approval')
})

test('切换写入策略时可立即取消旧的人工审批请求', async () => {
  const queue = new WriteApprovalQueue()
  const pending = queue.request(request, workspace('approval'))
  expect(queue.list()).toHaveLength(1)
  queue.rejectWorkspace('workspace-test')
  await expect(pending).resolves.toBe(false)
  expect(queue.list()).toHaveLength(0)
})
