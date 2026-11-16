import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { normalize } from '../src/core/config.js'
import { archiveSessions } from '../src/chat/session-reset.js'
import { runCommand, parseCommand } from '../src/chat/commands.js'
const root = mkdtempSync(join(tmpdir(), 'aurabot-reset-'))
process.env.AURABOT_WORKSPACE = join(root, 'workspace')
const { createHub } = await import('../src/chat/hub.js')
const OWNER = '10000001', CHAT = `private:${OWNER}`
const chat = { kind: 'private', chatId: CHAT, userId: OWNER, groupId: '', nickname: '主人' }
const noop = () => {}
const scheduleError = () => Object.assign(new Error('cannot archive: active (schedule)'), { name: 'WorkspaceActiveSessionError', activity: [{ kind: 'schedule' }] })
const wait = () => new Promise(setImmediate)
const text = [{ type: 'text', text: 'fixture' }]
async function setup(t) {
  const data = mkdtempSync(join(root, 'data-'))
  process.env.AURABOT_DATA_DIR = data
  const cfg = normalize({ enabled: true, dryRun: true, setupDone: true, ownerQQ: OWNER, botQQ: '20000002', allow: { private: [], groups: ['555'] }, memory: { enabled: false }, voice: { enabled: false }, stickers: { enabled: false, autoChance: 0 }, merge: { enabled: false }, chat: { seedHistory: false } })
  const fake = createFakeDsh({ brain: async () => '' })
  fake.ctx.agents.list = () => [...fake.agents.values()]
  let generation = 0
  const make = () => createHub({ dsh: fake.ctx, getConfig: () => cfg, log: { info: noop, debug: noop, warn: noop, error: noop }, onebot: { connected: true, call: async () => ({}) }, buildTools: ({ level }) => level === 'full' ? [{ name: 'qq_send_message', execute: async () => ({ generation }) }] : [], toolsGeneration: () => generation })
  let hub = make()
  t.after(() => { hub.dispose(); fake.dispose() })
  await hub.pushToSession(chat, text, OWNER)
  const sid = hub.sessions()[CHAT].sessionId
  const agent = fake.agents.get(sid)
  return { data, cfg, fake, agent, sid, get hub() { return hub }, reload() { hub.dispose(); generation++; hub = make(); return hub } }
}

test('archive helper waits, deduplicates IDs, and counts only successful writes', async () => {
  let release, entered
  const gate = new Promise((r) => { release = r })
  const start = new Promise((r) => { entered = r })
  const forgotten = [], calls = []
  const registry = { archivedSessionIds: ['session-old'], async archiveSession(id) { calls.push(id); entered(); await gate } }
  const work = archiveSessions({ registry, entries: [{ sessionId: 'session-a', chatId: CHAT }, { sessionId: 'a' }, { sessionId: 'session-old' }], forget: (r) => forgotten.push(r) })
  await start
  assert.equal(forgotten.length, 0)
  release()
  assert.deepEqual(await work, { archived: 1, alreadyArchived: 1, failed: [] })
  assert.deepEqual(calls, ['session-a'])
  assert.equal(forgotten.length, 3)
})

for (const outcome of ['reject', 'throw', 'false', 'ok-false', 'missing']) test(`archive ${outcome}: binding and tools survive, command reports failure`, async (t) => {
  const s = await setup(t)
  const reg = s.fake.ctx.workspaceRegistry
  reg.archiveSession = outcome === 'missing' ? undefined : outcome === 'throw' ? () => { throw scheduleError() } : async () => {
    if (outcome === 'reject') throw scheduleError()
    return outcome === 'false' ? false : { ok: false, message: '/private/path error' }
  }
  await assert.rejects(s.hub.resetChat(CHAT), { code: 'AURABOT_RESET_PARTIAL' })
  assert.equal(s.hub.sessions()[CHAT].sessionId, s.sid)
  assert.ok(s.agent.tools.has('qq_send_message'))
  const reply = await runCommand(parseCommand('/reset'), chat, { getConfig: () => s.cfg, hub: s.hub, log: { warn: noop } })
  assert.match(reply, /未重开/)
  assert.doesNotMatch(reply, /好，我们重新开始|private\/path/)
})

test('all reset retains scheduled private, archives group once, retry can finish private', async (t) => {
  const s = await setup(t)
  await s.hub.pushToSession({ kind: 'group', chatId: 'group:555', groupId: '555', userId: OWNER }, text, OWNER)
  const groupId = s.hub.sessions()['group:555'].sessionId
  const calls = []
  s.fake.ctx.workspaceRegistry.archiveSession = async (id) => {
    calls.push(id)
    if (id === s.sid) throw scheduleError()
    s.fake.ctx.workspaceRegistry.archivedSessionIds.push(id)
  }
  await assert.rejects(s.hub.resetSessions(), (e) => e.result.archived === 1 && e.result.failed.length === 1)
  assert.equal(s.hub.sessions()[CHAT].sessionId, s.sid)
  assert.equal(s.hub.sessions()['group:555'], undefined)
  assert.equal(calls.filter((id) => id === groupId).length, 1)
  s.fake.ctx.workspaceRegistry.archiveSession = async (id) => { s.fake.ctx.workspaceRegistry.archivedSessionIds.push(id) }
  assert.equal(await s.hub.resetChat(CHAT), true)
  assert.equal(s.hub.sessions()[CHAT], undefined)
  assert.equal(s.agent.tools.has('qq_send_message'), false)
  assert.equal(await s.hub.resetChat(CHAT), false)
})

test('awaited archive does not overwrite a replacement binding created during the wait', async (t) => {
  const s = await setup(t)
  let release
  s.fake.ctx.workspaceRegistry.archiveSession = () => new Promise((r) => { release = r })
  const reset = s.hub.resetChat(CHAT)
  await wait()
  const path = join(s.data, 'sessions.json')
  const m = JSON.parse(readFileSync(path, 'utf8'))
  m.chats[CHAT] = { ...m.chats[CHAT], sessionId: 'replacement', sessions: { live: 'replacement' } }
  writeFileSync(path, JSON.stringify(m))
  release()
  assert.equal(await reset, true)
  assert.equal(s.hub.sessions()[CHAT].sessionId, 'replacement')
})

test('schedule / sidebar wake after reload restores tools before a model request, without QQ input', async (t) => {
  const s = await setup(t)
  const previous = s.agent.tools.get('qq_send_message')
  s.reload()
  assert.equal(s.agent.tools.size, 0)
  s.hub.onSessionEvent(s.agent.session, { type: 'turn/start', data: { turn: 99 } })
  assert.ok(s.agent.tools.has('qq_send_message'))
  assert.notEqual(s.agent.tools.get('qq_send_message'), previous)
  assert.deepEqual(await s.agent.tools.get('qq_send_message').execute({}), { generation: 1 })
  assert.equal(s.hub.chatOfSession(s.sid), CHAT)
  assert.equal(s.hub.turnSendersAllOwner(s.sid), true)
  const once = s.agent.tools.get('qq_send_message')
  s.hub.restoreAgent(s.agent)
  assert.equal(s.agent.tools.get('qq_send_message'), once, 'no duplicate mount')
})

test('startup restores existing live agents; unknown, archived and disallowed sessions get no tools', async (t) => {
  const s = await setup(t)
  s.reload().restoreLiveSessions()
  assert.ok(s.agent.tools.has('qq_send_message'))
  s.reload()
  s.fake.ctx.workspaceRegistry.archivedSessionIds.push(s.sid)
  assert.equal(s.hub.restoreAgent(s.agent), false)
  assert.equal(s.agent.tools.size, 0)
  s.fake.ctx.workspaceRegistry.archivedSessionIds.length = 0
  s.cfg.ownerQQ = '99999999'
  assert.equal(s.hub.restoreAgent(s.agent), false)
  assert.equal(s.agent.tools.size, 0)
  s.cfg.ownerQQ = OWNER
  await s.hub.resetChat(CHAT)
  assert.equal(s.hub.restoreAgent(s.agent), false)
})

test('host reload restores real qq_send_message and reset route reports partial failure', async (t) => {
  const s = await setup(t)
  s.hub.dispose()
  s.cfg.snowluma = { ...s.cfg.snowluma, autoStart: false, autoAttach: false, dir: join(s.data, 'absent') }
  writeFileSync(join(s.data, 'config.json'), JSON.stringify(s.cfg))
  const { apply } = await import('../src/host.js')
  const api = apply(s.fake.ctx)
  await api.ready
  await wait()
  assert.ok(s.agent.tools.has('qq_send_message'), 'module tool restored without receiving a QQ message')
  s.fake.ctx.workspaceRegistry.archiveSession = async () => { throw scheduleError() }
  const r = (await s.fake.call('/sessions/reset', {})).json()
  assert.equal(r.ok, false)
  assert.equal(r.result.archived, 0)
  assert.equal(r.result.failed.length, 1)
  assert.match(r.message, /定时任务/)
  assert.equal(api.hub.sessions()[CHAT].sessionId, s.sid)
})

test('live/debug variants: archive successes only, retain failed mode for later retry', async (t) => {
  const s = await setup(t)
  const made = await s.fake.ctx.services.sessionController.create({ workspaceId: s.fake.workspaces[0].id, agentPreset: 'aurabot-private-long' })
  const path = join(s.data, 'sessions.json')
  const m = JSON.parse(readFileSync(path, 'utf8'))
  m.chats[CHAT].sessions = { live: s.sid, debug: made.sessionId }
  writeFileSync(path, JSON.stringify(m))
  s.fake.ctx.workspaceRegistry.archiveSession = async (id) => {
    if (id === made.sessionId) throw scheduleError()
    s.fake.ctx.workspaceRegistry.archivedSessionIds.push(id)
  }
  await assert.rejects(s.hub.resetChat(CHAT), (e) => e.result.archived === 1 && e.result.failed.length === 1)
  assert.equal(s.hub.sessions()[CHAT].sessionId, made.sessionId)
  assert.deepEqual(s.hub.sessions()[CHAT].sessions, { debug: made.sessionId })
  assert.equal(s.hub.restoreAgent(s.fake.agents.get(made.sessionId)), true)
})

test('all reset walks persona maps and leaves the scheduled persona binding intact', async (t) => {
  const s = await setup(t)
  s.cfg.persona.dataOwner = s.cfg.persona.current
  s.cfg.persona.current = 'shoko'
  await s.hub.pushToSession(chat, text, OWNER)
  const shokoId = s.hub.sessions()[CHAT].sessionId
  assert.notEqual(shokoId, s.sid)
  s.fake.ctx.workspaceRegistry.archiveSession = async (id) => {
    if (id === s.sid) throw scheduleError()
    s.fake.ctx.workspaceRegistry.archivedSessionIds.push(id)
  }
  await assert.rejects(s.hub.resetSessions(), (e) => e.result.archived === 1 && e.result.failed.length === 1)
  assert.equal(s.hub.sessions()[CHAT], undefined)
  s.cfg.persona.current = s.cfg.persona.dataOwner
  assert.equal(s.hub.sessions()[CHAT].sessionId, s.sid)
})
