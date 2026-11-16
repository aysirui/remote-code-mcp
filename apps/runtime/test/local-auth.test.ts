import { subscribeLocalEvents } from '../web/src/local-events'
import { LocalAuthorizationError, LOCAL_AUTH_RECOVERY } from '../web/src/local-auth'
import { requestLocal } from '../web/src/http'

const mockRequest = jest.fn()
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    create: () => ({ request: (...args: unknown[]) => mockRequest(...args) }),
    isAxiosError: (error: unknown) => Boolean((error as { isAxiosError?: boolean })?.isAxiosError),
  },
}))
afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
  mockRequest.mockReset()
})

test('本地 API 401 给出重新打开链接及重启恢复步骤，其他错误保留原意', async () => {
  mockRequest.mockRejectedValueOnce({
    isAxiosError: true,
    response: { status: 401, data: { error: 'unauthorized' } },
  })
  await expect(requestLocal('status', 'old-key')).rejects.toThrow(LocalAuthorizationError)
  mockRequest.mockRejectedValueOnce({
    isAxiosError: true,
    response: { status: 400, data: { error: '设备凭据无效' } },
  })
  await expect(requestLocal('unpair', 'valid-key')).rejects.toThrow('设备凭据无效')
  expect(LOCAL_AUTH_RECOVERY).toContain('重启 Runtime')
  expect(LOCAL_AUTH_RECOVERY).toContain('仅刷新旧页面无法恢复')
  expect(LOCAL_AUTH_RECOVERY).toContain('#token=')
})

test('缺少页面凭据时不发出请求，直接给出本地授权恢复说明', async () => {
  await expect(requestLocal('status', '')).rejects.toThrow(LocalAuthorizationError)
  expect(mockRequest).not.toHaveBeenCalled()
})

test('SSE 凭据失效后停止自动重试，只报告一次明确的授权错误', async () => {
  jest.useFakeTimers()
  const fetch = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(null, { status: 401 }))
  const onError = jest.fn()
  const onEvent = jest.fn()
  const stop = subscribeLocalEvents('old-key', onEvent, onError)
  try {
    await jest.advanceTimersByTimeAsync(10000)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toBeInstanceOf(LocalAuthorizationError)
    expect(onEvent).not.toHaveBeenCalled()
  } finally {
    stop()
  }
})

test('普通网络故障仍会自动重连并接收快照，不误报为授权失效', async () => {
  jest.useFakeTimers()
  const fetch = jest
    .spyOn(globalThis, 'fetch')
    .mockRejectedValueOnce(Error('network unavailable'))
    .mockResolvedValue(new Response('event: status\ndata: {"online":true}\n\n', { status: 200 }))
  const onError = jest.fn()
  const onEvent = jest.fn()
  const stop = subscribeLocalEvents('valid-key', onEvent, onError)
  try {
    await jest.advanceTimersByTimeAsync(2000)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).not.toBeInstanceOf(LocalAuthorizationError)
    expect(onEvent).toHaveBeenCalledWith('status', { online: true })
  } finally {
    stop()
  }
})
