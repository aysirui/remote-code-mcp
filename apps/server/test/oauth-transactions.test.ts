import type { Store } from '../src/infrastructure/database/store'
import { OAuthRepository } from '../src/modules/oauth/oauth.repository'
import { canonicalResource } from '../src/modules/oauth/oauth-utils'

let log: jest.SpyInstance
beforeEach(() => {
  log = jest.spyOn(console, 'info').mockImplementation(() => undefined)
})
afterEach(() => log.mockRestore())

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
  await expect(
    first.repository.rotateRefreshToken('hash', 'other-client', 'request-1'),
  ).resolves.toBeNull()
  expect(log).toHaveBeenCalledWith(expect.stringContaining('"reason":"client_mismatch"'))
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
  const diagnostic = JSON.parse(log.mock.calls[0][0])
  expect(diagnostic).toEqual(
    expect.objectContaining({
      event: 'token.refresh_replay_detected',
      tokenId: 'refresh-1',
      familyId: 'family-1',
      grantId: 'grant-1',
      consumedAt: state.refresh.consumedAt.toISOString(),
    }),
  )
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
  const diagnostic = JSON.parse(log.mock.calls[0][0])
  expect(diagnostic).toEqual(
    expect.objectContaining({
      event: 'token.refresh_rotating',
      tokenId: 'refresh-1',
      nextTokenId: expect.any(String),
      familyId: 'family-1',
    }),
  )
  expect(state.values).toHaveBeenCalledWith(expect.objectContaining({ id: diagnostic.nextTokenId }))
  expect(diagnostic).not.toHaveProperty('tokenHash')
  expect(JSON.stringify(diagnostic)).not.toContain(result!.refresh)
})

test('刷新：首次授权超过一小时且省略 client_id，仍按原归属签发令牌', async () => {
  jest.useFakeTimers()
  try {
    const state = setup()
    const refreshExpiresAt = new Date(Date.now() + 30 * 86400_000)
    state.refresh.expiresAt = refreshExpiresAt
    jest.setSystemTime(Date.now() + 63 * 60000)
    await expect(state.repository.rotateRefreshToken('hash', undefined)).resolves.toEqual({
      access: expect.any(String),
      refresh: expect.any(String),
      scope: 'mcp:tools',
    })
    expect(state.values).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: 'family-1',
        clientId: 'client-1',
        grantId: 'grant-1',
        expiresAt: refreshExpiresAt,
      }),
    )
    expect(state.values).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'client-1',
        userId: 'user-1',
        scope: 'mcp:tools',
        resource: canonicalResource(),
        expiresAt: new Date(Date.now() + 3600_000),
      }),
    )
  } finally {
    jest.useRealTimers()
  }
})

test('刷新：省略 client_id 仍拒绝令牌与授权关系的客户端不一致', async () => {
  const state = setup()
  state.grant.clientId = 'other-client'
  await expect(state.repository.rotateRefreshToken('hash', undefined)).resolves.toBeNull()
  expect(state.insert).not.toHaveBeenCalled()
  expect(state.update).not.toHaveBeenCalled()
})

test.each(['token_not_found', 'token_revoked', 'user_inactive'])(
  '刷新诊断：%s 记录具体原因和关联编号，不签发新令牌',
  async (reason) => {
    const state = setup()
    if (reason === 'token_not_found') state.locked.length = 0
    if (reason === 'token_revoked') state.refresh.revokedAt = new Date()
    if (reason === 'user_inactive') state.locked[2] = { id: 'user-1', status: 'disabled' }
    await expect(
      state.repository.rotateRefreshToken('secret-hash', undefined, 'request-1'),
    ).resolves.toBeNull()
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`"reason":"${reason}"`))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"requestId":"request-1"'))
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-hash')
    expect(state.insert).not.toHaveBeenCalled()
  },
)

test.each(['revoked', 'expired', 'replay'] as const)(
  '刷新：省略 client_id 不绕过 %s 校验',
  async (reason) => {
    const state = setup()
    if (reason === 'revoked') state.grant.revokedAt = new Date()
    if (reason === 'expired') state.refresh.expiresAt = new Date(Date.now() - 1000)
    if (reason === 'replay') state.refresh.consumedAt = new Date()
    await expect(state.repository.rotateRefreshToken('hash', undefined)).resolves.toEqual(
      reason === 'replay' ? { replay: true } : null,
    )
    expect(state.insert).not.toHaveBeenCalled()
  },
)

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
