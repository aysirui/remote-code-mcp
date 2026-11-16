import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import { DeviceHub } from '../src/modules/device/device-hub'
import type { Store } from '../src/infrastructure/database/store'
import * as S from '../src/infrastructure/database/schema'

/** 模拟连接消息与事务等待，不依赖真实设备或持久数据库。 */
function setup() {
  const events: string[] = []
  let releaseFirst: (() => void) | undefined
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  let notifyStarted: (() => void) | undefined
  const firstStarted = new Promise<void>((resolve) => {
    notifyStarted = resolve
  })
  let transactions = 0
  const query = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve([{ id: 'device-1', userId: 'owner-1', status: 'active' }]).then(resolve),
  }
  const db = {
    select: jest.fn(() => query),
    transaction: jest.fn(async () => {
      transactions++
      events.push('start:' + transactions)
      if (transactions === 1) {
        notifyStarted?.()
        await firstBlocked
      }
      events.push('end:' + transactions)
      return null
    }),
  }
  const hub = new DeviceHub({
    db,
    one: async (value: Promise<unknown[]>) => (await value)[0],
  } as unknown as Store)
  const socket = new EventEmitter() as WebSocket
  Object.defineProperty(socket, 'readyState', { value: WebSocket.OPEN })
  const send = jest.fn()
  socket.send = send
  socket.close = jest.fn()
  socket.ping = jest.fn()
  socket.terminate = jest.fn()
  hub['accept'](socket, 'device-1')
  const hello = (runtimeVersion: string) =>
    socket.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          kind: 'hello',
          runtimeVersion,
          workspaces: [],
        }),
      ),
    )
  const cleanup = () => socket.emit('close')
  return {
    events,
    firstStarted,
    releaseFirst: () => releaseFirst?.(),
    hello,
    cleanup,
    send,
    db,
    hub,
    socket,
  }
}

test('连续 hello 串行：第二条不得越过等待中的第一条事务', async () => {
  const state = setup()
  try {
    state.hello('first')
    await state.firstStarted
    state.hello('second')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(state.events).toEqual(['start:1'])
    state.releaseFirst()
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(state.events).toEqual(['start:1', 'end:1', 'start:2', 'end:2'])
    expect(state.send).not.toHaveBeenCalled()
  } finally {
    state.releaseFirst()
    state.cleanup()
  }
})

/** 连接替换后，旧连接排队中的 hello 不得再启动事务或发送撤销确认。 */
test('旧连接被替换：队列中尚未执行的 hello 被丢弃', async () => {
  const state = setup()
  const replacement = new EventEmitter() as WebSocket
  Object.defineProperty(replacement, 'readyState', { value: WebSocket.OPEN })
  replacement.send = jest.fn()
  replacement.close = jest.fn()
  replacement.ping = jest.fn()
  replacement.terminate = jest.fn()
  try {
    state.hello('first')
    await state.firstStarted
    state.hello('stale-second')
    state.hub['accept'](replacement, 'device-1')
    expect(state.socket.close).toHaveBeenCalledWith(4001, 'Replaced')
    state.releaseFirst()
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(state.events).toEqual(['start:1', 'end:1'])
    expect(state.send).not.toHaveBeenCalled()
  } finally {
    state.releaseFirst()
    state.cleanup()
    replacement.emit('close')
  }
})

/** 不属于当前连接的 RPC 响应不得被旧连接冒充。 */
test('连接替换后旧连接消息不再触发任何数据库同步', async () => {
  const state = setup()
  const replacement = new EventEmitter() as WebSocket
  Object.defineProperty(replacement, 'readyState', { value: WebSocket.OPEN })
  replacement.send = jest.fn()
  replacement.close = jest.fn()
  replacement.ping = jest.fn()
  replacement.terminate = jest.fn()
  try {
    state.hub['accept'](replacement, 'device-1')
    state.hello('stale')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(state.db.transaction).not.toHaveBeenCalled()
    expect(state.send).not.toHaveBeenCalled()
  } finally {
    state.cleanup()
    replacement.emit('close')
  }
})

/** 在真实事务回调中模拟连接替换，确保旧快照不能成功提交。 */
test('事务执行期间连接被替换：提交前抛错并回滚旧快照', async () => {
  const events: string[] = []
  let releaseWrite: (() => void) | undefined
  let notifyWrite: (() => void) | undefined
  const writeBlocked = new Promise<void>((resolve) => {
    releaseWrite = resolve
  })
  const writeStarted = new Promise<void>((resolve) => {
    notifyWrite = resolve
  })
  const device = { id: 'device-1', userId: 'owner-1', status: 'active' }
  const rows = (table: unknown) =>
    table === S.users ? [{ status: 'active' }] : table === S.devices ? [device] : []
  const makeQuery = () => ({
    from(table: unknown) {
      const result = rows(table)
      return {
        where: () => ({
          limit: () => ({
            for: async () => result,
            then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
          }),
          for: async () => result,
          then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
        }),
      }
    },
  })
  const tx = {
    select: jest.fn(makeQuery),
    update: jest.fn(() => ({ set: () => ({ where: async () => undefined }) })),
    delete: jest.fn(() => ({ where: async () => undefined })),
    insert: jest.fn(() => ({
      values: async () => {
        notifyWrite?.()
        await writeBlocked
      },
    })),
  }
  const transaction = jest.fn(async (fn: (value: typeof tx) => Promise<unknown>) => {
    events.push('begin')
    try {
      await fn(tx)
      events.push('commit')
    } catch {
      events.push('rollback')
    }
  })
  const hub = new DeviceHub({
    db: { select: jest.fn(makeQuery), transaction },
    one: async (value: Promise<unknown[]>) => (await value)[0],
  } as unknown as Store)
  const makeSocket = () => {
    const socket = new EventEmitter() as WebSocket
    Object.defineProperty(socket, 'readyState', { value: WebSocket.OPEN })
    socket.send = jest.fn()
    socket.close = jest.fn()
    socket.ping = jest.fn()
    socket.terminate = jest.fn()
    return socket
  }
  const oldSocket = makeSocket()
  const newSocket = makeSocket()
  hub['accept'](oldSocket, 'device-1')
  try {
    oldSocket.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          kind: 'hello',
          runtimeVersion: 'old',
          workspaces: [
            {
              id: '7ea14392-437e-40db-a10d-9261d7814f87',
              name: '工作区',
              enabled: true,
              permissions: { read: true, write: false },
              policies: { file: 'allow', git: 'allow', command: 'deny' },
            },
          ],
        }),
      ),
    )
    await writeStarted
    hub['accept'](newSocket, 'device-1')
    releaseWrite?.()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(events).toEqual(['begin', 'rollback'])
    expect(oldSocket.send).not.toHaveBeenCalled()
  } finally {
    releaseWrite?.()
    oldSocket.emit('close')
    newSocket.emit('close')
  }
})
