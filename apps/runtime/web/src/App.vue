<script setup lang="ts">
import { provide } from 'vue'
import { FolderOpened, Connection, Refresh, DocumentChecked } from '@element-plus/icons-vue'
import { useRuntimeConsole } from './use-runtime-console'
const ctx = useRuntimeConsole()
provide('runtime', ctx)
const { token, status, writeApprovals, refresh } = ctx
</script>
<template>
  <div class="runtime-shell">
    <aside class="runtime-sidebar">
      <div class="runtime-brand">
        <img class="mark" src="/remote-code-logo.png" alt="" width="32" height="32" />
        <div>Remote Code<small>本地 Runtime</small></div>
      </div>
      <div class="runtime-nav-label">本地管理</div>
      <nav v-if="token" class="runtime-nav" aria-label="本地管理导航">
        <router-link to="/connection"
          ><el-icon><Connection /></el-icon><span>设备连接</span></router-link
        >
        <router-link to="/workspaces"
          ><el-icon><FolderOpened /></el-icon><span>工作区</span></router-link
        >
        <router-link to="/approvals"
          ><el-icon><DocumentChecked /></el-icon><span>操作审批</span
          ><el-badge v-if="writeApprovals.length" :value="writeApprovals.length"
        /></router-link>
      </nav>
      <div class="runtime-sidebar-foot">
        本机管理界面 <span v-if="status.runtimeVersion">· v{{ status.runtimeVersion }}</span
        ><small>授权与审批由你掌控</small>
      </div>
    </aside>
    <div class="runtime-content">
      <header class="runtime-topbar">
        <div class="runtime-breadcrumb">
          本地控制中心 <span>/</span>
          <strong>{{
            $route.path === '/workspaces'
              ? '工作区'
              : $route.path === '/approvals'
                ? '操作审批'
                : '设备连接'
          }}</strong>
        </div>
        <div class="runtime-header-actions">
          <el-tag :type="status.online ? 'success' : 'info'" effect="plain">{{
            status.paused
              ? '连接已暂停'
              : !status.paired
                ? '未绑定服务器'
                : status.online
                  ? '服务器已连接'
                  : '服务器未连接'
          }}</el-tag
          ><el-button v-if="token" :icon="Refresh" aria-label="刷新本地状态" @click="refresh"
            >刷新</el-button
          >
        </div>
      </header>
      <main class="runtime-main">
        <el-alert
          v-if="!token"
          type="error"
          title="未授权访问"
          description="请使用 Runtime 启动终端中显示的本地管理 URL 打开本界面。"
          :closable="false"
        />
        <router-view v-else />
      </main>
    </div>
  </div>
</template>
