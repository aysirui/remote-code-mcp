import { ref, watch, onUnmounted, type Ref } from 'vue'
import { request } from './api'

/** 每个列表独立分页；序列号防止较慢的旧请求覆盖新页。 */
export function usePagedList<T>(endpoint: string, revision: Ref<number>) {
  const items = ref<T[]>([]) as Ref<T[]>
  const page = ref(1)
  const pageSize = ref(20)
  const total = ref(0)
  const busy = ref(false)
  const error = ref('')
  let sequence = 0
  async function load() {
    const current = ++sequence
    busy.value = true
    error.value = ''
    try {
      const result = await request<{ items: T[]; total: number }>(
        `${endpoint}?page=${page.value}&pageSize=${pageSize.value}`,
      )
      if (current !== sequence) return
      const last = Math.max(1, Math.ceil(result.total / pageSize.value))
      if (page.value > last) {
        page.value = last
        return
      }
      items.value = result.items
      total.value = result.total
    } catch (e) {
      if (current === sequence) {
        items.value = []
        error.value = e instanceof Error ? e.message : '列表加载失败'
      }
    } finally {
      if (current === sequence) busy.value = false
    }
  }
  watch(
    [page, pageSize, revision],
    () => {
      void load()
    },
    { immediate: true },
  )
  onUnmounted(() => {
    sequence++
  })
  function resize(size: number) {
    pageSize.value = size
    page.value = 1
  }
  return { items, page, pageSize, total, busy, error, load, resize }
}
