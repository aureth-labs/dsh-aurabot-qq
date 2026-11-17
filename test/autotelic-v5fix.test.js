// 自驱引擎 v5 · 返工回归（集成审查必修①②③ + 中危 4/6/8，2026-11-17）：
//   ① skillId 链路：resolveMethod 命中 → 行动单带 skillId → recordOutcome 记账；未命中走对象形态
//   ② buildTicket 步骤带 level（write-data / touch-owner），引擎不再「只会想不能做」
//   ③ 前缀缓存：prefix.js createPrefixCache 同输入不重拼、version 稳定、约束变更才换版本
//   ④ gate 输入预算：超预算裁候选、永不裁判据清单
//   ⑤ rework = 改写后通过；recordDelivery 带意图原文（回应判档用）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTicket, createPlanner, trimGateInput, DEFAULT_BUDGETS } from '../src/autotelic/plan.js'
import { createPrefixCache, hashPrefix } from '../src/autotelic/prefix.js'
import { createSkillStore } from '../src/autotelic/skills.js'
import { createFeedback } from '../src/autotelic/feedback.js'

const tmp = (t, name) => {
  const root = mkdtempSync(join(tmpdir(), `aurabot-autotelic-v5fix-${name}-`))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

// ---------- ② 步骤分级 ----------

test('buildTicket 步骤带 level：发言类 touch-owner、其余 write-data（必修②）', () => {
  const owner = buildTicket({ candidate: { title: '把今天的一角讲给主人听', tag: '分享', reason: 'r', evidence: ['a', 'b'] } })
  assert.equal(owner.steps[0].level, 'touch-owner')
  assert.equal(owner.ownerSide, true)
  const normal = buildTicket({ candidate: { title: '把那个 README 读一遍', tag: '学习', reason: 'r', evidence: ['a', 'b'] } })
  assert.equal(normal.steps[0].level, 'write-data', '写数据类步骤标 write-data，exec 不再全兜 touch-owner')
  assert.equal(normal.ownerSide, false)
})

// ---------- ① skillId 链路 ----------

test('skillId 链路：resolveMethod 命中既有技能 → 记账落条目；未命中 → 对象形态立候选记忆（必修①）', (t) => {
  const root = tmp(t, 'skillid')
  const store = createSkillStore(join(root, 'skills'), { now: () => Date.now() })
  // 攒 3 条同主题记忆 → 提炼晋升技能层（distill 不给，模板兜底）
  let n = 0
  for (const text of ['整理相册要按月份分目录', '整理相册先备份再动手', '整理相册完事写一条记录']) {
    n++
    const r = store.ingestReflection({ roundId: `round-${n}`, tag: '整理', text })
    assert.equal(r.ok, true)
  }
  const hit = store.resolveMethod('整理', { kind: '整理', text: '把相册整理一遍' })
  assert.ok(hit?.doc?.meta?.id, '同主题技能已晋升，resolveMethod 命中')
  // 命中路径：行动单带 skillId → recordOutcome(skillId, done) → uses+1 score+0.1
  const before = store.get(hit.doc.meta.id)
  const r1 = store.recordOutcome(hit.doc.meta.id, 'done', '')
  assert.equal(r1.ok, true)
  const after = store.get(hit.doc.meta.id)
  assert.equal(after.meta.uses, before.meta.uses + 1)
  assert.ok(after.meta.score > before.meta.score, 'done 加分（D9：真实复用终态锚定）')
  // 未命中路径（探索模式，集成层口径）：对象形态记账落不到条目时，集成层把真实终态立为候选记忆
  const r2 = store.recordOutcome({ tag: '好奇', status: 'done', ownerResponse: '' })
  if (!r2.ok && String(r2.why || '').includes('落不到任何条目')) {
    const ing = store.ingestReflection({ topic: '好奇', text: '行动「试着弄懂 X」真实复用终态 done（立为候选经验）', finalStatus: 'done' })
    assert.equal(ing.ok, true)
  } else {
    assert.equal(r2.ok, true, r2.why)
  }
  // 立了候选之后，同方向再 done 就能按 tag 找到条目记账（下一轮 resolveMethod 可命中）
  const r3 = store.recordOutcome({ tag: '好奇', status: 'done', ownerResponse: '' })
  assert.equal(r3.ok, true, r3.why || JSON.stringify(r3))
})

// ---------- ③ 前缀缓存 ----------

test('前缀缓存：同输入不重拼（缓存命中同串）、version 稳定、约束变更才换版本（必修③）', () => {
  const cache = createPrefixCache()
  const p1 = { personaSummary: '她是牧之原翔子。', instincts: [{ id: 'i1', title: '先备份', content: '动手前先备份' }], constraints: '不许半夜说话' }
  const text1 = cache.build(p1)
  const v1 = cache.version(p1)
  // 同输入再 build：直接命中内存缓存（同一字符串，不重拼——key 未变）
  assert.equal(cache.changed(p1), false, '同输入 changed=false（缓存命中）')
  assert.equal(cache.build(p1), text1)
  assert.equal(cache.version(p1), v1, 'version 稳定（hash 未变）')
  // 约束变更 → 缓存失效、版本更换
  const p2 = { ...p1, constraints: '不许半夜说话\n不许花钱' }
  assert.equal(cache.changed(p2), true, '约束变了 changed=true')
  assert.notEqual(cache.version(p2), v1, '版本更换（提示词缓存失效重拼）')
  // 确定性：同一输入永远同一输出（缓存命中的前提）
  assert.equal(hashPrefix(cache.build(p1)), hashPrefix(text1))
})

test('稳定前缀段：人格锚/本能/约束三段齐备且约束全文原样在段内（§9.3）', () => {
  const cache = createPrefixCache()
  const text = cache.build({ personaSummary: '人格卡摘要', instincts: [{ id: 'i', title: 'T', content: 'C' }], constraints: '不许半夜说话' })
  assert.match(text, /人格卡摘要/)
  assert.match(text, /本能·T/)
  assert.match(text, /不许半夜说话/)
})

// ---------- ④ gate 输入预算 ----------

test('gate 输入预算：超预算从队尾裁候选，判据清单永不裁（必修③）', () => {
  const cands = Array.from({ length: 8 }, (_, i) => ({ title: `候选念头第${i}个标题很长很长很长`, tag: '学习', evidence: [`obs:${i}a`, `obs:${i}b`] }))
  const gate = buildGateForTest(cands)
  const tiny = DEFAULT_BUDGETS.gateMaxInputTokens
  const r = trimGateInput({ text: gate, maxInputTokens: Math.max(120, Math.floor(tiny / 64)) }) // 极小预算逼出裁剪
  assert.ok(r.dropped > 0, '超预算时裁掉了候选')
  assert.match(r.text, /判据清单/, '判据清单永不裁')
  assert.match(r.text, /强制约束规则|主人暂未写任何约束/, '前置否决条款永不裁')
})
function buildGateForTest(candidates) {
  // 借 createPlanner 的内部路径不方便，这里复刻 buildGatePrompt 的段结构最小化验证
  const planner = createPlanner({})
  const lines = [
    '以下条款由主人制定，违反任何一条的候选直接打回，不允许改写挽救：',
    '（主人暂未写任何约束）', '',
    ...candidates.map((c, i) => `${i + 1}. 「${c.title}」（tag：${c.tag}）\n   出处证据：${c.evidence.join('；')}`), '',
    '判据清单（写死，不许自造指标）：',
    '0. 前置否决…', '',
    `[${candidates.map((c) => JSON.stringify(c)).join(',')}]`,
  ].join('\n')
  void planner
  return lines
}

// ---------- ⑤ rework 与回应窗 ----------

test('rework = 改写后通过：把关 why 附进行动单（集成审查中危 6）', async (t) => {
  const root = tmp(t, 'rework')
  const obs = [
    { id: 'o1', at: 1000, source: 'chat', text: '主人提到相册乱' },
    { id: 'o2', at: 2000, source: 'chat', text: '又提到相册乱' },
  ]
  const planner = createPlanner({
    decisionFile: '',
    intentTurn: async () => JSON.stringify([{ title: '把相册整理一遍', tag: '整理', reason: '因为主人提过', evidence: ['o1', 'o2'] }]),
    gateTurn: async () => JSON.stringify([{ i: 1, verdict: 'rework', why: '口吻再轻一点' }]),
    rng: () => 0,
  })
  const res = await planner.decideRound({ round: 1, constraintRulesText: '', observations: obs })
  assert.equal(res.outcome, 'tickets', 'rework 不再被静默丢弃')
  assert.equal(res.tickets.length, 1)
  assert.equal(res.tickets[0].reworked, true)
  assert.match(res.tickets[0].reason, /把关改写提示：口吻再轻一点/)
  void root
})

test('park 挂起项如实带出（集成层接走进下轮观察）', async (t) => {
  const obs = [
    { id: 'o1', at: 1000, source: 'chat', text: 'A' },
    { id: 'o2', at: 2000, source: 'chat', text: 'B' },
  ]
  const planner = createPlanner({
    decisionFile: '',
    intentTurn: async () => JSON.stringify([{ title: '还不到时候的事', tag: '好奇', reason: '因为', evidence: ['o1', 'o2'] }]),
    gateTurn: async () => JSON.stringify([{ i: 1, verdict: 'park', why: '现在不是时候' }]),
    rng: () => 0,
  })
  const res = await planner.decideRound({ round: 2, constraintRulesText: '', observations: obs })
  assert.equal(res.outcome, 'all-dead')
  assert.equal(res.parked?.length, 1, 'park 候选不再蒸发，交集成层挂起')
})

test('recordDelivery 带意图原文：回应判档有关键词可用（集成审查中危 8）', (t) => {
  const root = tmp(t, 'delivery')
  const fb = createFeedback({ file: join(root, 'feedback.json'), settings: () => ({}) })
  fb.recordDelivery({ id: 'tk-1', tag: '分享', text: '把今天学会的裁切讲给主人听' })
  const w = fb.snapshot().windows[0]
  assert.equal(w.text.includes('裁切'), true, '观察窗记录带意图原文')
})
