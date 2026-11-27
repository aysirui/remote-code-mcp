import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveOAuthReturn } from '../src/composables/oauth-return.ts'

const publicUrl = 'https://rcm.example.com'
const consoleUrl = 'https://console.example.com'
const tunnel = 'https://example.ngrok-free.dev'
const authorize = (origin: string) =>
  origin + '/oauth/authorize?state=a%26b&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback'

test('生产独立子域名保留完整 OAuth 参数', () => {
  assert.deepEqual(resolveOAuthReturn(authorize(publicUrl), publicUrl, consoleUrl, false), {
    target: authorize(publicUrl),
  })
})

test('单域名隧道及普通 localhost 开发均支持回跳', () => {
  assert.equal(
    resolveOAuthReturn(authorize(tunnel), tunnel, tunnel, true).target,
    authorize(tunnel),
  )
  const local = 'http://localhost:3000'
  assert.equal(
    resolveOAuthReturn(authorize(local), local, 'http://localhost:5173', true).target,
    authorize(local),
  )
})

test('本地 Console 不能使用不同域名的隧道 Session', () => {
  assert.ok(resolveOAuthReturn(authorize(tunnel), tunnel, 'http://localhost:5173', true).error)
})

test('拒绝其他来源、非授权路径、非法地址及重复参数', () => {
  for (const value of [
    authorize('https://attacker.example'),
    publicUrl + '/api/auth/logout',
    publicUrl + '/oauth/authorize#fragment',
    'not-a-url',
    [authorize(publicUrl), authorize(publicUrl)],
  ]) {
    const result = resolveOAuthReturn(value, publicUrl, consoleUrl, false)
    assert.ok(result.error)
    assert.equal(result.target, undefined)
  }
  assert.deepEqual(resolveOAuthReturn(undefined, publicUrl, consoleUrl, false), {})
})
