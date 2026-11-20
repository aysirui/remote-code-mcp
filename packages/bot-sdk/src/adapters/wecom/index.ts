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
  /** 无按钮的文本通知卡所需的整卡跳转链接，例如应用控制台。 */
  textNoticeUrl?: string
  /** 本地调试时接收固定阶段提示和企微数字错误码，不输出回调或卡片内容。 */
  onDiagnostic?: (message: string) => void
}

/** 转换为模板卡片；回调更新沿用原 task_id 关联同一张卡。 */
function renderCard(card: Card, taskId: string, textNoticeUrl?: string): TemplateCard {
  const rows: NonNullable<TemplateCard['horizontal_content_list']> = []
  const notes: string[] = []
  // 将「标签：内容」用原生字段逐条呈现，避免多行详情在引用区被折叠。
  for (const line of card.body.split('\n')) {
    if (!line.trim()) continue
    const field = /^([^：]{1,5})：(.+)$/u.exec(line)
    if (field && rows.length < 6) rows.push({ keyname: field[1], value: field[2] })
    else notes.push(line)
  }
  const hasButtons = card.buttons.length > 0
  if (!hasButtons && !textNoticeUrl) throw new Error('企微无按钮卡片需要配置 textNoticeUrl')
  return {
    card_type: hasButtons ? TemplateCardType.ButtonInteraction : TemplateCardType.TextNotice,
    task_id: taskId,
    main_title: { title: card.title },
    ...(rows.length ? { horizontal_content_list: rows } : {}),
    ...(notes.length ? { sub_title_text: notes.join('\n') } : {}),
    ...(hasButtons
      ? {
          button_list: card.buttons.map((button) => ({
            key: button.id,
            text: button.label,
            // 企微原生样式 1 为蓝底白字，4 为浅底深字。
            ...(button.style ? { style: button.style === 'primary' ? 1 : 4 } : {}),
          })),
        }
      : { card_action: { type: 1, url: textNoticeUrl } }),
  }
}

/** 官方 SDK 拒绝时可能返回回执帧；仅提取数字错误码，避免记录响应正文。 */
function describeFailure(stage: string, error: unknown): string {
  const code = error && typeof error === 'object' && 'errcode' in error ? error.errcode : undefined
  return typeof code === 'number' && Number.isInteger(code) ? `${stage}（errcode=${code}）` : stage
}

/** 创建企微适配器；私聊目标使用用户 userid。 */
export function createAdapter({
  id,
  botId,
  secret,
  textNoticeUrl,
  onDiagnostic,
}: WecomOptions): BotAdapter {
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
        try {
          const response = await events.action({
            botId: id,
            cardId,
            actionId,
            actorId: body.from.userid,
          })
          if (response) {
            await client.updateTemplateCard(
              frame,
              renderCard(response.card, cardId, textNoticeUrl),
              [body.from.userid],
            )
            onDiagnostic?.('企微已确认卡片更新')
          } else onDiagnostic?.('企微按钮回调未产生卡片更新')
        } catch (error) {
          events.error(new Error(describeFailure('企微按钮或卡片更新处理失败', error)))
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
          onDiagnostic?.('企微长连接认证成功')
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
      try {
        await client.sendMessage(userId, { msgtype: 'markdown', markdown: { content } })
        onDiagnostic?.('企微已接受私聊文本')
      } catch (error) {
        const message = describeFailure('企微私聊文本发送失败', error)
        onDiagnostic?.(message)
        throw new Error(message)
      }
    },
    async sendCard(userId, card) {
      const taskId = `rcm_${randomUUID()}`
      try {
        await client.sendMessage(userId, {
          msgtype: 'template_card',
          template_card: renderCard(card, taskId, textNoticeUrl),
        })
        onDiagnostic?.('企微已接受审批卡片')
      } catch (error) {
        const message = describeFailure('企微审批卡片发送失败', error)
        onDiagnostic?.(message)
        throw new Error(message)
      }
      return taskId
    },
  }
}
