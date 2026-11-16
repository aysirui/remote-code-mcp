import { ForbiddenException } from '@nestjs/common'
import { Identity } from '../src/modules/core/identity'
import type { Store } from '../src/infrastructure/database/store'

describe('administrator initialization boundary', () => {
  const originalAdminEmail = process.env.ADMIN_EMAIL
  afterEach(() => {
    if (originalAdminEmail === undefined) delete process.env.ADMIN_EMAIL
    else process.env.ADMIN_EMAIL = originalAdminEmail
    jest.restoreAllMocks()
  })

  test('public registration can never claim reserved ADMIN_EMAIL', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com'
    const identity = new Identity({} as Store)
    await expect(identity.register('ADMIN@example.com', 'a-strong-password-123')).rejects.toThrow(
      'Reserved administrator address',
    )
  })

  test('a session requiring a password change cannot access guarded APIs', async () => {
    const identity = new Identity({} as Store)
    jest.spyOn(identity, 'userBySession').mockResolvedValue({
      id: 'user-id',
      status: 'active',
      passwordChangeRequired: true,
    } as Awaited<ReturnType<Identity['userBySession']>>)
    await expect(
      identity.requireUser({} as Parameters<Identity['requireUser']>[0]),
    ).rejects.toThrow(ForbiddenException)
  })
})
