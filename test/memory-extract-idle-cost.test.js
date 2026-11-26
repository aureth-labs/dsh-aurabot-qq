// 空闲提炼的读盘成本：以前每提炼一批（80 行）都把「所有保留天 × 整日 JSONL」重新解析一遍，
// 7 天 × 12 批 = 84 次全量解析，几十万行的库会把事件循环卡住几十秒（#27）。
// 这个测试不测绝对耗时，只锁住「chatLogOf 调用次数不能随批次 × 天数放大」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMemoryStore } from '../src/features/memory.js'

const log = { info() {}, warn() {}, debug() {} }
const owner = '10000000'

function makeDays(count) {
  const now = Date.now()
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(now - (count - i) * 86400_000)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
}

test('空闲提炼不再按批重扫所有天的聊天流水', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-extract-idle-cost-'))
  const old = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  t.after(() => {
    if (old === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = old
    rmSync(dir, { recursive: true, force: true })
  })

  const days = makeDays(7)
  const now = Date.now()
  const rowsByDay = new Map(days.map((day, i) => [day, Array.from({ length: 100 }, (_, j) => ({
    t: now - 3600_000 - (6 - i) * 86400_000 + j * 1000,
    chatId: 'private:1', who: 'user', uid: '1',
    text: `第${i}天第${j}条聊天流水，随便聊聊今天发生的事。`,
  }))]))

  let chatLogCalls = 0
  let chatLogDaysCalls = 0
  const hub = {
    refreshFriends: async () => {},
    chatLogDays: () => { chatLogDaysCalls++; return days.slice() },
    chatLogOf: (day) => { chatLogCalls++; return rowsByDay.get(day) || [] },
    // 提炼期间没有新消息：修订号不变，应该复用第一遍算好的最新发言时间。
    chatLogRevision: () => 1,
  }

  let modelCalls = 0
  const llm = {
    async *stream(params) {
      modelCalls++
      const system = String(params.system || '')
      // 提炼事实回空数组；相处经验回顾回空对象，够走完流程就行。
      const text = system.includes('相处') ? '{"insights":[],"style":[]}' : '{"facts":[]}'
      yield { type: 'text-delta', text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }

  const cfg = {
    enabled: true,
    model: { provider: 'p', model: 'm' },
    ownerQQ: owner,
    botQQ: '999',
    memory: {
      enabled: true, shortTerm: false, dailyConsolidate: true, consolidateTimes: [],
      vector: { enabled: false }, rerank: { enabled: false },
      extractIdleMinutes: 30, extractMinLines: 20, extractDailyBatches: 24,
    },
  }
  const mem = createMemoryStore({ dsh: { llm }, getConfig: () => cfg, hub, log })

  await mem.tick()

  assert.ok(modelCalls > 0, '空闲提炼应该真的跑起来了')
  // 修复后：初始扫 7 天 + 每批只读当前天（约 12 批）。修复前是 7 + 12×(7+1) = 103 起。
  assert.ok(chatLogCalls < 60, `chatLogOf 被调用了 ${chatLogCalls} 次，像是又按批重扫所有天`)
  assert.ok(chatLogDaysCalls <= 3, `chatLogDays 被调用了 ${chatLogDaysCalls} 次，像是每批都重新枚举文件`)
})
