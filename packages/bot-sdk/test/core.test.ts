import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import {
  createBot,
  BotManager,
  UnsupportedCapabilityError,
  type Capability,
  type CapabilityContext,
} from '../src/core/index.js'
import {
  CardCapability,
  cardAdapter as cardKey,
  type CardConnection,
  type Card,
  type CardAdapter,
  type CardAdapterEvents,
} from '../src/core/capabilities/cards/index.js'
import {
  textAdapter as textKey,
  TextCapability,
  type TextConnection,
  type TextAdapter,
  type TextAdapterEvents,
} from '../src/core/capabilities/text/index.js'

const card: Card = { title: '测试', body: '正文', buttons: [{ id: 'ok', label: '确定' }] }

/** 创建可观察路由与启停的测试适配器。 */
function fake(id: string, lifecycle: string[] = []) {
  let textEvents!: TextAdapterEvents
  let cardEvents!: CardAdapterEvents
  const calls: object[] = []
  const adapter: TextConnection & CardConnection = {
    id,
    async start() {
      lifecycle.push(`start:${id}`)
    },
    async stop() {
      lifecycle.push(`stop:${id}`)
    },
  }
  const textAdapter: TextAdapter = {
    connection: adapter,
    async start(sink) {
      textEvents = sink
    },
    async stop() {},
    async send(to, text) {
      const userId = to.type === 'group' ? to.chatId : to.userId
      calls.push({ userId, text })
    },
  }
  const cardAdapter: CardAdapter = {
    connection: adapter,
    async start(sink) {
      cardEvents = sink
    },
    async stop() {},
    async send(to, card) {
      const userId = to.type === 'group' ? to.chatId : to.userId
      calls.push({ userId, card })
      return 'same-platform-id'
    },
    async update(ref, card) {
      calls.push({ ref, card })
    },
  }
  adapter[textKey] = () => textAdapter
  adapter[cardKey] = () => cardAdapter
  return {
    adapter,
    textAdapter,
    cardAdapter,
    calls,
    textEvents: () => textEvents,
    cardEvents: () => cardEvents,
  }
}

test('实例路由与卡片引用隔离，不接受伪造、跨 Bot 或错误实例事件', async () => {
  const alpha = fake('alpha')
  const beta = fake('beta')
  const bot = createBot({ adapter: alpha.adapter })
  const betaBot = createBot({ adapter: beta.adapter })
  betaBot.install(new TextCapability())
  const manager = new BotManager({ bots: [bot, betaBot] })
  const text = bot.install(new TextCapability())
  const cards = bot.install(new CardCapability())
  const user = { botId: 'alpha', userId: 'user' }
  await assert.rejects(text.send(user, '文字'), /尚未启动/)
  assert.throws(() => new BotManager({ bots: [bot, bot] }), /重复/)
  await manager.start()
  const ref = await cards.send(user, card)
  await cards.update(ref, card)
  await cards.settle(ref, card, {
    resultText: async () => assert.fail('支持主动更新时无需发送结算文本'),
  })
  await assert.rejects(cards.update({ ...ref, botId: 'beta' }, card), /不属于/)
  const foreign = fake('alpha')
  const separate = createBot({ adapter: foreign.adapter })
  const separateCards = separate.install(new CardCapability())
  await assert.rejects(separateCards.update(ref, card), /不属于/)
  assert.deepEqual(alpha.calls, [
    { userId: 'user', card },
    { ref, card },
    { ref, card },
  ])
  assert.deepEqual(beta.calls, [])
  const observed: string[] = []
  const unsubscribe = text.onMessage(({ text }) => {
    observed.push(text)
  })
  await assert.rejects(text.send({ ...user, botId: 'beta' }, '错误连接'), /不属于/)
  await alpha.textEvents().message({
    actorId: 'user',
    conversation: { ...user, botId: 'beta' },
    text: '错误来源',
    messageId: 'other',
  })
  await alpha
    .textEvents()
    .message({ actorId: 'user', conversation: user, text: '正确来源', messageId: 'first' })
  unsubscribe()
  await alpha
    .textEvents()
    .message({ actorId: 'user', conversation: user, text: '已取消订阅', messageId: 'second' })
  assert.deepEqual(observed, ['正确来源'])
  await manager.stop()
})

test('部分启动失败清理已尝试连接；可以再次启动，并发启停不会重复连接', async () => {
  const lifecycle: string[] = []
  const { adapter: first, textAdapter } = fake('first', lifecycle)
  const startFirst = first.start
  first.start = async () => {
    throw new Error('认证失败')
  }
  const bot = createBot({ adapter: first })
  first[textKey] = () => ({
    ...textAdapter,
    async start(events) {
      lifecycle.push('subscribe:text')
      await textAdapter.start(events)
    },
    async stop() {
      lifecycle.push('unsubscribe:text')
    },
  })
  bot.install(new TextCapability())
  await assert.rejects(bot.start(), /认证失败/)
  assert.deepEqual(lifecycle, ['subscribe:text', 'stop:first', 'unsubscribe:text'])
  first.start = startFirst
  await Promise.all([bot.start(), bot.start(), bot.stop(), bot.stop()])
  assert.deepEqual(lifecycle.slice(3), [
    'subscribe:text',
    'start:first',
    'stop:first',
    'unsubscribe:text',
  ])
})

test('主动更新和点击内更新分别检查能力', async () => {
  const { adapter, cardAdapter, cardEvents } = fake('bot')
  const bot = createBot({ adapter })
  adapter[cardKey] = () => ({ ...cardAdapter, update: undefined })
  const cards = bot.install(new CardCapability())
  assert.deepEqual(cards.capabilities(), {
    proactiveCardUpdate: false,
    callbackCardUpdate: false,
  })
  await bot.start()
  const ref = await cards.send({ botId: 'bot', userId: 'user' }, card)
  await assert.rejects(cards.update(ref, card), { capability: 'cards.update' })
  cards.onAction(() => ({ card }))
  await assert.rejects(
    cardEvents().action({ botId: 'bot', cardId: ref.cardId, actorId: 'user', actionId: 'ok' }),
    { capability: 'cards.respond' },
  )
  await bot.stop()
})

test('回调渠道有更新窗口时不重复通知，窗口不可用时补发文本', async () => {
  const { adapter, calls, cardEvents, cardAdapter } = fake('bot')
  const bot = createBot({ adapter })
  const text = bot.install(new TextCapability())
  adapter[cardKey] = () => ({
    ...cardAdapter,
    update: undefined,
    callbackUpdate: true,
    callbackUpdateWaitMs: 50,
  })
  const cards = bot.install(
    new CardCapability({ sendText: (to, message) => text.send(to, message) }),
  )
  await bot.start()
  const ref = await cards.send({ botId: 'bot', userId: 'user' }, card)
  const event = { botId: 'bot', cardId: ref.cardId, actorId: 'user', actionId: 'ok' }
  const result: Card = { title: '已完成', body: card.body, buttons: [] }
  let shouldCancel = false
  cards.onAction(({ deferCardUpdate }) => {
    const cancel = deferCardUpdate?.()
    if (shouldCancel) cancel?.()
  })
  const waiting = cardEvents().action(event)
  await assert.rejects(cards.settle({ ...ref }, result), /不属于/)
  assert.equal(
    await cards.settle(ref, result, {
      resultText: async () => assert.fail('已交付原卡更新时不应补发文本'),
    }),
    'callback',
  )
  assert.deepEqual(await waiting, { card: result })
  assert.equal(await cardEvents().action(event), undefined)
  shouldCancel = true
  const cancelled = cardEvents().action(event)
  assert.equal(
    await cards.settle(ref, result, { resultText: async () => '审批已拒绝' }),
    'unavailable',
  )
  assert.equal(await cancelled, undefined)
  assert.deepEqual(calls, [
    { userId: 'user', card },
    { userId: 'user', text: '审批已拒绝' },
  ])
  await bot.stop()
})

test('仅安装文本时正常收发；第三方能力可独立安装并参与启停', async () => {
  const { adapter, calls, textAdapter } = fake('text-only')
  adapter[cardKey] = undefined
  const bot = createBot({ adapter })
  const text = bot.install(new TextCapability())
  const to = { botId: adapter.id, userId: 'user' }
  assert.throws(() => bot.install(new TextCapability()), /重复/)
  const foreignConnection: TextConnection = { ...adapter, [textKey]: () => textAdapter }
  assert.throws(
    () => createBot({ adapter: foreignConnection }).install(new TextCapability()),
    /不属于/,
  )
  const lifecycle: string[] = []
  class StatusCapability implements Capability {
    readonly id = 'status'
    private context?: CapabilityContext
    attach(context: CapabilityContext) {
      this.context = context
    }
    async start() {
      lifecycle.push('开始监听')
    }
    async stop() {
      lifecycle.push('停止监听')
    }
    online() {
      return this.context?.running
    }
  }
  const status = bot.install(new StatusCapability())
  assert.equal(status.online(), false)
  await bot.start()
  assert.equal(status.online(), true)
  assert.throws(() => bot.install(new CardCapability()), /启动前/)
  await text.send(to, '普通消息')
  assert.deepEqual(calls, [{ userId: 'user', text: '普通消息' }])
  await bot.stop()
  assert.equal(status.online(), false)
  assert.deepEqual(lifecycle, ['开始监听', '停止监听'])
  const cards = bot.install(new CardCapability())
  await bot.start()
  await assert.rejects(cards.send(to, card), UnsupportedCapabilityError)
  await bot.stop()
})

test('Telegram 内联键盘与会话内消息 ID 可映射到同一套卡片能力', async () => {
  const messages = new Map<
    string,
    {
      text: string
      reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] }
    }
  >()
  let events!: CardAdapterEvents
  // Telegram 的消息 ID 在会话内唯一，适配器用会话与原生消息 ID 定位同一张卡。
  const adapter: CardConnection = {
    id: 'telegram',
    async start() {},
    async stop() {},
  }
  const cardAdapter: CardAdapter = {
    connection: adapter,
    async start(sink) {
      events = sink
    },
    async stop() {},
    async send(to, card) {
      const chatId = to.type === 'group' ? to.chatId : to.userId
      const key = JSON.stringify([chatId, 1])
      messages.set(key, {
        text: `${card.title}\n${card.body}`,
        reply_markup: {
          inline_keyboard: [
            card.buttons
              .filter(({ visible }) => visible !== false)
              .map(({ id, label }) => ({
                text: label,
                callback_data: id,
              })),
          ],
        },
      })
      return key
    },
    async update(ref, card) {
      messages.set(ref.cardId, {
        text: `${card.title}\n${card.body}`,
        reply_markup: { inline_keyboard: [] },
      })
    },
  }
  const bot = createBot({ adapter })
  adapter[cardKey] = () => cardAdapter
  const cards = bot.install(new CardCapability())
  await bot.start()
  const ref = await cards.send({ botId: adapter.id, userId: '101' }, card)
  const other = await cards.send({ botId: adapter.id, userId: '202' }, card)
  const action = messages.get(ref.cardId)?.reply_markup.inline_keyboard[0][0]
  assert.deepEqual(action, { text: '确定', callback_data: 'ok' })
  cards.onAction(async ({ cardId, actorId, actionId }) => {
    if (
      cardId === ref.cardId &&
      ref.type !== 'group' &&
      actorId === ref.userId &&
      actionId === 'ok'
    )
      assert.equal(await cards.settle(ref, { ...card, title: '完成', buttons: [] }), 'updated')
  })
  await events.action({
    botId: adapter.id,
    cardId: ref.cardId,
    actorId: '101',
    actionId: action!.callback_data,
  })
  assert.equal(messages.get(ref.cardId)?.text, '完成\n正文')
  assert.equal(messages.get(other.cardId)?.text, '测试\n正文')
  await bot.stop()
})

test('管理器并行启动多个机器人，首连失败时独立重试并在关闭后停止', async () => {
  const ready = fake('ready')
  const retry = fake('retry')
  let canConnect = false
  let attempts = 0
  retry.adapter.start = async () => {
    attempts++
    if (!canConnect) throw new Error('认证暂不可用')
  }
  const firstBot = createBot({ adapter: ready.adapter })
  const retryBot = createBot({ adapter: retry.adapter })
  const manager = new BotManager({ bots: [firstBot, retryBot], retryAfterMs: 20 })
  const textByBot = manager.install(() => new TextCapability())
  const cardsByBot = manager.install(() => new CardCapability())
  const firstText = textByBot.get('ready')!
  const retryText = textByBot.get('retry')!
  const firstCards = cardsByBot.get('ready')!
  const retryCards = cardsByBot.get('retry')!
  assert.notEqual(firstText, retryText)
  assert.notEqual(firstCards, retryCards)
  const startup = manager.start()
  assert.throws(() => manager.install(() => new TextCapability()), /启动前/)
  await startup
  assert.equal(manager.get('ready')?.isConnected(), true)
  assert.equal(manager.get('retry')?.isConnected(), false)
  await firstText.send('member', '正常连接可用')
  await firstCards.send('member', card)
  await assert.rejects(retryText.send('member', '认证完成前不可发送'), /尚未启动/)
  canConnect = true
  try {
    await setTimeout(35)
    await retryText.send('member', '重试后复用文本能力')
    await retryCards.send('member', card)
    assert.equal(attempts, 2)
    assert.deepEqual(ready.calls, [
      { userId: 'member', text: '正常连接可用' },
      { userId: 'member', card },
    ])
    assert.deepEqual(retry.calls, [
      { userId: 'member', text: '重试后复用文本能力' },
      { userId: 'member', card },
    ])
    canConnect = false
    await manager.stop()
    await manager.start()
    await manager.stop()
    await setTimeout(40)
    assert.equal(attempts, 3)
  } finally {
    await manager.stop()
  }
})

test('批量安装失败时可修正工厂后重试，已登记能力不会被部分修改', () => {
  const first = createBot({ adapter: fake('first').adapter })
  const second = createBot({ adapter: fake('second').adapter })
  const manager = new BotManager({ bots: [first, second] })
  const shared = new TextCapability()
  assert.throws(() => manager.install(() => shared), /独立/)
  assert.throws(
    () =>
      manager.install((bot) => {
        if (bot !== second) return new TextCapability()
        throw new Error('第二个机器人配置有误')
      }),
    /配置有误/,
  )
  second.install(new TextCapability())
  assert.throws(() => manager.install(() => new TextCapability()), /重复/)
  first.install(new TextCapability())
  assert.equal(manager.install(() => new CardCapability()).size, 2)
})
