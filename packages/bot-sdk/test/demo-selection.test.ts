import assert from 'node:assert/strict'
import { test } from 'node:test'
import { demoSelection } from '../src/demo/selection.js'

const click = { botId: 'bot', actorId: 'user', cardId: 'card', actionId: 'button1' }

test('只有指定用户在指定机器人卡片上能改变演示状态，只保留首次选择', () => {
  const decide = demoSelection('bot', 'user', 'card', 100)
  assert.equal(decide({ ...click, actorId: 'other' }, 10), undefined)
  assert.equal(decide({ ...click, botId: 'other' }, 10), undefined)
  assert.equal(decide({ ...click, cardId: 'other' }, 10), undefined)
  assert.equal(decide({ ...click, actionId: 'unknown' }, 10), undefined)
  assert.equal(decide(click, 10), 'button1')
  assert.equal(decide({ ...click, actionId: 'button2' }, 20), 'button1')
})

test('截止后返回过期；截止前可选择第二个按钮', () => {
  assert.equal(demoSelection('bot', 'user', 'card', 100)(click, 100), 'expired')
  assert.equal(
    demoSelection('bot', 'user', 'card', 100)({ ...click, actionId: 'button2' }, 99),
    'button2',
  )
})
