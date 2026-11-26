import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_OUTBOUND_CHARS, capOutboundSegments } from '../src/chat/reply.js'

const text = (value) => ({ type: 'text', data: { text: value } })
const quote = { type: 'reply', data: { id: '42' } }
const image = { type: 'image', data: { file: 'base64://AAAA' } }

test('短消息原样放行', () => {
  const message = [text('在吗')]
  const out = capOutboundSegments(message)
  assert.equal(out.trimmed, false)
  assert.equal(out.total, 2)
  assert.equal(out.message, message)
})

test('正好等于上限不截断', () => {
  const out = capOutboundSegments([text('鱼'.repeat(1500))])
  assert.equal(out.trimmed, false)
  assert.equal(out.total, 1500)
  assert.equal(out.message[0].data.text.length, 1500)
})

test('超过上限截到 1500 字，保留开头', () => {
  const out = capOutboundSegments([text('在吗'.repeat(27000))])
  assert.equal(out.trimmed, true)
  assert.equal(out.total, 54000)
  assert.equal(out.message.length, 1)
  assert.equal(out.message[0].data.text, '在吗'.repeat(750))
})

test('多段文字按顺序吃掉额度', () => {
  const out = capOutboundSegments([text('a'.repeat(1000)), text('b'.repeat(1000))])
  assert.equal(out.message.length, 2)
  assert.equal(out.message[0].data.text.length, 1000)
  assert.equal(out.message[1].data.text.length, 500)
})

test('额度用完后不留下空文字段', () => {
  const out = capOutboundSegments([text('a'.repeat(1500)), text('b')])
  assert.equal(out.message.length, 1)
  assert.equal(out.message[0].data.text.length, 1500)
})

test('引用与图片段原样保留', () => {
  const out = capOutboundSegments([quote, text('x'.repeat(2000)), image])
  assert.equal(out.message.length, 3)
  assert.equal(out.message[0], quote)
  assert.equal(out.message[1].data.text.length, 1500)
  assert.equal(out.message[2], image)
})

test('上限可覆盖，默认 1500', () => {
  assert.equal(MAX_OUTBOUND_CHARS, 1500)
  const out = capOutboundSegments([text('很长的一段话')], 3)
  assert.equal(out.trimmed, true)
  assert.equal(out.message[0].data.text, '很长的')
})
