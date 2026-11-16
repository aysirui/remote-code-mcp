<script setup lang="ts">
import { computed, inject, shallowRef } from 'vue'
import type { ConsoleContext } from '../../../composables/use-console'
import { usePagedList } from '../../../composables/use-paged-list'
import DataListPanel from '../../../components/data-list/DataListPanel.vue'
import RecordDetails from '../../../components/data-list/RecordDetails.vue'
import { shortId, dateParts, fullDate } from '../../../utils/list-format'
import type { Device } from '../../../api'
import { Monitor } from '@element-plus/icons-vue'
const { listRevision, adminRevoke } = inject<ConsoleContext>('console')!
const {
  items: records,
  page,
  pageSize,
  total,
  busy,
  error,
  load,
  resize,
} = usePagedList<Device>('/api/admin/devices', listRevision)
const selected = shallowRef<Device | null>(null)
const fields = computed(() =>
  selected.value
    ? [
        { label: '设备名称', value: selected.value.name },
        { label: '设备 ID', value: selected.value.id, copy: true },
        { label: '所属用户 ID', value: selected.value.userId, copy: true },
        { label: '系统平台', value: selected.value.platform },
        { label: 'Runtime 版本', value: selected.value.runtimeVersion },
        { label: '授权状态', value: selected.value.status === 'revoked' ? '已撤销' : '有效' },
        { label: '连接状态', value: selected.value.online ? '在线' : '离线' },
        { label: '最近连接', value: fullDate(selected.value.lastSeenAt) },
      ]
    : [],
)
</script>
<template>
  <DataListPanel
    title="全部设备"
    :count="total"
    :page="page"
    :page-size="pageSize"
    :busy="busy"
    :error="error"
    :has-items="!!records.length"
    empty-title="还没有平台设备"
    empty-description="用户完成 Runtime 绑定后，设备会显示在这里。"
    order="最近连接在前"
    @page="page = $event"
    @size="resize"
    @retry="load">
    <el-table :data="records" class="record-table" row-key="id">
      <el-table-column label="设备" min-width="220">
        <template #default="{ row }">
          <div class="record-identity">
            <span class="record-symbol">
              <el-icon><Monitor /></el-icon>
            </span>
            <div class="record-text">
              <strong>{{ row.name }}</strong>
              <span class="record-secondary">
                {{ row.platform }}
                <span v-if="row.runtimeVersion">· v{{ row.runtimeVersion }}</span>
              </span>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="所属用户" min-width="150">
        <template #default="{ row }">
          <span class="record-mono record-secondary" :title="row.userId">
            {{ shortId(row.userId) }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="设备状态" width="120">
        <template #default="{ row }">
          <span
            class="record-status"
            :class="row.status === 'revoked' ? 'neutral' : row.online ? 'positive' : 'neutral'">
            <i />
            {{ row.status === 'revoked' ? '已撤销' : row.online ? '在线' : '离线' }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="最近连接" width="144">
        <template #default="{ row }">
          <div class="record-text record-date">
            <span>{{ dateParts(row.lastSeenAt).date }}</span>
            <span class="record-secondary">{{ dateParts(row.lastSeenAt).time }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="授权管理" width="116" align="right">
        <template #default="{ row }">
          <el-button
            text
            type="danger"
            :disabled="row.status === 'revoked'"
            @click="adminRevoke(row)">
            撤销授权
          </el-button>
        </template>
      </el-table-column>
      <el-table-column label="" width="88" align="right">
        <template #default="{ row }">
          <el-button
            class="record-detail-button"
            text
            :aria-label="'查看' + (row.email || row.name || row.toolName || row.eventType) + '详情'"
            @click="selected = row">
            详情
          </el-button>
        </template>
      </el-table-column>
    </el-table>
  </DataListPanel>
  <RecordDetails
    :open="!!selected"
    title="全部设备详情"
    :fields="fields"
    @close="selected = null" />
</template>
