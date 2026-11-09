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
  } catch (error: unknown) {
    if (axios.isAxiosError<{ message?: string; error?: string }>(error)) {
      // 本地 UI 需要区分 HTTP 拒绝与连接失败；不要向 UI 泄露认证凭据或请求体。
      const status = error.response?.status
      const serverMessage = error.response?.data
      const detail =
        typeof serverMessage?.message === 'string'
          ? serverMessage.message
          : typeof serverMessage?.error === 'string'
            ? serverMessage.error
            : undefined
      const reason = status
        ? `Gateway HTTP ${status}${detail ? ': ' + detail : ''}`
        : error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT'
          ? 'Gateway 请求超时'
          : error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN'
            ? 'Gateway DNS 解析失败'
            : error.code === 'ECONNREFUSED'
              ? 'Gateway 连接被拒绝'
              : error.code === 'ECONNRESET'
                ? 'Gateway 连接被重置'
                : error.code?.startsWith('ERR_TLS_') ||
                    error.code?.startsWith('CERT_') ||
                    error.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
                  ? 'Gateway TLS 证书校验失败'
                  : `Gateway 网络请求失败${error.code ? ' (' + error.code + ')' : ''}`
      throw new Error(reason, { cause: error })
    }
    throw error
  }
}
