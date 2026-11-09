<script setup lang="ts">
import { inject } from 'vue'
import type { ConsoleContext } from './use-console'
import { CopyDocument } from '@element-plus/icons-vue'
const { mcpUrl, grants, revokeGrant, copyUrl, refresh } = inject<ConsoleContext>('console')!
</script>
<template>
  <div class="card" style="max-width: 780px">
    <h3 class="card-title">ChatGPT MCP 连接</h3>
    <p class="muted">
      在 ChatGPT 插件管理页面创建自定义 MCP Server，填写下面的 URL，并使用当前账号完成 OAuth 授权。
    </p>
    <div style="display: flex; gap: 10px; margin-top: 20px">
      <el-input readonly :model-value="mcpUrl" /><el-button
        type="primary"
        :icon="CopyDocument"
        @click="copyUrl"
        >复制 URL</el-button
      >
    </div>
    <el-divider />
    <div style="display: flex; justify-content: space-between; align-items: center">
      <h3 class="card-title">已授权的 AI 客户端</h3>
      <el-button text @click="refresh">刷新</el-button>
    </div>
    <div v-for="g in grants" :key="g.clientId" class="device-row">
      <div style="flex: 1">
        <strong>{{ g.clientName || g.clientId }}</strong>
        <div class="muted">{{ g.clientId }}</div>
        <div class="muted">
          {{ g.scope }} · 授权于 {{ new Date(g.createdAt).toLocaleString() }} ·
          {{
            g.lastUsedAt
              ? '最近签发/刷新 ' + new Date(g.lastUsedAt).toLocaleString()
              : '尚无令牌记录'
          }}
        </div>
      </div>
      <el-button type="danger" text @click="revokeGrant(g)">撤销</el-button>
    </div>
    <el-empty v-if="!grants.length" description="暂无已授权 AI 客户端" /><el-divider /><el-alert
      type="info"
      :closable="false"
      title="授权说明"
      description="ChatGPT 只能操作你当前账号下的设备和工作区。文件写入仍受本地 Runtime 权限约束。"
    />
  </div>
</template>
