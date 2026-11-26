import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseReply } from '../src/chat/reply.js'

for (const count of [3, 4, 5, 6, 7]) test(`连续 ${count} 个竖线都作为一个气泡分隔符，不留下单独消息`, () => {
  const { items } = parseReply(`<voice>第一条</voice>${'|'.repeat(count)}<voice>第二条</voice>`)
  assert.deepEqual(items, [{kind:'voice',value:'第一条'},{kind:'voice',value:'第二条'}])
  assert.deepEqual(parseReply(`你好${'|'.repeat(count)}再见`).items,[{kind:'text',value:'你好'},{kind:'text',value:'再见'}])
})
test('正常单竖线、双竖线和语音正文不被删除', () => {
  for(const text of ['A | B', 'a || b', '|', '||']) assert.deepEqual(parseReply(text).items,[{kind:'text',value:text}])
  assert.deepEqual(parseReply('<voice>A | B</voice>').items,[{kind:'voice',value:'A | B'}])
})
test('语音后的普通文字仍保留；重复分隔符不影响引用归属', () => {
  assert.deepEqual(parseReply('<voice>你好</voice>||||补充说明').items,[{kind:'voice',value:'你好'},{kind:'text',value:'补充说明'}])
  assert.deepEqual(parseReply('<reply:2><voice>你好</voice>||||<voice>再见</voice>').items,[{kind:'voice',value:'你好',replyTo:'2'},{kind:'voice',value:'再见'}])
})
