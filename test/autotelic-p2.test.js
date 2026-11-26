// 自驱引擎 v5 · 保留件回归（原 P2 测试的 v5 口径）：
// reflect.js（日志刊物：每日一页/做梦）与 audit.js 的 note 通道是保留件，契约不变；
// 原 runtime.js/createExec 的部分已随 v3 决策管线退役（见 autotelic-fix / autotelic-exec-v5）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuditor, verifyAuditChain } from '../src/autotelic/audit.js'
import { createJournal, dayKey } from '../src/autotelic/reflect.js'

const tmp = (t, name) => {
  const root = mkdtempSync(join(tmpdir(), `aurabot-autotelic-p2-${name}-`))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}
function chainFile(dir) {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.jsonl`
}

// ---------- 日志刊物（reflect.js 保留件） ----------

test('journal 存取：写读列一致', (t) => {
  const root = tmp(t, 'journal')
  const j = createJournal(root)
  j.write('daily', '2026-11-04', '今日一页')
  j.write('dreams', '2026-11-04', '- 梦一条')
  assert.equal(j.exists('daily', '2026-11-04'), true)
  assert.match(j.read('daily', '2026-11-04'), /今日一页/)
  assert.deepEqual(j.list('daily').map((x) => x.day), ['2026-11-04'])
})

test('journal 按目录隔离：换 base 换刊物（人格隔离的地基）', (t) => {
  const root = tmp(t, 'journal-iso')
  let base = join(root, 'a')
  const j = createJournal(() => base)
  j.write('daily', '2026-11-13', '大肥鱼的一天')
  base = join(root, 'b')
  assert.equal(j.exists('daily', '2026-11-13'), false)
  base = join(root, 'a')
  assert.equal(j.read('daily', '2026-11-13'), '大肥鱼的一天')
})

test('dayKey：本地时区 YYYY-MM-DD，同一天稳定', () => {
  const k = dayKey(new Date('2026-11-17T10:00:00'))
  assert.match(k, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(k, dayKey(new Date('2026-11-17T22:00:00')))
})

// ---------- 审计 note 通道（§4.1③，保留件） ----------

test('审计 note：模块侧显式记账固定记在她名下，哈希链不断', async (t) => {
  const root = tmp(t, 'note')
  const dir = join(root, 'audit')
  const a = createAuditor({ dir, chatOfSession: () => '', isOwnedSession: () => true, flushMs: 1, log: { debug: () => {} } })
  a.note({ kind: 'autotelic/tune', args: { quietFrom: '23:00' }, outcome: '调参进审计' })
  a.note({ kind: 'autotelic/dream', args: { day: dayKey(new Date()), saved: 4 }, outcome: '做梦本身也进审计' })
  await a.flush()
  const chain = await verifyAuditChain(dir)
  assert.equal(chain.ok, true)
  assert.equal(chain.total, 2)
  const text = readFileSync(join(dir, chainFile(dir)), 'utf8')
  assert.match(text, /autotelic\/tune/)
  assert.match(text, /system:autotelic/)
})
