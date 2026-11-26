import test from 'node:test'
import assert from 'node:assert/strict'
import { parseReply } from '../src/chat/reply.js'

const text = value => ({ kind: 'text', value })
const parse = (...parts) => parseReply(parts.join('|||')).items

test('文字超过五条时，语音、图片和表情前后的文字仍按原序发送', () => {
  for (const [markup, item] of [
    ['<voice>先听</voice>', { kind: 'voice', value: '先听' }],
    ['<sticker:点头>', { kind: 'sticker', value: '点头' }],
    ['![图](./example.png)', { kind: 'image', value: './example.png' }],
  ]) {
    assert.deepEqual(parse('甲','乙','丙','丁','戊',markup,'庚'), [text('甲'),text('乙'),text('丙'),text('丁\n戊'),item,text('庚')])
  }
})

test('引用随原来的文字，后续文字可以和它合并', () => {
  assert.deepEqual(parse('甲','乙','丙','丁','戊','<reply:2>己','庚'), [text('甲'),text('乙'),text('丙'),text('丁\n戊'),{ ...text('己\n庚'), replyTo:'2' }])
})

test('文字条条隔着语音时，每一条都留在原处', () => {
  const parts = Array.from({length:6}, (_,i) => [`第${i}句`, '<voice>嗯</voice>']).flat()
  assert.deepEqual(parse(...parts), parts.map((value,i) => i % 2 ? {kind:'voice',value:'嗯'} : text(value)))
})
