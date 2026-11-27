// 回归 #54：戳一戳的闭合标签 </poke> 被当正文发出（群友截图：「嗯？ <poke>」）。
// 旧实现只识别 <poke> / <poke/> 动作，</poke> 会原样进文字气泡。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanOutboundText, parseReply } from '../src/chat/reply.js'

const texts = (r) => r.items.filter((i) => i.kind === 'text').map((i) => i.value)

test('单独的 poke 闭合标签不会以文字出现', () => {
  assert.deepEqual(texts(parseReply('嗯？ </poke>')), ['嗯？'])
  assert.equal(cleanOutboundText('嗯？ </poke>'), '嗯？')
  assert.equal(cleanOutboundText('</poke>'), '')
  for (const tag of ['</poke>', '</poke >', '</POKE>', '< / poke >']) {
    const all = JSON.stringify(parseReply('好呀' + tag))
    assert.doesNotMatch(all, /poke/i, tag)
  }
})

test('整条只有 poke 闭合标签时按沉默处理，不发空气泡', () => {
  assert.deepEqual(parseReply('</poke>'), { silent: true, items: [] })
  assert.deepEqual(parseReply(' </poke> '), { silent: true, items: [] })
})

test('真正的 <poke> / <poke/> 仍会触发戳一戳', () => {
  assert.deepEqual(parseReply('戳你一下<poke>').items, [{ kind: 'text', value: '戳你一下' }, { kind: 'poke', value: '' }])
  assert.deepEqual(parseReply('<poke/>').items, [{ kind: 'poke', value: '' }])
  assert.deepEqual(parseReply('<poke></poke>').items, [{ kind: 'poke', value: '' }])
})

test('不误伤普通单词和相似标签', () => {
  for (const text of ['pokemon 是宝可梦', '<pokemon>正常</pokemon>', '他说 poke 这个词']) {
    assert.deepEqual(texts(parseReply(text)), [text])
  }
})
