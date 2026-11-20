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
      }
      client.on('message.text', listener)
    },
    async stop() {
      if (listener) client.off('message.text', listener)
      listener = undefined
    },
    async send(userId, text) {
      // 主动接口只接受 Markdown；转义标记，避免把收到的文本当格式或链接回送。
      const content = text.replace(/[\\`*_{}[\]()<>#+\-.!|~]/g, '\\$&')
      try {
        await client.sendMessage(userId, { msgtype: 'markdown', markdown: { content } })
        onDiagnostic?.('企微已接受私聊文本')
      } catch (error) {
        const message = describeFailure('企微私聊文本发送失败', error)
        onDiagnostic?.(message)
        throw new BotPlatformError(message)
      }
    },
  }
}
