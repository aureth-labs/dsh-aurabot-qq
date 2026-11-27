// #31：空闲提炼按来源公平排队——私聊/小群先轮到，大群积压再多也不能把每轮 12 批全吃掉。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize } from '../src/core/config.js'
import { createMemoryStore } from '../src/features/memory.js'
import { readMemoryState } from './helpers/memory-state.js'

const OWNER = '10000001'
const A = '30000001'
const BOT = '20000001'
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const log = { info() {}, warn() {}, debug() {} }

function setup(t, patch = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-memory-fair-'))
  const old = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const logs = new Map()
  const calls = []
  const cfg = normalize({
    ownerQQ: OWNER,
    botQQ: BOT,
    model: { provider: 'p', model: 'm' },
    memory: {
      dailyConsolidate: true,
      extractIdleMinutes: 1,
      extractMinLines: 2,
      extractDailyBatches: 24,
      gistEnabled: false,
      shortTerm: false,
      compress: false,
    },
    ...patch,
  })
  // normalize 会把空数组当成「没配」回退到 04:00/16:00；这里必须清掉，
  // 否则 CI 在下午跑 tick 时会先走 consolidate，而不是本用例要测的 extractIdle。
  cfg.memory.groupExtraction = { '999': 'all', '2': 'all' } // 完整流水的公平调度
  cfg.memory.consolidateTimes = []
  const hub = {
    chatLogDays: () => [...logs.keys()].sort(),
    chatLogOf: (d) => logs.get(d) || [],
    deleteChatLog: (d) => logs.delete(d),
    speakersOf: () => [],
  }
  const dsh = { get: () => null, llm: { async *stream({ system, messages }) {
    const text = messages[0].content[0].text
    calls.push({ system, text })
    yield { type: 'text-delta', text: system.includes('整理长期记忆') ? '[]' : '{"insights":[],"style":[]}' }
    yield { type: 'finish', reason: { kind: 'completed' } }
  } } }
  const make = () => createMemoryStore({ dsh, getConfig: () => cfg, hub, log })
  t.after(() => {
    if (old === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = old
    rmSync(dir, { recursive: true, force: true })
  })
  return { cfg, logs, calls, make, state: () => readMemoryState(dir) }
}

const row = (chatId, uid, text, t) => ({ chatId, uid, who: uid === BOT ? 'bot' : '小明', text, t })
const extractCalls = (s) => s.calls.filter((x) => x.system.includes('整理长期记忆'))
const lines = (chatId, uid, prefix, n, start) => Array.from({ length: n }, (_, i) => row(chatId, uid, `${prefix}-${i}-结束`, start + i))

test('#31 空闲提炼：大群在前积压时，私聊仍然先轮到，且一轮不会把 12 批全给群', async (t) => {
  const s = setup(t)
  const start = Date.now() - 3 * 3600_000
  // 故意把大群放在最前面：旧实现按插入顺序会先把它排满 12 批。
  const group = lines('group:999', '888', '大群消息', 2000, start)
  const priv = lines(`private:${A}`, A, '私聊消息', 40, start + 1)
  s.logs.set(dayKey(), [...group, ...priv])
  await s.make().tick()
  const calls = extractCalls(s)
  assert.equal(calls.length, 12, '一次 tick 仍只跑 EXTRACT_LIMIT=12 批')
  assert.match(calls[0].text, /私聊消息-0-结束/, '私聊必须先于积压的大群')
  assert.equal(calls.filter((c) => c.text.includes('私聊消息')).length, 1, '私聊只有一批，先轮到后不再占')
  assert.equal(calls.filter((c) => c.text.includes('大群消息')).length, 11, '剩下的预算才给大群')
})

test('#31 空闲提炼：积压更少的小群先于千人大群', async (t) => {
  const s = setup(t)
  const start = Date.now() - 3 * 3600_000
  const big = lines('group:999', '888', '大群消息', 2000, start)
  const small = lines('group:2', '777', '小群消息', 40, start + 1)
  s.logs.set(dayKey(), [...big, ...small])
  await s.make().tick()
  const calls = extractCalls(s)
  assert.equal(calls.length, 12)
  assert.match(calls[0].text, /小群消息-0-结束/, '小群优先于大群')
  assert.equal(calls.filter((c) => c.text.includes('小群消息')).length, 1)
})

test('#31 定时整理：同一窗口内私聊先于群聊，群流水不会占满首轮', async (t) => {
  const s = setup(t)
  const start = Date.now() - 3 * 3600_000
  const group = lines('group:999', '888', '大群消息', 40, start)
  const priv = lines(`private:${A}`, A, '私聊消息', 40, start + 1)
  s.logs.set(dayKey(), [...group, ...priv])
  const result = await s.make().consolidate({ includeToday: true })
  assert.equal(result.ok, true)
  const calls = extractCalls(s)
  assert.ok(calls.length >= 2)
  assert.match(calls[0].text, /私聊消息-0-结束/, '整理路径也要私聊先排队')
})

test('#31 总预算仍由 extractDailyBatches 控制，旧配置默认值不变', async (t) => {
  const s = setup(t, { memory: { dailyConsolidate: true, consolidateTimes: [], extractIdleMinutes: 1, extractMinLines: 2, extractDailyBatches: 3, gistEnabled: false, shortTerm: false, compress: false } })
  const start = Date.now() - 3 * 3600_000
  const group = lines('group:999', '888', '大群消息', 2000, start)
  const priv = lines(`private:${A}`, A, '私聊消息', 40, start + 1)
  s.logs.set(dayKey(), [...group, ...priv])
  const mem = s.make()
  await mem.tick()
  assert.equal(extractCalls(s).length, 3)
  assert.match(extractCalls(s)[0].text, /私聊消息/)
  assert.equal(s.state().extractBatches.count, 3)
  await mem.tick()
  assert.equal(extractCalls(s).length, 3, '日预算用完后下一分钟不再调模型')
  assert.equal(normalize({}).memory.extractDailyBatches, 24)
})

test('空闲提炼只给选入的行占预算，其余原文不进模型、群活跃时间仍按整群判断', async t => {
  const s = setup(t); s.cfg.memory.groupExtraction = {}; s.cfg.memory.extractMinLines = 1
  const at = Date.now() - 3 * 3600000, day = dayKey()
  const rows = [row('group:999', A, '环境流水', at), { ...row('group:999', A, '直接互动', at + 180000), interaction: [A] }, row('group:999', A, '现在仍在聊天', Date.now())]
  s.logs.set(day, rows); const m = s.make(); await m.tick(); assert.equal(extractCalls(s).length, 0)
  rows[2].t = at + 240000; await m.tick(); const calls = extractCalls(s); assert.equal(calls.length, 1); assert.match(calls[0].text, /直接互动/); assert.doesNotMatch(calls[0].text, /环境流水|现在仍在聊天/)
  assert.equal((await m.backlog()).pending, 0); assert.equal((await m.backlog()).outOfScope, 2); assert.equal(s.state().extractBatches.count, 1)
})
