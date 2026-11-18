<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import {
  ArrowRight,
  CircleCheck,
  Clock,
  Loading,
  Lock,
  Message,
  RefreshRight,
  Warning,
} from '@element-plus/icons-vue'
import { ApiError, request } from '../../api'

/** 邮箱验证的展示阶段；网络失败允许重试，失效链接需要重新获取。 */
type ActivationState = 'ready' | 'submitting' | 'success' | 'invalid' | 'error'
// 令牌只保留在内存，立即从地址栏移除；打开页面或邮件预览均不会自动激活。
let token = new URLSearchParams(window.location.hash.slice(1)).get('token') || ''
history.replaceState(null, '', location.pathname + location.search)
/** 当前页面状态，由令牌是否存在以及提交结果决定。 */
const state = ref<ActivationState>(token ? 'ready' : 'invalid')
/** 服务端或网络失败提示，仅在可重试的失败状态中展示。 */
const failureMessage = ref('')
const submitting = computed(() => state.value === 'submitting')
/** 各阶段只保留一个主要操作，让手机邮箱用户可以直接理解下一步。 */
const content = computed(() => {
  switch (state.value) {
    case 'success':
      return {
        title: '邮箱验证成功',
        description: '账号已激活。你可以继续登录，也可以回到电脑上使用 Remote Code。',
        icon: CircleCheck,
      }
    case 'invalid':
      return {
        title: '激活链接已失效',
        description: '链接可能已过期、已使用，或未完整打开。请使用最新的激活邮件，或重新发送一封。',
        icon: Warning,
      }
    case 'error':
      return {
        title: '暂时无法完成验证',
        description: '验证尚未完成，你可以再次尝试。如果仍无法验证，请稍后重新打开邮件中的链接。',
        icon: RefreshRight,
      }
    case 'submitting':
      return {
        title: '正在验证邮箱',
        description: '正在确认你的激活请求，请稍候。验证完成后即可使用账号登录。',
        icon: Loading,
      }
    default:
      return {
        title: '验证邮箱，激活账号',
        description: '只差最后一步。点击下方按钮确认你的邮箱，即可开始使用 Remote Code。',
        icon: Message,
      }
  }
})
const originalTitle = document.title
watch(
  content,
  (next) => {
    document.title = `${next.title} · Remote Code MCP`
  },
  { immediate: true },
)
onUnmounted(() => {
  document.title = originalTitle
})

/** 用户明确确认后提交一次性令牌；成功不创建会话，临时失败可使用当前令牌重试。 */
async function activate() {
  if (!token || submitting.value || state.value === 'success' || state.value === 'invalid') return
  state.value = 'submitting'
  failureMessage.value = ''
  try {
    await request('/api/auth/activate-email', 'POST', { token })
    token = ''
    state.value = 'success'
  } catch (cause) {
    if (cause instanceof ApiError && cause.message.includes('激活链接无效或已过期')) {
      token = ''
      state.value = 'invalid'
    } else {
      failureMessage.value =
        cause instanceof Error ? cause.message : '请求失败，请检查网络连接后重试。'
      state.value = 'error'
    }
  }
}
</script>

<template>
  <div class="activation-page">
    <header class="activation-header">
      <a class="activation-brand" href="/console" aria-label="Remote Code MCP，前往登录页">
        <img src="/logo-square.svg" width="32" height="32" alt="" />
        <span>
          Remote Code
          <span class="brand-suffix">MCP</span>
        </span>
      </a>
      <span class="header-label">账号验证</span>
    </header>

    <main class="activation-main">
      <section
        class="activation-panel"
        :class="`is-${state}`"
        aria-labelledby="activation-title"
        :aria-busy="submitting">
        <div class="activation-status" aria-hidden="true">
          <el-icon :class="{ 'is-loading': submitting }"><component :is="content.icon" /></el-icon>
        </div>
        <div class="activation-message" aria-live="polite" aria-atomic="true">
          <span class="status-label">
            {{
              state === 'success'
                ? '验证已完成'
                : state === 'invalid' || state === 'error'
                  ? '需要你的处理'
                  : '确认注册邮箱'
            }}
          </span>
          <h1 id="activation-title">{{ content.title }}</h1>
          <p class="activation-description">{{ content.description }}</p>
        </div>

        <p v-if="state === 'error'" class="activation-error" role="alert">{{ failureMessage }}</p>

        <div v-if="state === 'ready' || submitting" class="activation-detail">
          <el-icon aria-hidden="true"><Clock /></el-icon>
          <span>
            激活链接自发送起
            <strong>24 小时</strong>
            内有效
          </span>
        </div>
        <p v-else-if="state === 'success'" class="activation-detail success-detail">
          <el-icon aria-hidden="true"><CircleCheck /></el-icon>
          <span>邮箱状态已同步，无需在电脑上再次激活</span>
        </p>
        <p v-else-if="state === 'invalid'" class="activation-detail recovery-detail">
          重发方式：在注册页填写原邮箱和密码，点击“注册账号”，再在提示中选择“重发激活邮件”。
        </p>

        <div class="activation-actions">
          <router-link
            v-if="state === 'success' || state === 'invalid'"
            class="activation-primary"
            :to="state === 'invalid' ? '/console?register=1' : '/console'">
            {{ state === 'success' ? '前往登录' : '前往注册页重发' }}
            <el-icon aria-hidden="true"><ArrowRight /></el-icon>
          </router-link>
          <el-button
            v-else
            class="activation-primary"
            type="primary"
            :loading="submitting"
            :disabled="submitting"
            @click="activate">
            {{ submitting ? '正在验证…' : state === 'error' ? '重新尝试验证' : '确认激活账号' }}
            <el-icon v-if="!submitting" aria-hidden="true"><ArrowRight /></el-icon>
          </el-button>
          <router-link
            v-if="state !== 'success' && state !== 'invalid'"
            class="activation-secondary"
            to="/console">
            返回登录页
          </router-link>
        </div>

        <div class="activation-footnote">
          <el-icon aria-hidden="true"><Lock /></el-icon>
          <span>
            {{
              state === 'success'
                ? '在手机上激活后，也可回到电脑继续登录。'
                : '仅验证邮箱归属，不会自动登录你的账号。'
            }}
          </span>
        </div>
      </section>
      <p class="activation-help">如果不是你本人注册的账号，请忽略这封邮件。</p>
    </main>

    <footer class="activation-footer">代码留在本机 · 权限由你掌控</footer>
  </div>
</template>

<style scoped>
/* 独立的单栏验证布局，桌面和手机保持相同的信息顺序，避免分屏登录页挤压内容。 */
.activation-page {
  --activation-ink: #172b45;
  --activation-muted: #526277;
  --activation-border: #dde5ef;
  min-height: 100vh;
  min-height: 100svh;
  display: flex;
  flex-direction: column;
  padding: max(24px, env(safe-area-inset-top)) max(24px, env(safe-area-inset-right))
    max(20px, env(safe-area-inset-bottom)) max(24px, env(safe-area-inset-left));
  background: #f7f9fc;
  color: var(--activation-ink);
}
.activation-header {
  width: 100%;
  max-width: 1040px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.activation-brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: var(--activation-ink);
  font-size: 17px;
  font-weight: 650;
  text-decoration: none;
}
.activation-brand img {
  display: block;
  flex: 0 0 auto;
  border-radius: 7px;
}
.brand-suffix {
  color: var(--activation-muted);
  font-weight: 450;
}
.header-label {
  color: var(--activation-muted);
  font-size: 13px;
  white-space: nowrap;
}
.activation-main {
  flex: 1;
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 56px 0 40px;
}
.activation-panel {
  width: 100%;
  max-width: 480px;
  padding: 40px;
  border: 1px solid var(--activation-border);
  border-radius: 16px;
  background: #fff;
}
.activation-status {
  width: 64px;
  height: 64px;
  display: grid;
  place-items: center;
  margin-bottom: 28px;
  border-radius: 16px;
  color: var(--el-color-primary);
  background: #edf3ff;
}
.activation-status .el-icon {
  font-size: 30px;
}
.is-success .activation-status {
  color: #147d59;
  background: #eaf6f0;
}
.is-invalid .activation-status,
.is-error .activation-status {
  color: #9a5c16;
  background: #fff4e5;
}
.status-label {
  display: block;
  margin-bottom: 10px;
  color: var(--activation-muted);
  font-size: 13px;
  line-height: 1.5;
}
h1 {
  margin: 0;
  font-size: 26px;
  line-height: 1.4;
  font-weight: 650;
  letter-spacing: -0.025em;
  text-wrap: balance;
}
.activation-description {
  margin: 14px 0 0;
  color: var(--activation-muted);
  font-size: 15px;
  line-height: 1.8;
  text-wrap: pretty;
  overflow-wrap: anywhere;
}
.activation-detail {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 24px 0 0;
  color: var(--activation-muted);
  font-size: 13px;
  line-height: 1.7;
}
.activation-detail .el-icon {
  flex-shrink: 0;
  margin-top: 4px;
  font-size: 15px;
}
.activation-detail strong {
  color: var(--activation-ink);
  font-weight: 600;
}
.success-detail {
  color: #147d59;
}
.recovery-detail {
  padding-top: 20px;
  border-top: 1px solid var(--activation-border);
}
.activation-error {
  margin: 20px 0 0;
  padding: 12px;
  border-radius: 8px;
  color: #9c302b;
  background: #fff0ef;
  overflow-wrap: anywhere;
  font-size: 14px;
  line-height: 1.7;
}
.activation-actions {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 32px;
}
.activation-primary {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: 100%;
  min-height: 48px;
  height: auto;
  padding: 12px 16px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: var(--el-color-primary);
  color: #fff;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.5;
  text-align: center;
  text-decoration: none;
  white-space: normal;
  transition: background-color 160ms ease-out;
}
.activation-primary:hover {
  background: #1d4ed8;
}
.activation-primary:active {
  background: #1e40af;
}
.activation-primary .el-icon {
  flex-shrink: 0;
}
.activation-secondary {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 10px;
  color: var(--activation-muted);
  font-size: 14px;
  text-decoration: none;
}
.activation-secondary:hover {
  color: var(--el-color-primary);
}
a:focus-visible,
.activation-primary:focus-visible {
  outline: 3px solid #2563eb;
  outline-offset: 4px;
}
.activation-footnote {
  display: flex;
  align-items: flex-start;
  justify-content: center;
  gap: 6px;
  margin-top: 24px;
  padding-top: 24px;
  border-top: 1px solid var(--activation-border);
  color: var(--activation-muted);
  font-size: 12px;
  line-height: 1.7;
}
.activation-footnote .el-icon {
  flex-shrink: 0;
  margin-top: 3px;
  font-size: 14px;
}
.activation-help {
  max-width: 480px;
  margin: 20px 0 0;
  color: var(--activation-muted);
  font-size: 12px;
  line-height: 1.8;
  text-align: center;
}
.activation-footer {
  color: var(--activation-muted);
  font-size: 12px;
  line-height: 1.7;
  text-align: center;
}
/* 小屏预留安全区，按钮达到触屏尺寸；短屏自然滚动，不固定底部操作遮挡内容。 */
@media (max-width: 520px) {
  .activation-page {
    padding-right: max(20px, env(safe-area-inset-right));
    padding-left: max(20px, env(safe-area-inset-left));
  }
  .activation-brand {
    font-size: 15px;
    gap: 8px;
  }
  .activation-brand img {
    width: 28px;
    height: 28px;
  }
  .header-label {
    font-size: 12px;
  }
  .activation-main {
    padding: 36px 0 28px;
  }
  .activation-panel {
    padding: 28px 24px;
    border-radius: 12px;
  }
  .activation-status {
    width: 56px;
    height: 56px;
    margin-bottom: 24px;
    border-radius: 12px;
  }
  h1 {
    font-size: 23px;
  }
  .activation-description {
    font-size: 14px;
  }
  .activation-actions {
    margin-top: 28px;
  }
}
@media (max-width: 360px) {
  .activation-page {
    padding-right: max(16px, env(safe-area-inset-right));
    padding-left: max(16px, env(safe-area-inset-left));
  }
  .activation-panel {
    padding: 24px 20px;
  }
  .brand-suffix {
    display: none;
  }
  h1 {
    font-size: 21px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .activation-primary {
    transition: none;
  }
  .activation-status .is-loading,
  :deep(.el-icon.is-loading) {
    animation: none;
  }
}
</style>
