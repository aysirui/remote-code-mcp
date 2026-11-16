import { BadRequestException, ForbiddenException } from '@nestjs/common'
import type { Store } from '../src/infrastructure/database/store'
import type { DeviceHub } from '../src/modules/device/device-hub'
import { AdminService } from '../src/modules/admin/admin.service'
import type { AdminRepository } from '../src/modules/admin/admin.repository'

/** 验证管理员禁用用户时的事务边界与网络副作用顺序。 */
function setup() {
  const events: string[] = []
  const repository = {
    userById: jest.fn().mockResolvedValue({ id: 'target', role: 'user' }),
    updateUserStatus: jest.fn().mockImplementation(async () => {
      events.push('commit')
      return ['device-a', 'device-b']
    }),
  }
  const hub = { disconnect: jest.fn((id: string) => events.push('disconnect:' + id)) }
  const store = { securityAudit: jest.fn(async () => events.push('audit')) }
  const service = new AdminService(
    store as unknown as Store,
    hub as unknown as DeviceHub,
    repository as unknown as AdminRepository,
  )
  return { events, repository, hub, store, service }
}

test('禁用成功：数据库提交后才断连，最后写安全审计', async () => {
  const { service, events, repository } = setup()
  await expect(
    service.changeUserStatus({ id: 'admin', role: 'admin' }, 'target', 'disabled'),
  ).resolves.toEqual({ ok: true })
  expect(repository.updateUserStatus).toHaveBeenCalledWith('target', 'disabled')
  expect(events).toEqual(['commit', 'disconnect:device-a', 'disconnect:device-b', 'audit'])
})

test('事务失败：不提前断连，也不记录成功审计', async () => {
  const { service, repository, hub, store } = setup()
  repository.updateUserStatus.mockRejectedValueOnce(new Error('transaction rolled back'))
  await expect(
    service.changeUserStatus({ id: 'admin', role: 'admin' }, 'target', 'disabled'),
  ).rejects.toThrow('transaction rolled back')
  expect(hub.disconnect).not.toHaveBeenCalled()
  expect(store.securityAudit).not.toHaveBeenCalled()
})

test('角色边界：禁止修改自己及越权修改管理员', async () => {
  const { service, repository } = setup()
  await expect(
    service.changeUserStatus({ id: 'target', role: 'admin' }, 'target', 'disabled'),
  ).rejects.toBeInstanceOf(ForbiddenException)
  repository.userById.mockResolvedValueOnce({ id: 'target', role: 'admin' })
  await expect(
    service.changeUserStatus({ id: 'admin', role: 'admin' }, 'target', 'disabled'),
  ).rejects.toBeInstanceOf(ForbiddenException)
  expect(repository.updateUserStatus).not.toHaveBeenCalled()
})

test('非法状态在写入数据库之前拒绝', async () => {
  const { service, repository } = setup()
  await expect(
    service.changeUserStatus({ id: 'admin', role: 'admin' }, 'target', 'pending'),
  ).rejects.toBeInstanceOf(BadRequestException)
  expect(repository.updateUserStatus).not.toHaveBeenCalled()
})
