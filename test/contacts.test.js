// 好友申请与白名单：权限三档、试运行、请求参数、失败要当失败、主人不能被移出。用假 api / 假 OneBot 测。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeTestIdentity } from './helpers/identity.js'

const { default: contacts, planWhitelist, cleanId } = await import('../src/modules/contacts/index.js')
const { normalize } = await import('../src/core/config.js')

const OWNER = '10001'
const BOT = '20002'
const ownerPm = { kind: 'private', userId: OWNER, chatId: `private:${OWNER}` }
const otherPm = { kind: 'private', userId: '30003', chatId: 'private:30003' }
const group = { kind: 'group', userId: OWNER, groupId: '555', chatId: 'group:555' }

function setup({ cfg = {}, allOwner = true, callImpl } = {}) {
  let config = normalize({ ownerQQ: OWNER, botQQ: BOT, dryRun: false, ...cfg })
  const identity = makeTestIdentity(config.ownerQQ || OWNER, 'qq')
  const calls = []
  const sent = []
  const listeners = {}
  let builder
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-contacts-'))
  const api = {
    core: {
      identity,
      routeOwner: identity.routeOwner,
      hub: { turnSendersAllOwner: () => allOwner },
      onebot: {
        call: async (action, params) => {
          calls.push({ action, params })
          if (callImpl) return callImpl(action, params)
          return null
        },
      },
    },
    log: { warn() {}, info() {} },
    config: () => config,
    setConfig: (fn) => { config = normalize(fn(config)) },
    dataDir: (...p) => join(dir, ...p),
    on: (name, fn) => { listeners[name] = fn },
    tool: (b) => { builder = b },
    sendText: async (chatId, text) => { sent.push({ chatId, text }) },
  }
  contacts.setup(api)
  const tools = (chat) => Object.fromEntries(builder({ chat, sessionId: 's1' }).map((t) => [t.name, t]))
  return { calls, sent, tools, event: (ev) => listeners.onebot(ev), cfg: () => config, set: (patch) => { config = normalize({ ...config, ...patch }) } }
}
const friendEv = (over = {}) => ({ post_type: 'request', request_type: 'friend', user_id: 40004, comment: '你好', flag: 'u_abc', ...over })

test('权限：默认仅主人私聊；所有人含群；关了谁都不挂', () => {
  const t = setup()
  assert.deepEqual(Object.keys(t.tools(ownerPm)).sort(), ['qq_group_settings', 'qq_handle_friend_request', 'qq_handle_group_request', 'qq_list_friend_requests', 'qq_list_group_requests', 'qq_whitelist'])
  assert.deepEqual(Object.keys(t.tools(otherPm)), [])
  assert.deepEqual(Object.keys(t.tools(group)), [])
  assert.deepEqual(Object.keys(t.tools({ kind: 'system' })), [])
  t.set({ profilePerms: { qqFriendRequest: 'all', whitelist: 'off' } })
  assert.deepEqual(Object.keys(t.tools(group)), ['qq_list_friend_requests', 'qq_handle_friend_request'])
  assert.deepEqual(Object.keys(t.tools(otherPm)), ['qq_list_friend_requests', 'qq_handle_friend_request'])
  assert.deepEqual(Object.keys(t.tools(ownerPm)), ['qq_list_friend_requests', 'qq_handle_friend_request', 'qq_list_group_requests', 'qq_handle_group_request'])
  assert.equal(normalize({ profilePerms: { whitelist: 'boss', qqFriendRequest: 7 } }).profilePerms.whitelist, 'owner', '乱填回到默认')
  assert.equal(normalize({}).profilePerms.qqFriendRequest, 'owner')
})

test('执行时按最新设置再查：工具已挂出，设置改成关 / 混进别人的话就拒绝', async () => {
  const t = setup()
  t.event(friendEv())
  const tool = t.tools(ownerPm).qq_handle_friend_request
  t.set({ profilePerms: { qqFriendRequest: 'off' } })
  let r = await tool.execute({ qq: '40004', approve: true })
  assert.equal(r.ok, false)
  assert.equal(t.calls.length, 0)
  const t2 = setup({ allOwner: false })
  t2.event(friendEv())
  r = await t2.tools(ownerPm).qq_handle_friend_request.execute({ qq: '40004', approve: true })
  assert.equal(r.ok, false)
  assert.equal(t2.calls.length, 0)
  const w = setup()
  const wt = w.tools(ownerPm).qq_whitelist
  w.set({ profilePerms: { whitelist: 'off' } })
  r = await wt.execute({ action: 'add', kind: 'private', id: '40004' })
  assert.equal(r.ok, false)
  assert.deepEqual(w.cfg().allow.private, [])
})

test('收到好友申请：记下 flag、给主人提一句，同一条不重复提；关了权限就不打扰', () => {
  const t = setup()
  t.event(friendEv())
  t.event(friendEv())
  assert.equal(t.sent.length, 1)
  assert.equal(t.sent[0].chatId, `private:${OWNER}`)
  assert.match(t.sent[0].text, /40004/)
  t.event({ post_type: 'notice', notice_type: 'friend_add' })
  t.event(friendEv({ request_type: 'group', flag: '' }))
  assert.equal(t.sent.length, 1)
  const q = setup({ cfg: { profilePerms: { qqFriendRequest: 'off' } } })
  q.event(friendEv())
  assert.equal(q.sent.length, 0)
})

test('通过：set_friend_add_request 的 flag 原样取自事件、approve 是布尔', async () => {
  const t = setup()
  t.event(friendEv())
  const r = await t.tools(ownerPm).qq_handle_friend_request.execute({ qq: '40004', approve: true })
  assert.equal(r.ok, true)
  assert.deepEqual(t.calls, [{ action: 'set_friend_add_request', params: { flag: 'u_abc', approve: true } }])
  // 处理完就不再待处理
  const again = await t.tools(ownerPm).qq_handle_friend_request.execute({ qq: '40004', approve: true })
  assert.equal(again.ok, false)
})

test('拒绝、只有一个申请时 QQ 号可不填、多个时要说清楚', async () => {
  const t = setup()
  t.event(friendEv())
  let r = await t.tools(ownerPm).qq_handle_friend_request.execute({ approve: false })
  assert.equal(r.ok, true)
  assert.deepEqual(t.calls[0], { action: 'set_friend_add_request', params: { flag: 'u_abc', approve: false } })
  const m = setup({ callImpl: (a) => (a === 'get_doubt_friends_add_request' ? [] : null) })
  m.event(friendEv())
  m.event(friendEv({ user_id: 50005, flag: 'u_def' }))
  r = await m.tools(ownerPm).qq_handle_friend_request.execute({ approve: true })
  assert.equal(r.ok, false)
  assert.match(r.message, /40004/)
  assert.match(r.message, /50005/)
  assert.equal(m.calls.length, 0)
})

test('user_id=0 的好友申请不丢：通知说明未知QQ（由QQ过滤），可按序号通过', async () => {
  const t = setup()
  t.event(friendEv({ user_id: 0, flag: 'u_unknown_1', comment: '我是小王' }))
  assert.equal(t.sent.length, 1)
  assert.match(t.sent[0].text, /未知QQ（由QQ过滤）/)
  assert.match(t.sent[0].text, /第 1 个/)
  const list = await t.tools(ownerPm).qq_list_friend_requests.execute({})
  assert.match(list.message, /未知QQ（由QQ过滤）/)
  assert.match(list.message, /u_unknown_1/)
  const r = await t.tools(ownerPm).qq_handle_friend_request.execute({ index: 1, approve: true })
  assert.equal(r.ok, true)
  assert.match(r.message, /未知QQ（由QQ过滤）/)
  assert.deepEqual(t.calls.filter((x) => x.action !== 'get_doubt_friends_add_request'), [{ action: 'set_friend_add_request', params: { flag: 'u_unknown_1', approve: true } }])
})

test('未知申请按 flag 处理；删一条不会把其他未知 QQ 的申请一起删掉', async () => {
  const t = setup()
  t.event(friendEv({ user_id: 0, flag: 'u_a' }))
  t.event(friendEv({ user_id: 0, flag: 'u_b' }))
  assert.equal(t.sent.length, 2)
  assert.match(t.sent[1].text, /第 2 个/)
  let r = await t.tools(ownerPm).qq_handle_friend_request.execute({ flag: 'u_a', approve: false })
  assert.equal(r.ok, true)
  assert.deepEqual(t.calls.at(-1), { action: 'set_friend_add_request', params: { flag: 'u_a', approve: false } })
  const list = await t.tools(ownerPm).qq_list_friend_requests.execute({})
  assert.doesNotMatch(list.message, /u_a/)
  assert.match(list.message, /u_b/)
  // 删掉 u_a 后 u_b 变成第 1 个
  r = await t.tools(ownerPm).qq_handle_friend_request.execute({ index: 1, approve: true })
  assert.equal(r.ok, true)
  assert.deepEqual(t.calls.at(-1), { action: 'set_friend_add_request', params: { flag: 'u_b', approve: true } })
})

test('多个申请可按序号查找；qq/flag/序号冲突、坏序号都拒绝', async () => {
  const t = setup()
  t.event(friendEv())
  t.event(friendEv({ user_id: 50005, flag: 'u_def' }))
  const tool = t.tools(ownerPm).qq_handle_friend_request
  assert.equal((await tool.execute({ index: 0, approve: true })).ok, false)
  assert.equal((await tool.execute({ index: 1.5, approve: true })).ok, false)
  assert.equal((await tool.execute({ index: 1, flag: 'u_abc', approve: true })).ok, false)
  assert.equal((await tool.execute({ qq: '40004', index: 1, approve: true })).ok, false)
  assert.equal(t.calls.length, 0)
  const r = await tool.execute({ index: 2, approve: true })
  assert.equal(r.ok, true)
  assert.deepEqual(t.calls, [{ action: 'set_friend_add_request', params: { flag: 'u_def', approve: true } }])
})

test('好友申请列表合并事件和 QQ 过滤申请，同一 uid 不重复；可按 flag 处理过滤申请', async () => {
  const t = setup({ callImpl: (a) => (a === 'get_doubt_friends_add_request' ? [
    { uid: 'u_unknown_1', user_id: 0, msg: 'hi' },
    { uid: 'u_doubt_2', user_id: 60006, nick: 'x', msg: 'hello' },
  ] : null) })
  t.event(friendEv({ user_id: 0, flag: 'u_unknown_1', comment: '' }))
  const list = await t.tools(ownerPm).qq_list_friend_requests.execute({})
  assert.equal((list.message.match(/u_unknown_1/g) || []).length, 1, '事件里已有的 uid 不要在过滤列表里再列一遍')
  assert.match(list.message, /2\. QQ 60006/)
  const r = await t.tools(ownerPm).qq_handle_friend_request.execute({ flag: 'u_doubt_2', approve: true })
  assert.equal(r.ok, true)
  assert.deepEqual(t.calls.at(-1), { action: 'set_doubt_friends_add_request', params: { flag: 'u_doubt_2', approve: true } })
})

test('试运行：未知 QQ 申请只回话，不调接口、申请还在', async () => {
  const t = setup({ cfg: { dryRun: true } })
  t.event(friendEv({ user_id: 0, flag: 'u_dry' }))
  const r = await t.tools(ownerPm).qq_handle_friend_request.execute({ index: 1, approve: true })
  assert.equal(r.ok, true)
  assert.match(r.message, /试运行/)
  assert.equal(t.calls.length, 0)
  t.set({ dryRun: false })
  assert.equal((await t.tools(ownerPm).qq_handle_friend_request.execute({ index: 1, approve: true })).ok, true)
})

test('试运行只回话：不调接口、申请还在', async () => {
  const t = setup({ cfg: { dryRun: true } })
  t.event(friendEv())
  const r = await t.tools(ownerPm).qq_handle_friend_request.execute({ qq: '40004', approve: true })
  assert.equal(r.ok, true)
  assert.match(r.message, /试运行/)
  assert.equal(t.calls.length, 0)
  t.set({ dryRun: false })
  assert.equal((await t.tools(ownerPm).qq_handle_friend_request.execute({ qq: '40004', approve: true })).ok, true)
})

test('接口返回非 ok（OneBotError）要报失败，申请留着可以重试', async () => {
  let fail = true
  const t = setup({ callImpl: (a) => { if (fail && a === 'set_friend_add_request') throw new Error('set_friend_add_request 失败：retcode 1200') } })
  t.event(friendEv())
  let r = await t.tools(ownerPm).qq_handle_friend_request.execute({ qq: '40004', approve: true })
  assert.equal(r.ok, false)
  assert.match(r.message, /没成功/)
  assert.match(r.message, /1200/)
  fail = false
  r = await t.tools(ownerPm).qq_handle_friend_request.execute({ qq: '40004', approve: true })
  assert.equal(r.ok, true)
})

test('没收到过事件、但在 QQ 过滤的「可能认识的人」里：走 set_doubt_friends_add_request，flag 用列表里的 uid', async () => {
  const t = setup({ callImpl: (a) => (a === 'get_doubt_friends_add_request' ? [{ uid: 'u_doubt', user_id: 60006, nick: 'x', msg: 'hi' }] : null) })
  const r = await t.tools(ownerPm).qq_handle_friend_request.execute({ qq: '60006', approve: true })
  assert.equal(r.ok, true)
  assert.deepEqual(t.calls.map((c) => c.action), ['get_doubt_friends_add_request', 'set_doubt_friends_add_request'])
  assert.deepEqual(t.calls[1].params, { flag: 'u_doubt', approve: true })
  const none = setup({ callImpl: () => [] })
  const n = await none.tools(ownerPm).qq_handle_friend_request.execute({ qq: '60006', approve: true })
  assert.equal(n.ok, false)
  assert.equal(none.calls.length, 1, '只查了列表，没有动手')
})

test('参数不对：approve 不是布尔、QQ 号不像号码', async () => {
  const t = setup()
  t.event(friendEv())
  const tool = t.tools(ownerPm).qq_handle_friend_request
  assert.equal((await tool.execute({ qq: '40004', approve: 'yes' })).ok, false)
  assert.equal((await tool.execute({ qq: 'abc', approve: true })).ok, false)
  assert.equal(t.calls.length, 0)
})

test('白名单：加 / 移出 私聊和群、去重、写进配置', async () => {
  const t = setup({ cfg: { allow: { private: ['111111'], groups: [] } } })
  const w = t.tools(ownerPm).qq_whitelist
  let r = await w.execute({ action: 'add', kind: 'private', id: '40004' })
  assert.equal(r.ok, true)
  assert.deepEqual(t.cfg().allow.private, ['111111', '40004'])
  r = await w.execute({ action: 'add', kind: 'private', id: '40004' })
  assert.match(r.message, /已经在/)
  assert.deepEqual(t.cfg().allow.private, ['111111', '40004'])
  r = await w.execute({ action: 'add', kind: 'group', id: '777888' })
  assert.deepEqual(t.cfg().allow.groups, ['777888'])
  r = await w.execute({ action: 'remove', kind: 'group', id: '777888' })
  assert.equal(r.ok, true)
  assert.deepEqual(t.cfg().allow.groups, [])
  r = await w.execute({ action: 'remove', kind: 'private', id: '111111' })
  assert.deepEqual(t.cfg().allow.private, ['40004'])
  r = await w.execute({ action: 'remove', kind: 'group', id: '777888' })
  assert.match(r.message, /不在/)
  assert.equal(t.calls.length, 0, '改白名单不碰 QQ 接口')
})

test('白名单：不能把主人移出私聊白名单（哪怕名单里有他）；也不能乱填', async () => {
  const t = setup({ cfg: { allow: { private: [OWNER, '111111'], groups: [] } } })
  const w = t.tools(ownerPm).qq_whitelist
  let r = await w.execute({ action: 'remove', kind: 'private', id: OWNER })
  assert.equal(r.ok, false)
  assert.match(r.message, /主人/)
  assert.deepEqual(t.cfg().allow.private, [OWNER, '111111'])
  r = await w.execute({ action: 'add', kind: 'private', id: BOT })
  assert.equal(r.ok, false)
  // 群号和主人 QQ 号撞了也不受影响（两张表互不相干）
  r = await w.execute({ action: 'remove', kind: 'group', id: OWNER })
  assert.equal(r.ok, true)
  for (const bad of [{ action: 'del', kind: 'private', id: '40004' }, { action: 'add', kind: 'team', id: '40004' }, { action: 'add', kind: 'private', id: '12' }, { action: 'add', kind: 'private', id: '' }, { action: 'add', kind: 'private', id: 'abc' }]) {
    assert.equal((await w.execute(bad)).ok, false, JSON.stringify(bad))
  }
  assert.deepEqual(t.cfg().allow.private, [OWNER, '111111'])
})

test('白名单试运行：只回话，配置不变', async () => {
  const t = setup({ cfg: { dryRun: true, allow: { private: ['111111'], groups: ['555666'] } } })
  const w = t.tools(ownerPm).qq_whitelist
  let r = await w.execute({ action: 'add', kind: 'private', id: '40004' })
  assert.match(r.message, /试运行/)
  r = await w.execute({ action: 'remove', kind: 'group', id: '555666' })
  assert.match(r.message, /试运行/)
  assert.deepEqual(t.cfg().allow, { private: ['111111'], groups: ['555666'] })
  // 试运行时主人保护照样生效
  r = await w.execute({ action: 'remove', kind: 'private', id: OWNER })
  assert.equal(r.ok, false)
})

test('白名单：保存时用最新配置，不盖掉别处刚改的', async () => {
  const t = setup({ cfg: { allow: { private: [], groups: [] } } })
  const w = t.tools(ownerPm).qq_whitelist
  t.set({ allow: { private: ['222222'], groups: [] } })
  await w.execute({ action: 'add', kind: 'private', id: '40004' })
  assert.deepEqual(t.cfg().allow.private, ['222222', '40004'])
})

test('白名单：所有人档，群友也能改（权限由面板决定）', async () => {
  const t = setup({ cfg: { profilePerms: { whitelist: 'all' } }, allOwner: false })
  const r = await t.tools(group).qq_whitelist.execute({ action: 'add', kind: 'group', id: '777888' })
  assert.equal(r.ok, true)
  assert.deepEqual(t.cfg().allow.groups, ['777888'])
})

test('纯函数：cleanId / planWhitelist', () => {
  assert.equal(cleanId(' 40004 '), '40004')
  assert.equal(cleanId('12'), '')
  assert.equal(cleanId('1234567890123'), '')
  assert.equal(planWhitelist({ ownerQQ: '1', allow: { private: [], groups: [] } }, { action: 'add', kind: 'group', id: '12345' }).next[0], '12345')
})
