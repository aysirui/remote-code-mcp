import { OAuthRepository } from '../src/modules/oauth/oauth.repository'
import type { Store } from '../src/infrastructure/database/store'
import { canonicalResource } from '../src/modules/oauth/oauth-utils'

/** 模拟一次性确认记录的行锁与事务写入；真实数据库并发另行集成验证。 */
function setup() {
  const consent = {
    id: 'consent-1',
    csrfHash: 'csrf-hash',
    userId: 'user-1',
    expiresAt: new Date(Date.now() + 60000),
    consumedAt: null as Date | null,
  }
  const client = {
    clientId: 'client-1',
    redirectUris: JSON.stringify(['https://client.example/callback']),
  }
  const forUpdate = jest.fn(async () => [consent])
  const limit = jest.fn(() => ({
    for: forUpdate,
    then: (resolve: (rows: unknown[]) => unknown) => resolve([client]),
  }))
  const where = jest.fn(() => ({ limit }))
  const from = jest.fn(() => ({ where }))
  const select = jest.fn(() => ({ from }))
  const updateWhere = jest.fn(async () => undefined)
  const set = jest.fn(() => ({ where: updateWhere }))
  const update = jest.fn(() => ({ set }))
  const values = jest.fn(async () => undefined)
  const insert = jest.fn(() => ({ values }))
  const tx = { select, update, insert }
  const transaction = jest.fn(async (fn: (value: typeof tx) => Promise<boolean>) => fn(tx))
  const repository = new OAuthRepository({ db: { transaction } } as unknown as Store)
  const params = {
    csrfHash: 'csrf-hash',
    userId: 'user-1',
    codeHash: 'code-hash',
    clientId: 'client-1',
    redirectUri: 'https://client.example/callback',
    codeChallenge: 'A'.repeat(43),
    scope: 'mcp:tools',
    resource: canonicalResource(),
    expiresAt: new Date(Date.now() + 300000),
  }
  return {
    repository,
    consent,
    client,
    forUpdate,
    update,
    updateWhere,
    insert,
    values,
    transaction,
    params,
  }
}

test('授权确认成功：行锁后同一事务内消费并签发授权码', async () => {
  const state = setup()
  await expect(state.repository.consumeConsentAndCreateCode(state.params)).resolves.toBe(true)
  expect(state.transaction).toHaveBeenCalledTimes(1)
  expect(state.forUpdate).toHaveBeenCalledTimes(1)
  expect(state.update).toHaveBeenCalledTimes(1)
  expect(state.insert).toHaveBeenCalledTimes(1)
  expect(state.values).toHaveBeenCalledWith(
    expect.objectContaining({
      codeHash: 'code-hash',
      userId: 'user-1',
      clientId: 'client-1',
    }),
  )
})

test.each(['consumed', 'expired', 'wrong-user'] as const)(
  '授权确认 %s：不得再次签发授权码',
  async (reason) => {
    const state = setup()
    if (reason === 'consumed') state.consent.consumedAt = new Date()
    if (reason === 'expired') state.consent.expiresAt = new Date(Date.now() - 1000)
    const params =
      reason === 'wrong-user' ? { ...state.params, userId: 'other-user' } : state.params
    await expect(state.repository.consumeConsentAndCreateCode(params)).resolves.toBe(false)
    expect(state.update).not.toHaveBeenCalled()
    expect(state.insert).not.toHaveBeenCalled()
  },
)

test('回调 URI 不在注册列表中时不得消费授权确认', async () => {
  const state = setup()
  await expect(
    state.repository.consumeConsentAndCreateCode({
      ...state.params,
      redirectUri: 'https://attacker.example/callback',
    }),
  ).resolves.toBe(false)
  expect(state.update).not.toHaveBeenCalled()
  expect(state.insert).not.toHaveBeenCalled()
})

test('授权码写入失败时事务错误向上传递，不得向客户端报告授权成功', async () => {
  const state = setup()
  state.values.mockRejectedValueOnce(new Error('insert failed'))
  await expect(state.repository.consumeConsentAndCreateCode(state.params)).rejects.toThrow(
    'insert failed',
  )
  expect(state.transaction).toHaveBeenCalledTimes(1)
})
