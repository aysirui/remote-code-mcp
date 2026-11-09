import { createRouter, createWebHistory } from 'vue-router'
import OverviewPage from './OverviewPage.vue'
import DevicesPage from './DevicesPage.vue'
import ActivatePage from './ActivatePage.vue'
import WorkspacesPage from './WorkspacesPage.vue'
import ConnectionsPage from './ConnectionsPage.vue'
import HistoryPage from './HistoryPage.vue'
import AdminOverviewPage from './AdminOverviewPage.vue'
import AdminUsersPage from './AdminUsersPage.vue'
import AdminDevicesPage from './AdminDevicesPage.vue'
import AdminAuditPage from './AdminAuditPage.vue'

/** 路由与真实 URL 一一对应，支持页面刷新、浏览器前进后退与直接访问。 */
export const pagePaths: Record<string, string> = {
  overview: '/console',
  devices: '/console/devices',
  activate: '/activate',
  workspaces: '/console/workspaces',
  connections: '/console/connections',
  history: '/console/history',
  'admin-overview': '/admin',
  'admin-users': '/admin/users',
  'admin-devices': '/admin/devices',
  'admin-audit': '/admin/audit',
}
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/console' },
    { path: '/console', name: 'overview', component: OverviewPage },
    { path: '/console/devices', name: 'devices', component: DevicesPage },
    { path: '/console/workspaces', name: 'workspaces', component: WorkspacesPage },
    { path: '/console/connections', name: 'connections', component: ConnectionsPage },
    { path: '/console/history', name: 'history', component: HistoryPage },
    { path: '/activate', name: 'activate', component: ActivatePage },
    { path: '/admin', name: 'admin-overview', component: AdminOverviewPage },
    { path: '/admin/users', name: 'admin-users', component: AdminUsersPage },
    { path: '/admin/devices', name: 'admin-devices', component: AdminDevicesPage },
    { path: '/admin/audit', name: 'admin-audit', component: AdminAuditPage },
    { path: '/:pathMatch(.*)*', redirect: '/console' },
  ],
})
