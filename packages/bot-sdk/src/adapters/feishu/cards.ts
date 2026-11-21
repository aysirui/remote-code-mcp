import { BotConfigurationError } from '../../core/index.js'
import type { FeishuConnection } from './connection.js'
import type { CardAdapter, Card } from '../../core/capabilities/cards/index.js'

/** 把统一卡片转换为飞书原生卡片，正文按纯文本渲染。 */
function renderCard(card: Card) {
  const buttons = card.buttons.filter(({ visible }) => visible !== false)
  return {
    header: { title: { tag: 'plain_text', content: card.title } },
    elements: [
      { tag: 'div', text: { tag: 'plain_text', content: card.body } },
      ...(buttons.length
        ? [
            {
              tag: 'action',
              actions: buttons.map((button) => ({
                tag: 'button',
                text: { tag: 'plain_text', content: button.label },
                value: { botSdkAction: button.id },
              })),
            },
          ]
        : []),
    ],
  }
}

/** 为该连接创建独立的卡片实现。 */
export function createCardAdapter(connection: FeishuConnection): CardAdapter {
  const { id, channel } = connection
  let unsubscribe: (() => void) | undefined
  return {
    connection,
    async start(events) {
      unsubscribe = channel.on({
        async cardAction(event) {
          const value = event.action.value as { botSdkAction?: unknown } | null
          if (
            event.action.tag !== 'button' ||
            typeof value?.botSdkAction !== 'string' ||
            !event.operator.openId ||
            !event.messageId
          )
            return
          try {
            const response = await events.action({
              botId: id,
              cardId: event.messageId,
              actorId: event.operator.openId,
              actionId: value.botSdkAction,
              chatId: event.chatId,
            })
            if (response) return { card: { type: 'raw', data: renderCard(response.card) } }
          } catch {
            events.error(new Error('飞书按钮处理失败'))
            return { toast: { type: 'error', content: '按钮处理失败' } }
          }
        },
      })
    },
    async stop() {
      unsubscribe?.()
      unsubscribe = undefined
    },
    callbackUpdate: true,
    async send(to, card, binding) {
      if (binding) throw new BotConfigurationError('当前飞书卡片使用原生 JSON，无需模板配置')
      const result = await channel.send(connection.recipient(to), { card: renderCard(card) })
      return result.messageId
    },
    async update(ref, card) {
      await channel.updateCard(ref.cardId, renderCard(card))
    },
  }
}
