<script setup lang="ts">
import { provide, watch } from 'vue'
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
} from '@element-plus/icons-vue'
import { useConsole } from './use-console'
import { pagePaths } from './router'
import AuthPage from './AuthPage.vue'
import PasswordPage from './PasswordPage.vue'
const ctx = useConsole()
provide('console', ctx)
const { me, loading, page, isAdmin, title, refresh, logout } = ctx
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
</script>
<template>
  <div v-if="loading" class="loading-screen">
    <el-icon class="is-loading" size="30"><Refresh /></el-icon>
  </div>
  <AuthPage v-else-if="!me" />
  <PasswordPage v-else-if="me.passwordChangeRequired" />
  <div v-else class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark">◈</span><span class="brand-text">Remote Code MCP</span>
      </div>
      <nav class="nav">
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
          :class="{ active: page === item.id }"
          ><el-icon><component :is="item.icon" /></el-icon
          ><span class="label">{{ item.name }}</span></router-link
        >
        <div
          v-if="isAdmin"
          style="padding: 22px 13px 9px; color: #7285a0; font-size: 11px; font-weight: 700"
        >
          ADMINISTRATION
        </div>
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
          :class="{ active: page === item.id }"
          ><el-icon><component :is="item.icon" /></el-icon
          ><span class="label">{{ item.name }}</span></router-link
        >
      </nav>
      <div class="sidebar-footer">v0.1.0 · Secure by default</div>
    </aside>
    <div class="content">
      <header class="topbar">
        <div class="muted">工作空间 / {{ title }}</div>
        <div style="display: flex; align-items: center; gap: 12px">
          <span class="muted">{{ me.email }}</span
          ><el-button text @click="logout"
            ><el-icon><SwitchButton /></el-icon> 退出</el-button
          >
        </div>
      </header>

      <main class="page">
        <div class="pagehead">
          <div>
            <h1>{{ title }}</h1>
            <div class="muted">统一管理你的本地设备与 AI 工具授权</div>
          </div>
          <el-button :icon="Refresh" @click="refresh">刷新</el-button>
        </div>
        <router-view />
      </main>
    </div>
  </div>
</template>
