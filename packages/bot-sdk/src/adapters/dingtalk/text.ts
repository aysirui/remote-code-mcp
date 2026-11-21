import { TOPIC_ROBOT, EventAck } from 'dingtalk-stream'
import { decode, type DingtalkConnection } from './connection.js'
import type { TextAdapter } from '../../core/capabilities/text/index.js'

/** 创建文本能力适配器；可接收固定调试提示，不输出原始回调。 */
export function createTextAdapter(
  connection: DingtalkConnection,
  diagnose?: (message: string) => void,
): TextAdapter {
  const { id, client, corpId, robotCode } = connection
  let unsubscribe: (() => void) | undefined

  return {
    connection,
    async start(events) {
      unsubscribe = connection.subscribeCallback(TOPIC_ROBOT, (frame) => {
        diagnose?.('已收到钉钉机器人消息回调。')
        const message = decode(frame.data)
        if (!frame.headers.messageId) {
          diagnose?.('回调缺少消息确认标识。')
          return
        }
        client.socketCallBackResponse(frame.headers.messageId, EventAck.SUCCESS)
        if (
          !message ||
          (message.conversationType !== '1' && message.conversationType !== '2') ||
          message.msgtype !== 'text'
        ) {
          diagnose?.('已忽略非会话纯文本回调。')
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
        const group = message.conversationType === '2'
        if (
          typeof message.senderStaffId !== 'string' ||
          !message.senderStaffId ||
          typeof message.msgId !== 'string' ||
          typeof text !== 'string' ||
          (group && (typeof message.conversationId !== 'string' || !message.conversationId))
        ) {
          diagnose?.('会话回调缺少员工 ID、消息 ID、群会话 ID 或正文。')
          return
        }
        void events
          .message({
            conversation: group
              ? { botId: id, type: 'group', chatId: message.conversationId as string }
              : { botId: id, userId: message.senderStaffId },
            actorId: message.senderStaffId,
            messageId: message.msgId,
            text,
          })
          .catch(() => events.error(new Error('钉钉文字处理失败')))
      })
    },
    async stop() {
      unsubscribe?.()
      unsubscribe = undefined
    },
    async send(to, text) {
      const group = to.type === 'group'
      const result = (await connection.request(
        group ? 'robot/groupMessages/send' : 'robot/oToMessages/batchSend',
        'POST',
        {
          robotCode,
          ...(group ? { openConversationId: to.chatId } : { userIds: [to.userId] }),
          msgKey: 'sampleText',
          msgParam: JSON.stringify({ content: text }),
        },
      )) as {
        processQueryKey?: string
        invalidStaffIdList?: string[]
        flowControlledStaffIdList?: string[]
      }
      if (
        !result.processQueryKey ||
        result.invalidStaffIdList?.length ||
        result.flowControlledStaffIdList?.length
      )
        throw new Error('钉钉未接受文字投递')
    },
  }
}
