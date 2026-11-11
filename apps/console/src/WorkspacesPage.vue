<script setup lang="ts">
import { computed, inject } from 'vue'
import type { ConsoleContext } from './use-console'

const { workspaces, devices, disableWorkspace, setCloudPolicy } = inject<ConsoleContext>('console')!
const deviceNames = computed(() => new Map(devices.value.map((device) => [device.id, device.name])))
const deviceName = (deviceId: string) => deviceNames.value.get(deviceId) || '未知设备'
</script>

<template>
  <div class="notice">
    工作区只能通过对应设备上的 Runtime 本地界面添加。云端仅保存用户设置的显示名称、稳定 ID
    和授权元数据，不接收本地目录名、绝对路径或项目结构。
  </div>
  <div class="card table-wrap">
    <el-table :data="workspaces" style="width: 100%">
      <el-table-column label="工作区信息" min-width="260">
        <template #default="{ row }">
          <div class="workspace-cell">
            <div class="workspace-cell-title">{{ row.name }}</div>
            <div class="workspace-cell-meta workspace-cell-id" :title="row.id">
              ID：{{ row.id }}
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="设备信息" min-width="280">
        <template #default="{ row }">
          <div class="workspace-cell">
            <div class="workspace-cell-title">{{ deviceName(row.deviceId) }}</div>
            <div class="workspace-cell-meta workspace-cell-id" :title="row.deviceId">
              ID：{{ row.deviceId }}
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="云端工具策略" min-width="360">
        <template #default="{ row }">
          <div class="policy-stack">
            <div
              v-for="domain in ['file', 'git', 'command'] as const"
              :key="domain"
              class="policy-row"
            >
              <span>{{ { file: 'File', git: 'Git', command: 'Command' }[domain] }}</span>
              <el-select
                :model-value="row.cloudPolicies[domain]"
                size="small"
                :aria-label="domain + ' 云端策略'"
                @change="
                  (policy: 'deny' | 'approval' | 'allow') => setCloudPolicy(row, domain, policy)
                "
              >
                <el-option label="禁止" value="deny" />
                <el-option label="审批执行" value="approval" />
                <el-option label="完全允许" value="allow" />
              </el-select>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="row.enabled ? 'success' : 'info'">{{
            row.enabled ? '启用' : '停用'
          }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="120">
        <template #default="{ row }">
          <el-button text type="danger" :disabled="!row.enabled" @click="disableWorkspace(row)">
            停用
          </el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-empty v-if="!workspaces.length" description="请在本地 Runtime 添加一个项目" />
  </div>
</template>

<style scoped>
.policy-stack {
  display: grid;
  gap: 6px;
}
.policy-row {
  display: grid;
  grid-template-columns: 78px minmax(130px, 1fr);
  align-items: center;
  gap: 8px;
}
.workspace-cell {
  min-width: 0;
  padding: 4px 0;
}
.workspace-cell-title {
  font-size: 14px;
  font-weight: 600;
  line-height: 22px;
  color: #1f2937;
}
.workspace-cell-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin-top: 4px;
  color: #738297;
  font-size: 12px;
  line-height: 18px;
}
.workspace-cell-id {
  overflow-wrap: anywhere;
}
</style>
