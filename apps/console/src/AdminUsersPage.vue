<script setup lang="ts">
import { computed, inject, shallowRef } from 'vue'
import type { ConsoleContext } from './use-console'
import { usePagedList } from './use-paged-list'
import DataListPanel from './DataListPanel.vue'
import RecordDetails from './RecordDetails.vue'
import { shortId, roleLabel } from './list-format'
import type { User } from './api'
const { listRevision, me, setUserStatus } = inject<ConsoleContext>('console')!
const {
  items: users,
  page,
  pageSize,
  total,
  busy,
  error,
  load,
  resize,
} = usePagedList<User>('/api/admin/users', listRevision)
const selected = shallowRef<User | null>(null)
const fields = computed(() =>
  selected.value
    ? [
        { label: '用户邮箱', value: selected.value.email, copy: true },
        { label: '用户 ID', value: selected.value.id, copy: true },
        { label: '角色', value: roleLabel(selected.value.role) },
        { label: '状态', value: selected.value.status === 'active' ? '正常' : '已禁用' },
      ]
    : [],
)
</script>
<template>
  <DataListPanel
    title="全部用户"
    :count="total"
    :page="page"
    :page-size="pageSize"
    :busy="busy"
    :error="error"
    :has-items="!!users.length"
    empty-title="还没有用户"
    empty-description="用户注册后，会在这里显示账号及访问状态。"
    @page="page = $event"
    @size="resize"
    @retry="load"
  >
    <el-table :data="users" class="record-table" row-key="id">
      <el-table-column label="用户" min-width="250"
        ><template #default="{ row }"
          ><div class="record-identity">
            <span class="record-avatar">{{ row.email.slice(0, 1).toUpperCase() }}</span>
            <div class="record-text">
              <strong :title="row.email">{{ row.email }}</strong
              ><span class="record-secondary record-mono"
                >{{ shortId(row.id)
                }}<span v-if="row.id === me?.id" class="record-self">当前账号</span></span
              >
            </div>
          </div></template
        ></el-table-column
      >
      <el-table-column label="账户角色" min-width="140"
        ><template #default="{ row }"
          ><span class="record-role">{{ roleLabel(row.role) }}</span></template
        ></el-table-column
      >
      <el-table-column label="访问状态" width="120"
        ><template #default="{ row }"
          ><span class="record-status" :class="row.status === 'active' ? 'positive' : 'neutral'"
            ><i />{{ row.status === 'active' ? '正常' : '已禁用' }}</span
          ></template
        ></el-table-column
      >
      <el-table-column label="账户管理" width="116" align="right"
        ><template #default="{ row }"
          ><el-button
            text
            :type="row.status === 'active' ? 'danger' : 'primary'"
            :disabled="
              row.id === me?.id ||
              row.role === 'super_admin' ||
              (row.role === 'admin' && me?.role !== 'super_admin')
            "
            @click="setUserStatus(row)"
            >{{ row.status === 'active' ? '禁用账号' : '启用账号' }}</el-button
          ></template
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
    title="全部用户详情"
    :fields="fields"
    @close="selected = null"
  />
</template>
