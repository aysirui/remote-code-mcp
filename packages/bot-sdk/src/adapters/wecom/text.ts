import type { WSClientEventMap } from '@wecom/aibot-node-sdk'
import { BotPlatformError } from '../../core/index.js'
import { describeFailure, type WecomConnection } from './connection.js'
import type { TextAdapter } from '../../core/capabilities/text/index.js'

/** 为该连接创建独立的文本实现。 */
export function createTextAdapter(connection: WecomConnection): TextAdapter {
  const { id, botId, client, onDiagnostic } = connection
  let listener: WSClientEventMap['message.text'] | undefined

  return {
    connection,
    async start(events) {
      listener = async ({ body }) => {
        if (
          !body ||
          body.aibotid !== botId ||
          !['single', 'group'].includes(body.chattype) ||
          !body.from?.userid
        )
          return
        if (body.chattype === 'group' && !body.chatid) return
        try {
          await events.message({
            conversation:
              body.chattype === 'group'
                ? { botId: id, type: 'group', chatId: body.chatid! }
                : { botId: id, userId: body.from.userid },
            actorId: body.from.userid,
            messageId: body.msgid,
            text: body.text.content,
          })
        } catch {
          events.error(new Error('企微文字处理失败'))
        }
      }
      client.on('message.text', listener)
    },
    async stop() {
      if (listener) client.off('message.text', listener)
      listener = undefined
    },
    async send(to, text) {
      // 主动接口只接受 Markdown；转义标记，避免把收到的文本当格式或链接回送。
      const content = text.replace(/[\\`*_{}[\]()<>#+\-.!|~]/g, '\\$&')
      try {
        await client.sendMessage(to.type === 'group' ? to.chatId : to.userId, {
          msgtype: 'markdown',
          markdown: { content },
        })
        onDiagnostic?.('企微已接受文本')
      } catch (error) {
        const message = describeFailure('企微文本发送失败', error)
        onDiagnostic?.(message)
        throw new BotPlatformError(message)
      }
    },
  }
}
