import { computed, onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import { useRouter } from 'vue-router'
import type { WriteApprovalView } from '../types/runtime'

/**
 * 本机审批提醒：以审批列表和当前服务器为输入，active 表示本地凭据有效且在线。
 * 返回权限展示与授权操作；弹窗只含数量，不泄露路径、命令及审批详情。
 */
export function useApprovalNotifications(
  approvals: Ref<WriteApprovalView[]>,
  serverId: Ref<string>,
  active: Ref<boolean>,
) {
  const router = useRouter()
  const supported = typeof Notification !== 'undefined' && window.isSecureContext
  const permission = ref<NotificationPermission>(supported ? Notification.permission : 'denied')
  /** 仅获通知授权且在线的标签页才能持有发送权。 */
  const leader = ref(false)
  /** 当前页面生命周期内已提醒的审批 ID，断线重连不会清空。 */
  const seen = new Set<string>()
  let firstNotification = true
  /** 本页创建的通知按审批 ID 关联，队列失效时主动关闭。 */
  const opened = new Map<string, Notification>()
  const now = ref(Date.now())
  const pending = computed(() =>
    active.value ? approvals.value.filter((item) => item.expiresAt > now.value) : [],
  )
  const count = computed(() => pending.value.length)
  const label = computed(() =>
    !supported
      ? '此浏览器不支持通知'
      : permission.value === 'granted'
        ? '浏览器通知已开启'
        : permission.value === 'denied'
          ? '通知已被拒绝，请在浏览器设置中允许'
          : '开启浏览器通知',
  )
  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  const originalIcon = icon?.href || ''
  const originalTitle = document.title
  let timer: ReturnType<typeof setInterval> | undefined
  let release: (() => void) | undefined
  let abort: AbortController | undefined
  let stopElection: (() => void) | undefined
  const channel =
    typeof BroadcastChannel === 'undefined'
      ? undefined
      : new BroadcastChannel('rcm-approval-notifications')
  // 提醒态复用完整品牌 Logo，避免以临时绘制的图标替换原 favicon。
  const attentionIcon = '/favicon-attention.svg'
  let blinkOn = true

  /** 仅在存在待审批任务时切换 favicon，清空或离线后恢复标准图标。 */
  function updateFavicon() {
    if (icon) icon.href = count.value && blinkOn ? attentionIcon : originalIcon
  }

  /** 仅点击按钮时申请通知权限，已拒绝时由用户在浏览器设置中修改。 */
  async function enableNotifications() {
    if (!supported || permission.value !== 'default') return
    try {
      permission.value = await Notification.requestPermission()
    } catch {
      permission.value = Notification.permission
    }
  }

  /** 关闭所有本页创建的提醒；状态切换不影响实际审批队列。 */
  function closeNotifications() {
    for (const notification of opened.values()) notification.close()
    opened.clear()
  }

  /** 同源标签页之间只交换服务器 ID 和已提醒的审批 ID，不交换审批详情。 */
  type NotificationMessage = { serverId: string; kind: 'seen' | 'sync'; ids: string[] }
  /** 新标签页或切换服务器时请求已有去重状态，接管发送权后不重复旧通知。 */
  function syncSeen() {
    channel?.postMessage({ serverId: serverId.value, kind: 'sync', ids: [] })
  }
  /** 活跃标签页同步已通知 ID，后续接管领导权时不重复提醒。 */
  if (channel)
    channel.onmessage = (event: MessageEvent<NotificationMessage>) => {
      if (event.data.serverId !== serverId.value) return
      if (event.data.kind === 'sync') {
        channel.postMessage({ serverId: serverId.value, kind: 'seen', ids: [...seen] })
      } else {
        for (const id of event.data.ids) seen.add(id)
      }
    }

  watch(
    serverId,
    () => {
      closeNotifications()
      seen.clear()
      firstNotification = true
      syncSeen()
    },
    { flush: 'sync' },
  )
  watch(
    [pending, permission, leader],
    () => {
      document.title = count.value
        ? `（${count.value} 项待审批）Runtime · Local Code`
        : originalTitle
      if (!count.value) blinkOn = true
      updateFavicon()
      const ids = new Set(pending.value.map((item) => item.id))
      for (const [id, notification] of opened) {
        if (!ids.has(id)) {
          notification.close()
          opened.delete(id)
        }
      }
      if (!supported || permission.value !== 'granted' || !leader.value) return
      const fresh = pending.value.filter((item) => !seen.has(item.id))
      if (!fresh.length) return
      // 首次快照合并为一次通知；不支持 Web Locks 时用稳定 tag 合并相同审批。
      const batches = navigator.locks || firstNotification ? [fresh] : fresh.map((item) => [item])
      firstNotification = false
      for (const batch of batches) {
        try {
          const notification = new Notification('Remote Code · 操作待审批', {
            body: `有 ${count.value} 项操作等待你确认，请前往本地审批页面查看。`,
            tag: `rcm-approval-${serverId.value}-${batch[0].id}`,
            icon: originalIcon,
          })
          for (const item of batch) {
            seen.add(item.id)
            opened.set(item.id, notification)
          }
          channel?.postMessage({
            serverId: serverId.value,
            kind: 'seen',
            ids: batch.map((item) => item.id),
          })
          notification.onclick = () => {
            window.focus()
            void router.push('/approvals')
            notification.close()
          }
        } catch {
          // 系统可能在授权后仍拒绝弹窗；不影响审批或标签页提醒，也不自动重试刷屏。
          for (const item of batch) seen.add(item.id)
        }
      }
    },
    { immediate: true, flush: 'sync' },
  )

  /** 页面重新获得焦点时同步浏览器设置中的权限变更。 */
  function syncPermission() {
    if (supported) permission.value = Notification.permission
  }
  onMounted(() => {
    syncSeen()
    timer = setInterval(() => {
      now.value = Date.now()
      if (count.value) {
        blinkOn = !blinkOn
        updateFavicon()
      }
    }, 500)
    window.addEventListener('focus', syncPermission)
    // 只有有效且允许通知的页面参与选举，避免失效或拒绝权限的标签页占住发送权。
    stopElection = watch(
      [permission, active],
      () => {
        abort?.abort()
        release?.()
        release = undefined
        leader.value = false
        if (!supported || permission.value !== 'granted' || !active.value) return
        if (!navigator.locks) {
          leader.value = true
          return
        }
        abort = new AbortController()
        void navigator.locks
          .request('rcm-approval-notification-leader', { signal: abort.signal }, async () => {
            leader.value = true
            await new Promise<void>((resolve) => {
              release = resolve
            })
            leader.value = false
          })
          .catch((error: unknown) => {
            if (!(error instanceof DOMException && error.name === 'AbortError'))
              console.warn('无法选举审批通知标签页', error)
          })
      },
      { immediate: true },
    )
  })
  onUnmounted(() => {
    clearInterval(timer)
    stopElection?.()
    abort?.abort()
    release?.()
    channel?.close()
    closeNotifications()
    window.removeEventListener('focus', syncPermission)
    document.title = originalTitle
    if (icon) icon.href = originalIcon
  })
  return {
    notificationLabel: label,
    notificationPermission: permission,
    notificationSupported: supported,
    enableNotifications,
  }
}
