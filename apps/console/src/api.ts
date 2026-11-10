import axios, { AxiosError, type Method } from 'axios'

/** 开发环境的请求始终走 Vite 同源代理，生产环境仍使用配置的 API 地址。 */
export const base = import.meta.env.DEV ? '' : import.meta.env.VITE_API_URL || ''

/**
 * 唯一的业务 HTTP 客户端。
 * Cookie 负责 Session，CSRF Token 只放入非安全请求头；
 * 不允许在日志或异常信息中输出账号密码及原始请求体。
 */
const http = axios.create({
  baseURL: base,
  withCredentials: true,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
})

let csrfToken = ''
let csrfLoading: Promise<string> | undefined

/** 获取 CSRF Token，并合并并发请求，避免多次重复初始化。 */
async function getCsrf(): Promise<string> {
  if (csrfToken) return csrfToken
  if (!csrfLoading) {
    csrfLoading = http
      .get<{ csrfToken: string }>('/api/auth/csrf')
      .then(({ data }) => {
        csrfToken = data.csrfToken
        return csrfToken
      })
      .finally(() => {
        csrfLoading = undefined
      })
  }
  return csrfLoading
}

/** 将 Axios 的错误转换成 UI 可展示的信息，不暴露请求配置。 */
function toError(error: unknown): Error {
  if (!axios.isAxiosError(error)) return error instanceof Error ? error : Error('请求失败')
  const response = (error as AxiosError<{ message?: string | string[]; error?: string }>).response
  const message = response?.data?.message ?? response?.data?.error
  return Error(Array.isArray(message) ? message.join('; ') : message || '网络请求失败')
}

/**
 * 统一的业务请求入口；保留原有 API 签名以避免改动页面行为。
 * 所有需要修改服务端状态的请求必须先取得 CSRF Token。
 */
export async function request<T = unknown>(
  url: string,
  method: Method = 'GET',
  body?: unknown,
): Promise<T> {
  try {
    const headers: Record<string, string> = {}
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()))
      headers['x-csrf-token'] = await getCsrf()
    const { data } = await http.request<T>({ url, method, data: body, headers })
    return data
  } catch (error) {
    throw toError(error)
  }
}

/** 当前用户设备在 Console 中展示的摘要。 */
export type Device = {
  id: string
  name: string
  platform: string
  status: string
  online: boolean
  userId?: string
  lastSeenAt?: string
  runtimeVersion?: string
}

/** 云端计算后的工作区有效权限，不包含本地绝对路径。 */
export type Workspace = {
  id: string
  deviceId: string
  name: string
  /** 本地目录末级名称；不包含绝对路径。 */
  directoryName?: string | null
  enabled: boolean
  read: boolean
  write: boolean
}

/** 登录用户资料；初始管理员首次登录必须修改临时密码。 */
export type User = {
  id: string
  email: string
  role: string
  status: string
  passwordChangeRequired?: boolean
}

/** 管理台审计记录，工作区与设备信息可能为空。 */
export type AuditLog = {
  id: string
  operation: string
  status: string
  workspaceId?: string | null
  deviceId?: string | null
  createdAt: string
}

/** 当前用户授予 OAuth 客户端的有效权限。 */
export type OAuthGrant = {
  clientId: string
  clientName?: string | null
  scope: string
  createdAt: string
  lastUsedAt?: string | null
}

/** 管理员首页统计数据。 */
export type OverviewStats = {
  users: number
  devices: number
  online: number
  workspaces: number
}
