import type { FeishuConnection } from './connection.js'
import type { TextAdapter } from '../../core/capabilities/text/index.js'

/** 为该连接创建独立的文本实现。 */
export function createTextAdapter(connection: FeishuConnection): TextAdapter {
  const { id, channel } = connection
  let unsubscribe: (() => void) | undefined
  return {
    connection,
    async start(events) {
      unsubscribe = channel.on({
        async message(message) {
          if (!['p2p', 'group'].includes(message.chatType) || message.rawContentType !== 'text')
            return
          try {
            await events.message({
              conversation:
                message.chatType === 'group'
                  ? { botId: id, type: 'group', chatId: message.chatId }
                  : { botId: id, userId: message.senderId },
              actorId: message.senderId,
              messageId: message.messageId,
              text: message.content,
            })
          } catch {
            events.error(new Error('飞书文字处理失败'))
          }
        },
      })
    },
    async stop() {
      unsubscribe?.()
      unsubscribe = undefined
    },
    async send(to, text) {
      await channel.send(connection.recipient(to), { text })
    },
  }
}
