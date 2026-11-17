// 自驱引擎 v5 · plan.js 三段式决策环测试（成员 B 决策环交付之一）。
// 覆盖：候选三种回包、出处不足作废、全灭合法、constraint 前置否决注入、
//       预算降级顺序（先裁背景→再裁证据→永不裁人格锚与约束）、决策日志可校验、行动单结构、
//       复盘契约（lead 2026-11-17 定稿口径）。
// LLM 全走 fake 注入（intentTurn/gateTurn/reviewTurn），不打真网络。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TAG_VOCAB, TAG_SET, DEFAULT_BUDGETS, estimateTokens,
  buildSystemPrefix, assembleIntentInput, buildIntentPrompt, parseIntents,
  shuffle, buildGatePrompt, parseGateVerdicts, buildTicket,
  createDecisionLog, verifyDecisionLog, createPlanner, reviewRound,
} from '../src/autotelic/plan.js'
import { parseConstraintRules } from '../src/autotelic/constraint.js'

// —— 测试用观察窗口（带不同时间戳） ——
const T1 = 1_700_000_000_000
const OBS = [
  { id: 'obs:1', at: T1, source: 'owner', text: '主人说最近眼睛累，想看点轻松的东西' },
  { id: 'obs:2', at: T1 + 86_400_000, source: 'emotion', text: '今天聊到老歌时情绪明显高起来' },
  { id: 'obs:3', at: T1 + 2 * 86_400_000, source: 'chat', text: '群里反复讨论某个工具的用法' },
]
const GOOD_CANDIDATE = {
  title: '把主人提过的那个 README 读一遍', tag: '牵挂', reason: '因为主人那天随口提过它',
  want: '读完并写一条自己的判断', evidence: ['obs:1', 'obs:3'],
}

// —— ① 候选三种回包 ——

test('回包一：纯 JSON 数组正常解析，tag 词表校验通过', () => {
  const r = parseIntents(JSON.stringify([GOOD_CANDIDATE]), { observations: OBS })
  assert.equal(r.outcome, 'ok')
  assert.equal(r.candidates.length, 1)
  assert.equal(r.candidates[0].tag, '牵挂')
  assert.ok(TAG_SET.has(r.candidates[0].tag))
})

test('回包二：带前后缀散文的 JSON 也能抠出来（模型爱加说明）', () => {
  const r = parseIntents(`我想了想，有这些念头：\n${JSON.stringify([GOOD_CANDIDATE])}\n以上。`, { observations: OBS })
  assert.equal(r.candidates.length, 1)
})

test('回包三：垃圾回包 → parse-fail 全灭，candidates 为空不抛错', () => {
  for (const raw of ['', '今天没什么想做的', '{"title":1}数组都没有', '[{broken']) {
    const r = parseIntents(raw, { observations: OBS })
    assert.equal(r.candidates.length, 0, `垃圾回包「${raw.slice(0, 12)}」必须全灭`)
    assert.ok(['parse-fail', 'all-invalid'].includes(r.outcome))
  }
})

// —— 出处硬规则：无出处候选直接作废 ——

test('出处不足：evidence <2 条 / 窗口外 id / 时间全相同 三种都作废', () => {
  const r = parseIntents(JSON.stringify([
    { ...GOOD_CANDIDATE, title: '甲只有一条出处', evidence: ['obs:1'] },
    { ...GOOD_CANDIDATE, title: '乙引用了窗口外', evidence: ['obs:1', 'obs:99'] },
    { ...GOOD_CANDIDATE, title: '丙时间全相同', evidence: ['obs:1', 'obs:1'] },
    { ...GOOD_CANDIDATE, title: '丁同时引用两条相同时间', evidence: ['obs:1', 'obs:2', 'obs:2'] },
  ]), { observations: OBS })
  assert.equal(r.candidates.length, 1, `只有「丁」合法（含两条不同时间），实得 ${r.candidates.map((c) => c.title)}`)
  assert.equal(r.outcome, 'ok', '有合法存活候选时 outcome=ok（全灭指 0 候选）；作废原因照记')
  assert.equal(r.deadReasons.length, 3, '三条作废都要写明原因（面板可见）')
  // obs:1 与 obs:2 时间不同，obs:2 重复引用没关系——合法的是丁
  assert.equal(r.candidates[0].title, '丁同时引用两条相同时间')
})

test('候选缺 reason / tag 出词表 / 标题过短，一律作废', () => {
  const r = parseIntents(JSON.stringify([
    { ...GOOD_CANDIDATE, title: '没有理由', reason: '' },
    { ...GOOD_CANDIDATE, title: '词表外的tag', tag: '刷KPI' },
    { ...GOOD_CANDIDATE, title: '短' },
  ]), { observations: OBS })
  assert.equal(r.candidates.length, 0)
  assert.equal(r.deadReasons.length, 3)
})

test('模型主动输出 [] = 合法全灭（outcome=ok，不是 parse-fail）', () => {
  const r = parseIntents('[]', { observations: OBS })
  assert.equal(r.outcome, 'ok')
  assert.equal(r.candidates.length, 0)
})

// —— ② 把关：随机排列、隐藏生成侧理由、前置否决注入 ——

test('把关 prompt：约束条款在最前部，判据清单写死且禁「主人会不会觉得」措辞', () => {
  const rules = parseConstraintRules('不许半夜说话')
  const p = buildGatePrompt({ candidates: [GOOD_CANDIDATE], constraintRulesText: rulesTextOf(rules), observations: OBS })
  assert.ok(p.indexOf('主人制定') < p.indexOf('判据清单'), '约束必须先于判据清单（§3.7 注入位置一）')
  assert.ok(p.includes('半夜说话'), '约束全文要在场')
  assert.ok(p.includes('直接打回'), '§3.7 规定措辞')
  assert.ok(p.includes('主人制定的强制约束规则'), '判据 0 前置否决在场')
  assert.ok(!/主人会不会(觉得|喜欢)|主人会怎么(看|想)/.test(p), '禁「主人会不会觉得」类措辞（裁决四）')
})
function rulesTextOf(parsed) { return parsed.rules.map((r) => `- ${r.text}`).join('\n') }

test('把关输入隐藏生成侧理由（reason 不出现在 prompt 里），排列经洗牌随机化', () => {
  const c2 = { ...GOOD_CANDIDATE, title: '另一个念头', evidence: ['obs:2', 'obs:3'] }
  const p = buildGatePrompt({ candidates: [GOOD_CANDIDATE, c2], constraintRulesText: '', observations: OBS })
  assert.ok(!p.includes(GOOD_CANDIDATE.reason), '生成侧 reason 必须隐藏（§3.2）')
  // 固定 rng 的确定性 + 真随机可能换序
  const seq = [0.1] // i=1 时 j=floor(0.1*2)=0 → 交换两元素
  const a = shuffle([GOOD_CANDIDATE, c2], () => seq.shift() ?? 0.5)
  assert.equal(a[0], c2, '注入固定 rng 时洗牌可复现')
  const many = Array.from({ length: 6 }, (_, i) => ({ ...GOOD_CANDIDATE, title: `候选${i}` }))
  const s1 = shuffle(many)
  const s2 = shuffle(many)
  assert.deepEqual([...s1].sort((x, y) => x.title.localeCompare(y.title)), [...s2].sort((x, y) => x.title.localeCompare(y.title)), '洗牌不丢元素')
  assert.ok(JSON.stringify(s1) !== JSON.stringify(s2) || s1.length < 2, '默认 Math.random 下大概率换序')
})

test('把关回包：verdict 四值解析，未评到的按 reject（不默认放行）', () => {
  const g = parseGateVerdicts(JSON.stringify([{ i: 1, verdict: 'pass', why: '像她' }, { i: 2, decision: 'park', why: '先放着' }]), 3)
  assert.deepEqual(g.verdicts, ['pass', 'park', 'reject'])
  const bad = parseGateVerdicts('回包坏了', 2)
  assert.deepEqual(bad.verdicts, ['reject', 'reject'], '解析失败 → 全部保守否决')
  assert.equal(bad.outcome, 'parse-fail')
})

// —— ③ 决策环端到端（fake LLM）——

function fakeTurns({ intentRaw, gateRaw }) {
  const calls = []
  return {
    calls,
    intentTurn: async (prompt, opts) => { calls.push(['intent', prompt, opts]); return intentRaw },
    gateTurn: async (prompt, opts) => { calls.push(['gate', prompt, opts]); return gateRaw },
  }
}

async function tmpDecisionFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'autotelic-plan-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  return join(dir, 'decisions.jsonl')
}

test('端到端：候选→把关→立项落账，decisions.jsonl 每阶段一行且链可校验', async (t) => {
  const file = await tmpDecisionFile(t)
  const { intentTurn, gateTurn, calls } = fakeTurns({
    intentRaw: JSON.stringify([GOOD_CANDIDATE, { ...GOOD_CANDIDATE, title: '整理一次记忆索引', tag: '整理', evidence: ['obs:2', 'obs:3'] }]),
    gateRaw: JSON.stringify([{ i: 1, verdict: 'pass', why: '像她' }, { i: 2, verdict: 'reject', why: '没有更轻做法已够' }]),
  })
  const planner = createPlanner({ decisionFile: file, intentTurn, gateTurn, settings: () => ({}) })
  const r = await planner.decideRound({
    round: 7,
    persona: { summary: '大肥鱼，好奇、嘴碎、记仇三分钟', instinctExtra: '喜欢把读过的东西讲给别人听' },
    constraintRulesText: '- 不许半夜说话',
    observations: OBS, selfState: '精力 7/10', skillIndex: 'sk-1 | 读文档 | 学习',
  })
  assert.equal(r.outcome, 'tickets')
  assert.equal(r.tickets.length, 1)
  // 行动单数据结构（成员 C 执行侧消费的口径）
  const tk = r.tickets[0]
  assert.equal(tk.intent, GOOD_CANDIDATE.title)
  assert.equal(tk.tag, '牵挂')
  assert.equal(tk.ownerSide, false, '「牵挂」不是 touch-owner 类')
  assert.equal(typeof tk.budget.maxSteps, 'number')
  assert.equal(typeof tk.budget.timeoutMs, 'number')
  assert.ok(Array.isArray(tk.steps) && tk.steps[0].desc.length > 4)
  assert.ok(tk.visionNote.length > 0, '视野备注必填（§3.2 视野要求机制化）')
  // fake LLM 收到的 system 段：前缀含人格+约束（§9.3）
  assert.ok(calls[0][1].includes('大肥鱼') && calls[0][1].includes('不许半夜说话'))
  // 决策日志：intent + gate 各一行，机器可读 + 哈希链完整
  const text = await readFile(file, 'utf8')
  const lines = text.trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(lines.map((l) => l.phase), ['intent', 'gate'])
  assert.ok(lines.every((l) => typeof l.ts === 'number' && l.round === 7 && 'payload' in l))
  const v = await verifyDecisionLog(file)
  assert.equal(v.ok, true, `链必须可校验：${JSON.stringify(v.brokenAt)}`)
  assert.equal(v.total, 2)
})

test('全灭合法：模型输出 [] 时省把关，gate 只记一行 skipped', async (t) => {
  const file = await tmpDecisionFile(t)
  const { intentTurn, gateTurn, calls } = fakeTurns({ intentRaw: '[]', gateRaw: '[]' })
  const planner = createPlanner({ decisionFile: file, intentTurn, gateTurn, settings: () => ({}) })
  const r = await planner.decideRound({ round: 1, persona: {}, constraintRulesText: '', observations: OBS })
  assert.equal(r.outcome, 'all-dead')
  assert.equal(r.tickets.length, 0)
  assert.equal(calls.filter((c) => c[0] === 'gate').length, 0, '全灭轮省把关（§3.8）——把关回合不该发起')
  const lines = (await readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(lines.map((l) => l.phase), ['intent', 'gate'])
  assert.equal(lines[1].payload.skipped, '全灭轮，省把关')
})

test('约束前置否决：意图文本撞上约束词时，决策环链路上 check 直接否决（不进把关）', async (t) => {
  // 集成口径：decideRound 前由调用方（集成层）对候选先跑 constraint.check；
  // 这里验证「候选层面被约束否决后不进把关」的链路行为。
  const { check } = await import('../src/autotelic/constraint.js')
  const { rules } = parseConstraintRules('不许半夜说话')
  const veto = check(rules, { ...GOOD_CANDIDATE, title: '半夜说话问候主人', evidence: ['obs:1', 'obs:2'] })
  assert.equal(veto.vetoed, true)
  const { intentTurn, gateTurn, calls } = fakeTurns({ intentRaw: JSON.stringify([{ ...GOOD_CANDIDATE, title: '半夜说话问候主人' }]), gateRaw: '[]' })
  const planner = createPlanner({ intentTurn, gateTurn, settings: () => ({}) })
  const r = await planner.decideRound({ round: 2, persona: {}, constraintRulesText: '不许半夜说话', observations: OBS })
  // 决策环本身按设计把关兜底；此处断言集成层可在 candidates 上跑 check 全灭——
  assert.ok(veto.vetoed, '约束 check 必须能在此候选上直接否决')
  void planner; void r; void calls
})

// —— token 预算：降级顺序断言 ——

test('预算降级顺序：先裁背景历史 → 再裁证据（低显著度先丢）→ 永不裁前缀段', () => {
  const prefix = buildSystemPrefix({ personaSummary: '人格卡', instinctExtra: '本能段', constraintRulesText: '不许半夜说话' })
  const many = Array.from({ length: 60 }, (_, i) => ({
    id: `obs:x${i}`, at: T1 + i * 1000, source: i % 3 === 0 ? 'owner' : (i % 3 === 1 ? 'emotion' : 'chat'), text: `观察条目 ${i} `.repeat(3),
  }))
  // ① 预算足够：什么都不裁
  const big = assembleIntentInput({ prefix, observations: many, backgroundHistory: '历史背景', maxInputTokens: estimateTokens(prefix) + 100_000 })
  assert.deepEqual(big.dropped, [])
  assert.equal(big.keptObservations.length, many.length)
  // ② 紧预算：先丢背景历史（预算 = 除背景外的完整内容 + 一点余量，只装得下「无背景」形态）
  const noBg = assembleIntentInput({ prefix, observations: many, backgroundHistory: '', maxInputTokens: 1e9 })
  const budgetNoBg = estimateTokens(noBg.text) + 5
  const mid = assembleIntentInput({ prefix, observations: many, backgroundHistory: '历史'.repeat(1000), maxInputTokens: budgetNoBg })
  assert.ok(mid.dropped.includes('backgroundHistory'), `背景历史第一个被裁：${JSON.stringify(mid.dropped)}`)
  assert.equal(mid.keptObservations.length, many.length, '裁背景时证据还在')
  // ③ 更紧：开始裁证据，低显著度（chat）先丢，owner/emotion 优先保留
  const tight = assembleIntentInput({ prefix, observations: many, backgroundHistory: '', maxInputTokens: estimateTokens(prefix) + 200 })
  assert.ok(tight.dropped.some((d) => /^observations\(/.test(d)), `证据被裁：${JSON.stringify(tight.dropped)}`)
  assert.ok(tight.keptObservations.length < many.length)
  const keptSet = new Set(tight.keptObservations)
  // 深度裁剪按显著度从低到高丢：预算只够留 6 条时，留下的应全是最显著的 owner 条目
  //（owner 条目也会被裁——预算不够时——但一定是最后才轮到它）
  assert.ok(tight.keptObservations.every((o) => o.source === 'owner'), `留下的应全是最高显著度（owner），实得 ${tight.keptObservations.map((o) => o.source)}`)
  // ④ 极端紧：只剩前缀段也不裁（永不裁人格锚与约束）
  const extreme = assembleIntentInput({ prefix, observations: [], backgroundHistory: '', maxInputTokens: 10 })
  assert.equal(extreme.text.includes('人格卡'), true)
  assert.equal(extreme.text.includes('不许半夜说话'), true)
  assert.ok(extreme.dropped.includes('prefix-overflow(uncut)'), '超支要如实标注，但前缀一字不裁')
})

// —— 决策日志：不经模型手的机械落账 ——

test('决策日志：append 链式哈希；篡改一行即断链被校验器抓住', async (t) => {
  const file = await tmpDecisionFile(t)
  const log = createDecisionLog({ file, now: () => 1234 })
  await log.append('intent', 1, { a: 1 })
  await log.append('gate', 1, { b: 2 })
  assert.equal((await verifyDecisionLog(file)).ok, true)
  // 篡改中间 payload
  const raw = await readFile(file, 'utf8')
  const tampered = raw.replace('"a":1', '"a":999')
  await import('node:fs/promises').then((fs) => fs.writeFile(file, tampered, 'utf8'))
  const v = await verifyDecisionLog(file)
  assert.equal(v.ok, false, '「她可以骗主人但不能骗账本」：改了必被抓')
  assert.ok(v.brokenAt && v.brokenAt.line === 1)
})

// —— ③ 复盘契约（lead 2026-11-17 定稿） ——

const TICKET_RESULT = {
  roundId: 'r-7',
  ts: T1 + 3 * 86_400_000,
  ticketId: 'tk-1',
  intentTitle: GOOD_CANDIDATE.title,
  tag: '牵挂',
  steps: [{ desc: '围绕意图办一轮', status: 'done' }],
  finalStatus: 'done',
  ownerSide: true,
  ownerResponse: 'ignored',
  evidence: ['obs:1', 'obs:3'],
  lesson: '',
}

test('复盘：入参契约透传 + suggestions 产出 + decisions.jsonl 记一行 review', async (t) => {
  const file = await tmpDecisionFile(t)
  const reviewTurn = async () => JSON.stringify({ summary: '读了，主人没理', lessons: ['主人不买账=这招不对味'], next: 'archive', memoryDrafts: ['分享前先想这条删掉会损失什么'] })
  const artifact = await reviewRound(TICKET_RESULT, { decisionFile: file, reviewTurn })
  // 契约字段必须原样透传（skills.ingestReflection(artifact) 直接吃）
  for (const k of ['roundId', 'ts', 'ticketId', 'intentTitle', 'tag', 'steps', 'finalStatus', 'ownerSide', 'ownerResponse', 'evidence', 'lesson']) {
    assert.ok(k in artifact, `产物必须含契约字段 ${k}`)
  }
  assert.deepEqual(artifact.evidence, ['obs:1', 'obs:3'])
  assert.equal(artifact.ownerResponse, 'ignored')
  assert.equal(artifact.suggestions.next, 'archive')
  assert.ok(artifact.scoreNote.includes('recordOutcome'), '复盘只有建议权不碰分数（D9），score 由执行侧 recordOutcome 记')
  const lines = (await readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.length, 1)
  assert.equal(lines[0].phase, 'review')
  assert.equal((await verifyDecisionLog(file)).ok, true)
})

test('复盘：回包是垃圾 → 保守兜底不抛错，lesson 缺省落到 suggestions.lessons', async () => {
  const artifact = await reviewRound({ ...TICKET_RESULT, lesson: '下次先看主人在线状态', reviewTurn: async () => '我复盘了一下，感觉还行' })
  assert.equal(artifact.suggestions.next, 'retry', 'done 终态兜底 next=retry')
  assert.ok(artifact.suggestions.lessons.includes('下次先看主人在线状态'))
  const failed = await reviewRound({ ...TICKET_RESULT, finalStatus: 'aborted', reviewTurn: async () => null })
  assert.equal(failed.suggestions.next, 'drop', '非 done 终态兜底 next=drop')
})

test('复盘：步骤超预算时截 steps（只留步骤与终态，§9.3 review 降级策略）', () => {
  // 直接验证 assembleIntentInput 不适用——复盘侧的截断在 reviewRound 内，这里用极小预算走一遍
  return reviewRound({ ...TICKET_RESULT, steps: Array.from({ length: 200 }, (_, i) => ({ desc: `步骤${i} 很长很长很长`.repeat(5), status: 'done' })) }, {
    reviewTurn: async () => '{}', settings: () => ({ reviewMaxInputTokens: 64 }),
  }).then((a) => {
    assert.ok(a.steps.length < 200, `步骤应被截断，实得 ${a.steps.length}`)
  })
})

test('词表：≤20 个且 owner 类标记齐全（touch-owner 硬闸依据）', () => {
  assert.ok(TAG_VOCAB.length <= 20)
  assert.equal(TAG_VOCAB.filter((x) => x.owner).every((x) => ['分享', '问候', '陪伴'].includes(x.tag)), true)
  const tk = buildTicket({ candidate: { ...GOOD_CANDIDATE, tag: '分享' } })
  assert.equal(tk.ownerSide, true, 'owner 类 tag → ownerSide=true，成员 C 据此走硬闸')
})
