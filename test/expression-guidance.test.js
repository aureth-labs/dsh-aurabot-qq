import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rulesText } from '../src/persona/personas.js'
import { normalize } from '../src/core/config.js'
import { COMMON_FACES, textToSegments } from '../src/chat/faces.js'
import { parseReply } from '../src/chat/reply.js'

for (const kind of ['social', 'private', 'group-owner']) {
  test(`${kind}：表情语法不越过人格的场景和频率规则，也不撤销明确请求`, () => {
    const rules = rulesText(kind, normalize({ stickers: { limitTagged: true } }))
    assert.match(rules, /表情格式只说明如何发送，不代表建议使用/)
    assert.match(rules, /以当前人格的场景和频率要求为准/)
    assert.match(rules, /本轮明确索要或要求原样引用时按要求处理/)
    assert.match(rules, /<face:名字>/)
    assert.match(rules, /<sticker:标签>/)
    assert.doesNotMatch(rules, /<face:(斜眼笑|偷笑|吃瓜|捂脸)>|标签可以是|想发表情包，写/)
    assert.match(rules, /不要为了补发而调用工具/)
  })
}

test('关闭的表情能力仍不向模型教授发送标签', () => {
  const cfg = normalize({ stickers: { enabled: false, faces: false } })
  assert.doesNotMatch(rulesText('social', cfg), /<face:|<sticker:/)
  assert.doesNotMatch(rulesText('social', normalize({}), { off: new Set(['stickers']) }), /<sticker:/)
})

test('调整说明不改变发送契约：明确选择的 QQ 表情、emoji 和 sticker 仍保留', () => {
  assert.deepEqual(textToSegments('<face:斜眼笑>', (name) => COMMON_FACES[name]), [{ type: 'face', data: { id: '178' } }])
  assert.deepEqual(textToSegments('收到🙂', (name) => COMMON_FACES[name]), [{ type: 'text', data: { text: '收到🙂' } }])
  assert.ok(parseReply('<sticker:开心>').items.some((item) => item.kind === 'sticker'))
})
