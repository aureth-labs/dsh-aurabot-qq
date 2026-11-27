import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize } from '../src/core/config.js'
import { ignoredGroupMember, validMemberFilter } from '../src/chat/member-filter.js'
import { createHub } from '../src/chat/hub.js'
import { createFakeDsh } from './helpers/fake-dsh.js'
const U = '50000005', G = '30000003', H = '40000004', OWNER = '10000001', BOT = '20000002'
const rule = (scope = 'groups', groups = [G]) => ({ enabled: true, rules: [{ userId: U, scope, groups }] })
const msg = (groupId = G, userId = U) => ({ kind: 'group', groupId, userId })

test('默认空名单；指定群留空或无效不会扩大为所有群；主人和私聊不拦', () => {
  assert.deepEqual(normalize({}).memberFilter, { enabled: true, rules: [] })
  const c = normalize({ ownerQQ: OWNER, memberFilter: rule() })
  assert.equal(ignoredGroupMember(c, msg()), true)
  assert.equal(ignoredGroupMember(c, msg(H)), false)
  assert.equal(ignoredGroupMember(c, { ...msg(), kind: 'private' }), false)
  c.ownerQQ = U; assert.equal(ignoredGroupMember(c, msg()), false); c.ownerQQ = OWNER
  for (const r of [rule('groups', []), rule('bad', []), rule('groups', ['invalid'])]) {
    c.memberFilter = normalize({ memberFilter: r }).memberFilter
    assert.equal(ignoredGroupMember(c, msg()), false)
  }
  c.memberFilter = rule('all', []); assert.equal(ignoredGroupMember(c, msg(H)), true)
  c.memberFilter.enabled = false; assert.equal(ignoredGroupMember(c, msg()), false)
})

test('面板输入严格检查，错误号码、重复用户和不明确范围不会被悄悄保存', () => {
  assert.equal(validMemberFilter(rule()), true)
  assert.equal(validMemberFilter(rule('groups', [])), true)
  assert.equal(validMemberFilter(rule('all', [])), true)
  for (const bad of [null, {}, { ...rule(), rules: [...rule().rules, ...rule().rules] }, rule('groups', ['abc']), rule('', []), { ...rule(), extra: true }, { ...rule(), enabled: 'false' }]) assert.equal(validMemberFilter(bad), false)
})

function setup(t, listed = true) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-member-filter-')); process.env.AURABOT_DATA_DIR = dir
  const cfg = normalize({ enabled: true, dryRun: true, ownerQQ: OWNER, botQQ: BOT, workspaceDir: join(dir, 'ws'),
    memberFilter: rule(), allow: { groups: listed ? [G, H] : [], private: [U, OWNER] },
    memory: { enabled: true, passiveGroups: [G] }, titleFilter: { enabled: false },
    stickers: { collect: false }, voice: { asr: true }, merge: { enabled: false } })
  const calls = [], hooks = [], fake = createFakeDsh({ brain: async () => { throw Error('此测试不应调用模型') } })
  const hub = createHub({ getConfig: () => cfg, dsh: fake.ctx, log: { debug() {}, info() {}, warn() {}, error() {} },
    onebot: { connected: true, call: async action => { calls.push(action); return {} } },
    hooks: { message: m => { hooks.push(m); return true }, poke: e => { hooks.push(e); return true } } })
  t.after(() => { hub.dispose(); fake.dispose(); rmSync(dir, { recursive: true, force: true }) })
  const event = (extra = {}) => ({ post_type: 'message', message_type: 'group', self_id: +BOT, user_id: +U, group_id: +G, message_id: 1,
    sender: { user_id: +U, nickname: '测试' }, message: [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: '#表情列表' } }, { type: 'record', data: { file: 'never-download' } }], ...extra })
  return { cfg, hub, fake, calls, hooks, event, rows: () => hub.chatLogDays().flatMap(d => hub.chatLogOf(d)) }
}
for (const listed of [true, false]) test(`拦截发生在模块、下载和记忆前（白名单=${listed}），戳一戳与群文件也拦`, async t => {
  const s = setup(t, listed)
  await s.hub.onMessage(s.event())
  await s.hub.onPoke({ self_id: +BOT, target_id: +BOT, group_id: +G, user_id: +U })
  await s.hub.onGroupFile({ group_id: +G, user_id: +U, file: { name: 'test.txt' } })
  assert.deepEqual(s.hooks, []); assert.deepEqual(s.calls, []); assert.deepEqual(s.rows(), []); assert.equal(s.fake.agents.size, 0)
})
test('其他群、私聊、主人保持可用；取消规则后新消息即时恢复', async t => {
  const s = setup(t)
  const text = [{ type: 'text', data: { text: '#表情列表' } }]
  await s.hub.onMessage(s.event({ group_id: +H, message: text }))
  await s.hub.onMessage(s.event({ message_type: 'private', message: text }))
  await s.hub.onMessage(s.event({ user_id: +OWNER, message: text }))
  assert.equal(s.hooks.length, 3)
  s.cfg.memberFilter.enabled = false
  await s.hub.onMessage(s.event({ message: text })); assert.equal(s.hooks.length, 4)
})
