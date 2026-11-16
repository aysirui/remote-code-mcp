import { NotFoundException } from '@nestjs/common'
import { AccountRepository } from '../src/modules/account/account.repository'
import { AccountService } from '../src/modules/account/account.service'
import type { Store } from '../src/infrastructure/database/store'
import type { DeviceHub } from '../src/modules/device/device-hub'

/** 设备撤销在事务内复查用户归属，避免预查询后的权限竞态。 */
function repositorySetup(found: boolean) {
  const events: string[] = []
  const forUpdate = jest.fn(async () => (found ? [{ id: 'device-1' }] : []))
  const limit = jest.fn(() => ({ for: forUpdate }))
  const where = jest.fn(async () => undefined)
  const selectWhere = jest.fn(() => ({ limit }))
  const from = jest.fn(() => ({ where: selectWhere }))
  const select = jest.fn(() => ({ from }))
  const set = jest.fn((fields: unknown) => {
    events.push(JSON.stringify(fields))
    return { where }
  })
  const update = jest.fn(() => ({ set }))
  const tx = { select, update }
  const transaction = jest.fn(async (fn: (value: typeof tx) => Promise<boolean>) => {
    events.push('begin')
    const result = await fn(tx)
    events.push('commit')
    return result
  })
  const repository = new AccountRepository({ db: { transaction } } as unknown as Store)
  return { repository, events, forUpdate, update, transaction }
}

test('归属校验成功：同一事务内撤销令牌及设备', async () => {
  const state = repositorySetup(true)
  await expect(state.repository.revokeDevice('user-1', 'device-1')).resolves.toBe(true)
  expect(state.forUpdate).toHaveBeenCalledTimes(2)
  expect(state.update).toHaveBeenCalledTimes(2)
  expect(state.events[0]).toBe('begin')
  expect(state.events[1]).toContain('revokedAt')
  expect(state.events[2]).toContain('revoked')
  expect(state.events[3]).toBe('commit')
})

test('事务内设备归属不匹配：不得修改设备或凭据', async () => {
  const state = repositorySetup(false)
  await expect(state.repository.revokeDevice('other-user', 'device-1')).resolves.toBe(false)
  expect(state.forUpdate).toHaveBeenCalledTimes(1)
  expect(state.update).not.toHaveBeenCalled()
})

/** 业务层只在事务确认撤销成功后执行网络副作用和安全审计。 */
function serviceSetup(result: boolean | Error) {
  const events: string[] = []
  const repository = {
    ownedDevice: jest.fn(async () => ({ id: 'device-1' })),
    revokeDevice: jest.fn(async () => {
      if (result instanceof Error) throw result
      events.push('commit')
      return result
    }),
  }
  const hub = { disconnect: jest.fn(() => events.push('disconnect')) }
  const store = {
    securityAudit: jest.fn(async () => {
      events.push('audit')
    }),
  }
  const service = new AccountService(
    store as unknown as Store,
    hub as unknown as DeviceHub,
    repository as unknown as AccountRepository,
  )
  return { events, repository, hub, store, service }
}

test('用户撤销设备成功：提交后断连并审计', async () => {
  const state = serviceSetup(true)
  await expect(state.service.revokeDevice('user-1', 'device-1')).resolves.toEqual({ ok: true })
  expect(state.repository.revokeDevice).toHaveBeenCalledWith('user-1', 'device-1')
  expect(state.events).toEqual(['commit', 'disconnect', 'audit'])
})

test.each([false, new Error('transaction failed')])(
  '撤销未成功时不得断连或审计',
  async (result) => {
    const state = serviceSetup(result)
    await expect(state.service.revokeDevice('user-1', 'device-1')).rejects.toThrow(
      result === false ? NotFoundException : 'transaction failed',
    )
    expect(state.hub.disconnect).not.toHaveBeenCalled()
    expect(state.store.securityAudit).not.toHaveBeenCalled()
  },
)
