import axios from 'axios'

/**
 * Runtime 发往云端 Gateway 的受控 HTTP 客户端。
 * 设备配对仅使用明确的服务端地址，远程连接一律要求 HTTPS；
 * 本机开发可使用 localhost / 127.0.0.1 的 HTTP。
 */
export async function postGateway<T = unknown>(
  gatewayUrl: string,
  endpoint: string,
  payload: unknown,
): Promise<T> {
  const gateway = new URL(gatewayUrl)
  if (
    gateway.protocol !== 'https:' &&
    !(gateway.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(gateway.hostname))
  )
    throw Error('HTTPS gateway required')
  if (!endpoint.startsWith('/api/device/pairing/')) throw Error('UNSUPPORTED_GATEWAY_ENDPOINT')

  try {
    const { data } = await axios.post<T>(new URL(endpoint, gateway).toString(), payload, {
      timeout: 15000,
      maxContentLength: 512 * 1024,
      maxBodyLength: 512 * 1024,
      headers: { 'Content-Type': 'application/json' },
    })
    return data
  } catch (error) {
    if (axios.isAxiosError<{ message?: string; error?: string }>(error))
      throw new Error(
        error.response?.data?.message || error.response?.data?.error || 'Gateway 请求失败',
        { cause: error },
      )
    throw error
  }
}
