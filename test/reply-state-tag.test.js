// 回归 #11：模型把内部状态标签 <state></state> 漏在消息结尾（2026-11-08 交流群 03 群友反馈）。
// 旧实现只认工具协议标签，state 标签会原样发进群。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanOutboundText, parseReply } from '../src/chat/reply.js'

const texts = (r) => r.items.filter((i) => i.kind === 'text').map((i) => i.value)

test('消息结尾重复的 state 开标签不会当正文发出', () => {
  assert.deepEqual(texts(parseReply('好呀<state><state>')), ['好呀'])
  assert.deepEqual(texts(parseReply('晚安</state>')), ['晚安'])
  assert.equal(cleanOutboundText('好呀<state></state>'), '好呀')
  assert.equal(cleanOutboundText('<state></state>'), '')
})

test('成对的 state 标签连内部内容一起删，前后正文保留', () => {
  assert.deepEqual(texts(parseReply('好呀<state>当前心情：开心</state>今天吃白米饭')), ['好呀今天吃白米饭'])
  assert.equal(cleanOutboundText('前文</state>后文'), '前文后文')
})

test('不误伤正常文字：<statement>、<stateful> 和正文里的 state 单词都保留', () => {
  const normal = '这是<statement>正常</statement>和<stateful>文本</stateful>，state 是英文单词'
  assert.deepEqual(texts(parseReply(normal)), [normal])
  assert.equal(cleanOutboundText(normal), normal)
})

test('代码示例里的 <state> 字面量保留', () => {
  assert.equal(cleanOutboundText('示例：`<state></state>` 是内部标签'), '示例：`<state></state>` 是内部标签')
  assert.ok(texts(parseReply('示例：`<state></state>` 是内部标签')).join('').includes('<state></state>'))
})
