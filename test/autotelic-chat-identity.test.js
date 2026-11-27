// 自驱引擎 v5 · 聊天观察接入回归（issue #576）。
// 坑：host.js 的 core 没暴露 identity，createChatCollector 拿到 undefined 后
// observe.js:259-260 直接早退，聊天流水一条都进不了观察层。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, appendFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createObserve, createChatCollector } from '../src/autotelic/observe.js'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')

test('core 暴露 identity.owner()，否则采集器会静默零采集', () => {
  const host = read('../src/host.js')
  const a = host.indexOf('const core = {')
  const b = host.indexOf('mods = createModules', a)
  assert.ok(a > 0 && b > a, '应能定位 core 定义')
  assert.match(host.slice(a, b), /identity\s*:\s*\{[^}]*owner\s*:/, 'core 必须暴露 identity.owner()')
  assert.match(read('../src/modules/autotelic/index.js'), /identity:\s*api\.core\?\.identity/)
})

test('identity 有效时，主人私聊流水进观察层', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'autotelic-identity-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const now = Date.now()
  const ownerQQ = '1240819805'
  const rows = [
    { t: now - 5000, chatId: 'private:999999', who: '陌生人', uid: '999999', text: '别人的私聊不该进观察' },
    { t: now - 4000, chatId: `private:${ownerQQ}`, who: 'bot', text: '这是我自己的回复，不该进观察' },
    { t: now - 3000, chatId: `private:${ownerQQ}`, who: '主人', uid: ownerQQ, text: '今天去吃了火锅，很好吃，下次带你去' },
    { t: now - 2000, chatId: `private:${ownerQQ}`, who: '主人', uid: ownerQQ, text: '帮我查一下明天的天气，为什么下雨' },
  ]
  const hub = { chatLogDays: () => ['2026-11-23'], chatLogOf: () => rows }
  const observe = createObserve({
    file: join(dir, 'observations.jsonl'),
    hooks: { write: (f, s) => appendFileSync(f, s, 'utf8'), schedule: () => () => {} },
  })
  const r = createChatCollector({ hub, identity: { owner: () => ownerQQ }, observe, now: () => now }).collect()
  assert.equal(r.written, 2)
  const chat = observe.list({ source: 'chat' })
  assert.equal(chat.length, 2)
  assert.ok(chat.every((x) => x.source === 'chat'))
  assert.ok(chat.some((x) => x.text.includes('火锅')))
})

test('观察窗按来源分配额，情绪打点挤不掉聊天', () => {
  const mod = read('../src/modules/autotelic/index.js')
  assert.doesNotMatch(mod, /observe\.list\(\{\s*since,\s*limit:\s*120\s*\}\)/)
  assert.match(mod, /limit:\s*100000/)
  assert.match(mod, /source\s*===\s*'chat'/)
  assert.match(mod, /lastEmoKey/, '情绪桥只在 top 变化时打点')
})

test('schedule 透出真实 outcome，status 返回 running', () => {
  assert.match(read('../src/autotelic/schedule.js'), /result\.outcome/)
  assert.match(read('../src/modules/autotelic/index.js'), /running:\s*!!schedule\.view\(\)\.inFlight/)
})

test('窗口条目超过旧去重上限时，第二轮不重复写', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'autotelic-dedup-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const now = Date.now()
  const ownerQQ = '1240819805'
  // 3000 条 > 旧默认 seenLimit 2000：旧实现第二轮会把整窗再写一遍。
  const rows = Array.from({ length: 3000 }, (_, i) => ({
    t: now - 3000 + i, chatId: `group:${7000 + (i % 5)}`, who: `u${i % 50}`, uid: String(i % 50),
    text: `第 ${i} 条群聊内容`,
  }))
  const hub = { chatLogDays: () => ['2026-11-23'], chatLogOf: () => rows }
  const observe = createObserve({
    file: join(dir, 'observations.jsonl'),
    hooks: { write: (f, s) => appendFileSync(f, s, 'utf8'), schedule: () => () => {} },
  })
  const collector = createChatCollector({ hub, identity: { owner: () => ownerQQ }, observe, now: () => now })
  assert.equal(collector.collect().written, 3000)
  assert.equal(collector.collect().written, 0, '第二轮不该重复写')
  assert.equal(collector.collect().written, 0, '第三轮也不该')
})
