<script setup lang="ts">
import { inject } from 'vue'
import type { ConsoleContext } from './use-console'
const { adminLogs } = inject<ConsoleContext>('console')!
</script>
<template>
  <div class="card">
    <el-table :data="adminLogs"
      ><el-table-column prop="operation" label="操作" /><el-table-column
        prop="status"
        label="结果" /><el-table-column prop="createdAt" label="时间"
    /></el-table>
  </div>
</template>
