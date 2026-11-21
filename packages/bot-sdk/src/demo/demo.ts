import { BotPlatformError, createBot, type BotAdapter, type Conversation } from '../core/index.js'
import { defaultCard, type Card } from '../core/capabilities/cards/index.js'
import { demoSelection } from './selection.js'

/** 读取必填环境变量；错误只包含变量名。 */
export function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`缺少环境变量 ${name}`)
  return value
}

/** 为指定测试用户或群发送通用双按钮卡，仅由指定测试用户点击后展示结果。 */
export async function runDemo(
  adapter: BotAdapter,
  options?: {
    /** 演示卡片的多行详情。 */
    details?: string
    /** 只打印可公开的启动错误；返回是否已处理。 */
    onStartupError?: (error: Error) => boolean
  },
) {
  const userId = required('BOT_DEMO_USER_ID')
  const chatId = process.env.BOT_DEMO_CHAT_ID
  const to: Conversation = chatId
    ? { botId: adapter.id, type: 'group', chatId }
    : { botId: adapter.id, userId }
  const bot = createBot({
    adapter,
    onError: (error) => {
      // 平台拒绝回调更新时也标记演示失败，不能仅凭业务处理日志或退出码 0 验收。
      process.exitCode = 1
      console.error(`演示失败：${error.message}`)
    },
  })
  const text = bot.messages
  const cards = bot.cards
  const card: Card = {
    ...defaultCard,
    body: options?.details ?? defaultCard.body,
  }

  text.onMessage(async (event) => {
    if (
      event.actorId === userId &&
      (chatId
        ? event.conversation.type === 'group' && event.conversation.chatId === chatId
        : event.conversation.type !== 'group')
    )
      await text.send(event.conversation, `收到：${event.text}`)
  })

  try {
    await bot.start()
    const ref = await cards.send(to, card)
    const select = demoSelection(adapter.id, userId, ref.cardId, Date.now() + 300_000)
    // 按钮事件由业务注册：先核验卡片和点击者，再把通用选择结果写回原卡。
    cards.onAction(async (event) => {
      console.log('演示已收到卡片按钮事件，正在核验点击者、卡片和动作。')
      const state = select(event)
      if (!state) {
        console.log('演示忽略未通过核验的按钮事件。')
        return
      }
      const status =
        state === 'expired'
          ? '卡片已过期'
          : `已选择${card.buttons.find((button) => button.id === state)!.label}`
      console.log(`演示按钮已处理：${status}`)
      const updated = {
        title: card.title,
        body: options?.details ? `状态：${status}\n\n${card.body}` : status,
        buttons: [],
      }
      const settlement = await event.update(updated)
      console.log(
        settlement === 'updated'
          ? '平台已确认主动更新原卡。'
          : settlement === 'accepted'
            ? '结果已交付点击回调，等待平台更新回执。'
            : '原卡更新不可用，请检查平台回调窗口。',
      )
    })
    console.log('通用演示卡已发送；可在目标会话发送文字测试回声，按 Ctrl+C 停止。')
  } catch (error) {
    await bot.stop().catch(() => undefined)
    // 仅由平台入口提取可公开的错误，避免 Node 默认打印原始异常链。
    if (error instanceof Error && options?.onStartupError?.(error)) {
      process.exitCode = 1
      return
    }
    throw new BotPlatformError('演示启动或发卡失败，请检查凭证、接收人、平台权限及卡片模板。')
  }

  /** 关闭连接时不打印上游 SDK 的原始错误。 */
  function shutdown() {
    process.off('SIGINT', shutdown)
    process.off('SIGTERM', shutdown)
    void bot.stop().catch(() => {
      process.exitCode = 1
      console.error('关闭机器人失败')
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
