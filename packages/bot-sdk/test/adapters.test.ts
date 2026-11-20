import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { LarkChannel, type EventMap } from '@larksuite/channel'
import { WSClient, type WsFrame } from '@wecom/aibot-node-sdk'
import { DWClient, TOPIC_CARD, TOPIC_ROBOT, type DWClientDownStream } from 'dingtalk-stream'
import { createAdapter as createFeishuAdapter } from '../src/adapters/feishu/index.js'
import { createAdapter as createWecomAdapter } from '../src/adapters/wecom/index.js'
import { createAdapter as createDingtalkAdapter } from '../src/adapters/dingtalk/index.js'
import { createBot, type ActionEvent, type Card, type TextEvent } from '../src/core/index.js'

const card: Card = { title: '模拟', body: '详情', buttons: [{ id: 'approve', label: '批准' }] }
const done: Card = { title: '模拟', body: '处理完成', buttons: [] }

test('飞书映射单聊、主动消息、原生按钮回调与主动更新', async ({ mock }) => {
  let handlers: Partial<EventMap> = {}
  const clear = mock.fn()
  mock.method(LarkChannel.prototype, 'on', (eventMap: Partial<EventMap>) => {
    handlers = eventMap
    return clear
  })
  mock.method(LarkChannel.prototype, 'connect', async () => undefined)
  mock.method(LarkChannel.prototype, 'disconnect', async () => undefined)
  const send = mock.method(LarkChannel.prototype, 'send', async () => ({ messageId: 'om_test' }))
  const update = mock.method(LarkChannel.prototype, 'updateCard', async () => undefined)
  const errors: string[] = []
  const bot = createBot({
    adapters: [createFeishuAdapter({ id: 'feishu', appId: 'cli_test', appSecret: 'fake' })],
    onError: (_id, error) => errors.push(error.message),
  })
  const texts: TextEvent[] = []
  const actions: ActionEvent[] = []
  bot.onMessage((event) => {
    texts.push(event)
  })
  bot.onAction((event) => {
    actions.push(event)
    if (event.actionId === 'throw') throw new Error('不应从上游透出')
    return { card: done }
  })
  await bot.start()
  const user = { botId: 'feishu', userId: 'ou_user' }
  const row = {
    chatType: 'p2p' as const,
    senderId: user.userId,
    rawContentType: 'text',
    messageId: 'om_in',
    chatId: 'oc_test',
    content: '你好',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: 1,
  }
  await handlers.message?.({ ...row, chatType: 'group' })
  await handlers.message?.(row)
  assert.deepEqual(texts, [{ conversation: user, text: '你好', messageId: 'om_in' }])
  await bot.sendText(user, '回应')
  assert.deepEqual(send.mock.calls[0].arguments, [user.userId, { text: '回应' }])
  const ref = await bot.sendCard(user, card)
  assert.equal(ref.cardId, 'om_test')
  assert.match(JSON.stringify(send.mock.calls[1].arguments), /botSdkAction/)
  const click = {
    messageId: ref.cardId,
    chatId: 'oc_test',
    operator: { openId: 'ou_user' },
    action: { tag: 'button', value: { botSdkAction: 'approve' } },
  }
  assert.equal(
    await handlers.cardAction?.({
      ...click,
      action: { tag: 'select_static', value: click.action.value },
    }),
    undefined,
  )
  assert.match(JSON.stringify(await handlers.cardAction?.(click)), /处理完成/)
  assert.deepEqual(actions, [
    { botId: 'feishu', cardId: ref.cardId, actorId: 'ou_user', actionId: 'approve' },
  ])
  assert.match(
    JSON.stringify(
      await handlers.cardAction?.({
        ...click,
        action: { tag: 'button', value: { botSdkAction: 'throw' } },
      }),
    ),
    /按钮处理失败/,
  )
  assert.deepEqual(errors, ['飞书按钮处理失败'])
  await bot.updateCard(ref, done)
  assert.equal(update.mock.calls.length, 1)
  await bot.stop()
  assert.equal(clear.mock.calls.length, 1)
})

test('企微等待认证、将 task_id 关联到点击并使用原回调帧更新', async ({ mock }) => {
  const connect = mock.method(WSClient.prototype, 'connect', function (this: WSClient) {
    this.emit('authenticated')
    return this
  })
  mock.method(WSClient.prototype, 'disconnect', () => undefined)
  const send = mock.method(WSClient.prototype, 'sendMessage', async () => ({}))
  const update = mock.method(WSClient.prototype, 'updateTemplateCard', async () => ({}))
  const bot = createBot({
    adapters: [createWecomAdapter({ id: 'wecom', botId: 'robot', secret: 'fake' })],
  })
  const texts: TextEvent[] = []
  const actions: ActionEvent[] = []
  bot.onMessage((event) => {
    texts.push(event)
  })
  bot.onAction((event) => {
    actions.push(event)
    return { card: done }
  })
  await bot.start()
  const client = connect.mock.calls[0].this as WSClient
  const user = { botId: 'wecom', userId: 'member' }
  client.emit('message.text', {
    headers: { req_id: 'r1' },
    body: {
      aibotid: 'robot',
      chattype: 'single',
      msgid: 'm1',
      from: { userid: 'member' },
      text: { content: '你好' },
    },
  } as WsFrame as never)
  await bot.sendText(user, '**纯文本**')
  assert.deepEqual(send.mock.calls[0].arguments, [
    'member',
    { msgtype: 'markdown', markdown: { content: '\\*\\*纯文本\\*\\*' } },
  ])
  const body =
    '设备：开发电脑\n工作区：示例\n操作：执行命令\n完整命令：node --version\n工作目录：工作区根目录\n授权范围：仅本次，不会登记到命令列表。'
  const ref = await bot.sendCard(user, { ...card, body })
  assert.deepEqual(send.mock.calls[1].arguments, [
    'member',
    {
      msgtype: 'template_card',
      template_card: {
        card_type: 'button_interaction',
        task_id: ref.cardId,
        main_title: { title: card.title },
        quote_area: { quote_text: body },
        button_list: [{ key: 'approve', text: card.buttons[0].label }],
      },
    },
  ])
  const frame = {
    headers: { req_id: 'r2' },
    body: {
      aibotid: 'robot',
      chattype: 'single',
      from: { userid: 'member' },
      event: { task_id: ref.cardId, event_key: 'approve' },
    },
  }
  client.emit('event.template_card_event', {
    ...frame,
    body: { ...frame.body, chattype: 'group' },
  } as never)
  client.emit('event.template_card_event', frame as never)
  await setImmediate()
  assert.deepEqual(texts, [{ conversation: user, messageId: 'm1', text: '你好' }])
  assert.deepEqual(actions, [
    { botId: 'wecom', cardId: ref.cardId, actorId: 'member', actionId: 'approve' },
  ])
  assert.deepEqual(update.mock.calls[0].arguments, [
    frame,
    {
      card_type: 'text_notice',
      task_id: ref.cardId,
      main_title: { title: '模拟' },
      quote_area: { quote_text: '处理完成' },
    },
    ['member'],
  ])
  await assert.rejects(bot.updateCard(ref, done), /不支持主动更新/)
  await bot.stop()
})

test('钉钉 OpenAPI 主动投放、Stream 点击回执、主动更新和平台拒绝', async ({ mock }) => {
  const connect = mock.method(DWClient.prototype, 'connect', async function (this: DWClient) {
    this.connected = true
  })
  mock.method(DWClient.prototype, 'disconnect', () => undefined)
  const ack = mock.method(DWClient.prototype, 'socketCallBackResponse', () => undefined)
  let textRejected = false
  let cardResponse = () =>
    Response.json({ success: true, result: { deliverResults: [{ success: true }] } })
  const http = mock.method(globalThis, 'fetch', async (url: string, _init?: RequestInit) => {
    if (url.endsWith('/accessToken'))
      return Response.json({ accessToken: 'test-token', expireIn: 7200 })
    if (url.endsWith('/batchSend'))
      return Response.json(
        textRejected ? { invalidStaffIdList: ['member'] } : { processQueryKey: 'ok' },
      )
    return url.endsWith('/createAndDeliver') ? cardResponse() : Response.json({ success: true })
  })
  const bot = createBot({
    adapters: [
      createDingtalkAdapter({
        id: 'ding',
        clientId: 'fake',
        clientSecret: 'fake',
        corpId: 'corp',
        cardTemplateId: 'template',
        robotCode: 'card-robot',
      }),
    ],
  })
  const actions: ActionEvent[] = []
  const texts: TextEvent[] = []
  bot.onMessage((event) => {
    texts.push(event)
  })
  bot.onAction((event) => {
    actions.push(event)
    return { card: done }
  })
  await bot.start()
  const client = connect.mock.calls[0].this as DWClient
  /** 向 Stream 回调注入平台形状的测试帧。 */
  const emit = (topic: string, data: object) =>
    client.emit(topic, {
      headers: { messageId: topic },
      data: JSON.stringify(data),
    } as DWClientDownStream)
  emit(TOPIC_ROBOT, {
    conversationType: '1',
    msgtype: 'text',
    senderCorpId: 'corp',
    senderStaffId: 'member',
    msgId: 'm1',
    text: { content: '你好' },
  })
  const user = { botId: 'ding', userId: 'member' }
  await bot.sendText(user, '回声')
  const ref = await bot.sendCard(user, card)
  const request = JSON.parse(http.mock.calls[2].arguments[1]?.body as string)
  assert.equal(request.openSpaceId, 'dtv1.card//IM_ROBOT.member')
  assert.deepEqual(request.imRobotOpenDeliverModel, {
    spaceType: 'IM_ROBOT',
    robotCode: 'card-robot',
  })
  const callback = {
    spaceType: 'IM_ROBOT',
    corpId: 'corp',
    userId: 'member',
    outTrackId: ref.cardId,
    content: JSON.stringify({ cardPrivateData: { params: { botSdkAction: 'approve' } } }),
  }
  emit(TOPIC_CARD, { ...callback, corpId: 'elsewhere' })
  emit(TOPIC_CARD, callback)
  await setImmediate()
  assert.deepEqual(texts, [{ conversation: user, messageId: 'm1', text: '你好' }])
  assert.deepEqual(actions, [
    { botId: 'ding', cardId: ref.cardId, actorId: 'member', actionId: 'approve' },
  ])
  assert.deepEqual(ack.mock.calls[1].arguments, [TOPIC_CARD, {}])
  assert.match(JSON.stringify(ack.mock.calls[2].arguments), /处理完成/)
  await bot.updateCard(ref, done)
  assert.match(JSON.stringify(http.mock.calls[3].arguments), /PUT/)
  textRejected = true
  await assert.rejects(bot.sendText(user, '不会投递'), /未接受/)
  cardResponse = () =>
    Response.json({
      success: true,
      result: { deliverResults: [{ success: false, errorMsg: 'param.userIdNotExist' }] },
    })
  await assert.rejects(bot.sendCard(user, card), /未确认私聊卡片投递（param.userIdNotExist）/)
  cardResponse = () => Response.json({ success: true })
  await assert.rejects(bot.sendCard(user, card), /未确认私聊卡片投递/)
  cardResponse = () =>
    Response.json({ code: 'param.templateUnpublished', message: '审批正文示例' }, { status: 400 })
  await assert.rejects(
    bot.sendCard(user, card),
    (error: Error) =>
      error.message.includes('HTTP 400，param.templateUnpublished') &&
      !error.message.includes('审批正文示例'),
  )
  await bot.stop()
})
