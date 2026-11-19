import { createLarkChannel } from '@larksuite/channel'
import type { BotAdapter, Card } from '../../core/index.js'

/** 国内飞书应用机器人配置。 */
export interface FeishuOptions {
  /** SDK 内唯一的机器人实例标识。 */
  id: string
  /** 飞书应用 App ID。 */
  appId: string
  /** 飞书应用 App Secret。 */
  appSecret: string
}

/** 把统一卡片转换为飞书原生卡片，正文按纯文本渲染。 */
function renderCard(card: Card) {
  return {
    header: { title: { tag: 'plain_text', content: card.title } },
    elements: [
      { tag: 'div', text: { tag: 'plain_text', content: card.body } },
      ...(card.buttons.length
        ? [
            {
              tag: 'action',
              actions: card.buttons.map((button) => ({
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

/** 创建飞书长连接适配器；私聊接收人使用本应用的 open_id。 */
export function createAdapter({ id, appId, appSecret }: FeishuOptions): BotAdapter {
  const channel = createLarkChannel({
    appId,
    appSecret,
    transport: 'websocket',
    policy: { dmMode: 'open' },
    safety: { chatQueue: { cardActions: 'separate' } },
    logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
  })
  let unsubscribe: (() => void) | undefined

  /** 只允许向本应用的用户 open_id 发私信，不接受群会话 ID。 */
  function recipient(userId: string) {
    if (!userId.startsWith('ou_')) throw new Error('飞书私聊目标必须是用户 open_id')
    return userId
  }

  return {
    id,
    callbackCardUpdate: true,
    async start(events) {
      unsubscribe = channel.on({
        async message(message) {
          if (
            message.chatType !== 'p2p' ||
            message.rawContentType !== 'text' ||
            message.senderIsBot ||
            !message.senderId.startsWith('ou_')
          )
            return
          try {
            await events.message({
              conversation: { botId: id, userId: message.senderId },
              messageId: message.messageId,
              text: message.content,
            })
          } catch {
            events.error(new Error('飞书文字处理失败'))
          }
        },
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
            })
            if (response) return { card: { type: 'raw', data: renderCard(response.card) } }
          } catch {
            events.error(new Error('飞书按钮处理失败'))
            return { toast: { type: 'error', content: '按钮处理失败' } }
          }
        },
        error: () => events.error(new Error('飞书连接或事件处理失败')),
      })
      await channel.connect()
    },
    async stop() {
      unsubscribe?.()
      unsubscribe = undefined
      await channel.disconnect()
    },
    async sendText(userId, text) {
      await channel.send(recipient(userId), { text })
    },
    async sendCard(userId, card) {
      const result = await channel.send(recipient(userId), { card: renderCard(card) })
      return result.messageId
    },
    async updateCard(ref, card) {
      await channel.updateCard(ref.cardId, renderCard(card))
    },
  }
}
