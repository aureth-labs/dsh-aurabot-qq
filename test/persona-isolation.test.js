// 人格隔离：每个人格自己的记忆、会话、聊天流水；根目录归「数据归属人格」，路径和标题与老版本一致。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockOneBot } from './helpers/mock-onebot.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const OWNER = '10000001'
const FRIEND = '10000003'
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

let slow = null
async function brain({ text }) {
  if (text.includes('慢慢回') && slow) await slow.promise
  return '嗯'
}

let mock
let fake
let api
let dataDir
before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'aurabot-persona-'))
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mkdirSync(join(dataDir, 'ws'), { recursive: true })
  mock = await startMockOneBot({ selfId: BOT })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    dryRun: false,
    setupDone: true,
    botQQ: BOT,
    ownerQQ: OWNER,
    allow: { private: [OWNER, FRIEND], groups: [] },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: mock.httpUrl, wsUrl: mock.wsUrl, httpToken: mock.token, wsToken: mock.token, dir: join(dataDir, 'no-snowluma') },
    voice: { engine: 'windows', autoChance: 0 },
    stickers: { autoChance: 0 },
    merge: { waitSec: 0.2, maxSec: 1 },
  }))
  fake = createFakeDsh({ brain })
  const host = await import('../src/host.js')
  api = host.apply(fake.ctx)
  await fake.call('/onebot/reconnect')
  await until(() => mock.connected() > 0)
  await fake.call('/persona/save', { id: 'xiaoxing', name: '小星', tags: [], body: '你是小星。' })
})

after(async () => {
  fake?.dispose()
  await mock?.close()
  setTimeout(() => process.exit(0), 200).unref()
})

const priv = (user_id, t) => ({ message_type: 'private', sub_type: 'friend', user_id: Number(user_id), message_id: Math.floor(Math.random() * 1e6), sender: { user_id: Number(user_id), nickname: user_id === OWNER ? 'xiaoming' : '朋友' }, message: [{ type: 'text', data: { text: t } }] })
const repliesTo = (qq) => mock.calls.filter((c) => c.action === 'send_private_msg' && String(c.params.user_id) === String(qq)).length
const xiaoxingDir = (...parts) => join(dataDir, 'persona-data', 'xiaoxing', ...parts)
const sessionsOf = (dir) => JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8')).chats
const rowsOf = (dir) => {
  const logs = join(dir, 'chatlog')
  if (!existsSync(logs)) return []
  return readdirSync(logs).flatMap((n) => readFileSync(join(logs, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
}
const use = async (id) => {
  const r = await fake.call('/persona/use', { id })
  assert.equal(r.json().ok, true, r.raw())
}
// 等回复发出去、这一轮也收完尾（发完才放开），之后才能切人格
async function say(qq, t) {
  const before = repliesTo(qq)
  mock.push(priv(qq, t))
  await until(() => repliesTo(qq) > before && !api.hub.busy())
}
const memories = async () => (await fake.call('/memories')).json().items

test('全新安装：启动时把当前人格认领为根目录人格', () => {
  assert.equal(api.getConfig().persona.dataOwner, 'dafeiyu')
})

let rootSession
test('根目录人格的会话和流水仍在老路径，标题不变', async () => {
  await say(OWNER, '你好呀')
  const entry = sessionsOf(dataDir)[`private:${OWNER}`]
  assert.ok(entry?.sessionId)
  assert.equal(entry.title, 'QQ · 主人私聊')
  rootSession = entry.sessionId
  assert.ok(rowsOf(dataDir).some((r) => r.text === '你好呀'))
  assert.equal(existsSync(xiaoxingDir('sessions.json')), false)
})

let xiaoxingSession
test('切到小星：新开会话，会话表和流水在 persona-data/xiaoxing，标题带人格名', async () => {
  await use('xiaoxing')
  await say(OWNER, '小星在吗')
  const entry = sessionsOf(xiaoxingDir())[`private:${OWNER}`]
  assert.ok(entry?.sessionId)
  assert.notEqual(entry.sessionId, rootSession)
  assert.match(entry.title, /小星/)
  xiaoxingSession = entry.sessionId
  assert.ok(rowsOf(xiaoxingDir()).some((r) => r.text === '小星在吗'))
  assert.ok(!rowsOf(dataDir).some((r) => r.text === '小星在吗'), '小星的聊天不能写进根目录流水')
  assert.ok(rowsOf(xiaoxingDir()).some((r) => r.who === 'bot'), '小星的回复记在小星的流水里')
})

test('记忆互不可见，切回后仍在', async () => {
  const add = await fake.call('/memory/add', { text: '主人最近在学做草莓蛋糕' })
  assert.equal(add.json().ok, true, add.raw())
  assert.ok((await memories()).some((m) => m.text.includes('草莓蛋糕')))
  await use('dafeiyu')
  assert.ok(!(await memories()).some((m) => m.text.includes('草莓蛋糕')), '大肥鱼看不到小星的记忆')
  await use('xiaoxing')
  assert.ok((await memories()).some((m) => m.text.includes('草莓蛋糕')))
})

test('切回大肥鱼继续原来的会话', async () => {
  await use('dafeiyu')
  await say(OWNER, '回来啦')
  assert.equal(sessionsOf(dataDir)[`private:${OWNER}`].sessionId, rootSession)
  assert.equal(sessionsOf(xiaoxingDir())[`private:${OWNER}`].sessionId, xiaoxingSession)
})

test('她正在回复时拒绝切换人格', async () => {
  let release
  slow = { promise: new Promise((r) => { release = r }) }
  const before = repliesTo(OWNER)
  mock.push(priv(OWNER, '慢慢回'))
  await until(() => fake.turns.length && api.hub.busy())
  const r = await fake.call('/persona/use', { id: 'xiaoxing' })
  assert.equal(r.json().ok, false)
  assert.equal(api.getConfig().persona.current, 'dafeiyu')
  release()
  slow = null
  await until(() => repliesTo(OWNER) > before && !api.hub.busy())
})

test('会话事件在调用方异步链之外到达时，回复记到会话所属人格', async () => {
  await use('xiaoxing')
  await new Promise((resolve) => setImmediate(() => {
    const session = { id: rootSession }
    fake.emit('session/event', session, { type: 'user/message', data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text: '窗口里打的字' }] } } })
    fake.emit('session/event', session, { type: 'assistant/message', data: { turn: 900, message: { content: [{ type: 'text', text: '窗口回复测试' }] } } })
    fake.emit('session/event', session, { type: 'turn/end', data: { turn: 900, reason: { kind: 'completed' } } })
    resolve()
  }))
  await until(() => rowsOf(dataDir).some((r) => r.who === 'bot' && r.text.includes('窗口回复测试')))
  assert.ok(!rowsOf(xiaoxingDir()).some((r) => r.text.includes('窗口回复测试')))
  assert.equal(api.hub.personaOf(rootSession), 'dafeiyu')
  assert.equal(api.hub.personaOf(xiaoxingSession), 'xiaoxing')
})

test('人设图与外貌按会话人格读取，提示词遵循异步上下文人格', async () => {
  const { personaScope } = await import('../src/persona/personas.js')
  const { saveAppearance, saveLookImage } = await import('../src/persona/persona-look.js')
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(64)])
  const other = Buffer.concat([png, Buffer.from([1])])
  saveAppearance('dafeiyu', '蓝色短发')
  saveAppearance('xiaoxing', '银色长发')
  saveLookImage('dafeiyu', png)
  saveLookImage('xiaoxing', other)
  const probeDir = join(dataDir, 'modules', 'look-probe')
  mkdirSync(probeDir, { recursive: true })
  writeFileSync(join(probeDir, 'index.mjs'), "export default { id: 'look-probe', name: '外貌探针', api: 1, setup(api) { return api.core.personas } }")
  const personas = await until(() => api.modules.use('look-probe'))
  await use('xiaoxing')
  assert.equal(personas.look(rootSession).appearance, '蓝色短发')
  assert.deepEqual(personas.look(rootSession).image, png)
  assert.equal(personas.look(xiaoxingSession).appearance, '银色长发')
  assert.deepEqual(personas.look(xiaoxingSession).image, other)
  assert.equal(personas.look().appearance, '银色长发')
  personaScope.run('dafeiyu', () => {
    assert.equal(personas.look().appearance, '蓝色短发')
    assert.match(fake.variables.get('aurabot_persona')(), /蓝色短发/)
    assert.doesNotMatch(fake.variables.get('aurabot_persona')(), /银色长发/)
  })
})

test('不再记住某人：对所有人格生效', async () => {
  await use('xiaoxing')
  assert.equal((await fake.call('/profiles/save', { qq: FRIEND, text: '一起打游戏的朋友' })).json().ok, true)
  await use('dafeiyu')
  assert.equal((await fake.call('/persona/person/no-memory', { qq: FRIEND, enabled: true })).json().ok, true)
  await use('xiaoxing')
  assert.equal((await fake.call('/profiles/save', { qq: FRIEND, text: '又写一次' })).json().ok, false, '小星也不能再记这个人')
})

test('QQ 里说「忘掉…」：所有人格一起忘', async () => {
  await use('xiaoxing')
  await say(OWNER, '记住我养了一只叫团子的猫')
  await use('dafeiyu')
  await say(OWNER, '记住我养了一只叫团子的猫')
  await say(OWNER, '忘掉叫团子的猫')
  const live = (items) => items.filter((m) => m.text.includes('团子') && !m.invalidAt)
  assert.equal(live(await memories()).length, 0)
  await use('xiaoxing')
  assert.equal(live(await memories()).length, 0, '小星也忘了')
})

test('面板「清理某人的记忆」只清当前人格：截止时间记在这个人格的会话表里', async () => {
  await use('xiaoxing')
  const r = await fake.call('/persona/person/reset', { qq: FRIEND }, { 'content-type': 'application/json' })
  assert.equal(r.json().ok, true, r.raw())
  assert.ok(JSON.parse(readFileSync(xiaoxingDir('sessions.json'), 'utf8')).memoryCutoffs?.[FRIEND] > 0)
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'sessions.json'), 'utf8')).memoryCutoffs?.[FRIEND], undefined, '大肥鱼的不动')
  assert.ok(api.hub.memoryResetAt(FRIEND) > 0)
  await use('dafeiyu')
  assert.equal(api.hub.memoryResetAt(FRIEND), 0)
})

test('后台任务跨过人格切换：剩下的后台轮次作废，不用旧人格的会话做事', async () => {
  const { personaScope } = await import('../src/persona/personas.js')
  await use('xiaoxing')
  await assert.rejects(personaScope.run('dafeiyu', () => api.hub.runSystemTurn('probe', '探针', '随便说点什么')), /人格已切换/)
})

test('重新开始所有 QQ 会话：所有人格的会话表都清空', async () => {
  await use('xiaoxing')
  const r = await fake.call('/sessions/reset', {})
  assert.equal(r.json().ok, true, r.raw())
  assert.deepEqual(sessionsOf(xiaoxingDir()), {})
  assert.deepEqual(sessionsOf(dataDir), {}, '不是当前人格的会话表也要清空，否则切回去会解归档旧会话')
})
