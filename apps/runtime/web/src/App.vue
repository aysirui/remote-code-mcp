<script setup lang="ts">
import { provide } from 'vue'
import { FolderOpened, Connection, Refresh, DocumentChecked } from '@element-plus/icons-vue'
import { useRuntimeConsole } from './use-runtime-console'
const ctx = useRuntimeConsole()
provide('runtime', ctx)
const { token, status, writeApprovals, refresh } = ctx
</script>
<template>
  <div class="layout">
    <header class="mast">
      <div>
        <div class="brand"><span class="mark">◈</span> Remote Code Runtime</div>
        <div class="muted" style="margin-left: 51px">本地工作区与 AI 执行权限管理</div>
      </div>
      <el-tag :type="status.online ? 'success' : 'info'" size="large">
        {{ !status.paired ? '设备未绑定' : status.online ? 'Gateway 已连接' : 'Gateway 未连接' }}
      </el-tag>
    </header>
    <el-alert
      v-if="!token"
      type="error"
      title="未授权访问"
      description="请使用 Runtime 启动终端中显示的本地管理 URL 打开本界面。"
      :closable="false"
    />
    <template v-else>
      <div class="runtime-toolbar">
        <nav class="runtime-nav" aria-label="本地管理导航">
          <router-link to="/connection"
            ><el-icon><Connection /></el-icon> 设备连接</router-link
          >
          <router-link to="/workspaces"
            ><el-icon><FolderOpened /></el-icon> 工作区</router-link
          >
          <router-link to="/approvals">
            <el-icon><DocumentChecked /></el-icon> 写入审批
            <el-badge v-if="writeApprovals.length" :value="writeApprovals.length" />
          </router-link>
        </nav>
        <el-button :icon="Refresh" @click="refresh">刷新</el-button>
      </div>
      <main class="runtime-main"><router-view /></main>
    </template>
  </div>
</template>
