// #14：同一条 QQ 消息被重复投递（重连后网关重放 / 两条 WS 同时在线）时，命令只能执行一次。
// 用真实 host + 假 OneBot：同 message_id 推两遍，/help 只能回一条。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockOneBot } from './helpers/mock-onebot.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const OWNER = '10000001'
const BOT = '20000002'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 10000) => {
  const t = Date.now()
  while (Date.now() - t < ms) { if (await fn()) return true; await sleep(20) }
  return false
}

let mock
let fake
const seen = {}

before(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aurabot-dup-command-'))
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mock = await startMockOneBot({ selfId: BOT })
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    dryRun: false,
    setupDone: true,
    gateway: 'onebot',
    botQQ: BOT,
    ownerQQ: OWNER,
    allow: { private: [OWNER], groups: [] },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: mock.httpUrl, wsUrl: mock.wsUrl, httpToken: mock.token, wsToken: mock.token, dir: join(dataDir, 'no-snowluma') },
    voice: { enabled: false },
    stickers: { autoChance: 0, collect: false },
    merge: { enabled: false },
  }))
  fake = createFakeDsh({ brain: async () => '收到啦' })
  const host = await import('../src/host.js')
  host.apply(fake.ctx)
  await until(() => fake.logs.some((line) => String(line).includes('Aurabot v')), 5000)
  const reconnect = await fake.call('/onebot/reconnect')
  assert.equal(reconnect.json().ok, true, '应该连上假网关')
})

after(async () => {
  fake?.dispose()
  await mock?.close()
  setTimeout(() => process.exit(0), 200).unref()
})

const helpEvent = (id) => ({
  post_type: 'message', message_type: 'private', sub_type: 'friend',
  self_id: Number(BOT), user_id: Number(OWNER), time: Math.floor(Date.now() / 1000),
  message_id: id,
  message: [{ type: 'text', data: { text: '/help' } }],
  sender: { user_id: Number(OWNER), nickname: '主人' },
})
const helpSends = () => mock.calls.filter((c) => c.action === 'send_private_msg' && String(c.params.user_id) === String(OWNER))

test('同一条命令被重复投递：只执行一次、只回一条', { timeout: 15000 }, async () => {
  const ev = helpEvent(7001)
  mock.push(ev)
  mock.push(ev)
  assert.equal(await until(() => helpSends().length >= 1), true, '应该执行命令并回复')
  await sleep(400) // 给重复事件留足处理时间
  seen.first = helpSends().length
  assert.equal(seen.first, 1, '同 message_id 的命令只能回一条')
})

test('不同 message_id 的命令照常执行', { timeout: 15000 }, async () => {
  const before = helpSends().length
  mock.push(helpEvent(7002))
  assert.equal(await until(() => helpSends().length > before), true, '新消息应该正常执行')
  await sleep(200)
  assert.equal(helpSends().length, before + 1)
})
