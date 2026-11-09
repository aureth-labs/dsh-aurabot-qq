// persona-memory 吸纳：派生视图、只读推荐、细档位与召回门槛，含真实存储的旧数据兼容。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Script } from 'node:vm'
import { normalize, mergeFromPanel } from '../src/core/config.js'
import { createMemoryStore, buildIndex, search, memoryLine } from '../src/features/memory.js'
import { FACT_TIERS, tierDays, strongerTier, memoryPlatforms } from '../src/features/memory-rules.js'
import memoryModule from '../src/modules/memory/index.js'
import { readMemoryState, writeMemoryState } from './helpers/memory-state.js'

const OWNER = '10000001', A = '30000001', B = '30000002', C = '30000003'
const DAY = 86400_000
const log = { info() {}, warn() {}, debug() {} }
const chat = (qq) => ({ kind: 'private', userId: qq, chatId: `private:${qq}` })
const dayKey = (at) => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const fact = (id, text, patch = {}) => ({ id, text, about: A, source: 'auto', chatId: chat(A).chatId, at: Date.now() - 1000, saidAt: Date.now() - 1000, importance: 0.8, ...patch })

function setup(t, memory = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-memory-absorb-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const cfg = normalize({ ownerQQ: OWNER, ownerName: '主人', allow: { private: [A, B, C] }, model: { provider: 'p', model: 'm' }, memory: { compress: false, keepChatlogDays: -1, ...memory } })
  const rows = [], calls = []
  let answer = ({ system }) => system.includes('整理长期记忆') ? '{"facts":[]}' : system.includes('压成一句') ? '{"text":"我和朋友聊过茶和旅行"}' : system.includes('人物小档案') ? '朋友喜欢喝茶和旅行' : '{"insights":[],"style":[]}'
  const dsh = { get: () => null, llm: { async *stream({ system, messages }) {
    const input = { system, text: messages?.[0]?.content?.[0]?.text || '' }
    calls.push(input)
    yield { type: 'text-delta', text: await answer(input) }
    yield { type: 'finish', reason: { kind: 'completed' } }
  } } }
  const hub = {
    chatLogDays: () => [...new Set(rows.map((r) => dayKey(r.t)))].sort(),
    chatLogOf: (day) => rows.filter((r) => dayKey(r.t) === day),
    deleteChatLog: (day) => { for (let i = rows.length - 1; i >= 0; i--) if (dayKey(rows[i].t) === day) rows.splice(i, 1) },
    groupNames: new Map(), speakersOf: () => [], forgetChatLog: () => 0,
  }
  const make = () => createMemoryStore({ getConfig: () => cfg, dsh, hub, log })
  const mem = make()
  t.after(() => {
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, cfg, mem, make, hub, dsh, rows, calls, answer: (fn) => { answer = fn },
    seed: (items, extra = {}) => writeMemoryState(dir, { items, ...extra }), state: () => readMemoryState(dir) }
}

function routes(s) {
  const handlers = new Map()
  memoryModule.setup({ config: () => s.cfg, dsh: s.dsh, log, core: { hub: s.hub, http: { query: (req) => req.query || {}, body: async (req) => req.body || {} } },
    context() {}, on() {}, every() {}, tool() {}, route: (path, fn) => handlers.set(path, fn) })
  return handlers
}

test('档位保留旧编号和自定义期限，新增 1 / 15 天，不把 0 天当永久', () => {
  const cfg = normalize({ memory: { tierDays: { 1: 12, 2: 45, 3: 120, 4: 0, 5: 22 } } })
  assert.deepEqual(cfg.memory.tierDays, { 1: 12, 2: 45, 3: 120, 4: 0, 5: 22 })
  assert.deepEqual(normalize({}).memory.tierDays, { 1: 7, 2: 30, 3: 90, 4: 1, 5: 15 })
  assert.deepEqual(FACT_TIERS.map((t) => t.id), [4, 1, 5, 2, 3, 0])
  assert.equal(tierDays(4, cfg.memory.tierDays), 0)
  assert.equal(tierDays(0, cfg.memory.tierDays), null)
  assert.equal(tierDays(undefined), null)
  const saved = mergeFromPanel(cfg, { memory: { tierDays: { ...cfg.memory.tierDays, 5: 19 }, recallMinRelevance: 0.6 } })
  assert.equal(saved.memory.tierDays[1], 12)
  assert.equal(saved.memory.tierDays[5], 19)
  assert.equal(saved.memory.recallMinRelevance, 0.6)
  assert.equal(normalize({ memory: { recallMinRelevance: 2 } }).memory.recallMinRelevance, 1)
  assert.equal(normalize({ memory: { recallMinRelevance: -1 } }).memory.recallMinRelevance, 0)
  assert.equal(normalize({}).memory.recallMinRelevance, 0)
  assert.equal(normalize({ memory: { recallMinRelevance: 'bad' } }).memory.recallMinRelevance, 0)
})

for (const backend of ['sqlite', 'json']) test(`${backend}：旧 1/2/3/0 与无档位记忆重启、整理后保留原期限和时间`, async (t) => {
  const s = setup(t)
  const items = [fact('old1', '朋友喜欢红茶', { tier: 1, at: Date.now() - 6 * DAY }), fact('old2', '朋友住在杭州', { tier: 2, at: Date.now() - 29 * DAY }),
    fact('old3', '朋友学习钢琴', { tier: 3, at: Date.now() - 89 * DAY }), fact('old0', '朋友珍惜约定', { tier: 0, importance: 0.1, at: Date.now() - 900 * DAY }),
    fact('no-tier', '朋友有一个蓝色杯子', { source: 'tool', at: Date.now() - 900 * DAY })]
  s.seed(items)
  if (backend === 'json') {
    writeFileSync(join(s.dir, 'memories.json'), JSON.stringify({ items }))
    writeFileSync(join(s.dir, 'memory-json-fallback.json'), '{}')
  }
  assert.equal((await s.mem.consolidate()).ok, true)
  const restart = s.make()
  assert.equal((await restart.consolidate()).ok, true)
  for (const original of items) {
    const stored = s.state().items.find((m) => m.id === original.id)
    assert.ok(stored, original.id)
    assert.equal(stored.tier, original.tier)
    assert.equal(stored.at, original.at)
    assert.equal(stored.saidAt, original.saidAt)
    assert.equal(stored.tierLabel, undefined)
    assert.equal(stored.tierDays, undefined)
  }
  assert.deepEqual(s.state().gists || [], [])
  assert.equal(restart.list('').find((m) => m.id === 'old3').tierDays, 90)
})

test('旧的自定义天数在实际整理中仍生效，不按新默认值提前压缩', async (t) => {
  const s = setup(t, { tierDays: { 1: 12, 2: 45, 3: 120 } })
  s.seed([fact('custom1', '朋友在筹备茶会', { tier: 1, at: Date.now() - 10 * DAY }),
    fact('custom2', '朋友在杭州工作', { tier: 2, at: Date.now() - 40 * DAY }),
    fact('custom3', '朋友学习钢琴', { tier: 3, at: Date.now() - 100 * DAY })])
  await s.mem.consolidate()
  assert.deepEqual(s.state().items.map((m) => m.id), ['custom1', 'custom2', 'custom3'])
  assert.deepEqual(s.state().gists || [], [])
  assert.deepEqual(s.mem.personaPerson(A).factTiers.filter((t) => [1, 2, 3].includes(t.id)).map((t) => t.days), [12, 45, 120])
})

test('去重提升期限按实际天数，不按编号；永久不会被新档位降级', (t) => {
  const { mem, cfg } = setup(t)
  const add = (tier) => mem.add({ text: '朋友喜欢喝红茶', about: A, chatId: chat(A).chatId, tier })
  const id = add(4).id
  for (const tier of [1, 5, 2, 3, 0]) {
    assert.equal(add(tier).updated, id)
    assert.equal(mem.list('')[0].tier, tier)
  }
  add(5)
  assert.equal(mem.list('')[0].tier, 0)
  assert.equal(strongerTier(3, 5), 3)
  cfg.memory.tierDays[1] = 100
  assert.equal(strongerTier(3, 1, cfg.memory.tierDays), 1)
  assert.equal(strongerTier('core', 4), 'core')
})

test('新增两档到期先压缩，失败或预算不足时保留事实；永久不压', async (t) => {
  const s = setup(t)
  s.seed([fact('short', '朋友昨天顺路买了红茶', { tier: 4, at: Date.now() - 2 * DAY }), fact('normal', '朋友最近去杭州旅行', { tier: 5, at: Date.now() - 16 * DAY }), fact('permanent', '朋友珍惜约定', { tier: 0, at: Date.now() - 500 * DAY })])
  s.answer(({ system }) => { if (system.includes('压成一句')) throw new Error('模拟离线'); return '{"insights":[],"style":[]}' })
  await s.mem.consolidate()
  assert.equal(s.state().items.length, 3)
  s.cfg.memory.gistDailyBatches = 0
  s.answer(() => '{"text":"我记得朋友喝茶和旅行"}')
  await s.mem.consolidate()
  assert.equal(s.state().items.length, 3)
  s.cfg.memory.gistDailyBatches = 6
  await s.mem.consolidate()
  assert.deepEqual(s.state().items.map((m) => m.id), ['permanent'])
  assert.equal(s.state().gists.length, 1)
})

test('提炼接受两档，提示词采用配置天数；面板能改档而不能给外部内容改档', async (t) => {
  const s = setup(t, { tierDays: { 4: 2, 5: 16 } })
  s.rows.push({ chatId: chat(A).chatId, uid: A, who: '阿甲', text: '我今天出门买茶，最近在杭州旅行', t: Date.now() - 1000 })
  s.answer(({ system }) => system.includes('整理长期记忆') ? JSON.stringify({ facts: [
    { text: '阿甲今天出门买茶', about_qq: A, speaker: A, tier: 4 }, { text: '阿甲最近在杭州旅行', about_qq: A, speaker: A, tier: 5 },
  ] }) : '{"insights":[],"style":[]}')
  await s.mem.consolidate({ includeToday: true })
  assert.deepEqual(s.mem.list('').map((m) => m.tier).sort(), [4, 5])
  assert.match(s.calls.find((c) => c.system.includes('整理长期记忆')).system, /4 短暂（2天）.*5 小事（16天）/)
  const handlers = routes(s)
  const id = s.mem.list('')[0].id
  assert.equal((await handlers.get('/memory/update')({ body: { id, tier: 2 } })).ok, true)
  assert.equal(s.make().list('').find((m) => m.id === id).tier, 2)
  assert.equal(s.mem.update(id, { tier: 6 }).ok, false)
  const seen = s.mem.addEvent({ kind: 'seen', meta: { title: '茶叶视频', platform: 'bili' } })
  assert.equal(s.mem.update(seen.id, { tier: 4 }).ok, false)
})

test('星图复用已有亲疏和关系，旧名字关系只在唯一匹配时连线，不因查看写库', (t) => {
  // 亲疏包含随时间衰减的最近互动项；两个视图必须在同一时刻比较。
  const now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const s = setup(t)
  s.seed([], { profiles: { [OWNER]: { name: '主人' }, [A]: { name: '阿甲' }, [B]: { name: '同名' }, [C]: { name: '同名' } }, relations: [
    { id: 'by-qq', subj: '阿甲', subjQq: A, pred: '的同学是', obj: '同名', objQq: B, chatId: 'group:77' },
    { id: 'ambiguous', subj: '阿甲', pred: '的朋友是', obj: '同名', chatId: 'group:77' },
    { id: 'by-name', subj: '阿甲', pred: '认识', obj: '主人', chatId: chat(OWNER).chatId },
  ] })
  s.rows.push(...Array.from({ length: 8 }, (_, i) => ({ chatId: chat(A).chatId, uid: A, who: '阿甲', text: '互动', t: Date.now() - i * 1000 })),
    { chatId: 'group:77', uid: B, who: '同名', text: '只是路过发言', t: Date.now() })
  const before = s.state()
  const graph = s.mem.personaGraph()
  assert.equal(graph.nodes.length, 4)
  assert.deepEqual(graph.links.map((e) => e.id), ['by-qq', 'by-name'])
  assert.ok(graph.nodes.find((p) => p.qq === A).closeness > graph.nodes.find((p) => p.qq === B).closeness)
  assert.equal(graph.nodes.find((p) => p.qq === A).closeness, s.mem.personaOverview().find((p) => p.qq === A).closeness)
  assert.deepEqual(s.state(), before)
  s.mem.setNoMemory(B, true)
  assert.ok(!s.mem.personaGraph().nodes.some((p) => p.qq === B))
  assert.ok(!s.mem.personaGraph().links.some((e) => e.id === 'by-qq'))
  s.mem.deletePerson(A)
  assert.ok(!s.mem.personaGraph().nodes.some((p) => p.qq === A))
  assert.deepEqual(s.mem.personaGraph().links, [])
})

test('推荐按已有 related、同话题、同人物补充，去重限六条，不记命中或召回日志', (t) => {
  const s = setup(t)
  s.seed([fact('anchor', '朋友喜欢红茶', { related: ['linked'] }), fact('linked', '周末在湖边散步', { related: ['anchor'] }),
    fact('topic', '红茶的香味很独特', { about: B }), ...Array.from({ length: 8 }, (_, i) => fact('person-' + i, '住在杭州的小区' + i)),
    fact('old', '红茶过时内容', { invalidAt: Date.now() - 1000 }), fact('future', '红茶未来内容', { validFrom: Date.now() + DAY })])
  const before = s.state(), recalls = s.mem.recalls()
  const list = s.mem.recommendations({ id: 'anchor' })
  assert.equal(list[0].id, 'linked')
  assert.equal(list[0].reason, '已关联')
  assert.ok(list.some((m) => m.id === 'topic' && m.reason === '同话题'))
  assert.ok(list.some((m) => m.reason === '同人物'))
  assert.equal(list.length, 6)
  assert.equal(new Set(list.map((m) => m.id)).size, list.length)
  assert.ok(!list.some((m) => ['anchor', 'old', 'future'].includes(m.id)))
  assert.deepEqual(s.state(), before)
  assert.deepEqual(s.mem.recalls(), recalls)
  assert.deepEqual(s.mem.recommendations({ id: 'missing' }), [])
})

test('时间轴梗概和 seen 都能作为推荐入口；梗概不跨聊天，停记与删除立即生效', (t) => {
  const s = setup(t)
  s.seed([fact('topic', '朋友喜欢在旅行时喝红茶')], { gists: [
    fact('gist-a', '我们旅行时聊了红茶', { kind: 'gist', level: 1 }),
    fact('gist-b', '别的群也聊了红茶', { kind: 'gist', scope: 'group', about: '', chatId: 'group:88', level: 1 }),
  ] })
  assert.ok(s.mem.recommendations({ id: 'gist-a', kind: 'gist' }).some((m) => m.id === 'topic'))
  assert.ok(!s.mem.recommendations({ id: 'topic' }).some((m) => m.id === 'gist-b'))
  const seen = s.mem.addEvent({ kind: 'seen', text: '红茶旅行视频', meta: { title: '红茶旅行', platform: 'douyin' } })
  assert.ok(s.mem.recommendations({ id: seen.id, kind: 'seen' }).some((m) => m.id === 'topic'))
  s.mem.setNoMemory(A, true)
  assert.deepEqual(s.mem.recommendations({ id: 'topic' }), [])
  assert.ok(!s.mem.recommendations({ id: seen.id }).some((m) => m.id === 'topic'))
  s.mem.remove(seen.id)
  assert.deepEqual(s.mem.recommendations({ id: seen.id }), [])
})

test('模块推荐显式传 chat 时不能通过关联、同人物或同话题绕过来源/主人隐私', (t) => {
  const s = setup(t)
  s.seed([fact('anchor', '旅行红茶', { chatId: 'group:77', related: ['owner', 'elsewhere', 'safe'] }),
    fact('owner', '主人私事红茶', { about: OWNER, chatId: 'group:77' }), fact('elsewhere', '阿甲的私聊红茶'),
    fact('safe', '阿甲在群里聊红茶', { chatId: 'group:77' }), fact('group', '这个群常聊红茶', { about: '', scope: 'group', chatId: 'group:77' })])
  const current = { kind: 'group', chatId: 'group:77', groupId: '77' }
  const list = s.mem.recommendations({ id: 'anchor', chat: current })
  assert.deepEqual(new Set(list.map((m) => m.id)), new Set(['safe', 'group']))
  assert.deepEqual(s.mem.recommendations({ id: 'owner', chat: current }), [])
  assert.deepEqual(s.mem.recommendations({ id: 'elsewhere', chat: current }), [])
})

test('召回门槛使用原始相关度，人物和重要性加分不能救回低相关条目', (t) => {
  const { mem, cfg, seed } = setup(t)
  seed([fact('tea', '红茶', { importance: 1, about: OWNER, chatId: chat(OWNER).chatId })])
  const opts = { where: chat(OWNER).chatId, about: OWNER, shown: false }
  assert.ok(mem.recall('红茶', opts).length)
  cfg.memory.recallMinRelevance = 0.95
  assert.deepEqual(mem.recall('红茶相机', opts), [])
  assert.equal(mem.recallHint(chat(OWNER), '红茶相机'), '')
  assert.ok(mem.recall('红茶', opts).length, '精确关键词仍然相关，不能因门槛变高而一律丢掉')
  cfg.memory.recallMinRelevance = 0
  assert.ok(mem.recall('红茶', opts).length)
  assert.deepEqual(mem.recall('完全无关的星系', opts), [])
})

test('默认与缺省门槛保留原有低相关度召回，显式调高才过滤', async (t) => {
  const now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const s = setup(t)
  const query = '红茶相机钢琴旅行湖边散步星系宇宙银河电影咖啡'
  const items = Array.from({ length: 50 }, (_, i) => fact('legacy-' + i, '红茶'))
  s.seed(items)
  const opts = { where: chat(A).chatId, about: A, shown: false }
  const original = search(buildIndex(items), query, { about: A })
  assert.ok(original.length, '原有关键词和人物加分能召回')
  assert.ok(original.every((h) => h.relevance < 0.1), '覆盖旧默认 0.1 会误过滤的场景')
  for (const configured of [0, undefined]) {
    if (configured === undefined) delete s.cfg.memory.recallMinRelevance
    else s.cfg.memory.recallMinRelevance = configured
    assert.deepEqual(s.mem.recall(query, opts).map((h) => h.it.id), original.map((h) => h.it.id))
    assert.ok((await s.mem.recallAsync(query, opts)).length)
    assert.match(s.mem.recallHint(chat(A), query), /红茶/)
    assert.match(await s.mem.recallHintAsync(chat(A), query), /红茶/)
    assert.match(s.mem.recallHint(chat(A), '嗯嗯', query), /红茶/, '上一句回退也保持原有能力')
  }
  s.cfg.memory.recallMinRelevance = 0.1
  assert.deepEqual(s.mem.recall(query, opts), [])
  assert.equal(s.mem.recallHint(chat(A), '嗯嗯', query), '')
})

test('常见关键词不因记忆库增大而被最低相关度误杀', () => {
  const items = Array.from({ length: 50 }, (_, i) => fact(String(i), '红茶', { about: OWNER }))
  const hits = search(buildIndex(items), '红茶', { minRelevance: 0.95, minScore: 0, limit: 5 })
  assert.equal(hits.length, 5)
  assert.ok(hits.every((h) => h.relevance === 1))
})

test('向量、关联补充与上一句也受同一门槛约束，隐私先过滤', (t) => {
  const { mem, cfg, seed } = setup(t)
  const items = [fact('seed', '红茶', { related: ['linked'] }), fact('linked', '湖边散步'), fact('secret', '红茶', { about: OWNER, chatId: chat(OWNER).chatId })]
  seed(items)
  const idx = buildIndex(items)
  const vec = { vectorHits: [{ id: 'seed', similarity: 0.7 }, { id: 'secret', similarity: 0.99 }], ownerScope: false, scopeChatId: chat(A).chatId, excludeAbout: OWNER, limit: 6 }
  assert.ok(search(idx, '星系', { ...vec, minRelevance: 0.1 }).some((h) => h.it.id === 'linked'))
  assert.deepEqual(search(idx, '星系', { ...vec, minRelevance: 0.8 }), [])
  assert.deepEqual(search(idx, '星系', { ...vec, vectorHits: [{ id: 'seed', similarity: 0.54 }] }), [])
  cfg.memory.recallMinRelevance = 0.9
  assert.equal(mem.recallHint(chat(A), '嗯嗯', '红茶'), '')
  cfg.memory.recallMinRelevance = 0.1
  assert.match(mem.recallHint(chat(A), '嗯嗯', '红茶'), /红茶/)
})

test('异步召回与自动注入也遵守门槛', async (t) => {
  const s = setup(t, { recallMinRelevance: 0.95 })
  s.seed([fact('tea', '红茶')])
  assert.deepEqual(await s.mem.recallAsync('红茶相机', { where: chat(A).chatId, about: A }), [])
  assert.equal(await s.mem.recallHintAsync(chat(A), '红茶相机'), '')
  assert.deepEqual(s.mem.recalls()[0].hits, [])
})

test('来源统计兼容无 via / 单字符串 / 多来源，去重标签，已忘和停记不计', (t) => {
  const s = setup(t)
  const now = Date.now()
  s.rows.push(
    { chatId: chat(A).chatId, uid: A, who: '阿甲', text: 'QQ 原话', t: now },
    { chatId: chat(A).chatId, uid: A, who: '阿甲', text: '抖音原话', via: 'douyin', t: now },
    { chatId: chat(A).chatId, who: 'bot', text: '来自自定义工具的回复', via: 'custom', t: now },
    { chatId: chat(A).chatId, uid: A, text: '已忘', forgottenAt: now, t: now },
    { chatId: chat(A).chatId, text: '外部内容不是原话', kind: 'seen', t: now },
  )
  s.seed([fact('seen', '看过视频', { about: '', chatId: '', source: 'event', kind: 'seen', meta: { title: '茶', platform: 'douyin' } })], { gists: [
    fact('legacy', 'QQ 梗概', { kind: 'gist', level: 1 }), fact('single', '老平台梗概', { kind: 'gist', via: 'douyin', level: 1 }),
    fact('mixed', '混合来源印象', { kind: 'gist', via: ['qq', 'douyin', 'douyin', 'custom'], level: 2 }),
  ] })
  const before = s.state()
  assert.deepEqual(s.mem.platformStats(), [
    { platform: 'custom', episodes: 1, gists: 1, seen: 0 }, { platform: 'douyin', episodes: 1, gists: 2, seen: 1 }, { platform: 'qq', episodes: 1, gists: 2, seen: 0 },
  ])
  assert.deepEqual(s.state(), before)
  assert.deepEqual(memoryPlatforms({ via: ['douyin', 'douyin'] }), ['douyin'])
  assert.deepEqual(memoryPlatforms({}), ['unknown'])
  assert.equal(s.mem.timeline({ platform: 'qq' }).length, 2)
  s.mem.setNoMemory(A, true)
  assert.deepEqual(s.mem.platformStats(), [{ platform: 'douyin', episodes: 0, gists: 0, seen: 1 }])
})

test('QQ 与 via 混合的流水压缩后保留全部来源，仍只有一条同聊天梗概', async (t) => {
  const s = setup(t, { keepChatlogDays: 0, keepChatlogSet: true })
  const at = Date.now() - 2 * DAY
  s.rows.push({ chatId: chat(A).chatId, uid: A, who: '阿甲', text: '我喝红茶', t: at }, { chatId: chat(A).chatId, uid: A, who: '阿甲', text: '继续聊红茶', via: 'douyin', t: at + 1 })
  await s.mem.consolidate()
  assert.equal(s.mem.gists().length, 1)
  assert.deepEqual(s.mem.gists()[0].via, ['qq', 'douyin'])
  assert.equal(s.rows.length, 0)
  assert.deepEqual(s.mem.platformStats().map((p) => [p.platform, p.gists]), [['douyin', 1], ['qq', 1]])
})

test('相似事实只在同一聊天去重，保留原有矛盾保护和出处', (t) => {
  const s = setup(t)
  const base = { about: A, text: '阿甲喜欢喝红茶' }
  const first = s.mem.add({ ...base, chatId: chat(A).chatId })
  const group = s.mem.add({ ...base, chatId: 'group:77' })
  assert.ok(first.id && group.id)
  assert.equal(s.mem.add({ ...base, chatId: chat(A).chatId }).updated, first.id)
  assert.ok(s.mem.add({ ...base, text: '阿甲不喜欢喝红茶', chatId: chat(A).chatId }).id)
  assert.equal(s.mem.list('').length, 3)
  const line = memoryLine({ ...base, chatId: chat(A).chatId, at: Date.now(), saidAt: Date.now(), speaker: B, status: 'hearsay', via: 'douyin' })
  assert.match(line, new RegExp(`私聊${A}.*抖音.*原话来自${B}`))
})

test('三个管理只读路由复用 store，查看后不新增持久化文件', async (t) => {
  const s = setup(t)
  s.seed([fact('a', '朋友喜欢喝红茶'), fact('b', '朋友常在旅行时泡红茶')])
  const handlers = routes(s)
  const before = readdirSync(s.dir).sort()
  assert.equal((await handlers.get('/persona/graph')({})).nodes[0].qq, A)
  assert.equal((await handlers.get('/memory/platforms')({})).ok, true)
  assert.ok((await handlers.get('/memory/related')({ query: { id: 'a' } })).list.some((m) => m.id === 'b'))
  assert.deepEqual(readdirSync(s.dir).sort(), before)
  assert.deepEqual(s.state().items.map((m) => m.hits), [undefined, undefined])
})

// 用实际面板函数验证交互和窄宽 SVG 的坐标边界，不依赖 DOM 或浏览器。
function panelHarness(name, props, respond = async () => ({ ok: true })) {
  const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let loader
  const requests = [], slots = [], pendingEffects = []
  let hook = 0
  const React = {
    Component: class {}, Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (initial) => { const i = hook++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }] },
    useRef: (initial) => { const i = hook++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i] },
    useMemo: (fn) => { hook++; return fn() }, useCallback: (fn) => fn,
    useEffect: (effect, deps) => {
      const i = hook++, previous = slots[i]
      if (!previous || deps.some((v, n) => !Object.is(v, previous.deps[n]))) {
        previous?.cleanup?.()
        slots[i] = { deps }
        pendingEffects.push(() => { slots[i].cleanup = effect() })
      }
    },
  }
  const marker = '    exports.apply = apply'
  new Script(source.replace(marker, '    exports.absorbTest = { PersonaGraph, PersonaDetail, RelatedMemories, PersonaFact, MemoryPlatforms, starPositions, Mood, MemoryPage }\n' + marker)).runInNewContext({
    setTimeout, clearTimeout,
    window: { innerWidth: 360, __ModuleLoader__: { load: (value) => { loader = value } } },
    fetch: async (url, options) => { requests.push({ url, options }); return { json: async () => respond(url, options) } },
  })
  const api = loader.factory(() => React).absorbTest
  return { api, requests, render: () => { hook = 0; const tree = api[name](props); while (pendingEffects.length) pendingEffects.shift()(); return tree },
    flush: async () => { for (let i = 0; i < 8; i++) await Promise.resolve() } }
}
const allNodes = (tree) => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(allNodes) : [tree, ...allNodes(tree.children)]

test('星图面板用 SVG、48 人分页，点节点或键盘进入详情，手机坐标不出界', async () => {
  const nodes = Array.from({ length: 50 }, (_, i) => ({ qq: String(30000000 + i), name: '朋友' + i, closeness: i, interactions: i }))
  const ui = panelHarness('PersonaGraph', { toast() {} }, async () => ({ ok: true, nodes, links: [{ id: 'r', source: nodes[0].qq, target: nodes[1].qq, text: '同学' }] }))
  ui.render(); await ui.flush()
  let tree = ui.render(), elements = allNodes(tree)
  assert.equal(elements.filter((n) => n.type === 'svg').length, 1)
  assert.equal(elements.filter((n) => n.type === 'g' && n.props.role === 'button').length, 48)
  assert.equal(elements.filter((n) => n.type === 'line').length, 1)
  const positions = ui.api.starPositions(nodes.slice(0, 48), [])
  assert.ok(positions.points[47].r > positions.points[0].r)
  for (const p of positions.points) assert.ok(Number.isFinite(p.x) && p.x >= 30 && p.x <= 330 && p.y >= 30 && p.y <= positions.height - 40)
  const pick = elements.find((n) => n.type === 'g' && n.props.role === 'button')
  let prevented = false
  pick.props.onKeyDown({ key: 'Enter', preventDefault: () => { prevented = true } })
  assert.ok(prevented)
  tree = ui.render()
  assert.equal(allNodes(tree).find((n) => n.type === ui.api.PersonaDetail).props.qq, nodes[0].qq)
  allNodes(tree).find((n) => n.type === ui.api.PersonaDetail).props.back()
  allNodes(ui.render()).find((n) => n.children.includes('下一页')).props.onClick()
  assert.equal(allNodes(ui.render()).filter((n) => n.type === 'g').length, 2)
})

test('推荐面板展开才 GET，关闭丢弃在途结果，内容只读且当文字呈现', async () => {
  let resolve
  const wait = new Promise((r) => { resolve = r })
  const ui = panelHarness('RelatedMemories', { m: { id: 'anchor', text: '红茶' } }, async () => wait)
  let tree = ui.render()
  assert.equal(ui.requests.length, 0)
  allNodes(tree).find((n) => n.type === 'button').props.onClick()
  ui.render(); await ui.flush()
  assert.equal(ui.requests.length, 1)
  assert.match(ui.requests[0].url, /\/memory\/related\?id=anchor/)
  assert.equal(ui.requests[0].options.method, undefined)
  allNodes(ui.render()).find((n) => n.type === 'button').props.onClick()
  ui.render()
  resolve({ ok: true, list: [{ id: 'b', text: '<script>不能执行</script>', reason: '同话题' }] })
  await ui.flush()
  assert.equal(allNodes(ui.render()).filter((n) => n.type === 'article').length, 0)
  allNodes(ui.render()).find((n) => n.type === 'button').props.onClick()
  ui.render(); await ui.flush()
  tree = ui.render()
  assert.equal(allNodes(tree).filter((n) => n.type === 'article').length, 1)
  assert.ok(allNodes(tree).some((n) => n.children.includes('<script>不能执行</script>')))
  assert.ok(!allNodes(tree).some((n) => n.props.dangerouslySetInnerHTML || n.type === 'textarea'))
})

test('设置面板用后端档位表生成天数输入，门槛和天数写回同一配置草稿', async () => {
  const props = { st: { modules: [{ id: 'memory', running: true }], config: { memory: { uiCollapsed: { people: false, tiers: false, vector: false, rerank: false } } } }, draft: normalize({}), setDraft: (next) => { props.draft = next }, toast() {} }
  const ui = panelHarness('MemoryPage', props, async () => ({ ok: true, items: [], styles: {}, stats: { factTiers: FACT_TIERS } }))
  ui.render(); await ui.flush()
  let tree = ui.render()
  let row = allNodes(tree).find((n) => n.props.label === '召回最低相关度')
  row.children[0].props.onChange(0.65)
  assert.equal(props.draft.memory.recallMinRelevance, 0.65)
  tree = ui.render()
  row = allNodes(tree).find((n) => n.props.label === '小事事实保留多少天')
  row.children[0].props.onChange({ target: { value: '18' } })
  assert.equal(props.draft.memory.tierDays[5], 18)
  assert.equal(props.draft.memory.tierDays[3], 90)
  assert.equal(allNodes(tree).filter((n) => n.props.label?.endsWith('事实保留多少天')).length, 5)
})

test('人物事实改档提交选择值，平台表显示后端的三类数量', async () => {
  const m = { id: 'a', text: '朋友喜欢茶', tier: 1, tierLabel: '琐碎', tierDays: 7 }
  const ui = panelHarness('PersonaFact', { m, tiers: [{ id: 1, label: '琐碎', days: 7 }, { id: 5, label: '小事', days: 15 }], toast() {}, onChanged() {} })
  allNodes(ui.render()).find((n) => n.children.includes('改')).props.onClick()
  let tree = ui.render()
  allNodes(tree).find((n) => n.type === 'select').props.onChange({ target: { value: '5' } })
  tree = ui.render()
  await allNodes(tree).find((n) => n.children.includes('保存')).props.onClick()
  assert.equal(JSON.parse(ui.requests[0].options.body).tier, 5)
  const stats = panelHarness('MemoryPlatforms', {}, async () => ({ ok: true, list: [{ platform: 'douyin', episodes: 12, gists: 3, seen: 8 }] }))
  stats.render(); await stats.flush()
  const cells = allNodes(stats.render()).filter((n) => n.type === 'td').map((n) => n.children[0])
  assert.deepEqual(cells, ['抖音', 12, 3, 8])
})
