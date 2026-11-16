import { NotFoundException } from '@nestjs/common'
import { AccountRepository } from '../src/modules/account/account.repository'
import { AccountService } from '../src/modules/account/account.service'
import type { Store } from '../src/infrastructure/database/store'
import type { DeviceHub } from '../src/modules/device/device-hub'

/** OAuth 授权撤销：锁定归属授权，所有凭据在一个事务中失效。 */
function repositorySetup(found: boolean) {
  const events: string[] = []
  const forUpdate = jest.fn(async () => (found ? [{ id: 'grant-1' }] : []))
  const limit = jest.fn(() => ({ for: forUpdate }))
  const selectWhere = jest.fn(() => ({ limit }))
  const from = jest.fn(() => ({ where: selectWhere }))
  const select = jest.fn(() => ({ from }))
  const updateWhere = jest.fn(async () => undefined)
  const set = jest.fn((data: { revokedAt: Date }) => {
    events.push('revoke:' + data.revokedAt.getTime())
    return { where: updateWhere }
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

test('授权存在时：同一事务撤销 Refresh、Access 和 Grant，时间戳一致', async () => {
  const state = repositorySetup(true)
  await expect(state.repository.revokeOauth('user-1', 'client-1')).resolves.toBe(true)
  expect(state.forUpdate).toHaveBeenCalledTimes(1)
  expect(state.update).toHaveBeenCalledTimes(3)
  expect(state.events[0]).toBe('begin')
  expect(new Set(state.events.slice(1, 4)).size).toBe(1)
  expect(state.events[4]).toBe('commit')
})

test('当前用户没有该授权时：不撤销任何凭据', async () => {
  const state = repositorySetup(false)
  await expect(state.repository.revokeOauth('user-2', 'client-1')).resolves.toBe(false)
  expect(state.update).not.toHaveBeenCalled()
})

/** 只有真实授权撤销成功后才写成功审计。 */
test.each([false, new Error('transaction failed')])('撤销失败时不得写成功审计', async (result) => {
  const repository = {
    revokeOauth: jest.fn(async () => {
      if (result instanceof Error) throw result
      return result
    }),
  }
  const store = { securityAudit: jest.fn() }
  const service = new AccountService(
    store as unknown as Store,
    {} as DeviceHub,
    repository as unknown as AccountRepository,
  )
  await expect(service.revokeOauth('user-1', 'client-1')).rejects.toThrow(
    result === false ? NotFoundException : 'transaction failed',
  )
  expect(store.securityAudit).not.toHaveBeenCalled()
})

test('撤销成功后记录结构化审计', async () => {
  const repository = { revokeOauth: jest.fn(async () => true) }
  const store = { securityAudit: jest.fn(async () => undefined) }
  const service = new AccountService(
    store as unknown as Store,
    {} as DeviceHub,
    repository as unknown as AccountRepository,
  )
  await expect(service.revokeOauth('user-1', 'client-1')).resolves.toEqual({ ok: true })
  expect(store.securityAudit).toHaveBeenCalledWith(
    expect.objectContaining({
      actorId: 'user-1',
      resourceId: 'client-1',
      eventType: 'oauth.grant.revoke',
    }),
  )
})
