import { effectScope, nextTick, ref } from 'vue'
import { useApprovalNotifications as createNotifications } from '../web/src/composables/use-approval-notifications'
import type { WriteApprovalView } from '../web/src/types/runtime'

const mockMounted: Array<() => void> = []
const mockUnmounted: Array<() => void> = []
const mockPush = jest.fn()
jest.mock('vue-router', () => ({ useRouter: () => ({ push: mockPush }) }))
jest.mock('vue', () => ({
  ...jest.requireActual('vue'),
  onMounted: (fn: () => void) => mockMounted.push(fn),
  onUnmounted: (fn: () => void) => mockUnmounted.push(fn),
}))

const notices: Array<{ close: jest.Mock; onclick?: () => void; options: NotificationOptions }> = []
let permission: NotificationPermission
let requested: NotificationPermission
let icon: { href: string }
let callbacks: Record<string, () => void>
const original = new Map<string, PropertyDescriptor | undefined>()

/** 安装浏览器替身，测试真实响应式快照行为，避免向操作系统发送通知。 */
function install(name: string, value: unknown) {
  if (!original.has(name)) original.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}
beforeEach(() => {
  jest.useFakeTimers()
  permission = 'granted'
  requested = 'granted'
  notices.length = 0
  callbacks = {}
  icon = { href: '/original.png' }
  install('window', {
    isSecureContext: true,
    focus: jest.fn(),
    addEventListener: (name: string, fn: () => void) => {
      callbacks[name] = fn
    },
    removeEventListener: jest.fn(),
  })
  install('document', { title: 'Runtime · Local Code', querySelector: () => icon })
  install('navigator', {})
  install('BroadcastChannel', undefined)
  install(
    'Notification',
    class {
      static get permission() {
        return permission
      }
      static requestPermission = jest.fn(async () => {
        permission = requested
        return permission
      })
      close = jest.fn()
      constructor(
        _title: string,
        public options: NotificationOptions,
      ) {
        notices.push(this)
      }
    },
  )
})
afterEach(() => {
  mockUnmounted.splice(0).forEach((fn) => fn())
  mockMounted.length = 0
  mockPush.mockReset()
  for (const [name, descriptor] of original) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
  original.clear()
  jest.useRealTimers()
})

/** 建立独立页面实例，并显式执行浏览器生命周期回调。 */
function page(ids: string[] = []) {
  const approvals = ref(ids.map(item))
  const server = ref('server-1')
  const scope = effectScope()
  const active = ref(true)
  const ctx = scope.run(() => createNotifications(approvals, server, active))!
  mockMounted.splice(0).forEach((fn) => fn())
  mockUnmounted.push(() => scope.stop())
  return { approvals, server, ctx, active }
}
/** 构造一项一分钟后过期的真实审批视图摘要。 */
function item(id: string) {
  return { id, expiresAt: Date.now() + 60000 } as WriteApprovalView
}

test('新增审批通知一次，刷新、移除再重连不重复；标题和图标随队列恢复', async () => {
  const p = page(['a'])
  expect(notices).toHaveLength(1)
  expect(document.title).toContain('1 项待审批')
  expect(icon.href).toContain('data:image/svg+xml')
  p.approvals.value = [item('a')]
  await nextTick()
  expect(notices).toHaveLength(1)
  p.approvals.value = []
  await nextTick()
  expect(notices[0].close).toHaveBeenCalled()
  expect(document.title).toBe('Runtime · Local Code')
  expect(icon.href).toBe('/original.png')
  p.approvals.value = [item('a'), item('b')]
  await nextTick()
  expect(notices).toHaveLength(2)
  notices[1].onclick?.()
  expect(window.focus).toHaveBeenCalled()
  expect(mockPush).toHaveBeenCalledWith('/approvals')
  expect(notices[1].options.body).not.toContain('path')
})

test('Web Locks 主标签页首次快照合并通知，从标签页不发送', async () => {
  let acquire: (() => Promise<void>) | undefined
  install('navigator', {
    locks: {
      request: jest.fn((_name, _options, callback) => {
        acquire = callback
        return Promise.resolve()
      }),
    },
  })
  page(['a', 'b'])
  expect(notices).toHaveLength(0)
  void acquire?.()
  await nextTick()
  expect(notices).toHaveLength(1)
  expect(notices[0].options.body).toContain('2 项')
})

test('无 Web Locks 时相同审批使用稳定 tag 供浏览器合并', async () => {
  const p = page(['a', 'b'])
  await nextTick()
  expect(notices.map((n) => n.options.tag)).toEqual(['rcm-approval-server-1-a'])
  p.approvals.value.push(item('c'))
  await nextTick()
  expect(notices[1].options.tag).toBe('rcm-approval-server-1-c')
})

test('拒绝权限时保留角标，点击请求授权后才发送；失效审批自动清理', async () => {
  permission = 'default'
  const p = page(['a'])
  expect(notices).toHaveLength(0)
  expect(document.title).toContain('待审批')
  requested = 'denied'
  await p.ctx.enableNotifications()
  await nextTick()
  expect(p.ctx.notificationLabel.value).toContain('拒绝')
  permission = 'granted'
  callbacks.focus()
  await nextTick()
  expect(notices).toHaveLength(1)
  jest.advanceTimersByTime(61000)
  await nextTick()
  expect(icon.href).toBe('/original.png')
  expect(notices[0].close).toHaveBeenCalled()
})

test('不支持通知时审批角标仍可用，切换服务器清除通知状态', async () => {
  install('Notification', undefined)
  const p = page(['a'])
  expect(p.ctx.notificationSupported).toBe(false)
  expect(document.title).toContain('待审批')
  p.approvals.value = []
  p.server.value = 'server-2'
  await nextTick()
  expect(icon.href).toBe('/original.png')
})

test('凭据失效或离线释放通知发送权，拒绝权限的页面不参与选举', async () => {
  const signals: AbortSignal[] = []
  const request = jest.fn((_name, options, callback) => {
    signals.push(options.signal)
    void callback()
    return Promise.resolve()
  })
  install('navigator', { locks: { request } })
  permission = 'denied'
  const p = page(['a'])
  expect(request).not.toHaveBeenCalled()
  permission = 'granted'
  callbacks.focus()
  await nextTick()
  expect(request).toHaveBeenCalledTimes(1)
  p.active.value = false
  await nextTick()
  expect(signals[0].aborted).toBe(true)
  expect(icon.href).toBe('/original.png')
  expect(notices[0].close).toHaveBeenCalled()
})

test('新标签页同步去重记录，主标签页关闭后接管不会重复提醒', async () => {
  const channels: Array<{ onmessage?: (event: { data: unknown }) => void }> = []
  install(
    'BroadcastChannel',
    class {
      onmessage?: (event: { data: unknown }) => void
      constructor() {
        channels.push(this)
      }
      postMessage(data: unknown) {
        for (const channel of channels) if (channel !== this) channel.onmessage?.({ data })
      }
      close() {
        channels.splice(channels.indexOf(this), 1)
      }
    },
  )
  let tail = Promise.resolve()
  install('navigator', {
    locks: {
      request: (_name: string, _options: unknown, callback: () => Promise<void>) => {
        const result = tail.then(callback)
        tail = result
        return result
      },
    },
  })
  page(['a'])
  await nextTick()
  expect(notices).toHaveLength(1)
  const disposeLeader = mockUnmounted.splice(0)
  const follower = page(['a'])
  await nextTick()
  expect(notices).toHaveLength(1)
  for (const dispose of disposeLeader) dispose()
  await nextTick()
  await nextTick()
  expect(notices).toHaveLength(1)
  follower.approvals.value.push(item('b'))
  await nextTick()
  expect(notices).toHaveLength(2)
})
