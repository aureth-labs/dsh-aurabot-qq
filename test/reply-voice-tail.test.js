import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasInvalidVoiceMarkup, parseReply } from '../src/chat/reply.js'

const parse = (s) => parseReply(s).items
const voice = (value) => ({ kind: 'voice', value })

test('普通回复：最后一个语音块漏写结束标签，不把标记当文字发，也不重复第一条', () => {
  for (const sep of ['\n', '|||', '']) {
    assert.deepEqual(parse(`<voice>第一句。</voice>${sep}<voice>第二句。`), [voice('第一句。'), voice('第二句。')])
  }
  assert.deepEqual(parse('<voice>晚安'), [voice('晚安')])
  assert.deepEqual(parse('<reply:2><voice>晚安'), [{ ...voice('晚安'), replyTo: '2' }])
  assert.ok(hasInvalidVoiceMarkup('一条文字|||<voice>晚安'), '跨聊天的发送前校验仍须拒绝未配对标签')
})

test('只修最后的明确语音指令，不把普通文字、示例、跨气泡正文当语音', () => {
  for (const text of ['示例：`<voice>晚安`', '```xml\n<voice>晚安\n```', '这里提到了 <voice>标签', '<voice>第一句|||另一条文字', '<voice>标题\n正文', '<voice>一<voice>二']) {
    assert.equal(parse(text).some(i => i.kind === 'voice'), false, text)
  }
  assert.deepEqual(parse('<voice>说完啦</voice>|||另外一句'), [voice('说完啦'), { kind: 'text', value: '另外一句' }])
})

test('连续孤立的结束标签：只在用户要求语音时续读，保留顺序、不漏字、不发标记', () => {
  const raw = '<VOICE>甲。</VOICE>乙。</voice>丙。</VOICE >丁。</voice>'
  assert.deepEqual(parseReply(raw, { wantVoice: true }).items, [voice('甲。\n乙。\n丙。\n丁。')])
  assert.deepEqual(parse(raw), [voice('甲。'), { kind: 'text', value: '乙。丙。丁。' }])
  assert.deepEqual(parseReply('只有结束。</voice>', { wantVoice: true }).items, [voice('只有结束。')])
  assert.deepEqual(parse('</voice></voice>'), [])
  assert.deepEqual(parse('<voice>第一句</voice>|||附注</voice>'), [voice('第一句'), {kind:'text', value:'附注'}])
})

test('正常的混合回复、引用和语音内停顿保留；不朗读代码示例或执行其中的语音标签', () => {
  const raw = '<reply:2><voice>甲|||乙</voice>|||文字|||<sticker:笑>|||![图](https://example.test/a.png)'
  assert.deepEqual(parse(raw), [{...voice('甲\n乙'), replyTo:'2'}, {kind:'text', value:'文字'}, {kind:'sticker', value:'笑'}, {kind:'image', value:'https://example.test/a.png'}])
  for (const literal of ['`<voice>正文</voice>`', '```xml\n<voice>正文</voice>\n```']) {
    assert.deepEqual(parse(literal), [{ kind:'text', value:'<voice>正文</voice>' }])
  }
  for (const bad of ['<voice>甲<voice>乙','<voice>甲\n乙','正文</voice>','<voice>甲|||乙','<voice>甲<voice>乙</voice></voice>']) {
    assert.ok(!parse(bad).some(x=>/<\/?voice\b/i.test(x.value)), bad)
  }
})
