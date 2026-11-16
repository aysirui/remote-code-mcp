import { createRouter, createWebHistory } from 'vue-router'
import RuntimeConnectionPage from './views/connection/index.vue'
import RuntimeWorkspacesPage from './views/workspaces/index.vue'
import RuntimeApprovalsPage from './views/approvals/index.vue'

/** 本地管理路由共用一个 Runtime/SSE 会话，切换页面不会重复订阅事件。 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/connection' },
    { path: '/connection', name: 'connection', component: RuntimeConnectionPage },
    { path: '/workspaces', name: 'workspaces', component: RuntimeWorkspacesPage },
    { path: '/approvals', name: 'approvals', component: RuntimeApprovalsPage },
    { path: '/:pathMatch(.*)*', redirect: '/connection' },
  ],
})
