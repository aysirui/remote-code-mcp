import type { Store } from '../src/infrastructure/database/store'
import { OAuthRepository } from '../src/modules/oauth/oauth.repository'
import { canonicalResource } from '../src/modules/oauth/oauth-utils'

/** 模拟 Drizzle 事务内的行锁和写入，检查安全拒绝路径与事务副作用。 */
function setup() {
  const now = new Date(Date.now() + 60000)
  const code = {
    id: 'code-1',
    userId: 'user-1',
    clientId: 'client-1',
    redirectUri: 'https://client.example/callback',
    resource: canonicalResource(),
    codeChallenge: 'challenge',
    scope: 'mcp:tools',
    expiresAt: now,
  }
  const refresh = {
    id: 'refresh-1',
    clientId: 'client-1',
    grantId: 'grant-1',
    familyId: 'family-1',
    expiresAt: now,
    revokedAt: null as Date | null,
    consumedAt: null as Date | null,
  }
  const grant = {
    id: 'grant-1',
    clientId: 'client-1',
    userId: 'user-1',
    resource: canonicalResource(),
    scope: 'mcp:tools',
    revokedAt: null as Date | null,
  }
  const locked = [refresh, grant, { id: 'user-1', status: 'active' }]
  let index = 0
  const forUpdate = jest.fn(async () => [locked[index++]])
  const limit = jest.fn(() => ({
    for: forUpdate,
    then: (resolve: (value: unknown[]) => unknown) => resolve([locked[index++]]),
  }))
  const where = jest.fn(() => ({ limit }))
  const from = jest.fn(() => ({ where }))
  const select = jest.fn(() => ({ from }))
  const set = jest.fn(() => ({ where: jest.fn(async () => undefined) }))
  const update = jest.fn(() => ({ set }))
  const values = jest.fn(async () => undefined)
  const insert = jest.fn(() => ({ values }))
  const remove = jest.fn(() => ({ where: jest.fn(async () => undefined) }))
  const tx = { select, update, insert, delete: remove }
  const transaction = jest.fn(async (callback: (value: typeof tx) => Promise<unknown>) =>
    callback(tx),
  )
  const repository = new OAuthRepository({ db: { transaction } } as unknown as Store)
  return {
    repository,
    code,
    refresh,
    grant,
    locked,
    set,
    update,
    insert,
    values,
    remove,
    forUpdate,
    transaction,
  }
}

test('刷新：错误客户端或过期凭据不得签发令牌', async () => {
  const first = setup()
  await expect(first.repository.rotateRefreshToken('hash', 'other-client')).resolves.toBeNull()
  expect(first.insert).not.toHaveBeenCalled()
  const expired = setup()
  expired.refresh.expiresAt = new Date(Date.now() - 1000)
  await expect(expired.repository.rotateRefreshToken('hash', 'client-1')).resolves.toBeNull()
  expect(expired.insert).not.toHaveBeenCalled()
})

test('刷新：旧令牌重放撤销令牌族和相关 Access Token，不签发新凭据', async () => {
  const state = setup()
  state.refresh.consumedAt = new Date()
  await expect(state.repository.rotateRefreshToken('hash', 'client-1')).resolves.toEqual({
    replay: true,
  })
  expect(state.update).toHaveBeenCalledTimes(2)
  expect(state.insert).not.toHaveBeenCalled()
  expect(state.set).toHaveBeenCalledWith(expect.objectContaining({ revokedAt: expect.any(Date) }))
})

test('刷新：有效令牌消费旧令牌并签发新 Access/Refresh', async () => {
  const state = setup()
  const result = await state.repository.rotateRefreshToken('hash', 'client-1')
  expect(result).toEqual({
    access: expect.any(String),
    refresh: expect.any(String),
    scope: 'mcp:tools',
  })
  expect(state.forUpdate).toHaveBeenCalledTimes(2)
  expect(state.insert).toHaveBeenCalledTimes(2)
  expect(state.update).toHaveBeenCalledTimes(2)
})

test('授权码：行锁检查失败时不得删除授权码或签发凭据', async () => {
  const state = setup()
  state.locked[0] = {
    ...state.code,
    expiresAt: new Date(Date.now() - 1000),
  } as unknown as typeof state.refresh
  const redeemed = await state.repository.redeemAuthorizationCode({
    codeId: 'code-1',
    clientId: 'client-1',
    redirectUri: state.code.redirectUri,
    resource: state.code.resource,
    codeChallenge: state.code.codeChallenge,
    access: 'access',
    refresh: 'refresh',
  })
  expect(redeemed).toBe(false)
  expect(state.remove).not.toHaveBeenCalled()
  expect(state.insert).not.toHaveBeenCalled()
})
