import axios from 'axios'
import { LocalAuthorizationError } from '../local-auth'

/** Runtime 本地管理 API 的响应结构，错误消息由本地服务返回。 */
interface LocalApiError {
  error?: string
  message?: string
}

/**
 * 本地管理页面唯一的 HTTP 客户端。
 * 只访问同源 /local/api，避免把启动 Token 发送到其他服务器。
 */
const client = axios.create({
  baseURL: '/local/api/',
  // 留出 Server 请求（15 秒）超时后本地服务返回错误的时间。
  timeout: 20000,
  headers: { 'Content-Type': 'application/json' },
})

/**
 * 为每次请求注入当前启动 Token。
 * 不在 Axios 全局实例或持久存储中缓存 Token，避免意外跨请求泄露。
 */
export async function requestLocal<T = unknown>(
  path: string,
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET',
  data?: unknown,
): Promise<T> {
  if (!token) throw new LocalAuthorizationError()
  try {
    const response = await client.request<T>({
      url: path,
      method,
      data,
      headers: { Authorization: `Bearer ${token}` },
    })
    return response.data
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 401)
      throw new LocalAuthorizationError()
    if (axios.isAxiosError<LocalApiError>(error))
      throw new Error(
        error.response?.data?.error || error.response?.data?.message || '本地请求失败',
        { cause: error },
      )
    throw error
  }
}
