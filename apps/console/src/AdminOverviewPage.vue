<script setup lang="ts">
import { inject } from 'vue'
import type { ConsoleContext } from './use-console'
const { stats } = inject<ConsoleContext>('console')!
</script>
<template>
  <div class="stat-grid">
    <div
      v-for="s in [
        { label: '注册用户', value: stats.users },
        { label: '总设备 / 在线', value: stats.devices + ' / ' + stats.online },
        { label: '工作区总数', value: stats.workspaces },
      ]"
      :key="s.label"
      class="card"
    >
      <div class="stat-label">{{ s.label }}</div>
      <div class="stat-number">{{ s.value }}</div>
    </div>
  </div>
  <div class="notice">
    管理员可以管理用户、设备与平台状态，但无法直接读取普通用户的本地源码内容。
  </div>
</template>
