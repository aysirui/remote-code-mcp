<script setup lang="ts">
import { inject } from 'vue'
import type { ConsoleContext } from '../../composables/use-console'
import { Monitor } from '@element-plus/icons-vue'
const { devices, workspaces, navigate } = inject<ConsoleContext>('console')!
</script>
<template>
  <div class="stat-grid">
    <div
      v-for="s in [
        { label: '我的设备', value: devices.length },
        { label: '在线设备', value: devices.filter((d) => d.online).length },
        { label: '已授权工作区', value: workspaces.length },
      ]"
      :key="s.label"
      class="card">
      <div class="stat-label">{{ s.label }}</div>
      <div class="stat-number">{{ s.value }}</div>
    </div>
  </div>
  <div class="notice">
    <strong>连接你的开发环境</strong>
    <br />
    安装 Runtime，完成设备绑定和工作区授权，然后在 ChatGPT 中添加 MCP Server
    URL。云端默认不持久化源码内容。
  </div>
  <div class="card">
    <div class="row-between">
      <h3 class="card-title">最近设备</h3>
      <el-button text type="primary" @click="navigate('devices')">查看全部</el-button>
    </div>
    <div v-for="d in devices.slice(0, 5)" :key="d.id" class="device-row">
      <div class="device-icon">
        <el-icon><Monitor /></el-icon>
      </div>
      <div>
        <strong>{{ d.name }}</strong>
        <div class="muted">{{ d.platform }}</div>
      </div>
      <div class="spacer"></div>
      <el-tag :type="d.online ? 'success' : 'info'">{{ d.online ? '在线' : '离线' }}</el-tag>
    </div>
    <el-empty v-if="!devices.length" description="暂无设备，先安装并绑定 Runtime" />
  </div>
</template>
