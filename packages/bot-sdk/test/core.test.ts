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
  const cards = bot.cards
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

test('统一 API 自动收发、回复原群并支持多个按钮订阅，原生客户端保持具体类型和同一实例', async () => {
  const state = fake('unified')
  const native = { platformMethod: () => 'native-result' }
  const adapter = Object.assign(state.adapter, { native })
  const bot = createBot({ adapter })
  assert.equal(bot.native, native)
  assert.equal(bot.native.platformMethod(), 'native-result')
  const observed: string[] = []
  const unsubscribe = bot.cards.onAction(async (event) => {
    observed.push(event.actionId)
    assert.equal('deferCardUpdate' in event, false)
    assert.equal(await event.update({ ...card, buttons: [] }), 'updated')
  })
  const unsubscribeOther = bot.cards.onAction(() => {
    observed.push('other')
  })
  bot.messages.onMessage(async (event) => {
    await event.reply('群回复')
  })
  await bot.start()
  const group = { type: 'group' as const, chatId: 'room' }
  const ref = await bot.cards.send(group, card)
  await state.textEvents().message({
    conversation: { botId: 'unified', ...group },
    actorId: 'member',
    messageId: 'message',
    text: '你好',
  })
  await state
    .cardEvents()
    .action({ botId: bot.id, cardId: ref.cardId, actorId: 'member', actionId: 'ok' })
  assert.deepEqual(observed, ['ok', 'other'])
  unsubscribe()
  unsubscribeOther()
  await state
    .cardEvents()
    .action({ botId: bot.id, cardId: ref.cardId, actorId: 'member', actionId: 'ignored' })
  assert.deepEqual(observed, ['ok', 'other'])
  assert.deepEqual(state.calls, [
    { userId: 'room', card },
    { userId: 'room', text: '群回复' },
    { ref, card: { ...card, buttons: [] } },
  ])
  await assert.rejects(
    bot.messages.send({ botId: 'foreign', userId: 'user' }, '拒绝跨 Bot'),
    /不属于/,
  )
  await bot.stop()
})

test('统一更新自动使用回调窗口，窗口失效返回 unavailable，不隐式补发文本', async () => {
  const state = fake('callback')
  state.adapter[cardKey] = () => ({
    ...state.cardAdapter,
    update: undefined,
    callbackUpdate: true,
    callbackUpdateWaitMs: 50,
  })
  const bot = createBot({ adapter: state.adapter })
  const finished = { ...card, buttons: [] }
  bot.cards.onAction(async (event) => {
    assert.equal(await event.update(finished), 'accepted')
  })
  await bot.start()
  const ref = await bot.cards.send({ userId: 'user' }, card)
  assert.deepEqual(
    await state
      .cardEvents()
      .action({ botId: bot.id, cardId: ref.cardId, actorId: 'user', actionId: 'ok' }),
    { card: finished },
  )
  assert.equal(await bot.cards.update(ref, finished), 'unavailable')
  assert.deepEqual(state.calls, [{ userId: 'user', card }])
  await bot.stop()
})

test('统一更新不吞掉平台请求失败，也不自动发送第二张卡或文本', async () => {
  const state = fake('failure')
  state.cardAdapter.update = async () => {
    throw new Error('平台拒绝更新')
  }
  const bot = createBot({ adapter: state.adapter })
  await bot.start()
  const ref = await bot.cards.send('user', card)
  await assert.rejects(bot.cards.update(ref, card), /平台拒绝更新/)
  assert.deepEqual(state.calls, [{ userId: 'user', card }])
  await bot.stop()
})

test('BotManager 一次订阅汇聚各 Bot 事件，统一发送更新保持实例隔离，取消和重启不重复绑定', async () => {
  const alpha = fake('alpha')
  const beta = fake('beta')
  const manager = new BotManager({
    bots: [createBot({ adapter: alpha.adapter }), createBot({ adapter: beta.adapter })],
  })
  const messages: string[] = []
  const actions: string[] = []
  const unsubscribeMessage = manager.messages.onMessage(async (event) => {
    messages.push(event.conversation.botId)
    await event.reply('原会话回复')
  })
  const unsubscribeAction = manager.cards.onAction(async (event) => {
    actions.push(event.botId)
    assert.equal(await event.update({ ...card, buttons: [] }), 'updated')
  })
  const otherMessages: string[] = []
  manager.messages.onMessage((event) => {
    otherMessages.push(event.conversation.botId)
  })
  await assert.rejects(
    manager.messages.send({ botId: 'alpha', userId: 'user' }, '尚未连接'),
    /尚未启动/,
  )
  await manager.start()
  const alphaTarget = { botId: 'alpha', userId: 'same-user' }
  const betaTarget = { botId: 'beta', type: 'group' as const, chatId: 'group' }
  await manager.messages.send(alphaTarget, '仅 alpha')
  const alphaRef = await manager.cards.send(alphaTarget, card)
  const betaRef = await manager.cards.send(betaTarget, card)
  // 平台可以返回相同卡片 ID；仍按所属 Bot 的原始引用路由，不能混淆。
  assert.equal(alphaRef.cardId, betaRef.cardId)
  await alpha
    .textEvents()
    .message({ conversation: alphaTarget, actorId: 'same-user', messageId: 'a', text: '文字' })
  await beta
    .textEvents()
    .message({ conversation: betaTarget, actorId: 'member', messageId: 'b', text: '群文字' })
  await alpha
    .cardEvents()
    .action({ botId: 'alpha', cardId: alphaRef.cardId, actorId: 'same-user', actionId: 'ok' })
  await beta
    .cardEvents()
    .action({ botId: 'beta', cardId: betaRef.cardId, actorId: 'member', actionId: 'ok' })
  await manager.cards.update(alphaRef, card)
  assert.deepEqual(messages, ['alpha', 'beta'])
  assert.deepEqual(actions, ['alpha', 'beta'])
  assert.deepEqual(alpha.calls, [
    { userId: 'same-user', text: '仅 alpha' },
    { userId: 'same-user', card },
    { userId: 'same-user', text: '原会话回复' },
    { ref: alphaRef, card: { ...card, buttons: [] } },
    { ref: alphaRef, card },
  ])
  assert.deepEqual(beta.calls, [
    { userId: 'group', card },
    { userId: 'group', text: '原会话回复' },
    { ref: betaRef, card: { ...card, buttons: [] } },
  ])
  await assert.rejects(manager.cards.update({ ...alphaRef, botId: 'beta' }, card), /不属于/)
  await assert.rejects(
    manager.messages.send({ botId: 'missing', userId: 'user' }, '不猜测平台'),
    /未登记/,
  )
  await assert.rejects(manager.cards.send({ botId: 'missing', userId: 'user' }, card), /未登记/)
  await manager.stop()
  await manager.start()
  await alpha.textEvents().message({
    conversation: alphaTarget,
    actorId: 'same-user',
    messageId: 'restart',
    text: '重启',
  })
  assert.deepEqual(messages, ['alpha', 'beta', 'alpha'])
  unsubscribeMessage()
  unsubscribeAction()
  await beta.textEvents().message({
    conversation: betaTarget,
    actorId: 'member',
    messageId: 'unsubscribed',
    text: '取消后',
  })
  await beta
    .cardEvents()
    .action({ botId: 'beta', cardId: betaRef.cardId, actorId: 'member', actionId: 'ok' })
  assert.deepEqual(messages, ['alpha', 'beta', 'alpha'])
  assert.deepEqual(actions, ['alpha', 'beta'])
  assert.deepEqual(otherMessages, ['alpha', 'beta', 'alpha', 'beta'])
  await manager.stop()
})

test('BotManager 按钮汇聚保留原平台的回调更新窗口', async () => {
  const state = fake('callback')
  state.adapter[cardKey] = () => ({
    ...state.cardAdapter,
    update: undefined,
    callbackUpdate: true,
    callbackUpdateWaitMs: 50,
  })
  const manager = new BotManager({ bots: [createBot({ adapter: state.adapter })] })
  const finished = { ...card, buttons: [] }
  manager.cards.onAction(async (event) => {
    assert.equal(event.botId, 'callback')
    assert.equal(await manager.cards.update(reference, finished), 'accepted')
  })
  await manager.start()
  const reference = await manager.cards.send({ botId: 'callback', userId: 'user' }, card)
  assert.deepEqual(
    await state
      .cardEvents()
      .action({ botId: 'callback', cardId: reference.cardId, actorId: 'user', actionId: 'ok' }),
    { card: finished },
  )
  assert.equal(await manager.cards.update(reference, finished), 'unavailable')
  assert.deepEqual(state.calls, [{ userId: 'user', card }])
  await manager.stop()
})
