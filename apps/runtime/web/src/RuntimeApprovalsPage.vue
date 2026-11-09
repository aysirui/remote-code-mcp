<script setup lang="ts">
import { inject } from 'vue'
import type { RuntimeContext } from './use-runtime-console'
const { writeApprovals, answerWriteApproval } = inject<RuntimeContext>('runtime')!
</script>
<template>
  <div class="card">
    <div class="title">待审批的文件修改（30 秒后自动拒绝）</div>
    <el-alert
      v-if="writeApprovals.length"
      title="远程 AI 请求修改本地文件"
      description="请核对工作区与文件路径；没有批准的请求不会执行。"
      type="warning"
      :closable="false"
      style="margin: 12px 0"
    />
    <div v-for="approval in writeApprovals" :key="approval.id" class="project row">
      <div style="flex: 1; min-width: 0; word-break: break-all">
        <strong>{{ approval.workspaceName }}</strong>
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
      <el-button type="danger" plain @click="answerWriteApproval(approval.id, false)"
        >拒绝</el-button
      >
      <el-button type="primary" @click="answerWriteApproval(approval.id, true)">批准本次</el-button>
    </div>
    <el-empty v-if="!writeApprovals.length" description="暂无待审批的文件修改" />
  </div>
</template>
