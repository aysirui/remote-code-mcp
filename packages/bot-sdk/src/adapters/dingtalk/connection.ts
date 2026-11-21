import { DWClient, type DWClientDownStream } from 'dingtalk-stream'
import { BotPlatformError, type BotAdapter } from '../../core/index.js'
/** 钉钉企业内部应用连接配置。 */
export interface DingtalkOptions {
  /** 在 BotManager 内使用的名字，默认 dingtalk。 */
  id?: string
  /** 企业内部应用 Client ID。 */
  clientId: string
  /** 企业内部应用 Client Secret。 */
  clientSecret: string
  /** 企业 corpId；仅接收该企业成员的事件。 */
  corpId: string
  /** 机器人编码，缺省时使用 Client ID。 */
  robotCode?: string
  /** 输出连接、私聊、卡片处理阶段和模板字段名，不含平台正文、凭证或用户身份。 */
  onDiagnostic?: (message: string) => void
}

/** 可写入运维日志的钉钉接口错误，仅由适配器使用固定提示和已知平台错误码构造。 */
export class DingtalkApiError extends BotPlatformError {}

/** 从网络异常中保留可公开的诊断码。 */
const safeNetworkCodes = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
])

/** 调用钉钉 OpenAPI；网络异常不保留底层请求、异常正文或凭证。 */
async function fetchApi(path: string, init: RequestInit): Promise<Response> {
  return await fetch(`https://api.dingtalk.com/v1.0/${path}`, init).catch((error: unknown) => {
    const timedOut = init.signal?.aborted
    const cause = error instanceof Error ? error.cause : undefined
    const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined
    const detail = typeof code === 'string' && safeNetworkCodes.has(code) ? `（${code}）` : ''
    throw new DingtalkApiError(
      `钉钉 ${path} ${timedOut ? '网络请求超时' : '网络请求失败'}${detail}`,
    )
  })
}

/** HTTP 成功时仍校验响应体可解析，区分代理错误页和业务拒绝。 */
async function readJson<T>(response: Response, path: string): Promise<T> {
  return (await response.json().catch(() => {
    throw new DingtalkApiError(`钉钉 ${path} 返回非 JSON 响应（HTTP ${response.status}）`)
  })) as T
}

/** 所有接口共用的公开错误码。 */
const commonErrorCodes = new Set([
  'AccessDenied',
  'Forbidden.AccessDenied',
  'Forbidden.AccessDenied.AccessTokenPermissionDenied',
  'Forbidden.AccessDenied.IpNotInWhiteList',
  'param.invalid',
  'system.busy',
])

/** 单个能力允许出现在日志中的接口诊断。 */
interface RequestDiagnostics {
  /** 可公开的能力专用平台错误码。 */
  codes: ReadonlySet<string>
  /** 可公开的权限名。 */
  scope?: string
}

/** 解码平台回调；忽略不是对象的内容。 */
export function decode(data: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(data)
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** 平台连接的认证、基础接口及资源由实例管理。 */
export class DingtalkConnection implements BotAdapter {
  /** SDK 内唯一的机器人实例标识。 */
  readonly id: string
  /** @internal Stream 客户端，供已安装能力接收回调。 */
  readonly client: DWClient
  /** @internal 入站事件必须来自此组织。 */
  readonly corpId: string
  /** @internal 出站接口使用的机器人编码。 */
  readonly robotCode: string
  private token?: { value: string; expiresAt: number }

  /** 初始化连接所需的客户端及凭证。 */
  constructor(private readonly options: DingtalkOptions) {
    const { id = 'dingtalk', clientId, clientSecret, corpId, robotCode = clientId } = options
    this.id = id
    this.corpId = corpId
    this.robotCode = robotCode
    this.client = new DWClient({ clientId, clientSecret, keepAlive: true, debug: false })
    // Stream SDK 浅拷贝默认配置，各连接必须隔离自己的订阅数组。
    this.client.config.subscriptions = [...this.client.config.subscriptions]
  }

  /** 建立并确认平台连接。 */
  async start() {
    try {
      await this.client.connect()
    } catch {
      throw new Error('钉钉 Stream 连接失败')
    }
    // Stream SDK 会吞掉首次连接异常并安排重连，必须读取连接状态确认启动结果。
    if (!this.client.connected) throw new Error('钉钉 Stream 连接失败')
  }
  /** 断开 Stream 并清除访问令牌。 */
  async stop() {
    this.client.disconnect()
    this.token = undefined
  }

  /** 使用新版授权接口获取凭证；异常不携带凭证或平台响应原文。 */
  private async accessToken() {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value
    const { clientId, clientSecret } = this.options
    const response = await fetchApi('oauth2/accessToken', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appKey: clientId, appSecret: clientSecret }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new DingtalkApiError(`钉钉获取访问令牌失败（HTTP ${response.status}）`)
    const result = await readJson<{ accessToken?: string; expireIn?: number } | null>(
      response,
      'oauth2/accessToken',
    )
    if (!result?.accessToken || !result.expireIn)
      throw new DingtalkApiError('钉钉访问令牌响应缺少字段')
    this.token = {
      value: result.accessToken,
      expiresAt: Date.now() + (result.expireIn - 60) * 1000,
    }
    return this.token.value
  }

  /** @internal 调用钉钉 API，错误消息仅保留可公开的诊断。 */
  async request(
    path: string,
    method: 'POST' | 'PUT',
    body: object,
    diagnostics?: RequestDiagnostics,
  ) {
    const response = await fetchApi(path, {
      method,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
      headers: {
        'content-type': 'application/json',
        'x-acs-dingtalk-access-token': await this.accessToken(),
      },
    })
    if (response.status === 401) this.token = undefined
    if (!response.ok) {
      const result = (await response.json().catch(() => undefined)) as
        | {
            /** 钉钉 REST 错误码、请求追踪号及权限详情；不读取业务异常正文。 */
            code?: string
            requestid?: string
            accessdenieddetail?: { requiredScopes?: string[] }
          }
        | undefined
      const code =
        result?.code && (commonErrorCodes.has(result.code) || diagnostics?.codes.has(result.code))
          ? `，${result.code}`
          : ''
      const scopes = result?.accessdenieddetail?.requiredScopes
      const scope = diagnostics?.scope
      const permission =
        scope && Array.isArray(scopes) && scopes.includes(scope) ? `，缺少权限 ${scope}` : ''
      const requestId = result?.requestid
      // 只接受官方错误结构里的 UUID 追踪号，不把平台回显的业务数据写进日志。
      const trace =
        typeof requestId === 'string' &&
        /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(requestId)
          ? `，请求 ID ${requestId}`
          : ''
      throw new DingtalkApiError(
        `钉钉 ${path} 请求失败（HTTP ${response.status}${code}${permission}${trace}）`,
      )
    }
    return await readJson(response, path)
  }

  /** @internal 注册当前能力的回调，最后一个同主题监听释放时取消 Stream 订阅。 */
  subscribeCallback(topic: string, handler: (frame: DWClientDownStream) => void) {
    this.client.registerCallbackListener(topic, handler)
    return () => {
      this.client.off(topic, handler)
      if (!this.client.listenerCount(topic))
        this.client.config.subscriptions = this.client.config.subscriptions.filter(
          (item) => item.type !== 'CALLBACK' || item.topic !== topic,
        )
    }
  }
}
