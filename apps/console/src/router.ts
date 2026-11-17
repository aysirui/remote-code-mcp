import { createRouter, createWebHistory } from 'vue-router'
const OverviewPage = () => import('./views/overview/index.vue')
const DevicesPage = () => import('./views/devices/index.vue')
const ActivatePage = () => import('./views/activate/index.vue')
const WorkspacesPage = () => import('./views/workspaces/index.vue')
const ConnectionsPage = () => import('./views/connections/index.vue')
const HistoryPage = () => import('./views/history/index.vue')
const AdminOverviewPage = () => import('./views/admin/overview/index.vue')
const AdminUsersPage = () => import('./views/admin/users/index.vue')
const AdminDevicesPage = () => import('./views/admin/devices/index.vue')
const AdminAuditPage = () => import('./views/admin/audit/index.vue')

export { pagePaths } from './page-paths'
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/activate-email',
      name: 'activate-email',
      component: () => import('./views/activate-email/index.vue'),
    },
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
