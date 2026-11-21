import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { LarkChannel, type EventMap } from '@larksuite/channel'
import { WSClient, type WsFrame, type TemplateCard } from '@wecom/aibot-node-sdk'
import { DWClient, TOPIC_CARD, TOPIC_ROBOT, type DWClientDownStream } from 'dingtalk-stream'
import { createAdapter as createFeishuAdapter } from '../src/adapters/feishu/index.js'
import { createAdapter as createWecomAdapter } from '../src/adapters/wecom/index.js'
import {
  createAdapter as createDingtalkAdapter,
  type DingtalkCardOptions,
} from '../src/adapters/dingtalk/index.js'
import { BotConfigurationError, createBot } from '../src/core/index.js'
import {
  CardCapability,
  type ActionEvent,
  type Card,
} from '../src/core/capabilities/cards/index.js'
import { TextCapability, type TextEvent } from '../src/core/capabilities/text/index.js'

const card: Card = { title: '模拟', body: '详情', buttons: [{ id: 'approve', label: '批准' }] }
const done: Card = { title: '模拟', body: '处理完成', buttons: [] }

test('飞书群聊收发文字、发送卡片及按钮回调保留群目标和独立点击者', async ({ mock }) => {
  let handlers: Partial<EventMap> = {}
  mock.method(LarkChannel.prototype, 'on', (events: Partial<EventMap>) => {
    handlers = { ...handlers, ...events }
    return () => {}
  })
  mock.method(LarkChannel.prototype, 'connect', async () => undefined)
  mock.method(LarkChannel.prototype, 'disconnect', async () => undefined)
  const send = mock.method(LarkChannel.prototype, 'send', async () => ({ messageId: 'group-card' }))
  const update = mock.method(LarkChannel.prototype, 'updateCard', async () => undefined)
  const bot = createBot({ adapter: createFeishuAdapter({ appId: 'test', appSecret: 'test' }) })
  const text = bot.messages
  const cards = bot.cards
  const received: TextEvent[] = []
  const actions: ActionEvent[] = []
  text.onMessage((event) => {
    const { reply: _reply, ...message } = event
    received.push(message)
  })
  cards.onAction(async (event) => {
    actions.push(event)
    await event.update(done)
  })
  await bot.start()
  const group = { botId: 'feishu', type: 'group' as const, chatId: 'oc_group' }
  await handlers.message?.({
    chatType: 'group',
    chatId: group.chatId,
    senderId: 'ou_member',
    rawContentType: 'text',
    content: '群消息',
    messageId: 'm-group',
  } as never)
  assert.deepEqual(received, [
    { conversation: group, actorId: 'ou_member', text: '群消息', messageId: 'm-group' },
  ])
  await text.send(received[0].conversation, '群回复')
  const ref = await cards.send(group, card)
  assert.deepEqual(send.mock.calls[0].arguments, ['oc_group', { text: '群回复' }])
  assert.equal(send.mock.calls[1].arguments[0], 'oc_group')
  await handlers.cardAction?.({
    messageId: ref.cardId,
    chatId: 'oc_group',
    operator: { openId: 'ou_other' },
    action: { tag: 'button', value: { botSdkAction: 'approve' } },
  })
  assert.deepEqual(actions[0].conversation, group)
  assert.equal(actions[0].actorId, 'ou_other')
  assert.match(JSON.stringify(update.mock.calls[0].arguments), /处理完成/)
  assert.ok(bot.native instanceof LarkChannel)
  await bot.stop()
})

test('企微群聊发送和回复使用 chatid，允许群按钮回调并可更新所有接收者', async ({ mock }) => {
  const connect = mock.method(WSClient.prototype, 'connect', function (this: WSClient) {
    this.emit('authenticated')
    return this
  })
  mock.method(WSClient.prototype, 'disconnect', () => undefined)
  const send = mock.method(WSClient.prototype, 'sendMessage', async () => ({}))
  const update = mock.method(WSClient.prototype, 'updateTemplateCard', async () => ({}))
  const bot = createBot({
    adapter: createWecomAdapter({
      botId: 'robot',
      secret: 'test',
      cards: { textNoticeUrl: 'https://example.com/', updateScope: 'all' },
    }),
  })
  const text = bot.messages
  const cards = bot.cards
  const received: TextEvent[] = []
  const actions: ActionEvent[] = []
  text.onMessage((event) => {
    const { reply: _reply, ...message } = event
    received.push(message)
  })
  cards.onAction(async (event) => {
    actions.push(event)
    await event.update(done)
  })
  await bot.start()
  const client = connect.mock.calls[0].this as WSClient
  const group = { botId: 'wecom', type: 'group' as const, chatId: 'group-room' }
  client.emit('message.text', {
    headers: { req_id: 'text' },
    body: {
      aibotid: 'robot',
      chattype: 'group',
      chatid: group.chatId,
      from: { userid: 'member' },
      msgid: 'm-group',
      text: { content: '群消息' },
    },
  } as never)
  await setImmediate()
  assert.deepEqual(received, [
    { conversation: group, actorId: 'member', text: '群消息', messageId: 'm-group' },
  ])
  await text.send(received[0].conversation, '群回复')
  const ref = await cards.send(group, card)
  assert.equal(send.mock.calls[0].arguments[0], 'group-room')
  assert.equal(send.mock.calls[1].arguments[0], 'group-room')
  const frame = {
    headers: { req_id: 'click' },
    body: {
      aibotid: 'robot',
      chattype: 'group',
      chatid: group.chatId,
      from: { userid: 'other-member' },
      event: { template_card_event: { task_id: ref.cardId, event_key: 'approve' } },
    },
  }
  client.emit('event.template_card_event', frame as never)
  await setImmediate()
  assert.deepEqual(actions[0].conversation, group)
  assert.equal(actions[0].actorId, 'other-member')
  assert.equal(update.mock.calls[0].arguments[0], frame)
  assert.equal(update.mock.calls[0].arguments[2], undefined)
  assert.equal(bot.native, client)
  await bot.stop()
})

test('钉钉群文字使用群接口，卡片投放使用群模型，IM_GROUP 点击正常交付', async ({ mock }) => {
  const connect = mock.method(DWClient.prototype, 'connect', async function (this: DWClient) {
    this.connected = true
  })
  mock.method(DWClient.prototype, 'disconnect', () => undefined)
  mock.method(DWClient.prototype, 'socketCallBackResponse', () => undefined)
  const http = mock.method(globalThis, 'fetch', async (url: string, _init?: RequestInit) => {
    if (url.endsWith('/accessToken')) return Response.json({ accessToken: 'token', expireIn: 7200 })
    if (url.endsWith('/groupMessages/send')) return Response.json({ processQueryKey: 'sent' })
    return Response.json({ success: true, result: { deliverResults: [{ success: true }] } })
  })
  const bot = createBot({
    adapter: createDingtalkAdapter({
      clientId: 'test',
      clientSecret: 'test',
      corpId: 'corp',
      cards: {
        templateId: 'template',
        titleVariable: 'heading',
        bodyVariable: 'description',
        buttonActionParam: 'choice',
        buttonSlots: [
          {
            componentId: 'choose',
            labelVariable: 'caption',
            visibleVariable: 'shown',
            actionIdVariable: 'actionValue',
          },
        ],
      },
    }),
  })
  const text = bot.messages
  const cards = bot.cards
  const received: TextEvent[] = []
  const actions: ActionEvent[] = []
  text.onMessage((event) => {
    const { reply: _reply, ...message } = event
    received.push(message)
  })
  cards.onAction(async (event) => {
    actions.push(event)
    await event.update(done)
  })
  await bot.start()
  const group = { botId: 'dingtalk', type: 'group' as const, chatId: 'cid-room' }
  const client = connect.mock.calls[0].this as DWClient
  client.emit(TOPIC_ROBOT, {
    headers: { messageId: 'text' },
    data: JSON.stringify({
      conversationType: '2',
      conversationId: group.chatId,
      senderCorpId: 'corp',
      senderStaffId: 'member',
      msgId: 'm-group',
      msgtype: 'text',
      text: { content: '群消息' },
    }),
  } as DWClientDownStream)
  await setImmediate()
  assert.deepEqual(received, [
    { conversation: group, actorId: 'member', messageId: 'm-group', text: '群消息' },
  ])
  await text.send(received[0].conversation, '群回复')
  const ref = await cards.send(group, card)
  assert.match(String(http.mock.calls[1].arguments[0]), /robot\/groupMessages\/send$/)
  const textBody = JSON.parse(http.mock.calls[1].arguments[1]?.body as string)
  assert.equal(textBody.openConversationId, 'cid-room')
  assert.equal(textBody.userIds, undefined)
  const body = JSON.parse(http.mock.calls[2].arguments[1]?.body as string)
  assert.equal(body.openSpaceId, 'dtv1.card//IM_GROUP.cid-room')
  assert.deepEqual(body.imGroupOpenDeliverModel, { robotCode: 'test' })
  assert.equal(body.imRobotOpenDeliverModel, undefined)
  assert.deepEqual(body.cardData.cardParamMap, {
    heading: '模拟',
    description: '详情',
    caption: '批准',
    shown: 'true',
    actionValue: 'approve',
  })
  client.emit(TOPIC_CARD, {
    headers: { messageId: 'click' },
    data: JSON.stringify({
      spaceType: 'IM_GROUP',
      spaceId: body.openSpaceId,
      corpId: 'corp',
      userId: 'other-member',
      outTrackId: ref.cardId,
      content: JSON.stringify({ cardPrivateData: { params: { choice: 'approve' } } }),
    }),
  } as DWClientDownStream)
  await setImmediate()
  assert.deepEqual(actions[0].conversation, group)
  assert.equal(actions[0].actorId, 'other-member')
  assert.match(JSON.stringify(http.mock.calls.at(-1)?.arguments), /处理完成/)
  assert.equal(bot.native, client)
  await bot.stop()
})

test('飞书映射单聊、主动消息、原生按钮回调与主动更新', async ({ mock }) => {
  let handlers: Partial<EventMap> = {}
  const clear = mock.fn()
  mock.method(LarkChannel.prototype, 'on', (eventMap: Partial<EventMap>) => {
    handlers = { ...handlers, ...eventMap }
    return clear
  })
  mock.method(LarkChannel.prototype, 'connect', async () => undefined)
  mock.method(LarkChannel.prototype, 'disconnect', async () => undefined)
  const send = mock.method(LarkChannel.prototype, 'send', async () => ({ messageId: 'om_test' }))
  const update = mock.method(LarkChannel.prototype, 'updateCard', async () => undefined)
  const errors: string[] = []
  const adapter = createFeishuAdapter({ id: 'feishu', appId: 'cli_test', appSecret: 'fake' })
  const bot = createBot({
    adapter,
    onError: (error) => errors.push(error.message),
  })
  const text = bot.install(new TextCapability())
  const cardCapability = bot.install(new CardCapability())
  const texts: TextEvent[] = []
  const actions: ActionEvent[] = []
  text.onMessage((event) => {
    texts.push(event)
  })
  cardCapability.onAction((event) => {
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
  assert.deepEqual(texts, [
    {
      conversation: { botId: 'feishu', type: 'group', chatId: 'oc_test' },
      actorId: 'ou_user',
      text: '你好',
      messageId: 'om_in',
    },
    { conversation: user, actorId: 'ou_user', text: '你好', messageId: 'om_in' },
  ])
  await text.send(user, '回应')
  assert.deepEqual(send.mock.calls[0].arguments, [user.userId, { text: '回应' }])
  const hidden = { id: 'snooze', label: '稍后查看', visible: false }
  const ref = await cardCapability.send(user, { ...card, buttons: [hidden, ...card.buttons] })
  assert.equal(ref.cardId, 'om_test')
  assert.match(JSON.stringify(send.mock.calls[1].arguments), /botSdkAction/)
  assert.doesNotMatch(JSON.stringify(send.mock.calls[1].arguments), /snooze/)
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
    {
      botId: 'feishu',
      cardId: ref.cardId,
      actorId: 'ou_user',
      actionId: 'approve',
      conversation: user,
      chatId: 'oc_test',
    },
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
  await cardCapability.update(ref, done)
  assert.equal(update.mock.calls.length, 1)
  await bot.stop()
  assert.equal(clear.mock.calls.length, 3)
})

test('企微等待认证、将 task_id 关联到点击并使用原回调帧更新', async ({ mock }) => {
  const diagnose = mock.fn()
  const connect = mock.method(WSClient.prototype, 'connect', function (this: WSClient) {
    this.emit('authenticated')
    return this
  })
  mock.method(WSClient.prototype, 'disconnect', () => undefined)
  const send = mock.method(WSClient.prototype, 'sendMessage', async () => ({}))
  const update = mock.method(
    WSClient.prototype,
    'updateTemplateCard',
    async (_frame: WsFrame, updated: TemplateCard) => {
      // 复现线上 42045 的边界：文本通知卡必须带 type 1 及有效链接，不能仅信任 SDK 的类型声明。
      if (
        updated.card_type === 'text_notice' &&
        (updated.card_action?.type !== 1 || !updated.card_action.url)
      )
        throw { errcode: 42045 }
      return {} as WsFrame
    },
  )
  const adapter = createWecomAdapter({
    id: 'wecom',
    botId: 'robot',
    secret: 'fake',
    onDiagnostic: diagnose,
  })
  const bot = createBot({ adapter })
  const text = bot.install(new TextCapability())
  const cardCapability = bot.install(new CardCapability())
  const cards = cardCapability.withOptions({ textNoticeUrl: 'https://example.com/' })
  const texts: TextEvent[] = []
  const actions: ActionEvent[] = []
  text.onMessage((event) => {
    texts.push(event)
  })
  cardCapability.onAction(async (event) => {
    const { deferCardUpdate, ...action } = event
    actions.push(action)
    deferCardUpdate?.()
    await cards.settle(ref, done)
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
  await text.send(user, '**纯文本**')
  assert.deepEqual(send.mock.calls[0].arguments, [
    'member',
    { msgtype: 'markdown', markdown: { content: '\\*\\*纯文本\\*\\*' } },
  ])
  const body =
    '设备：开发电脑\n工作区：示例\n操作：执行命令\n完整命令：node --version\n工作目录：工作区根目录\n授权范围：仅本次，不会登记到命令列表。'
  const ref = await cards.send(user, {
    ...card,
    body: '模拟审批详情\n' + body,
    buttons: [
      { id: 'snooze', label: '稍后查看', visible: false },
      { id: 'deny', label: '拒绝', style: 'secondary' },
      { ...card.buttons[0], style: 'primary' },
    ],
  })
  assert.deepEqual(send.mock.calls[1].arguments, [
    'member',
    {
      msgtype: 'template_card',
      template_card: {
        card_type: 'button_interaction',
        task_id: ref.cardId,
        main_title: { title: card.title },
        sub_title_text: '模拟审批详情',
        horizontal_content_list: [
          { keyname: '设备', value: '开发电脑' },
          { keyname: '工作区', value: '示例' },
          { keyname: '操作', value: '执行命令' },
          { keyname: '完整命令', value: 'node --version' },
          { keyname: '工作目录', value: '工作区根目录' },
          { keyname: '授权范围', value: '仅本次，不会登记到命令列表。' },
        ],
        button_list: [
          { key: 'deny', text: '拒绝', style: 4 },
          { key: 'approve', text: '批准', style: 1 },
        ],
      },
    },
  ])
  const frame = {
    headers: { req_id: 'r2' },
    body: {
      aibotid: 'robot',
      chattype: 'single',
      from: { userid: 'member' },
      chatid: 'member',
      event: {
        eventtype: 'template_card_event',
        template_card_event: { task_id: ref.cardId, event_key: 'approve' },
      },
    },
  }
  client.emit('event.template_card_event', {
    ...frame,
    body: { ...frame.body, aibotid: 'other-bot' },
  } as never)
  client.emit('event.template_card_event', {
    ...frame,
    body: { ...frame.body, from: undefined },
  } as never)
  client.emit('event.template_card_event', frame as never)
  await setImmediate()
  assert.deepEqual(texts, [
    { conversation: user, actorId: 'member', messageId: 'm1', text: '你好' },
  ])
  assert.deepEqual(actions, [
    {
      botId: 'wecom',
      cardId: ref.cardId,
      actorId: 'member',
      actionId: 'approve',
      conversation: user,
      chatId: 'member',
    },
  ])
  assert.deepEqual(update.mock.calls[0].arguments, [
    frame,
    {
      card_type: 'text_notice',
      task_id: ref.cardId,
      main_title: { title: '模拟' },
      sub_title_text: '处理完成',
      card_action: { type: 1, url: 'https://example.com/' },
    },
    ['member'],
  ])
  assert.deepEqual(
    diagnose.mock.calls.map(({ arguments: args }) => args[0]),
    [
      '企微长连接认证成功',
      '企微已接受文本',
      '企微已接受卡片',
      '企微已推送卡片按钮回调',
      '企微按钮回调未通过机器人或点击者校验',
      '企微已推送卡片按钮回调',
      '企微按钮回调未通过机器人或点击者校验',
      '企微已推送卡片按钮回调',
      '企微已确认卡片更新',
    ],
  )
  // 通知卡缺少链接时应在本地报错，避免发送已知会被平台拒绝的 type 0。
  await assert.rejects(cardCapability.send(user, done), /必须配置/)
  await cards.send(user, done, { textNoticeUrl: 'https://example.com/details' })
  const linkedCard = send.mock.calls.at(-1)?.arguments[1] as {
    template_card: { card_action: { type: number; url?: string } }
  }
  assert.deepEqual(linkedCard.template_card.card_action, {
    type: 1,
    url: 'https://example.com/details',
  })
  await assert.rejects(cards.update(ref, done), { capability: 'cards.update' })
  await bot.stop()
})

test('同一个钉钉连接使用两套模板，更新和点击各自沿用原配置', async ({ mock }) => {
  const connect = mock.method(DWClient.prototype, 'connect', async function (this: DWClient) {
    this.connected = true
  })
  mock.method(DWClient.prototype, 'disconnect', () => undefined)
  mock.method(DWClient.prototype, 'socketCallBackResponse', () => undefined)
  const http = mock.method(globalThis, 'fetch', async (url: string, _init?: RequestInit) =>
    url.endsWith('/accessToken')
      ? Response.json({ accessToken: 'token', expireIn: 7200 })
      : Response.json({ success: true, result: { deliverResults: [{ success: true }] } }),
  )
  const adapter = createDingtalkAdapter({
    id: 'ding',
    clientId: 'fake',
    clientSecret: 'fake',
    corpId: 'corp',
  })
  const bot = createBot({ adapter })
  const cardCapability = bot.install(new CardCapability())
  const customOptions = {
    templateId: 'template',
    buttonSlots: [
      {
        labelVariable: 'leftText',
        visibleVariable: 'showLeft',
        actionIdVariable: 'leftAction',
      },
      {
        labelVariable: 'rightText',
        visibleVariable: 'showRight',
        actionIdVariable: 'rightAction',
      },
    ],
    buttonActionParam: 'choice',
  } satisfies DingtalkCardOptions
  const customCards = cardCapability.withOptions(customOptions)
  const defaultCards = cardCapability.withOptions({ templateId: 'second-template' })
  const actions: ActionEvent[] = []
  cardCapability.onAction((event) => {
    actions.push(event)
  })
  await bot.start()
  const to = { botId: 'ding', userId: 'member' }
  await assert.rejects(cardCapability.send(to, card), BotConfigurationError)
  await assert.rejects(
    cardCapability.send(to, card, { textNoticeUrl: 'https://example.com/' }),
    BotConfigurationError,
  )
  assert.equal(http.mock.calls.length, 0)
  const ref = await customCards.send(to, {
    title: '提醒',
    body: '任务已到期',
    buttons: [
      { id: 'snooze', label: '稍后提醒', visible: false },
      { id: 'resolve', label: '标为完成' },
    ],
  })
  const second = await defaultCards.send(to, card)
  // 调整业务配置后，已投放的卡片仍然使用发送时的按钮变量。
  customOptions.buttonSlots[0].visibleVariable = 'changed'
  customOptions.buttonActionParam = 'changed'
  await defaultCards.update(ref, done)
  await customCards.update(second, done)
  const payload = (index: number) => JSON.parse(http.mock.calls[index].arguments[1]?.body as string)
  assert.equal(payload(1).cardTemplateId, 'template')
  assert.equal(payload(2).cardTemplateId, 'second-template')
  assert.equal(payload(3).cardData.cardParamMap.showLeft, 'false')
  assert.equal(payload(4).cardData.cardParamMap.showFirst, 'false')
  assert.deepEqual(
    JSON.parse(http.mock.calls[1].arguments[1]?.body as string).cardData.cardParamMap,
    {
      title: '提醒',
      body: '任务已到期',
      leftText: '稍后提醒',
      showLeft: 'false',
      leftAction: 'snooze',
      rightText: '标为完成',
      showRight: 'true',
      rightAction: 'resolve',
    },
  )
  const client = connect.mock.calls[0].this as DWClient
  client.emit(TOPIC_CARD, {
    headers: { messageId: 'callback' },
    data: JSON.stringify({
      spaceType: 'IM_ROBOT',
      corpId: 'corp',
      userId: 'member',
      outTrackId: ref.cardId,
      content: JSON.stringify({ cardPrivateData: { params: { choice: 'resolve' } } }),
    }),
  } as DWClientDownStream)
  client.emit(TOPIC_CARD, {
    headers: { messageId: 'second-callback' },
    data: JSON.stringify({
      spaceType: 'IM_ROBOT',
      corpId: 'corp',
      userId: 'member',
      outTrackId: second.cardId,
      content: JSON.stringify({ cardPrivateData: { params: { botSdkAction: 'approve' } } }),
    }),
  } as DWClientDownStream)
  await setImmediate()
  assert.deepEqual(actions, [
    { botId: 'ding', cardId: ref.cardId, actorId: 'member', actionId: 'resolve', conversation: to },
    {
      botId: 'ding',
      cardId: second.cardId,
      actorId: 'member',
      actionId: 'approve',
      conversation: to,
    },
  ])
  await bot.stop()
})

test('钉钉真实回调缺少场域字段时仍按原卡识别动作，拒绝跨企业及未知卡片', async ({ mock }) => {
  const connect = mock.method(DWClient.prototype, 'connect', async function (this: DWClient) {
    this.connected = true
  })
  mock.method(DWClient.prototype, 'disconnect', () => undefined)
  mock.method(DWClient.prototype, 'socketCallBackResponse', () => undefined)
  const http = mock.method(globalThis, 'fetch', async (url: string, _init?: RequestInit) =>
    url.endsWith('/accessToken')
      ? Response.json({ accessToken: 'token', expireIn: 7200 })
      : Response.json({ success: true, result: { deliverResults: [{ success: true }] } }),
  )
  const bot = createBot({
    adapter: createDingtalkAdapter({ clientId: 'fake', clientSecret: 'fake', corpId: 'corp' }),
  })
  const cards = bot.install(new CardCapability())
  const actions: string[] = []
  cards.onAction(({ actionId }) => {
    actions.push(actionId)
  })
  await bot.start()
  const ref = await cards.send(
    'member',
    {
      title: '操作审批',
      body: '测试模板映射',
      buttons: [
        { id: 'deny', label: '拒绝' },
        { id: 'approve', label: '批准' },
      ],
    },
    {
      templateId: 'existing-template',
      buttonSlots: [
        {
          componentId: 'reject',
          labelVariable: 'firstLabel',
          visibleVariable: 'showFirst',
          actionIdVariable: 'firstId',
        },
        {
          componentId: 'agree',
          labelVariable: 'secondLabel',
          visibleVariable: 'showSecond',
          actionIdVariable: 'secondId',
        },
      ],
    } satisfies DingtalkCardOptions,
  )
  const payload = JSON.parse(http.mock.calls[1].arguments[1]?.body as string)
  assert.deepEqual(payload.cardData.cardParamMap, {
    title: '操作审批',
    body: '测试模板映射',
    firstLabel: '拒绝',
    showFirst: 'true',
    firstId: 'deny',
    secondLabel: '批准',
    showSecond: 'true',
    secondId: 'approve',
  })
  const client = connect.mock.calls[0].this as DWClient
  for (const [componentId, variable] of [
    ['reject', 'firstId'],
    ['agree', 'secondId'],
  ]) {
    // 模板参数值绑定 firstId、secondId 变量，平台回传变量展开后的业务动作。
    const callback = {
      corpId: 'corp',
      userId: 'member',
      outTrackId: ref.cardId,
      content: JSON.stringify({
        cardPrivateData: {
          actionIds: [componentId],
          params: { botSdkAction: payload.cardData.cardParamMap[variable] },
        },
      }),
    }
    // 真实回调可不带 spaceType；不得因此丢弃已投放原卡的合法点击。
    for (const data of [
      { ...callback, corpId: 'other-corp' },
      { ...callback, outTrackId: 'rcm_unknown' },
      callback,
    ]) {
      client.emit(TOPIC_CARD, {
        headers: { messageId: componentId },
        data: JSON.stringify(data),
      } as DWClientDownStream)
    }
  }
  await setImmediate()
  assert.deepEqual(actions, ['deny', 'approve'])
  await bot.stop()
})

test('钉钉 OpenAPI 主动投放、Stream 点击回执、主动更新和平台拒绝', async ({ mock }) => {
  const deliveryFailureDetail = mock.fn()
  const messageDiagnostic = mock.fn()
  const connect = mock.method(DWClient.prototype, 'connect', async function (this: DWClient) {
    this.connected = true
  })
  mock.method(DWClient.prototype, 'disconnect', () => undefined)
  const ack = mock.method(DWClient.prototype, 'socketCallBackResponse', () => undefined)
  let textRejected = false
  let updateSuccess = true
  let cardResponse = () =>
    Response.json({ success: true, result: { deliverResults: [{ success: true }] } })
  const http = mock.method(globalThis, 'fetch', async (url: string, _init?: RequestInit) => {
    if (url.endsWith('/accessToken'))
      return Response.json({ accessToken: 'test-token', expireIn: 7200 })
    if (url.endsWith('/batchSend'))
      return Response.json(
        textRejected ? { invalidStaffIdList: ['member'] } : { processQueryKey: 'ok' },
      )
    return url.endsWith('/createAndDeliver')
      ? cardResponse()
      : Response.json({ success: updateSuccess })
  })
  const adapter = createDingtalkAdapter({
    id: 'ding',
    clientId: 'fake',
    clientSecret: 'fake',
    corpId: 'corp',
    robotCode: 'card-robot',
    onDiagnostic: messageDiagnostic,
  })
  const bot = createBot({ adapter })
  const text = bot.install(new TextCapability())
  const cardCapability = bot.install(new CardCapability())
  const cards = cardCapability.withOptions({
    templateId: 'template',
    onDeliveryFailureDetail: deliveryFailureDetail,
  } satisfies DingtalkCardOptions)
  const actions: ActionEvent[] = []
  const texts: TextEvent[] = []
  text.onMessage((event) => {
    texts.push(event)
  })
  cardCapability.onAction((event) => {
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
  await text.send(user, '回声')
  const ref = await cards.send(user, {
    ...card,
    buttons: [{ id: 'deny', label: '拒绝' }, card.buttons[0]],
  })
  const request = JSON.parse(http.mock.calls[2].arguments[1]?.body as string)
  assert.equal(request.cardData.cardParamMap.firstId, 'deny')
  assert.equal(request.cardData.cardParamMap.secondId, 'approve')
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
  assert.deepEqual(texts, [
    { conversation: user, actorId: 'member', messageId: 'm1', text: '你好' },
  ])
  assert.deepEqual(actions, [
    {
      botId: 'ding',
      cardId: ref.cardId,
      actorId: 'member',
      actionId: 'approve',
      conversation: user,
    },
  ])
  assert.deepEqual(ack.mock.calls[1].arguments, [TOPIC_CARD, {}])
  assert.match(JSON.stringify(ack.mock.calls[2].arguments), /处理完成/)
  // 平台原生组件 ID 可直接定位按钮；文案、数组位置与回调动作应保持一致。
  for (const componentId of ['button1', 'button2']) {
    const nativeRef = await cards.send(user, {
      ...card,
      buttons: [{ id: 'deny', label: '拒绝' }, card.buttons[0]],
    })
    if (componentId === 'button1') {
      // 平台未接受交换按钮的更新时，仍按原卡显示的第一个按钮识别为拒绝。
      updateSuccess = false
      await assert.rejects(
        cards.update(nativeRef, {
          ...card,
          buttons: [card.buttons[0], { id: 'deny', label: '拒绝' }],
        }),
        /钉钉卡片更新失败/,
      )
      updateSuccess = true
    }
    const nativeCallback = {
      ...callback,
      outTrackId: nativeRef.cardId,
      content: JSON.stringify({
        cardPrivateData: {
          actionIds: [componentId],
          // 第二个按钮故意回传过时参数，仍应按当前显示槽位识别为批准。
          ...(componentId === 'button2' ? { params: { botSdkAction: 'deny' } } : {}),
        },
      }),
    }
    emit(TOPIC_CARD, { ...nativeCallback, corpId: 'elsewhere' })
    emit(TOPIC_CARD, nativeCallback)
    await setImmediate()
  }
  assert.deepEqual(
    actions.map(({ actionId }) => actionId),
    ['approve', 'deny', 'approve'],
  )
  emit(TOPIC_ROBOT, {
    conversationType: '1',
    msgtype: 'text',
    chatbotCorpId: 'corp',
    senderCorpId: 'other-org',
    senderStaffId: 'other-member',
    msgId: 'm2',
    text: { content: '私聊内容' },
  })
  assert.equal(texts.length, 1)
  assert.deepEqual(
    messageDiagnostic.mock.calls
      .map(({ arguments: args }) => args)
      .filter(
        ([message]) =>
          message === '已收到钉钉机器人消息回调。' || message.startsWith('机器人组织与配置一致'),
      ),
    [
      ['已收到钉钉机器人消息回调。'],
      ['已收到钉钉机器人消息回调。'],
      ['机器人组织与配置一致，但发送者不是该组织成员或回调缺少发送者组织。'],
    ],
  )
  const cardDiagnostics = messageDiagnostic.mock.calls.map(({ arguments: args }) => args[0])
  assert.ok(cardDiagnostics.includes('已收到钉钉卡片按钮回调。'))
  assert.ok(cardDiagnostics.some((message) => message.includes('企业匹配":false')))
  assert.ok(cardDiagnostics.includes('钉钉卡片按钮已交付业务处理。'))
  assert.ok(cardDiagnostics.every((message) => !/member|elsewhere|私聊内容/.test(message)))
  await cards.update(ref, done)
  assert.equal(http.mock.calls.at(-1)?.arguments[1]?.method, 'PUT')
  textRejected = true
  await assert.rejects(text.send(user, '不会投递'), /未接受/)
  cardResponse = () =>
    Response.json({
      success: true,
      result: { deliverResults: [{ success: false, errorMsg: 'param.userIdNotExist' }] },
    })
  await assert.rejects(cards.send(user, card), /平台返回投递失败（param.userIdNotExist）/)
  cardResponse = () =>
    Response.json({
      success: true,
      result: { deliverResults: [{ success: false, errorMsg: '平台回显的私聊内容' }] },
    })
  await assert.rejects(
    cards.send(user, card),
    (error: Error) =>
      error.message.includes('平台返回投递失败') && !error.message.includes('平台回显的私聊内容'),
  )
  assert.deepEqual(deliveryFailureDetail.mock.calls[1].arguments, ['平台回显的私聊内容'])
  cardResponse = () => Response.json({ success: true })
  await assert.rejects(cards.send(user, card), /投递结果条数：未返回/)
  cardResponse = () =>
    Response.json({ code: 'param.templateUnpublished', message: '审批正文示例' }, { status: 400 })
  await assert.rejects(
    cards.send(user, card),
    (error: Error) =>
      error.message.includes('HTTP 400，param.templateUnpublished') &&
      !error.message.includes('审批正文示例'),
  )
  const requestId = 'e64a36ef-2fb4-4bc5-bbd8-80e0f54218f9'
  cardResponse = () =>
    Response.json(
      {
        code: 'Forbidden.AccessDenied.AccessTokenPermissionDenied',
        requestid: requestId,
        message: '审批正文示例',
        accessdenieddetail: { requiredScopes: ['Card.Instance.Write', '未识别值'] },
      },
      { status: 403 },
    )
  await assert.rejects(
    cards.send(user, card),
    (error: Error) =>
      error.message.includes('HTTP 403，Forbidden.AccessDenied.AccessTokenPermissionDenied') &&
      error.message.includes('Card.Instance.Write') &&
      error.message.includes(requestId) &&
      !/审批正文示例|未识别值/.test(error.message),
  )
  cardResponse = () => new Response('代理错误页')
  await assert.rejects(cards.send(user, card), /返回非 JSON 响应（HTTP 200）/)
  cardResponse = () => {
    throw new TypeError('底层网络错误含敏感值', { cause: { code: 'ENOTFOUND' } })
  }
  await assert.rejects(
    cards.send(user, card),
    (error: Error) =>
      error.message.includes('网络请求失败（ENOTFOUND）') && !error.message.includes('敏感值'),
  )
  await bot.stop()
})

test('钉钉自动装配文字和卡片回调，重启不重复注册', async ({ mock }) => {
  const connection = createDingtalkAdapter({
    id: 'ding',
    clientId: 'fake',
    clientSecret: 'fake',
    corpId: 'corp',
  })
  const other = createDingtalkAdapter({
    id: 'ding-other',
    clientId: 'fake',
    clientSecret: 'fake',
    corpId: 'corp',
  })
  const connect = mock.method(DWClient.prototype, 'connect', async function (this: DWClient) {
    this.connected = true
  })
  mock.method(DWClient.prototype, 'disconnect', function (this: DWClient) {
    this.connected = false
  })
  const bot = createBot({ adapter: connection })
  bot.install(new TextCapability())
  for (let i = 0; i < 2; i++) {
    await bot.start()
    const client = connect.mock.calls[i].this as DWClient
    assert.equal(client.listenerCount(TOPIC_ROBOT), 1)
    assert.equal(client.listenerCount(TOPIC_CARD), 1)
    assert.deepEqual(
      client.config.subscriptions
        .filter(({ type }) => type === 'CALLBACK')
        .map(({ topic }) => topic),
      [TOPIC_ROBOT, TOPIC_CARD],
    )
    assert.equal(
      other.client.config.subscriptions.some(({ type }) => type === 'CALLBACK'),
      false,
    )
    await bot.stop()
    assert.equal(client.listenerCount(TOPIC_ROBOT), 0)
    assert.equal(client.listenerCount(TOPIC_CARD), 0)
  }
})
