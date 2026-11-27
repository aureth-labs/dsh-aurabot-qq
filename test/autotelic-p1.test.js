// 自驱引擎 v5 · 词表归一回归（原 P1「好奇判分」已被 v5 推翻——打分器整层删除，D1 裁决）。
// 本文件现在守的是：tag 封闭词表唯一来源（tags.js）与决策环词表解析的一致性（§3.3，
// 集成裁决 2026-11-17：plan.js 的词表从 tags.js 解析，不许两份名单漂移）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_TAGS, mergeTags, isValidTag } from '../src/autotelic/tags.js'
import { TAG_VOCAB, TAG_SET, makeTagVocab, parseIntents, buildTicket } from '../src/autotelic/plan.js'

const OBS = [
  { id: 'obs:1', at: 1000, source: 'chat', text: '主人提过想整理相册' },
  { id: 'obs:2', at: 2000, source: 'chat', text: '又提到相册乱' },
  { id: 'obs:3', at: 3000, source: 'note', text: '记录：相册' },
]

test('词表唯一来源：决策环 TAG_VOCAB 与 tags.js DEFAULT_TAGS 一一对应，无漂移', () => {
  assert.equal(TAG_VOCAB.length, DEFAULT_TAGS.length, '词表条数必须一致（以 tags.js 为准）')
  assert.deepEqual(TAG_VOCAB.map((x) => x.tag), DEFAULT_TAGS, '词表名单与 tags.js 完全一致且保序')
  assert.equal(TAG_SET.size, DEFAULT_TAGS.length, '无重复')
})

test('词表规模与 owner 分类（§3.3 ≤20；touch-owner 类只有 分享/问候/陪伴）', () => {
  assert.ok(TAG_VOCAB.length <= 20, `词表超限：${TAG_VOCAB.length}`)
  const owners = TAG_VOCAB.filter((x) => x.owner).map((x) => x.tag)
  assert.deepEqual([...owners].sort(), ['分享', '问候', '陪伴'].sort())
  const tk = buildTicket({ candidate: { title: '把今天的一角讲给主人听', tag: '分享', reason: '因为今天学会了新东西', evidence: ['obs:1', 'obs:2'] } })
  assert.equal(tk.ownerSide, true, 'owner 类 tag → ownerSide=true，执行侧据此走硬闸')
  const tk2 = buildTicket({ candidate: { title: '读一遍那个 README', tag: '学习', reason: '因为好奇', evidence: ['obs:1', 'obs:3'] } })
  assert.equal(tk2.ownerSide, false)
})

test('makeTagVocab 可注入：自定义名单/owner 名单生效，未知 tag 元数据为空但不炸', () => {
  const v = makeTagVocab(['学习', '自定义新tag'], ['学习'])
  assert.equal(v.length, 2)
  assert.equal(v.find((x) => x.tag === '学习').owner, true)
  assert.equal(v.find((x) => x.tag === '自定义新tag').owner, false)
  assert.equal(v.find((x) => x.tag === '自定义新tag').desc, '')
})

test('用户扩展词表合并：内置在前、去重保序、上限 40', () => {
  const merged = mergeTags(['学习', '手帐', ' 书法 '])
  assert.deepEqual(merged.slice(0, DEFAULT_TAGS.length), DEFAULT_TAGS, '内置在前')
  assert.ok(merged.includes('手帐') && merged.includes('书法'), '用户扩展进表')
  assert.equal(merged.filter((t) => t === '学习').length, 1, '去重')
  assert.ok(mergeTags(Array.from({ length: 60 }, (_, i) => `t${i}`)).length <= 40, '钳到 40')
})

test('isValidTag：默认按内置词表判；传入词表按传入判', () => {
  assert.equal(isValidTag('学习'), true)
  assert.equal(isValidTag('刷KPI'), false)
  assert.equal(isValidTag('手帐', mergeTags(['手帐'])), true)
})

test('决策环出处硬验收：候选 tag 出词表即作废（防换词绕过抑制表）', () => {
  const good = { title: '把主人提过的相册整理一遍', tag: '整理', reason: '因为主人那天随口提过它', evidence: ['obs:1', 'obs:2'] }
  const bad = { ...good, tag: '刷KPI' }
  const r = parseIntents(JSON.stringify([good, bad]), { observations: OBS })
  assert.equal(r.candidates.length, 1, '只有词表内的候选活下来')
  assert.ok(r.deadReasons.some((s) => /词表/.test(s)), '作废原因写明词表')
})
