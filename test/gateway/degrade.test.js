// G1 过关条件 · 渲染与降级（renderParts 口径 §六.2；降级表每行一测 §七.2）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderParts } from '../../src/gateway/render.js'
import { degrade } from '../../src/gateway/degrade.js'

// ───────────────────────── renderParts ─────────────────────────

test('renderParts：图片/表情包/视频/文件/合并转发/戳一戳 口径', () => {
  const { text } = renderParts([
    { type: 'image', media: { url: 'https://x/a.png' } },
    { type: 'sticker', media: {}, label: '[啊？]' },
    { type: 'sticker', media: {} },
    { type: 'video', media: {} },
    { type: 'file', media: { name: '报告.pdf' } },
    { type: 'forward', id: 'fwd1' },
    { type: 'poke' },
  ])
  assert.equal(text, '[图片][啊？][表情包][视频][文件 报告.pdf][合并转发][戳一戳]')
})

test('renderParts：@别人、@全体、face、card、other、voice', () => {
  const { text, wakeText } = renderParts([
    { type: 'text', text: '看这个 ' },
    { type: 'mention', account: '10002', name: '小明' },
    { type: 'mention', account: 'all' },
    { type: 'text', text: ' 都来看 ' },
    { type: 'face', name: '捂脸' },
    { type: 'face', name: '骰子', value: '6' },
    { type: 'card', text: '[分享卡片：标题]' },
    { type: 'other', text: '[闪传文件]' },
    { type: 'voice', media: {} },
  ])
  assert.equal(text, '看这个 @小明 @全体成员  都来看 [捂脸][骰子：6][分享卡片：标题][闪传文件]')
  assert.equal(wakeText, '看这个 @小明  都来看 [捂脸][骰子：6][分享卡片：标题][闪传文件]', 'wakeText 去掉 @全体成员')
})

// ───────────────────────── 降级表（§七.2 每行一测） ─────────────────────────

const baseCaps = {
  image: true, sticker: true, voice: 'native', video: true, file: true, maxFileBytes: 1000,
  quoteReply: true, mention: true, mentionAll: true, poke: true, typing: false, recall: true,
  card: true, listenAllInGroup: true, proactive: 'free', replyWindowMs: 0, repliesPerMessage: 0,
  history: false, memberList: false, forwardExpand: false,
}

test('降级：voice 平台是 file → 当音频文件发（保留）', () => {
  const caps = { ...baseCaps, voice: 'file' }
  const d = degrade([{ type: 'voice', media: { url: 'a.mp3' } }], undefined, caps)
  assert.equal(d.parts[0].type, 'voice')
  assert.deepEqual(d.degraded, [])
})

test('降级：voice 平台是 false → 丢掉并记 degraded', () => {
  const caps = { ...baseCaps, voice: false }
  const d = degrade([{ type: 'text', text: 'hi' }, { type: 'voice', media: {} }], undefined, caps)
  assert.equal(d.parts.length, 1)
  assert.deepEqual(d.degraded, ['voice dropped'])
})

test('降级：sticker → image；连图也不支持就丢掉', () => {
  const capsA = { ...baseCaps, sticker: false }
  const a = degrade([{ type: 'text', text: 'x' }, { type: 'sticker', media: { url: 's.png' } }], undefined, capsA)
  assert.equal(a.parts[1].type, 'image')
  assert.deepEqual(a.degraded, ['sticker→image'])

  const capsB = { ...baseCaps, sticker: false, image: false }
  const b = degrade([{ type: 'text', text: 'x' }, { type: 'sticker', media: {} }], undefined, capsB)
  assert.equal(b.parts.length, 1)
  assert.deepEqual(b.degraded, ['sticker dropped'])
})

test('降级：image / video / file 不支持 → 丢掉记 degraded', () => {
  const caps = { ...baseCaps, image: false, video: false, file: false }
  const d = degrade([{ type: 'text', text: 'x' }, { type: 'image', media: {} }, { type: 'video', media: {} }, { type: 'file', media: {} }], undefined, caps)
  assert.equal(d.parts.length, 1)
  assert.deepEqual(d.degraded, ['image dropped', 'video dropped', 'file dropped'])
})

test('降级：file 超过 maxFileBytes → 抛 not-sent too-large', () => {
  const caps = { ...baseCaps, maxFileBytes: 100 }
  assert.throws(
    () => degrade([{ type: 'text', text: 'x' }, { type: 'file', media: { size: 200 } }], undefined, caps),
    (e) => e.certainty === 'not-sent' && e.code === 'too-large',
  )
})

test('降级：mention 不支持 → 换成文字「@名字 」；@all → 「@全体成员 」', () => {
  const caps = { ...baseCaps, mention: false, mentionAll: false }
  const d = degrade([{ type: 'text', text: 'x ' }, { type: 'mention', account: '10002', name: '小明' }, { type: 'mention', account: 'all' }], undefined, caps)
  assert.deepEqual(d.parts, [{ type: 'text', text: 'x ' }, { type: 'text', text: '@小明 ' }, { type: 'text', text: '@全体成员 ' }])
  assert.deepEqual(d.degraded, ['mention→text', 'mentionAll→text'])
})

test('降级：replyTo 平台不支持引用 → 去掉引用照常发', () => {
  const caps = { ...baseCaps, quoteReply: false }
  const d = degrade([{ type: 'text', text: 'x' }], 'msg-9', caps)
  assert.equal(d.replyTo, undefined)
  assert.deepEqual(d.degraded, ['quoteReply dropped'])
})

test('降级：poke 不支持 → 丢掉', () => {
  const caps = { ...baseCaps, poke: false }
  const d = degrade([{ type: 'text', text: 'x' }, { type: 'poke' }], undefined, caps)
  assert.deepEqual(d.degraded, ['poke dropped'])
})

test('降级：face 声明 face=false → 换文字「[名字]」', () => {
  const caps = { ...baseCaps, face: false }
  const d = degrade([{ type: 'text', text: 'x' }, { type: 'face', name: '捂脸' }], undefined, caps)
  assert.deepEqual(d.parts, [{ type: 'text', text: 'x' }, { type: 'text', text: '[捂脸]' }])
  assert.deepEqual(d.degraded, ['face→text'])
})

test('降级：card 不支持 → 换文字 text，有 url 接在后面', () => {
  const caps = { ...baseCaps, card: false }
  const d = degrade([{ type: 'text', text: 'x' }, { type: 'card', text: '[分享卡片：标题]', url: 'https://e.com' }], undefined, caps)
  assert.deepEqual(d.parts[1], { type: 'text', text: '[分享卡片：标题] https://e.com' })
  assert.deepEqual(d.degraded, ['card→text'])
})

test('降级：主动消息且 proactive=none → 抛 not-sent proactive-not-allowed', () => {
  const caps = { ...baseCaps, proactive: 'none' }
  assert.throws(
    () => degrade([{ type: 'text', text: 'hi' }], undefined, caps, { instance: 'fake', proactive: true }),
    (e) => e.certainty === 'not-sent' && e.code === 'proactive-not-allowed' && e.instance === 'fake',
  )
  // 被动回复（proactive=false）不受影响
  const d = degrade([{ type: 'text', text: 'hi' }], undefined, caps, { instance: 'fake', proactive: false })
  assert.equal(d.parts.length, 1)
})

test('降级：降级后 parts 空了 → 抛 not-sent nothing-to-send', () => {
  const caps = { ...baseCaps, image: false }
  assert.throws(
    () => degrade([{ type: 'image', media: {} }], undefined, caps, { instance: 'fake' }),
    (e) => e.certainty === 'not-sent' && e.code === 'nothing-to-send',
  )
})

test('降级：全支持时原样通过，degraded 为空', () => {
  const d = degrade([{ type: 'text', text: 'hi' }, { type: 'poke' }], 'm1', baseCaps)
  assert.equal(d.parts.length, 2)
  assert.equal(d.replyTo, 'm1')
  assert.deepEqual(d.degraded, [])
})
