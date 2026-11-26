// 自驱引擎安全契约（v5 口径继承）：
//   1) 默认关闭时行为完全不变——排程闸返回 disabled/wait，零模型调用、零落盘；
//   2) 审计链断点：篡改后可检出，断点后记账不掩盖断裂；
//   3) 分级与硬禁区：LEVELS 冻结（三级分级 §3.5）；行动单分级缺省按最保守 touch-owner；
//   4) 重启恢复：在途 step 改判 failed，done 原样保留，坏账本兜底不抛（book.js 保留件）。
// 本文件只做契约断言，不启动真实 DSH / 真模型 / 真子进程。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuditor } from '../src/autotelic/audit.js'
import { createBook } from '../src/autotelic/book.js'
import { createSchedule } from '../src/autotelic/schedule.js'
import { LEVELS } from '../src/autotelic/exec.js'

const root = () => mkdtempSync(join(tmpdir(), 'aurabot-safety-'))
// 审计账本按本地时区命名（audit.js 的 dayFile 用 getFullYear/getMonth/getDate）
const dayFileOf = (dir) => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return join(dir, `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.jsonl`)
}
const cleanup = (t, dir) => t.after(() => rmSync(dir, { recursive: true, force: true }))

// ---------- 1. 默认关闭：行为完全不变 ----------

test('默认关闭（契约）：tick 返回 disabled/wait，且零 IO——不落任何盘、不调模型', async (t) => {
  const dir = root(); cleanup(t, dir)
  let modelCalls = 0
  const schedule = createSchedule({
    settings: () => ({ enabled: false }),
    file: join(dir, 'schedule.json'),
    run: async () => { modelCalls++; return { outcome: 'all-dead' } }, // 真被调到就算失败
  })
  const r = await schedule.tick()
  assert.equal(r.action, 'wait', '关闭时排程闸直接等')
  assert.equal(r.reason, 'disabled', '关闭时的出口是 disabled')
  assert.equal(modelCalls, 0, '关着绝不调模型')
  assert.equal(existsSync(join(dir, 'schedule.json')), false, '关着不落任何盘')
})

test('默认关闭（契约）：fire 也不跳总开关（§2.2：点火不跳开关）', async (t) => {
  const dir = root(); cleanup(t, dir)
  const schedule = createSchedule({ settings: () => ({ enabled: false }), file: '', run: async () => ({ outcome: 'all-dead' }) })
  const r = await schedule.fire('手动')
  assert.equal(r.outcome, 'skipped-disabled')
})

test('默认关闭（契约）：空账本只读不落盘、不产生任务', () => {
  const dir = root()
  const file = join(dir, 'ledger.json')
  const book = createBook({ file, now: () => Date.now() })
  assert.equal(existsSync(file), false, '只读账本不落盘')
  assert.deepEqual(book.list(), [], '空账本')
})

test('审计器只记录不拦截：非她会话的工具调用一律放行', async () => {
  const dir = root()
  const auditor = createAuditor({ dir, ownRoot: dir, chatMap: {} })
  const next = () => ({ kind: 'pass', allowed: true })
  const out = await auditor.preExecute({ name: 'fs', arguments: {}, agent: { session: { id: 'system:owner' } } }, next)
  assert.ok(out, '主人会话必须正常放行')
  assert.equal(out.kind, 'pass', '不改变原有放行结果')
})

// ---------- 2. 审计链断点 ----------

test('审计链断点：篡改账本后 status().chain 检出 brokenAt，不静默通过', async (t) => {
  const dir = root(); cleanup(t, dir)
  const auditor = createAuditor({ dir, ownRoot: dir, chatMap: { her: 'system:autotelic' } })
  auditor.note({ kind: 'tool/call', tool: 'fs', args: {}, outcome: 'ok' })
  auditor.note({ kind: 'tool/call', tool: 'fs', args: {}, outcome: 'ok' })
  auditor.note({ kind: 'tool/call', tool: 'fs', args: {}, outcome: 'ok' })
  await auditor.flush()
  const good = await auditor.status()
  assert.equal(good.chain.ok, true, '未篡改时链条完整')
  assert.ok(good.today >= 3, '今天的条目数对得上')
  const f = dayFileOf(dir)
  assert.equal(existsSync(f), true, '账本已落盘')
  const rows = readFileSync(f, 'utf8').split('\n').filter(Boolean)
  const tampered = rows.map((line, i) => {
    if (i !== 1) return line
    const obj = JSON.parse(line)
    return JSON.stringify({ ...obj, outcome: '被改过' })
  })
  writeFileSync(f, tampered.join('\n') + '\n', 'utf8')
  const bad = await auditor.status()
  assert.equal(bad.chain.ok, false, '篡改必须被检出')
  assert.ok(bad.chain.brokenAt !== undefined, '给出断点位置，供面板显示')
})

test('审计链断点：断点后继续记账不掩盖断裂', async (t) => {
  const dir = root(); cleanup(t, dir)
  const auditor = createAuditor({ dir, ownRoot: dir, chatMap: { her: 'system:autotelic' } })
  auditor.note({ kind: 'tool/call', tool: 'a', args: {}, outcome: 'ok' })
  auditor.note({ kind: 'tool/call', tool: 'b', args: {}, outcome: 'ok' })
  await auditor.flush()
  const f = dayFileOf(dir)
  const rows = readFileSync(f, 'utf8').split('\n').filter(Boolean)
  rows[0] = JSON.stringify({ ...JSON.parse(rows[0]), tool: '篡改' })
  writeFileSync(f, rows.join('\n') + '\n', 'utf8')
  auditor.note({ kind: 'tool/call', tool: 'c', args: {}, outcome: 'ok' })
  await auditor.flush()
  const chain = await auditor.status()
  assert.equal(chain.chain.ok, false, '后续记账不能让前面被改的痕迹消失')
})

// ---------- 3. 三级分级（v5 的 L2 白名单已退役，代之以 LEVELS + isForbidden） ----------

test('分级：LEVELS 显式冻结，三级缺一不可（§3.5）', () => {
  assert.ok(Array.isArray(LEVELS), '分级是显式集合')
  assert.equal(Object.isFrozen(LEVELS), true, '分级必须冻结，运行时代码改不了')
  assert.deepEqual([...LEVELS], ['read-only', 'write-data', 'touch-owner'])
})

// ---------- 4. 重启恢复（book.js 保留件） ----------

test('重启恢复：在途 step 改判 failed（写明重启原因），done 的 step 不重跑', (t) => {
  const dir = root(); cleanup(t, dir)
  const file = join(dir, 'ledger.json')
  const a = createBook({ file, now: () => Date.now() })
  const { task } = a.addTask({ title: '在途', reason: 'r', todos: [{ desc: '会挂' }, { desc: '没到' }] })
  a.beginStep(task.id) // 第一步跑到一半（running）
  const b = createBook({ file, now: () => Date.now() }) // 新实例 = 插件重启
  const t2 = b.list().find((x) => x.id === task.id)
  assert.ok(t2, '任务本身还在')
  const running = (t2.steps || []).filter((s) => s.status === 'running')
  assert.equal(running.length, 0, '重启后不应再有 running 的 step')
  const failedSteps = (t2.steps || []).filter((s) => s.status === 'failed')
  assert.ok(failedSteps.length >= 1, '在途 step 改判 failed 等重试')
  assert.match(String(failedSteps[0].why || ''), /重启|在途/, '失败原因写明是重启导致')
})

test('重启恢复：done 的 step 保持 done，不被重跑', (t) => {
  const dir = root(); cleanup(t, dir)
  const file = join(dir, 'ledger.json')
  const a = createBook({ file, now: () => Date.now() })
  const { task } = a.addTask({ title: '办完一步', reason: 'r', todos: [{ desc: 'a' }, { desc: 'b' }] })
  a.beginStep(task.id)
  a.endStep(task.id, { ok: true, note: '成了' })
  const b = createBook({ file, now: () => Date.now() })
  const t2 = b.list().find((x) => x.id === task.id)
  const doneSteps = (t2.steps || []).filter((s) => s.status === 'done')
  assert.ok(doneSteps.length >= 1, '已完成的 step 保持 done')
  assert.equal((t2.steps || []).filter((s) => s.status === 'running').length, 0, '没有残留 running')
})

test('重启恢复：落盘账本续读——新实例读到旧任务', (t) => {
  const dir = root(); cleanup(t, dir)
  const file = join(dir, 'ledger.json')
  const a = createBook({ file, now: () => Date.now() })
  const { task } = a.addTask({ title: '办好它', reason: 'r', todos: [{ desc: 'a' }] })
  const before = a.list()
  const b = createBook({ file, now: () => Date.now() })
  const after = b.list()
  assert.equal(after.length, before.length, '任务数不变')
  assert.equal(after[0].id, task.id, '同一任务续读')
})

test('重启恢复：账本文件损坏时不抛，按空账本兜底', (t) => {
  const dir = root(); cleanup(t, dir)
  const file = join(dir, 'ledger.json')
  writeFileSync(file, '{ 这不是合法 json', 'utf8')
  const book = createBook({ file, now: () => Date.now() })
  assert.deepEqual(book.list(), [], '坏文件按空账本处理，不让插件起不来')
})
