import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import type { ApprovalNotice } from '@rcm/protocol'
import { env } from '../src/config/env'
import { DeviceHub } from '../src/modules/device/device-hub'
import {
  ApprovalChannelService,
  type ApprovalRecipient,
} from '../src/modules/device/approval-channel.service'

test.each(['feishu', 'dingtalk', 'wecom'] as const)(
  '结算 %s 使用同一张卡，仅提供结算文本',
  async (channel) => {
    const service = new ApprovalChannelService({} as never)
    const ref = { botId: channel, cardId: 'test-card', userId: 'test-user' }
    const cards = {
      send: jest.fn().mockResolvedValue(ref),
      settle: jest.fn().mockResolvedValue(undefined),
    }
    const cardOptions = {
      feishu: undefined,
      wecom: undefined,
      dingtalk: { templateId: 'test-template' },
    }[channel]
    service['channels'].set(channel, { appId: 'test-app', cardOptions })
    jest.replaceProperty(
      service as unknown as { cards: Map<string, typeof cards> },
      'cards',
      new Map([[channel, cards]]),
    )
    jest.spyOn(service, 'isCurrent').mockResolvedValue(true)
    const recipient: ApprovalRecipient = {
      channel,
      userId: 'owner',
      appId: 'test-app',
      platformUserId: 'test-user',
      revision: 'test-revision',
      enabled: true,
    }
    const notice: ApprovalNotice = {
      kind: 'approval-notice',
      approvalId: randomUUID(),
      requestId: randomUUID(),
      expiresAt: Date.now() + 60_000,
      summary: '工作区：项目\n完整命令：node --version',
    }
    await service.deliver(recipient, notice, '测试电脑', async () => true)
    expect(cards.send).toHaveBeenCalledWith(
      recipient.platformUserId,
      expect.any(Object),
      cardOptions,
    )
    expect(cards.send.mock.calls[0][1].buttons.map(({ id }: { id: string }) => id)).toEqual([
      'deny',
      'approve',
    ])
    const original = cards.send.mock.calls[0][1].body
    const deferCardUpdate = jest.fn(() => jest.fn())
    await service['handleAction']({
      botId: channel,
      cardId: ref.cardId,
      actorId: 'other-user',
      actionId: 'approve',
      deferCardUpdate,
    })
    expect(deferCardUpdate).not.toHaveBeenCalled()
    // SDK 允许群卡回调，但 RCM 审批业务只接受私发场景，即使点击者身份相同也拒绝群事件。
    await service['handleAction']({
      botId: channel,
      cardId: ref.cardId,
      actorId: recipient.platformUserId,
      actionId: 'approve',
      deferCardUpdate,
      conversation: { botId: channel, type: 'group', chatId: 'group-room' },
    })
    expect(deferCardUpdate).not.toHaveBeenCalled()
    await service['handleAction']({
      botId: channel,
      cardId: ref.cardId,
      actorId: recipient.platformUserId,
      actionId: 'approve',
      deferCardUpdate,
    })
    expect(deferCardUpdate).toHaveBeenCalledTimes(1)
    await service.close(ref, 'approved')
    expect(cards.settle).toHaveBeenCalledWith(
      ref,
      { title: '审批已通过', body: original, buttons: [] },
      { resultText: expect.any(Function) },
    )
    const { resultText } = cards.settle.mock.calls[0][2]
    await expect(resultText()).resolves.toBe(
      `审批已通过\n审批编号 ${notice.approvalId.slice(0, 8)}`,
    )
    expect(cards.send).toHaveBeenCalledTimes(1)
  },
)

/** 模拟设备侧事件，不连接真实飞书或数据库。 */
test('多渠道独立投递，绑定变更后旧卡片失效，审批结果同步到所有成功投递的卡片', async () => {
  const binding = {
    userId: 'owner',
    appId: 'cli_test',
    platformUserId: 'ou_test',
    revision: 'original',
    enabled: true,
  }
  const recipients = jest
    .fn()
    .mockResolvedValue(['feishu', 'wecom', 'dingtalk'].map((channel) => ({ ...binding, channel })))
  const isCurrent = jest.fn().mockResolvedValue(true)
  const answers = new Map<string, (approved: boolean) => Promise<boolean>>()
  const deliver = jest.fn(
    async (
      recipient: ApprovalRecipient,
      _notice: unknown,
      _deviceName: string,
      decide: (approved: boolean) => Promise<boolean>,
    ) => {
      if (recipient.channel === 'dingtalk') throw new Error('平台故障')
      answers.set(recipient.channel, decide)
      return { cardId: recipient.channel }
    },
  )
  const close = jest.fn().mockResolvedValue(undefined)
  const query = { from: () => query, where: () => query, limit: () => query }
  const hub = new DeviceHub(
    {
      db: { select: () => query },
      one: jest.fn().mockResolvedValue({
        id: 'device',
        deviceId: 'device',
        localRead: true,
        localWrite: true,
        status: 'active',
        name: '办公室电脑',
      }),
      logOperation: jest.fn().mockResolvedValue(undefined),
    } as never,
    undefined,
    { recipients, isCurrent, deliver, close } as unknown as ApprovalChannelService,
  )
  const socket = new EventEmitter() as WebSocket
  Object.defineProperty(socket, 'readyState', { value: WebSocket.OPEN })
  const send = jest.fn(
    (_message: unknown, optionsOrCallback?: unknown, callback?: (error?: Error) => void) => {
      if (typeof optionsOrCallback === 'function') optionsOrCallback()
      else callback?.()
    },
  )
  socket.send = send
  const other = new EventEmitter() as WebSocket
  hub['accept'](socket, 'device')
  hub['accept'](other, 'other-device')
  try {
    const completion = hub.execute('owner', 'client', randomUUID(), 'file.read', {
      path: 'demo.txt',
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const request = JSON.parse(String(send.mock.calls[0][0]))
    expect(request.notifyApproval).toBe(true)
    const approvalId = randomUUID()
    const notice = {
      kind: 'approval-notice',
      requestId: request.id,
      approvalId,
      summary: '路径：demo.txt',
      expiresAt: Date.now() + 60_000,
    }
    other.emit('message', JSON.stringify(notice))
    expect(deliver).not.toHaveBeenCalled()
    socket.emit('message', JSON.stringify(notice))
    socket.emit('message', JSON.stringify(notice))
    expect(deliver).toHaveBeenCalledTimes(3)
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'feishu' }),
      notice,
      '办公室电脑',
      expect.any(Function),
    )
    await answers.get('feishu')!(true)
    expect(JSON.parse(String(send.mock.calls[1][0]))).toEqual({
      kind: 'approval-answer',
      requestId: request.id,
      approvalId,
      approved: true,
    })
    isCurrent.mockResolvedValue(false)
    await answers.get('wecom')!(false)
    expect(send).toHaveBeenCalledTimes(2)
    socket.emit(
      'message',
      JSON.stringify({
        kind: 'approval-closed',
        requestId: request.id,
        approvalId,
        status: 'approved',
      }),
    )
    socket.emit(
      'message',
      JSON.stringify({ kind: 'response', id: request.id, success: true, data: 'ok' }),
    )
    await expect(completion).resolves.toBe('ok')
    expect(close).toHaveBeenCalledWith({ cardId: 'feishu' }, 'approved')
    expect(close).toHaveBeenCalledWith({ cardId: 'wecom' }, 'approved')
    expect(close).toHaveBeenCalledTimes(2)
  } finally {
    socket.emit('close')
    other.emit('close')
  }
})

test('未配置机器人时不访问绑定表、不返回渠道也不启动适配器', async () => {
  jest.spyOn(env, 'feishuApproval', 'get').mockReturnValue(undefined)
  jest.spyOn(env, 'wecomApproval', 'get').mockReturnValue(undefined)
  jest.spyOn(env, 'dingtalkApproval', 'get').mockReturnValue(undefined)
  const store = { db: { select: jest.fn() } }
  const service = new ApprovalChannelService(store as never)
  try {
    service.onApplicationBootstrap()
    await expect(service.status('owner')).resolves.toEqual([])
    await expect(service.recipients('owner')).resolves.toEqual([])
    expect(store.db.select).not.toHaveBeenCalled()
  } finally {
    await service.onApplicationShutdown()
    jest.restoreAllMocks()
  }
})
