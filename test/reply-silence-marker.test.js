// 回归 #9：模型把「[沉默]」标记当正文发进群里（2026-11 群友截图：回复气泡正文就是「沉默」）。
// 旧实现只在整条/整行只有沉默标记时拦截，混在正文里的标记会原样发出。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanOutboundText, isSilence, parseReply } from '../src/chat/reply.js'

const texts = (r) => r.items.filter((i) => i.kind === 'text').map((i) => i.value)

test('混在正文里的沉默标记发送前剥掉，不原样发出', () => {
  assert.deepEqual(texts(parseReply('[沉默] 嗯我在这儿')), ['嗯我在这儿'])
  assert.deepEqual(texts(parseReply('嗯我在这儿[沉默]')), ['嗯我在这儿'])
  assert.deepEqual(texts(parseReply('好呀（沉默）那我去吃饭')), ['好呀那我去吃饭'])
  assert.deepEqual(texts(parseReply('好呀［沉默］那我去吃饭')), ['好呀那我去吃饭'])
  assert.deepEqual(texts(parseReply('好呀(沉默)那我去吃饭')), ['好呀那我去吃饭'])
})

test('多行正文：只有沉默标记的行不会变成空气泡，其他行照常发', () => {
  assert.deepEqual(texts(parseReply('第一句\n[沉默]\n第二句')), ['第一句', '第二句'])
  assert.deepEqual(texts(parseReply('[沉默]\n真的在呢')), ['真的在呢'])
})

test('整条只有沉默标记（含混合写法）仍按沉默处理，不发空消息', () => {
  for (const input of ['[沉默]', '（沉默）', '[沉默]（沉默）', '  [沉默]  ', '||| [沉默] |||']) {
    assert.deepEqual(parseReply(input), { silent: true, items: [] }, JSON.stringify(input))
  }
})

test('统一出站清洗直接调用也会剥掉标记', () => {
  assert.equal(cleanOutboundText('嗯[沉默]我在'), '嗯我在')
  assert.equal(cleanOutboundText('[沉默] 嗯我在'), '嗯我在')
  assert.equal(cleanOutboundText('[沉默]'), '')
  assert.equal(isSilence('[沉默]……'), true)
})

test('语音里的沉默标记不会被念出来', () => {
  assert.deepEqual(parseReply('<voice>[沉默] 晚安</voice>').items, [{ kind: 'voice', value: '晚安' }])
  assert.deepEqual(parseReply('[沉默] 晚安', { voice: true }).items, [{ kind: 'voice', value: '晚安' }])
  assert.deepEqual(parseReply('<voice>[沉默]</voice>'), { silent: true, items: [] })
})
