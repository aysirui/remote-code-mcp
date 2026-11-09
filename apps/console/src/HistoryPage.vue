<script setup lang="ts">
import { inject } from 'vue'
import type { ConsoleContext } from './use-console'
const { logs } = inject<ConsoleContext>('console')!
</script>
<template>
  <div class="card">
    <el-table :data="logs"
      ><el-table-column prop="operation" label="操作" /><el-table-column
        prop="status"
        label="结果"
      /><el-table-column prop="workspaceId" label="工作区" /><el-table-column label="时间"
        ><template #default="{ row }">{{
          new Date(row.createdAt).toLocaleString()
        }}</template></el-table-column
      ></el-table
    ><el-empty v-if="!logs.length" description="暂无操作记录" />
  </div>
</template>
