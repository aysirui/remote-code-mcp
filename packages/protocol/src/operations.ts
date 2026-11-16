/**
 * Runtime 允许执行的操作白名单。
 * Git、文件和受限命令是三个独立工具域；Git 操作不得通过 command.run 间接执行。
 */
export const Operations = [
  'file.list',
  'file.read',
  'file.search',
  'file.write',
  'file.mkdir',
  'file.move',
  'file.delete',
  'git.status',
  'git.log',
  'git.diff',
  'git.add',
  'git.commit',
  'command.list',
  'command.run',
] as const

/** 平台和本地 Runtime 之间共享的操作名称。 */
export type Operation = (typeof Operations)[number]

/** 会修改工作区或执行本地程序的操作必须同时通过云端和 Runtime 写权限校验。 */
export const operationRequiresWrite = (operation: Operation): boolean =>
  [
    'file.write',
    'file.mkdir',
    'file.move',
    'file.delete',
    'git.add',
    'git.commit',
    'command.run',
  ].includes(operation)

/**
 * Git 暂存和提交始终需要 Runtime 本机逐次确认；
 * 文件删除是否需要审批由 Runtime 根据本地真实目录项数量进行风险评估。
 * Command 是否需要审批完全由云端与本地 Command 策略决定。
 */
export const operationRequiresLocalApproval = (operation: Operation): boolean =>
  ['git.add', 'git.commit'].includes(operation)
