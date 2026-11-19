import { createBot, type BotAdapter, type Card } from '../core/index.js'
import { demoDecision } from './decision.js'

/** 读取必填环境变量；错误只包含变量名。 */
export function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`缺少环境变量 ${name}`)
  return value
}

/** 为指定测试用户启动回声机器人，并主动发送一张模拟审批卡。 */
export async function runDemo(adapter: BotAdapter) {
  const userId = required('BOT_DEMO_USER_ID')
  const to = { botId: adapter.id, userId }
  const bot = createBot({
    adapters: [adapter],
    onError: (_botId, error) => console.error(error.message),
  })
  const capabilities = bot.capabilities(adapter.id)
  const card: Card = {
    title: '模拟审批',
    body: '测试卡片，不会执行文件或命令操作。五分钟后失效。',
    buttons: [
      { id: 'approve', label: '批准' },
      { id: 'reject', label: '拒绝' },
    ],
  }

  bot.onMessage(async (event) => {
    if (event.conversation.userId === userId)
      await bot.sendText(event.conversation, `收到：${event.text}`)
  })

  try {
    await bot.start()
    const ref = await bot.sendCard(to, card)
    const decide = demoDecision(adapter.id, userId, ref.cardId, Date.now() + 300_000)
    bot.onAction(async (event) => {
      const state = decide(event)
      if (!state) return
      const status = { approved: '已批准', rejected: '已拒绝', expired: '已过期' }[state]
      const updated = { title: '模拟审批', body: status, buttons: [] }
      if (capabilities.callbackCardUpdate) return { card: updated }
      if (capabilities.proactiveCardUpdate) await bot.updateCard(ref, updated)
    })
    console.log('模拟审批卡已发送；可在私聊发送文字测试回声，按 Ctrl+C 停止。')
  } catch {
    await bot.stop().catch(() => undefined)
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
