<script setup lang="ts">
import { inject } from 'vue'
import type { ConsoleContext } from '../../composables/use-console'
import AuthShell from '../../components/layout/AuthShell.vue'

const { me, currentPassword, newPassword, newPasswordConfirm, changePassword, logout } =
  inject<ConsoleContext>('console')!
</script>

<template>
  <AuthShell
    headline="保护你的账号，从设置新密码开始。"
    description="首次登录需要替换初始化临时密码。完成后将撤销旧会话，请使用新密码重新登录。">
    <div class="auth-eyebrow">ACCOUNT SECURITY</div>
    <h2>设置新密码</h2>
    <p class="auth-subtitle">账号：{{ me?.email }}</p>
    <el-alert
      class="auth-security-tip"
      type="warning"
      title="首次登录需要修改临时密码"
      :closable="false"
      show-icon />
    <el-form class="auth-fields" label-position="top" @submit.prevent="changePassword">
      <el-form-item label="当前临时密码">
        <el-input
          v-model="currentPassword"
          size="large"
          type="password"
          show-password
          autocomplete="current-password" />
      </el-form-item>
      <el-form-item label="新密码（12–72 UTF-8 字节）">
        <el-input
          v-model="newPassword"
          size="large"
          type="password"
          show-password
          autocomplete="new-password" />
      </el-form-item>
      <el-form-item label="再次输入新密码">
        <el-input
          v-model="newPasswordConfirm"
          size="large"
          type="password"
          show-password
          autocomplete="new-password" />
      </el-form-item>
      <div class="auth-actions">
        <el-button
          class="auth-submit"
          type="primary"
          size="large"
          native-type="submit"
          :disabled="!currentPassword || !newPassword || !newPasswordConfirm">
          确认修改密码
        </el-button>
        <el-button class="auth-secondary" size="large" @click="logout">退出登录</el-button>
      </div>
    </el-form>
  </AuthShell>
</template>
