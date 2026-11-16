import { computed, ref, watch, type Ref } from 'vue'
/** 已完整加载的资源列表采用本地分页；数据减少时自动回到最后有效页。 */
export function useLocalPage<T>(source: Ref<T[]>) {
  const page = ref(1)
  const pageSize = ref(20)
  const total = computed(() => source.value.length)
  watch([total, pageSize], () => {
    page.value = Math.min(page.value, Math.max(1, Math.ceil(total.value / pageSize.value)))
  })
  const rows = computed(() =>
    source.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value),
  )
  function resize(size: number) {
    pageSize.value = size
    page.value = 1
  }
  return { rows, page, pageSize, total, resize }
}
