<script setup lang="ts">
import { CopyDocument } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
export interface DetailField {
  label: string
  value: string | number | null | undefined
  copy?: boolean
}
defineProps<{ open: boolean; title: string; fields: DetailField[] }>()
defineEmits<{ close: [] }>()
/** 长标识完整保留在详情内；复制失败时明确提示。 */
async function copy(value: DetailField['value']) {
  try {
    await navigator.clipboard.writeText(String(value))
    ElMessage.success('已复制')
  } catch {
    ElMessage.error('复制失败，请选中文本复制')
  }
}
</script>
<template>
  <el-drawer
    :model-value="open"
    :title="title"
    size="min(480px, 100vw)"
    class="record-drawer"
    @close="$emit('close')"
  >
    <p class="record-drawer-intro">本条记录的完整元数据</p>
    <dl class="record-detail-list">
      <div v-for="field in fields" :key="field.label">
        <dt>{{ field.label }}</dt>
        <dd>
          <span :class="{ 'record-mono': field.copy }">{{ field.value ?? '—' }}</span>
          <el-button
            v-if="field.copy && field.value"
            text
            :icon="CopyDocument"
            :aria-label="'复制' + field.label"
            @click="copy(field.value)"
          />
        </dd>
      </div>
    </dl>
  </el-drawer>
</template>
