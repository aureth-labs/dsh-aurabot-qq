import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createReplyStatus } from '../src/core/reply-status.js'

const session = { id: 'session-fixture' }
const user = (id = 'u1', source = { kind: 'aurabot' }) => ({ type: 'user/message', data: { id, source } })
const answer = (seq = 12, text = '最终回复', more = []) => ({
  type: 'assistant/message', seq,
  data: { turn: 1, message: { id: 'm' + seq, role: 'assistant', content: [{ type: 'text', text }, ...more] } },
})
async function setup(t, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'reply-status-'))
  const options = { directory, chatOfSession: id => id === session.id ? 'group:123' : '', ...extra }
  const store = createReplyStatus(options)
  t.after(async () => { await store.dispose(); await rm(directory, { recursive: true, force: true }) })
  store.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  store.onEvent(session, user())
  return { store, directory, options }
}
const receipt = (state = 'edited', extra = {}) => ({ sessionId: session.id, userMessageId: 'u1', state,
  reason: state === 'edited' ? 'edited' : 'timeout', text: '最终回复', before: 200, elapsedMs: 16000, ...extra })

test('精简标识对应实际保存的回复，并能在重启后读取；不保存正文', async t => {
  const { store, directory, options } = await setup(t)
  const event = answer(), snapshot = structuredClone(event)
  store.report(receipt()); store.onEvent(session, event)
  store.onEvent(session, { type: 'turn/end' })
  const row = await store.read(session.id, 10, 15)
  assert.equal(row.state, 'edited'); assert.equal(row.before, 200); assert.equal(row.after, 4)
  assert.deepEqual(event, snapshot)
  await store.dispose()
  const saved = await readFile(join(directory, 'fixture.json'), 'utf8')
  assert.ok(!saved.includes('最终回复'))
  const restored = createReplyStatus(options)
  assert.deepEqual(await restored.read(session.id, 10, 15), row)
  await restored.dispose()
})

test('超时原稿、短原稿保留实际原因；取一轮最后一条回复', async t => {
  const { store } = await setup(t)
  store.report(receipt('original')); store.onEvent(session, answer())
  assert.equal((await store.read(session.id, 10, 13)).reason, 'timeout')
  store.report(receipt('original', { reason: 'below-threshold', text: '短回复', before: 3 }))
  store.onEvent(session, answer(14, '短回复'))
  assert.equal((await store.read(session.id, 10, 15)).reason, 'below-threshold')
  assert.equal(await store.read(session.id, 16, 19), null)
})

test('非 Aurabot 对话和手动 DSH 来话不显示；后台工具步骤不冒充最终回复', async t => {
  const { store } = await setup(t)
  store.onEvent({ id: 'other' }, user()); store.onEvent({ id: 'other' }, answer())
  assert.equal(await store.read('other', 0, 100), null)
  store.onEvent(session, answer(12, '查询中', [{ type: 'tool-call', name: 'search' }]))
  assert.equal(await store.read(session.id, 0, 100), null)
  store.onEvent(session, user('manual', { kind: 'user' })); store.onEvent(session, answer())
  assert.equal(await store.read(session.id, 0, 100), null)
})

test('旧轮次、不同会话、不同正文的结果不能标成已精简', async t => {
  const { store } = await setup(t)
  store.report(receipt()); store.onEvent(session, { type: 'turn/start', data: { turn: 2 } })
  store.onEvent(session, user('u2')); store.report(receipt())
  store.onEvent(session, answer())
  assert.equal((await store.read(session.id, 0, 100)).reason, 'not-edited')
  store.report(receipt('edited', { userMessageId: 'u2', text: '另一份' }))
  store.onEvent(session, answer(15))
  assert.equal((await store.read(session.id, 15, 15)).reason, 'not-edited')
  assert.equal(await store.read('other', 0, 100), null)
})

test('运行时背景事件不丢失当前轮次；没有旧记录时不猜稿件状态', async t => {
  const { store } = await setup(t)
  store.onEvent(session, user('clock', { kind: 'time-context' }))
  store.report(receipt()); store.onEvent(session, answer())
  assert.equal((await store.read(session.id, 10, 15)).state, 'edited')
  assert.equal(await store.read('no-history', 0, 99), null)
  for (const args of [['../escape', 0, 99], [session.id, -1, 99], [session.id, 5, 1], [session.id, null, 99]]) {
    assert.equal(await store.read(...args), null)
  }
})

test('磁盘失败只丢标识持久化，不阻断回复事件', async t => {
  const { store } = await setup(t, { directory: '/dev/null/reply-status' })
  assert.doesNotThrow(() => { store.report(receipt()); store.onEvent(session, answer()) })
  await store.dispose()
})

test('完整宿主事件与只读接口接线，不把标识交给 QQ 发送', async t => {
  const { writeFile, mkdir } = await import('node:fs/promises')
  const { createFakeDsh } = await import('./helpers/fake-dsh.js')
  const { apply } = await import('../src/host.js')
  const dir = await mkdtemp(join(tmpdir(), 'reply-status-host-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'config.json'), JSON.stringify({ enabled: false, setupDone: true, snowluma: { autoStart: false, autoAttach: false } }))
  const fake = createFakeDsh({ brain: async () => { throw Error('No model calls') } })
  const app = apply(fake.ctx)
  t.after(async () => {
    fake.dispose(); await app.dispose?.()
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    await rm(dir, { recursive: true, force: true })
  })
  await app.ready
  // The route is harmless for unrelated and unrecorded conversations.
  const r = await fake.call('/reply-status?sessionId=not-aurabot&startSeq=1&endSeq=99')
  assert.deepEqual(r.json(), { ok: true, status: null })
  assert.equal(fake.turns.length, 0)
  app.hub.chatOfSession = id => id === session.id ? 'group:123' : ''
  const sent = []
  app.onebot.call = async (...args) => { sent.push(args); return {} }
  fake.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
  fake.emit('session/event', session, user())
  app.modules.emit('reply/status', receipt())
  fake.emit('session/event', session, answer())
  fake.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  const status = (await fake.call('/reply-status?sessionId=fixture&startSeq=10&endSeq=15')).json().status
  assert.equal(status.state, 'edited')
  assert.equal(sent.length, 0)
  assert.equal(fake.turns.length, 0)
})
