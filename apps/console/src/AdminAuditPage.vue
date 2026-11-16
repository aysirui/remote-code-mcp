<script setup lang="ts">
import { computed, inject, shallowRef } from 'vue'
import type { ConsoleContext } from './use-console'
import { usePagedList } from './use-paged-list'
import DataListPanel from './DataListPanel.vue'
import RecordDetails from './RecordDetails.vue'
import { shortId, dateParts, fullDate, resourceLabel, eventLabel } from './list-format'
import type { SecurityAudit } from './api'
import { Lock } from '@element-plus/icons-vue'
const { listRevision } = inject<ConsoleContext>('console')!
const {
  items: records,
  page,
  pageSize,
  total,
  busy,
  error,
  load,
  resize,
} = usePagedList<SecurityAudit>('/api/admin/security-audits', listRevision)
const selected = shallowRef<SecurityAudit | null>(null)
const fields = computed(() =>
  selected.value
    ? [
        { label: '安全事件', value: eventLabel(selected.value.eventType) },
        { label: '事件标识', value: selected.value.eventType },
        { label: '操作者类型', value: selected.value.actorType === 'admin' ? '管理员' : '用户' },
        { label: '操作者 ID', value: selected.value.actorId, copy: true },
        { label: '资源类型', value: resourceLabel(selected.value.resourceType) },
        { label: '资源 ID', value: selected.value.resourceId, copy: true },
        { label: '结果', value: selected.value.result === 'success' ? '成功' : '失败' },
        { label: '发生时间', value: fullDate(selected.value.createdAt) },
        { label: '记录 ID', value: selected.value.id, copy: true },
      ]
    : [],
)
</script>
<template>
  <p class="list-privacy">
    <el-icon><Lock /></el-icon>记录账号与授权变更，审计内容不包含本地源码或 AI 对话。
  </p>
  <DataListPanel
    title="安全事件"
    :count="total"
    :page="page"
    :page-size="pageSize"
    :busy="busy"
    :error="error"
    :has-items="!!records.length"
    empty-title="还没有安全事件"
    empty-description="账号、设备与授权发生变更时，会在这里留下审计记录。"
    @page="page = $event"
    @size="resize"
    @retry="load"
  >
    <el-table :data="records" class="record-table" row-key="id">
      <el-table-column label="安全事件" min-width="210"
        ><template #default="{ row }"
          ><div class="record-identity">
            <span class="record-symbol"
              ><el-icon><Lock /></el-icon
            ></span>
            <div class="record-text">
              <strong>{{ eventLabel(row.eventType) }}</strong
              ><span class="record-secondary record-mono">{{ row.eventType }}</span>
            </div>
          </div></template
        ></el-table-column
      >
      <el-table-column label="操作者" min-width="150"
        ><template #default="{ row }"
          ><div class="record-text">
            <span>{{ row.actorType === 'admin' ? '管理员' : '用户' }}</span
            ><span class="record-secondary record-mono" :title="row.actorId">{{
              shortId(row.actorId)
            }}</span>
          </div></template
        ></el-table-column
      >
      <el-table-column label="关联资源" min-width="150"
        ><template #default="{ row }"
          ><div class="record-text">
            <span>{{ resourceLabel(row.resourceType) }}</span
            ><span class="record-secondary record-mono" :title="row.resourceId">{{
              shortId(row.resourceId)
            }}</span>
          </div></template
        ></el-table-column
      >
      <el-table-column label="结果" width="104"
        ><template #default="{ row }"
          ><span class="record-status" :class="row.result === 'success' ? 'positive' : 'negative'"
            ><i />{{ row.result === 'success' ? '成功' : '失败' }}</span
          ></template
        ></el-table-column
      >
      <el-table-column label="发生时间" width="144"
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
    title="安全事件详情"
    :fields="fields"
    @close="selected = null"
  />
</template>
