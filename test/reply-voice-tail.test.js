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
