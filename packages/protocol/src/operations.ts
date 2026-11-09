/**
 * Runtime 允许执行的操作白名单。
 * 所有远程请求必须匹配这里的操作类型，不允许任意 Shell 命令。
 */
export const Operations = [
  'file.list',
  'file.read',
  'file.search',
  'file.write',
  'file.mkdir',
  'file.move',
  'file.delete',
  'command.list',
  'command.run',
  'git.status',
  'git.diff',
] as const

/** 平台和本地 Runtime 之间共享的操作名称。 */
export type Operation = (typeof Operations)[number]

/** 会修改本地工作区的操作必须同时通过云端和 Runtime 写入权限校验。 */
export const operationRequiresWrite = (operation: Operation): boolean =>
  ['file.write', 'file.mkdir', 'file.move', 'file.delete', 'command.run'].includes(operation)
