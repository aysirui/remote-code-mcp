<script setup lang="ts">
import { inject } from 'vue'
import type { ConsoleContext } from './use-console'
const { adminLogs } = inject<ConsoleContext>('console')!
</script>

<template>
  <div class="notice">
    安全审计仅记录账号、设备、工作区授权、OAuth 授权及管理员管理动作。 不记录 MCP
    工具调用内容、文件信息或 AI 对话。
  </div>
  <div class="card">
    <el-table :data="adminLogs" style="width: 100%">
      <el-table-column prop="eventType" label="安全事件" min-width="190" />
      <el-table-column prop="actorType" label="操作者类型" width="110" />
      <el-table-column prop="actorId" label="操作者 ID" min-width="190" />
      <el-table-column prop="resourceType" label="资源类型" width="120" />
      <el-table-column prop="resourceId" label="资源 ID" min-width="190" />
      <el-table-column label="结果" width="90">
        <template #default="{ row }">
          <el-tag :type="row.result === 'success' ? 'success' : 'danger'">
            {{ row.result === 'success' ? '成功' : '失败' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="时间" min-width="180">
        <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString() }}</template>
      </el-table-column>
    </el-table>
    <el-empty v-if="!adminLogs.length" description="暂无安全审计记录" />
  </div>
</template>
