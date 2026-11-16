<script setup lang="ts">
import { inject, ref } from 'vue'
import type { ConsoleContext } from './use-console'
import { useLocalPage } from './use-local-page'
import ListFooter from './ListFooter.vue'
import { CopyDocument, Link, Refresh } from '@element-plus/icons-vue'
const { mcpUrl, grants, revokeGrant, copyUrl, refresh } = inject<ConsoleContext>('console')!
const refreshing = ref(false)
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})
function formatDate(value?: string | null) {
  if (!value) return '暂无记录'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间不可用' : dateFormat.format(date)
}
async function refreshGrants() {
  refreshing.value = true
  try {
    await refresh()
  } finally {
    refreshing.value = false
  }
}
const { rows, page, pageSize, total, resize } = useLocalPage(grants)
</script>
<template>
  <div class="card connections-card">
    <h2 class="card-title">ChatGPT MCP 连接</h2>
    <p class="connection-description">
      在 ChatGPT 插件管理页面创建自定义 MCP Server，填写下面的 URL，并使用当前账号完成 OAuth 授权。
    </p>
    <div class="connection-url">
      <el-input aria-label="MCP Server URL" readonly :model-value="mcpUrl" />
      <el-button type="primary" :icon="CopyDocument" @click="copyUrl">复制 URL</el-button>
    </div>
    <el-divider />
    <section aria-labelledby="grants-title" :aria-busy="refreshing">
      <div class="grants-header">
        <div>
          <h2 id="grants-title" class="card-title">
            已授权的 AI 客户端 <span class="grants-count">{{ grants.length }}</span>
          </h2>
          <p class="grants-description">管理可访问 MCP 工具的客户端，随时撤销授权。</p>
        </div>
        <el-button :icon="Refresh" :loading="refreshing" @click="refreshGrants">刷新</el-button>
      </div>
      <ul v-if="grants.length" class="grants-list">
        <li v-for="g in rows" :key="g.clientId" class="grant-row">
          <div class="grant-icon" aria-hidden="true">
            <el-icon><Link /></el-icon>
          </div>
          <div class="grant-content">
            <div class="grant-heading">
              <h3>{{ g.clientName || '未命名客户端' }}</h3>
              <el-tag
                v-for="scope in g.scope.split(' ').filter(Boolean)"
                :key="scope"
                size="small"
                effect="plain"
                :title="scope"
              >
                {{ scope === 'mcp:tools' ? 'MCP 工具' : scope }}
              </el-tag>
            </div>
            <p class="grant-client-id">
              <span>客户端 ID</span><code>{{ g.clientId }}</code>
            </p>
            <dl class="grant-times">
              <div>
                <dt>首次授权</dt>
                <dd>
                  <time :datetime="g.createdAt">{{ formatDate(g.createdAt) }}</time>
                </dd>
              </div>
              <div>
                <dt>最近签发 / 刷新</dt>
                <dd>
                  <time v-if="g.lastUsedAt" :datetime="g.lastUsedAt">{{
                    formatDate(g.lastUsedAt)
                  }}</time
                  ><span v-else>暂无记录</span>
                </dd>
              </div>
            </dl>
          </div>
          <el-button
            class="grant-revoke"
            type="danger"
            plain
            :aria-label="`撤销 ${g.clientName || g.clientId} 的授权`"
            @click="revokeGrant(g)"
            >撤销授权</el-button
          >
        </li>
      </ul>
      <el-empty v-else description="暂无已授权 AI 客户端，请在客户端使用上方 URL 完成授权。" />
      <p class="grants-timezone">时间按当前设备时区显示（{{ timeZone }}）</p>
    </section>
    <el-divider />
    <el-alert
      type="info"
      :closable="false"
      title="授权说明"
      description="ChatGPT 只能操作你当前账号下的设备和工作区。文件写入仍受本地 Runtime 权限约束。"
    />
    <ListFooter
      v-if="total > 10"
      :page="page"
      :page-size="pageSize"
      :total="total"
      :busy="false"
      @page="page = $event"
      @size="resize"
    />
  </div>
</template>
<style scoped>
.connection-description,
.grants-description,
.grants-timezone {
  color: #64748b;
  font-size: 13px;
  line-height: 1.6;
}
.connection-description {
  margin: 0;
}
.connection-url {
  display: flex;
  gap: 12px;
  margin-top: 20px;
}
.grants-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 8px;
}
.grants-header .card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.grants-count {
  color: #64748b;
  font-size: 13px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.grants-description {
  margin: 0;
}
.grants-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.grant-row {
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr) auto;
  align-items: start;
  gap: 16px;
  padding: 24px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.grant-row:last-child {
  border-bottom: none;
}
.grant-icon {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-size: 20px;
}
.grant-content {
  min-width: 0;
}
.grant-heading {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.grant-heading h3 {
  margin: 0;
  font-size: 15px;
  line-height: 24px;
  overflow-wrap: anywhere;
}
.grant-client-id {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  margin: 6px 0 16px;
  color: #64748b;
  font-size: 12px;
  line-height: 1.6;
}
.grant-client-id code {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  overflow-wrap: anywhere;
}
.grant-times {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 32px;
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
}
.grant-times dt {
  margin-bottom: 4px;
  color: #64748b;
}
.grant-times dd {
  margin: 0;
  color: var(--el-text-color-primary);
  font-variant-numeric: tabular-nums;
}
.grants-timezone {
  margin: 12px 0 0;
  font-size: 12px;
}
@media (max-width: 640px) {
  .grants-header {
    flex-wrap: wrap;
  }
  .grants-header > div {
    flex-basis: 100%;
  }
  .connections-card {
    padding: 16px;
  }
  .grant-row {
    grid-template-columns: 32px minmax(0, 1fr);
    gap: 12px;
  }
  .grant-icon {
    width: 32px;
    height: 32px;
    border-radius: 8px;
  }
  .grant-revoke {
    grid-column: 2;
    justify-self: start;
  }
  .grant-times {
    flex-direction: column;
  }
  .connection-url {
    flex-wrap: wrap;
  }
}
</style>
