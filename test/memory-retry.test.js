// 记忆提炼失败时：关掉思考再试、连续失败跳过这一批、断网不跳过。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let createMemoryStore, normalize
before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-memretry-'))
  ;({ createMemoryStore } = await import('../src/features/memory.js'))
  ;({ normalize } = await import('../src/core/config.js'))
})

function setup(answer, idle = false) {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-memretry-'))
  const calls = []
  const dsh = {
    get: () => null,
    llm: {
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }, { id: 'low' }] } }),
      async *stream({ system, reasoningEffort, maxTokens }) {
        if (system.includes('整理长期记忆')) {
          calls.push({ reasoningEffort, maxTokens })
          const out = answer(calls.length, reasoningEffort)
          if (out instanceof Error) throw out
          if (out) yield { type: 'text-delta', text: out }
        } else yield { type: 'text-delta', text: '[]' }
        yield { type: 'finish', reason: { kind: 'completed' } }
      },
    },
  }
  const today = new Date()
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const hub = { chatLogDays: () => [day], chatLogOf: () => [{ chatId: 'private:2', who: '阿花', uid: '2', text: '你好', t: Date.now() - 3600_000 }], deleteChatLog() {} }
  const warns = []
  const cfg = normalize({ model: { provider: 'p', model: 'm' }, ownerQQ: '1' })
  if (idle) Object.assign(cfg.memory, { consolidateTimes: [], extractMinLines: 1, extractIdleMinutes: 1, shortTerm: false })
  const make = () => createMemoryStore({ dsh, getConfig: () => cfg, hub, log: { info() {}, warn: (...a) => warns.push(a.join('')), debug() {} } })
  return { mem: make(), make, calls, warns }
}

test('模型没写出东西：关掉思考、预算放到 16000 再问一次', async () => {
  const { mem, calls } = setup((n, effort) => (effort === 'off' ? '[]' : ''))
  const r = await mem.consolidate({ includeToday: true })
  assert.equal(r.ok, true, r.message)
  assert.deepEqual(calls.at(-1), { reasoningEffort: 'off', maxTokens: 16000 })
})

test('同一批连续 3 次没有数组就跳过，错误里带模型返回的内容', async () => {
  const { mem, warns } = setup(() => '我不想整理')
  const first = await mem.consolidate({ includeToday: true })
  assert.equal(first.ok, false)
  assert.match(first.message, /模型返回：我不想整理/)
  assert.equal((await mem.consolidate({ includeToday: true })).ok, false)
  assert.equal((await mem.consolidate({ includeToday: true })).ok, true, '第 3 次跳过后继续')
  assert.ok(warns.some((w) => w.includes('跳过')))
})

test('断网这类错误不跳过，恢复后接着提炼', async () => {
  const { mem } = setup(() => new Error('Connection error'))
  for (let i = 0; i < 4; i++) assert.equal((await mem.consolidate({ includeToday: true })).ok, false)
})

for (const idle of [false, true]) test(`${idle ? '空闲提炼' : '定时整理'}：限流不算坏格式，恢复后同一批仍能入库`, async () => {
  let answer = '非 JSON 回答'
  const s = setup(() => answer, idle)
  const run = async () => { const mem = s.make(); return idle ? mem.tick() : mem.consolidate({ includeToday: true }) }
  await run()
  answer = new Error('429 quota exceeded')
  await run(); await run()
  answer = '非 JSON 回答'
  await run(); await run()
  assert.ok(!s.warns.some(w => w.includes('跳过')), '只有两次连续格式错误，不能推进进度')
  answer = '{"facts":[{"text":"阿花喜欢画山水","about_qq":"2","speaker":"2"}]}'
  await run()
  assert.ok(s.make().list('').some(m => m.text.includes('喜欢画山水')))
})

test('未闭合的提炼对象即使已有空 facts 数组，也不算整批处理成功', async () => {
  const { mem, calls } = setup(n => n === 1 ? '{"facts":[],"people":[' : '{"facts":[{"text":"阿花喜欢画山水","about_qq":"2","speaker":"2"}]}')
  const r = await mem.consolidate({ includeToday: true })
  assert.equal(r.ok, true, r.message)
  assert.equal(calls.length, 2)
  assert.ok(mem.list('').some(m => m.text.includes('喜欢画山水')))
})
