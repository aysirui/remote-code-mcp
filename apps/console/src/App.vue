<script setup lang="ts">
import { computed, provide, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  Monitor,
  FolderOpened,
  Connection,
  DataAnalysis,
  User,
  Warning,
  Refresh,
  Lock,
  SwitchButton,
  Reading,
} from '@element-plus/icons-vue'
import { useConsole } from './composables/use-console'
import { pagePaths } from './router'
import AuthPage from './views/auth/index.vue'
import PasswordPage from './views/password/index.vue'
const ctx = useConsole()
provide('console', ctx)
const { me, loading, page, isAdmin, title, refresh, refreshing, logout } = ctx
const router = useRouter()
/** 管理页仅管理员可打开；未登录与首次改密由根布局统一拦截展示。 */
watch(
  [loading, me, page],
  () => {
    if (
      !loading.value &&
      me.value &&
      !me.value.passwordChangeRequired &&
      String(page.value).startsWith('admin-') &&
      !isAdmin.value
    )
      void router.replace('/console')
  },
  { immediate: true },
)
const descriptions: Record<string, string> = {
  overview: '查看设备连接与工作区授权概况',
  devices: '管理已绑定设备及其连接状态',
  workspaces: '查看 Runtime 同步的工作区权限与工具策略',
  connections: '连接 AI 客户端，管理持久授权',
  history: '追踪工具执行结果与耗时',
  'admin-users': '管理平台账户及访问状态',
  'admin-audit': '追踪权限变更与平台安全事件',
  'admin-devices': '查看平台设备，撤销失效授权',
  'admin-overview': '了解平台资源与连接状态',
}
// 在线文档独立发布，开发环境可回退到本地 /docs/ 代理。
const docsUrl = import.meta.env.VITE_DOCS_URL || '/docs/'
const pageDescription = computed(() => descriptions[page.value] || '管理设备与 AI 工具授权')
</script>
<template>
  <router-view v-if="$route.name === 'activate-email'" />
  <div v-else-if="loading" class="loading-screen">
    <el-icon class="is-loading" size="30"><Refresh /></el-icon>
  </div>
  <AuthPage v-else-if="!me" />
  <PasswordPage v-else-if="me.passwordChangeRequired" />
  <div v-else class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <img class="brand-mark" src="/logo-square.svg" alt="" width="32" height="32" />
        <span class="brand-text">
          Remote Code
          <span class="brand-caption">控制中心</span>
        </span>
      </div>
      <nav class="nav" aria-label="控制台导航">
        <div class="nav-group-label">工作空间</div>
        <router-link
          v-for="item in [
            { id: 'overview', name: '工作台概览', icon: DataAnalysis },
            { id: 'devices', name: '我的设备', icon: Monitor },
            { id: 'workspaces', name: '工作区', icon: FolderOpened },
            { id: 'connections', name: 'AI 连接', icon: Connection },
            { id: 'history', name: '操作记录', icon: Warning },
          ]"
          :key="item.id"
          :to="pagePaths[item.id]"
          :title="item.name"
          :aria-current="page === item.id ? 'page' : undefined"
          :class="{ active: page === item.id }">
          <el-icon><component :is="item.icon" /></el-icon>
          <span class="label">{{ item.name }}</span>
        </router-link>
        <div v-if="isAdmin" class="nav-group-label">平台管理</div>
        <router-link
          v-for="item in isAdmin
            ? [
                { id: 'admin-overview', name: '平台概览', icon: DataAnalysis },
                { id: 'admin-users', name: '用户管理', icon: User },
                { id: 'admin-devices', name: '平台设备', icon: Monitor },
                { id: 'admin-audit', name: '安全审计', icon: Lock },
              ]
            : []"
          :key="item.id"
          :to="pagePaths[item.id]"
          :title="item.name"
          :aria-current="page === item.id ? 'page' : undefined"
          :class="{ active: page === item.id }">
          <el-icon><component :is="item.icon" /></el-icon>
          <span class="label">{{ item.name }}</span>
        </router-link>
        <!-- 文档是独立静态站点，使用普通链接离开 Console 路由。 -->
        <a :href="docsUrl" title="使用文档">
          <el-icon><Reading /></el-icon>
          <span class="label">使用文档</span>
        </a>
      </nav>
      <div class="sidebar-footer">
        <span class="security-dot"></span>
        授权访问 · 安全连接
      </div>
    </aside>
    <div class="content">
      <header class="topbar">
        <div class="breadcrumbs">
          <span>控制中心</span>
          <span>/</span>
          <strong>{{ title }}</strong>
        </div>
        <div class="account-actions">
          <span class="account-email" :title="me.email">{{ me.email }}</span>
          <el-button text @click="logout">
            <el-icon><SwitchButton /></el-icon>
            退出
          </el-button>
        </div>
      </header>

      <main class="page">
        <div class="pagehead">
          <div>
            <h1>{{ title }}</h1>
            <div class="muted">{{ pageDescription }}</div>
          </div>
          <el-button :icon="Refresh" :loading="refreshing" @click="refresh">刷新</el-button>
        </div>
        <router-view />
      </main>
    </div>
  </div>
</template>
