// #254：概览「今日统计」重启后归零。计数按日期落盘，同日重启继续累计，跨天重置。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'aurabot-stats-'))
process.env.AURABOT_DATA_DIR = dir

const { createHub } = await import('../src/chat/hub.js')

const today = () => new Date().toDateString()

function makeHub() {
  const hub = createHub({
    dsh: { sessions: async () => [], on: () => () => {}, off: () => {}, emit: () => {} },
    onebot: { call: async () => ({}), state: 'connected' },
    getConfig: () => ({ ownerQQ: '10001', botQQ: '20002', enabled: true, dryRun: true, allow: { private: ['10001'], groups: [] }, group: {}, stickers: { enabled: false }, voice: { enabled: false }, chat: {} }),
    log: { info() {}, warn() {}, debug() {}, error() {} },
  })
  return hub
}

test('同一天重启后今日统计继续累计', () => {
  writeFileSync(join(dir, 'stats.json'), JSON.stringify({ received: 7, sent: 5, voice: 2, stickers: 1, errors: 0, day: today() }))
  const hub = makeHub()
  assert.deepEqual(hub.stats(), { received: 7, sent: 5, voice: 2, stickers: 1, errors: 0, day: today() })
  hub.dispose()
})

test('跨天的旧统计会被重置', () => {
  writeFileSync(join(dir, 'stats.json'), JSON.stringify({ received: 9, sent: 9, voice: 9, stickers: 9, errors: 9, day: 'Thu Jan 01 1970' }))
  const hub = makeHub()
  assert.deepEqual(hub.stats(), { received: 0, sent: 0, voice: 0, stickers: 0, errors: 0, day: today() })
  hub.dispose()
})

test('统计文件损坏或非法值不影响启动', () => {
  writeFileSync(join(dir, 'stats.json'), '{ 这不是 JSON')
  const broken = makeHub()
  assert.equal(broken.stats().received, 0)
  broken.dispose()
  writeFileSync(join(dir, 'stats.json'), JSON.stringify({ received: -3, sent: 'x', day: today() }))
  const bad = makeHub()
  assert.deepEqual(bad.stats(), { received: 0, sent: 0, voice: 0, stickers: 0, errors: 0, day: today() })
  bad.dispose()
})

test('计数变化后卸载会把最新值落盘（下次启动继续累计）', () => {
  writeFileSync(join(dir, 'stats.json'), JSON.stringify({ received: 4, sent: 0, voice: 0, stickers: 0, errors: 0, day: today() }))
  const hub = makeHub()
  assert.equal(hub.stats().received, 4)
  hub.dispose()
  const saved = JSON.parse(readFileSync(join(dir, 'stats.json'), 'utf8'))
  assert.equal(saved.day, today())
  assert.equal(saved.received, 4)
  const again = makeHub()
  assert.equal(again.stats().received, 4, '重启后继续累计')
  again.dispose()
})

test.after(() => rmSync(dir, { recursive: true, force: true }))
