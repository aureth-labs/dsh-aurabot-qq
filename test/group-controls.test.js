import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize } from '../src/core/config.js'
import { checkAllowed, shouldObserveGroup } from '../src/chat/access.js'
import { decideGroupReply, policyFor } from '../src/chat/group-policy.js'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { createHub } from '../src/chat/hub.js'
import { createMemoryStore } from '../src/features/memory.js'

const G = '30000003', U = '10000002', BOT = '20000002'
const now = 5_000_000
const input = { text: '我也喜欢这个游戏', now, hour: 12, relevance: 1, recentTimes: [now, now, now], rand: () => 0,
  engagedUntil: now + 10000, engagedRun: 0 }
const decide = (patch = {}, p = {}) => decideGroupReply({ ...input, policy: policyFor(patch, {}, G), ...p })

test('旧配置和零概率保持原有行为', () => {
  assert.equal(decide().mode, 'engaged')
  assert.equal(decide({ interjectChance: 0 }).reply, false)
  assert.equal(decide({ interjectChance: 0 }, { mentioned: true }).mode, 'must')
  assert.equal(normalize({}).group.engagedEnabled, null)
})

test('可只在窗口内接话，概率为零也能明确开启；窗口结束不主动加入', () => {
  const p = { proactiveEnabled: false, engagedEnabled: true, interjectChance: 0 }
  assert.equal(decide(p).mode, 'engaged')
  assert.equal(decide(p, { engagedUntil: now }).reply, false)
  assert.equal(decide(p, { engagedUntil: 0 }).reply, false)
})

test('可以只主动加入而不窗口接话；两个都关闭不影响明确被叫到', () => {
  assert.equal(decide({ engagedEnabled: false, proactiveEnabled: true }).mode, 'interject')
  const off = { engagedEnabled: false, proactiveEnabled: false }
  assert.equal(decide(off).reply, false)
  for (const direct of [{ mentioned: true }, { repliedToBot: true }, { text: '肥鱼来啦' }, { text: '人呢', lastIsBot: true, botReplyTimes: [now - 1000] }]) {
    assert.equal(decide(off, direct).mode, 'must')
  }
})

test('窗口接话仍遵守相关度、次数、静默时段和突发刹车', () => {
  const p = { proactiveEnabled: false, engagedEnabled: true }
  for (const extra of [{ relevance: 0 }, { engagedRun: 6 }, { hour: 2 }, { botReplyTimes: Array(8).fill(now) }]) {
    assert.equal(decide(p, extra).reply, false)
  }
})

test('单群独立覆盖，移除后跟随；不破坏其他单群设置', () => {
  const cfg = normalize({ group: { engagedEnabled: false, overrides: {
    [G]: { engagedEnabled: true, proactiveEnabled: false, cooldownSec: 77 },
    '40000004': { engagedEnabled: 'false', proactiveEnabled: null, interjectChance: 0 },
  } } })
  assert.equal(decideGroupReply({ ...input, policy: policyFor(cfg.group, cfg.group.overrides, G) }).mode, 'engaged')
  assert.equal(policyFor(cfg.group, cfg.group.overrides, G).cooldownSec, 77)
  assert.equal(policyFor(cfg.group, cfg.group.overrides, '40000004').engagedEnabled, false)
  assert.equal(policyFor(cfg.group, cfg.group.overrides, '40000004').proactiveEnabled, true)
  delete cfg.group.overrides[G]
  assert.equal(policyFor(cfg.group, cfg.group.overrides, G).engagedEnabled, false)
})

test('旁听名单默认空，群号归一化；不增加聊天权限', () => {
  assert.deepEqual(normalize({}).memory.passiveGroups, [])
  const cfg = normalize({ enabled: true, memory: { passiveGroups: `${G}, ${G}\nabc\n40000004` } })
  assert.deepEqual(cfg.memory.passiveGroups, [G, '40000004'])
  const msg = { kind: 'group', groupId: G, userId: U }
  assert.equal(shouldObserveGroup(cfg, msg), true)
  assert.equal(checkAllowed(cfg, msg).allowed, false)
  assert.equal(shouldObserveGroup(cfg, { ...msg, kind: 'private' }), false)
})

function setup(t, patch = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-passive-'))
  process.env.AURABOT_DATA_DIR = root
  const cfg = normalize({ enabled: true, dryRun: true, ownerQQ: '10000001', botQQ: BOT,
    workspaceDir: join(root, 'workspace'), merge: { enabled: false }, titleFilter: { enabled: false },
    group: { proactiveEnabled: false, engagedEnabled: false },
    memory: { enabled: true, passiveGroups: [G] }, ...patch })
  const fake = createFakeDsh({ brain: async () => { throw new Error('旁听不应调用聊天模型') } })
  const calls = [], messages = [], commands = [], activity = []
  const hub = createHub({ dsh: fake.ctx, getConfig: () => cfg,
    onebot: { connected: true, async call(action, args) { calls.push(action); return { title: '大肥鱼' } } },
    log: Object.fromEntries(['info', 'warn', 'error', 'debug'].map(k => [k, () => {}])),
    hooks: { message: (...a) => { messages.push(a) } },
    onCommand: (...a) => { commands.push(a) }, onActivity: (...a) => { activity.push(a) } })
  t.after(() => { hub.dispose(); fake.dispose(); rmSync(root, { recursive: true, force: true }) })
  const event = (text, extra = {}) => ({ post_type: 'message', message_type: 'group', self_id: Number(BOT),
    group_id: Number(G), user_id: Number(U), message_id: 123, sender: { nickname: '小纸船', user_id: Number(U) },
    message: [{ type: 'text', data: { text } }], ...extra })
  const rows = () => hub.chatLogDays().flatMap(d => hub.chatLogOf(d))
  return { cfg, hub, fake, calls, messages, commands, activity, event, rows }
}

test('非白名单旁听写入带群和作者的文字，但 @ / 命令也不触发 agent、消息钩子或 QQ 调用', async t => {
  const s = setup(t)
  await s.hub.onMessage(s.event('我喜欢白米饭'))
  await s.hub.onMessage(s.event('', { user_id: 10000001, message: [
    { type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: '/reset' } },
    { type: 'image', data: { file: 'https://example.invalid/no-download.png' } },
    { type: 'record', data: { file: 'https://example.invalid/no-download.wav' } },
  ] }))
  assert.equal(s.rows().length, 2)
  assert.equal(s.rows()[0].chatId, `group:${G}`)
  assert.equal(s.rows()[0].uid, U)
  assert.equal(s.rows()[0].text, '我喜欢白米饭')
  assert.deepEqual(s.rows()[0].interaction, undefined)
  assert.equal(s.fake.agents.size, 0)
  for (const xs of [s.calls, s.messages, s.commands, s.activity]) assert.equal(xs.length, 0)
})

for (const [name, patch] of Object.entries({
  '总开关关闭': { enabled: false },
  '记忆关闭': { memory: { enabled: false, passiveGroups: [G] } },
  '未列入旁听名单': { memory: { passiveGroups: [] } },
  '调试模式': { debug: true },
  '命中头衔过滤': { titleFilter: { enabled: true, groups: [G], title: '大肥鱼' } },
})) test(`${name}不写旁听流水`, async t => {
  const s = setup(t, patch)
  await s.hub.onMessage(s.event('我喜欢白米饭'))
  assert.deepEqual(s.rows(), [])
  assert.equal(s.fake.agents.size, 0)
})

test('旁听只针对群，移除后停止新增、不删除已记录文字', async t => {
  const s = setup(t)
  await s.hub.onMessage(s.event('留存的一句'))
  s.cfg.memory.passiveGroups = []
  await s.hub.onMessage(s.event('不应记住的一句'))
  s.cfg.memory.passiveGroups = [G]
  await s.hub.onMessage(s.event('私聊不应旁听', { message_type: 'private', user_id: Number(G) }))
  assert.deepEqual(s.rows().map(r => r.text), ['留存的一句'])
})

test('同一群在白名单和旁听名单时沿用原逻辑，不重复写入；记忆关闭也不改变白名单旧行为', async t => {
  const s = setup(t, { allow: { groups: [G] }, memory: { enabled: false, passiveGroups: [G] } })
  await s.hub.onMessage(s.event('普通群消息'))
  assert.equal(s.rows().length, 1)
  assert.equal(s.rows()[0].text, '普通群消息')
})


test('旁听流水进入现有记忆整理并保留群作用域，不开聊天会话', async t => {
  const s = setup(t, { model: { provider: 'test', model: 'test' }, memory: { enabled: true, passiveGroups: [G], gistEnabled: false } })
  await s.hub.onMessage(s.event('本群约好了周六下午去公园野餐'))
  const transcripts = []
  const dsh = { get: () => null, llm: { async *stream({ system, messages }) {
    const extracting = system.includes('整理长期记忆')
    if (extracting) transcripts.push(messages[0].content[0].text)
    yield { type: 'text-delta', text: extracting ? JSON.stringify([{ text: '本群约好了周六下午去公园野餐', scope: 'group', speaker: U }]) : '{"insights":[],"style":[]}' }
    yield { type: 'finish', reason: { kind: 'completed' } }
  } } }
  const mem = createMemoryStore({ dsh, getConfig: () => s.cfg, hub: s.hub, log: { info() {}, warn() {}, debug() {} } })
  const result = await mem.consolidate({ includeToday: true })
  assert.equal(result.ok, true)
  assert.equal(result.added, 1)
  assert.equal(transcripts.length, 1)
  assert.ok(transcripts[0].includes('公园野餐'))
  const fact = mem.list('公园野餐')[0]
  assert.equal(fact.chatId, `group:${G}`)
  assert.equal(fact.scope, 'group')
  assert.equal(s.fake.agents.size, 0)
  assert.equal(checkAllowed(s.cfg, { kind: 'group', groupId: G }).allowed, false)
})
