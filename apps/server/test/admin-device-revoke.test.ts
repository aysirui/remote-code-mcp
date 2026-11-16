import type { Store } from '../src/infrastructure/database/store'
import type { DeviceHub } from '../src/modules/device/device-hub'
import { AdminRepository } from '../src/modules/admin/admin.repository'
import { AdminService } from '../src/modules/admin/admin.service'

/** 管理员撤销设备时，设备状态和令牌必须处于同一数据库事务。 */
test('撤销设备：两次更新共用一个事务，先撤销凭据再更新设备状态', async () => {
  const events: string[] = []
  const where = jest.fn(async () => undefined)
  const set = jest.fn((value: unknown) => {
    events.push(JSON.stringify(value))
    return { where }
  })
  const update = jest.fn(() => ({ set }))
  const select = jest.fn(() => ({
    from: () => ({
      where: () => ({
        limit: () => ({
          for: async () => [{ id: 'device-1', userId: 'owner-1' }],
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve([{ userId: 'owner-1' }]).then(resolve),
        }),
      }),
    }),
  }))
  const tx = { update, select }
  const transaction = jest.fn(async (fn: (value: typeof tx) => Promise<void>) => {
    events.push('begin')
    const result = await fn(tx)
    events.push('commit')
    return result
  })
  const repo = new AdminRepository({ db: { transaction, select } } as unknown as Store)
  await expect(repo.revokeDevice('device-1')).resolves.toBe(true)
  expect(transaction).toHaveBeenCalledTimes(1)
  expect(update).toHaveBeenCalledTimes(2)
  expect(events[0]).toBe('begin')
  expect(events[1]).toContain('revokedAt')
  expect(events[2]).toContain('revoked')
  expect(events[3]).toBe('commit')
})

/** 数据库未成功提交时，Service 不应提前断开在线设备或记录成功审计。 */
test('撤销失败：不得断连设备或记录成功审计', async () => {
  const repository = {
    deviceById: jest.fn(async () => ({ id: 'device-1' })),
    revokeDevice: jest.fn(async () => {
      throw new Error('transaction failed')
    }),
  }
  const hub = { disconnect: jest.fn() }
  const store = { securityAudit: jest.fn() }
  const service = new AdminService(
    store as unknown as Store,
    hub as unknown as DeviceHub,
    repository as unknown as AdminRepository,
  )
  await expect(service.revokeDevice('admin-1', 'device-1')).rejects.toThrow('transaction failed')
  expect(hub.disconnect).not.toHaveBeenCalled()
  expect(store.securityAudit).not.toHaveBeenCalled()
})

test('撤销成功：提交后断连，随后记录审计', async () => {
  const events: string[] = []
  const repository = {
    deviceById: jest.fn(async () => ({ id: 'device-1' })),
    revokeDevice: jest.fn(async () => {
      events.push('commit')
      return true
    }),
  }
  const hub = { disconnect: jest.fn(() => events.push('disconnect')) }
  const store = {
    securityAudit: jest.fn(async () => {
      events.push('audit')
    }),
  }
  const service = new AdminService(
    store as unknown as Store,
    hub as unknown as DeviceHub,
    repository as unknown as AdminRepository,
  )
  await expect(service.revokeDevice('admin-1', 'device-1')).resolves.toEqual({ ok: true })
  expect(events).toEqual(['commit', 'disconnect', 'audit'])
})

/** 预查询后设备已删除或归属发生变化，不得误报成功或断开连接。 */
test('事务复查失败：管理员撤销不得断连或记录成功审计', async () => {
  const repository = {
    deviceById: jest.fn(async () => ({ id: 'device-1' })),
    revokeDevice: jest.fn(async () => false),
  }
  const hub = { disconnect: jest.fn() }
  const store = { securityAudit: jest.fn() }
  const service = new AdminService(
    store as unknown as Store,
    hub as unknown as DeviceHub,
    repository as unknown as AdminRepository,
  )
  await expect(service.revokeDevice('admin-1', 'device-1')).rejects.toThrow()
  expect(hub.disconnect).not.toHaveBeenCalled()
  expect(store.securityAudit).not.toHaveBeenCalled()
})
