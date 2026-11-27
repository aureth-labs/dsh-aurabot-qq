// 自驱引擎 v5 · 观察积累层测试（R1/R12）。
// 覆盖：tags 封闭词表 / append 校验与显著度门控 / 防抖批量落盘（坑#9）/ list·byTag·stats /
// 主人纠偏识别与事件（抑制表归成员 C，这里绝不写 feedback.json）/ 情绪观察桥（§9.2）/
// 聊天流水采集（沿用 hub.chatLogOf 路径，只积累不决策）。
// 测试不打真定时：hooks.schedule 捕获刷新回调，手动触发（api.__petTestHooks 同款注入模式）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_TAGS, isValidTag, resolveTags, mergeTags, readUserTags } from '../src/autotelic/tags.js'
import {
  createObserve, matchCorrection, salienceOf, createEmotionBridge, createChatCollector,
} from '../src/autotelic/observe.js'

function tmpDir(t, name = 'autotelic-obs-') {
  const dir = mkdtempSync(join(tmpdir(), name))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 造一个观察层：真盘 + 捕获式防抖（不打真 setTimeout）；write 钩子记录批次且照常真写盘。 */
function makeObserve(t, dir, extra = {}) {
  const flushed = []
  let pending = null
  const baseHooks = {
    schedule(fn) { pending = fn; return () => { pending = null } },
    write: (file, text) => { flushed.push({ file, text }); appendFileSync(file, text, 'utf8') },
  }
  const observe = createObserve({
    file: join(dir, 'observations.jsonl'),
    now: () => 1700000000000,
    hooks: { ...baseHooks, ...(extra.hooks || {}) },
    flushMs: 5000,
    ...extra,
    hooks: { ...baseHooks, ...(extra.hooks || {}) }, // spread extra 可能带 hooks：强制再并一次
  })
  const firePending = () => { const f = pending; pending = null; f?.() }
  return { observe, flushed, firePending, hasPending: () => pending != null }
}

// —— tags 封闭词表 ——

test('tags：内置默认词表 ≤20 且非空', () => {
  assert.ok(DEFAULT_TAGS.length > 0 && DEFAULT_TAGS.length <= 20, `实得 ${DEFAULT_TAGS.length} 个`)
})

test('tags：isValidTag 只认词表内成员', () => {
  assert.equal(isValidTag('好奇'), true)
  assert.equal(isValidTag('好奇', ['好奇', '牵挂']), true)
  assert.equal(isValidTag('瞎写的'), false)
  assert.equal(isValidTag(''), false)
  assert.equal(isValidTag(null), false)
})

test('tags：用户扩展合并去重，内置在前（tags-user.json）', (t) => {
  const dir = tmpDir(t)
  const dataDirFn = (...p) => join(dir, ...p)
  writeFileSync(dataDirFn('tags-user.json'), JSON.stringify(['养花', '好奇', '木工']), 'utf8')
  const tags = resolveTags(dataDirFn)
  assert.equal(tags[0], '未完成', '内置在前')
  assert.ok(tags.includes('养花') && tags.includes('木工'))
  assert.equal(tags.filter((t2) => t2 === '好奇').length, 1, '去重')
  assert.equal(isValidTag('养花', tags), true, '合并后用户扩展合法')
})

test('tags：扩展文件缺失/坏格式不抛错，回退内置', (t) => {
  const dir = tmpDir(t)
  const dataDirFn = (...p) => join(dir, ...p)
  assert.deepEqual(resolveTags(dataDirFn), DEFAULT_TAGS, '文件不存在 = 只有内置')
  writeFileSync(dataDirFn('tags-user.json'), 'not json', 'utf8')
  assert.deepEqual(resolveTags(dataDirFn), DEFAULT_TAGS, '坏 JSON 静默回退')
  assert.deepEqual(readUserTags(null), [])
})

// —— append 校验 / 显著度门控 ——

test('append：source/tag 全量校验，非法拒绝且不落盘', (t) => {
  const { observe, flushed } = makeObserve(t, tmpDir(t))
  assert.equal(observe.append({ source: 'dog', tag: '好奇', text: 'x' }).reason, 'bad-source')
  assert.equal(observe.append({ source: 'chat', tag: '瞎写的', text: 'x' }).reason, 'bad-tag')
  assert.equal(observe.append({ source: 'chat', tag: '好奇', text: '  ' }).reason, 'empty-text')
  assert.equal(observe.append({}).reason, 'bad-source')
  observe.flush()
  assert.equal(flushed.length, 0, '全被拒：一次写盘都不发生')
})

test('append：显著度门控——低显著度不入库', (t) => {
  const { observe, flushed } = makeObserve(t, tmpDir(t))
  const r = observe.append({ source: 'chat', tag: '生活', text: '哦', salience: 0.1 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'low-salience')
  observe.flush()
  assert.equal(flushed.length, 0)
})

test('salienceOf：纠偏语句=1，普通短句低于门控线，带诉求/问句抬高', () => {
  assert.equal(salienceOf('别再刷B站了'), 1)
  assert.ok(salienceOf('哦') < 0.2, `实得 ${salienceOf('哦')}`)
  assert.ok(salienceOf('爸爸说想要看看那个新功能，能帮我弄一下吗？') >= 0.5)
})

// —— 行格式契约（全队契约严格照写）——

test('行格式契约：{id,ts,source,tag,text,salience} 六键不多不少', async (t) => {
  const { observe, firePending } = makeObserve(t, tmpDir(t))
  const r = observe.append({ source: 'chat', tag: '好奇', text: '主人提了个新东西', salience: 0.8 })
  assert.equal(r.ok, true)
  firePending()
  const rows = observe.list({})
  assert.equal(rows.length, 1)
  assert.deepEqual(Object.keys(rows[0]).sort(), ['id', 'salience', 'source', 'tag', 'text', 'ts'])
  assert.ok(typeof rows[0].id === 'string' && rows[0].id.length > 0)
  assert.equal(rows[0].source, 'chat')
})

// —— 防抖批量落盘（坑#9）——

test('防抖：append 只进缓冲不写盘，到期一次批量落盘', (t) => {
  const { observe, flushed, firePending, hasPending } = makeObserve(t, tmpDir(t))
  observe.append({ source: 'chat', tag: '生活', text: '第一条', salience: 0.6 })
  observe.append({ source: 'chat', tag: '好奇', text: '第二条', salience: 0.6 })
  observe.append({ source: 'note', tag: '牵挂', text: '第三条', salience: 0.9 })
  assert.equal(hasPending(), true, '已排了防抖刷新')
  assert.equal(flushed.length, 0, '没到期绝不写盘（坑#9：禁止每条消息同步写盘）')
  firePending()
  assert.equal(flushed.length, 1, '一批只写一次')
  const lines = flushed[0].text.trim().split('\n')
  assert.equal(lines.length, 3, '三条观察同一批写入')
  assert.deepEqual(JSON.parse(lines[0]), observe.list({})[0])
})

test('缓冲满立刻落盘，不等防抖到期', (t) => {
  const { observe, flushed } = makeObserve(t, tmpDir(t), { maxBuffer: 2, flushMs: 60_000 })
  observe.append({ source: 'chat', tag: '生活', text: 'a', salience: 0.6 })
  observe.append({ source: 'chat', tag: '生活', text: 'b', salience: 0.6 })
  assert.equal(flushed.length, 1, 'maxBuffer=2：第二条进来就批量落盘')
})

// —— list / byTag / stats ——

test('list：时间窗/来源/tag 过滤 + limit 从新端截取', (t) => {
  const { observe } = makeObserve(t, tmpDir(t))
  const t0 = 1700000000000
  observe.append({ source: 'chat', tag: '好奇', text: '一', salience: 0.6, ts: t0 })
  observe.append({ source: 'chat', tag: '好奇', text: '二', salience: 0.6, ts: t0 + 1000 })
  observe.append({ source: 'emotion', tag: '牵挂', text: '三', salience: 0.7, ts: t0 + 2000 })
  observe.append({ source: 'chat', tag: '好奇', text: '四', salience: 0.6, ts: t0 + 3000 })
  assert.equal(observe.list({}).length, 4)
  assert.deepEqual(observe.list({ since: t0 + 1500 }).map((r) => r.text), ['三', '四'])
  assert.deepEqual(observe.list({ source: 'emotion' }).map((r) => r.text), ['三'])
  assert.deepEqual(observe.byTag('牵挂').map((r) => r.text), ['三'])
  assert.equal(observe.list({ limit: 2 }).length, 2, 'limit 截取')
  assert.equal(observe.list({ since: t0 + 3000, until: t0 + 3000 }).length, 1, '边界含 until')
})

test('stats：按来源与 tag 薄统计', (t) => {
  const { observe } = makeObserve(t, tmpDir(t))
  observe.append({ source: 'chat', tag: '好奇', text: '一', salience: 0.6 })
  observe.append({ source: 'chat', tag: '生活', text: '二', salience: 0.6 })
  observe.append({ source: 'emotion', tag: '牵挂', text: '三', salience: 0.7 })
  const s = observe.stats()
  assert.equal(s.total, 3)
  assert.equal(s.bySource.chat, 2)
  assert.equal(s.bySource.emotion, 1)
  assert.equal(s.byTag.好奇, 1)
  assert.equal(s.byTag.牵挂, 1)
})

// —— 主人纠偏（§3.6 最高优先级）——

test('matchCorrection：识别「别做X/别再X/不要再X/别X了」', () => {
  assert.deepEqual(matchCorrection('别做这道菜'), { target: '这道菜', phrase: '别做这道菜' })
  assert.equal(matchCorrection('别再刷B站了').target, 'B站')
  assert.equal(matchCorrection('别再刷B站了').phrase, '别再刷B站')
  assert.equal(matchCorrection('不要再提这事').target, '这事')
  assert.equal(matchCorrection('别再熬夜了').target, '熬夜')
  assert.equal(matchCorrection('别管我了').target, '管我')
  assert.equal(matchCorrection('我今天挺好的'), null, '普通话不误伤')
  assert.equal(matchCorrection('别的先不说，这个不错'), null, '「别的」不误伤')
})

test('纠偏观察：高显著度 note 入库 + emit 事件；绝不写 feedback.json（抑制表归成员 C）', (t) => {
  const dir = tmpDir(t)
  const corrections = []
  const { observe } = makeObserve(t, dir, {
    hooks: { onCorrection: (c) => corrections.push(c) },
  })
  const r = observe.observeCorrection('别再刷B站了', { tag: '好奇', source: 'chat' })
  assert.ok(r, '命中纠偏')
  assert.equal(r.result.ok, true)
  const rows = observe.list({ source: 'note' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].salience, 1, '高显著度')
  assert.ok(rows[0].text.includes('刷B站'))
  assert.equal(corrections.length, 1, '事件已 emit（成员 C 据此写抑制表）')
  assert.equal(corrections[0].target, 'B站')
  assert.equal(corrections[0].tag, '好奇', '带被抑制行为自己的 tag')
  assert.equal(existsSync(join(dir, 'feedback.json')), false, 'feedback.json 不归观察层碰')
})

test('纠偏观察：没命中返回 null，不产生观察也不 emit', (t) => {
  const corrections = []
  const { observe } = makeObserve(t, tmpDir(t), { hooks: { onCorrection: (c) => corrections.push(c) } })
  assert.equal(observe.observeCorrection('今天天气不错'), null)
  assert.equal(corrections.length, 0)
  assert.equal(observe.stats().total, 0)
})

// —— 情绪观察桥（§9.2 / R12）——

test('情绪桥：未接线时惰性（not-wired），不写任何观察', (t) => {
  const { observe } = makeObserve(t, tmpDir(t))
  const bridge = createEmotionBridge({ observe })
  const r = bridge.collect()
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'not-wired')
  assert.equal(observe.stats().total, 0)
})

test('情绪桥：接线后按 source=emotion 写入（情绪也是经历）', (t) => {
  const { observe } = makeObserve(t, tmpDir(t))
  const bridge = createEmotionBridge({
    observe,
    fetchEmotions: () => [{ text: '刚才聊到爸爸的腰伤，有点担心', tag: '牵挂', salience: 0.8 }],
  })
  const r = bridge.collect()
  assert.equal(r.ok, true)
  assert.equal(r.written.length, 1)
  const rows = observe.list({ source: 'emotion' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].tag, '牵挂')
})

// —— 聊天流水采集 ——

function fakeHub(entriesByDay) {
  return {
    chatLogDays: () => Object.keys(entriesByDay),
    chatLogOf: (day) => entriesByDay[day] || [],
  }
}

test('聊天采集：只积累不决策；主人私聊+群聊进，她自己的话与 forgotten 不进', (t) => {
  const { observe } = makeObserve(t, tmpDir(t))
  const hub = fakeHub({
    '2026-11-17': [
      { chatId: 'private:123', t: 1700000000000, who: 'u123', text: '今天好累啊，帮我想想周末去哪' },
      { chatId: 'private:123', t: 1700000001000, who: 'bot', text: '我自己说的话不是观察' },
      { chatId: 'group:88', t: 1700000002000, who: 'u9', text: '群里有人聊起了新游戏，好奇是什么原理', forgottenAt: 1 },
      { chatId: 'group:88', t: 1700000003000, who: 'u9', text: '这条正常，应该进观察' },
      { chatId: 'private:456', t: 1700000004000, who: 'u456', text: '陌生人私聊不进' },
    ],
  })
  const collector = createChatCollector({ hub, identity: { owner: () => '123' }, observe })
  const r = collector.collect()
  assert.equal(r.scanned, 3, 'bot 自己的话与 forgotten 不计入扫描')
  const texts = observe.list({}).map((x) => x.text)
  assert.ok(texts.some((x) => x.includes('周末去哪')), '主人私聊进')
  assert.ok(texts.some((x) => x.includes('应该进观察')), '群聊进')
  assert.ok(!texts.some((x) => x.includes('我自己说')), '她自己的话不进')
  assert.ok(!texts.some((x) => x.includes('新游戏原理')), 'forgottenAt 不进')
  assert.ok(!texts.some((x) => x.includes('陌生人私聊')), '非主人私聊不进')
  // 纠偏语句顺带识别
  const corr = observe.list({ source: 'note' })
  assert.equal(corr.length, 0, '本轮没有纠偏语句')
})

test('聊天采集：同条目去重（两天窗口重叠不重复入库）；纠偏命中 emit', (t) => {
  const corrections = []
  const { observe } = makeObserve(t, tmpDir(t), { hooks: { onCorrection: (c) => corrections.push(c) } })
  const e = { chatId: 'private:123', t: 1700000000000, who: 'u123', text: '别再熬夜了' }
  const hub = fakeHub({ '2026-11-16': [e], '2026-11-17': [e] })
  const collector = createChatCollector({ hub, identity: { owner: () => '123' }, observe })
  collector.collect()
  collector.collect() // 第二天再扫同一条
  const all = observe.list({ limit: 999 })
  const noteRows = all.filter((r) => r.source === 'note')
  assert.equal(noteRows.length, 1, '纠偏观察只写一次')
  assert.equal(corrections.length, 1, '纠偏事件只 emit 一次')
  assert.ok(noteRows[0].text.includes('熬夜'))
})

test('聊天采集：identity 没就绪时安静返回零（不打错）', (t) => {
  const { observe } = makeObserve(t, tmpDir(t))
  const collector = createChatCollector({ hub: fakeHub({ d: [] }), identity: { owner: () => '' }, observe })
  assert.deepEqual(collector.collect(), { scanned: 0, written: 0, corrections: 0 })
})

// —— 读文件容错 ——

test('读旧文件：坏行静默跳过，不影响其余条目', (t) => {
  const dir = tmpDir(t)
  const file = join(dir, 'observations.jsonl')
  writeFileSync(file, '{"id":"a","ts":1,"source":"chat","tag":"好奇","text":"好的","salience":0.5}\nnot-json\n', 'utf8')
  const { observe } = makeObserve(t, dir)
  const rows = observe.list({})
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'a')
})
