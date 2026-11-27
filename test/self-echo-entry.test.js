// 网关上报本号自己发的消息时（reportSelfMessage），只有「群聊里的纯文字、且不是她刚发出去的那条」
// 才补进群聊上下文；其余一律不补，避免重复和噪音。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selfEchoEntry } from '../src/chat/hub.js'

const msg = (patch = {}) => ({
  kind: 'group', chatId: 'group:1', groupId: '1', userId: '42', nickname: '某人',
  text: '前台说有人找', messageId: '9001', replyId: '', ...patch,
})

test('群聊里的文字补进上下文，并标成本号', () => {
  const e = selfEchoEntry(msg(), { sentIds: new Set() })
  assert.equal(e.nick, '你（本号）')
  assert.equal(e.text, '前台说有人找')
  assert.equal(e.self, true)
  assert.equal(e.mid, '9001')
})

test('私聊不补（私聊有自己的上下文路径）', () => {
  assert.equal(selfEchoEntry(msg({ kind: 'private', chatId: 'private:42' }), { sentIds: new Set() }), null)
})

test('她自己刚发出去的那条不重复补', () => {
  assert.equal(selfEchoEntry(msg(), { sentIds: new Set(['9001']) }), null)
  // 别的 id 不受影响
  assert.ok(selfEchoEntry(msg({ messageId: '9002' }), { sentIds: new Set(['9001']) }))
})

test('没有正文的（纯图片 / 表情）不补', () => {
  assert.equal(selfEchoEntry(msg({ text: '   ' }), { sentIds: new Set() }), null)
  assert.equal(selfEchoEntry(msg({ text: '' }), { sentIds: new Set() }), null)
})

test('消息 id 为 0（取不到）时照常补，不去撞 sentIds', () => {
  const e = selfEchoEntry(msg({ messageId: '0' }), { sentIds: new Set(['0']) })
  assert.ok(e)
  assert.equal(e.mid, '0')
})
