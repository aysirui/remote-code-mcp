<script setup lang="ts">
import { Clock, Document, Refresh, Warning } from '@element-plus/icons-vue'
import ListFooter from './ListFooter.vue'
defineProps<{
  title: string
  count: number
  page: number
  pageSize: number
  busy: boolean
  error: string
  hasItems: boolean
  emptyTitle: string
  emptyDescription: string
  order?: string
}>()
defineEmits<{ page: [value: number]; size: [value: number]; retry: [] }>()
</script>
<template>
  <section class="data-list-panel" :aria-label="title" :aria-busy="busy">
    <header class="data-list-toolbar">
      <div class="data-list-title">
        <h2>{{ title }}</h2>
        <span class="data-list-count">{{ count }}</span>
      </div>
      <span class="data-list-order"
        ><el-icon><Clock /></el-icon>{{ order || '最新记录在前' }}</span
      >
    </header>
    <div v-if="error" class="data-list-empty" role="alert">
      <span class="data-empty-icon"
        ><el-icon><Warning /></el-icon
      ></span>
      <h3>暂时无法加载</h3>
      <p>{{ error }}</p>
      <el-button :icon="Refresh" @click="$emit('retry')">重新加载</el-button>
    </div>
    <div v-else-if="busy && !hasItems" class="data-list-skeleton" aria-label="正在加载列表">
      <el-skeleton :rows="5" animated />
    </div>
    <template v-else-if="hasItems">
      <div v-loading="busy" class="data-list-body"><slot /></div>
      <ListFooter
        :page="page"
        :page-size="pageSize"
        :total="count"
        :busy="busy"
        @page="$emit('page', $event)"
        @size="$emit('size', $event)"
      />
    </template>
    <div v-else class="data-list-empty" role="status">
      <span class="data-empty-icon"
        ><el-icon><Document /></el-icon
      ></span>
      <h3>{{ emptyTitle }}</h3>
      <p>{{ emptyDescription }}</p>
    </div>
  </section>
</template>
