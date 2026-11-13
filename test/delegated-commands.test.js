import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { canUseDelegatedCommand, delegatedCommandKey, runPersonalModelCommand } from '../src/chat/delegated-commands.js'
import { normalize } from '../src/core/config.js'

const owner = '10000001'
const guest = '10000002'
const guest2 = '10000003'

test('授权按私聊、命令和 QQ 号分别检查，扩展命令验证模块身份', () => {
  const cfg = normalize({ ownerQQ: owner, allow: { private: [guest] }, commandAllow: { reset: [guest], 'ext:other:画图': [guest] } })
  const msg = { kind: 'private', userId: guest }
  assert.equal(canUseDelegatedCommand(cfg, msg, 'reset'), true)
  assert.equal(canUseDelegatedCommand(cfg, msg, 'model'), false)
  assert.equal(canUseDelegatedCommand(cfg, { ...msg, kind: 'group' }, 'reset'), false)
  assert.equal(canUseDelegatedCommand(cfg, { ...msg, userId: guest2 }, 'reset'), false)
  assert.equal(delegatedCommandKey({ name: '画图', ext: { module: 'imagegen' } }), '')
  assert.equal(delegatedCommandKey({ name: '画图', ext: { module: 'other', delegatable: true } }), 'ext:other:画图')
  assert.equal(delegatedCommandKey({ name: '画图', ext: { module: 'other', delegatable: true, sensitive: true } }), '')
  assert.equal(canUseDelegatedCommand(cfg, msg, 'ext:other:画图'), true)
  assert.equal(canUseDelegatedCommand(cfg, msg, 'ext:another:画图'), false)
  assert.equal(delegatedCommandKey({ name: '画图', ext: { module: '../other', delegatable: true } }), '')
})

test('私聊模型只更改该用户，并在授权撤销后拒绝', async () => {
  let cfg = normalize({ ownerQQ: owner, model: { provider: 'fake', model: 'base', reasoningEffort: 'low' },
    allow: { private: [guest, guest2] }, commandAllow: { model: [guest] },
    chatModels: { privates: { [guest2]: { provider: 'fake', model: 'other', reasoningEffort: 'low' } } } })
  const list = [{ provider: 'fake', model: 'base', name: 'Base' }, { provider: 'fake', model: 'new', name: 'New' }, { provider: 'fake', model: 'other', name: 'Other' }]
  const deps = { getConfig: () => cfg, setConfig: (next) => { cfg = normalize(next) }, listModels: async () => list, defaultModel: () => cfg.model }
  const msg = { kind: 'private', userId: guest }
  assert.match(await runPersonalModelCommand({ name: 'model', arg: '2' }, msg, deps), /New/)
  assert.deepEqual(cfg.chatModels.privates[guest], { provider: 'fake', model: 'new', reasoningEffort: '' })
  assert.equal(cfg.model.model, 'base')
  assert.equal(cfg.chatModels.privates[guest2].model, 'other')
  cfg.commandAllow.model = []
  assert.match(await runPersonalModelCommand({ name: 'model', arg: '1' }, msg, deps), /撤销/)
  assert.equal(cfg.chatModels.privates[guest].model, 'new')
  cfg.commandAllow.model = [guest]
  await runPersonalModelCommand({ name: 'model', arg: '默认' }, msg, deps)
  assert.equal(cfg.chatModels.privates[guest], undefined)
})

test('QQ 消息入口执行已授权重开，拒绝未授权的全局开关和群内命令', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-delegated-'))
  process.env.AURABOT_DATA_DIR = dir
  const config = { enabled: true, dryRun: true, setupDone: true, ownerQQ: owner, botQQ: '20000002',
    allow: { private: [guest], groups: ['30000003'] }, commandAllow: { reset: [guest], model: [guest], 'ext:probe:hello': [guest] },
    snowluma: { autoStart: false, autoAttach: false }, merge: { enabled: false } }
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config))
  mkdirSync(join(dir, 'modules', 'probe'), { recursive: true })
  writeFileSync(join(dir, 'modules', 'probe', 'index.mjs'), `export default { id: 'probe', api: 1, setup(api) { api.command({ name: 'hello', delegatable: true, run: () => { globalThis.__delegatedProbe = (globalThis.__delegatedProbe || 0) + 1; return 'ok' } }) } }`)
  writeFileSync(join(dir, 'sessions.json'), JSON.stringify({ chats: { [`private:${guest}`]: { sessionId: 'old-session' } } }))
  const fake = createFakeDsh({ brain: async () => '' })
  const { apply } = await import('../src/host.js')
  const api = apply(fake.ctx)
  await api.ready
  t.after(() => { delete globalThis.__delegatedProbe; fake.dispose(); rmSync(dir, { recursive: true, force: true }) })
  const message = (text, group = false) => ({ post_type: 'message', message_type: group ? 'group' : 'private',
    self_id: 20000002, user_id: Number(guest), ...(group ? { group_id: 30000003 } : {}), message_id: 123,
    sender: { user_id: Number(guest), nickname: '访客' }, message: [{ type: 'text', data: { text } }] })
  const ownerMessage = (text, group = false) => {
    const event = message(text, group)
    event.user_id = Number(owner)
    event.sender.user_id = Number(owner)
    return event
  }
  await api.hub.onMessage(message('/权限 添加 命令 off ' + guest))
  await api.hub.onMessage(ownerMessage('/权限 添加 命令 off ' + guest, true))
  assert.equal((await fake.call('/state')).json().config.commandAllow.off, undefined)
  const panel = await fake.call('/permissions/subject', { id: guest, changes: { mood: true } }, { 'content-type': 'application/json' })
  assert.equal(panel.json().ok, true)
  const denied = await fake.call('/permissions/subject', { id: guest, changes: { status: true, off: true } }, { 'content-type': 'application/json' })
  assert.equal(denied.json().ok, false)
  assert.equal((await fake.call('/state')).json().config.commandAllow.status.includes(guest), false)
  await api.hub.onMessage(ownerMessage('/权限 添加 命令 status ' + guest))
  assert.equal((await fake.call('/state')).json().config.commandAllow.status.includes(guest), true)
  await api.hub.onMessage(ownerMessage('/权限 移除 命令 status ' + guest))
  assert.equal((await fake.call('/state')).json().config.commandAllow.status.includes(guest), false)
  assert.equal((await fake.call('/state')).json().config.commandAllow.mood.includes(guest), true)
  await api.hub.onMessage(message('/reset'))
  assert.equal(JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8')).chats[`private:${guest}`], undefined)
  assert.deepEqual(fake.ctx.workspaceRegistry.archivedSessionIds, ['old-session'])
  await api.hub.onMessage(message('/off'))
  assert.equal((await fake.call('/state')).json().config.enabled, true)
  assert.equal((await fake.call('/state')).json().config.commandAllow.reset.includes(guest), true)
  await api.hub.onMessage(message('/model 2'))
  const selected = (await fake.call('/state')).json().config.chatModels.privates[guest]
  assert.equal(selected.model, 'm-pdef')
  await api.hub.onMessage(message('/hello'))
  assert.equal(globalThis.__delegatedProbe, 1)
  const sessions = JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8'))
  sessions.chats['group:30000003'] = { sessionId: 'group-session' }
  writeFileSync(join(dir, 'sessions.json'), JSON.stringify(sessions))
  await api.hub.onMessage(message('/reset', true))
  await api.hub.onMessage(message('/hello', true))
  assert.equal(globalThis.__delegatedProbe, 1)
  assert.equal(JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8')).chats['group:30000003'].sessionId, 'group-session')
})
