import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasReplyStickerKeywords, preserveReplyStickers } from '../src/chat/sticker-policy.js'
import { parseReply } from '../src/chat/reply.js'
import { normalize, mergeFromPanel } from '../src/core/config.js'

const match = text => hasReplyStickerKeywords(parseReply(text).items)

test('默认关闭，单独保存实验开关不改概率、总限制或其他配置', () => {
  const before = normalize({ stickers: { autoChance: 0.03, limitTagged: true } })
  assert.equal(before.stickers.keywordExemption, false)
  const after = mergeFromPanel(before, { stickers: { keywordExemption: true } })
  assert.deepEqual(after, { ...before, stickers: { ...before.stickers, keywordExemption: true } })
  assert.equal(normalize({ stickers: { keywordExemption: 'false' } }).stickers.keywordExemption, false)
})

test('宽松词组有一个命中即可，包括用户指出的端庄版句式', () => {
  for (const text of ['图', '表情', '贴纸', '照片', '相片', '截屏', '一张', '这张', '那张', '几张', '两张', '多张', '来张', '发张', '整张', '换张', '一幅', '这幅', '那幅', '几幅', '一套', '这套', '那套', '看看', '看这', '看那', '看个', '看一', '瞧瞧', '瞅瞅', '瞅这', '给你看', '给大家看', '给你发', '发给你', '发你', '发个', '发一', '发来', '给你整', '整一个', '来一个', '来个', '换一个', '换个', '安排一个', '送你', '送个', '收下', '收藏', '配个', '配一', '给你整一个端庄版', '看看这个', '地图怎么打开', 'a GIF', 'some stickers', 'a picture', 'Photo', 'image', 'meme', 'pics', 'emoji']) {
    assert.equal(match(text + '<sticker:开心>'), true, text)
  }
})

test('只匹配正文，标签名、图片段和 QQ 小黄脸标签不算关键词', () => {
  for (const text of ['今天天气真好<sticker:表情图>', '<sticker:一张图>', '<sticker:GIF>', '你好呀<face:表情><sticker:开心>', '![一张图](https://example.com/image.png)<sticker:开心>']) {
    assert.equal(match(text), false, text)
  }
  assert.equal(hasReplyStickerKeywords([{ kind: 'sticker', value: { name: '表情' } }, { kind: 'image', value: '/图片/this.png' }, { kind: 'poke', value: '这张' }]), false)
  assert.equal(match('我也喜欢数学'), false)
  assert.equal(match('classification'), false, '英文词不能在别的单词内部命中')
})

test('语音正文和同一段回复的其他文字气泡也参与匹配', () => {
  assert.equal(match('<voice>给你看看这个</voice><sticker:开心>'), true)
  assert.equal(match('这张很端庄|||真的|||<sticker:开心>'), true)
})

test('纯表情豁免不把空回复、混排或表情名字当成正文关键词', () => {
  assert.equal(preserveReplyStickers(parseReply('<sticker:开心> ||| <sticker:委屈>').items), true)
  assert.equal(preserveReplyStickers([]), false)
  assert.equal(preserveReplyStickers(parseReply('你好<sticker:图片>').items), false)
  assert.equal(preserveReplyStickers(parseReply('<voice>你好</voice><sticker:开心>').items), false)
  assert.equal(preserveReplyStickers([{kind:'image',value:'image.png'},{kind:'sticker',value:'开心'}]), false)
})
