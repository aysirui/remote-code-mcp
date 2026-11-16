import { onMounted, onUnmounted, type Ref } from 'vue'
import { LocalAuthorizationError } from '../local-auth'
import { subscribeLocalEvents, type LocalEventName } from '../api/local-events'

/** 维护 Runtime 本地 SSE 生命周期，避免过期会话事件覆盖新会话状态。 */
export function useRuntimeEvents(
  browserWindow: Window,
  token: Ref<string>,
  applyEvent: (name: LocalEventName, payload: unknown) => void,
  invalidateLocalSession: () => void,
  readTokenFromUrl: () => boolean,
) {
  let unsubscribeEvents: (() => void) | undefined

  /** 凭据失效或组件卸载时关闭事件流，停止继续使用旧会话。 */
  function stopEvents() {
    unsubscribeEvents?.()
    unsubscribeEvents = undefined
  }

  /** SSE 首次连接推送完整快照；凭据错误需要新链接，网络中断仍自动重连。 */
  function connectEvents() {
    stopEvents()
    if (!token.value) return
    const eventToken = token.value
    unsubscribeEvents = subscribeLocalEvents(
      eventToken,
      (name, data) => {
        if (token.value === eventToken) applyEvent(name, data)
      },
      (error) => {
        if (token.value !== eventToken) return
        if (error instanceof LocalAuthorizationError) invalidateLocalSession()
        else console.warn('Runtime 本地事件流中断，正在重连', error)
      },
    )
  }
  function restoreFromUrl() {
    if (readTokenFromUrl()) connectEvents()
  }
  onMounted(() => {
    connectEvents()
    browserWindow.addEventListener('hashchange', restoreFromUrl)
  })
  onUnmounted(() => {
    stopEvents()
    browserWindow.removeEventListener('hashchange', restoreFromUrl)
  })

  return { stopEvents }
}
