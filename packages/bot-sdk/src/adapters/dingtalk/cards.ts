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
  /** 模板按钮组件 ID；配置后可用平台 actionIds 直接识别该槽的动作。 */
  componentId?: string
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
  /** 标题对应的模板变量，默认 title。 */
  titleVariable?: string
  /** 正文对应的模板变量，默认 body。 */
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
  {
    componentId: 'button1',
    labelVariable: 'firstLabel',
    visibleVariable: 'showFirst',
    actionIdVariable: 'firstId',
  },
  {
    componentId: 'button2',
    labelVariable: 'secondLabel',
    visibleVariable: 'showSecond',
    actionIdVariable: 'secondId',
  },
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
  const componentIds = buttonSlots.flatMap((slot) =>
    slot.componentId === undefined ? [] : [slot.componentId],
  )
  if (componentIds.some((id) => !id.trim()) || new Set(componentIds).size !== componentIds.length)
    throw new BotConfigurationError('钉钉按钮组件 ID 须非空且不能重复')
  return {
    templateId,
    titleVariable,
    bodyVariable,
    buttonSlots: buttonSlots.map((slot) => ({ ...slot })),
    buttonActionParam,
    supportForward,
    onDeliveryFailureDetail,
    // 仅记录当前卡片可见按钮与模板组件的对应关系，避免依赖审批等业务动作名。
    buttonActions: new Map<string, string>(),
  }
}

/** SDK 发卡前已填充默认值，回调与更新读取发卡时的配置。 */
type PreparedOptions = ReturnType<typeof prepareOptions>

/** 按数组位置生成模板数据与可见按钮映射；隐藏按钮时保留后续槽位，调用方成功发送后保存映射。 */
function renderCard(card: Card, config: PreparedOptions) {
  const { buttonSlots, titleVariable, bodyVariable } = config
  if (card.buttons.length > buttonSlots.length)
    throw new BotPlatformError(`钉钉模板仅配置了 ${buttonSlots.length} 个按钮槽`)
  const params: [string, string][] = [
    [titleVariable, card.title],
    [bodyVariable, card.body],
  ]
  const buttonActions = new Map<string, string>()
  for (const [index, slot] of buttonSlots.entries()) {
    const button = card.buttons[index]
    if (slot.componentId && button && button.visible !== false)
      buttonActions.set(slot.componentId, button.id)
    params.push(
      [slot.labelVariable, button?.label ?? ''],
      [slot.visibleVariable, String(Boolean(button && button.visible !== false))],
      [slot.actionIdVariable, button?.id ?? ''],
    )
  }
  return { cardData: { cardParamMap: Object.fromEntries(params) }, buttonActions }
}

/** 为连接创建卡片实现并保存默认模板映射；诊断不输出身份或卡片内容。 */
export function createCardAdapter(
  connection: DingtalkConnection,
  diagnose?: (message: string) => void,
  defaults?: DingtalkCardOptions,
): CardAdapter {
  const { id, client, corpId, robotCode } = connection
  let unsubscribe: (() => void) | undefined

  return {
    connection,
    async start(events) {
      unsubscribe = connection.subscribeCallback(TOPIC_CARD, async (frame) => {
        diagnose?.('已收到钉钉卡片按钮回调。')
        const requestId = frame.headers.messageId
        if (!requestId) {
          diagnose?.('钉钉卡片回调缺少消息确认标识。')
          return
        }
        let update: object = {}
        // 回执写入成功后才切换本地动作映射，保持失败时原卡按钮的含义。
        let acceptedUpdate:
          { config: PreparedOptions; buttonActions: Map<string, string> } | undefined
        try {
          const event = decode(frame.data)
          // 群聊与私聊都支持交互；场域是上下文，不作为业务授权条件，点击权限由调用方核验。
          if (
            event?.corpId === corpId &&
            typeof event.userId === 'string' &&
            event.userId &&
            typeof event.outTrackId === 'string' &&
            event.outTrackId &&
            typeof event.content === 'string'
          ) {
            const content = decode(event.content) as
              | {
                  /** 平台回传的按钮组件和调用方配置的参数。 */
                  cardPrivateData?: {
                    /** 本次交互触发的模板组件 ID；按钮点击只接受单个组件。 */
                    actionIds?: unknown[]
                    /** 模板显式配置的键值参数，兼容原有参数回传方式。 */
                    params?: Record<string, unknown>
                  }
                }
              | undefined
            const config = events.cardOptions(event.outTrackId) as PreparedOptions | undefined
            const privateData = content?.cardPrivateData
            const actionIds = privateData?.actionIds
            const componentId =
              Array.isArray(actionIds) && actionIds.length === 1 ? actionIds[0] : undefined
            // 组件与显示槽位绑定，优先用它映射动作；旧模板仍可使用显式回传参数。
            const actionId =
              config &&
              ((typeof componentId === 'string'
                ? config.buttonActions.get(componentId)
                : undefined) ??
                privateData?.params?.[config.buttonActionParam])
            if (!config) diagnose?.('钉钉卡片配置不在当前进程，无法解析按钮。')
            else if (typeof actionId !== 'string' || !actionId)
              diagnose?.('钉钉卡片回调未匹配按钮组件或有效动作参数。')
            if (config && typeof actionId === 'string' && actionId) {
              const response = await events.action({
                botId: id,
                actorId: event.userId,
                cardId: event.outTrackId,
                actionId,
                ...(typeof event.spaceId === 'string' &&
                event.spaceId.startsWith('dtv1.card//IM_GROUP.')
                  ? {
                      conversation: {
                        botId: id,
                        type: 'group' as const,
                        chatId: event.spaceId.slice('dtv1.card//IM_GROUP.'.length),
                      },
                    }
                  : {}),
              })
              diagnose?.('钉钉卡片按钮已交付业务处理。')
              if (response) {
                const rendered = renderCard(response.card, config)
                update = {
                  cardUpdateOptions: { updateCardDataByKey: true },
                  cardData: rendered.cardData,
                }
                acceptedUpdate = { config, buttonActions: rendered.buttonActions }
              }
            }
          } else {
            // 只报告各项校验是否通过，便于区分回调未到达与已到达但被过滤。
            diagnose?.(
              `钉钉卡片回调校验未通过：${JSON.stringify({
                企业匹配: event?.corpId === corpId,
                点击者存在: typeof event?.userId === 'string' && Boolean(event.userId),
                卡片编号有效: typeof event?.outTrackId === 'string' && Boolean(event.outTrackId),
                交互内容为字符串: typeof event?.content === 'string',
              })}`,
            )
          }
        } catch {
          events.error(new Error('钉钉按钮处理失败'))
        }
        try {
          client.socketCallBackResponse(requestId, update)
          if (acceptedUpdate) acceptedUpdate.config.buttonActions = acceptedUpdate.buttonActions
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
    // 常规 API 使用连接默认配置；底层扩展可覆盖本次投放，更新沿用原配置。
    prepareOptions: (options) => prepareOptions(options ?? defaults),
    async send(to, card, binding, register) {
      const config = binding as PreparedOptions
      const outTrackId = `rcm_${randomUUID()}`
      const { cardData, buttonActions } = renderCard(card, config)
      diagnose?.(
        `钉钉发卡按钮字段：${config.buttonSlots
          .map((slot) =>
            [slot.labelVariable, slot.actionIdVariable, slot.visibleVariable].join('/'),
          )
          .join('；')}`,
      )
      config.buttonActions = buttonActions
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
          ...(to.type === 'group'
            ? {
                openSpaceId: `dtv1.card//IM_GROUP.${to.chatId}`,
                imGroupOpenSpaceModel: { supportForward: config.supportForward },
                imGroupOpenDeliverModel: { robotCode },
              }
            : {
                openSpaceId: `dtv1.card//IM_ROBOT.${to.userId}`,
                imRobotOpenSpaceModel: { supportForward: config.supportForward },
                imRobotOpenDeliverModel: { spaceType: 'IM_ROBOT', robotCode },
              }),
        },
        diagnostics,
      )) as {
        success?: boolean
        result?: { deliverResults?: { success?: boolean; errorMsg?: string }[] }
      }
      // HTTP 成功只表示接口可调用，仍需检查钉钉返回的目标会话投递结果。
      const deliveries = result?.result?.deliverResults
      if (!Array.isArray(deliveries) || deliveries.length !== 1) {
        const count = Array.isArray(deliveries) ? deliveries.length : '未返回'
        throw new DingtalkApiError(`钉钉未确认卡片投递（投递结果条数：${count}，预期 1 条）。`)
      }
      const delivery = deliveries[0]
      if (typeof delivery?.errorMsg === 'string' && delivery.success !== true && delivery.errorMsg)
        config.onDeliveryFailureDetail?.(delivery.errorMsg)
      if (delivery?.success === false) {
        const code = delivery.errorMsg
        const detail = code && diagnostics.codes.has(code) ? `（${code}）` : ''
        throw new DingtalkApiError(`钉钉未确认卡片投递：平台返回投递失败${detail}。`)
      }
      if (result.success !== true || delivery?.success !== true)
        throw new DingtalkApiError('钉钉未确认卡片投递（接口或投递结果未返回成功标记）。')
      return outTrackId
    },
    async update(ref, card, binding) {
      const config = binding as PreparedOptions
      const { cardData, buttonActions } = renderCard(card, config)
      const result = (await connection.request(
        'card/instances',
        'PUT',
        {
          outTrackId: ref.cardId,
          cardData,
        },
        diagnostics,
      )) as { success?: boolean }
      if (!result.success) throw new Error('钉钉卡片更新失败')
      config.buttonActions = buttonActions
      diagnose?.('钉钉已确认主动更新原卡。')
    },
  }
}
