import { LocalAuthorizationError } from '../local-auth'

/** 本地 SSE 事件名，只订阅页面展示需要的数据。 */
export type LocalEventName = 'status' | 'workspaces' | 'write-approvals'

/**
 * 用 fetch + ReadableStream 读取 SSE，便于通过 Authorization Header 认证。
 * 原生 EventSource 不支持自定义请求头，因此不能直接复用现有 Bearer Token 安全机制。
 * SSE 只承载单向推送，配置修改与操作审批仍使用受保护的 HTTP API。
 */
export function subscribeLocalEvents(
  token: string,
  onEvent: (name: LocalEventName, data: unknown) => void,
  onError: (error: unknown) => void,
): () => void {
  let stopped = false
  let controller: AbortController | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  /** 解析单个 SSE 消息，忽略注释和未知事件。 */
  function dispatch(frame: string) {
    let name = ''
    const data: string[] = []
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    }
    if (!['status', 'workspaces', 'write-approvals'].includes(name) || !data.length) return
    onEvent(name as LocalEventName, JSON.parse(data.join('\n')))
  }

  /** SSE 连接中断后自动恢复，重连会收到 Runtime 提供的完整初始快照。 */
  async function connect() {
    if (stopped || !token) return
    controller = new AbortController()
    try {
      const response = await fetch('/local/api/events', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
        cache: 'no-store',
        signal: controller.signal,
      })
      if (response.status === 401) {
        stopped = true
        onError(new LocalAuthorizationError())
        return
      }
      if (!response.ok || !response.body)
        throw new Error(`本地事件连接失败：HTTP ${response.status}`)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (!stopped) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
        if (buffer.length > 1024 * 1024) throw new Error('本地事件消息过大')
        let index: number
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          if (frame) dispatch(frame)
        }
      }
    } catch (error: unknown) {
      if (!stopped) onError(error)
    } finally {
      if (!stopped) retryTimer = setTimeout(() => void connect(), 2000)
    }
  }

  void connect()
  return () => {
    stopped = true
    controller?.abort()
    if (retryTimer) clearTimeout(retryTimer)
  }
}
