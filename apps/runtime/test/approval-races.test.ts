import { WriteApprovalQueue } from '../src/requests/write-approvals'
import type { LocalWorkspace } from '../src/workspace/state'
import type { ApprovalEvent, RpcRequest } from '@rcm/protocol'

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

test('飞书可批准写入，但通知不发送文件正文，决定仅结算一次', async () => {
  const queue = new WriteApprovalQueue()
  const events: ApprovalEvent[] = []
  const req = { ...request('one'), notifyApproval: true as const }
  const pending = queue.request(req, workspace('one'), (event) => events.push(event))
  const approvalId = queue.list()[0].id
  expect(events[0]).toMatchObject({ kind: 'approval-notice' })
  expect(JSON.stringify(events)).toContain('README.md')
  expect(JSON.stringify(events)).toContain('工作区：测试工作区')
  expect(JSON.stringify(events)).not.toMatch(/hello|\/tmp\/demo/)
  expect(queue.answerRemote('different-request', approvalId, false)).toBe(false)
  expect(queue.answerRemote(req.id, approvalId, true)).toBe(true)
  expect(queue.answer(approvalId, true)).toBe(false)
  expect(queue.answerRemote(req.id, approvalId, false)).toBe(false)
  await expect(pending).resolves.toMatchObject({ approved: true })
  expect(events[1]).toMatchObject({ kind: 'approval-closed', status: 'approved' })
})

test('只展示明确允许外发的内置命令，飞书和本地审批共享队列', async () => {
  const queue = new WriteApprovalQueue()
  const events: ApprovalEvent[] = []
  const req: RpcRequest = {
    ...request('one'),
    notifyApproval: true,
    operation: 'command.run',
    payload: { command: 'test' },
  }
  const pending = queue.request(req, workspace('one'), (event) => events.push(event))
  const approvalId = queue.list()[0].id
  expect(events[0]).toMatchObject({
    kind: 'approval-notice',
    summary: expect.stringContaining('完整命令：pnpm run test'),
  })
  expect(JSON.stringify(events)).not.toContain('/tmp/demo')
  expect(queue.answerRemote(req.id, approvalId, true)).toBe(true)
  expect(queue.answer(approvalId, false)).toBe(false)
  await expect(pending).resolves.toMatchObject({ approved: true })
})

test('未订阅时不回传审批通知，临时命令参数从不外发', async () => {
  const queue = new WriteApprovalQueue()
  const events: ApprovalEvent[] = []
  const requestLocal = queue.request(request('one'), workspace('one'), (event) =>
    events.push(event),
  )
  queue.cancelAll()
  await requestLocal
  expect(events).toHaveLength(0)
  const req: RpcRequest = {
    ...request('one'),
    notifyApproval: true,
    operation: 'command.run',
    payload: { executable: 'tool', args: ['secret-value'] },
  }
  const pending = queue.request(req, workspace('one'), (event) => events.push(event))
  expect(events[0]).toMatchObject({ kind: 'approval-notice' })
  expect(JSON.stringify(events)).not.toContain('secret-value')
  expect(queue.answerRemote(req.id, queue.list()[0].id, true)).toBe(true)
  await expect(pending).resolves.toMatchObject({ approved: true })
})
