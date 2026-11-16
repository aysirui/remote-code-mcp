<script setup lang="ts">
import { inject } from 'vue'
import type { RuntimeContext } from './use-runtime-console'
import {
  Plus,
  Connection,
  Refresh,
  EditPen,
  Delete,
  VideoPause,
  VideoPlay,
} from '@element-plus/icons-vue'
const {
  status,
  refresh,
  showAddServer,
  serverName,
  serverGateway,
  serverBusy,
  addServer,
  activateServer,
  renameServer,
  removeServer,
  toggleConnection,
  startPair,
  finishPair,
  pairing,
  unpair,
} = inject<RuntimeContext>('runtime')!
function openActivationPage() {
  if (pairing.value?.activationUrl) window.open(pairing.value.activationUrl, '_blank', 'noopener')
}
</script>
<template>
  <section class="card">
    <div class="row between server-header">
      <div>
        <h1 class="title">设备连接</h1>
        <p class="muted">保存多个服务器，各自配对与授权；同一时间连接一个服务器。</p>
      </div>
      <el-button type="primary" :icon="Plus" :disabled="serverBusy" @click="showAddServer = true"
        >添加服务器</el-button
      >
    </div>
    <ul class="server-list">
      <li
        v-for="server in status.servers"
        :key="server.id"
        class="server-row"
        :class="{ 'server-current': server.id === status.serverId }"
      >
        <div class="server-symbol" aria-hidden="true">
          <el-icon><Connection /></el-icon>
        </div>
        <div class="server-info">
          <div class="row server-name">
            <strong>{{ server.name }}</strong
            ><el-tag v-if="server.id === status.serverId" size="small">当前服务器</el-tag>
          </div>
          <div class="server-url">{{ server.gateway }}</div>
          <div class="server-meta">
            {{ server.paired ? '配对已保存' : '尚未配对' }} ·
            {{ server.workspaceCount }} 个授权工作区
          </div>
        </div>
        <div class="server-actions">
          <el-button
            v-if="server.id !== status.serverId"
            :disabled="serverBusy"
            @click="activateServer(server)"
            >切换</el-button
          >
          <el-button
            text
            :icon="EditPen"
            :disabled="serverBusy"
            :aria-label="`重命名 ${server.name}`"
            @click="renameServer(server)"
          />
          <el-button
            text
            type="danger"
            :icon="Delete"
            :disabled="serverBusy || status.servers.length < 2"
            :aria-label="`移除 ${server.name}`"
            @click="removeServer(server)"
          />
        </div>
      </li>
    </ul>
  </section>
  <section class="card">
    <div class="row between server-header">
      <div>
        <h2 class="title">{{ status.serverName || '当前服务器' }}</h2>
        <p class="muted">{{ status.gateway }}</p>
      </div>
      <el-tag :type="status.online ? 'success' : 'info'">{{
        status.paused ? '已暂停' : status.online ? '已连接' : status.paired ? '等待连接' : '待配对'
      }}</el-tag>
    </div>
    <el-alert
      v-if="status.connectionError"
      type="error"
      :closable="false"
      :title="status.connectionError"
      class="binding-notice"
    />
    <div v-if="status.paired" class="binding-details">
      <p class="muted">
        设备：{{ status.name }} <span class="device-id">{{ status.deviceId }}</span>
      </p>
      <p class="muted">切换服务器或暂停连接都会保留绑定，重新启动后仍可恢复。</p>
      <div class="row binding-actions">
        <el-button
          :icon="status.paused ? VideoPlay : VideoPause"
          :disabled="serverBusy"
          @click="toggleConnection"
          >{{ status.paused ? '恢复连接' : '暂停连接' }}</el-button
        >
        <el-button text type="danger" :disabled="serverBusy" @click="unpair">解除绑定</el-button>
        <el-button text :icon="Refresh" :disabled="serverBusy" @click="refresh">刷新状态</el-button>
      </div>
    </div>
    <div v-else class="binding-details">
      <p class="muted">
        在此服务器配对一次后即可保存设备身份。其他服务器的绑定与工作区权限独立保留。
      </p>
      <el-button type="primary" :icon="Connection" :loading="serverBusy" @click="startPair">{{
        pairing ? '重新显示配对码' : '生成配对码'
      }}</el-button>
      <div v-if="pairing" class="pairing-panel">
        <div class="muted">请在 {{ status.serverName }} 对应的平台确认此配对码</div>
        <div class="pairing-code">{{ pairing.code }}</div>
        <div class="row binding-actions">
          <el-button @click="openActivationPage">打开平台授权页面</el-button>
          <el-button type="primary" :loading="serverBusy" @click="finishPair"
            >我已确认，完成绑定</el-button
          >
        </div>
      </div>
    </div>
  </section>
  <el-dialog v-model="showAddServer" title="添加服务器" width="min(500px, 95vw)">
    <el-form label-position="top" @submit.prevent="addServer">
      <el-form-item label="名称（可选）"
        ><el-input v-model="serverName" placeholder="例如：本地开发、远程环境" maxlength="80"
      /></el-form-item>
      <el-form-item label="服务器地址"
        ><el-input
          v-model="serverGateway"
          placeholder="http://localhost:3000 或 https://rcm.example.com"
      /></el-form-item>
      <p class="muted">填写服务器根地址，无需 /mcp。新增服务器默认不获得已有工作区的访问权限。</p>
    </el-form>
    <template #footer
      ><el-button @click="showAddServer = false">取消</el-button
      ><el-button
        type="primary"
        :loading="serverBusy"
        :disabled="!serverGateway.trim()"
        @click="addServer"
        >保存并切换</el-button
      ></template
    >
  </el-dialog>
</template>
<style scoped>
.server-header {
  align-items: flex-start;
  flex-wrap: wrap;
}
.server-header .title {
  margin: 0 0 8px;
}
.server-header p {
  margin: 0;
}
.server-list {
  list-style: none;
  margin: 20px 0 0;
  padding: 0;
}
.server-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px 0;
  border-top: 1px solid var(--el-border-color-lighter);
}
.server-symbol {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  border-radius: 8px;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
  font-size: 20px;
}
.server-current .server-symbol {
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}
.server-info {
  min-width: 0;
  flex: 1;
}
.server-name {
  flex-wrap: wrap;
  gap: 8px;
}
.server-url {
  margin-top: 6px;
  font-size: 13px;
  color: #526176;
  overflow-wrap: anywhere;
}
.server-meta {
  margin-top: 6px;
  color: #64748b;
  font-size: 12px;
}
.server-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}
.server-actions .el-button + .el-button {
  margin-left: 0;
}
.binding-details {
  margin-top: 20px;
}
.binding-details p {
  overflow-wrap: anywhere;
}
.binding-actions {
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 16px;
}
.binding-actions .el-button + .el-button {
  margin-left: 0;
}
.device-id {
  display: block;
  margin-top: 4px;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
}
.binding-notice {
  margin-top: 16px;
}
.pairing-panel {
  margin-top: 20px;
  padding: 20px;
  border-radius: 10px;
  background: var(--el-color-primary-light-9);
}
.pairing-code {
  margin: 12px 0 20px;
  font-size: 28px;
  font-weight: 700;
  letter-spacing: 3px;
}
@media (max-width: 600px) {
  .server-row {
    flex-wrap: wrap;
    gap: 12px;
  }
  .server-actions {
    width: 100%;
    justify-content: flex-end;
  }
}
</style>

<style scoped>
.server-header h1.title {
  font-size: 23px;
  font-weight: 650;
  letter-spacing: -0.025em;
}
.server-meta,
.server-url,
.device-id {
  color: var(--ui-muted);
}
.server-current .server-symbol {
  background: var(--ui-selected);
  color: var(--ui-accent);
}
.pairing-panel {
  border-radius: 6px;
}
@media (max-width: 760px) {
  .server-header h1.title {
    font-size: 21px;
  }
}
</style>
