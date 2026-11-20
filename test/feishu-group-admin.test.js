// 飞书群管全链路验证：
//   - Feishu adapter groupAdmin 能力对象（getBotState / getGroupInfo / listMembers / kickMember / 错误码映射）
//   - groupRoles 多后端解析（Feishu owner/admin/member/unknown、错误文案、与 QQ/QQBot 同号不串台）
//   - group-admin 模块能力驱动（Feishu 仅 kick/list_members、禁止 ban/whole_ban/title/notice、@ 与昵称解析）
//   - 安全性（非主人/dryRun/踢主人/踢机器人/非白名单/跨群 open_id）与 /groups/roles 面板响应

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFeishuAdapter } from '../src/adapters/feishu/index.js'
import { createGateway } from '../src/gateway/index.js'
import { createIdentity } from '../src/gateway/identity.js'
import { createGroupRoles } from '../src/chat/group-roles.js'
import { normalize } from '../src/core/config.js'
import groupAdminDef from '../src/modules/group-admin/index.js'

const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return this } }

function makeFeishuMockClient(handler) {
  return {
    async request(req) {
      const u = new URL(req.url)
      const body = typeof req.body === 'string' && req.body ? JSON.parse(req.body) : req.body
      if (u.pathname.endsWith('/tenant_access_token/internal')) {
        return { status: 200, json: { code: 0, tenant_access_token: 't_feishu_test', expire: 7200 } }
      }
      if (u.pathname.endsWith('/bot/v3/info')) {
        return { status: 200, json: { code: 0, bot: { open_id: 'ou_bot', app_name: '飞书测试Bot' } } }
      }
      return handler({ method: req.method, path: u.pathname, query: u.searchParams, body })
    },
  }
}

test('Feishu adapter groupAdmin：能力边界、角色探测、分页成员列表、踢人与错误码映射', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-feishu-ga-'))
  const identity = createIdentity({ dataDir: dir, log: silent })
  t.after(() => identity.close?.())

  const cfg = normalize({
    enabled: false,
    platforms: {
      qq: { enabled: false },
      feishu: { enabled: true, appId: 'cli_test_app', appSecret: 'sec_1', transport: 'webhook' },
    },
  })
  cfg.platforms = {
    qq: { enabled: false },
    feishu: { enabled: true, appId: 'cli_test_app', appSecret: 'sec_1', transport: 'webhook' },
  }

  let chatMode = 'admin' // 'owner' | 'admin' | 'member' | 'unknown' | '99991672' | '232019'
  let kickMode = 'ok' // 'ok' | 'invalid_id_list' | '232025' | '232027' | '99991672' | '232019' | '232010' | '230002'
  const calls = []

  const gw = createGateway({
    config: cfg,
    dataDir: (...p) => join(dir, 'gw', ...p),
    http: { route: () => () => {} },
    identity,
    log: silent,
  })
  let adapter = null
  gw.register(() => {
    adapter = createFeishuAdapter({
      client: makeFeishuMockClient(async (req) => {
        calls.push({ method: req.method, path: req.path, query: Object.fromEntries(req.query), body: req.body })
        if (req.method === 'GET' && req.path === '/open-apis/im/v1/chats/oc_g1') {
          if (chatMode === '99991672') return { status: 400, json: { code: 99991672, msg: 'Access denied' } }
          if (chatMode === '232019') return { status: 429, json: { code: 232019, msg: 'rate limited' } }
          const base = { name: '研发测试群', owner_id: chatMode === 'owner' ? 'ou_bot' : 'ou_owner', user_count: '12' }
          if (chatMode === 'admin') base.bot_manager_id_list = ['cli_test_app']
          else if (chatMode === 'member') base.bot_manager_id_list = []
          return { status: 200, json: { code: 0, data: base } }
        }
        if (req.method === 'GET' && req.path === '/open-apis/im/v1/chats/oc_g1/members') {
          const pt = req.query.get('page_token') || ''
          if (!pt) {
            return {
              status: 200,
              json: {
                code: 0,
                data: {
                  has_more: true,
                  page_token: 'page_2',
                  items: [
                    { member_id: 'ou_owner', member_id_type: 'open_id', name: '群主大大' },
                    { member_id: 'ou_alice', member_id_type: 'open_id', name: '爱丽丝' },
                  ],
                },
              },
            }
          }
          return {
            status: 200,
            json: {
              code: 0,
              data: {
                has_more: false,
                page_token: '',
                items: [
                  { member_id: 'ou_alice', member_id_type: 'open_id', name: '爱丽丝' },
                  { member_id: 'ou_bob', member_id_type: 'open_id', name: '鲍勃' },
                ],
              },
            },
          }
        }
        if (req.method === 'DELETE' && req.path === '/open-apis/im/v1/chats/oc_g1/members') {
          if (kickMode === 'invalid_id_list') return { status: 200, json: { code: 0, data: { invalid_id_list: req.body?.id_list || [] } } }
          if (kickMode === '232025') return { status: 400, json: { code: 232025, msg: 'Only owner or manager can operate' } }
          if (kickMode === '232027') return { status: 400, json: { code: 232027, msg: 'There are no valid members' } }
          if (kickMode === '99991672') return { status: 403, json: { code: 99991672, msg: 'No scope' } }
          if (kickMode === '232019') return { status: 429, json: { code: 232019, msg: 'rate limited' } }
          if (kickMode === '232010') return { status: 400, json: { code: 232010, msg: 'different tenants' } }
          if (kickMode === '230002') return { status: 400, json: { code: 230002, msg: 'not in chat' } }
          return { status: 200, json: { code: 0, data: { invalid_id_list: [] } } }
        }
        return { status: 404, json: { code: 404, msg: 'not found' } }
      }),
    })
    return adapter
  })

  // 未启动时调用直接报 group-admin-failed + 未连接
  await assert.rejects(() => adapter.groupAdmin.getBotState('oc_g1'), (e) => e.code === 'group-admin-failed' && /未连接/.test(e.message))

  await gw.sync()
  t.after(() => gw.stopAll())

  const ga = gw.groupAdmin('feishu')
  assert.ok(ga)
  assert.deepEqual(ga.supportedActions, {
    ban: false,
    unban: false,
    kick: true,
    wholeBan: false,
    title: false,
    notice: false,
    listMembers: true,
  })
  assert.equal(ga.muteMember, undefined)
  assert.equal(ga.unmuteMember, undefined)

  const info = await ga.getGroupInfo('oc_g1')
  assert.equal(info.name, '研发测试群')
  assert.equal(info.memberCount, 12)
  assert.equal(info.ownerId, 'ou_owner')

  chatMode = 'owner'
  assert.equal((await ga.getBotState('oc_g1')).role, 'owner')
  chatMode = 'admin'
  assert.equal((await ga.getBotState('oc_g1')).role, 'admin')
  chatMode = 'member'
  assert.equal((await ga.getBotState('oc_g1')).role, 'member')
  chatMode = 'unknown'
  const stUnknown = await ga.getBotState('oc_g1')
  assert.equal(stUnknown.unknownRole, true)
  assert.match(stUnknown.reason, /未返回管理员列表/)

  chatMode = '99991672'
  await assert.rejects(() => ga.getBotState('oc_g1'), (e) => e.code === 'group-admin-forbidden')
  chatMode = '232019'
  await assert.rejects(() => ga.getBotState('oc_g1'), (e) => e.code === 'group-admin-rate-limited')

  const members = await ga.listMembers('oc_g1')
  assert.deepEqual(members.map((m) => m.openid), ['ou_owner', 'ou_alice', 'ou_bob'])
  assert.equal(members[1].nick, '爱丽丝')
  assert.deepEqual((await ga.listMembers('oc_g1', { startIndex: 1, limit: 1 })).map((m) => m.openid), ['ou_alice'])

  await ga.kickMember('oc_g1', 'ou_bob')
  const delCall = calls.filter((c) => c.method === 'DELETE' && c.path.endsWith('/members')).at(-1)
  assert.equal(delCall.query.member_id_type, 'open_id')
  assert.deepEqual(delCall.body, { id_list: ['ou_bob'] })

  kickMode = 'invalid_id_list'
  await assert.rejects(() => ga.kickMember('oc_g1', 'ou_ghost'), (e) => e.code === 'group-admin-not-member')
  kickMode = '232025'
  await assert.rejects(() => ga.kickMember('oc_g1', 'ou_bob'), (e) => e.code === 'group-admin-not-admin')
  kickMode = '232027'
  await assert.rejects(() => ga.kickMember('oc_g1', 'ou_bob'), (e) => e.code === 'group-admin-not-member')
  kickMode = '99991672'
  await assert.rejects(() => ga.kickMember('oc_g1', 'ou_bob'), (e) => e.code === 'group-admin-forbidden')
  kickMode = '232019'
  await assert.rejects(() => ga.kickMember('oc_g1', 'ou_bob'), (e) => e.code === 'group-admin-rate-limited')
  kickMode = '232010'
  await assert.rejects(() => ga.kickMember('oc_g1', 'ou_bob'), (e) => e.code === 'group-admin-forbidden')
  kickMode = '230002'
  await assert.rejects(() => ga.kickMember('oc_g1', 'ou_bob'), (e) => e.code === 'group-admin-failed' && /不在该飞书群里/.test(e.message))
})

test('groupRoles 支持 Feishu：owner/admin/member/unknown、离线与权限报错文案、与 QQ 不串台', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-feishu-roles-'))
  const identity = createIdentity({ dataDir: dir, log: silent })
  t.after(() => identity.close?.())

  const cfg = normalize({
    enabled: true,
    allow: { groups: ['qq:group:555', 'feishu:group:555'] },
    platforms: {
      qq: { enabled: true },
      feishu: { enabled: true, appId: 'cli_r', appSecret: 'sec_r', transport: 'webhook' },
    },
  })
  cfg.platforms = {
    qq: { enabled: true },
    feishu: { enabled: true, appId: 'cli_r', appSecret: 'sec_r', transport: 'webhook' },
  }

  let mode = 'admin' // 'admin' | 'member' | 'unknown' | '99991672'
  const gw = createGateway({ config: cfg, dataDir: (...p) => join(dir, 'gw', ...p), http: { route: () => () => {} }, identity, log: silent })
  gw.register(() => createFeishuAdapter({
    client: makeFeishuMockClient(async (req) => {
      if (req.path === '/open-apis/im/v1/chats/555') {
        if (mode === '99991672') return { status: 403, json: { code: 99991672, msg: 'no chat scope' } }
        const data = { name: '同名飞书群', owner_id: 'ou_owner' }
        if (mode === 'admin') data.bot_manager_id_list = ['cli_r']
        if (mode === 'member') data.bot_manager_id_list = []
        return { status: 200, json: { code: 0, data } }
      }
      return { status: 404, json: { code: 404 } }
    }),
  }))

  const fakeOnebot = { connected: () => true, on: () => {}, call: async () => ({ role: 'owner' }) }
  const roles = createGroupRoles({ onebot: fakeOnebot, getGateway: () => gw, getConfig: () => cfg, dataDir: (...p) => join(dir, 'roles', ...p), log: silent })

  // 停在未同步状态：明确提示飞书未连接（不误报 QQBot 文案）
  const offInfo = await roles.inspect('feishu:group:555', { fresh: true })
  assert.equal(offInfo.backend, 'gateway-admin')
  assert.equal(offInfo.platform, 'feishu')
  assert.match(offInfo.reason, /飞书未连接/)

  await gw.sync()
  t.after(() => gw.stopAll())

  const qqSpec = roles.resolveBackend('qq:group:555')
  const fsSpec = roles.resolveBackend('feishu:group:555')
  assert.equal(qqSpec.backend, 'onebot')
  assert.equal(fsSpec.backend, 'gateway-admin')
  assert.equal(fsSpec.platform, 'feishu')

  const fsAdmin = await roles.inspect('feishu:group:555', { fresh: true })
  assert.equal(fsAdmin.role, 'admin')
  assert.equal(fsAdmin.label, '管理员')
  assert.equal(fsAdmin.canManage, true)
  assert.equal(fsAdmin.actions.kick, true)
  assert.equal(fsAdmin.actions.ban, false)

  mode = 'member'
  const fsMember = await roles.inspect('feishu:group:555', { fresh: true })
  assert.equal(fsMember.role, 'member')
  assert.equal(fsMember.canManage, false)

  mode = 'unknown'
  const fsUnknown = await roles.inspect('feishu:group:555', { fresh: true })
  assert.equal(fsUnknown.role, 'unknown')
  assert.equal(fsUnknown.label, '未知')
  assert.equal(fsUnknown.canManage, true)
  assert.match(fsUnknown.reason, /以 API 结果为准/)

  mode = '99991672'
  const fsForbidden = await roles.inspect('feishu:group:555', { fresh: true })
  assert.equal(fsForbidden.canManage, false)
  assert.match(fsForbidden.reason, /99991672/)
  assert.doesNotMatch(fsForbidden.reason, /11253/)
})

test('Feishu group_admin 全链路：仅暴露 kick/list_members、禁止 ban/whole_ban、安全护栏、双平台隔离与 /groups/roles 面板', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-feishu-mod-'))
  const identity = createIdentity({ dataDir: dir, log: silent })
  t.after(() => identity.close?.())
  const ownerPid = identity.claimOwner('feishu', 'ou_owner')
  identity.link('qq', '10000001', ownerPid, 'owner')

  const cfg = normalize({
    enabled: true,
    dryRun: false,
    ownerQQ: '10000001',
    allow: { groups: ['feishu:group:oc_g1', 'qq:group:555', 'qqbot:group:QB_1'] },
    platforms: {
      qq: { enabled: false },
      qqbot: { enabled: false },
      feishu: { enabled: true, appId: 'cli_m', appSecret: 'sec_m', transport: 'webhook' },
    },
  })
  cfg.platforms = {
    qq: { enabled: false },
    qqbot: { enabled: false },
    feishu: { enabled: true, appId: 'cli_m', appSecret: 'sec_m', transport: 'webhook' },
  }

  let chatRoleMode = 'admin' // 'admin' | 'member' | 'unknown'
  let kickBehavior = 'ok' // 'ok' | '232025'
  const apiCalls = []

  const gw = createGateway({ config: cfg, dataDir: (...p) => join(dir, 'gw', ...p), http: { route: () => () => {} }, identity, log: silent })
  gw.register(() => createFeishuAdapter({
    client: makeFeishuMockClient(async (req) => {
      apiCalls.push({ method: req.method, path: req.path, body: req.body })
      if (req.method === 'GET' && req.path === '/open-apis/im/v1/chats/oc_g1') {
        const data = { name: '飞书核心群', owner_id: 'ou_owner', user_count: '5' }
        if (chatRoleMode === 'admin') data.bot_manager_id_list = ['cli_m']
        else if (chatRoleMode === 'member') data.bot_manager_id_list = []
        return { status: 200, json: { code: 0, data } }
      }
      if (req.method === 'GET' && req.path === '/open-apis/im/v1/chats/oc_g1/members') {
        return {
          status: 200,
          json: {
            code: 0,
            data: {
              has_more: false,
              items: [
                { member_id: 'ou_owner', member_id_type: 'open_id', name: '主人' },
                { member_id: 'ou_alice', member_id_type: 'open_id', name: '爱丽丝' },
                { member_id: 'ou_bob', member_id_type: 'open_id', name: '鲍勃' },
              ],
            },
          },
        }
      }
      if (req.method === 'DELETE' && req.path === '/open-apis/im/v1/chats/oc_g1/members') {
        if (kickBehavior === '232025') return { status: 400, json: { code: 232025, msg: 'Only owner or manager can operate' } }
        return { status: 200, json: { code: 0, data: { invalid_id_list: [] } } }
      }
      return { status: 404, json: { code: 404 } }
    }),
  }))
  await gw.sync()
  t.after(() => gw.stopAll())

  let ownerAll = true
  let onebotConnected = false
  const fakeOnebot = { connected: () => onebotConnected, on: () => {}, call: async () => ({ role: 'owner' }) }
  const groupRoles = createGroupRoles({ onebot: fakeOnebot, getGateway: () => gw, getConfig: () => cfg, dataDir: (...p) => join(dir, 'roles', ...p), log: silent })

  let toolFactory = null
  const contexts = []
  const messageListeners = []
  const routes = new Map()
  groupAdminDef.setup({
    core: {
      hub: { turnSendersAllOwner: () => ownerAll, groupName: async (g) => String(g) },
      onebot: fakeOnebot,
      groupRoles,
      gateway: gw,
      identity,
      http: { body: async (r) => r?.body || {}, query: (r) => r?.query || {} },
    },
    config: () => cfg,
    dataDir: (...p) => join(dir, 'mod', ...p),
    on: (ev, fn) => { if (ev === 'message') messageListeners.push(fn) },
    tool: (fn) => { toolFactory = fn },
    context: (fn) => contexts.push(fn),
    route: (path, handler) => routes.set(path, handler),
  })

  const pickAdmin = (ctx) => [toolFactory(ctx)].flat().filter(Boolean).find((x) => x.name === 'group_admin')
  const fsGroupChat = { chatId: 'feishu:group:oc_g1', kind: 'group', groupId: 'oc_g1', platform: 'feishu' }
  const fsGroupTool = pickAdmin({ chat: fsGroupChat, level: 'social', sessionId: 's_fs_g' })
  const fsPrivTool = pickAdmin({ chat: { chatId: 'feishu:private:ou_owner', kind: 'private', userId: 'ou_owner', platform: 'feishu' }, level: 'full', sessionId: 's_fs_p' })
  const fsConsoleTool = pickAdmin({ chat: { chatId: 'dsh:owner', kind: 'private' }, level: 'full', sessionId: 's_fs_console' })

  // 1) schema 严格收窄为 kick / list_members，且不包含 minutes / text 与任何 QQ 文案
  for (const toolObj of [fsGroupTool, fsPrivTool, fsConsoleTool]) {
    assert.deepEqual(toolObj.parameters.properties.action.enum, ['kick', 'list_members'])
    assert.equal('minutes' in toolObj.parameters.properties, false)
    assert.equal('text' in toolObj.parameters.properties, false)
    assert.doesNotMatch(JSON.stringify(toolObj), /QQ/)
  }

  // 上下文不含 QQ，且说明飞书不支持单人禁言/全体禁言
  const ctxBefore = contexts.map((fn) => fn({ chat: fsGroupChat })).join('\n')
  assert.doesNotMatch(ctxBefore, /QQ/)
  assert.match(ctxBefore, /不支持按成员单人禁言/)

  // 2) 运行时显式拒绝 ban / unban / whole_ban / whole_unban / title / notice
  for (const badAct of ['ban', 'unban', 'whole_ban', 'whole_unban', 'title', 'notice']) {
    const r = await fsGroupTool.execute({ action: badAct, user_id: 'ou_alice' })
    assert.equal(r.ok, false)
    assert.match(r.message, /飞书当前不支持/)
  }

  // 3) list_members 返回 open_id / 名字，并支持筛选；非主人拒绝
  const lmAll = await fsGroupTool.execute({ action: 'list_members' })
  assert.equal(lmAll.ok, true)
  assert.equal(lmAll.count, 3)
  assert.equal(lmAll.members[1].openid, 'ou_alice')
  const lmFilter = await fsGroupTool.execute({ action: 'list_members', query: '爱丽丝' })
  assert.equal(lmFilter.count, 1)

  ownerAll = false
  assert.equal((await fsGroupTool.execute({ action: 'list_members' })).ok, false)
  assert.equal((await fsGroupTool.execute({ action: 'kick', user_id: 'ou_bob' })).ok, false)
  ownerAll = true

  // 4) @提及、昵称、显式 open_id 均可踢人；拒绝纯数字 QQ 号与非法 open_id
  assert.match((await fsGroupTool.execute({ action: 'kick', user_id: '12345678' })).message, /飞书不能按 QQ 号操作/)
  assert.match((await fsGroupTool.execute({ action: 'kick', member_openid: 'not_ou_prefix' })).message, /飞书 open_id 格式不对/)

  for (const fn of messageListeners) {
    await fn({
      kind: 'group',
      platform: 'feishu',
      chatId: 'feishu:group:oc_g1',
      userId: 'ou_owner',
      nickname: '主人',
      sender: { isOwner: true },
      parts: [{ type: 'mention', account: 'ou_alice', name: '爱丽丝' }],
    })
  }
  const ctxMention = contexts.map((fn) => fn({ chat: fsGroupChat })).join('\n')
  assert.match(ctxMention, /open_id=ou_alice/)
  assert.doesNotMatch(ctxMention, /member_openid/)

  const kickByMention = await fsGroupTool.execute({ action: 'kick' })
  assert.equal(kickByMention.ok, true, kickByMention.message)
  assert.deepEqual(apiCalls.filter((c) => c.method === 'DELETE').at(-1)?.body, { id_list: ['ou_alice'] })

  const kickByNick = await fsGroupTool.execute({ action: 'kick', user_id: '鲍勃' })
  assert.equal(kickByNick.ok, true, kickByNick.message)
  assert.deepEqual(apiCalls.filter((c) => c.method === 'DELETE').at(-1)?.body, { id_list: ['ou_bob'] })

  const kickByExplicit = await fsGroupTool.execute({ action: 'kick', member_openid: 'ou_bob' })
  assert.equal(kickByExplicit.ok, true, kickByExplicit.message)

  // 5) 安全边界：dryRun 不调删除、不能踢主人、不能踢机器人自己、不能跨群/非白名单
  cfg.dryRun = true
  const delCountBefore = apiCalls.filter((c) => c.method === 'DELETE').length
  const dryRes = await fsGroupTool.execute({ action: 'kick', member_openid: 'ou_bob' })
  assert.equal(dryRes.ok, true)
  assert.match(dryRes.message, /试运行.*飞书/)
  assert.equal(apiCalls.filter((c) => c.method === 'DELETE').length, delCountBefore)
  cfg.dryRun = false

  assert.match((await fsGroupTool.execute({ action: 'kick', member_openid: 'ou_owner' })).message, /不能对主人/)
  assert.match((await fsGroupTool.execute({ action: 'kick', member_openid: 'ou_bot' })).message, /不能对我自己/)
  assert.match((await fsGroupTool.execute({ action: 'kick', group_id: 'feishu:group:oc_unlisted', member_openid: 'ou_bob' })).message, /不在白名单/)
  assert.match((await fsGroupTool.execute({ action: 'kick', member_openid: 'ou_other_group_member' })).message, /不在当前飞书群的成员列表/)

  // 6) role=unknown 尝试执行由 API 错误判定；role=member 时允许 list_members 但阻止 kick
  chatRoleMode = 'unknown'
  kickBehavior = '232025'
  const res232025 = await fsGroupTool.execute({ action: 'kick', member_openid: 'ou_bob' })
  assert.equal(res232025.ok, false)
  assert.match(res232025.message, /不是群管理员/)
  kickBehavior = 'ok'

  chatRoleMode = 'member'
  assert.equal((await fsGroupTool.execute({ action: 'list_members' })).ok, true)
  assert.match((await fsGroupTool.execute({ action: 'kick', member_openid: 'ou_bob' })).message, /普通成员/)
  const ctxMember = contexts.map((fn) => fn({ chat: fsGroupChat })).join('\n')
  assert.match(ctxMember, /普通成员.*list_members/)
  assert.doesNotMatch(ctxMember, /QQ/)
  chatRoleMode = 'admin'

  // 7) 双平台共存：开启 QQ 后各自保持独立 schema 与行为，不串台
  cfg.platforms.qq.enabled = true
  cfg.platforms.qqbot.enabled = true
  onebotConnected = true
  const qqTool = pickAdmin({ chat: { chatId: 'qq:group:555', kind: 'group', groupId: '555', platform: 'qq' }, level: 'social', sessionId: 's_qq' })
  const qbTool = pickAdmin({ chat: { chatId: 'qqbot:group:QB_1', kind: 'group', groupId: 'QB_1', platform: 'qqbot' }, level: 'social', sessionId: 's_qb' })
  const fsToolDual = pickAdmin({ chat: fsGroupChat, level: 'social', sessionId: 's_fs_dual' })
  assert.deepEqual(qqTool.parameters.properties.action.enum, ['ban', 'unban', 'whole_ban', 'whole_unban', 'kick', 'title', 'notice', 'list_members'])
  assert.deepEqual(qbTool.parameters.properties.action.enum, ['ban', 'unban', 'kick', 'list_members'])
  assert.deepEqual(fsToolDual.parameters.properties.action.enum, ['kick', 'list_members'])
  cfg.platforms.qq.enabled = false
  cfg.platforms.qqbot.enabled = false
  onebotConnected = false

  // 8) 能力降级：supportedActions.kick=false 时工具仅暴露 list_members，执行 kick 直接拒绝
  const gaLive = gw.groupAdmin('feishu')
  const origActions = gaLive.supportedActions
  gaLive.supportedActions = { ...origActions, kick: false }
  const readOnlyTool = pickAdmin({ chat: fsGroupChat, level: 'social', sessionId: 's_ro' })
  assert.deepEqual(readOnlyTool.parameters.properties.action.enum, ['list_members'])
  assert.match((await readOnlyTool.execute({ action: 'kick', member_openid: 'ou_bob' })).message, /不支持移出群成员/)
  gaLive.supportedActions = origActions

  // 9) /groups/roles 与面板渲染：backendLabel='飞书群管'、qqbotInstances 不混入 Feishu、面板渲染飞书能力摘要
  const rolesHandler = routes.get('/groups/roles')
  const rolesJson = await rolesHandler({})
  assert.equal(rolesJson.ok, true)
  const fsRow = rolesJson.list.find((r) => r.groupId === 'feishu:group:oc_g1')
  assert.ok(fsRow)
  assert.equal(fsRow.backendLabel, '飞书群管')
  assert.equal(fsRow.name, '飞书核心群')
  assert.equal(fsRow.actions.kick, true)
  assert.equal(fsRow.actions.ban, false)
  assert.equal(fsRow.actions.wholeBan, false)
  assert.deepEqual(rolesJson.qqbotInstances, [])

  const clientCode = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.match(clientCode, /飞书群支持查成员与踢人（不支持禁言\/全体禁言\/头衔\/公告）/)
  assert.match(clientCode, /支持：查成员、踢人（不支持禁言\/全体禁言\/头衔\/公告）/)
})
