// 每轮提示装配（contextFor / recallHint）的记忆读取成本：整库只读一次，不随条数放大。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMemoryStore } from '../src/features/memory.js'

const log = { info() {}, warn() {}, debug() {} }
const owner = '10000000'

function seed(dir, { items = 1000, relations = 200, people = 30 } = {}) {
  const list = []
  for (let i = 0; i < items; i++) {
    list.push({ id: 'm' + i, text: '她说过的一件事，编号 ' + i + (i % 10 === 0 ? '，就是上次说的那件事' : '') + '，内容稍微长一点模拟真实记忆。', about: String(10000001 + (i % people)), aboutName: '群友' + (i % people), tags: ['日常'], importance: 0.5, source: 'auto', chatId: 'private:' + owner, at: Date.now() - i * 60000, saidAt: Date.now() - i * 60000, hits: 0 })
  }
  const profiles = {}
  for (let i = 0; i < people; i++) profiles[String(10000001 + i)] = { qq: String(10000001 + i), name: '群友' + i, alias: '小' + i, text: '一段一百多字的印象，用来模拟真实档案的长度。', at: Date.now() }
  const rels = []
  for (let i = 0; i < relations; i++) {
    rels.push({ id: 'r' + i, subjQq: owner, objQq: String(10000001 + (i % people)), subj: '主人', obj: '群友' + (i % people), kind: '朋友', text: '他们一起做过编号 ' + i + ' 的事', chatId: 'private:' + owner, at: Date.now() - i * 1000 })
  }
  writeFileSync(join(dir, 'memories.json'), JSON.stringify({ items: list, relations: rels, profiles, rev: 1 }))
}

test('记忆和关系多时，contextFor / recallHint 不按条数反复读库', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-tip-cost-'))
  const oldDir = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  t.after(() => {
    if (oldDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = oldDir
    rmSync(dir, { recursive: true, force: true })
  })
  seed(dir)

  const mem = createMemoryStore({ dsh: {}, getConfig: () => ({ memory: { enabled: true }, ownerQQ: owner }), hub: { speakersOf: () => [owner] }, log })
  const chat = { kind: 'private', userId: owner, chatId: 'private:' + owner }

  mem.contextFor(chat, 's') // 预热：第一次会把 JSON 记忆迁进 SQLite
  const rounds = 3
  const t0 = performance.now()
  for (let i = 0; i < rounds; i++) {
    mem.contextFor(chat, 's')
    mem.recallHint(chat, '上次说的那件事', '', 's', [owner])
  }
  const perRound = (performance.now() - t0) / rounds

  // 修之前每轮要按记忆条数读库，1000 条记忆 + 200 条关系约 10 秒；修好后本地 0.2 秒级，
  // 这里留足余量只挡「按条数读库」这种量级退化。
  assert.ok(perRound < 1500, `一轮提示装配用了 ${perRound.toFixed(0)}ms，像是又按条数读库了`)

  const ctx = mem.contextFor(chat, 's')
  assert.match(ctx, /人物关系/, '关系仍然要进上下文')
  assert.doesNotThrow(() => mem.recallHint(chat, '上次说的那件事', '', 's', [owner]))
})

test('聊天流水逐行 rememberedRow 不按每行整库读盘', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-row-cost-'))
  const oldDir = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  t.after(() => {
    if (oldDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = oldDir
    rmSync(dir, { recursive: true, force: true })
  })
  seed(dir, { items: 1000, relations: 0, people: 30 })
  const now = Date.now()
  const rows = Array.from({ length: 3000 }, (_, i) => ({
    t: now - i * 1000,
    chatId: 'private:' + owner,
    who: 'user',
    uid: owner,
    text: '流水第 ' + i + ' 条，用来验证逐行过滤不会重复读整库。',
  }))
  const hub = { speakersOf: () => [owner], chatLogDays: () => ['2026-11-14'], chatLogOf: () => rows, chatLogRevision: () => 1 }
  const mem = createMemoryStore({ dsh: {}, getConfig: () => ({ memory: { enabled: true }, ownerQQ: owner }), hub, log })
  const chat = { kind: 'private', userId: owner, chatId: 'private:' + owner }

  mem.recallHint(chat, '流水', '', 's', [owner]) // 预热
  const t0 = performance.now()
  const hint = mem.recallHint(chat, '流水', '', 's', [owner])
  const ms = performance.now() - t0
  assert.equal(typeof hint, 'string')
  assert.ok(ms < 1500, `3000 行聊天流水过滤用了 ${ms.toFixed(0)}ms，像是又按行整库读盘了`)
})
