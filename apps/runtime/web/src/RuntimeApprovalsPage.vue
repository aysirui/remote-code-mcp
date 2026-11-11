<script setup lang="ts">
import { inject } from 'vue'
import type { RuntimeContext } from './use-runtime-console'
const { status, writeApprovals, answerWriteApproval } = inject<RuntimeContext>('runtime')!
</script>

<template>
  <div class="card">
    <div class="title">待审批的本地操作（5 分钟后自动拒绝）</div>
    <p class="muted">
      请求来源：{{ status.serverName }} · {{ status.gateway }}。切换服务器会取消尚未处理的审批。
    </p>
    <el-alert
      v-if="writeApprovals.length"
      title="远程 AI 请求访问或执行本地工具"
      description="请核对工作区 ID、操作类型和详情；审批上下文只在本机待审批期间展示，不会保存到云端。"
      type="warning"
      :closable="false"
      style="margin: 12px 0"
    />
    <div v-for="approval in writeApprovals" :key="approval.id" class="project row">
      <div style="flex: 1; min-width: 0; word-break: break-all">
        <div style="font-weight: 600">{{ approval.workspaceName }}</div>
        <div class="muted">工作区 ID：{{ approval.workspaceId }}</div>
        <el-tag type="warning" size="small" style="margin-left: 8px">{{
          approval.operation
        }}</el-tag>
        <div>{{ approval.path }}</div>
        <div class="muted">{{ approval.bytes }} 字节待写入</div>
        <pre
          style="
            max-height: 160px;
            overflow: auto;
            white-space: pre-wrap;
            background: #f6f8fb;
            padding: 8px;
          "
          >{{ approval.preview }}</pre>
        <div v-if="approval.truncated" class="muted">仅展示前 2000 个字符，请谨慎确认</div>
      </div>
      <el-button type="danger" plain @click="answerWriteApproval(approval.id, false)">
        拒绝
      </el-button>
      <el-button type="primary" @click="answerWriteApproval(approval.id, true)">批准本次</el-button>
    </div>
    <el-empty v-if="!writeApprovals.length" description="暂无待审批的本地操作" />
  </div>
</template>
