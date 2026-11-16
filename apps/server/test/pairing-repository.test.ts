import { BadRequestException, UnauthorizedException } from '@nestjs/common'
import type { Store } from '../src/infrastructure/database/store'
import { PairingRepository } from '../src/modules/device/pairing.repository'

/** 模拟行锁后的单条配对记录，覆盖批准、消费与异常事务路径。 */
function setup(status: 'pending' | 'approved' | 'consumed' = 'pending') {
  const pairing = {
    id: 'pair-1',
    deviceId: status === 'pending' ? null : 'device-1',
    deviceName: 'test runtime',
    platform: 'win32',
    status,
    secretHash: 'valid-secret',
    tokenCiphertext: status === 'approved' ? 'encrypted' : null,
    expiresAt: new Date(Date.now() + 60000),
  }
  const lock = jest.fn(async () => [pairing])
  const select = jest.fn(() => ({
    from: () => ({ where: () => ({ limit: () => ({ for: lock }) }) }),
  }))
  const insert = jest.fn(() => ({ values: jest.fn(async () => undefined) }))
  const set = jest.fn((values: Record<string, unknown>) => ({
    where: jest.fn(async () => {
      if (values.status) pairing.status = values.status as typeof pairing.status
      if ('tokenCiphertext' in values)
        pairing.tokenCiphertext = values.tokenCiphertext as string | null
      if ('deviceId' in values) pairing.deviceId = values.deviceId as string
    }),
  }))
  const update = jest.fn(() => ({ set }))
  const tx = { select, insert, update }
  const transaction = jest.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
    callback(tx),
  )
  const store = { db: { transaction } }
  const repository = new PairingRepository(store as unknown as Store)
  return { repository, pairing, lock, insert, update, transaction }
}

test('批准配对必须持有行锁，成功后创建凭据并标记 approved', async () => {
  const { repository, pairing, lock, insert } = setup()
  const encrypt = jest.fn(() => 'encrypted')
  await repository.approve('code-hash', 'owner', 'device-1', 'token-hash', encrypt)
  expect(lock).toHaveBeenCalledTimes(1)
  expect(insert).toHaveBeenCalledTimes(2)
  expect(encrypt).toHaveBeenCalledTimes(1)
  expect(pairing.status).toBe('approved')
  expect(pairing.tokenCiphertext).toBe('encrypted')
})

test('重复批准、过期批准都拒绝，且不得创建设备或加密凭据', async () => {
  for (const reason of ['approved', 'expired'] as const) {
    const { repository, pairing, insert } = setup(reason === 'approved' ? 'approved' : 'pending')
    if (reason === 'expired') pairing.expiresAt = new Date(Date.now() - 1000)
    const encrypt = jest.fn(() => 'encrypted')
    await expect(
      repository.approve('code', 'owner', 'device', 'hash', encrypt),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(insert).not.toHaveBeenCalled()
    expect(encrypt).not.toHaveBeenCalled()
  }
})

test('领取配对仅允许有效私有凭据，成功后清除密文且不可重复领取', async () => {
  const { repository, pairing, lock } = setup('approved')
  const decrypt = jest.fn(() => 'device-token')
  await expect(repository.complete('pair-1', 'invalid', decrypt)).rejects.toBeInstanceOf(
    UnauthorizedException,
  )
  expect(decrypt).not.toHaveBeenCalled()
  await expect(repository.complete('pair-1', 'valid-secret', decrypt)).resolves.toEqual({
    status: 'complete',
    deviceId: 'device-1',
    token: 'device-token',
  })
  expect(lock).toHaveBeenCalledTimes(2)
  expect(pairing.status).toBe('consumed')
  expect(pairing.tokenCiphertext).toBeNull()
  await expect(repository.complete('pair-1', 'valid-secret', decrypt)).rejects.toBeInstanceOf(
    BadRequestException,
  )
  expect(decrypt).toHaveBeenCalledTimes(1)
})

test('未批准返回 pending，过期和解密失败不消费配对记录', async () => {
  const pending = setup()
  await expect(pending.repository.complete('pair-1', 'valid-secret', jest.fn())).resolves.toEqual({
    status: 'pending',
  })
  const expired = setup('approved')
  expired.pairing.expiresAt = new Date(Date.now() - 1000)
  await expect(
    expired.repository.complete('pair-1', 'valid-secret', jest.fn()),
  ).rejects.toBeInstanceOf(BadRequestException)
  const broken = setup('approved')
  await expect(
    broken.repository.complete('pair-1', 'valid-secret', () => {
      throw new Error('decrypt failed')
    }),
  ).rejects.toThrow('decrypt failed')
  expect(broken.pairing.status).toBe('approved')
  expect(broken.pairing.tokenCiphertext).toBe('encrypted')
})
