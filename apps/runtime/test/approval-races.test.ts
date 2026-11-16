import { WriteApprovalQueue } from '../src/requests/write-approvals'
import type { LocalWorkspace } from '../src/workspace/state'
import type { RpcRequest } from '@rcm/protocol'

const workspace = (id: string): LocalWorkspace => ({
  id,
  name: '测试工作区',
  root: '/tmp/demo',
  enabled: true,
  permissions: { read: true, write: true },
  policies: { file: 'approval', git: 'approval', command: 'allow' },
})

const request = (id: string): RpcRequest => ({
  kind: 'request',
  version: 1,
  id: 'request-' + id,
  workspaceId: id,
  operation: 'file.write',
  payload: { path: 'README.md', content: 'hello' },
  deadlineAt: Date.now() + 60000,
})

/** 审批队列只负责当前待处理操作，不负责连接或工作区状态的版本管理。 */
test('工作区撤销只清理对应的待审批请求', async () => {
  const queue = new WriteApprovalQueue()
  const first = queue.request(request('one'), workspace('one'))
  const second = queue.request(request('two'), workspace('two'))
  queue.rejectWorkspace('one')
  expect(queue.list().map((item) => item.workspaceId)).toEqual(['two'])
  await expect(first).resolves.toMatchObject({ approved: false })
  queue.answer(queue.list()[0].id, true)
  await expect(second).resolves.toMatchObject({ approved: true })
})

test('断开连接时取消全部待审批请求', async () => {
  const queue = new WriteApprovalQueue()
  const pending = queue.request(request('one'), workspace('one'))
  queue.cancelAll()
  expect(queue.list()).toHaveLength(0)
  await expect(pending).resolves.toMatchObject({ approved: false })
})
