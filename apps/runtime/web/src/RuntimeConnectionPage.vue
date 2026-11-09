<script setup lang="ts">
import { inject } from 'vue'
import type { RuntimeContext } from './use-runtime-console'
import { Refresh, Connection, Lock } from '@element-plus/icons-vue'
const {
  status,
  gateway,
  setGatewayDraft,
  refresh,
  updateGateway,
  startPair,
  finishPair,
  pairing,
  unpair,
} = inject<RuntimeContext>('runtime')!

/** 浏览器全局对象只在 setup 中使用，避免 Vue 模板把 window 误判为 Ref。 */
function openActivationPage() {
  if (pairing.value?.activationUrl) window.open(pairing.value.activationUrl, '_blank', 'noopener')
}
</script>
<template>
  <div class="card">
    <div class="row between">
      <div>
        <div class="title">设备与云端连接</div>
        <div class="muted">
          {{ status.name || '本地设备' }} · {{ status.deviceId || '尚未绑定账号' }}
        </div>
      </div>
      <el-button :icon="Refresh" @click="refresh">刷新</el-button>
    </div>
    <el-divider />
    <div class="row">
      <el-input
        :model-value="gateway"
        placeholder="https://mcp.example.com"
        @update:model-value="setGatewayDraft"
      /><el-button @click="updateGateway">设置服务器</el-button>
    </div>
    <div v-if="!status.paired" style="margin-top: 20px">
      <el-alert
        title="当前设备尚未绑定"
        type="info"
        :closable="false"
        description="点击生成配对码，随后在平台控制台登录账号并输入配对码。"
      /><el-button type="primary" style="margin-top: 16px" @click="startPair"
        ><el-icon><Connection /></el-icon> 绑定设备</el-button
      >
      <div
        v-if="pairing"
        style="margin-top: 19px; background: #f1f6ff; padding: 18px; border-radius: 10px"
      >
        <div class="muted">你的临时配对码</div>
        <div style="font-size: 28px; letter-spacing: 3px; font-weight: 750; margin: 8px 0">
          {{ pairing.code }}
        </div>
        <div class="row">
          <el-button type="primary" @click="openActivationPage">打开平台授权页面</el-button
          ><el-button @click="finishPair">我已确认，完成绑定</el-button>
        </div>
      </div>
    </div>
    <div v-else class="row" style="margin-top: 17px">
      <el-tag type="success">已绑定账户</el-tag
      ><el-button text type="danger" @click="unpair">断开本地连接</el-button>
    </div>
  </div>
  <div class="card">
    <div class="row">
      <el-icon color="#2563eb" size="22"><Lock /></el-icon>
      <div>
        <strong>安全提醒</strong>
        <div class="muted">
          保持 Runtime 以普通用户运行；不要将家目录或磁盘根目录作为工作区；不要把本地管理 URL 中的
          Token 发送给他人。
        </div>
      </div>
    </div>
  </div>
</template>
