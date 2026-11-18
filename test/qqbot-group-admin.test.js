// QQ 官方机器人群管适配（阶段 1 + 阶段 2）全链路验证：
//   - groupRoles 多后端解析（qqbot groupAdmin / 绑定持久化 / 同号不串台 / 缓存与 fresh / 停用或删除 qqbot 不误用）
//   - group-admin 模块（qqbot ban/unban/kick、非主人拒绝、member_openid 校验、实时重查角色、不支持动作拒绝、OneBot 不回归）
//   - HTTP 接口（/groups/roles /groups/qqbot/bind /groups/qqbot/unbind /groups/qqbot/members）与面板源码契约

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGateway } from '../src/gateway/index.js'
import { createIdentity } from '../src/gateway/identity.js'
import { createGroupRoles } from '../src/chat/group-roles.js'
import { makeIdentity } from './gateway/helpers.js'
import { createQqbotAdapter } from '../src/adapters/qqbot/index.js'
import groupAdminDef from '../src/modules/group-admin/index.js'
import { normalize } from '../src/core/config.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return this } }

function makeQqbotClient(responder) {
  let tokenCount = 0
  return {
    async request(req) {
      if (req.path === '/app/getAppAccessToken') {
        tokenCount++
        return { status: 200, data: { access_token: `tk-${tokenCount}`, expires_in: 7200 } }
      }
      if (req.path === '/users/@me') return { status: 200, data: { id: 'BOT_OID', username: '官方Bot' } }
      if (req.path === '/gateway') return { status: 200, data: { url: 'wss://fake/gw' } }
      return responder(req)
    },
  }
}

test('groupRoles：qqbot 绑定、11253/offline 原因、同群号跨平台不串、停用 qqbot 后不误用与持久化重启恢复', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-qqbot-roles-'))
  const dataFn = (...parts) => join(dir, ...parts)
  const identity = makeIdentity()
  let cfg = {
    enabled: false,
    botQQ: '20000002',
    allow: { groups: ['1136292994', 'qqbot:group:OPENID_LIVE', 'qq:group:1136292994'] },
    platforms: {
      qqbot: { enabled: true, appId: 'app1', clientSecret: 'sec1', transport: 'webhook', botSecret: 'b'.repeat(32) },
    },
  }

  let botStateRole = 'admin'
  let botStateMode = 'ok'
  const botCalls = []
  const onebotCalls = []
  const fakeOnebot = {
    async call(action, params) {
      onebotCalls.push({ action, params })
      return { role: 'member' }
    },
  }

  const gw = createGateway({
    config: cfg,
    dataDir: (...parts) => join(dir, 'gw', ...parts),
    http: { route: () => () => {} },
    identity,
    log: silent,
  })
  let qqbotAdapter = null
  gw.register(() => {
    qqbotAdapter = createQqbotAdapter({
      client: makeQqbotClient(async (req) => {
        botCalls.push({ method: req.method, path: req.path, body: req.body })
        if (req.path.endsWith('/bot_state')) {
          if (botStateMode === '11253') return { status: 403, data: { code: 11253, message: 'no permission' } }
          return { status: 200, data: { member_role: botStateRole, member_openid: 'BOT_M' } }
        }
        if (req.path.endsWith('/info')) return { status: 200, data: { group_openid: 'OPENID_LIVE', group_name: '官方研发群' } }
        return { status: 404, data: null }
      }),
    })
    return qqbotAdapter
  })
  await gw.sync()
  t.after(() => gw.stopAll())

  const roles = createGroupRoles({ onebot: fakeOnebot, getGateway: () => gw, getConfig: () => cfg, dataDir: dataFn, log: silent })

  // 1) 未绑定的数字群号（纯 qqbot 且 OneBot 未启用）：给出明确「先去绑定群」，绝不报 OneBot「她在群里吗」
  const unboundInfo = await roles.inspect('1136292994', { fresh: true })
  assert.equal(unboundInfo.role, '')
  assert.equal(unboundInfo.unbound, true)
  assert.equal(unboundInfo.reason, '先去绑定群')

  // 2) 直接用 qqbot:group:OPENID_LIVE：走官方 bot_state 返回 admin
  const directInfo = await roles.inspect('qqbot:group:OPENID_LIVE', { fresh: true })
  assert.equal(directInfo.backend, 'gateway-admin')
  assert.equal(directInfo.role, 'admin')
  assert.equal(directInfo.canManage, true)

  // 3) 保存别名绑定 1136292994 -> OPENID_LIVE：裸数字走 qqbot；而显式 qq:group:1136292994 严禁串到 qqbot 绑定
  roles.saveBinding({ instance: 'qqbot', openid: 'OPENID_LIVE', alias: '1136292994', name: '官方研发群' })
  const boundBareInfo = await roles.inspect('1136292994', { fresh: true })
  assert.equal(boundBareInfo.backend, 'gateway-admin')
  assert.equal(boundBareInfo.role, 'admin')

  const qqExplicitInfo = await roles.inspect('qq:group:1136292994', { fresh: true })
  assert.equal(qqExplicitInfo.backend, 'onebot')
  assert.equal(qqExplicitInfo.role, 'member')
  assert.equal(onebotCalls.length, 1, '显式 qq:group 必须走 OneBot 而不串台')

  // P1: 非默认 QQ 实例（如 qq#2:group:<id>）绝不静默回落到默认 legacy onebot
  const qq2Spec = roles.resolveBackend('qq#2:group:1136292994')
  assert.equal(qq2Spec.backend, 'none')
  const qq2Info = await roles.inspect('qq#2:group:1136292994', { fresh: true })
  assert.equal(qq2Info.backend, 'none')
  assert.equal(onebotCalls.length, 1, 'qq#2:group 不得串台调用默认 OneBot')

  // 4) 缓存命中 + fresh 强制刷新 + 11253 权限拒绝时不得拿旧缓存 owner/admin 伪装可用
  const beforeCached = botCalls.length
  const cachedHit = await roles.inspect('qqbot:group:OPENID_LIVE')
  assert.equal(cachedHit.role, 'admin')
  assert.equal(botCalls.length, beforeCached, 'TTL 内走缓存')

  botStateMode = '11253'
  const deniedFresh = await roles.inspect('qqbot:group:OPENID_LIVE', { fresh: true })
  assert.equal(deniedFresh.role, '')
  assert.equal(deniedFresh.canManage, false)
  assert.match(deniedFresh.reason, /11253/)

  // 5) 持久化重启恢复 + 停用 qqbot 后绑定不误用
  const rolesReloaded = createGroupRoles({ onebot: fakeOnebot, getGateway: () => gw, getConfig: () => cfg, dataDir: dataFn, log: silent })
  assert.equal(rolesReloaded.bindings().length, 1)
  assert.equal(rolesReloaded.bindings()[0].alias, '1136292994')

  cfg.platforms = {}
  await gw.sync()
  assert.equal(rolesReloaded.bindings()[0].active, false)
  assert.equal(rolesReloaded.bindings({ activeOnly: true }).length, 0)
  const afterDisable = await rolesReloaded.inspect('1136292994', { fresh: true })
  assert.equal(afterDisable.backend, 'none')
  assert.equal(onebotCalls.length, 1, '停用 qqbot 后不误用残留绑定，也不误打未启用的 OneBot')

  // P2-5: touchBindingName 持久化群名并在重启重载后保留
  assert.equal(rolesReloaded.touchBindingName('qqbot:group:OPENID_LIVE', '官方测试群名'), true)
  const rolesPersisted = createGroupRoles({ onebot: fakeOnebot, getGateway: () => gw, getConfig: () => cfg, dataDir: dataFn, log: silent })
  assert.equal(rolesPersisted.bindings()[0].name, '官方测试群名')

  // P2-2: 纯 QQBot（未配 qq 节点且 qqbot 激活）或 qqbot 激活但 OneBot 未连接时，纯数字群返回“先去绑定群”
  const dirQqOnly = mkdtempSync(join(tmpdir(), 'aurabot-roles-p22-'))
  let mustNotCallOnebot = 0
  const stoppedOb = {
    state: 'stopped',
    async call() {
      mustNotCallOnebot++
      throw new Error('stopped onebot must not be called')
    },
  }
  const activeQqbotGw = {
    instances: () => [{ instance: 'qqbot', platform: 'qqbot', enabled: true, state: 'connected' }],
    groupAdmin: (inst) => (inst === 'qqbot' ? {} : null),
  }
  const cfgQqOnly = { enabled: true, platforms: { qqbot: { enabled: true } } }
  const rolesQqOnly = createGroupRoles({
    onebot: stoppedOb,
    getGateway: () => activeQqbotGw,
    getConfig: () => cfgQqOnly,
    dataDir: (...p) => join(dirQqOnly, ...p),
    log: silent,
  })
  const unboundSpec = rolesQqOnly.resolveBackend('123456')
  assert.equal(unboundSpec.backend, 'none')
  assert.equal(unboundSpec.unbound, true)
  assert.equal(unboundSpec.reason, '先去绑定群')
  const unboundInspect = await rolesQqOnly.inspect('123456', { fresh: true })
  assert.equal(unboundInspect.backend, 'none')
  assert.equal(unboundInspect.reason, '先去绑定群')

  // 混合配了 qq 与 qqbot 但 OneBot 未连接时，裸数字群也不回退 stopped/connecting onebot
  const cfgMixed = { enabled: true, platforms: { qq: { enabled: true }, qqbot: { enabled: true } } }
  const rolesMixed = createGroupRoles({
    onebot: { ...stoppedOb, state: 'connecting' },
    getGateway: () => activeQqbotGw,
    getConfig: () => cfgMixed,
    dataDir: (...p) => join(dirQqOnly, ...p),
    log: silent,
  })
  const mixedSpec = rolesMixed.resolveBackend('123456')
  assert.equal(mixedSpec.backend, 'none')
  assert.equal(mixedSpec.unbound, true)
  assert.equal(mixedSpec.reason, '先去绑定群')
  assert.equal(mustNotCallOnebot, 0)
})

test('group-admin：qqbot ban/unban/kick、禁止纯数字 QQ、实时重查角色、拒绝公告/头衔与 OneBot 兼容', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-qqbot-admin-'))
  const identity = createIdentity({ dataDir: dir, log: silent })
  t.after(() => identity.close?.())
  const ownerPerson = identity.claimOwner('qqbot', 'OWNER_OPENID')
  identity.link('qq', '10000001', ownerPerson, 'manual')

  let botRole = 'admin'
  let kickMode = 'ok'
  const apiCalls = []
  const onebotCalls = []
  const fakeOnebot = {
    async call(action, params) {
      onebotCalls.push({ action, params })
      if (action === 'get_group_member_info') return { role: 'owner' }
      return {}
    },
  }
  const cfg = normalize({
    enabled: true,
    dryRun: false,
    botQQ: '20000002',
    ownerQQ: '10000001',
    allow: { groups: ['555', 'qqbot:group:OPENID_ADMIN'] },
    platforms: {
      qq: { enabled: true },
      qqbot: { enabled: true, appId: 'app1', clientSecret: 'sec1', transport: 'webhook', botSecret: 'b'.repeat(32) },
    },
  })

  const gw = createGateway({
    config: cfg,
    dataDir: (...parts) => join(dir, 'gw', ...parts),
    http: { route: () => () => {} },
    identity,
    log: silent,
  })
  let qqbotAdapter = null
  gw.register(() => {
    qqbotAdapter = createQqbotAdapter({
      client: makeQqbotClient(async (req) => {
        apiCalls.push({ method: req.method, path: req.path, body: req.body })
        if (req.path.endsWith('/bot_state')) return { status: 200, data: { member_role: botRole } }
        if (req.path.endsWith('/info')) return { status: 200, data: { group_openid: 'OPENID_ADMIN', group_name: '正式官方群' } }
        if (req.path.endsWith('/members')) return { status: 200, data: { members: [{ member_openid: 'MEM_OPENID_1', nick: '群友1', role: 'member' }] } }
        if (req.path.endsWith('/restrict_chat_setting')) return { status: 200, data: {} }
        if (req.path.endsWith('/batch_remove_members')) {
          if (kickMode === '11253') return { status: 403, data: { code: 11253, message: 'forbidden kick' } }
          return { status: 200, data: {} }
        }
        return { status: 404, data: null }
      }),
    })
    return qqbotAdapter
  })
  await gw.sync()
  t.after(() => gw.stopAll())

  qqbotAdapter.platform.deliver('GROUP_AT_MESSAGE_CREATE', {
    id: 'm_cand_1',
    author: { member_openid: 'MEM_OPENID_1', member_role: 'member' },
    content: 'hi bot',
    group_openid: 'OPENID_ADMIN',
    timestamp: '2026-11-18T12:00:00+08:00',
  })

  const groupRoles = createGroupRoles({ onebot: fakeOnebot, getGateway: () => gw, getConfig: () => cfg, dataDir: (...p) => join(dir, ...p), log: silent })
  let ownerAll = true
  const tools = []
  const contexts = []
  const routes = new Map()
  groupAdminDef.setup({
    core: {
      hub: { turnSendersAllOwner: () => ownerAll, groupName: async (g) => String(g) },
      onebot: fakeOnebot,
      groupRoles,
      gateway: gw,
      identity,
      http: { body: async (req) => req?.body || {}, query: (req) => req?.query || {} },
    },
    config: () => cfg,
    tool: (fn) => tools.push(...[fn({ chat: { chatId: 'qqbot:group:OPENID_ADMIN', kind: 'group', groupId: 'OPENID_ADMIN', platform: 'qqbot' }, level: 'social', sessionId: 's_bot' })].flat().filter(Boolean)),
    context: (fn) => contexts.push(fn),
    route: (path, handler) => routes.set(path, handler),
  })

  const adminTool = tools.find((x) => x.name === 'qq_group_admin')
  assert.ok(adminTool)

  // 1) ban / unban / kick 走 QQBot 接口；且不允许传纯数字 QQ 号
  const numericReject = await adminTool.execute({ action: 'ban', user_id: '12345678', minutes: 5 })
  assert.equal(numericReject.ok, false)
  assert.match(numericReject.message, /member_openid/)

  const banOwnerReject = await adminTool.execute({ action: 'ban', user_id: 'OWNER_OPENID', minutes: 5 })
  assert.equal(banOwnerReject.ok, false)
  assert.match(banOwnerReject.message, /主人/)

  const banOk = await adminTool.execute({ action: 'ban', member_openid: 'MEM_OPENID_1', minutes: 5 })
  assert.equal(banOk.ok, true, banOk.message)
  assert.ok(apiCalls.some((c) => c.path === '/v2/groups/OPENID_ADMIN/restrict_chat_setting' && c.body?.members?.[0]?.op === 'add'))
  assert.equal(onebotCalls.length, 0)

  // context 能拿到已缓存的真实 QQBot 管理员身份，且明确指出不支持公告/头衔
  const ctxText = contexts.map((fn) => fn({ chat: { chatId: 'qqbot:group:OPENID_ADMIN', kind: 'group', groupId: 'OPENID_ADMIN', platform: 'qqbot' } })).join('\n')
  assert.match(ctxText, /管理员/)
  assert.match(ctxText, /member_openid/)

  const unbanOk = await adminTool.execute({ action: 'unban', user_id: 'MEM_OPENID_1' })
  assert.equal(unbanOk.ok, true)

  // 非主人拒绝
  ownerAll = false
  const deniedNonOwner = await adminTool.execute({ action: 'kick', user_id: 'MEM_OPENID_1' })
  assert.equal(deniedNonOwner.ok, false)
  assert.match(deniedNonOwner.message, /只有主人/)
  ownerAll = true

  // 2) 不支持的动作（whole_ban / title / notice）直接拒绝
  for (const unsupported of ['whole_ban', 'whole_unban', 'title', 'notice']) {
    const res = await adminTool.execute({ action: unsupported, text: '测试' })
    assert.equal(res.ok, false)
    assert.match(res.message, /不支持/)
  }

  // 3) kick：先成功，再测试 11253、再测试降为 member 时实时重查拒绝
  const kickOk = await adminTool.execute({ action: 'kick', user_id: 'MEM_OPENID_1' })
  assert.equal(kickOk.ok, true)

  kickMode = '11253'
  const kick11253 = await adminTool.execute({ action: 'kick', user_id: 'MEM_OPENID_1' })
  assert.equal(kick11253.ok, false)
  assert.match(kick11253.message, /11253/)

  botRole = 'member'
  const demoted = await adminTool.execute({ action: 'ban', user_id: 'MEM_OPENID_1', minutes: 5 })
  assert.equal(demoted.ok, false)
  assert.match(demoted.message, /普通成员/)

  // 4) 传统 OneBot 群仍旧照常执行
  const obTools = []
  groupAdminDef.setup({
    core: {
      hub: { turnSendersAllOwner: () => true, groupName: async () => '老QQ群' },
      onebot: fakeOnebot,
      groupRoles,
      gateway: gw,
      identity,
      http: { body: async (req) => req?.body || {}, query: (req) => req?.query || {} },
    },
    config: () => cfg,
    tool: (fn) => obTools.push(...[fn({ chat: { chatId: 'qq:group:555', kind: 'group', groupId: '555', platform: 'qq' }, level: 'social', sessionId: 's_ob' })].flat().filter(Boolean)),
    context: () => {},
    route: () => {},
  })
  const obRes = await obTools[0].execute({ action: 'ban', user_id: '999', minutes: 2 })
  assert.equal(obRes.ok, true)
  assert.ok(onebotCalls.some((c) => c.action === 'set_group_ban' && c.params.group_id === 555 && c.params.user_id === 999))

  // 5) HTTP 面板路由：/groups/roles /groups/qqbot/bind /groups/qqbot/unbind /groups/qqbot/members
  botRole = 'admin'
  const rolesRes = await routes.get('/groups/roles')()
  assert.equal(rolesRes.ok, true)
  assert.equal(rolesRes.qqbotInstances.length, 1)
  assert.equal(rolesRes.candidates[0]?.openid, 'OPENID_ADMIN')
  const qqbotRow = rolesRes.list.find((x) => x.groupOpenid === 'OPENID_ADMIN')
  assert.equal(qqbotRow.backendLabel, 'QQ 官方机器人')
  assert.equal(qqbotRow.name, '正式官方群')

  const bindRes = await routes.get('/groups/qqbot/bind')({ body: { openid: 'OPENID_ADMIN', alias: '555666' } })
  assert.equal(bindRes.ok, true)
  assert.equal(bindRes.binding.name, '正式官方群')

  const membersRes = await routes.get('/groups/qqbot/members')({ query: { openid: 'OPENID_ADMIN' } })
  assert.equal(membersRes.ok, true)
  assert.equal(membersRes.list[0].openid, 'MEM_OPENID_1')

  const unbindRes = await routes.get('/groups/qqbot/unbind')({ body: { openid: 'OPENID_ADMIN' } })
  assert.equal(unbindRes.ok, true)

  // 6) client/client.js 面板契约
  const clientCode = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.match(clientCode, /接入方式/)
  assert.match(clientCode, /QQ 官方机器人群绑定/)
  assert.match(clientCode, /group_openid/)
  assert.match(clientCode, /member_openid/)
})

test('宿主机 HTTP 全链路：纯 QQBot 安装 group-admin 后正确挂载 STABLE_ROUTES、/groups/roles 返回未绑定引导，bind/unbind 生效', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-qqbot-host-'))
  const wsDir = join(dir, 'ws')
  mkdirSync(wsDir, { recursive: true })
  mkdirSync(join(dir, 'modules', 'group-admin'), { recursive: true })
  // 直接整文件复制为本地自定义模块，验证无需社区库包装即可经 globalThis.aurabot.lib 运行
  writeFileSync(
    join(dir, 'modules', 'group-admin', 'index.mjs'),
    readFileSync(new URL('../src/modules/group-admin/index.js', import.meta.url), 'utf8'),
  )
  const prevDir = process.env.AURABOT_DATA_DIR
  const prevWs = process.env.AURABOT_WORKSPACE
  const prevGlobal = globalThis.aurabot
  process.env.AURABOT_DATA_DIR = dir
  process.env.AURABOT_WORKSPACE = wsDir
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    enabled: false,
    dryRun: false,
    setupDone: true,
    allow: { groups: ['99887766'], private: ['qqbot:private:OWNER_1'] },
    platforms: { qq: { enabled: false }, qqbot: { enabled: true, appId: 'app1', clientSecret: 'sec1', transport: 'webhook', botSecret: 'c'.repeat(32) } },
  }))
  const fake = createFakeDsh({ brain: async () => 'ok' })
  const host = await import('../src/host.js')
  const app = host.apply(fake.ctx)
  t.after(async () => {
    fake.dispose()
    await app.gateway?.stopAll?.()
    if (prevDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prevDir
    if (prevWs === undefined) delete process.env.AURABOT_WORKSPACE
    else process.env.AURABOT_WORKSPACE = prevWs
    if (prevGlobal === undefined) delete globalThis.aurabot
    else globalThis.aurabot = prevGlobal
  })
  await app.ready

  const roles = (await fake.call('/groups/roles')).json()
  assert.equal(roles.ok, true)
  assert.equal(roles.list.length, 1)
  assert.equal(roles.list[0].backendLabel, '未绑定 QQ 官方群')
  assert.equal(roles.list[0].reason, '先去绑定群')
  assert.equal(roles.list[0].label, '查不到')

  // 真实 HTTP POST 走 http.body + STABLE_ROUTES：bind 后别名指向官方群，unbind 后回到未绑定
  const bindHttp = (await fake.call('/groups/qqbot/bind', { instance: 'qqbot', openid: 'OPENID_HTTP_1', alias: '99887766', name: 'HTTP绑定群' })).json()
  assert.equal(bindHttp.ok, true)
  assert.equal(bindHttp.binding.name, 'HTTP绑定群')
  const boundRoles = (await fake.call('/groups/roles')).json()
  assert.equal(boundRoles.ok, true)
  const boundRow = boundRoles.list.find((x) => x.groupId === '99887766')
  assert.equal(boundRow?.backendLabel, 'QQ 官方机器人')
  assert.equal(boundRow?.groupOpenid, 'OPENID_HTTP_1')

  const unbindHttp = (await fake.call('/groups/qqbot/unbind', { chatId: 'qqbot:group:OPENID_HTTP_1' })).json()
  assert.equal(unbindHttp.ok, true)
  const afterUnbind = (await fake.call('/groups/roles')).json()
  assert.equal(afterUnbind.list.find((x) => x.groupId === '99887766')?.reason, '先去绑定群')
})

test('group-admin 审查加固：P1 拒绝 qq#2 串台退回 onebot；P2-5 /groups/roles 自动回填并持久化群名', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-ga-p1p25-'))
  const { default: groupAdminMod } = await import('../src/modules/group-admin/index.js')
  const { normalize } = await import('../src/core/config.js')
  const cfg = normalize({
    enabled: true,
    dryRun: false,
    ownerQQ: '10000001',
    allow: { private: ['10000001'], groups: ['900100'] },
    platforms: { qqbot: { enabled: true }, 'qq#2': { enabled: true } },
  })
  cfg.platforms = { qqbot: { enabled: true }, 'qq#2': { enabled: true } }

  let obCalls = 0
  const ob = {
    state: 'connected',
    async call(action, params) {
      obCalls++
      return { action, params }
    },
  }
  let getGroupInfoCalls = 0
  const qqbotGa = {
    supportedActions: { ban: true, unban: true, kick: true },
    async getBotState(openid) { return { role: 'admin', groupOpenid: openid, memberOpenid: 'bot_1' } },
    async getGroupInfo(openid) {
      getGroupInfoCalls++
      return { groupOpenid: openid, name: '自动回填官方群名', memberCount: 42 }
    },
  }
  const gw = {
    instances: () => [
      { instance: 'qqbot', platform: 'qqbot', enabled: true, state: 'connected' },
      { instance: 'qq#2', platform: 'qq', enabled: true, state: 'connected' },
    ],
    groupAdmin: (inst) => (inst === 'qqbot' ? qqbotGa : null),
  }

  const roles = createGroupRoles({
    onebot: ob,
    getGateway: () => gw,
    getConfig: () => cfg,
    dataDir: (...p) => join(dir, ...p),
    log: silent,
  })
  roles.saveBinding({ instance: 'qqbot', openid: 'OPENID_BACKFILL', alias: '900100', name: '' })

  const routes = new Map()
  const toolBuilders = []
  const mockApi = {
    id: 'group-admin',
    log: silent,
    config: () => cfg,
    defineTool: (spec) => spec,
    tool: (fn) => { toolBuilders.push(fn); return () => {} },
    context: () => () => {},
    rule: () => () => {},
    command: () => () => {},
    on: () => () => {},
    emit() {},
    onDispose: () => () => {},
    use: () => null,
    lazy: () => ({}),
    has: () => false,
    platformOf: () => '',
    caps: () => null,
    features: () => ({}),
    can: () => false,
    route: (path, handler) => { routes.set(path, handler); return () => {} },
    core: {
      groupRoles: roles,
      onebot: ob,
      gateway: gw,
      hub: {
        chats: () => [],
        sessions: () => [{ chatId: 'qqbot:group:OPENID_BACKFILL', title: '' }],
        groupName: () => '',
        turnSendersAllOwner: () => true,
      },
      http: {
        body: async (req) => req?.body || {},
        query: (req) => req?.query || {},
        send() {},
      },
      getConfig: () => cfg,
    },
  }

  const prevGlobal = globalThis.aurabot
  globalThis.aurabot = undefined
  t.after(() => {
    if (prevGlobal === undefined) delete globalThis.aurabot
    else globalThis.aurabot = prevGlobal
  })

  groupAdminMod.setup(mockApi)
  assert.ok(routes.has('/groups/roles'))
  assert.ok(toolBuilders.length >= 1)

  // P1: 非默认 qq#2 实例在 group-admin 工具层也禁止回落 legacy onebot
  const BuiltTools = toolBuilders.flatMap((b) => {
    const res = typeof b === 'function' ? b({ chat: { kind: 'private', chatId: 'qq:private:10000001' }, level: 'full', sessionId: 's1' }) : b
    return Array.isArray(res) ? res : (res ? [res] : [])
  })
  const adminTool = BuiltTools.find((x) => x?.name === 'qq_group_admin')
  assert.ok(adminTool, '应注册 qq_group_admin 工具')
  const qq2Exec = await adminTool.execute({ action: 'ban', group_id: 'qq#2:group:777', user_id: '12345' })
  assert.equal(qq2Exec.ok, false)
  assert.equal(obCalls, 0, 'qq#2 执行群管时绝不能回退打到默认 OneBot')

  // P2-5: 无名称绑定的 QQ 官方群查询 /groups/roles 时自动通过 getGroupInfo 回填并持久化
  const rolesResp = await routes.get('/groups/roles')({ query: { fresh: '1' } })
  assert.equal(rolesResp.ok, true)
  const row = rolesResp.list.find((x) => x.groupOpenid === 'OPENID_BACKFILL')
  assert.ok(row, '/groups/roles 应返回已绑定群')
  assert.equal(row.name, '自动回填官方群名')
  assert.ok(getGroupInfoCalls >= 1)
  const rolesReload = createGroupRoles({
    onebot: ob,
    getGateway: () => gw,
    getConfig: () => cfg,
    dataDir: (...p) => join(dir, ...p),
    log: silent,
  })
  assert.equal(rolesReload.bindings()[0].name, '自动回填官方群名', '回填的群名应持久化到 qqbot-groups.json')
})
