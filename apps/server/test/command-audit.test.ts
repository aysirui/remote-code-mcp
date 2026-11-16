import { commandAuditSummary, sanitizeCommandAudit } from '@rcm/protocol'
import { Store } from '../src/store'

test('常见任务保留具体程序和参数，程序绝对路径不会进入摘要', () => {
  expect(
    commandAuditSummary({ executable: 'C:\\private\\node\\pnpm.cmd', args: ['run', 'build'] }),
  ).toBe('pnpm run build')
  expect(
    commandAuditSummary({ executable: '/home/private/bin/npm', args: ['run', 'test', '--watch'] }),
  ).toBe('npm run test --watch')
})

test.each([
  ['路径参数', ['run', 'build', '--dir', '/home/private/project']],
  ['相对路径', ['run', 'build', '../private']],
  ['凭据参数', ['run', 'build', '--token', 'test']],
  ['脚本正文', ['-e', 'console.log("secret")']],
  ['连接信息', ['https://user:password@example.com']],
  ['未知参数', ['private-value']],
])('%s 默认隐藏，连续脱敏结果稳定', (_, args) => {
  const safe = sanitizeCommandAudit({ executable: 'node', args })
  expect(safe.args).not.toContain(args[args.length - 1])
  expect(sanitizeCommandAudit(safe)).toEqual(safe)
})

test('未知程序名和全部参数隐藏', () => {
  expect(commandAuditSummary({ executable: '/private/private-program', args: ['build'] })).toBe(
    '[已隐藏] [已隐藏]',
  )
})

test('数据库仅持久化再次脱敏后的摘要，不保留命令结构或原值', async () => {
  const values = jest.fn().mockResolvedValue(undefined)
  const store = { db: { insert: () => ({ values }) } } as unknown as Store
  await Store.prototype.logOperation.call(store, {
    operationId: 'operation',
    userId: 'user',
    workspaceId: 'workspace',
    clientId: 'client',
    toolName: 'command_run',
    operationType: 'command',
    status: 'success',
    durationMs: 1,
    commandAudit: { executable: '/private/bin/pnpm', args: ['run', 'build', '--token', 'secret'] },
  })
  expect(values).toHaveBeenCalledWith(
    expect.objectContaining({ commandSummary: 'pnpm run build [已隐藏] [已隐藏]' }),
  )
  expect(JSON.stringify(values.mock.calls)).not.toContain('/private')
  expect(JSON.stringify(values.mock.calls)).not.toContain('secret')
  expect(values.mock.calls[0][0]).not.toHaveProperty('commandAudit')
})
