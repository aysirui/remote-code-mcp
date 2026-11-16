import { NotFoundException } from '@nestjs/common'
import type { Store } from '../src/infrastructure/database/store'
import type { DeviceHub } from '../src/modules/device/device-hub'
import { AccountRepository } from '../src/modules/account/account.repository'
import { AccountService } from '../src/modules/account/account.service'

/** 工作区撤销墓碑与原授权删除必须位于同一事务。 */
function setup(found: boolean, failInsert = false) {
  const events: string[] = []
  const forUpdate = jest.fn(async () => (found ? [{ id: 'ws-1', deviceId: 'device-1' }] : []))
  const limit = jest.fn(() => ({
    for: forUpdate,
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve(found ? [{ deviceId: 'device-1' }] : []).then(resolve),
  }))
  const where = jest.fn(() => ({ limit }))
  const from = jest.fn(() => ({ where }))
  const select = jest.fn(() => ({ from }))
  const values = jest.fn(async (value: { id: string; deviceId: string; userId: string }) => {
    events.push('insert:' + value.id + ':' + value.deviceId + ':' + value.userId)
    if (failInsert) throw Error('insert failed')
  })
  const deleteWhere = jest.fn(async () => {
    events.push('delete')
  })
  const tx = {
    select,
    insert: jest.fn(() => ({ values })),
    delete: jest.fn(() => ({ where: deleteWhere })),
  }
  const transaction = jest.fn(async (fn: (value: typeof tx) => Promise<boolean>) => {
    events.push('begin')
    const result = await fn(tx)
    events.push('commit')
    return result
  })
  const repository = new AccountRepository({ db: { transaction, select } } as unknown as Store)
  return { repository, events, forUpdate, tx, transaction }
}

test('撤销已有工作区：先写墓碑再删除授权，事务提交后才返回成功', async () => {
  const state = setup(true)
  await expect(state.repository.revokeWorkspace('owner', 'ws-1')).resolves.toBe(true)
  expect(state.forUpdate).toHaveBeenCalledTimes(3)
  expect(state.events).toEqual(['begin', 'insert:ws-1:device-1:owner', 'delete', 'commit'])
})

test('不存在或不属于当前用户：不创建墓碑，也不删除授权', async () => {
  const state = setup(false)
  await expect(state.repository.revokeWorkspace('other', 'ws-1')).resolves.toBe(false)
  expect(state.tx.insert).not.toHaveBeenCalled()
  expect(state.tx.delete).not.toHaveBeenCalled()
})

test('墓碑写入失败：不删除授权，事务不得成功提交', async () => {
  const state = setup(true, true)
  await expect(state.repository.revokeWorkspace('owner', 'ws-1')).rejects.toThrow('insert failed')
  expect(state.tx.delete).not.toHaveBeenCalled()
  expect(state.events).not.toContain('commit')
})

test.each([false, new Error('database unavailable')])(
  '撤销未成功时不记录成功审计',
  async (result) => {
    const repository = {
      revokeWorkspace: jest.fn(async () => {
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
    await expect(service.revokeWorkspace('owner', 'ws-1')).rejects.toThrow(
      result === false ? NotFoundException : 'database unavailable',
    )
    expect(store.securityAudit).not.toHaveBeenCalled()
  },
)

test('成功撤销只记录结构化审计，不传输本地路径', async () => {
  const repository = { revokeWorkspace: jest.fn(async () => true) }
  const store = { securityAudit: jest.fn(async () => undefined) }
  const service = new AccountService(
    store as unknown as Store,
    {} as DeviceHub,
    repository as unknown as AccountRepository,
  )
  await expect(service.revokeWorkspace('owner', 'ws-1')).resolves.toEqual({ ok: true })
  expect(repository.revokeWorkspace).toHaveBeenCalledWith('owner', 'ws-1')
  expect(store.securityAudit).toHaveBeenCalledWith(
    expect.objectContaining({
      actorId: 'owner',
      resourceId: 'ws-1',
      eventType: 'workspace.revoke',
    }),
  )
})
