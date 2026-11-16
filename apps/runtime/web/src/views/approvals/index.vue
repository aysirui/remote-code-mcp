<script setup lang="ts">
import { inject, ref, onMounted, onUnmounted } from 'vue'
import type { RuntimeContext } from '../../composables/use-runtime-console'

const { status, writeApprovals, answerWriteApproval } = inject<RuntimeContext>('runtime')!

/** 实时显示剩余有效期，并在提交期间锁定当前卡片，避免重复决定。 */
const now = ref(Date.now())
const submitting = ref(new Set<string>())
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
function remaining(expiresAt: number) {
  const seconds = Math.max(0, Math.ceil((expiresAt - now.value) / 1000))
  return seconds ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒后失效` : '已失效，等待清理'
}
async function answer(id: string, approved: boolean) {
  if (submitting.value.has(id)) return
  submitting.value.add(id)
  try {
    await answerWriteApproval(id, approved)
  } finally {
    submitting.value.delete(id)
  }
}

/** 将内部 RPC 名称转换为用户能直接理解的操作标题。 */
function operationTitle(operation: string) {
  const labels: Record<string, string> = {
    'file.write': '修改文件',
    'file.mkdir': '创建目录',
    'file.move': '移动文件或目录',
    'file.delete': '删除文件或目录',
    'file.read': '读取文件',
    'file.list': '读取目录',
    'file.search': '搜索文件内容',
    'git.add': '添加 Git 暂存内容',
    'git.commit': '创建 Git 提交',
    'git.status': '读取 Git 状态',
    'git.log': '读取 Git 提交历史',
    'git.diff': '读取 Git 差异',
    'command.run': '执行本机命令',
    'command.list': '读取本地命令清单',
  }
  return labels[operation] || '本地操作'
}

/** 将审批时间格式化为本地时间，便于区分连续到达的请求。 */
function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString()
}

/** 统一展示文件写入体积，避免小文件也出现冗长字节数。 */
function formatBytes(bytes: number) {
  if (!bytes) return ''
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}
</script>

<template>
  <main class="approval-page">
    <header class="approval-header">
      <div class="approval-heading">
        <div class="approval-eyebrow">RUNTIME SECURITY CENTER</div>
        <h1>本地操作审批</h1>
        <p>需要人工确认的请求集中在这里；操作遵循本地授权策略。</p>
      </div>
      <div class="approval-counter" :class="{ 'has-pending': writeApprovals.length }">
        <span class="counter-number">{{ writeApprovals.length }}</span>
        <span class="counter-label">待处理</span>
      </div>
    </header>

    <section class="connection-strip">
      <span class="connection-dot" :class="{ online: status.online }"></span>
      <div class="connection-copy">
        <strong>{{ status.serverName || '尚未选择服务器' }}</strong>
        <span>{{ status.gateway || '未配置 Gateway' }}</span>
      </div>
      <span class="connection-state">{{ status.online ? '设备在线' : '设备离线' }}</span>
    </section>

    <div v-if="writeApprovals.length" class="approval-guidance">
      <span class="guidance-icon">!</span>
      <div>
        <strong>请逐项核对请求内容</strong>
        <p>
          审批仅对当前这一次请求有效。请求将在 5 分钟后自动失效，切换服务器或断开连接也会取消审批。
        </p>
      </div>
    </div>

    <section v-if="writeApprovals.length" class="approval-list">
      <article
        v-for="approval in writeApprovals"
        :key="approval.id"
        class="approval-card"
        :class="{ 'is-high-risk': approval.riskLevel === 'high' }">
        <div class="card-topline">
          <div class="operation-heading">
            <span class="operation-symbol" :class="{ danger: approval.riskLevel === 'high' }">
              {{
                approval.operation === 'file.delete'
                  ? '−'
                  : approval.operation.startsWith('git.')
                    ? 'G'
                    : approval.operation === 'command.run'
                      ? '>_'
                      : 'F'
              }}
            </span>
            <div>
              <h2>{{ operationTitle(approval.operation) }}</h2>
              <span class="request-time">请求于 {{ formatTime(approval.createdAt) }}</span>
            </div>
          </div>
          <span class="risk-pill" :class="approval.riskLevel">
            {{ approval.riskLevel === 'high' ? '高风险 · 需要确认' : '等待确认' }}
          </span>
        </div>

        <div class="workspace-block">
          <span class="field-label">工作区</span>
          <strong>{{ approval.workspaceName }}</strong>
          <span class="workspace-id">ID：{{ approval.workspaceId }}</span>
        </div>

        <div class="target-block">
          <span class="field-label">操作目标</span>
          <code>{{ approval.path || '—' }}</code>
        </div>

        <div v-if="approval.operation === 'file.delete'" class="impact-grid">
          <div class="impact-item">
            <span class="field-label">影响条目</span>
            <strong>{{ approval.itemCount }}</strong>
          </div>
          <div class="impact-item">
            <span class="field-label">删除方式</span>
            <strong>{{ approval.preview.includes('递归') ? '递归删除' : '单项删除' }}</strong>
          </div>
          <div class="impact-item">
            <span class="field-label">可撤销性</span>
            <strong class="irreversible">不可保证恢复</strong>
          </div>
        </div>
        <div v-else-if="approval.bytes" class="impact-summary">
          <span>写入内容大小</span>
          <strong>{{ formatBytes(approval.bytes) }}</strong>
        </div>

        <details
          v-if="approval.preview"
          class="detail-panel"
          :open="approval.operation === 'command.run'">
          <summary>
            {{ approval.operation === 'command.run' ? '执行命令与风险' : '查看操作详情' }}
          </summary>
          <pre>{{ approval.preview }}</pre>
          <span v-if="approval.truncated" class="truncated-note">
            内容较长，仅展示前 2000 个字符。
          </span>
        </details>

        <div v-if="approval.riskLevel === 'high'" class="high-risk-note">
          {{
            approval.operation === 'command.run'
              ? '命令以本机账号权限运行，可访问项目外文件和网络。请核对完整程序、参数和工作目录后，仅批准可信请求。'
              : approval.operation === 'file.delete'
                ? '该请求涉及批量删除。请确认目标路径、影响条目和不可撤销的后果。'
                : '请核对操作目标与详细变更内容，确认本次高风险操作确实符合预期。'
          }}
        </div>

        <footer class="approval-actions">
          <span class="expiry-note">{{ remaining(approval.expiresAt) }}</span>
          <div class="action-buttons">
            <el-button
              plain
              :disabled="submitting.has(approval.id) || now >= approval.expiresAt"
              @click="answer(approval.id, false)">
              拒绝
            </el-button>
            <el-button
              :disabled="submitting.has(approval.id) || now >= approval.expiresAt"
              :loading="submitting.has(approval.id)"
              :type="approval.riskLevel === 'high' ? 'danger' : 'primary'"
              @click="answer(approval.id, true)">
              {{ approval.riskLevel === 'high' ? '确认并执行' : '批准本次操作' }}
            </el-button>
          </div>
        </footer>
      </article>
    </section>

    <section v-else class="empty-state">
      <div class="empty-icon">✓</div>
      <h2>当前没有待审批操作</h2>
      <p>新的本地访问或修改请求到达时，会显示在这里。</p>
    </section>

    <p class="privacy-note">审批详情仅保存在 Runtime 本机内存中，不会上传或持久化到云端。</p>
  </main>
</template>

<style scoped>
.approval-page {
  width: 100%;
  max-width: 920px;
  margin: 0 auto;
  padding: 8px 0 36px;
  box-sizing: border-box;
  color: #182230;
}
.approval-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 22px;
}
.approval-eyebrow {
  margin-bottom: 8px;
  color: #718096;
  font-size: 10px;
  font-weight: 750;
  letter-spacing: 1.5px;
}
.approval-heading h1 {
  margin: 0;
  font-size: 25px;
  line-height: 1.3;
  font-weight: 730;
  letter-spacing: -0.6px;
}
.approval-heading p {
  margin: 7px 0 0;
  color: #718096;
  font-size: 13px;
}
.approval-counter {
  display: flex;
  min-width: 76px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 10px 15px;
  border: 1px solid #e6eaf0;
  border-radius: 13px;
  background: #fff;
}
.counter-number {
  font-size: 25px;
  line-height: 1.1;
  font-weight: 750;
  color: #64748b;
  font-variant-numeric: tabular-nums;
}
.has-pending .counter-number {
  color: #d97706;
}
.counter-label {
  margin-top: 4px;
  color: #8792a2;
  font-size: 11px;
}
.connection-strip {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 12px 15px;
  border: 1px solid #e8edf3;
  border-radius: 12px;
  background: #fff;
}
.connection-dot {
  width: 8px;
  height: 8px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: #a0a9b7;
}
.connection-dot.online {
  background: #16a36a;
  box-shadow: 0 0 0 3px #e5f6ee;
}
.connection-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 3px;
}
.connection-copy strong {
  font-size: 12px;
  font-weight: 650;
}
.connection-copy span {
  overflow: hidden;
  color: #8792a2;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.connection-state {
  color: #718096;
  font-size: 11px;
  white-space: nowrap;
}
.approval-guidance {
  display: flex;
  gap: 11px;
  margin: 17px 0;
  padding: 13px 15px;
  border: 1px solid #f3dfb5;
  border-radius: 12px;
  background: #fffaf0;
}
.guidance-icon {
  display: flex;
  width: 21px;
  height: 21px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: #f4dfb5;
  color: #8a5700;
  font-size: 13px;
  font-weight: 800;
}
.approval-guidance strong {
  color: #704b0b;
  font-size: 12px;
}
.approval-guidance p {
  margin: 4px 0 0;
  color: #8a7043;
  font-size: 11px;
  line-height: 1.6;
}
.approval-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.approval-card {
  overflow: hidden;
  padding: 18px 19px 0;
  border: 1px solid #e6eaf0;
  border-radius: 14px;
  background: #fff;
  box-shadow: 0 3px 12px rgb(22 34 51 / 3%);
}
.approval-card.is-high-risk {
  border-color: #f0c8c5;
  box-shadow: 0 3px 14px rgb(185 55 45 / 6%);
}
.card-topline {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.operation-heading {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 11px;
}
.operation-symbol {
  display: flex;
  width: 36px;
  height: 36px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: #edf4ff;
  color: #3269bd;
  font-size: 17px;
  font-weight: 750;
}
.operation-symbol.danger {
  background: #fff0ef;
  color: #c24136;
}
.operation-heading h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
}
.request-time {
  display: block;
  margin-top: 4px;
  color: #98a2b1;
  font-size: 10px;
}
.risk-pill {
  padding: 5px 9px;
  border-radius: 20px;
  background: #f1f5f9;
  color: #64748b;
  font-size: 10px;
  font-weight: 650;
  white-space: nowrap;
}
.risk-pill.high {
  background: #fff0ef;
  color: #bd3e34;
}
.workspace-block,
.target-block {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 7px 10px;
  margin-top: 17px;
}
.field-label {
  color: #8a95a5;
  font-size: 10px;
  font-weight: 600;
}
.workspace-block strong {
  color: #263447;
  font-size: 12px;
  font-weight: 650;
}
.workspace-id {
  color: #a0a9b6;
  font-size: 10px;
}
.target-block {
  align-items: flex-start;
  flex-direction: column;
  gap: 6px;
}
.target-block code {
  box-sizing: border-box;
  width: 100%;
  overflow-wrap: anywhere;
  padding: 9px 11px;
  border: 1px solid #edf0f4;
  border-radius: 8px;
  background: #f8fafc;
  color: #344256;
  font-size: 11px;
}
.impact-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 9px;
  margin-top: 12px;
}
.impact-item {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border: 1px solid #edf0f4;
  border-radius: 9px;
}
.impact-item strong {
  overflow-wrap: anywhere;
  color: #344256;
  font-size: 12px;
  font-weight: 650;
}
.impact-item .irreversible {
  color: #bd3e34;
  font-size: 11px;
}
.impact-summary {
  display: flex;
  justify-content: space-between;
  margin-top: 12px;
  color: #8490a0;
  font-size: 11px;
}
.impact-summary strong {
  color: #344256;
}
.detail-panel {
  margin-top: 13px;
  border-top: 1px solid #edf0f4;
}
.detail-panel summary {
  padding: 11px 0;
  color: #526176;
  cursor: pointer;
  font-size: 11px;
  font-weight: 600;
}
.detail-panel pre {
  max-height: 190px;
  overflow: auto;
  margin: 0 0 9px;
  padding: 11px;
  border-radius: 8px;
  background: #f7f9fc;
  color: #445166;
  font:
    11px/1.65 ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.truncated-note {
  display: block;
  margin-bottom: 9px;
  color: #9a7a39;
  font-size: 10px;
}
.high-risk-note {
  margin-top: 13px;
  padding: 10px 11px;
  border-radius: 8px;
  background: #fff5f4;
  color: #a43c34;
  font-size: 11px;
  line-height: 1.55;
}
.approval-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 15px -19px 0;
  padding: 12px 19px;
  border-top: 1px solid #edf0f4;
  background: #fcfdff;
}
.expiry-note {
  color: #9aa4b2;
  font-size: 10px;
}
.action-buttons {
  display: flex;
  gap: 8px;
}
.action-buttons :deep(.el-button) {
  margin-left: 0;
}
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  margin-top: 20px;
  padding: 62px 20px;
  border: 1px dashed #dce3eb;
  border-radius: 14px;
  background: #fff;
  text-align: center;
}
.empty-icon {
  display: flex;
  width: 42px;
  height: 42px;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: #eaf7f0;
  color: #199765;
  font-size: 21px;
  font-weight: 700;
}
.empty-state h2 {
  margin: 15px 0 5px;
  color: #344256;
  font-size: 14px;
}
.empty-state p {
  margin: 0;
  color: #98a2b1;
  font-size: 11px;
}
.privacy-note {
  margin: 15px 0 0;
  color: #a0a9b6;
  font-size: 10px;
  text-align: center;
}
@media (max-width: 620px) {
  .approval-page {
    padding-top: 0;
  }
  .approval-heading h1 {
    font-size: 21px;
  }
  .approval-heading p {
    max-width: 270px;
    line-height: 1.55;
  }
  .approval-card {
    padding: 15px 13px 0;
  }
  .approval-actions {
    align-items: flex-start;
    flex-direction: column;
    margin-right: -13px;
    margin-left: -13px;
    padding: 12px 13px;
  }
  .action-buttons {
    width: 100%;
  }
  .action-buttons :deep(.el-button) {
    flex: 1;
  }
  .impact-grid {
    grid-template-columns: 1fr 1fr;
  }
}
</style>

<style scoped>
.expiry-note,
.field-label,
.request-time,
.privacy-note {
  color: #526176;
  font-size: 12px;
}
.detail-panel summary:focus-visible {
  outline: 2px solid #3269bd;
  outline-offset: 3px;
}
</style>
