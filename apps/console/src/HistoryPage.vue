<script setup lang="ts">
import { computed, inject, shallowRef } from 'vue'
import type { ConsoleContext } from './use-console'
import { usePagedList } from './use-paged-list'
import DataListPanel from './DataListPanel.vue'
import RecordDetails from './RecordDetails.vue'
import { shortId, dateParts, fullDate, operationLabel } from './list-format'
import type { OperationLog } from './api'
import { Lock, Document } from '@element-plus/icons-vue'
const { listRevision, devices, workspaces } = inject<ConsoleContext>('console')!
const {
  items: logs,
  page,
  pageSize,
  total,
  busy,
  error,
  load,
  resize,
} = usePagedList<OperationLog>('/api/me/operation-logs', listRevision)
const selected = shallowRef<OperationLog | null>(null)
const workspaceName = (id: string) =>
  workspaces.value.find((w) => w.id === id)?.name || '工作区 · ' + shortId(id)
const deviceName = (id?: string | null) =>
  devices.value.find((d) => d.id === id)?.name || '设备 · ' + shortId(id)
const fields = computed(() =>
  selected.value
    ? [
        { label: '工具', value: selected.value.toolName },
        { label: '结果', value: selected.value.status === 'success' ? '执行成功' : '执行失败' },
        { label: '耗时', value: selected.value.durationMs + ' ms' },
        { label: '时间', value: fullDate(selected.value.createdAt) },
        { label: '错误码', value: selected.value.errorCode },
        { label: '客户端 ID', value: selected.value.clientId, copy: true },
        { label: '工作区 ID', value: selected.value.workspaceId, copy: true },
        { label: '设备 ID', value: selected.value.deviceId, copy: true },
        { label: '记录 ID', value: selected.value.id, copy: true },
      ]
    : [],
)
</script>
<template>
  <p class="list-privacy">
    <el-icon><Lock /></el-icon>仅记录执行元数据，源码、命令内容和 AI 对话不会保存。
  </p>
  <DataListPanel
    title="执行明细"
    :count="total"
    :page="page"
    :page-size="pageSize"
    :busy="busy"
    :error="error"
    :has-items="!!logs.length"
    empty-title="还没有操作记录"
    empty-description="AI 客户端执行工具后，结果与耗时会显示在这里。"
    @page="page = $event"
    @size="resize"
    @retry="load"
  >
    <el-table :data="logs" class="record-table" row-key="id">
      <el-table-column label="工具操作" min-width="180"
        ><template #default="{ row }"
          ><div class="record-identity">
            <span class="record-symbol"
              ><el-icon><Document /></el-icon
            ></span>
            <div class="record-text">
              <strong>{{ operationLabel(row.toolName) }}</strong
              ><span class="record-secondary record-mono">{{ row.toolName }}</span>
            </div>
          </div></template
        ></el-table-column
      >
      <el-table-column label="工作区 / 设备" min-width="190"
        ><template #default="{ row }"
          ><div class="record-text">
            <span class="record-primary" :title="workspaceName(row.workspaceId)">{{
              workspaceName(row.workspaceId)
            }}</span
            ><span class="record-secondary">{{ deviceName(row.deviceId) }}</span>
          </div></template
        ></el-table-column
      >
      <el-table-column label="执行结果" width="116"
        ><template #default="{ row }"
          ><span class="record-status" :class="row.status === 'success' ? 'positive' : 'negative'"
            ><i />{{ row.status === 'success' ? '成功' : '失败' }}</span
          ><span
            v-if="row.errorCode"
            class="record-secondary record-error"
            :title="row.errorCode"
            >{{ row.errorCode }}</span
          ></template
        ></el-table-column
      >
      <el-table-column label="耗时" width="96" align="right"
        ><template #default="{ row }"
          ><span class="record-number">{{ row.durationMs }}<small> ms</small></span></template
        ></el-table-column
      >
      <el-table-column label="执行时间" width="144"
        ><template #default="{ row }"
          ><div class="record-text record-date">
            <span>{{ dateParts(row.createdAt).date }}</span
            ><span class="record-secondary">{{ dateParts(row.createdAt).time }}</span>
          </div></template
        ></el-table-column
      >
      <el-table-column label="" width="88" align="right"
        ><template #default="{ row }"
          ><el-button
            class="record-detail-button"
            text
            :aria-label="'查看' + (row.email || row.name || row.toolName || row.eventType) + '详情'"
            @click="selected = row"
            >详情</el-button
          ></template
        ></el-table-column
      >
    </el-table>
  </DataListPanel>
  <RecordDetails
    :open="!!selected"
    title="执行明细详情"
    :fields="fields"
    @close="selected = null"
  />
</template>
