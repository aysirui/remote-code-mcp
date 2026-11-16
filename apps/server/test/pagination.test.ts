import type { Request } from 'express'
import type { Identity } from '../src/modules/core/identity'
import type { Store } from '../src/infrastructure/database/store'
import type { DeviceHub } from '../src/modules/device/device-hub'
import { parsePagination } from '../src/common/pagination'
import { AccountController } from '../src/modules/account/account.controller'
import { AccountService } from '../src/modules/account/account.service'
import { AccountRepository } from '../src/modules/account/account.repository'
import { AdminController } from '../src/modules/admin/admin.controller'
import { AdminService } from '../src/modules/admin/admin.service'
import { AdminRepository } from '../src/modules/admin/admin.repository'

test('分页参数保持旧客户端兼容并限制查询大小', () => {
  expect(parsePagination({})).toBeUndefined()
  expect(parsePagination({ page: '3', pageSize: '20' })).toEqual({
    page: 3,
    pageSize: 20,
    offset: 40,
  })
  expect(parsePagination({ page: '1' })).toEqual({ page: 1, pageSize: 20, offset: 0 })
  for (const value of ['0', '-1', '1.5', 'abc', ['1'], '1000001'])
    expect(() => parsePagination({ page: value })).toThrow()
  expect(() => parsePagination({ pageSize: '101' })).toThrow()
})

/** 用链式查询替身校验真实控制器调用，确保分页仍经过鉴权并保留用户过滤。 */
function database() {
  interface QueryDouble {
    from: jest.Mock
    where: jest.Mock
    orderBy: jest.Mock
    limit: jest.Mock
    offset: jest.Mock
    then: (resolve: (value: unknown) => unknown) => Promise<unknown>
  }
  const queries: QueryDouble[] = []
  const db = {
    select: jest.fn((selection?: unknown) => {
      const result =
        selection && Object.keys(selection).includes('total') ? [{ total: 43 }] : [{ id: 'record' }]
      const query: QueryDouble = {
        from: jest.fn(),
        where: jest.fn(),
        orderBy: jest.fn(),
        limit: jest.fn(),
        offset: jest.fn(),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
      }
      for (const method of ['from', 'where', 'orderBy', 'limit', 'offset'] as const)
        query[method] = jest.fn(() => query)
      queries.push(query)
      return query
    }),
  }
  return { db, queries }
}

test('个人记录分页的数据和总数查询都必须限制为当前用户', async () => {
  const store = database()
  const identity = { requireUser: jest.fn().mockResolvedValue({ id: 'owner' }) }
  const controller = new AccountController(
    identity as unknown as Identity,
    new AccountService(
      store as unknown as Store,
      {} as DeviceHub,
      new AccountRepository(store as unknown as Store),
    ),
  )
  const result = await controller.operationLogs({
    query: { page: '3', pageSize: '20' },
  } as unknown as Request)
  expect(identity.requireUser).toHaveBeenCalledTimes(1)
  expect(result).toMatchObject({ items: [{ id: 'record' }], total: 43, page: 3, pageSize: 20 })
  expect(store.queries[0].offset).toHaveBeenCalledWith(40)
  expect(store.queries[0].limit).toHaveBeenCalledWith(20)
  expect(store.queries[0].where).toHaveBeenCalledTimes(1)
  expect(store.queries[1].where).toHaveBeenCalledWith(store.queries[0].where.mock.calls[0][0])
})

test('管理用户和审计分页保留管理员鉴权及稳定排序', async () => {
  for (const method of ['users', 'securityAudits'] as const) {
    const store = database()
    const identity = { requireAdmin: jest.fn().mockResolvedValue({ id: 'admin' }) }
    const controller = new AdminController(
      identity as unknown as Identity,
      new AdminService(
        store as unknown as Store,
        {} as DeviceHub,
        new AdminRepository(store as unknown as Store),
      ),
    )
    await expect(
      controller[method]({ query: { page: '2' } } as unknown as Request),
    ).resolves.toMatchObject({
      total: 43,
      page: 2,
    })
    expect(identity.requireAdmin).toHaveBeenCalledTimes(1)
    expect(store.queries[0].orderBy.mock.calls[0]).toHaveLength(2)
    expect(store.queries[0].offset).toHaveBeenCalledWith(20)
  }
})

test('平台设备分页附带在线状态，旧请求仍返回数组', async () => {
  const store = database()
  const identity = { requireAdmin: jest.fn().mockResolvedValue({ id: 'admin' }) }
  const hub = { isOnline: jest.fn().mockReturnValue(true) }
  const controller = new AdminController(
    identity as unknown as Identity,
    new AdminService(
      store as unknown as Store,
      hub as unknown as DeviceHub,
      new AdminRepository(store as unknown as Store),
    ),
  )
  await expect(
    controller.adminDevices({ query: { page: '1', pageSize: '10' } } as unknown as Request),
  ).resolves.toMatchObject({ items: [{ id: 'record', online: true }], total: 43 })
  await expect(controller.adminDevices({ query: {} } as unknown as Request)).resolves.toEqual([
    { id: 'record', online: true },
  ])
})

test('分页接口鉴权失败时不会读取数据库', async () => {
  const store = database()
  const identity = { requireAdmin: jest.fn().mockRejectedValue(Error('FORBIDDEN')) }
  const controller = new AdminController(
    identity as unknown as Identity,
    new AdminService(
      store as unknown as Store,
      {} as DeviceHub,
      new AdminRepository(store as unknown as Store),
    ),
  )
  await expect(controller.users({ query: { page: '1' } } as unknown as Request)).rejects.toThrow(
    'FORBIDDEN',
  )
  expect(store.db.select).not.toHaveBeenCalled()
})
