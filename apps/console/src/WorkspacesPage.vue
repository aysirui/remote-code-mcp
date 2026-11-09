<script setup lang="ts">
import { inject } from 'vue'
import type { ConsoleContext } from './use-console'
const { workspaces, disableWorkspace } = inject<ConsoleContext>('console')!
</script>
<template>
  <div class="notice">
    工作区只能通过对应设备上的 Runtime 本地界面添加。云端只展示授权元数据，不保存绝对路径。
  </div>
  <div class="card table-wrap">
    <el-table :data="workspaces" style="width: 100%"
      ><el-table-column prop="name" label="工作区" min-width="170" /><el-table-column
        prop="deviceId"
        label="所属设备 ID"
        min-width="230"
      /><el-table-column label="权限" width="120"
        ><template #default="{ row }"
          ><el-tag :type="row.write ? 'warning' : 'info'">{{
            row.write ? '读写' : '只读'
          }}</el-tag></template
        ></el-table-column
      ><el-table-column label="状态" width="100"
        ><template #default="{ row }"
          ><el-tag :type="row.enabled ? 'success' : 'info'">{{
            row.enabled ? '启用' : '停用'
          }}</el-tag></template
        ></el-table-column
      ><el-table-column label="操作" width="120"
        ><template #default="{ row }"
          ><el-button text type="danger" :disabled="!row.enabled" @click="disableWorkspace(row)"
            >停用</el-button
          ></template
        ></el-table-column
      ></el-table
    ><el-empty v-if="!workspaces.length" description="请在本地 Runtime 添加一个项目" />
  </div>
</template>
