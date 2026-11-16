<script setup lang="ts">
import { inject } from 'vue'
import type { ConsoleContext } from '../../composables/use-console'
const { pairingCode, approve } = inject<ConsoleContext>('console')!
</script>
<template>
  <div class="card" style="max-width: 660px">
    <h3 class="card-title">将 Runtime 绑定到你的账号</h3>
    <el-steps :active="1" finish-status="success" style="margin: 25px 0 34px">
      <el-step title="打开 Runtime" />
      <el-step title="输入配对码" />
      <el-step title="绑定成功" />
    </el-steps>
    <p class="muted">
      请在本地 Runtime 页面点击“绑定设备”，获取一次性配对码，再输入下方。配对码仅短时有效。
    </p>
    <el-input v-model="pairingCode" placeholder="ABCD-EFGH" size="large" style="margin: 17px 0" />
    <el-button type="primary" :disabled="!pairingCode" @click="approve">确认绑定</el-button>
  </div>
</template>
