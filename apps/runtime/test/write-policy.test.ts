import { defaultWorkspacePolicies, policyForOperation, type LocalWorkspace } from '../src/state'
import { WriteApprovalQueue, WRITE_APPROVAL_TIMEOUT_MS } from '../src/write-approvals'
import { listCommands, validateLocalCommand } from '../src/command-operations'
import { assertSafeRelativePath } from '../src/path-safety'
import {
  operationRequiresWrite,
  operationRequiresLocalApproval,
  type RpcRequest,
} from '@rcm/protocol'

/** 构造有写入权限的工作区，用于验证旧配置与独立策略。 */
const workspace = (
  policies: LocalWorkspace['policies'] = defaultWorkspacePolicies,
): LocalWorkspace => ({
  id: 'workspace-test',
  name: 'demo',
  root: '/tmp/demo',
  enabled: true,
  permissions: { read: true, write: true },
  policies: { ...policies },
})

const request: RpcRequest = {
  kind: 'request',
  version: 1,
  id: 'request-test',
  workspaceId: 'workspace-test',
  operation: 'file.write',
  payload: { path: 'README.md', content: 'updated' },
  approvalRequired: false,
  deadlineAt: Date.now() + 60000,
}

test('File、Git、Command 三个工具域拥有独立的三档策略', () => {
  const w = workspace({ file: 'deny', git: 'approval', command: 'allow' })
  expect(policyForOperation(w, 'file.read')).toBe('deny')
  expect(policyForOperation(w, 'git.log')).toBe('approval')
  expect(policyForOperation(w, 'command.run')).toBe('allow')
})

test('未知策略不应意外放行', () => {
  const w = workspace({
    file: 'invalid' as 'deny',
    git: 'invalid' as 'deny',
    command: 'invalid' as 'deny',
  })
  expect(policyForOperation(w, 'file.read')).toBe('deny')
})

test('审批等待上限为五分钟', () => {
  expect(WRITE_APPROVAL_TIMEOUT_MS).toBe(5 * 60 * 1000)
})

test('审批详情只在待处理期间存在，结束后立即从队列移除', async () => {
  const queue = new WriteApprovalQueue()
  const pending = queue.request(
    request,
    workspace({ file: 'approval', git: 'allow', command: 'approval' }),
  )
  const [approval] = queue.list()
  expect(approval.expiresAt - approval.createdAt).toBe(WRITE_APPROVAL_TIMEOUT_MS)
  expect(approval.path).toBe('README.md')
  expect(approval.workspaceName).toBe('demo')
  queue.answer(approval.id, false)
  await expect(pending).resolves.toMatchObject({ approved: false, requestHash: expect.any(String) })
  expect(queue.list()).toHaveLength(0)
})

test('切换写入策略时可立即取消旧的人工审批请求', async () => {
  const queue = new WriteApprovalQueue()
  const pending = queue.request(
    request,
    workspace({ file: 'approval', git: 'allow', command: 'approval' }),
  )
  expect(queue.list()).toHaveLength(1)
  queue.rejectWorkspace('workspace-test')
  await expect(pending).resolves.toMatchObject({ approved: false, requestHash: expect.any(String) })
  expect(queue.list()).toHaveLength(0)
})

test('旧版 git-log 命令不再出现在 Command Registry', () => {
  const legacy = {
    id: 'git-log',
    name: '最近 Git 提交',
    executable: 'git',
    args: ['log'],
  }
  expect(listCommands({ ...workspace(), commands: [legacy] }).map((item) => item.id)).not.toContain(
    'git-log',
  )
  expect(() => validateLocalCommand(legacy)).toThrow('INVALID_COMMAND')
})

test('Hard Deny 在审批前拒绝路径穿越、绝对路径、ADS 和敏感目录', () => {
  for (const value of [
    '../outside',
    '/etc/passwd',
    'C:secret.txt',
    'file:stream',
    '.git/config',
    '.env.local',
    '.ssh/id_ed25519',
  ]) {
    expect(() => assertSafeRelativePath(value)).toThrow()
  }
})

test('Hard Deny 拒绝 Windows 保留设备名和尾随点空格', () => {
  for (const value of ['CON', 'NUL.txt', 'folder/name.', 'folder/name ']) {
    expect(() => assertSafeRelativePath(value)).toThrow()
  }
})

test('工作区根目录仅允许显式读取，不允许作为文件修改路径', () => {
  expect(() => assertSafeRelativePath('.', false)).toThrow()
  expect(() => assertSafeRelativePath('.', true)).not.toThrow()
})

test('Command 执行必须具备工作区写权限，Git 只读查询不需要', () => {
  expect(operationRequiresWrite('file.write')).toBe(true)
  expect(operationRequiresWrite('file.delete')).toBe(true)
  expect(operationRequiresWrite('command.run')).toBe(true)
  expect(operationRequiresWrite('git.log')).toBe(false)
  expect(operationRequiresWrite('git.add')).toBe(true)
  expect(operationRequiresWrite('git.commit')).toBe(true)
})

test('Command 是否逐次审批由 Command 策略决定，不再被固定操作规则强制审批', () => {
  expect(operationRequiresLocalApproval('file.delete')).toBe(false)
  expect(operationRequiresLocalApproval('command.run')).toBe(false)
  expect(operationRequiresLocalApproval('git.add')).toBe(true)
  expect(operationRequiresLocalApproval('git.commit')).toBe(true)
  expect(operationRequiresLocalApproval('file.write')).toBe(false)
  expect(operationRequiresLocalApproval('git.status')).toBe(false)
})

test('Command Registry 不允许直接调用 Git 可执行程序', () => {
  expect(() =>
    validateLocalCommand({
      id: 'git-status',
      name: 'Git 状态',
      executable: 'git',
      args: ['status'],
    }),
  ).toThrow('SHELL_EXECUTABLE_DENIED')
})
