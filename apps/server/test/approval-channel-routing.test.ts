import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { DeviceHub } from '../src/modules/device/device-hub'
import {
  ApprovalChannelService,
  type ApprovalRecipient,
} from '../src/modules/device/approval-channel.service'

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
  const store = { db: { select: jest.fn() } }
  const service = new ApprovalChannelService(store as never)
  jest.replaceProperty(
    service as unknown as { channels: Map<string, unknown> },
    'channels',
    new Map<string, unknown>(),
  )
  service.onApplicationBootstrap()
  await expect(service.status('owner')).resolves.toEqual([])
  await expect(service.recipients('owner')).resolves.toEqual([])
  expect(store.db.select).not.toHaveBeenCalled()
  await service.onApplicationShutdown()
  jest.restoreAllMocks()
})
