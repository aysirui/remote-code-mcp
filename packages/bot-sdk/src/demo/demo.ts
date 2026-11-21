import { BotPlatformError, createBot, type BotAdapter } from '../core/index.js'
import { defaultCard, type Card, type CardOptions } from '../core/capabilities/cards/index.js'
import { TextCapability } from '../core/capabilities/text/index.js'
import { demoSelection } from './selection.js'

/** 读取必填环境变量；错误只包含变量名。 */
export function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`缺少环境变量 ${name}`)
  return value
}

/** 为指定测试用户发送通用双按钮卡，点击后展示所选按钮。 */
export async function runDemo(
  adapter: BotAdapter,
  options?: {
    /** 此演示使用的卡片配置。 */
    cardOptions?: CardOptions
    /** 演示卡片的多行详情。 */
    details?: string
    /** 只打印可公开的启动错误；返回是否已处理。 */
    onStartupError?: (error: Error) => boolean
  },
) {
  const userId = required('BOT_DEMO_USER_ID')
  const to = { botId: adapter.id, userId }
  const bot = createBot({
    adapter,
    onError: (error) => console.error(error.message),
  })
  const { CardCapability } = await import('../core/capabilities/cards/index.js')
  const text = bot.install(new TextCapability())
  const cardCapability = bot.install(new CardCapability())
  const cards = options?.cardOptions
    ? cardCapability.withOptions(options.cardOptions)
    : cardCapability
  const card: Card = {
    ...defaultCard,
    body: options?.details ?? defaultCard.body,
  }

  text.onMessage(async (event) => {
    if (event.conversation.userId === userId)
      await text.send(event.conversation, `收到：${event.text}`)
  })

  try {
    await bot.start()
    const ref = await cards.send(to, card)
    const select = demoSelection(adapter.id, userId, ref.cardId, Date.now() + 300_000)
    cards.onAction(async (event) => {
      const state = select(event)
      if (!state) return
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
      event.deferCardUpdate?.()
      await cards.settle(ref, updated)
    })
    console.log('通用演示卡已发送；可在私聊发送文字测试回声，按 Ctrl+C 停止。')
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
