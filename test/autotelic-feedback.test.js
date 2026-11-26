// 自驱引擎 v5 · 反馈回路测试（src/autotelic/feedback.js）。
// 覆盖：纠偏进抑制/偏好表、无回应记账三档与冷度、半衰、自动 park 与三条件恢复、
//       立项权重 0.6^chill、熔断（3 轮全灭 / 2 次叫停）、decisions.jsonl 追加。
// 全部注入 now 与临时文件路径，不打真盘业务数据。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFeedback } from '../src/autotelic/feedback.js'

const HOUR = 3600_000
const DAY = 24 * HOUR

/** 造一个可推时钟的反馈回路。 */
function mk(over = {}) {
  let clock = 1_000_000_000_000
  const fb = createFeedback({ now: () => clock, ...over })
  return { fb, setClock: (t) => { clock = t }, getClock: () => clock }
}

test('纠偏语句：别做了 → 抑制表（跨轮硬排除 weight=0）；多干这种 → 偏好表抬升权重', () => {
  const { fb } = mk()
  const r1 = fb.ingestCorrection('别再做这种发链接的事了', { tags: ['share-link'] })
  assert.deepEqual(r1.suppressed, ['share-link'])
  assert.equal(fb.isSuppressed('share-link'), true)
  assert.equal(fb.weightOf('share-link'), 0, '抑制表硬排除，权重 0')

  const r2 = fb.ingestCorrection('这种整理笔记的事多干点', { tags: ['note-keep'] })
  assert.deepEqual(r2.preferred, ['note-keep'])
  const w1 = fb.weightOf('note-keep')
  assert.ok(w1 > 1, `偏好抬升后权重应 > 1（实际 ${w1}）`)
  // 再来一次抬升更多（有封顶）
  fb.ingestCorrection('笔记多干', { tags: ['note-keep'] })
  assert.ok(fb.weightOf('note-keep') >= w1)
})

test('无回应负反馈：观察窗到点没回应 → ignored，冷度 +1，权重乘 0.6', async () => {
  const { fb, setClock } = mk({ settings: () => ({ responseWindowHours: 48 }) })
  const t0 = Date.now()
  fb.recordDelivery({ id: 'd1', tag: 'share-link', at: t0 })
  assert.equal(fb.chillOf('share-link', t0), 0)
  setClock(t0 + 49 * HOUR)
  const r = fb.tick()
  assert.equal(r.expired, 1, '到点未回应记 ignored')
  assert.equal(fb.chillOf('share-link'), 1)
  const w = fb.weightOf('share-link')
  assert.ok(Math.abs(w - 0.6) < 1e-6, `权重应 ≈0.6（实际 ${w}）`)
})

test('回应三档：perfunctory +0.5 / replied −1（下限 0）', () => {
  const { fb } = mk()
  fb.recordDelivery({ id: 'p1', tag: 'share-link', at: 1 })
  const r = fb.recordResponse('p1', 'perfunctory')
  assert.equal(r.ok, true); assert.equal(r.chill, 0.5)
  fb.recordDelivery({ id: 'p2', tag: 'share-link', at: 2 })
  fb.recordResponse('p2', 'replied')
  assert.equal(fb.chillOf('share-link'), 0, 'replied 抵消到 0，不为负')
  // 非法档位拒收
  fb.recordDelivery({ id: 'p3', tag: 'x', at: 3 })
  assert.equal(fb.recordResponse('p3', 'seen').ok, false)
})

test('冷度 14 天半衰：chill=2 放 14 天 → 1', () => {
  const { fb, setClock } = mk({ settings: () => ({ chillHalfLifeDays: 14 }) })
  const t0 = Date.now()
  fb.recordDelivery({ id: 'h1', tag: 'share-link', at: t0 })
  fb.recordResponse('h1', 'ignored', t0)
  fb.recordDelivery({ id: 'h2', tag: 'share-link', at: t0 })
  fb.recordResponse('h2', 'ignored', t0)
  assert.equal(fb.chillOf('share-link', t0), 2)
  setClock(t0 + 14 * DAY)
  assert.ok(Math.abs(fb.chillOf('share-link') - 1) < 1e-6, `半衰后应 ≈1（实际 ${fb.chillOf('share-link')}）`)
})

test('冷度 ≥3 自动 park 90 天（权重 0）；恢复三条件各自可解', () => {
  const { fb } = mk({ settings: () => ({ chillParkThreshold: 3 }) })
  const t0 = Date.now()
  for (let i = 0; i < 3; i++) {
    fb.recordDelivery({ id: `pk${i}`, tag: 'share-link', at: t0 + i })
    fb.recordResponse(`pk${i}`, 'ignored', t0 + i)
  }
  const p = fb.parkInfo('share-link')
  assert.ok(p, '连续 ignored×3 触发自动 park')
  assert.ok(p.until - p.at >= 89 * DAY, 'park 期 90 天')
  assert.equal(fb.weightOf('share-link', t0), 0, 'park 中权重 0，不主动触发')

  // 恢复条件一：主人主动提及相关话题
  assert.equal(fb.resume('share-link', 'mention', t0 + DAY).ok, true)
  assert.equal(fb.parkInfo('share-link'), null)
  assert.ok(fb.weightOf('share-link', t0 + DAY) > 0, 'mention 解 park 后权重恢复（冷度保留继续半衰）')

  // 恢复条件二：显式说多干（ingestCorrection 的 prefer 分支顺带解 park）
  for (let i = 0; i < 3; i++) { fb.recordDelivery({ id: `q${i}`, tag: 'share-link', at: t0 }); fb.recordResponse(`q${i}`, 'ignored', t0) }
  assert.ok(fb.parkInfo('share-link'))
  fb.ingestCorrection('这种分享多干点', { tags: ['share-link'] })
  assert.equal(fb.parkInfo('share-link'), null, 'explicit 多干解除 park')

  // 恢复条件三：面板清零（连冷度一起归零）
  for (let i = 0; i < 3; i++) { fb.recordDelivery({ id: `r${i}`, tag: 'share-link', at: t0 }); fb.recordResponse(`r${i}`, 'ignored', t0) }
  fb.resume('share-link', 'panel')
  assert.equal(fb.chillOf('share-link'), 0)
  assert.equal(fb.parkInfo('share-link'), null)
})

test('熔断：连续 3 轮全灭 → 静默一轮 + 待检视；被 1 次好轮打断则清零', () => {
  const { fb } = mk()
  fb.recordRound({ dead: true }); fb.recordRound({ dead: true })
  assert.equal(fb.isSilent(), false, '2 轮不熔断')
  fb.recordRound({ dead: true })
  assert.equal(fb.isSilent(), true, '3 轮全灭熔断')
  assert.equal(fb.needsReview(), true)
  fb.clearReview()
  assert.equal(fb.needsReview(), false)

  // 好轮清零计数
  const fb2 = mk().fb
  fb2.recordRound({ dead: true }); fb2.recordRound({ dead: true }); fb2.recordRound({ dead: false }); fb2.recordRound({ dead: true }); fb2.recordRound({ dead: true })
  assert.equal(fb2.isSilent(), false, '连续被打断不算')
})

test('熔断：连续 2 个行动被叫停 → 静默 + 待检视 + decisions.jsonl 落痕', () => {
  const dir = mkdtempSync(join(tmpdir(), 'autotelic-fb-'))
  const decisionsFile = join(dir, 'decisions.jsonl')
  const { fb } = mk({ decisionsFile })
  fb.recordStop({}); fb.recordStop({})
  assert.equal(fb.isSilent(), true)
  assert.equal(fb.needsReview(), true)
  assert.ok(existsSync(decisionsFile), '熔断要写 decisions 日志')
  const text = readFileSync(decisionsFile, 'utf8')
  assert.match(text, /feedback\/breaker/)
  assert.match(text, /needsReview/)
  rmSync(dir, { recursive: true, force: true })
})

test('feedback.json 持久化：抑制/冷度跨实例可读（dataDir 根，独家读写）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'autotelic-fb-'))
  const file = join(dir, 'feedback.json')
  let clock = 1_000_000_000_000
  const now = () => clock
  const fb1 = createFeedback({ file, now })
  fb1.ingestCorrection('别做了', { tags: ['spam'] })
  fb1.recordDelivery({ id: 'd', tag: 'share-link', at: clock })
  fb1.recordResponse('d', 'ignored', clock)
  const fb2 = createFeedback({ file, now })
  assert.equal(fb2.isSuppressed('spam'), true, '抑制表跨实例持久')
  assert.equal(fb2.chillOf('share-link'), 1, '冷度跨实例持久')
  assert.equal(fb2.weightOf('share-link'), 0.6)
  rmSync(dir, { recursive: true, force: true })
})

test('主动发言频控持久化（lead 裁决 2026-11-17）：recordSpoke 写后重读仍在，重启不重置节流', () => {
  const dir = mkdtempSync(join(tmpdir(), 'autotelic-fb-'))
  const file = join(dir, 'feedback.json')
  let clock = 1_700_000_000_000
  const now = () => clock
  const fb1 = createFeedback({ file, now })
  fb1.recordSpoke('share-link', clock)
  assert.equal(fb1.lastSpokeOf('share-link'), clock)
  const fb2 = createFeedback({ file, now }) // 模拟重启重读
  assert.equal(fb2.lastSpokeOf('share-link'), clock, '频控账跨实例持久')
  rmSync(dir, { recursive: true, force: true })
})

test('半衰可配置（settings 注入）：chillHalfLifeDays=7 时 7 天折半', () => {
  const { fb, setClock } = mk({ settings: () => ({ chillHalfLifeDays: 7 }) })
  const t0 = Date.now()
  fb.recordDelivery({ id: 'x', tag: 't', at: t0 })
  fb.recordResponse('x', 'ignored', t0)
  setClock(t0 + 7 * DAY)
  assert.ok(Math.abs(fb.chillOf('t') - 0.5) < 1e-6)
})
