<script setup lang="ts">
import { inject } from 'vue'
import type { ConsoleContext } from './use-console'
const { logs } = inject<ConsoleContext>('console')!
const operationTypeLabel = (type: string) =>
  ({ file: '文件', git: 'Git', command: '命令' })[type] || type
</script>

<template>
  <div class="notice">
    这里只记录工具执行元数据：客户端、工作区、工具类型、执行结果和耗时。
    不保存文件路径、命令参数、文件内容、Diff、执行输出或 AI 对话。
  </div>
  <div class="card">
    <el-table :data="logs" style="width: 100%">
      <el-table-column prop="toolName" label="工具" min-width="130" />
      <el-table-column label="类型" width="90">
        <template #default="{ row }">{{ operationTypeLabel(row.operationType) }}</template>
      </el-table-column>
      <el-table-column prop="clientId" label="OAuth Client ID" min-width="190" />
      <el-table-column prop="workspaceId" label="工作区 ID" min-width="190" />
      <el-table-column prop="deviceId" label="设备 ID" min-width="190" />
      <el-table-column label="结果" width="90">
        <template #default="{ row }">
          <el-tag :type="row.status === 'success' ? 'success' : 'danger'">
            {{ row.status === 'success' ? '成功' : '失败' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="耗时" width="100">
        <template #default="{ row }">{{ row.durationMs }} ms</template>
      </el-table-column>
      <el-table-column prop="errorCode" label="错误码" width="150" />
      <el-table-column label="时间" min-width="180">
        <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString() }}</template>
      </el-table-column>
    </el-table>
    <el-empty v-if="!logs.length" description="暂无工具执行记录" />
  </div>
</template>
