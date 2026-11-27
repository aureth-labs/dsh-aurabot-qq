// 会话复用：老数据（没有 mode / sessions 字段）不能被当成「模式不匹配」而新建；
// 切换调试/正式之后要接回各自原来那条。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const dataDir = mkdtempSync(join(tmpdir(), 'aurabot-sessmode-'))
process.env.AURABOT_DATA_DIR = dataDir
process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
mkdirSync(dataDir, { recursive: true })

const OWNER = '10000001'
const BOT = '20000002'
const MAP = join(dataDir, 'sessions.json')
writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
  enabled: true, dryRun: true, debug: false, setupDone: true, botQQ: BOT, ownerQQ: OWNER,
  allow: { private: [], groups: [] },
  snowluma: { autoStart: false, autoAttach: false, dir: join(dataDir, 'none') },
  voice: { enabled: false }, merge: { enabled: false },
}))

const { createFakeDsh } = await import(`file:///${REPO}/test/helpers/fake-dsh.js`)
const fake = createFakeDsh({ brain: async () => '嗯嗯' })
const host = await import(`file:///${REPO}/src/host.js`)
const api = host.apply(fake.ctx)
await api.ready
await new Promise((r) => setTimeout(r, 400))

const CHAT = `private:${OWNER}`
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const entry = () => JSON.parse(readFileSync(MAP, 'utf8')).chats[CHAT] || {}
const say = (text) => api.hub.onMessage({
  post_type: 'message', message_type: 'private', sub_type: 'friend',
  self_id: Number(BOT), user_id: Number(OWNER), time: Math.floor(Date.now() / 1000),
  message_id: Math.floor(Math.random() * 1e6),
  message: [{ type: 'text', data: { text } }],
  sender: { user_id: Number(OWNER), nickname: '主人' },
})
const createdCount = async () => ((await fake.call('/logs?limit=500')).json().entries || [])
  .filter((e) => String(e.text).includes(`为 ${CHAT} 新建了 DSH 会话`)).length

test('先正常建一条会话', async () => {
  await say('一')
  await wait(1200)
  assert.ok(entry().sessionId, '应该有会话了')
  assert.equal(await createdCount(), 1)
})

test('老数据（没有 mode / sessions）继续用原会话，不新建', async () => {
  const A = entry().sessionId
  // 抹掉新字段，还原成「调试功能之前」的老数据
  const m = JSON.parse(readFileSync(MAP, 'utf8'))
  delete m.chats[CHAT].mode
  delete m.chats[CHAT].sessions
  writeFileSync(MAP, JSON.stringify(m))

  const before = await createdCount()
  await say('二')
  await wait(1200)
  assert.equal(entry().sessionId, A, '应该还是原来那条会话')
  assert.equal(await createdCount(), before, '不该新建')
})

test('切到调试再切回来，各自接回原来的会话', async () => {
  const A = entry().sessionId

  api.setConfig({ ...api.getConfig(), debug: true, dryRun: true })
  await api.hub.ensureDebugSession()
  await wait(1000)
  const B = entry().sessions.debug
  assert.ok(B, '调试会话应该记下来')
  assert.notEqual(String(B), String(A), '调试和正式是两条会话')
  assert.equal(String(entry().sessions.live), String(A), '正式那条没被顶掉')

  const before = await createdCount()
  api.setConfig({ ...api.getConfig(), debug: false, dryRun: true })
  await say('三')
  await wait(1200)
  assert.equal(String(entry().sessions.live), String(A), '切回正式接回原来那条')
  assert.equal(await createdCount(), before, '切模式不该新建会话')
  // 复用旧会话时也要把「当前会话」写回映射，否则投递守卫会把它当旧会话、把回复丢掉
  assert.equal(String(entry().sessionId), String(A), '当前会话要指回正式那条')
  assert.equal(entry().mode, 'live', '映射里的模式要跟着变')
  const logs = ((await fake.call('/logs?limit=300')).json().entries || []).map((e) => String(e.text))
  assert.ok(logs.some((t) => t.includes('试运行（没真发）') && t.includes(CHAT)), '这一轮的回复应该走到投递（试运行只记日志）')
})

test('在侧栏会话里直接打字，也会更新 lastText（面板上下文靠它触发）', async () => {
  const sid = entry().sessions.live
  api.hub.onSessionEvent({ id: sid }, { type: 'user/message', data: { message: { content: [{ type: 'text', text: '群里今天聊什么了' }] } } })
  assert.equal(api.hub.lastTextOf(sid), '群里今天聊什么了', '直接打的那句要能被上下文看到')
})

test.after(() => fake.dispose())
