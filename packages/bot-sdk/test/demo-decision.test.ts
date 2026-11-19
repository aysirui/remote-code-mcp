import assert from 'node:assert/strict'
import { test } from 'node:test'
import { demoDecision } from '../src/demo/decision.js'

const click = { botId: 'bot', actorId: 'user', cardId: 'card', actionId: 'approve' }

test('只有指定用户在指定机器人卡片上能改变演示状态，决定只结算一次', () => {
  const decide = demoDecision('bot', 'user', 'card', 100)
  assert.equal(decide({ ...click, actorId: 'other' }, 10), undefined)
  assert.equal(decide({ ...click, botId: 'other' }, 10), undefined)
  assert.equal(decide({ ...click, cardId: 'other' }, 10), undefined)
  assert.equal(decide({ ...click, actionId: 'unknown' }, 10), undefined)
  assert.equal(decide(click, 10), 'approved')
  assert.equal(decide({ ...click, actionId: 'reject' }, 20), 'approved')
})

test('过期操作不能通过；截止前可以拒绝', () => {
  assert.equal(demoDecision('bot', 'user', 'card', 100)(click, 100), 'expired')
  assert.equal(
    demoDecision('bot', 'user', 'card', 100)({ ...click, actionId: 'reject' }, 99),
    'rejected',
  )
})
