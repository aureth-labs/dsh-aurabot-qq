import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../src/features/memory.js'
import { normalize } from '../src/core/config.js'
import { readMemoryState, writeMemoryState } from './helpers/memory-state.js'

const day = '2024-01-02', previous = '2024-01-01', future = '9999-01-01'
const today = new Date().toLocaleDateString('sv-SE')
const group = 'group:10001', dm = 'private:10002'
const row = (chatId, extra = {}) => ({ chatId, text: 'private fixture content', ...extra })
function setup(t, logs, processed, extra) {
  const directory = mkdtempSync(join(tmpdir(), 'aurabot-backlog-'))
  writeMemoryState(directory, { items: [], processed, ...extra })
  const hub = { sessions: () => ({ [dm]: { title: '私聊示例' } }), groupNames: new Map([['10001', '测试群']]), chatLogDays: () => Object.keys(logs), chatLogOf: d => { assert.notEqual(d, future); return logs[d] } }
  const config = normalize({ memory: { extractDailyBatches: 30, groupExtraction: { '10001': 'all', '90000': 'all' } } })
  const mem = createMemoryStore({ directory, dsh: {}, getConfig: () => config, hub, log: { warn() {} } })
  t.after(() => { mem.close(); rmSync(directory, { recursive: true, force: true }) })
  return { mem, state: () => readMemoryState(directory) }
}

test('进度观察：按日期、窗口、会话游标和空闲区间去重；查看不写进度、不发消息内容', async t => {
  const logs = { [future]: [], [day]: [row(dm), row(group, { forgottenAt: 1 }), row(dm), row(group), row(dm), row(group), row('system:task'), row(group), row('private:10003'), row('qzone')], [previous]: [row(dm)] }
  const { mem, state } = setup(t, logs, { [previous]: 12, [day]: { offset: 1, end: 7, chats: { [group]: 2, [dm]: 1 }, idle: [[2, 3], [4, 5]] } }, { profiles: { '10003': { noMemory: true } }, extractBatches: { day: today, count: 7 } })
  const before = state(), first = await mem.backlog(), second = await mem.backlog()
  assert.equal(first.total, 8); assert.equal(first.pending, 4); assert.equal(first.batches, 4)
  assert.equal(first.oldest, previous); assert.equal(first.used, 7); assert.equal(first.limit, 30)
  assert.deepEqual(first.chats, [{ id: group, name: '测试群', pending: 2 }, { id: dm, name: '私聊示例', pending: 1 }, { id: 'qzone', name: 'QQ 空间', pending: 1 }])
  assert.doesNotMatch(JSON.stringify(first), /private fixture content/)
  assert.deepEqual({ ...first, at: 0 }, { ...second, at: 0 }); assert.deepEqual(state(), before)
})

test('未完成队列：每窗口分会话、每批最多 80 行；不沿用昨天预算', async t => {
  const id = 'group:90000', rows = Array.from({ length: 241 }, () => row(id)); rows.push(row(dm))
  const { mem } = setup(t, { [day]: rows }, {}, { extractBatches: { day: previous, count: 24 } })
  const b = await mem.backlog(); assert.equal(b.pending, 242); assert.equal(b.batches, 5); assert.equal(b.used, 0); assert.equal(b.chats[0].name, id)
})

test('全部处理后不列空会话，行数不是长期记忆条目数', async t => {
  const { mem } = setup(t, { [day]: [row(dm), row(group)] }, { [day]: { offset: 2, end: 2, chats: {} } })
  const b = await mem.backlog(); assert.equal(b.total, 2); assert.equal(b.pending, 0); assert.equal(b.batches, 0); assert.equal(b.oldest, ''); assert.deepEqual(b.chats, [])
})
