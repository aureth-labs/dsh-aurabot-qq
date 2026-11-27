import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize } from '../src/core/config.js'
import { createMemoryStore, parseFollowUpAt, compressionClusters, shouldForget } from '../src/features/memory.js'
import { createPurpose } from '../src/purpose/module.js'
import { collectMaterials, minePurposeSeeds, selectPurpose, FOLLOW_UP_WEIGHT } from '../src/purpose/engine.js'
import { readMemoryState, writeMemoryState } from './helpers/memory-state.js'

const OWNER = '10000001'
const FRIEND = '10000002'
const STRANGER = '10000003'
const DAY = 86400_000
const log = { info() {}, warn() {}, debug() {}, error() {} }
const chat = (qq) => ({ kind: 'private', chatId: `private:${qq}`, userId: qq })
const dayKey = (at) => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const fact = (patch = {}) => ({ text: '主人公司正在裁员，还在等通知', about: '主人', about_qq: OWNER, speaker: OWNER, status: 'fact', tier: 3, follow_up: { question: '公司裁员的事后来怎么样了？' }, ...patch })

function setup(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-follow-up-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const cfg = normalize({ enabled: true, dryRun: false, ownerQQ: OWNER, ownerName: '主人',
    model: { provider: 'p', model: 'm' }, voice: { enabled: false }, stickers: { enabled: false },
    memory: { compress: false, gistEnabled: false, keepChatlogDays: -1, ...options.memory },
    speakUp: { allow: [FRIEND], awakeFrom: 0, awakeTo: 24, nudge: false, idleMinutes: 1, minIntervalMinutes: 1, maxIntervalMinutes: 1, maxPerDay: 2 },
    ext: { purpose: { enabled: false, minMaterials: 2 } },
  })
  const rows = options.rows || [{ chatId: `private:${OWNER}`, uid: OWNER, who: '主人', text: '公司最近在裁员，我还在等通知，有点担心', t: now - 1000 }]
  const extraction = options.extraction || { facts: [fact()] }
  const calls = [], pushed = [], generated = [], delivered = []
  const dsh = { get: () => null, llm: { async *stream({ system, messages }) {
    calls.push({ system, text: messages?.[0]?.content?.[0]?.text || '' })
    yield { type: 'text-delta', text: system.includes('整理长期记忆') ? JSON.stringify(extraction) : '{"insights":[],"style":[]}' }
    yield { type: 'finish', reason: { kind: 'completed' } }
  } } }
  const muted = new Set()
  const hub = {
    lastOwnerChatAt: 0, lastBotToOwner: { at: 0, text: '' }, lastPrivateAt: () => 0,
    chatLogDays: () => [...new Set(rows.map((r) => dayKey(r.t)))].sort(),
    chatLogOf: (day) => rows.filter((r) => dayKey(r.t) === day),
    forgetChatLog: () => 0, speakersOf: () => [], groupNames: new Map(),
    async pushToSession(target, content, sender, opts) {
      pushed.push({ target, text: content[0].text, opts })
      if (options.sent !== false) opts?.onDelivered?.()
    },
    async runSystemTurn(id, title, prompt) { generated.push(prompt); return options.reply ?? '公司那件事后来怎么样了？' },
    async deliver(target, text) { delivered.push({ target, text }); return { sent: options.sent === false ? '' : text } },
  }
  const mem = createMemoryStore({ dsh, getConfig: () => cfg, hub, log })
  const purpose = createPurpose({ getConfig: () => cfg, hub, log, memory: () => mem, isMuted: (id) => muted.has(id), personaText: () => '' })
  const pending = (patch = {}) => {
    const qq = patch.about || OWNER
    return mem.add({ text: '主人公司正在裁员，还在等通知', about: qq, aboutName: qq, speaker: qq, status: 'fact', tier: 3,
      source: 'auto', chatId: `private:${qq}`, saidAt: now - 5 * DAY,
      followUp: { at: now - 1000, question: '裁员的事后来怎么样了？' }, ...patch }).id
  }
  const state = () => readMemoryState(dir)
  const get = (id) => state().items.find((m) => m.id === id)
  t.after(() => {
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, cfg, rows, extraction, calls, mem, purpose, hub, muted, pushed, generated, delivered, pending, state, get,
    advance: (days) => { now += days * DAY } }
}

test('提炼 follow_up 写进原事实，默认按原话后 3 天；明确日期保留到晚上', async (t) => {
  const s = setup(t)
  assert.equal((await s.mem.consolidate({ includeToday: true })).ok, true)
  const m = s.state().items.find((m) => m.text.includes('裁员'))
  assert.deepEqual(m.followUp, { at: s.rows[0].t + 3 * DAY, tries: 0, question: '公司裁员的事后来怎么样了？' })
  const call = s.calls.find((c) => c.system.includes('整理长期记忆'))
  assert.match(call.system, /本人亲口说的.*尚无结果.*重要/)
  assert.match(call.system, /周三面试就周三晚上/)
  assert.match(call.system, /follow_up:null/)
  const at = new Date(2030, 4, 15, 20).getTime()
  assert.equal(parseFollowUpAt('2030-05-15 20:00'), at)
  assert.equal(parseFollowUpAt('2030-05-15'), at)
  assert.equal(parseFollowUpAt('2030-02-30 25:90', s.rows[0].t), s.rows[0].t + 3 * DAY)
})

for (const [label, patch] of [
  ['琐碎', { tier: 1 }], ['没有档位', { tier: undefined }], ['转述', { status: 'hearsay' }], ['猜测', { status: 'guess' }],
  ['主人说别人的事', { about: '朋友', about_qq: FRIEND }],
]) {
  test(`提炼不跟进${label}`, async (t) => {
    const s = setup(t, { extraction: { facts: [fact(patch)] } })
    await s.mem.consolidate({ includeToday: true })
    assert.ok(s.state().items.length)
    assert.ok(s.state().items.every((m) => !m.followUp))
  })
}

for (const [label, qq, id, allowed] of [
  ['白名单私聊', FRIEND, `private:${FRIEND}`, true],
  ['非白名单私聊', STRANGER, `private:${STRANGER}`, false],
  ['白名单在群里说', FRIEND, 'group:20000001', false],
]) {
  test(`提炼范围：${label}`, async (t) => {
    const s = setup(t, { rows: [{ chatId: id, uid: qq, who: '朋友', text: '我下周要面试，还没结果，很在意', t: Date.now() - 1000 }],
      extraction: { facts: [fact({ about: '朋友', about_qq: qq, speaker: qq, text: '朋友下周要面试，还没结果' })] } })
    await s.mem.consolidate({ includeToday: true })
    assert.equal(s.state().items.some((m) => Boolean(m.followUp)), allowed)
  })
}

// P5：以下 8 个用例原测「到期 followUp 由主动搭话（companion.fire/tick）注入与回执」——
// companion 已随 speakup 模块退场删除，purpose 等价语义（发出才延期、沉默/投递失败不计数、
// 到期素材常量权重优先选中）由下方「目的引擎…」用例与 purpose.test.js 覆盖。

for (const op of ['update', 'outdated']) {
  test(`${op} 有结果后清掉；outdated 的历史条目也不保留跟进`, async (t) => {
    const s = setup(t)
    const id = s.pending()
    s.extraction.facts = [fact({ op, id, text: '主人收到通知，这轮裁员没有被裁，已经安心了', follow_up: null })]
    await s.mem.consolidate({ includeToday: true })
    assert.ok(s.state().items.some((m) => m.text.includes('已经安心了')))
    assert.ok(s.state().items.every((m) => !m.followUp))
    if (op === 'outdated') assert.ok(s.get(id).invalidAt)
  })

  test(`${op} 还没结果维持原跟进次数和时间`, async (t) => {
    const s = setup(t)
    const id = s.pending()
    s.mem.markFollowUpAsked(id)
    const old = s.get(id).followUp
    s.extraction.facts = [fact({ op, id, text: '主人公司还没有发裁员通知，仍在等消息', follow_up: undefined })]
    await s.mem.consolidate({ includeToday: true })
    const current = s.state().items.find((m) => !m.invalidAt && m.text.includes('仍在等消息'))
    assert.deepEqual(current.followUp, old)
    if (op === 'outdated') assert.equal(s.get(id).followUp, undefined)
  })
}

test('复用去重，重复提炼不新建跟进也不重置问过次数', async (t) => {
  const s = setup(t)
  const id = s.pending()
  s.mem.markFollowUpAsked(id)
  const old = s.get(id).followUp
  await s.mem.consolidate({ includeToday: true })
  assert.equal(s.state().items.length, 1)
  assert.deepEqual(s.get(id).followUp, { ...old, question: '公司裁员的事后来怎么样了？' })
})

test('取消、忘掉都清理原字段，迟到的发送回执不能复活跟进', async (t) => {
  const s = setup(t, { sent: false })
  const id = s.pending()
  const other = s.pending({ text: '主人下周要参加重要面试' })
  assert.equal(s.mem.update(id, { followUp: null }).ok, true)
  const r = s.mem.handleCommand(chat(OWNER), '忘掉主人下周要参加重要面试')
  assert.equal(r.ok, true)
  assert.equal(s.get(other).followUp, undefined)
  assert.ok(s.get(other).invalidAt)
  assert.equal(s.mem.markFollowUpAsked(other), false)
})

// P5：以下两个用例（禁言/讨厌白名单、awake/daily/gap/active 闸门）原测 companion.tickFriends
// 与 speakup 排程闸门——companion 已删；purpose 侧闸门（安静时段/预算/禁言/讨厌）由
// purpose.test.js 与 proactive-policy.test.js 覆盖。

test('默认打开，关闭后不提炼、不注入、不计数；总记忆关闭同样不生效', async (t) => {
  const s = setup(t)
  assert.equal(normalize({}).memory.followUp, true)
  assert.equal(normalize({ memory: { followUp: 'false' } }).memory.followUp, true)
  const id = s.pending()
  s.cfg.memory.followUp = false
  await s.mem.consolidate({ includeToday: true })
  assert.equal(s.mem.dueFollowUp(OWNER), null)
  assert.equal(s.mem.markFollowUpAsked(id), false)
  assert.equal(s.get(id).followUp.tries, 0)
  const extra = s.pending({ text: '主人等待医院检查结果' })
  assert.equal(s.get(extra).followUp, undefined)
  s.cfg.memory.followUp = true
  s.cfg.memory.enabled = false
  assert.equal(s.mem.dueFollowUp(OWNER), null)
})

test('待跟进事实不被长期印象压缩吞掉；普通旧细节仍可压缩', (t) => {
  const s = setup(t)
  const id = s.pending()
  const base = s.get(id)
  const items = Array.from({ length: 4 }, (_, i) => ({ ...base, id: `old${i}`, saidAt: Date.now() - 50 * DAY, followUp: undefined }))
  assert.equal(compressionClusters(items).length, 1)
  assert.equal(compressionClusters(items.map((m) => ({ ...m, followUp: base.followUp }))).length, 0)
  assert.equal(shouldForget({ ...base, at: Date.now() - 180 * DAY, importance: 0.3 }), false)
})

test('目的引擎到期素材使用常量权重、优先选中，一轮只带一件', (t) => {
  const s = setup(t)
  const id = s.pending()
  const items = [s.get(id), { ...s.get(id), id: 'later', followUp: { at: Date.now() + DAY, tries: 0, question: '以后才问' } }]
  const { items: materials, stats } = collectMaterials({ followUpRecords: items })
  assert.equal(stats.followUp, 1)
  const seeds = minePurposeSeeds({ materials })
  assert.equal(seeds[0].weight, FOLLOW_UP_WEIGHT)
  const picked = selectPurpose({ seeds, random: () => 0.99, history: [{ sourceId: seeds[0].sourceId, text: seeds[0].text }] })
  assert.equal(picked.purpose.kind, 'memory-follow-up', '合法的下一次跟进不被旧历史永久去重')
  assert.match(picked.purpose.text, /裁员的事后来怎么样了/)
})

test('目的引擎只在开启时使用同一事实；发出才延期，不复制到 pending/goals', async (t) => {
  const s = setup(t, { rows: [], reply: '裁员的事后来怎么样了？\n【目的】关心裁员\n【状态】待续\n【待续】再问裁员结果' })
  const id = s.pending()
  assert.equal((await s.purpose.fire()).outcome, 'disabled')
  s.cfg.ext.purpose.enabled = true
  assert.equal((await s.purpose.fire()).outcome, 'sent')
  assert.match(s.generated[0], /裁员的事后来怎么样了/)
  assert.equal(s.get(id).followUp.tries, 1)
  const purposeState = JSON.parse(readFileSync(join(s.dir, 'purpose', 'purpose-state.json'), 'utf8'))
  assert.deepEqual(purposeState.pending, [])
  assert.deepEqual(purposeState.goals, [])
  s.cfg.memory.followUp = false
  assert.equal((await s.purpose.preview()).stats.followUp, 0)
  s.muted.add(`private:${OWNER}`)
  assert.equal((await s.purpose.fire()).outcome, 'muted')
})

for (const [label, opts] of [['沉默', { reply: '[沉默]' }], ['投递失败', { sent: false }]]) {
  test(`目的引擎${label}不消耗跟进次数`, async (t) => {
    const s = setup(t, opts)
    const id = s.pending()
    s.cfg.ext.purpose.enabled = true
    await s.purpose.fire()
    assert.equal(s.get(id).followUp.tries, 0)
  })
}

// P5：原「主动回合排队/准入时序」与「真实发送回执」两组用例都经 companion.fire 注入 followUp，
// companion 已删。purpose 投递链路的时序与回执语义由 purpose.test.js（投递/回执/排程）覆盖，
// 跟进计数口径由上方「目的引擎…」用例覆盖。

