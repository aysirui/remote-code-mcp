import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBot, type AdapterEvents, type BotAdapter, type Card } from '../src/core/index.js'

const card: Card = { title: '测试', body: '正文', buttons: [{ id: 'ok', label: '确定' }] }

/** 创建可观察路由与启停的测试适配器。 */
function fake(id: string, lifecycle: string[] = []) {
  let events: AdapterEvents | undefined
  const calls: object[] = []
  const adapter: BotAdapter = {
    id,
    callbackCardUpdate: false,
    async start(sink) {
      events = sink
      lifecycle.push(`start:${id}`)
    },
    async stop() {
      lifecycle.push(`stop:${id}`)
    },
    async sendText(userId, text) {
      calls.push({ userId, text })
    },
    async sendCard(userId, card) {
      calls.push({ userId, card })
      return 'same-platform-id'
    },
    async updateCard(ref, card) {
      calls.push({ ref, card })
    },
  }
  return { adapter, calls, events: () => events! }
}

test('实例路由与卡片引用隔离，不接受伪造、跨 Bot 或错误实例事件', async () => {
  const alpha = fake('alpha')
  const beta = fake('beta')
  const bot = createBot({ adapters: [alpha.adapter, beta.adapter] })
  const user = { botId: 'alpha', userId: 'user' }
  await assert.rejects(bot.sendText(user, '文字'), /尚未启动/)
  assert.throws(() => createBot({ adapters: [alpha.adapter, alpha.adapter] }), /重复/)
  await bot.start()
  const ref = await bot.sendCard(user, card)
  await bot.updateCard(ref, card)
  await assert.rejects(bot.updateCard({ ...ref, botId: 'beta' }, card), /不属于/)
  const separate = createBot({ adapters: [fake('alpha').adapter] })
  await assert.rejects(separate.updateCard(ref, card), /不属于/)
  assert.deepEqual(alpha.calls, [
    { userId: 'user', card },
    { ref, card },
  ])
  assert.deepEqual(beta.calls, [])
  const observed: string[] = []
  const unsubscribe = bot.onMessage(({ text }) => {
    observed.push(text)
  })
  await beta.events().message({ conversation: user, text: '错误来源', messageId: 'other' })
  await alpha.events().message({ conversation: user, text: '正确来源', messageId: 'first' })
  unsubscribe()
  await alpha.events().message({ conversation: user, text: '已取消订阅', messageId: 'second' })
  assert.deepEqual(observed, ['正确来源'])
  await bot.stop()
})

test('部分启动失败清理已尝试连接；可以再次启动，并发启停不会重复连接', async () => {
  const lifecycle: string[] = []
  const first = fake('first', lifecycle).adapter
  const second = fake('second', lifecycle).adapter
  const startSecond = second.start
  second.start = async () => {
    throw new Error('认证失败')
  }
  const bot = createBot({ adapters: [first, second] })
  await assert.rejects(bot.start(), /认证失败/)
  assert.deepEqual(lifecycle, ['start:first', 'stop:first', 'stop:second'])
  second.start = startSecond
  await Promise.all([bot.start(), bot.start(), bot.stop(), bot.stop()])
  assert.deepEqual(lifecycle.slice(3), ['start:first', 'start:second', 'stop:first', 'stop:second'])
})

test('主动更新和点击内更新分别检查能力', async () => {
  const { adapter, events } = fake('bot')
  delete adapter.updateCard
  const bot = createBot({ adapters: [adapter] })
  assert.deepEqual(bot.capabilities('bot'), {
    proactiveCardUpdate: false,
    callbackCardUpdate: false,
  })
  await bot.start()
  const ref = await bot.sendCard({ botId: 'bot', userId: 'user' }, card)
  await assert.rejects(bot.updateCard(ref, card), /不支持主动更新/)
  bot.onAction(() => ({ card }))
  await assert.rejects(
    events().action({ botId: 'bot', cardId: ref.cardId, actorId: 'user', actionId: 'ok' }),
    /不支持在点击回调内/,
  )
  await bot.stop()
})
