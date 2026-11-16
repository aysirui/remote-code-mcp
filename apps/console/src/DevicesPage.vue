<script setup lang="ts">
import { inject } from 'vue'
import type { ConsoleContext } from './use-console'
import { useLocalPage } from './use-local-page'
import ListFooter from './ListFooter.vue'
import { Monitor, Plus } from '@element-plus/icons-vue'
const { devices, rename, revoke, navigate } = inject<ConsoleContext>('console')!
const { rows, page, pageSize, total, resize } = useLocalPage(devices)
</script>
<template>
  <div class="card">
    <div class="row-between">
      <h3 class="card-title">我的设备</h3>
      <el-button type="primary" @click="navigate('activate')"
        ><el-icon><Plus /></el-icon> 绑定设备</el-button
      >
    </div>
    <div v-for="d in rows" :key="d.id" class="device-row">
      <div class="device-icon">
        <el-icon><Monitor /></el-icon>
      </div>
      <div>
        <strong>{{ d.name }}</strong>
        <div class="muted">
          {{ d.platform }} · {{ d.runtimeVersion || '未知版本' }} ·
          {{
            d.lastSeenAt ? '最近连接 ' + new Date(d.lastSeenAt).toLocaleString() : '暂无连接记录'
          }}
        </div>
      </div>
      <div class="spacer"></div>
      <el-tag :type="d.online ? 'success' : 'info'">{{ d.online ? '在线' : '离线' }}</el-tag
      ><el-button text @click="rename(d)">重命名</el-button
      ><el-button text type="danger" @click="revoke(d)">解绑</el-button>
    </div>
    <el-empty v-if="!devices.length" description="还没有绑定设备" />
    <ListFooter
      v-if="total > 10"
      :page="page"
      :page-size="pageSize"
      :total="total"
      :busy="false"
      @page="page = $event"
      @size="resize"
    />
  </div>
</template>
