import { randomUUID } from 'node:crypto'
import { TemplateCardType, WSClient, type TemplateCard } from '@wecom/aibot-node-sdk'
import type { BotAdapter, Card } from '../../core/index.js'

/** 企业微信智能机器人长连接配置，不是自建应用凭证。 */
export interface WecomOptions {
  /** SDK 内唯一的机器人实例标识。 */
  id: string
  /** 智能机器人的 Bot ID。 */
  botId: string
  /** 智能机器人的长连接 Secret。 */
  secret: string
}

/** 转换为模板卡片；回调更新沿用原 task_id 关联同一张卡。 */
function renderCard(card: Card, taskId: string): TemplateCard {
  return {
    card_type: card.buttons.length
      ? TemplateCardType.ButtonInteraction
      : TemplateCardType.TextNotice,
    task_id: taskId,
    main_title: { title: card.title, desc: card.body },
    ...(card.buttons.length
      ? { button_list: card.buttons.map((button) => ({ key: button.id, text: button.label })) }
      : {}),
  }
}

/** 创建企微适配器；私聊目标使用用户 userid。 */
export function createAdapter({ id, botId, secret }: WecomOptions): BotAdapter {
  const client = new WSClient({
    botId,
    secret,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  })

  return {
    id,
    callbackCardUpdate: true,
    async start(events) {
      client.on('message.text', async ({ body }) => {
        if (!body || body.aibotid !== botId || body.chattype !== 'single' || !body.from?.userid)
          return
        try {
          await events.message({
            conversation: { botId: id, userId: body.from.userid },
            messageId: body.msgid,
            text: body.text.content,
          })
        } catch {
          events.error(new Error('企微文字处理失败'))
        }
      })
      client.on('event.template_card_event', async (frame) => {
        const body = frame.body
        if (
          !body ||
          body.aibotid !== botId ||
          body.chattype === 'group' ||
          body.chatid ||
          !body.from?.userid
        )
          return
        const { task_id: cardId, event_key: actionId } = body.event
        if (!cardId?.startsWith('rcm_') || !actionId) return
        try {
          const response = await events.action({
            botId: id,
            cardId,
            actionId,
            actorId: body.from.userid,
          })
          if (response)
            await client.updateTemplateCard(frame, renderCard(response.card, cardId), [
              body.from.userid,
            ])
        } catch {
          events.error(new Error('企微按钮或卡片更新处理失败'))
        }
      })
      client.on('error', () => events.error(new Error('企微连接失败')))
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => failed(), 15_000)
        /** 认证结束后取消启动监听及计时器，不影响 SDK 的重连。 */
        function cleanup() {
          clearTimeout(timeout)
          client.off('authenticated', authenticated)
          client.off('error', failed)
        }
        /** 认证成功后才允许发送。 */
        function authenticated() {
          cleanup()
          resolve()
        }
        /** 认证失败或超时时结束启动，外层负责关闭连接。 */
        function failed() {
          cleanup()
          reject(new Error('企微机器人未能完成认证'))
        }
        client.once('authenticated', authenticated)
        client.once('error', failed)
        try {
          client.connect()
        } catch {
          failed()
        }
      })
    },
    async stop() {
      client.disconnect()
      client.removeAllListeners()
    },
    async sendText(userId, text) {
      // 主动接口只接受 Markdown；转义标记，避免把收到的文本当格式或链接回送。
      const content = text.replace(/[\\`*_{}[\]()<>#+\-.!|~]/g, '\\$&')
      await client.sendMessage(userId, { msgtype: 'markdown', markdown: { content } })
    },
    async sendCard(userId, card) {
      const taskId = `rcm_${randomUUID()}`
      await client.sendMessage(userId, {
        msgtype: 'template_card',
        template_card: renderCard(card, taskId),
      })
      return taskId
    },
  }
}
