// 自驱引擎 v5 · 机制回归三件套（原 v3「三病修复」回归的 v5 口径继承）：
//   1. 防重入：回味在途时 tick/fire/ignite 一律 skipped-busy（原 runtime running 标记 → schedule）
//   2. 瞬态退避：后台会话冷却/超时是瞬态——退避重试不计失败（原 runtime TRANSIENT_RE → exec-v5）
//   3. 熔断：连续 3 轮全灭 / 连续 2 次叫停 → 静默 + 待检视（原 runtime 指纹熔断 → feedback）
// 机制本体分别在成员 A（schedule.js）/ C（exec.js、feedback.js）的交付里，本文件是集成口径的回归保险。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSchedule } from '../src/autotelic/schedule.js'
import { TRANSIENT_RE, isForbidden } from '../src/autotelic/exec.js'
import { createFeedback } from '../src/autotelic/feedback.js'

const tmp = (t, name) => {
  const root = mkdtempSync(join(tmpdir(), `aurabot-autotelic-fix-${name}-`))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

// ---------- 1. 防重入 ----------

test('防重入：在途回味期间 tick/fire 一律 skipped-busy，绝不叠轮', async (t) => {
  const dir = tmp(t, 'reentry')
  let resolveRun
  const gate = new Promise((r) => { resolveRun = r })
  const schedule = createSchedule({
    settings: () => ({ enabled: true, awakeFrom: 0, awakeTo: 24, minIntervalMinutes: 5, maxIntervalMinutes: 5, maxPerDay: 0 }),
    file: join(dir, 'schedule.json'),
    run: () => gate, // 第一轮挂住不放
  })
  const first = schedule.fire('回归', Date.now())
  // 把下一次定时时刻拨到过去，让 tick 走到「到点」分支，撞上在途标记
  const st = schedule.load(Date.now() + 1000)
  st.nextFireAt = Date.now() - 1
  schedule.save()
  const busyTick = await schedule.tick(Date.now() + 1000)
  assert.equal(busyTick.action, 'skipped-busy', 'tick 撞在途回味：跳过')
  const busyFire = await schedule.fire('回归2', Date.now() + 1000)
  assert.equal(busyFire.outcome, 'skipped-busy', 'fire 撞在途回味：跳过')
  resolveRun({ outcome: 'all-dead' })
  const done = await first
  assert.equal(done.outcome, 'run', '第一轮正常收尾，防重入标记在 finally 复位')
  const again = await schedule.fire('回归3', Date.now() + 2000)
  assert.equal(again.outcome, 'run', '复位后可以再跑')
})

// ---------- 2. 瞬态退避与硬禁区 ----------

test('瞬态识别：冷却/超时/断线是瞬态，普通失败不是（坑#7：冤死过 4 个任务）', () => {
  for (const msg of ['后台会话冷却，等太久', '执行超时(timeout)', 'ECONNRESET', '还没结束']) {
    assert.equal(TRANSIENT_RE.test(msg), true, `「${msg}」应判瞬态`)
  }
  for (const msg of ['步数预算耗尽', '硬禁区：不许改宿主配置', 'JSON 解析失败']) {
    assert.equal(TRANSIENT_RE.test(msg), false, `「${msg}」不该判瞬态`)
  }
})

test('硬禁区：行动单模板没有表达空间（改配置/源码、碰凭据、删流水、shell）', () => {
  assert.equal(isForbidden({ desc: '修改 host.json 里的端口' }).forbidden, true)
  assert.equal(isForbidden({ desc: '改一下 src/core/config.js 这份源码' }).forbidden, true)
  assert.equal(isForbidden({ path: 'C:/x/cookie.txt', desc: '读取登录态' }).forbidden, true)
  assert.equal(isForbidden({ desc: '删除聊天流水里的这段记录' }).forbidden, true)
  assert.equal(isForbidden({ desc: '跑一段 powershell 脚本' }).forbidden, true)
  assert.equal(isForbidden({ desc: '把自己目录的 notes/ 里的笔记整理成一篇' }).forbidden, false, '自己的正常事不拦')
})

// ---------- 3. 熔断 ----------

test('熔断：连续 3 轮全灭 → 静默 + 待检视；有产出轮清零计数', (t) => {
  const dir = tmp(t, 'breaker')
  const fb = createFeedback({ file: join(dir, 'feedback.json'), decisionsFile: join(dir, 'decisions.jsonl'), settings: () => ({}) })
  assert.equal(fb.recordRound({ dead: true }).broken, false)
  assert.equal(fb.recordRound({ dead: true }).broken, false)
  assert.equal(fb.recordRound({ dead: false }).broken, false, '有产出的轮清零')
  assert.equal(fb.recordRound({ dead: true }).broken, false)
  assert.equal(fb.recordRound({ dead: true }).broken, false)
  const third = fb.recordRound({ dead: true })
  assert.equal(third.broken, true, '连续 3 轮全灭触发熔断')
  assert.equal(fb.isSilent(), true, '静默期不立项')
  assert.equal(fb.needsReview(), true, '标记待主人检视')
  fb.clearReview()
  assert.equal(fb.needsReview(), false, '面板检视完成清标记')
})

test('熔断：连续 2 次行动被叫停同样触发', (t) => {
  const dir = tmp(t, 'breaker-stop')
  const fb = createFeedback({ file: join(dir, 'feedback.json'), settings: () => ({}) })
  fb.recordStop()
  assert.equal(fb.isSilent(), false)
  fb.recordStop()
  assert.equal(fb.isSilent(), true, '连续 2 次叫停 → 静默')
})
