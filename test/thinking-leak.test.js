import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanOutboundText, cleanOutboundSegments } from '../src/chat/reply.js'
import { promisify } from 'node:util'

test('无标记思考块：显式【思考】/括号内心段不发出', () => {
  assert.equal(cleanOutboundText('【思考】用户想要一个答案，我需要先判断。【/思考】好呀'), '好呀')
  assert.equal(cleanOutboundText('（思考：她在问我今天做了什么。）今天去散步了'), '今天去散步了')
})

test('无标记思考前缀：「思考过程」行与元信息行不会当正文', () => {
  assert.equal(cleanOutboundText('思考过程：用户问的是天气，我要简短回答。\n\n今天很晴朗。').trim(), '今天很晴朗。')
  assert.equal(cleanOutboundText('用户说想听笑话。我需要先判断一下。\n\n好呀，我说一个。').trim(), '好呀，我说一个。')
})

test('结构化推理开场后只保留最终回答', () => {
  const text = '用户说想让我讲个故事，我需要先分析一下。\n首先看场景，然后决定怎么回。\n最终回答：从前有一只小鱼。'
  assert.equal(cleanOutboundText(text), '从前有一只小鱼。')
})

test('正常正文不被误伤', () => {
  for (const text of ['分析：这个方案可行。', '我觉得（笑）这个思路很好。', '今天去散步了，风有点大。', '（笑）好呀']) {
    assert.equal(cleanOutboundText(text), text)
  }
})

test('消息段出口同样清掉思考块', () => {
  const out = cleanOutboundSegments([{ type: 'text', data: { text: '【思考】用户想让我回答。【/思考】好呀' } }])
  assert.deepEqual(out, [{ type: 'text', data: { text: '好呀' } }])
})
