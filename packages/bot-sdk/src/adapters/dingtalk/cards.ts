import { randomUUID } from 'node:crypto'
import { TOPIC_CARD } from 'dingtalk-stream'
import { BotConfigurationError, BotPlatformError } from '../../core/index.js'
import type { CardAdapter, Card, CardOptions } from '../../core/capabilities/cards/index.js'
import { decode, DingtalkApiError, type DingtalkConnection } from './connection.js'

/** 投递和更新仅公开已知卡片错误码及所需权限，省略平台返回的正文。 */
const diagnostics = {
  scope: 'Card.Instance.Write',
  codes: new Set([
    'param.openDeliverModelEmpty',
    'param.openDeliverModelError',
    'param.openSpaceIdInvalid',
    'param.userIdNotExist',
    'param.contentUnsafe',
    'param.openSpaceModelInvalid',
    'param.templateNotExist',
    'param.templateUnpublished',
    'spaces of card is empty',
    'spaceId is illegal',
    'chatbot not exist',
  ]),
}

/** 钉钉卡片模板中一个按钮绑定的变量名。 */
export interface DingtalkButtonSlot {
  /** 按钮文案变量。 */
  labelVariable: string
  /** 按钮可见性变量。 */
  visibleVariable: string
  /** 点击回传所引用的动作值变量。 */
  actionIdVariable: string
}

/** 钉钉卡片能力的配置，同一个机器人可以同时使用多个模板。 */
export interface DingtalkCardOptions extends CardOptions {
  /** 已发布的互动卡片模板 ID。 */
  templateId: string
  /** 标题和正文对应的模板变量，默认 title、body。 */
  titleVariable?: string
  bodyVariable?: string
  /** 按模板位置配置按钮；默认使用两个通用槽。 */
  buttonSlots?: readonly DingtalkButtonSlot[]
  /** 点击回传动作值的参数名，默认 botSdkAction。 */
  buttonActionParam?: string
  /** 是否允许转发卡片，默认关闭。 */
  supportForward?: boolean
  /** 本地模拟卡片调试回调，平台投递说明可能含收件人信息。 */
  onDeliveryFailureDetail?: (message: string) => void
}

/** 默认模板协议，槽位仅对应数组位置。 */
const defaultButtonSlots: readonly DingtalkButtonSlot[] = [
  { labelVariable: 'firstLabel', visibleVariable: 'showFirst', actionIdVariable: 'firstId' },
  { labelVariable: 'secondLabel', visibleVariable: 'showSecond', actionIdVariable: 'secondId' },
]

/** 发送前校验模板配置并复制按钮槽，点击和更新沿用这次投递的变量。 */
function prepareOptions(options?: CardOptions) {
  const {
    templateId,
    titleVariable = 'title',
    bodyVariable = 'body',
    buttonSlots = defaultButtonSlots,
    buttonActionParam = 'botSdkAction',
    supportForward = false,
    onDeliveryFailureDetail,
  } = (options ?? {}) as Partial<DingtalkCardOptions>
  if (typeof templateId !== 'string' || !templateId.trim() || !buttonActionParam.trim())
    throw new BotConfigurationError('钉钉卡片需要模板 ID 和有效的回传参数名')
  const variableNames = [
    titleVariable,
    bodyVariable,
    ...buttonSlots.flatMap((slot) => [
      slot.labelVariable,
      slot.visibleVariable,
      slot.actionIdVariable,
    ]),
  ]
  if (
    variableNames.some((name) => !name.trim()) ||
    new Set(variableNames).size !== variableNames.length
  )
    throw new BotConfigurationError('钉钉卡片变量名须非空且不能重复')
  return {
    templateId,
    titleVariable,
    bodyVariable,
    buttonSlots: buttonSlots.map((slot) => ({ ...slot })),
    buttonActionParam,
    supportForward,
    onDeliveryFailureDetail,
  }
}

/** SDK 发卡前已填充默认值，回调与更新读取发卡时的配置。 */
type PreparedOptions = ReturnType<typeof prepareOptions>

/** 以模板配置映射数组位置；隐藏按钮时保留后续按钮的槽位。 */
function renderCard(card: Card, { buttonSlots, titleVariable, bodyVariable }: PreparedOptions) {
  if (card.buttons.length > buttonSlots.length)
    throw new BotPlatformError(`钉钉模板仅配置了 ${buttonSlots.length} 个按钮槽`)
  const params: [string, string][] = [
    [titleVariable, card.title],
    [bodyVariable, card.body],
  ]
  for (const [index, slot] of buttonSlots.entries()) {
    const button = card.buttons[index]
    params.push(
      [slot.labelVariable, button?.label ?? ''],
      [slot.visibleVariable, String(Boolean(button && button.visible !== false))],
      [slot.actionIdVariable, button?.id ?? ''],
    )
  }
  return { cardParamMap: Object.fromEntries(params) }
}

/** 为该连接创建独立的卡片实现。 */
export function createCardAdapter(connection: DingtalkConnection): CardAdapter {
  const { id, client, corpId, robotCode } = connection
  let unsubscribe: (() => void) | undefined

  return {
    connection,
    async start(events) {
      unsubscribe = connection.subscribeCallback(TOPIC_CARD, async (frame) => {
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
              { cardPrivateData?: { params?: Record<string, unknown> } } | undefined
            const config = events.cardOptions(event.outTrackId) as PreparedOptions | undefined
            const actionId = config && content?.cardPrivateData?.params?.[config.buttonActionParam]
            if (config && typeof actionId === 'string' && actionId) {
              const response = await events.action({
                botId: id,
                actorId: event.userId,
                cardId: event.outTrackId,
                actionId,
              })
              if (response)
                update = {
                  cardUpdateOptions: { updateCardDataByKey: true },
                  cardData: renderCard(response.card, config),
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
    },
    async stop() {
      unsubscribe?.()
      unsubscribe = undefined
    },
    callbackUpdate: true,
    prepareOptions,
    async send(userId, card, binding, register) {
      const config = binding as PreparedOptions
      const outTrackId = `rcm_${randomUUID()}`
      const cardData = renderCard(card, config)
      register(outTrackId)
      const result = (await connection.request(
        'card/instances/createAndDeliver',
        'POST',
        {
          outTrackId,
          cardTemplateId: config.templateId,
          callbackType: 'STREAM',
          userIdType: 1,
          cardData,
          openSpaceId: `dtv1.card//IM_ROBOT.${userId}`,
          imRobotOpenSpaceModel: { supportForward: config.supportForward },
          // 绑定回执走文字接口，卡片投放也需要明确指定单聊机器人编码。
          imRobotOpenDeliverModel: { spaceType: 'IM_ROBOT', robotCode },
        },
        diagnostics,
      )) as {
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
        config.onDeliveryFailureDetail?.(delivery.errorMsg)
      if (delivery?.success === false) {
        const code = delivery.errorMsg
        const detail = code && diagnostics.codes.has(code) ? `（${code}）` : ''
        throw new DingtalkApiError(`钉钉未确认私聊卡片投递：平台返回投递失败${detail}。`)
      }
      if (result.success !== true || delivery?.success !== true)
        throw new DingtalkApiError('钉钉未确认私聊卡片投递（接口或投递结果未返回成功标记）。')
      return outTrackId
    },
    async update(ref, card, binding) {
      const result = (await connection.request(
        'card/instances',
        'PUT',
        {
          outTrackId: ref.cardId,
          cardData: renderCard(card, binding as PreparedOptions),
        },
        diagnostics,
      )) as { success?: boolean }
      if (!result.success) throw new Error('钉钉卡片更新失败')
    },
  }
}
