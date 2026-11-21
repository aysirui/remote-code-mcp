import { randomUUID } from 'node:crypto'
import { TemplateCardType, type TemplateCard, type WSClientEventMap } from '@wecom/aibot-node-sdk'
import { BotPlatformError, BotConfigurationError } from '../../core/index.js'
import { describeFailure } from './connection.js'
import type { WecomConnection } from './connection.js'
import type { CardAdapter, Card, CardOptions } from '../../core/capabilities/cards/index.js'

/** 企业微信无按钮通知卡使用的发卡选项。 */
export interface WecomCardOptions extends CardOptions {
  /** 点击无按钮卡片时打开的 HTTP(S) 链接；不配置则不跳转。 */
  readonly textNoticeUrl?: string
}

/** 发送前校验并保存供结果卡使用的链接。 */
function prepareOptions(options?: CardOptions): WecomCardOptions | undefined {
  if (!options) return
  const { textNoticeUrl } = options
  if (textNoticeUrl === undefined) return {}
  if (
    typeof textNoticeUrl !== 'string' ||
    !URL.canParse(textNoticeUrl) ||
    !/^https?:$/u.test(new URL(textNoticeUrl).protocol)
  )
    throw new BotConfigurationError('企微文本通知卡需要有效的 HTTP(S) 跳转链接')
  return { textNoticeUrl }
}

/** 按企微原生字段拆分正文，并记录超出原生字段条数的详情。 */
function cardContent(body: string) {
  const rows: NonNullable<TemplateCard['horizontal_content_list']> = []
  const notes: string[] = []
  // 将「标签：内容」用原生字段逐条呈现，避免多行详情在引用区被折叠。
  for (const line of body.split('\n')) {
    if (!line.trim()) continue
    const field = /^([^：]{1,5})：(.+)$/u.exec(line)
    if (field && rows.length < 6) rows.push({ keyname: field[1], value: field[2] })
    else notes.push(line)
  }
  return { rows, notes: notes.join('\n') }
}

/** 转换为模板卡片；回调更新沿用原 task_id 关联同一张卡。 */
function renderCard(card: Card, taskId: string, options?: WecomCardOptions): TemplateCard {
  const textNoticeUrl = options?.textNoticeUrl
  const { rows, notes } = cardContent(card.body)
  const buttons = card.buttons.filter(({ visible }) => visible !== false)
  const hasButtons = buttons.length > 0
  return {
    card_type: hasButtons ? TemplateCardType.ButtonInteraction : TemplateCardType.TextNotice,
    task_id: taskId,
    main_title: { title: card.title },
    ...(rows.length ? { horizontal_content_list: rows } : {}),
    ...(notes ? { sub_title_text: notes } : {}),
    ...(hasButtons
      ? {
          button_list: buttons.map((button) => ({
            key: button.id,
            text: button.label,
            // 企微原生样式 1 为蓝底白字，4 为浅底深字。
            ...(button.style ? { style: button.style === 'primary' ? 1 : 4 } : {}),
          })),
        }
      : // 通知卡要求提供 card_action；type 0 保留原卡内容但不打开外部页面。
        { card_action: textNoticeUrl ? { type: 1, url: textNoticeUrl } : { type: 0 } }),
  }
}

/** 为该连接创建独立的卡片实现。 */
export function createCardAdapter(connection: WecomConnection): CardAdapter {
  const { id, botId, client, onDiagnostic } = connection
  let listener: WSClientEventMap['event.template_card_event'] | undefined

  return {
    connection,
    async start(events) {
      listener = async (frame) => {
        onDiagnostic?.('企微已推送卡片按钮回调')
        const body = frame.body
        if (
          !body ||
          body.aibotid !== botId ||
          body.chattype === 'group' ||
          (!body.chattype && body.chatid) ||
          !body.from?.userid
        ) {
          onDiagnostic?.('企微按钮回调未通过机器人或私聊身份校验')
          return
        }
        // WebSocket 回调可将按钮参数放在 template_card_event 中，SDK 类型还声明了平铺形式。
        const event = body.event as typeof body.event & {
          template_card_event?: Pick<typeof body.event, 'task_id' | 'event_key'>
        }
        const { task_id: cardId, event_key: actionId } = event?.template_card_event ?? event ?? {}
        if (
          typeof cardId !== 'string' ||
          !cardId.startsWith('rcm_') ||
          typeof actionId !== 'string' ||
          !actionId
        ) {
          onDiagnostic?.('企微按钮回调缺少本 SDK 发出的卡片编号或按钮键')
          return
        }
        const binding = events.cardOptions(cardId) as WecomCardOptions | undefined
        try {
          const response = await events.action({
            botId: id,
            cardId,
            actionId,
            actorId: body.from.userid,
          })
          if (response) {
            await client.updateTemplateCard(frame, renderCard(response.card, cardId, binding), [
              body.from.userid,
            ])
            onDiagnostic?.('企微已确认卡片更新')
          } else onDiagnostic?.('企微按钮回调未产生卡片更新')
        } catch (error) {
          events.error(new BotPlatformError(describeFailure('企微按钮或卡片更新处理失败', error)))
        }
      }
      client.on('event.template_card_event', listener)
    },
    async stop() {
      if (listener) client.off('event.template_card_event', listener)
      listener = undefined
    },
    callbackUpdate: true,
    prepareOptions,
    // 企微要求五秒内提交更新，保留 2.5 秒等待业务结果，其余时间用于发送回执。
    callbackUpdateWaitMs: 2_500,
    async send(userId, card, binding, register) {
      const taskId = `rcm_${randomUUID()}`
      const templateCard = renderCard(card, taskId, binding as WecomCardOptions | undefined)
      register(taskId)
      try {
        await client.sendMessage(userId, {
          msgtype: 'template_card',
          template_card: templateCard,
        })
        onDiagnostic?.('企微已接受卡片')
      } catch (error) {
        const message = describeFailure('企微卡片发送失败', error)
        onDiagnostic?.(message)
        throw new BotPlatformError(message)
      }
      return taskId
    },
  }
}
