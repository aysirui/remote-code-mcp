<script setup lang="ts">
import { inject } from 'vue'
import type { ConsoleContext } from './use-console'
const { adminDevices, adminRevoke } = inject<ConsoleContext>('console')!
</script>
<template>
  <div class="card">
    <el-table :data="adminDevices"
      ><el-table-column prop="name" label="平台设备" /><el-table-column
        prop="userId"
        label="用户 ID"
        min-width="200"
      /><el-table-column prop="status" label="状态" /><el-table-column
        prop="platform"
        label="平台"
      /><el-table-column label="操作"
        ><template #default="{ row }"
          ><el-button
            text
            type="danger"
            :disabled="row.status === 'revoked'"
            @click="adminRevoke(row)"
            >撤销设备</el-button
          ></template
        ></el-table-column
      ></el-table
    >
    <div class="muted" style="margin-top: 15px">平台全量设备列表；后续可补充筛选与分页。</div>
  </div>
</template>
