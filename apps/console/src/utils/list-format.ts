/** 列表显示短标识，完整值始终保留在详情中。 */
export const shortId = (value?: string | null) =>
  !value ? '未记录' : value.length > 16 ? value.slice(0, 8) + '…' + value.slice(-4) : value
export function dateParts(value?: string | null) {
  const date = value ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return { date: '暂无记录', time: '' }
  return {
    date: date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }),
    time: date.toLocaleTimeString('zh-CN', { hour12: false }),
  }
}
export const fullDate = (value?: string | null) => {
  const parts = dateParts(value)
  return [parts.date, parts.time].filter(Boolean).join(' ')
}
export const roleLabel = (value: string) =>
  (({ super_admin: '超级管理员', admin: '管理员', user: '普通用户' }) as Record<string, string>)[
    value
  ] || value
export const resourceLabel = (value?: string | null) =>
  (
    ({ user: '用户', device: '设备', workspace: '工作区', oauth_client: 'AI 客户端' }) as Record<
      string,
      string
    >
  )[value || ''] ||
  value ||
  '未记录'
export const eventLabel = (value: string) =>
  (
    ({
      'device.revoke': '撤销设备授权',
      'oauth.grant.revoke': '撤销 AI 授权',
      'user.status.change': '变更用户状态',
    }) as Record<string, string>
  )[value] || value
/** 将 MCP 工具名或 RPC 操作名转换为记录列表中的中文名称。 */
export const operationLabel = (value: string) =>
  (
    ({
      'file.read': '读取文件',
      'file.stat': '读取文件属性',
      'file.list': '浏览目录',
      'file.search': '搜索文件',
      'file.write': '写入文件',
      'file.delete': '删除文件',
      'file.mkdir': '创建目录',
      'file.move': '移动文件',
      'git.status': '查看 Git 状态',
      'git.diff': '查看代码差异',
      'git.add': '暂存变更',
      'git.commit': '创建提交',
      'git.log': '查看提交记录',
      'command.run': '执行命令',
      'command.list': '查看命令',
    }) as Record<string, string>
  )[value.replace('_', '.')] || value
