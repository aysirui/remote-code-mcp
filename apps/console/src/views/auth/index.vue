<script setup lang="ts">
import { inject } from 'vue'
import type { ConsoleContext } from '../../composables/use-console'
import AuthShell from '../../components/layout/AuthShell.vue'

const {
  registering,
  email,
  password,
  signIn,
  authBusy,
  activationDialogOpen,
  activationEmail,
  clearActivationPrompt,
  resendBusy,
  resendSeconds,
  resendActivation,
} = inject<ConsoleContext>('console')!
</script>

<template>
  <AuthShell
    :headline="registering ? '开始安全连接你的本地开发环境。' : '让 AI 安全连接你的本地开发环境。'"
    description="统一管理设备、工作区和 AI 授权。借助本地 Runtime，远程协作不必交出你的源码。">
    <div class="auth-eyebrow">REMOTE CODE PLATFORM</div>
    <h2>{{ registering ? '创建账号' : '欢迎回来' }}</h2>
    <p class="auth-subtitle">
      {{ registering ? '创建账号，开启安全开发体验' : '登录以管理你的设备与工作区' }}
    </p>
    <el-form
      class="auth-fields"
      label-position="top"
      :disabled="authBusy || resendBusy"
      @submit.prevent="signIn">
      <el-form-item label="电子邮箱">
        <el-input
          v-model="email"
          size="large"
          type="email"
          placeholder="you@example.com"
          autocomplete="username" />
      </el-form-item>
      <el-form-item label="密码">
        <el-input
          v-model="password"
          size="large"
          type="password"
          show-password
          :autocomplete="registering ? 'new-password' : 'current-password'"
          :placeholder="registering ? '至少 12 位密码' : '请输入密码'" />
      </el-form-item>
      <el-button
        class="auth-submit"
        type="primary"
        native-type="submit"
        size="large"
        :loading="authBusy"
        :disabled="authBusy || !email.trim() || !password">
        {{ registering ? '注册账号' : '登录' }}
      </el-button>
    </el-form>
    <div class="auth-switch">
      <span>{{ registering ? '已经有账号？' : '还没有账号？' }}</span>
      <el-link
        type="primary"
        :disabled="authBusy || resendBusy"
        @click="registering = !registering">
        {{ registering ? '立即登录' : '免费注册' }}
      </el-link>
    </div>
    <el-dialog
      v-model="activationDialogOpen"
      title="账号尚未激活"
      width="420px"
      align-center
      class="activation-prompt"
      :close-on-click-modal="!resendBusy"
      :close-on-press-escape="!resendBusy"
      :show-close="!resendBusy"
      @closed="clearActivationPrompt">
      <p class="activation-prompt-email">{{ activationEmail }}</p>
      <p>该账号已注册，需要激活邮箱后才能登录。请查看激活邮件，或重新发送一封。</p>
      <p class="activation-prompt-help">
        重发需要使用注册时的密码。如输入的不是原密码，请关闭弹窗后修改。
      </p>
      <template #footer>
        <el-button :disabled="resendBusy" @click="activationDialogOpen = false">我知道了</el-button>
        <el-button
          type="primary"
          :loading="resendBusy"
          :disabled="resendBusy || resendSeconds > 0"
          @click="resendActivation">
          {{ resendSeconds > 0 ? `${resendSeconds} 秒后可重发` : '重发激活邮件' }}
        </el-button>
      </template>
    </el-dialog>
  </AuthShell>
</template>

<style>
/* 弹窗会传送至 body；限制小屏宽度，邮箱与操作按钮可自然换行。 */
.activation-prompt.el-dialog {
  max-width: calc(100vw - 32px);
  border-radius: 12px;
}
.activation-prompt .el-dialog__body {
  color: #526277;
  line-height: 1.8;
}
.activation-prompt .el-dialog__body p {
  margin: 0 0 12px;
}
.activation-prompt .activation-prompt-email {
  color: #172b45;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.activation-prompt .activation-prompt-help {
  font-size: 13px;
}
.activation-prompt .el-dialog__footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 12px;
}
.activation-prompt .el-dialog__footer .el-button {
  margin: 0;
  min-height: 44px;
}
</style>
