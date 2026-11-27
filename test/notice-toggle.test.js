// 面板的通知开关只改通知设置：以前只把 { notice } 交给 setConfig，保存时只和默认值合并，整份配置被重置。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'

const OWNER = '10000001'
const BOT = '20000002'
let fake
let api
let dataDir
before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'aurabot-notice-'))
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mkdirSync(join(dataDir, 'ws'), { recursive: true })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    setupDone: true,
    botQQ: BOT,
    ownerQQ: OWNER,
    allow: { private: [OWNER], groups: ['555'] },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: 'http://127.0.0.1:9', wsUrl: 'ws://127.0.0.1:9', dir: join(dataDir, 'no-snowluma') },
  }))
  fake = createFakeDsh({ brain: async () => '嗯' })
  const host = await import('../src/host.js')
  api = host.apply(fake.ctx)
})

after(() => {
  fake?.dispose()
  setTimeout(() => process.exit(0), 200).unref()
})

const saved = () => JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'))

test('通知开关只改通知设置，其他配置保持原样', async () => {
  const r = await fake.call('/notice/toggle', { kind: 'approval', value: false })
  assert.equal(r.json().ok, true, r.raw())
  for (const cfg of [saved(), api.getConfig()]) {
    assert.equal(cfg.notice.approval, false)
    assert.equal(cfg.ownerQQ, OWNER)
    assert.equal(cfg.botQQ, BOT)
    assert.equal(cfg.setupDone, true)
    assert.deepEqual(cfg.allow, { ...cfg.allow, private: [OWNER], groups: ['555'] })
  }
})

test('按工作区的通知开关同样不动其他配置', async () => {
  const workspace = join(dataDir, 'ws')
  const r = await fake.call('/notice/toggle', { kind: 'question', value: false, workspace })
  assert.equal(r.json().ok, true, r.raw())
  const cfg = saved()
  assert.equal(cfg.ownerQQ, OWNER)
  assert.equal(cfg.notice.approval, false, '前一次改的通知设置也还在')
  assert.ok(Object.values(cfg.notice.workspaces).some((w) => w.question === false))
})
