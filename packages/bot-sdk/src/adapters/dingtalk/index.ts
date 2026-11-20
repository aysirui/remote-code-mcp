import { randomUUID } from 'node:crypto'
import { DWClient, EventAck, TOPIC_CARD, TOPIC_ROBOT } from 'dingtalk-stream'
import type { BotAdapter, Card } from '../../core/index.js'

/** 钉钉企业内部应用及互动卡片配置。 */
export interface DingtalkOptions {
  /** SDK 内唯一的机器人实例标识。 */
  id: string
  /** 企业内部应用 Client ID。 */
  clientId: string
  /** 企业内部应用 Client Secret。 */
  clientSecret: string
  /** 企业 corpId；仅接收该企业成员的事件。 */
  corpId: string
  /** 已发布的互动卡片模板 ID，须遵循 README 中的变量约定。 */
  cardTemplateId: string
  /** 机器人编码，缺省时使用 Client ID。 */
  robotCode?: string
  /** 本地模拟卡片调试专用；接收钉钉的投递错误说明，可能含收件人信息。 */
  onDeliveryFailureDetail?: (message: string) => void
  /** 本地排查私聊回调时接收固定诊断提示，不含平台消息或用户身份。 */
  onMessageDiagnostic?: (message: string) => void
}

/** 可写入运维日志的钉钉接口错误，仅由适配器使用固定提示和已知平台错误码构造。 */
export class DingtalkApiError extends Error {}

/** 平台响应可能包含原始业务内容，只允许已知错误码进入错误消息。 */
const safeErrorCodes = new Set([
  'AccessDenied',
  'Forbidden.AccessDenied',
  'Forbidden.AccessDenied.AccessTokenPermissionDenied',
  'Forbidden.AccessDenied.IpNotInWhiteList',
  'param.openDeliverModelEmpty',
  'param.openDeliverModelError',
  'param.openSpaceIdInvalid',
  'param.userIdNotExist',
  'param.contentUnsafe',
  'param.openSpaceModelInvalid',
  'param.templateNotExist',
  'param.templateUnpublished',
  'param.invalid',
  'system.busy',
  'spaces of card is empty',
  'spaceId is illegal',
  'chatbot not exist',
])

/** 卡片模板映射；两个可见性字段独立控制按钮是否渲染。 */
function renderCard(card: Card) {
  if (card.buttons.length > 2) throw new Error('钉钉默认模板最多支持两个按钮')
  const [first, second] = card.buttons
  return {
    cardParamMap: {
      title: card.title,
      body: card.body,
      firstId: first?.id ?? '',
      firstLabel: first?.label ?? '',
      showFirst: String(Boolean(first)),
      secondId: second?.id ?? '',
      secondLabel: second?.label ?? '',
      showSecond: String(Boolean(second)),
    },
  }
}

/** 解码平台回调；忽略不是对象的内容。 */
function decode(data: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(data)
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** 创建钉钉适配器；Stream SDK 收事件，OpenAPI 负责主动投放和更新。 */
export function createAdapter(options: DingtalkOptions): BotAdapter {
  const { id, clientId, clientSecret, corpId, cardTemplateId, robotCode = clientId } = options
  const client = new DWClient({ clientId, clientSecret, keepAlive: true, debug: false })
  let token: { value: string; expiresAt: number } | undefined

  /** 使用新版授权接口获取凭证；异常不携带凭证或平台响应原文。 */
  async function accessToken() {
    if (token && token.expiresAt > Date.now()) return token.value
    const response = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appKey: clientId, appSecret: clientSecret }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new DingtalkApiError(`钉钉获取访问令牌失败（HTTP ${response.status}）`)
    const result = (await response.json()) as { accessToken?: string; expireIn?: number }
    if (!result.accessToken || !result.expireIn)
      throw new DingtalkApiError('钉钉访问令牌响应缺少字段')
    token = { value: result.accessToken, expiresAt: Date.now() + (result.expireIn - 60) * 1000 }
    return token.value
  }

  /** 调用固定的钉钉 API；平台返回失败时不把业务数据写入错误消息。 */
  async function request(path: string, method: 'POST' | 'PUT', body: object) {
    const response = await fetch(`https://api.dingtalk.com/v1.0/${path}`, {
      method,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
      headers: {
        'content-type': 'application/json',
        'x-acs-dingtalk-access-token': await accessToken(),
      },
    })
    if (response.status === 401) token = undefined
    if (!response.ok) {
      const result = (await response.json().catch(() => undefined)) as
        | {
            /** 钉钉 REST 错误码、请求追踪号及权限详情；不读取业务异常正文。 */
            code?: string
            requestid?: string
            accessdenieddetail?: { requiredScopes?: string[] }
          }
        | undefined
      const code = result?.code && safeErrorCodes.has(result.code) ? `，${result.code}` : ''
      const scopes = result?.accessdenieddetail?.requiredScopes
      const permission =
        Array.isArray(scopes) && scopes.includes('Card.Instance.Write')
          ? '，缺少互动卡片实例写权限 Card.Instance.Write'
          : ''
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
    return await response.json()
  }

  return {
    id,
    callbackCardUpdate: true,
    async start(events) {
      client.registerCallbackListener(TOPIC_ROBOT, (frame) => {
        const diagnose = options.onMessageDiagnostic
        diagnose?.('已收到钉钉机器人消息回调。')
        const message = decode(frame.data)
        if (!frame.headers.messageId) {
          diagnose?.('回调缺少消息确认标识。')
          return
        }
        client.socketCallBackResponse(frame.headers.messageId, EventAck.SUCCESS)
        if (message?.conversationType !== '1' || message.msgtype !== 'text') {
          diagnose?.('已忽略非私聊纯文本回调。')
          return
        }
        if (message.senderCorpId !== corpId) {
          // 员工 ID 属于其所在组织，不能用其他组织的成员身份发卡或绑定。
          if (message.chatbotCorpId === corpId)
            diagnose?.('机器人组织与配置一致，但发送者不是该组织成员或回调缺少发送者组织。')
          else diagnose?.('发送者组织与 DINGTALK_CORP_ID 不匹配，请核对机器人所在组织。')
          return
        }
        const text = (message.text as { content?: unknown } | undefined)?.content
        if (
          typeof message.senderStaffId !== 'string' ||
          !message.senderStaffId ||
          typeof message.msgId !== 'string' ||
          typeof text !== 'string'
        ) {
          diagnose?.('私聊回调缺少员工 ID、消息 ID 或正文。')
          return
        }
        void events
          .message({
            conversation: { botId: id, userId: message.senderStaffId },
            messageId: message.msgId,
            text,
          })
          .catch(() => events.error(new Error('钉钉文字处理失败')))
      })
      client.registerCallbackListener(TOPIC_CARD, async (frame) => {
        const requestId = frame.headers.messageId
        if (!requestId) return
        let update: object = {}
        try {
          const event = decode(frame.data)
          if (
            event?.spaceType === 'IM_ROBOT' &&
            event.corpId === corpId &&
            typeof event.userId === 'string' &&
            event.userId &&
            typeof event.outTrackId === 'string' &&
            event.outTrackId.startsWith('rcm_') &&
            typeof event.content === 'string'
          ) {
            const content = decode(event.content) as
              { cardPrivateData?: { params?: { botSdkAction?: unknown } } } | undefined
            const actionId = content?.cardPrivateData?.params?.botSdkAction
            if (typeof actionId === 'string' && actionId) {
              const response = await events.action({
                botId: id,
                actorId: event.userId,
                cardId: event.outTrackId,
                actionId,
              })
              if (response)
                update = {
                  cardUpdateOptions: { updateCardDataByKey: true },
                  cardData: renderCard(response.card),
                }
            }
          }
        } catch {
          events.error(new Error('钉钉按钮处理失败'))
        }
        try {
          client.socketCallBackResponse(requestId, update)
        } catch {
          events.error(new Error('钉钉按钮回执发送失败'))
        }
      })
      try {
        await client.connect()
      } catch {
        throw new Error('钉钉 Stream 连接失败')
      }
      // Stream SDK 会吞掉首次连接异常并安排重连，必须读取连接状态确认启动结果。
      if (!client.connected) throw new Error('钉钉 Stream 连接失败')
    },
    async stop() {
      client.disconnect()
      client.removeAllListeners(TOPIC_ROBOT)
      client.removeAllListeners(TOPIC_CARD)
      token = undefined
    },
    async sendText(userId, text) {
      const result = (await request('robot/oToMessages/batchSend', 'POST', {
        robotCode,
        userIds: [userId],
        msgKey: 'sampleText',
        msgParam: JSON.stringify({ content: text }),
      })) as {
        processQueryKey?: string
        invalidStaffIdList?: string[]
        flowControlledStaffIdList?: string[]
      }
      if (
        !result.processQueryKey ||
        result.invalidStaffIdList?.length ||
        result.flowControlledStaffIdList?.length
      )
        throw new Error('钉钉未接受私聊文字投递')
    },
    async sendCard(userId, card) {
      const outTrackId = `rcm_${randomUUID()}`
      const result = (await request('card/instances/createAndDeliver', 'POST', {
        outTrackId,
        cardTemplateId,
        callbackType: 'STREAM',
        userIdType: 1,
        cardData: renderCard(card),
        openSpaceId: `dtv1.card//IM_ROBOT.${userId}`,
        imRobotOpenSpaceModel: { supportForward: false },
        // 绑定回执走文字接口，卡片投放也需要明确指定单聊机器人编码。
        imRobotOpenDeliverModel: { spaceType: 'IM_ROBOT', robotCode },
      })) as {
        success?: boolean
        result?: { deliverResults?: { success?: boolean; errorMsg?: string }[] }
      }
      // HTTP 成功只表示接口可调用，仍需检查钉钉返回的单聊投递结果。
      const deliveries = result?.result?.deliverResults
      if (!Array.isArray(deliveries) || deliveries.length !== 1) {
        const count = Array.isArray(deliveries) ? deliveries.length : '未返回'
        throw new DingtalkApiError(`钉钉未确认私聊卡片投递（投递结果条数：${count}，预期 1 条）。`)
      }
      const delivery = deliveries[0]
      if (typeof delivery?.errorMsg === 'string' && delivery.success !== true && delivery.errorMsg)
        options.onDeliveryFailureDetail?.(delivery.errorMsg)
      if (delivery?.success === false) {
        const code = delivery.errorMsg
        const detail = code && safeErrorCodes.has(code) ? `（${code}）` : ''
        throw new DingtalkApiError(`钉钉未确认私聊卡片投递：平台返回投递失败${detail}。`)
      }
      if (result.success !== true || delivery?.success !== true)
        throw new DingtalkApiError('钉钉未确认私聊卡片投递（接口或投递结果未返回成功标记）。')
      return outTrackId
    },
    async updateCard(ref, card) {
      const result = (await request('card/instances', 'PUT', {
        outTrackId: ref.cardId,
        cardData: renderCard(card),
      })) as { success?: boolean }
      if (!result.success) throw new Error('钉钉卡片更新失败')
    },
  }
}
