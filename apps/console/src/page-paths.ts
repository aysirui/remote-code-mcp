/** 路由与真实 URL 一一对应，支持页面刷新、浏览器前进后退与直接访问。 */
export const pagePaths: Record<string, string> = {
  overview: '/console',
  devices: '/console/devices',
  activate: '/activate',
  workspaces: '/console/workspaces',
  connections: '/console/connections',
  'approval-channels': '/console/approval-channels',
  history: '/console/history',
  'admin-overview': '/admin',
  'admin-users': '/admin/users',
  'admin-devices': '/admin/devices',
  'admin-audit': '/admin/audit',
}
