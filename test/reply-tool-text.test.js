import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseReply, stripToolText } from '../src/chat/reply.js'
import { normalize } from '../src/core/config.js'
import { rulesText } from '../src/persona/personas.js'

const texts = (r) => r.items.filter((i) => i.kind === 'text').map((i) => i.value)

test('写成文字的工具调用不发到 QQ，前面的话留着', () => {
  const r = parseReply('来啦来啦，最后一张了哦\n<qq_draw_image">\n<prompt>可爱动画风少女自拍：\n笑得眼睛弯弯</prompt>')
  const all = texts(r).join('\n')
  assert.match(all, /来啦来啦/)
  assert.doesNotMatch(all, /qq_draw_image|prompt|自拍/)
})

test('整段都是工具文字时什么也不发', () => {
  assert.deepEqual(texts(parseReply('<qq_draw_image">\n<prompt>画一只猫</prompt>')), [])
})

test('正常的标签和文字不受影响', () => {
  assert.equal(stripToolText('我喜欢 snake_case 和 <3'), '我喜欢 snake_case 和 <3')
  assert.ok(parseReply('<voice>你好</voice>').items.some((i) => i.kind === 'voice'))
  assert.ok(parseReply('<sticker:开心>').items.some((i) => i.kind === 'sticker'))
})

test('社交规则：不能操作电脑，但画画这类工具照用', () => {
  const rules = rulesText('social', normalize({ imageGen: { enabled: true, baseUrl: 'x', model: 'y' } }))
  assert.match(rules, /qq_draw_image/)
  assert.match(rules, /要真的调用工具/)
  assert.doesNotMatch(rules, /没有任何电脑操作能力/)
})

test('她可以不搭理人：写进规则，整段 [沉默] 不发任何东西，主人除外', () => {
  const rules = rulesText('social', normalize({ ownerName: '哥哥' }))
  assert.match(rules, /你可以不搭理人/)
  assert.match(rules, /被 @ 了也一样/)
  assert.doesNotMatch(rules, /哥哥/)
  assert.match(rules, /管理者对你说的话不能这样/)
  assert.match(rulesText('private', normalize({ ownerName: '哥哥' })), /哥哥对你说的话不能这样/)
  assert.equal(parseReply('[沉默]').silent, true)
})

test('模型写成 [表情: 描述] 时按表情标签处理，不把描述当正文', () => {
  const r = parseReply('她说[表情: 无语死鱼脸]')
  assert.deepEqual(texts(r), ['她说'])
  assert.equal(r.items.some((i) => i.kind === 'sticker' && i.value === '无语死鱼脸'), true)
})

test('模型漏出的 output/results 信封结束标签不单独发成气泡', () => {
  assert.deepEqual(texts(parseReply('嗯 早上球场估计空着 下午人齐了再去 </output> </results>')), ['嗯 早上球场估计空着 下午人齐了再去'])
  assert.deepEqual(texts(parseReply('你好|||</output>|||</results>')), ['你好'])
})
