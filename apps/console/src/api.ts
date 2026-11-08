export const base = import.meta.env.VITE_API_URL || ''
let csrf = ''
export async function request<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  if (method !== 'GET' && !csrf)
    csrf = (await request<{ csrfToken: string }>('/api/auth/csrf')).csrfToken
  const resp = await fetch(base + path, {
    method,
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(method !== 'GET' ? { 'x-csrf-token': csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok)
    throw new Error(
      Array.isArray(data.message)
        ? data.message.join('; ')
        : data.message || data.error || 'Request failed',
    )
  return data as T
}
export type Device = {
  id: string
  name: string
  platform: string
  status: string
  online: boolean
  lastSeenAt?: string
  runtimeVersion?: string
}
export type Workspace = {
  id: string
  deviceId: string
  name: string
  enabled: boolean
  read: boolean
  write: boolean
}
export type User = { id: string; email: string; role: string; status: string; passwordChangeRequired?: boolean }
