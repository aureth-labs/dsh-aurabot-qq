// 升级用户：根目录已有老数据、还没认领时所有人格共用根目录（和老版本一样）；主人认领后其他人格才分开。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockOneBot } from './helpers/mock-onebot.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const OWNER = '10000001'
const BOT = '20000002'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 8000) {
  const t = Date.now()
  while (Date.now() - t < ms) {
    const v = await fn()
    if (v) return v
    await sleep(50)
  }
  throw new Error('等不到条件成立')
}

let mock
let fake
let api
let dataDir
before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'aurabot-claim-'))
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mkdirSync(join(dataDir, 'ws'), { recursive: true })
  mkdirSync(join(dataDir, 'personas'), { recursive: true })
  mkdirSync(join(dataDir, 'chatlog'), { recursive: true })
  // 老版本留下的数据：主人当时已经切到小星，但根目录里的东西主要是大肥鱼的
  writeFileSync(join(dataDir, 'personas', 'xiaoxing.md'), '---\nname: 小星\ntags: []\n---\n\n你是小星。\n')
  writeFileSync(join(dataDir, 'memories.json'), JSON.stringify({ items: [{ id: 'old1', text: '主人喜欢吃辣', about: '', aboutName: '', importance: 0.6, source: 'panel', at: Date.now() }] }))
  writeFileSync(join(dataDir, 'sessions.json'), JSON.stringify({ chats: {} }))
  writeFileSync(join(dataDir, 'chatlog', '2026-01-01.jsonl'), JSON.stringify({ t: 1, chatId: `private:${OWNER}`, who: '主人', text: '老聊天' }) + '\n')
  mock = await startMockOneBot({ selfId: BOT })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    dryRun: false,
    setupDone: true,
    botQQ: BOT,
    ownerQQ: OWNER,
    allow: { private: [OWNER], groups: [] },
    persona: { current: 'xiaoxing' },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: mock.httpUrl, wsUrl: mock.wsUrl, httpToken: mock.token, wsToken: mock.token, dir: join(dataDir, 'no-snowluma') },
    voice: { engine: 'windows', autoChance: 0 },
    stickers: { autoChance: 0 },
    merge: { waitSec: 0.2, maxSec: 1 },
  }))
  fake = createFakeDsh({ brain: async () => '嗯' })
  const host = await import('../src/host.js')
  api = host.apply(fake.ctx)
  await fake.call('/onebot/reconnect')
  await until(() => mock.connected() > 0)
})

after(async () => {
  fake?.dispose()
  await mock?.close()
  setTimeout(() => process.exit(0), 200).unref()
})

const priv = (t) => ({ message_type: 'private', sub_type: 'friend', user_id: Number(OWNER), message_id: Math.floor(Math.random() * 1e6), sender: { user_id: Number(OWNER), nickname: 'xiaoming' }, message: [{ type: 'text', data: { text: t } }] })
const replies = () => mock.calls.filter((c) => c.action === 'send_private_msg').length
// 等回复发出去、这一轮也收完尾（发完才放开），之后才能切人格或认领
async function say(t) {
  const before = replies()
  mock.push(priv(t))
  await until(() => replies() > before && !api.hub.busy())
}
const sessionsOf = (dir) => JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8')).chats
const memories = async () => (await fake.call('/memories')).json().items
const xiaoxingDir = (...parts) => join(dataDir, 'persona-data', 'xiaoxing', ...parts)

test('没认领时不自动认领，面板能看到待认领', async () => {
  assert.equal(api.getConfig().persona.dataOwner || '', '')
  const r = (await fake.call('/personas')).json()
  assert.equal(r.dataOwner, '')
  assert.equal(r.claimPending, true)
})

let pendingSession
test('待认领期间和老版本一样：当前人格也用根目录', async () => {
  await say('还是老样子吗')
  const entry = sessionsOf(dataDir)[`private:${OWNER}`]
  assert.ok(entry?.sessionId)
  assert.equal(entry.title, 'QQ · 主人私聊', '标题不变')
  pendingSession = entry.sessionId
  assert.ok((await memories()).some((m) => m.text === '主人喜欢吃辣'))
  assert.equal(existsSync(xiaoxingDir()), false)
})

test('认领前切换人格也要检查参数；认领不存在的人格被拒绝', async () => {
  assert.equal((await fake.call('/persona/data-owner', { id: 'nobody' })).json().ok, false)
})

test('认领给大肥鱼后：小星换用自己的目录，根目录数据归大肥鱼', async () => {
  const r = (await fake.call('/persona/data-owner', { id: 'dafeiyu' })).json()
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(api.getConfig().persona.dataOwner, 'dafeiyu')
  assert.equal(api.getConfig().persona.current, 'xiaoxing', '认领不改当前人格')
  assert.equal((await fake.call('/personas')).json().claimPending, false)
  assert.ok(!(await memories()).some((m) => m.text === '主人喜欢吃辣'), '小星不再看到根目录的记忆')
  await say('小星来了')
  assert.notEqual(sessionsOf(xiaoxingDir())[`private:${OWNER}`].sessionId, pendingSession)
  assert.equal(sessionsOf(dataDir)[`private:${OWNER}`].sessionId, pendingSession, '根目录会话留给大肥鱼')
  assert.equal((await fake.call('/persona/data-owner', { id: 'xiaoxing' })).json().ok, false, '认领只能做一次')
})

test('切换人格不会冲掉认领结果', async () => {
  assert.equal((await fake.call('/persona/use', { id: 'dafeiyu' })).json().ok, true)
  assert.equal(api.getConfig().persona.dataOwner, 'dafeiyu')
  assert.ok((await memories()).some((m) => m.text === '主人喜欢吃辣'))
})

test('删除人格：正在用的人格换个写法也删不掉；可以连数据一起删，根目录不受影响', async () => {
  assert.equal((await fake.call('/persona/delete', { id: 'dafeiyu!' })).json().ok, false)
  assert.ok(existsSync(join(dataDir, 'personas', 'dafeiyu.md')))
  const r = (await fake.call('/persona/delete', { id: 'xiaoxing', withData: true })).json()
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(existsSync(xiaoxingDir()), false)
  assert.ok(existsSync(join(dataDir, 'sessions.json')))
  assert.ok(existsSync(join(dataDir, 'chatlog')))
})
