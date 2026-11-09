<script setup lang="ts">
import { inject } from 'vue'
import type { ConsoleContext } from './use-console'
import { CopyDocument } from '@element-plus/icons-vue'
const { mcpUrl, grants, revokeGrant, copyUrl } = inject<ConsoleContext>('console')!
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
    <h3 class="card-title">已授权的 AI 客户端</h3>
    <div v-for="g in grants" :key="g.clientId" class="device-row">
      <div style="flex: 1">
        <strong>{{ g.clientId }}</strong>
        <div class="muted">{{ g.scope }} · {{ new Date(g.expiresAt).toLocaleString() }} 过期</div>
      </div>
      <el-button type="danger" text @click="revokeGrant(g)">撤销</el-button>
    </div>
    <el-empty v-if="!grants.length" description="暂无有效 OAuth 授权" /><el-divider /><el-alert
      type="info"
      :closable="false"
      title="授权说明"
      description="ChatGPT 只能操作你当前账号下的设备和工作区。文件写入仍受本地 Runtime 权限约束。"
    />
  </div>
</template>
