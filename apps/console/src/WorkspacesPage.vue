<script setup lang="ts">
import { computed, inject } from 'vue'
import type { ConsoleContext } from './use-console'
import { useLocalPage } from './use-local-page'
import ListFooter from './ListFooter.vue'

const { workspaces, devices } = inject<ConsoleContext>('console')!
const deviceNames = computed(() => new Map(devices.value.map((device) => [device.id, device.name])))
const deviceName = (deviceId: string) => deviceNames.value.get(deviceId) || '未知设备'
const policyLabels: Record<string, string> = {
  deny: '禁止',
  approval: '审批执行',
  allow: '完全允许',
}
const { rows, page, pageSize, total, resize } = useLocalPage(workspaces)
</script>

<template>
  <div class="notice">
    工作区的启用状态、读写权限和工具策略统一在对应设备的 Runtime 中设置，此处仅展示最近同步的状态。
  </div>
  <div class="card table-wrap">
    <el-table :data="rows" style="width: 100%">
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
      <el-table-column label="本地工具策略" min-width="220">
        <template #default="{ row }">
          <div class="policy-stack">
            <div
              v-for="domain in ['file', 'git', 'command'] as const"
              :key="domain"
              class="policy-row"
            >
              <span>{{ { file: 'File', git: 'Git', command: 'Command' }[domain] }}</span>
              <span>{{ policyLabels[row.policies[domain]] || '未知策略' }}</span>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="读写权限" width="120">
        <template #default="{ row }">
          {{ row.read ? (row.write ? '可读写' : '只读') : '无访问权限' }}
        </template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="row.enabled ? 'success' : 'info'">{{
            row.enabled ? '启用' : '停用'
          }}</el-tag>
        </template>
      </el-table-column>
    </el-table>
    <el-empty v-if="!workspaces.length" description="请在本地 Runtime 添加一个项目" />
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
.policy-stack {
  display: grid;
  gap: 6px;
}
.policy-row {
  display: grid;
  grid-template-columns: 78px 1fr;
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
