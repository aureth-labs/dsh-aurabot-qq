// 自驱引擎 v5 · 双轨排程触发测试（R10/D4）。
// 覆盖：配置映射 / 安静窗口派生 / tick 排程闸顺序（总开关→安静→当日上限→到点→防重入）/
// fire 手动入口（跳排程闸不跳开关与安静）/ ignite 心念点火冷却 / 防重入 skipped-busy（坑#8）/
// 主人回话直方图轻推 / 状态持久化与跨天清零。
// 不打真定时：tick 由测试直接驱动；状态文件用 tmpdir（api.__petTestHooks 同款注入风格）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scheduleConfig, quietOf, computeNextFire, createSchedule } from '../src/autotelic/schedule.js'

const BASE = {
  enabled: true,
  awakeFrom: 8,
  awakeTo: 23,
  minIntervalMinutes: 90,
  maxIntervalMinutes: 240,
  maxPerDay: 3,
}

// 本地时区的「今天 hh:mm」时刻构造（排程判定全走本地时区，同 purpose）。
function at(dayOffset = 0, h = 10, m = 0) {
  const d = new Date()
  d.setDate(d.getDate() + dayOffset)
  d.setHours(h, m, 0, 0)
  return d.getTime()
}

function tmpFile(t, name = 'schedule.json') {
  const dir = mkdtempSync(join(tmpdir(), 'autotelic-sched-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, name)
}

/** 造排程器：run 注入为可捕获的 fake（不打真 LLM），now 可控。 */
function makeSchedule(t, { settings = BASE, file = null, runImpl } = {}) {
  const calls = []
  let clock = at(0, 12, 0)
  const sch = createSchedule({
    settings: () => ({ ...settings }),
    file: file || '',
    now: () => clock,
    random: () => 0, // 区间随机稳定取下界，测试可断言
    run: async (reason, meta) => {
      calls.push({ reason, meta, at: clock })
      if (runImpl) return runImpl(reason, meta)
      return { ok: true }
    },
    hooks: { onError: () => {} },
  })
  return {
    sch, calls,
    clockOf: () => clock,
    setClock: (h, m = 0, dayOffset = 0) => { clock = at(dayOffset, h, m) },
  }
}

// —— 配置映射 ——

test('scheduleConfig：默认值 + 钳制', () => {
  const cfg = scheduleConfig({})
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.minIntervalMinutes, 90)
  assert.equal(cfg.maxPerDay, 3)
  const clamped = scheduleConfig({ minIntervalMinutes: 1, maxIntervalMinutes: 99999, maxPerDay: -3, awakeFrom: 30 })
  assert.equal(clamped.minIntervalMinutes, 5)
  assert.equal(clamped.maxIntervalMinutes, 2880)
  assert.equal(clamped.maxPerDay, 0)
  assert.equal(clamped.awakeFrom, 24)
  assert.equal(scheduleConfig({ enabled: false }).enabled, false)
})

test('quietOf：醒着窗口取补集；全天醒 = 不启用安静（start===end）', () => {
  assert.deepEqual(quietOf(scheduleConfig({ awakeFrom: 8, awakeTo: 23 })), { quietStart: '23:00', quietEnd: '08:00' })
  assert.deepEqual(quietOf(scheduleConfig({ awakeFrom: 9, awakeTo: 24 })), { quietStart: '00:00', quietEnd: '09:00' })
  assert.deepEqual(quietOf(scheduleConfig({ awakeFrom: 0, awakeTo: 24 })), { quietStart: '00:00', quietEnd: '00:00' }, '全天醒：安静视为不启用')
})

// —— computeNextFire 纯函数 ——

test('computeNextFire：区间随机 + 安静时段推离', () => {
  const cfg = scheduleConfig(BASE)
  const noon = at(0, 12, 0)
  // random=0 → 取区间下界 90 分钟
  const at1 = computeNextFire({ now: noon, cfg, lastRunAt: noon, countToday: 0, random: () => 0 })
  assert.equal(at1 - noon, 90 * 60_000, 'random=0 → minInterval')
  const at2 = computeNextFire({ now: noon, cfg, lastRunAt: noon, countToday: 0, random: () => 1 })
  assert.equal(at2 - noon, 240 * 60_000, 'random=1 → maxInterval')
  // 落进安静时段（23:00 后）→ 推到安静结束（次日 08:00）之后
  const night = at(0, 23, 30)
  const at3 = computeNextFire({ now: night, cfg, lastRunAt: night, countToday: 0, random: () => 0 })
  assert.ok(new Date(at3).getHours() >= 8, '不落安静时段')
  // 当日额度用尽 → 次日起点（08:00）
  const at4 = computeNextFire({ now: noon, cfg, lastRunAt: noon, countToday: 3, random: () => 0 })
  assert.equal(new Date(at4).getDate(), new Date(noon).getDate() + 1)
  assert.equal(new Date(at4).getHours(), 8)
})

test('computeNextFire：主人回话直方图轻推（样本≥5 向高回话小时偏）', () => {
  const cfg = scheduleConfig(BASE)
  const noon = at(0, 12, 0)
  const noHist = computeNextFire({ now: noon, cfg, lastRunAt: noon, countToday: 0, random: () => 0 })
  // 24 桶直方图：14 点集中 5 条样本，其余为 0（总数≥5 才偏置；轻推只向后看 ≤3h）
  const hist = new Array(24).fill(0)
  hist[14] = 5
  const withHist = computeNextFire({ now: noon, cfg, lastRunAt: noon, countToday: 0, replyHours: hist, random: () => 0 })
  assert.equal(new Date(withHist).getHours(), 14, '直方图把落点轻推到主人常回话的 14 点')
  assert.equal(new Date(noHist).getHours(), 13, '无直方图不偏置（12 点 + 90min = 13 点）')
})

// —— tick：排程闸顺序 ——

test('tick：总开关关闭 → wait(disabled)，不写状态不跑 run', async (t) => {
  const { sch, calls } = makeSchedule(t, { settings: { ...BASE, enabled: false } })
  const r = await sch.tick()
  assert.equal(r.action, 'wait')
  assert.equal(r.reason, 'disabled')
  assert.equal(calls.length, 0)
})

test('tick：安静时段 → wait(quiet)，不跑 run', async (t) => {
  const { sch, calls, setClock } = makeSchedule(t)
  setClock(2, 0) // 凌晨 2 点（醒着窗 8~23 的补集）
  const r = await sch.tick()
  assert.equal(r.reason, 'quiet')
  assert.equal(calls.length, 0)
})

test('tick：当日上限 → wait(daily-max)', async (t) => {
  const file = tmpFile(t)
  const { sch, calls } = makeSchedule(t, { file, settings: { ...BASE, maxPerDay: 1 } })
  const t0 = at(0, 12, 0)
  await sch.tick(t0) // 排下一次：12:00 + 45min = 12:45
  const r1 = await sch.tick(at(0, 12, 46))
  assert.equal(r1.action, 'run', '第一轮到点跑')
  assert.equal(calls.length, 1)
  const r2 = await sch.tick(at(0, 12, 47))
  assert.equal(r2.reason, 'daily-max', '当日次数用尽（闸在 nextFireAt 之前判）')
  assert.equal(calls.length, 1)
})

test('tick：没到点 → wait(waiting)；到点 → run 且计数/状态落盘', async (t) => {
  const file = tmpFile(t)
  const { sch, calls } = makeSchedule(t, { file })
  const t0 = at(0, 12, 0)
  // 首次 tick：排下一次（12:00 + 90min = 13:30），此刻不到点
  const r1 = await sch.tick(t0)
  assert.equal(r1.reason, 'waiting')
  assert.equal(calls.length, 0)
  // 到点了：跑一轮
  const r2 = await sch.tick(t0 + 90 * 60_000)
  assert.equal(r2.action, 'run')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].meta.scheduled, true, '定时轨标记')
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.countToday, 1, '当日计数落盘')
  assert.equal(saved.day, new Date(t0).toDateString())
  assert.ok(saved.nextFireAt > t0 + 90 * 60_000, '跑完排下一次')
})

test('tick：in-flight 时撞上 → skipped-busy（坑#8，防重入自建标记）', async (t) => {
  let releaseRun
  const gate = new Promise((resolve) => { releaseRun = resolve })
  const { sch, calls } = makeSchedule(t, { runImpl: () => gate })
  const t0 = at(0, 12, 0)
  await sch.tick(t0) // 排下一次 13:30
  const first = sch.tick(t0 + 90 * 60_000) // 到点，进入在途（run 卡在 gate）
  await new Promise((r) => setTimeout(r, 10)) // 让它进 perform
  const busy = await sch.tick(t0 + 91 * 60_000)
  assert.equal(busy.action, 'skipped-busy', '在途时 tick 跳过')
  releaseRun()
  const done = await first
  assert.equal(done.action, 'run')
  assert.equal(calls.length, 1, '只跑了一轮，没有并发')
})

// —— fire 手动入口（面板「现在想想」）——

test('fire：跳过排程闸（间隔/当日次数），但不跳总开关与安静时段', async (t) => {
  const { sch, calls, setClock } = makeSchedule(t, { settings: { ...BASE, maxPerDay: 1 } })
  // 已用掉当日额度后，fire 仍能跑（跳过 daily-max）
  await sch.fire('面板：现在想想')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].meta.scheduled, false, '手动轨标记')
  await sch.fire('再来一次')
  assert.equal(calls.length, 2, '排程闸不拦手动')
  // 安静时段拦
  setClock(3, 0)
  const r = await sch.fire('半夜想想')
  assert.equal(r.outcome, 'skipped-quiet')
  assert.equal(calls.length, 2)
})

test('fire：总开关关 → skipped-disabled；防重入 → skipped-busy', async (t) => {
  let releaseRun
  const gate = new Promise((resolve) => { releaseRun = resolve })
  const { sch, calls, setClock } = makeSchedule(t, { runImpl: () => gate })
  await sch.tick(at(0, 12, 0)) // 先排程（13:30 到点）
  const first = sch.fire('面板：现在想想')
  await new Promise((r) => setTimeout(r, 10))
  const second = await sch.fire('又想想')
  assert.equal(second.outcome, 'skipped-busy', '在途时手动也跳过（坑#8）')
  releaseRun()
  await first
  assert.equal(calls.length, 1)
  setClock(3, 0)
})

test('fire：总开关关闭 → skipped-disabled', async (t) => {
  const { sch, calls } = makeSchedule(t, { settings: { ...BASE, enabled: false } })
  const r = await sch.fire('面板：现在想想')
  assert.equal(r.outcome, 'skipped-disabled')
  assert.equal(calls.length, 0)
})

// —— ignite 心念点火 ——

test('ignite：事件入口走 fire 语义，且带事件侧冷却防风暴', async (t) => {
  const { sch, calls } = makeSchedule(t, { settings: { ...BASE, igniteCooldownMinutes: 45 } })
  const t0 = at(0, 12, 0)
  const r1 = await sch.ignite('技能沉淀完成', t0)
  assert.equal(r1.outcome, 'run')
  assert.ok(calls[0].reason.includes('点火'), 'reason 带点火标记')
  assert.equal(calls[0].meta.scheduled, false)
  const r2 = await sch.ignite('重要对话结束', t0 + 10 * 60_000)
  assert.equal(r2.outcome, 'skipped-ignite-cooldown', '45 分钟内第二次事件被冷却')
  assert.ok(r2.retryAt > t0, '给出重试时刻')
  const r3 = await sch.ignite('重要对话结束', t0 + 46 * 60_000)
  assert.equal(r3.outcome, 'run', '冷却过了照常点火')
})

// —— recordReply 直方图 ——

test('recordReply：按素材 id 去重记账进 24 桶，持久化', async (t) => {
  const file = tmpFile(t)
  const { sch } = makeSchedule(t, { file })
  const t0 = at(0, 10, 0)
  sch.recordReply(t0, 'qq:1')
  sch.recordReply(t0, 'qq:1') // 同 id 去重
  sch.recordReply(t0 + 60_000, 'qq:2')
  const v = sch.view(t0)
  assert.equal(v.replyHours[10], 2, '去重后记 2 条')
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.replyHours[10], 2, '落盘')
  assert.ok(saved.replyHoursSeen.includes('qq:1'))
})

// —— 跨天与持久化 ——

test('跨天：countToday 清零；状态文件断电不丢账', async (t) => {
  const file = tmpFile(t)
  const { sch } = makeSchedule(t, { file, settings: { ...BASE, maxPerDay: 2 } })
  const t0 = at(0, 12, 0)
  await sch.tick(t0)
  await sch.tick(t0 + 90 * 60_000)
  const v1 = sch.view(t0 + 91 * 60_000)
  assert.equal(v1.countToday, 1)
  // 次日：计数清零
  const v2 = sch.view(at(1, 12, 0))
  assert.equal(v2.countToday, 0, '跨天清零')
  assert.equal(v2.lastRunAt, t0 + 90 * 60_000, 'lastRunAt 保留')
})

test('状态文件损坏：回退内存态不抛错', async (t) => {
  const file = tmpFile(t)
  writeFileSync(file, 'broken', 'utf8')
  const { sch, calls } = makeSchedule(t, { file })
  const r = await sch.tick(at(0, 12, 0))
  assert.equal(r.reason, 'waiting')
  assert.equal(calls.length, 0)
})

// —— view 面板视图 ——

test('view：面板字段齐全（enabled/quiet/inFlight/countToday/nextFireAt/lastOutcome）', async (t) => {
  const { sch } = makeSchedule(t)
  await sch.tick(at(0, 12, 0))
  const v = sch.view(at(0, 12, 1))
  assert.equal(v.enabled, true)
  assert.deepEqual(v.quiet, { quietStart: '23:00', quietEnd: '08:00' })
  assert.equal(v.inFlight, false)
  assert.equal(v.countToday, 0)
  assert.ok(v.nextFireAt > 0)
  assert.equal(v.lastOutcome, '')
})
