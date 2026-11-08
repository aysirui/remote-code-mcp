import { hash, secret } from '../src/core'
test('token hashes are deterministic but do not expose plaintext', () => {
  const a = secret()
  expect(hash(a)).toBe(hash(a))
  expect(hash(a)).not.toContain(a)
})
