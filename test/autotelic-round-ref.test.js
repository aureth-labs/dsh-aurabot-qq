// 自驱引擎 v5 · 回归：runRound 一轮回味必须能走到决策环（2026-11-18 真机回归）。
// 现象：runRound 里误用了 ctxOf() 内部的局部名 planner（ReferenceError: planner is not defined），
//       一进「观察窗口 ≥2 条」的轮次就整轮 failed，面板显示「这轮出错了，看日志」。
// 契约：runRound 在 enabled=true、观察窗口够、hub 回包无 JSON 时，应正常返回 { outcome: 'parse-fail' }，
//       而不是抛 ReferenceError。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import module from '../src/modules/autotelic/index.js'

test('runRound 真实回路：观察窗口足够时走到决策环，不因 planner 未定义整轮 failed', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-autotelic-round-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const routes = {}
  const settingsStore = { ...module.defaults, enabled: true, awakeStart: 0, awakeEnd: 24, maxPerDay: 10 }
  const api = {
    dataDir: (...parts) => join(root, 'modules-data', 'autotelic', ...parts),
    settings: () => settingsStore,
    route: (path, fn) => { routes[path] = fn },
    every: () => {},
    tool: () => {},
    config: () => ({ ownerQQ: '' }),
    log: { debug: () => {}, info: () => {}, warn: () => {} },
    // hub 回包不含 JSON 数组 → planner 按契约返回 parse-fail（这正是「走通了决策环」的证据）
    core: { hub: { runSystemTurn: async () => '今天天气不错。' } },
  }
  const exported = module.setup(api)
  // 种下 ≥2 条近期观察（direct write，绕开 observe 缓冲）
  const dataDir = api.dataDir('')
  mkdirSync(dataDir, { recursive: true })
  const ts = Date.now()
  const lines = [
    { id: 'o1', ts, source: 'chat', tag: '生活', text: '第一次见一群之中', salience: 0.3 },
    { id: 'o2', ts: ts + 1000, source: 'chat', tag: '生活', text: '这好像不是奶茶就是奶龙', salience: 0.25 },
  ]
  writeFileSync(join(dataDir, 'observations.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
  // 修复前：这里抛 ReferenceError: planner is not defined（整轮 failed）
  const r = await exported.runRound('测试一轮')
  // hub 回包无 JSON → planner 按「全灭」收场，这是「走通了决策环」的证据
  assert.equal(r.outcome, 'all-dead', `应走到决策环并按全灭收场（实际 ${r.outcome}${r.error ? '：' + r.error.message : ''}）`)
  assert.ok((r.deadReasons || []).some((d) => String(d).includes('JSON')), '全灭原因应来自回包解析，而非内部错误')
})
