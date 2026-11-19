import { ref, watch, type Ref } from 'vue'
import { request, type User } from '../api'

/** 已配置通知渠道及当前账号的绑定状态。 */
export interface ApprovalChannel {
  channel: 'feishu' | 'wecom' | 'dingtalk'
  bound: boolean
  enabled: boolean
}

export const approvalChannelsEndpoint = '/api/me/approval-channels'

/** 侧栏和设置页共享查询结果；切换账号时丢弃旧响应。 */
export function useApprovalChannels(account: Ref<User | null>) {
  const channels = ref<ApprovalChannel[]>([])
  const loading = ref(false)
  const error = ref('')
  let revision = 0

  /** 仅为已经登录并完成首次改密的账号查询可用渠道。 */
  async function reload() {
    const current = ++revision
    if (!account.value || account.value.passwordChangeRequired) return
    loading.value = true
    error.value = ''
    try {
      const result = await request<ApprovalChannel[]>(approvalChannelsEndpoint)
      if (current === revision) channels.value = result
    } catch (failure) {
      if (current === revision)
        error.value = failure instanceof Error ? failure.message : '暂时无法读取通知渠道'
    } finally {
      if (current === revision) loading.value = false
    }
  }

  watch(
    () => [account.value?.id, account.value?.passwordChangeRequired] as const,
    () => {
      channels.value = []
      error.value = ''
      loading.value = false
      void reload()
    },
    { immediate: true, flush: 'sync' },
  )

  return { channels, loading, error, reload }
}
