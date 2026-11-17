import axios, { AxiosError, type Method } from 'axios'

/** 开发环境的请求始终走 Vite 同源代理，生产环境仍使用配置的 API 地址。 */
export const base = import.meta.env.DEV ? '' : import.meta.env.VITE_API_URL || ''

/**
 * 唯一的业务 HTTP 客户端：Cookie 负责 Session，CSRF Token 只放入非安全请求头。
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

/** 请求错误只暴露用户消息、业务码和重试秒数，不携带请求密码或配置。 */
export class ApiError extends Error {
  constructor(
    message: string,
    /** 服务端稳定业务码，用于区分账号已存在、未激活和发信失败。 */
    public readonly code?: string,
    /** 服务端建议的重试等待秒数。 */
    public readonly retryAfter?: number,
  ) {
    super(message)
  }
}

/** 将 Axios 错误转换成 UI 可展示的信息，不暴露请求配置。 */
function toError(error: unknown): Error {
  if (!axios.isAxiosError(error)) return error instanceof Error ? error : Error('请求失败')
  const response = (
    error as AxiosError<{
      message?: string | string[]
      error?: string
      code?: string
      retryAfter?: number
    }>
  ).response
  const message = response?.data?.message ?? response?.data?.error
  return new ApiError(
    Array.isArray(message) ? message.join('; ') : message || '网络请求失败',
    response?.data?.code,
    response?.data?.retryAfter,
  )
}

/** 统一的业务请求入口；所有会修改服务端状态的请求必须先取得 CSRF Token。 */
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

/** Runtime 同步的工作区有效权限与策略；不包含本地路径或目录名。 */
export type Workspace = {
  id: string
  deviceId: string
  name: string
  enabled: boolean
  read: boolean
  write: boolean
  policies: {
    file: 'deny' | 'approval' | 'allow'
    git: 'deny' | 'approval' | 'allow'
    command: 'deny' | 'approval' | 'allow'
  }
}

/** 登录用户资料；首次管理员登录可能要求先修改临时密码。 */
export type User = {
  id: string
  email: string
  role: string
  status: string
  passwordChangeRequired?: boolean
}

/** MCP 操作日志包含必要元数据及脱敏命令，不含路径、原始参数、内容、输出或对话信息。 */
export type OperationLog = {
  id: string
  operationId: string
  userId: string
  deviceId?: string | null
  workspaceId: string
  clientId: string
  toolName: string
  commandSummary?: string | null
  operationType: 'file' | 'git' | 'command'
  status: 'success' | 'failed'
  durationMs: number
  errorCode?: string | null
  createdAt: string
}

/** 安全审计只记录管理动作，不记录 AI 工具调用详情。 */
export type SecurityAudit = {
  id: string
  actorType: 'user' | 'admin'
  actorId: string
  eventType: string
  resourceType?: string | null
  resourceId?: string | null
  result: 'success' | 'failed'
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
