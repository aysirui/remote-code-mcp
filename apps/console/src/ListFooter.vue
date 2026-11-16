<script setup lang="ts">
import { computed } from 'vue'
const props = defineProps<{ page: number; pageSize: number; total: number; busy: boolean }>()
defineEmits<{ page: [value: number]; size: [value: number] }>()
const start = computed(() => (props.total ? (props.page - 1) * props.pageSize + 1 : 0))
const end = computed(() => Math.min(props.page * props.pageSize, props.total))
</script>
<template>
  <footer class="list-footer">
    <span class="list-range"
      >显示 <strong>{{ start }}–{{ end }}</strong> 条，共 {{ total }} 条</span
    >
    <el-pagination
      :current-page="page"
      :page-size="pageSize"
      :total="total"
      :page-sizes="[10, 20, 50, 100]"
      :disabled="busy"
      :pager-count="5"
      layout="sizes, prev, pager, next"
      @update:current-page="$emit('page', $event)"
      @update:page-size="$emit('size', $event)"
    />
  </footer>
</template>
