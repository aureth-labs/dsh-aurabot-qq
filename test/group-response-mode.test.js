// 群消息只交给模块时，不启动 AI；原有群、私聊、模块发送、记忆记录保持独立。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize } from '../src/core/config.js'
import { groupResponseMode } from '../src/chat/access.js'
import { planGroupSettings, readSettings } from '../src/modules/contacts/group-settings.js'
import { planWhitelist } from '../src/modules/contacts/index.js'
import { createFakeDsh } from './helpers/fake-dsh.js'
const root = mkdtempSync(join(tmpdir(), 'aurabot-group-mode-'))
process.env.AURABOT_WORKSPACE = join(root, 'workspace')
const { createHub } = await import('../src/chat/hub.js')
after(() => rmSync(root, { recursive: true, force: true }))
const G = '30000003', H = '40000004', OWNER = '10000001', BOT = '20000002'
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(setImmediate) }
const event = (text, group = G, extra = []) => ({ post_type: 'message', message_type: group ? 'group' : 'private',
  self_id: +BOT, user_id: +OWNER, ...(group ? { group_id: +group } : {}), message_id: 1,
  sender: { user_id: +OWNER, nickname: '测试' }, message: [{ type: 'text', data: { text } }, ...extra] })
const at = { type: 'at', data: { qq: BOT } }
function setup(t, { patch = {}, brain = async () => '收到', hooks = {} } = {}) {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(root, 'case-'))
  const cfg = normalize({ enabled: true, dryRun: false, ownerQQ: OWNER, botQQ: BOT, allow: { groups: [G, H] },
    group: { moduleOnlyGroups: [G] }, merge: { enabled: false }, voice: { enabled: false },
    chat: { bubbleMinMs: 0, bubbleMaxMs: 0 }, stickers: { collect: false, autoChance: 0 }, ...patch })
  const fake = createFakeDsh({ brain }), calls = [], logs = []
  const hub = createHub({ dsh: fake.ctx, getConfig: () => cfg, hooks,
    log: Object.fromEntries(['info', 'warn', 'error', 'debug'].map(k => [k, (...args) => logs.push(args.join(' '))])),
    onebot: { connected: true, async call(action, params) { calls.push({ action, params });
      if (action === 'get_msg') return { sender: { user_id: +BOT }, message: [] }
      return { message_id: calls.length }
    } } })
  fake.ctx.effect(() => fake.ctx.on('session/event', hub.onSessionEvent))
  t.after(() => { hub.dispose(); fake.dispose() })
  return { cfg, fake, hub, calls, logs }
}

test('三种模式复用白名单；恢复接话默认、旧加白操作不解除仅模块限制', () => {
  let cfg = normalize({ allow: { groups: [H] }, group: { overrides: { [G]: { engagedEnabled: false } } } })
  assert.equal(groupResponseMode(cfg, H), 'chat'); assert.equal(groupResponseMode(cfg, G), 'off')
  const old = structuredClone(cfg)
  cfg = planGroupSettings(cfg, { action: 'set', group_id: G, mode: 'modules' }).next
  assert.equal(groupResponseMode(cfg, G), 'modules')
  assert.deepEqual(cfg.memory, old.memory); assert.deepEqual(cfg.group.overrides, old.group.overrides)
  cfg = planGroupSettings(cfg, { action: 'reset', group_id: G }).next
  assert.equal(groupResponseMode(cfg, G), 'modules')
  cfg = planGroupSettings(cfg, { action: 'set', group_id: G, mode: 'off' }).next
  assert.equal(groupResponseMode(cfg, G), 'off')
  const add = planWhitelist(cfg, { action: 'add', kind: 'group', id: G })
  cfg = { ...cfg, allow: { ...cfg.allow, groups: add.next } }
  assert.match(add.message, /仍为仅模块/); assert.equal(groupResponseMode(cfg, G), 'modules')
  assert.equal(readSettings(cfg, G).state.can_reply_by_settings, false)
  cfg = planGroupSettings(cfg, { action: 'set', group_id: G, mode: 'chat' }).next
  assert.equal(groupResponseMode(cfg, G), 'chat'); assert.equal(groupResponseMode(cfg, H), 'chat')
  for (const mode of [null, [], ['chat'], {}, true, 'constructor', 'auto']) assert.equal(planGroupSettings(cfg, { action: 'set', group_id: G, mode }).ok, false)
})

test('仅模块：普通消息、@、引用、唤醒词和戳一戳不进入 AI；模块命令仍可发送', async t => {
  const received = []
  const s = setup(t, { hooks: { message: async msg => {
    received.push(msg.text)
    if (msg.text === '#表情列表') { await s.hub.sendText(msg.chatId, '表情菜单'); return true }
    if (msg.text === '模块失败') throw new Error('/private/host/internal.js secret')
    return false
  } } })
  for (const [text, extra] of [['普通聊天', []], ['你好', [at]], ['引用', [{ type: 'reply', data: { id: '9' } }]], ['大肥鱼', []], ['模块失败', []], ['#表情列表', []]]) {
    await s.hub.onMessage(event(text, G, extra))
  }
  await s.hub.onPoke({ self_id: +BOT, target_id: +BOT, group_id: +G, user_id: +OWNER })
  await settle()
  assert.equal(received.length, 6); assert.equal(s.fake.agents.size, 0)
  const sends = s.calls.filter(x => x.action === 'send_group_msg')
  assert.equal(sends.length, 1); assert.match(JSON.stringify(sends), /表情菜单/)
  assert.doesNotMatch(JSON.stringify(sends), /internal|secret|private\/host/)
  await s.hub.onMessage(event('你好', H, [at])); await settle()
  await s.hub.onMessage(event('私聊', '')); await settle()
  assert.equal(s.fake.turns.length, 2, '其他群和主人私聊保持可用')
})

test('未加白群仍不调用消息模块；仅模块不会绕过白名单', async t => {
  let count = 0
  const s = setup(t, { patch: { allow: { groups: [H] } }, hooks: { message: () => { count++; return true } } })
  await s.hub.onMessage(event('#表情列表', G, [at])); assert.equal(count, 0); assert.equal(s.fake.turns.length, 0)
})

test('模块等待期间改为仅模块，不会继续 AI；改回后新消息正常工作', async t => {
  const entered = deferred(), gate = deferred()
  t.after(() => gate.resolve(false))
  const s = setup(t, { patch: { group: {} }, hooks: { message: () => { entered.resolve(); return gate.promise } } })
  const work = s.hub.onMessage(event('你好', G, [at])); await entered.promise
  s.cfg.group.moduleOnlyGroups = [G]; gate.resolve(false); await work
  assert.equal(s.fake.turns.length, 0)
  s.cfg.group.moduleOnlyGroups = []; await s.hub.onMessage(event('新消息', G, [at])); await settle()
  assert.equal(s.fake.turns.length, 1)
})

test('合并等待中的消息切换模式后丢弃，不会迟到启动 AI', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const s = setup(t, { patch: { group: {}, merge: { enabled: true, groupWaitSec: 1, groupMaxSec: 3 } } })
  await s.hub.onMessage(event('等一会', G, [at])); s.cfg.group.moduleOnlyGroups = [G]
  t.mock.timers.tick(1100); await settle()
  assert.equal(s.fake.turns.length, 0)
  s.cfg.group.moduleOnlyGroups = []; await s.hub.onMessage(event('新的一轮', G, [at]))
  t.mock.timers.tick(1100); await settle()
  assert.equal(s.fake.turns.length, 1)
})

for (const stage of ['prompt', 'brain', 'send']) test(`在 ${stage} 等待期间关闭 AI，不投递迟到回复，模块发送仍可用`, async t => {
  const entered = deferred(), gate = deferred()
  t.after(() => gate.resolve())
  const s = setup(t, { patch: { group: {} },
    brain: async () => { if (stage === 'brain') { entered.resolve(); await gate.promise } return '旧回复' },
    hooks: { prompt: async content => { if (stage === 'prompt') { entered.resolve(); await gate.promise } return content },
      send: async segments => { if (stage === 'send') { entered.resolve(); await gate.promise } return segments } } })
  const work = s.hub.onMessage(event('开始', G, [at])); await entered.promise
  s.cfg.group.moduleOnlyGroups = [G]; gate.resolve(); await work; await settle()
  assert.equal(s.calls.filter(x => x.action === 'send_group_msg').length, 0)
  if (stage === 'prompt') assert.equal(s.fake.turns.length, 0)
  await s.hub.sendText(`group:${G}`, '模块结果')
  assert.equal(s.calls.filter(x => x.action === 'send_group_msg').length, 1)
})

test('单独 @ 仍唤醒，正文不伪称有图片；真实图片按原样呈现', async t => {
  const s = setup(t)
  await s.hub.onMessage(event(' ', H, [at])); await settle()
  const turn = s.fake.turns[0]
  assert.match(turn.userText, /^\[1\].*@了你$/m)
  assert.equal(turn.images, 0)
  await s.hub.onMessage({ ...event('', H, [at, { type: 'image', data: { sub_type: 0, file: 'base64://iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5S8AAAAASUVORK5CYII=' } }]), message_id: 2 }); await settle()
  assert.match(s.fake.turns[1].userText, /^\[1\].*@了你：\[图片\]$/m)
  await s.hub.onMessage({ ...event('（没有文字）', H, [at]), message_id: 3 }); await settle()
  assert.match(s.fake.turns[2].userText, /^\[1\].*@了你：（没有文字）$/m)
})
