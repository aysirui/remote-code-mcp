<script setup lang="ts">
import { inject } from 'vue'
import type { ConsoleContext } from '../../composables/use-console'
import AuthShell from '../../components/layout/AuthShell.vue'

const { registering, email, password, signIn, resendBusy, resendSeconds, resendActivation } =
  inject<ConsoleContext>('console')!
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
    <el-form class="auth-fields" label-position="top" @submit.prevent="signIn">
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
        :disabled="!email.trim() || !password">
        {{ registering ? '注册账号' : '登录' }}
      </el-button>
      <el-button
        v-if="!registering"
        link
        type="primary"
        :loading="resendBusy"
        :disabled="!email.trim() || !password || resendSeconds > 0"
        @click="resendActivation">
        {{ resendSeconds > 0 ? `${resendSeconds} 秒后可重发` : '重发激活邮件' }}
      </el-button>
    </el-form>
    <div class="auth-switch">
      <span>{{ registering ? '已经有账号？' : '还没有账号？' }}</span>
      <el-link type="primary" @click="registering = !registering">
        {{ registering ? '立即登录' : '免费注册' }}
      </el-link>
    </div>
  </AuthShell>
</template>
