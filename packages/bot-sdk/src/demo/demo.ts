import { createBot, type BotAdapter, type Card } from '../core/index.js'
import { demoDecision } from './decision.js'

/** 读取必填环境变量；错误只包含变量名。 */
export function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`缺少环境变量 ${name}`)
  return value
}

/** 为指定测试用户发模拟审批卡，并按平台选择是否同步发一条详情文本。 */
export async function runDemo(
  adapter: BotAdapter,
  options?: {
    /** 测试用多行详情；提供时先私发文本，再发送同样正文的卡片。 */
    details?: string
    /** 数组首项是否为批准；用于左侧绑定第二个变量槽的钉钉模板。 */
    approveFirst?: boolean
    /** 只打印可公开的启动错误；返回是否已处理。 */
    onStartupError?: (error: Error) => boolean
  },
) {
  const userId = required('BOT_DEMO_USER_ID')
  const to = { botId: adapter.id, userId }
  const bot = createBot({
    adapters: [adapter],
    onError: (_botId, error) => console.error(error.message),
  })
  const capabilities = bot.capabilities(adapter.id)
  const approve = { id: 'approve', label: '批准', style: 'primary' } as const
  const deny = { id: 'deny', label: '拒绝', style: 'secondary' } as const
  const card: Card = {
    title: '模拟审批',
    body: options?.details ?? '测试卡片，不会执行文件或命令操作。五分钟后失效。',
    buttons: options?.approveFirst ? [approve, deny] : [deny, approve],
  }

  bot.onMessage(async (event) => {
    if (event.conversation.userId === userId)
      await bot.sendText(event.conversation, `收到：${event.text}`)
  })

  try {
    await bot.start()
    if (options?.details) await bot.sendText(to, card.body)
    const ref = await bot.sendCard(to, card)
    const decide = demoDecision(adapter.id, userId, ref.cardId, Date.now() + 300_000)
    bot.onAction(async (event) => {
      const state = decide(event)
      if (!state) return
      const status = { approved: '已批准', rejected: '已拒绝', expired: '已过期' }[state]
      console.log(`模拟审批按钮已处理：${status}`)
      const updated = {
        title: card.title,
        body: options?.details ? `状态：${status}\n\n${card.body}` : status,
        buttons: [],
      }
      if (capabilities.callbackCardUpdate) return { card: updated }
      if (capabilities.proactiveCardUpdate) await bot.updateCard(ref, updated)
    })
    console.log('模拟审批卡已发送；可在私聊发送文字测试回声，按 Ctrl+C 停止。')
  } catch (error) {
    await bot.stop().catch(() => undefined)
    // 仅由平台入口提取可公开的错误，避免 Node 默认打印原始异常链。
    if (error instanceof Error && options?.onStartupError?.(error)) {
      process.exitCode = 1
      return
    }
    throw new Error('演示启动或发卡失败，请检查凭证、接收人、平台权限及卡片模板。')
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
