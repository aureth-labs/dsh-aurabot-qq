// 正文标记：模型用 ⟦REPLY⟧ 包住要发的话，插件只取标记内。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractMarkedReply, stripMarkers, markerInstruction, REPLY_OPEN, REPLY_CLOSE } from '../src/chat/reply-marker.js'

test('正常：标记内的话取出来', () => {
  const r = extractMarkedReply(`${REPLY_OPEN}今天好累啊${REPLY_CLOSE}`)
  assert.equal(r.found, true)
  assert.equal(r.text, '今天好累啊')
})

test('思考写在标记外：只取标记内', () => {
  const raw = 'Godot\'s story is funny. I could react. 先想想怎么说。'
    + `${REPLY_OPEN}美服这局也太热闹了${REPLY_CLOSE}`
    + '（这里又写了点别的）'
  const r = extractMarkedReply(raw)
  assert.equal(r.found, true)
  assert.equal(r.text, '美服这局也太热闹了')
})

test('完全没有标记：found=false，交给调用方重写', () => {
  const r = extractMarkedReply('NSFW image + 筹集 joke. Not addressed to me. Silence.')
  assert.equal(r.found, false)
  assert.equal(r.text, '')
})

test('只有开始没有结束：取到结尾（模型常忘闭合）', () => {
  const r = extractMarkedReply(`草稿……${REPLY_OPEN}就这样吧`)
  assert.equal(r.found, true)
  assert.equal(r.text, '就这样吧')
})

test('多组标记：取最后一组（定稿）', () => {
  const raw = `${REPLY_OPEN}第一版${REPLY_CLOSE} 再改改 ${REPLY_OPEN}第二版${REPLY_CLOSE}`
  const r = extractMarkedReply(raw)
  assert.equal(r.text, '第二版')
})

test('宽容变体：[[REPLY]] 和 【REPLY】 也认', () => {
  for (const raw of [
    '[[REPLY]]你好[[/REPLY]]',
    '【REPLY】你好【/REPLY】',
    '⟦ REPLY ⟧你好⟦ /REPLY ⟧',
  ]) {
    const r = extractMarkedReply(raw)
    assert.equal(r.found, true, raw)
    assert.equal(r.text, '你好', raw)
  }
})

test('标记内是空的：found=true 但 text 为空', () => {
  const r = extractMarkedReply(`${REPLY_OPEN}${REPLY_CLOSE}`)
  assert.equal(r.found, true)
  assert.equal(r.text, '')
})

test('stripMarkers：把标记从正文里清掉', () => {
  assert.equal(stripMarkers('⟦REPLY⟧你好⟦/REPLY⟧'), '你好')
  assert.equal(stripMarkers('[[REPLY]]你好[[/REPLY]]'), '你好')
})

test('注入的格式要求里带标记', () => {
  const text = markerInstruction()
  assert.ok(text.includes(REPLY_OPEN))
  assert.ok(text.includes(REPLY_CLOSE))
  assert.ok(text.includes('重写'))
})
