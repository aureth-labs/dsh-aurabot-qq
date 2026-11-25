// P3 验收回归：主账号控制面（GET /platforms/people、POST /platforms/owner/primary、/platforms/people/fixed 非主人限制、/save 一致性、重启持久化、/test-send、api.ownerRoute、前端 TAB_KEYS/GlobalAccess/Platforms）。
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Script } from 'node:vm'

const tempDirs = []
function freshDataDir(prefix = 'aurabot-p3-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  process.env.AURABOT_DATA_DIR = dir
  return dir
}

let hostMod
let normalize
let createIdentity
let createModules
let createFakeDsh
let makeFakeAdapter
let makeTestIdentity

before(async () => {
  freshDataDir('aurabot-p3-boot-')
  hostMod = await import('../src/host.js')
  ;({ normalize } = await import('../src/core/config.js'))
  ;({ createIdentity } = await import('../src/gateway/identity.js'))
  ;({ createModules } = await import('../src/core/modules.js'))
  ;({ createFakeDsh } = await import('./helpers/fake-dsh.js'))
  ;({ makeFakeAdapter } = await import('./helpers/fake-adapter.js'))
  ;({ makeTestIdentity } = await import('./helpers/identity.js'))
})

beforeEach(() => {
  freshDataDir('aurabot-p3-case-')
})

async function startHost(t, { dataDir = process.env.AURABOT_DATA_DIR, seedConfig, seedOwnerAccounts = [], configureDsh, configureBridgeAdapter } = {}) {
  process.env.AURABOT_DATA_DIR = dataDir
  const seedId = createIdentity({ dataDir: join(dataDir, 'gateway'), log: { info() {}, warn() {}, debug() {} } })
  const ownerPerson = seedId.claimOwner('qq', '10001')
  for (const [plat, acc] of seedOwnerAccounts) {
    seedId.link(plat, acc, ownerPerson, 'manual')
  }

  const cfgObj = normalize({
    enabled: true,
    dryRun: false,
    ownerQQ: '10001',
    snowluma: { autoStart: false },
    merge: { enabled: false },
    allow: { private: [], groups: [] },
    platforms: {
      bridge: { enabled: true },
      'bridge#2': { enabled: true },
      feishu: { enabled: true, caps: { proactive: 'none' } },
    },
    ...(seedConfig || {}),
  })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify(cfgObj), 'utf8')

  const fake = createFakeDsh({ brain: async () => '好的' })
  configureDsh?.(fake.ctx)
  const applied = hostMod.apply(fake.ctx)
  t.after(async () => {
    try { await applied.gateway?.stopAll?.() } catch {}
    try { applied.modules?.dispose?.() } catch {}
    try { applied.onebot?.disconnect?.() } catch {}
    try { fake.dispose() } catch {}
  })

  const adapters = new Map()
  if (applied.gateway) {
    applied.gateway.register(() => {
      const adapter = makeFakeAdapter({ id: 'bridge', name: 'Bridge' })
      const origStart = adapter.start
      adapter.start = async (ctx) => {
        adapters.set(ctx.instance, adapter)
        configureBridgeAdapter?.(ctx.instance, adapter)
        return origStart(ctx)
      }
      return adapter
    })
    applied.gateway.register(() => {
      const adapter = makeFakeAdapter({ id: 'feishu', name: '飞书', caps: { proactive: 'none' } })
      const origStart = adapter.start
      adapter.start = async (ctx) => { adapters.set(ctx.instance, adapter); return origStart(ctx) }
      return adapter
    })
    await applied.gateway.sync()
  }
  await applied.ready

  return { fake, applied, adapters, ownerPerson }
}

test('共享私聊接口拒绝以旧版直连 QQ 为主账号，已启用的旧配置仍可关闭', async (t) => {
  const { fake, applied } = await startHost(t, {
    seedConfig: {
      ownerPrimary: { mode: 'fixed', platform: 'qq', instance: 'qq', account: '10001' },
      platforms: { bridge: { enabled: true } },
    },
    configureDsh(ctx) {
      ctx.services.sessionController.fork = async () => { throw new Error('测试只使用面板接口') }
      ctx.services.sessionProjections = {}
    },
  })
  const path = '/platforms/multi-private'
  assert.ok(applied.gateway, '即使其他平台已接入网关也要拒绝旧版直连主账号')
  const status = (await fake.call(path)).json()
  assert.equal(status.available, false)
  assert.equal(status.reason, 'gateway-required')
  const refused = (await fake.call(path, { enabled: true })).json()
  assert.equal(refused.ok, false)
  assert.equal(refused.reason, 'gateway-required')
  assert.match(refused.message, /旧版直连 QQ/)
  assert.equal(applied.getConfig().multiPlatformPrivateSession, false)

  applied.setConfig({ ...applied.getConfig(), multiPlatformPrivateSession: true })
  const existing = (await fake.call(path)).json()
  assert.equal(existing.enabled, true)
  assert.equal(existing.available, false)
  assert.equal((await fake.call(path, { enabled: false })).json().ok, true)
  assert.equal(applied.getConfig().multiPlatformPrivateSession, false)

  const config = applied.getConfig()
  applied.setConfig({ ...config, platforms: { ...config.platforms, 'qq#2': { enabled: false } } })
  const { instances } = (await fake.call('/platforms')).json()
  assert.ok(instances.some(item => item.instance === 'qq' && item.legacy))
  assert.ok(instances.some(item => item.instance === 'qq#2' && !item.legacy))
})

test('共享私聊接口确认旧历史后收起入口，授权轮换后拒绝继承', async (t) => {
  const cwd = process.env.AURABOT_DATA_DIR
  const sessionsFile = join(cwd, 'sessions.json')
  const sessionId = 'bridge-old-owner-session'
  const { fake, applied, ownerPerson } = await startHost(t, {
    seedOwnerAccounts: [['bridge', 'b_owner']],
    seedConfig: {
      workspaceDir: cwd, ownerLevel: 'social', multiPlatformPrivateSession: true,
      ownerPrimary: { mode: 'fixed', platform: 'bridge', instance: 'bridge', account: 'b_owner' },
      platforms: { bridge: { enabled: true } },
    },
    configureDsh(ctx) {
      ctx.services.sessionController.fork = async () => { throw new Error('测试只使用面板接口') }
      ctx.services.sessionProjections = {}
      ctx.services.sessionQuery = {
        async observeSession(id) {
          assert.equal(id, sessionId)
          return {
            header: { id, cwd },
            events: [{ seq: 0, type: 'turn/end', data: { reason: { kind: 'completed' } } }],
          }
        },
      }
    },
  })
  writeFileSync(sessionsFile, JSON.stringify({
    chats: { 'bridge:private:b_owner': { sessionId, level: 'social', preset: 'aurabot-social' } },
  }))

  const path = '/platforms/multi-private'
  const status = async () => (await fake.call(path)).json()
  assert.equal((await status()).legacyHistoryAvailable, true)
  const prepared = (await fake.call(path + '/legacy/prepare', { mode: 'live' })).json()
  assert.equal(prepared.ok, true, prepared.message)
  const confirmed = (await fake.call(path + '/legacy/confirm', { mode: 'live', token: prepared.token, confirmed: true })).json()
  assert.equal(confirmed.ok, true, confirmed.message)
  assert.equal(confirmed.legacyHistoryAvailable, false)

  const config = applied.getConfig()
  const oldRevision = config.ownerAuthorization.revision
  const changed = applied.setConfig({ ...config, ownerQQ: '' })
  assert.equal(changed.ownerPersonId, ownerPerson)
  assert.notEqual(changed.ownerAuthorization.revision, oldRevision)
  const blocked = await status()
  assert.equal(blocked.available, true)
  assert.equal(blocked.sourceAuthorizationChanged, true)
  assert.equal(blocked.legacyHistoryAvailable, false)
  const beforeInherit = readFileSync(sessionsFile, 'utf8')
  const inherit = (await fake.call(path + '/inherit', { mode: 'live' })).json()
  assert.equal(inherit.ok, false)
  assert.match(inherit.message, /主人授权已变化/)
  assert.equal(readFileSync(sessionsFile, 'utf8'), beforeInherit)
})

test('P3-1: api.ownerRoute() 暴露结构化主账号路由，blocked/no-route 时绝不穿透 QQ', async (t) => {
  const dir = freshDataDir('aurabot-p3-mod-')
  const identity = makeTestIdentity('10001', 'qq', { personId: 'owner-mod' })
  identity.setOwner('b_two', 'bridge', 'owner-mod')
  let routeState = {
    chatId: 'bridge#2:private:b_two',
    blocked: false,
    reason: 'ok',
    target: { platform: 'bridge', instance: 'bridge#2', account: 'b_two' },
    fallbackUsed: false,
  }
  let capturedApi = null
  const mods = createModules({
    ctx: {},
    core: {
      identity,
      resolveOwnerRoute: () => routeState,
      routeOwner: () => 'private:10001',
      hub: { ownerChat: () => 'private:10001', sendText: async () => ({ message_id: 'm1' }) },
      onebot: { call: async () => null },
      ask: async () => '',
    },
    getConfig: () => normalize({ ownerQQ: '10001' }),
    setConfig: () => {},
    logger: { child: () => ({ info() {}, warn() {}, debug() {}, error() {} }) },
    version: 'test',
    builtins: [{ id: 'p3-probe', name: 'p3-probe', platforms: ['*'], setup(api) { capturedApi = api; return {} } }],
  })
  t.after(() => mods.dispose())
  await mods.boot()
  assert.ok(dir)
  assert.deepEqual(capturedApi.ownerRoute(), routeState)
  assert.equal(capturedApi.ownerChat(), 'bridge#2:private:b_two')

  routeState = {
    chatId: '',
    blocked: true,
    reason: 'primary-offline',
    target: { platform: 'bridge', instance: 'bridge#2', account: 'b_two' },
    fallbackUsed: false,
  }
  assert.deepEqual(capturedApi.ownerRoute(), routeState)
  assert.equal(capturedApi.ownerChat(), '', 'blocked 时 ownerChat 返回空串不回退 QQ')

  routeState = { chatId: '', blocked: false, reason: 'no-route', target: null, fallbackUsed: false }
  assert.deepEqual(capturedApi.ownerRoute(), { chatId: '', blocked: false, reason: 'no-route', target: null, fallbackUsed: false })
  assert.equal(capturedApi.ownerChat(), '')
})

test('P3-2: GET /platforms/people 展开多实例选项、标注 proactive=none 禁用态且纯只读不误记阻塞态', async (t) => {
  const { fake, applied, adapters } = await startHost(t, {
    seedOwnerAccounts: [['bridge', 'b_acc'], ['feishu', 'ou_nop'], ['qqbot', 'qb_noinst']],
    seedConfig: {
      ownerPrimary: { mode: 'fixed', platform: 'bridge', instance: 'bridge#2', account: 'b_acc', fallback: false, noticeFallback: true },
    },
  })

  // 先让 b_acc 在 bridge#2 上入站，验证多实例下未观测实例 bridge 与无实例平台 qqbot 在 ownerAccountOptions 中均禁用（selectable=false）
  adapters.get('bridge#2').pushInbound({
    chat: { kind: 'private', id: 'b_acc' },
    sender: { account: 'b_acc', name: '主人2' },
    parts: [{ type: 'text', text: '在线2' }],
  })
  const pBeforeObs = (await fake.call('/platforms/people')).json()
  const preB1 = (pBeforeObs.ownerAccountOptions || []).find((o) => o.platform === 'bridge' && o.instance === 'bridge' && o.account === 'b_acc')
  const preB2 = (pBeforeObs.ownerAccountOptions || []).find((o) => o.platform === 'bridge' && o.instance === 'bridge#2' && o.account === 'b_acc')
  const preNoInst = (pBeforeObs.ownerAccountOptions || []).find((o) => o.platform === 'qqbot' && o.account === 'qb_noinst')
  assert.equal(preB1?.observed, false)
  assert.equal(preB1?.selectable, false, '多实例未在该实例观测到的账号必须标为不可选')
  assert.equal(preB2?.observed, true)
  assert.equal(preB2?.selectable, true)
  assert.equal(preNoInst?.hasInstance, false)
  assert.equal(preNoInst?.selectable, false, '没有配置平台实例的主账号选项必须标为不可选')

  // 再让 b_acc 在 bridge 上也入站，建立双实例观测归属，以便断线回退测试
  adapters.get('bridge').pushInbound({
    chat: { kind: 'private', id: 'b_acc' },
    sender: { account: 'b_acc', name: '主人1' },
    parts: [{ type: 'text', text: '在线1' }],
  })

  // 断掉 bridge#2，验证只读轮询 /platforms/people 不污染 lastBlockedRoute，且不产生 router.json 写副作用
  adapters.get('bridge#2').disconnect()
  const routerFile = join(process.env.AURABOT_DATA_DIR, 'gateway', 'router.json')
  const beforeRouter = existsSync(routerFile) ? readFileSync(routerFile, 'utf8') : ''

  const p1 = (await fake.call('/platforms/people')).json()
  assert.equal(p1.ok, true)
  assert.equal(p1.ownerPrimary.instance, 'bridge#2')
  assert.equal(p1.resolvedProactiveRoute.blocked, true)
  assert.equal(p1.resolvedProactiveRoute.reason, 'primary-offline')
  assert.equal(p1.resolvedNoticeRoute.blocked, false, 'noticeFallback=true 时 notice 路由允许回退到在线 bridge')
  assert.equal(p1.resolvedNoticeRoute.fallbackUsed, true)
  assert.equal(p1.lastBlockedRoute, null, '纯面板只读查看不应伪造运行期 lastBlockedRoute')

  const opts = p1.ownerAccountOptions || []
  const b1 = opts.find((o) => o.platform === 'bridge' && o.instance === 'bridge' && o.account === 'b_acc')
  const b2 = opts.find((o) => o.platform === 'bridge' && o.instance === 'bridge#2' && o.account === 'b_acc')
  const fsNop = opts.find((o) => o.platform === 'feishu' && o.account === 'ou_nop')
  const qqLegacy = opts.find((o) => o.platform === 'qq' && o.account === '10001')
  assert.ok(b1 && b2, '多实例 bridge 与 bridge#2 均应出现在 ownerAccountOptions 中')
  assert.equal(b1.multiInstance, true)
  assert.equal(b2.multiInstance, true)
  assert.equal(b2.state, 'disconnected')
  assert.equal(fsNop?.canProactive, false, 'caps.proactive=none 的实例应标为不可设为主账号')
  assert.equal(qqLegacy?.legacy, true)

  // 运行期真实调用 resolveOwnerRoute 才记入 lastBlockedRoute
  const rt = applied.resolveOwnerRoute({ purpose: 'proactive' })
  assert.equal(rt.blocked, true)
  const p2 = (await fake.call('/platforms/people')).json()
  assert.equal(p2.lastBlockedRoute?.reason, 'primary-offline')
  const afterRouter = existsSync(routerFile) ? readFileSync(routerFile, 'utf8') : ''
  assert.equal(afterRouter, beforeRouter, 'GET /platforms/people 与 resolveOwnerRoute 不得写 router.json')
})

test('P3-3: /platforms/people/fixed 仅非主人；/platforms/owner/primary 与 /save 一致清理 router.fixed 且重启持久化', async (t) => {
  const dirA = freshDataDir('aurabot-p3-consistency-a-')
  const hostA = await startHost(t, {
    dataDir: dirA,
    seedOwnerAccounts: [['bridge', 'b_acc'], ['feishu', 'ou_nop']],
  })
  hostA.adapters.get('bridge#2').pushInbound({
    chat: { kind: 'private', id: 'b_acc' },
    sender: { account: 'b_acc', name: '主人' },
    parts: [{ type: 'text', text: 'hi' }],
  })
  // 预写入历史 router.fixed[owner]，以及一个非主人访客
  hostA.applied.gateway.routing.setFixed(hostA.ownerPerson, 'qq')
  const guestPerson = hostA.applied.gateway.identity.resolve('bridge', 'guest_9')
  hostA.applied.memory.add({ text: '访客小王', about: guestPerson, aboutName: '小王', source: 'panel' })

  // 1) /platforms/people/fixed 禁止修改主人，正常放行非主人
  const ownerFixRes = (await hostA.fake.call('/platforms/people/fixed', { person: hostA.ownerPerson, platform: 'bridge' })).json()
  assert.equal(ownerFixRes.ok, false)
  assert.match(ownerFixRes.message, /权限 → 主人/)
  assert.equal(hostA.applied.gateway.routing.fixedPlatform(hostA.ownerPerson), 'qq', '拒绝后原有残留暂保持，不走旁路改写')

  const guestFixRes = (await hostA.fake.call('/platforms/people/fixed', { person: guestPerson, platform: 'bridge' })).json()
  assert.equal(guestFixRes.ok, true)
  assert.equal(hostA.applied.gateway.routing.fixedPlatform(guestPerson), 'bridge')

  // 2) /platforms/owner/primary 拒绝 caps.proactive=none 实例、不存在平台/实例、他人账号、以及未观测多实例账号
  const rejectNone = (await hostA.fake.call('/platforms/owner/primary', { mode: 'fixed', platform: 'feishu', instance: 'feishu', account: 'ou_nop' })).json()
  assert.equal(rejectNone.ok, false)
  assert.match(rejectNone.message, /仅支持回复/)

  const rejectNoneNoInst = (await hostA.fake.call('/platforms/owner/primary', { mode: 'fixed', platform: 'feishu', account: 'ou_nop' })).json()
  assert.equal(rejectNoneNoInst.ok, false)
  assert.match(rejectNoneNoInst.message, /仅支持回复/)

  const rejectMissingInst = (await hostA.fake.call('/platforms/owner/primary', { mode: 'fixed', platform: 'bridge', instance: 'bridge#99', account: 'b_acc' })).json()
  assert.equal(rejectMissingInst.ok, false)

  const rejectForeignAcc = (await hostA.fake.call('/platforms/owner/primary', { mode: 'fixed', platform: 'bridge', instance: 'bridge#2', account: 'stranger_999' })).json()
  assert.equal(rejectForeignAcc.ok, false)
  assert.match(rejectForeignAcc.message, /未绑定在当前主人名下/)

  const rejectUnobserved = (await hostA.fake.call('/platforms/owner/primary', { mode: 'fixed', platform: 'bridge', instance: 'bridge', account: 'b_acc' })).json()
  assert.equal(rejectUnobserved.ok, false)
  assert.match(rejectUnobserved.message, /尚未在实例「bridge」观测到/)

  const rejectNoInstance = (await hostA.fake.call('/platforms/owner/primary', { mode: 'fixed', platform: 'qqbot', instance: 'qqbot', account: 'qb_noinst' })).json()
  assert.equal(rejectNoInstance.ok, false)
  assert.match(rejectNoInstance.message, /找不到平台实例/)

  // 3) 通过 POST /platforms/owner/primary 设置并对比另一套干净实例上的 POST /save
  const primaryPatch = { mode: 'fixed', platform: 'bridge', instance: 'bridge#2', account: 'b_acc', fallback: false, noticeFallback: true, fallbackOrder: [] }
  const setByPrimary = (await hostA.fake.call('/platforms/owner/primary', primaryPatch)).json()
  assert.equal(setByPrimary.ok, true)
  assert.deepEqual(setByPrimary.ownerPrimary, primaryPatch)
  assert.ok(!hostA.applied.gateway.routing.fixedPlatform(hostA.ownerPerson), 'router.fixed[owner] 应在切换后被幂等清空')

  const dirB = freshDataDir('aurabot-p3-consistency-b-')
  const hostB = await startHost(t, {
    dataDir: dirB,
    seedOwnerAccounts: [['bridge', 'b_acc'], ['feishu', 'ou_nop']],
  })
  hostB.adapters.get('bridge#2').pushInbound({
    chat: { kind: 'private', id: 'b_acc' },
    sender: { account: 'b_acc', name: '主人' },
    parts: [{ type: 'text', text: 'hi' }],
  })
  hostB.applied.gateway.routing.setFixed(hostB.ownerPerson, 'qq')
  const setBySave = (await hostB.fake.call('/save', { ownerPrimary: primaryPatch })).json()
  assert.equal(setBySave.ok, true)
  assert.deepEqual(setBySave.config.ownerPrimary, setByPrimary.ownerPrimary)
  assert.ok(!hostB.applied.gateway.routing.fixedPlatform(hostB.ownerPerson), '/save 也必须清理 router.fixed[owner]')

  // 4) 单字段清空 account='' 重新解析，以及切 recent 清空旧平台字段（两边一致）
  const clearAccA = (await hostA.fake.call('/platforms/owner/primary', { mode: 'fixed', platform: 'bridge', instance: 'bridge#2', account: '' })).json()
  const clearAccB = (await hostB.fake.call('/save', { ownerPrimary: { mode: 'fixed', platform: 'bridge', instance: 'bridge#2', account: '' } })).json()
  assert.deepEqual(clearAccA.ownerPrimary, clearAccB.config.ownerPrimary)
  assert.equal(clearAccA.ownerPrimary.account, '')
  assert.equal(clearAccA.resolvedProactiveRoute.chatId, 'bridge#2:private:b_acc')

  const recentA = (await hostA.fake.call('/platforms/owner/primary', { mode: 'recent' })).json()
  const recentB = (await hostB.fake.call('/save', { ownerPrimary: { mode: 'recent' } })).json()
  assert.deepEqual(recentA.ownerPrimary, { mode: 'recent', platform: '', instance: '', account: '', fallback: false, noticeFallback: true, fallbackOrder: [] })
  assert.deepEqual(recentA.ownerPrimary, recentB.config.ownerPrimary)

  // 5) 先切回 fixed bridge#2，再模拟宿主重启并校验持久化生效
  const savedFixed = (await hostA.fake.call('/platforms/owner/primary', primaryPatch)).json()
  assert.equal(savedFixed.ok, true)
  await hostA.applied.gateway.stopAll()
  hostA.applied.modules.dispose()
  hostA.fake.dispose()

  // 同一目录重启加载
  process.env.AURABOT_DATA_DIR = dirA
  const fake2 = createFakeDsh({ brain: async () => '好的' })
  const applied2 = hostMod.apply(fake2.ctx)
  t.after(async () => {
    try { await applied2.gateway?.stopAll?.() } catch {}
    try { applied2.modules?.dispose?.() } catch {}
    try { applied2.onebot?.disconnect?.() } catch {}
    try { fake2.dispose() } catch {}
  })
  const b2Again = []
  applied2.gateway.register(() => {
    const adapter = makeFakeAdapter({ id: 'bridge', name: 'Bridge' })
    const origStart = adapter.start
    adapter.start = async (ctx) => { if (ctx.instance === 'bridge#2') b2Again.push(adapter); return origStart(ctx) }
    return adapter
  })
  applied2.gateway.register(() => makeFakeAdapter({ id: 'feishu', name: '飞书', caps: { proactive: 'none' } }))
  await applied2.gateway.sync()
  await applied2.ready

  const reloadedPeople = (await fake2.call('/platforms/people')).json()
  assert.deepEqual(reloadedPeople.ownerPrimary, primaryPatch, '重启后 ownerPrimary 配置应从磁盘恢复')
  assert.equal(reloadedPeople.resolvedProactiveRoute.chatId, 'bridge#2:private:b_acc')
  assert.equal(applied2.resolveOwnerRoute({ purpose: 'proactive' }).chatId, 'bridge#2:private:b_acc')
  assert.equal(b2Again.length, 1)
})

test('P3-4: POST /test-send 遵循 noticeFallback 并在响应中返回目标与 fallbackUsed', async (t) => {
  const { fake, adapters } = await startHost(t, {
    seedOwnerAccounts: [['bridge', 'b_acc']],
    seedConfig: {
      ownerPrimary: { mode: 'fixed', platform: 'bridge', instance: 'bridge#2', account: 'b_acc', fallback: false, noticeFallback: false },
    },
  })
  adapters.get('bridge').pushInbound({
    chat: { kind: 'private', id: 'b_acc' },
    sender: { account: 'b_acc', name: '主人' },
    parts: [{ type: 'text', text: 'hello1' }],
  })
  adapters.get('bridge#2').pushInbound({
    chat: { kind: 'private', id: 'b_acc' },
    sender: { account: 'b_acc', name: '主人' },
    parts: [{ type: 'text', text: 'hello' }],
  })

  // 关闭 noticeFallback 且 bridge#2 离线 → /test-send 明确阻塞
  adapters.get('bridge#2').disconnect()
  const rBlocked = (await fake.call('/test-send', {})).json()
  assert.equal(rBlocked.ok, false)
  assert.equal(rBlocked.blocked, true)
  assert.equal(rBlocked.reason, 'primary-offline')

  // 打开 noticeFallback（保留 fallback=false），再测 /test-send → 经在线 bridge 实例回退发出
  const switched = (await fake.call('/platforms/owner/primary', { noticeFallback: true })).json()
  assert.equal(switched.ok, true)
  const rFallback = (await fake.call('/test-send', {})).json()
  assert.equal(rFallback.ok, true, JSON.stringify(rFallback))
  assert.equal(rFallback.fallbackUsed, true)
  assert.equal(rFallback.target?.platform, 'bridge')
  assert.ok(adapters.get('bridge').sent.some((x) => JSON.stringify(x.message.parts).includes('大肥鱼到此一游')))
})

test('P3-5: 前端 client.js 注册 TAB_KEYS.access、GlobalAccess 主账号与告警渲染及 Platforms 人卡片防双写', async () => {
  const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const marker = '    exports.apply = apply'
  assert.ok(source.includes(marker))
  const tapMarker = 'const TAB_KEYS = {'
  assert.ok(source.includes(tapMarker))

  const instrumented = source
    .replace(
      'return h(\'div\', { className: \'ab-root\' },',
      'exports.__tabKeys = TAB_KEYS;\n      return h(\'div\', { className: \'ab-root\' },',
    )
    .replace(
      marker,
      '    exports.panelTest = { GlobalAccess, Platforms, AurabotPage }\n' + marker,
    )

  const posted = []
  const fakeFetch = async (url, init) => {
    const parsedBody = init?.body ? JSON.parse(init.body) : {}
    if (init?.method === 'POST') posted.push({ url, body: parsedBody })
    if (url === '/aurabot/api/save') return { json: async () => ({ ok: true, config: parsedBody }) }
    return { json: async () => ({ ok: true }) }
  }
  const script = new Script(instrumented, { filename: 'client/client.js' })
  const storage = new Map()
  const localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) }
  let loader
  const winListeners = new Map()
  const addWinListener = (ev, fn) => {
    if (!winListeners.has(ev)) winListeners.set(ev, new Set())
    winListeners.get(ev).add(fn)
  }
  const removeWinListener = (ev, fn) => { winListeners.get(ev)?.delete(fn) }
  const dispatchWinEvent = (ev, data) => {
    for (const fn of [...(winListeners.get(ev) || [])]) fn(data)
  }
  script.runInNewContext({
    fetch: fakeFetch,
    localStorage,
    setTimeout() { return 0 },
    clearTimeout() {},
    window: {
      __ModuleLoader__: { load: (v) => { loader = v } },
      addEventListener: addWinListener,
      removeEventListener: removeWinListener,
    },
  })

  let hook = 0
  let state = []
  const refs = []
  let draftState = null
  const React = {
    Component: class {},
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (initial) => {
      const i = hook++
      if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial
      return [state[i], (val) => { state[i] = typeof val === 'function' ? val(state[i]) : val }]
    },
    useEffect() {},
    useRef: (initial) => {
      const i = hook++
      if (!(i in refs)) refs[i] = { current: initial }
      return refs[i]
    },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
  const vmExport = (() => {
    const exportsObj = loader.factory(() => React)
    return { ...loader, ...exportsObj }
  })()
  assert.ok(vmExport.panelTest)

  // 全局 fetch 给 post('/test-send') 用
  const origFetch = globalThis.fetch
  globalThis.fetch = fakeFetch
  try {
    // 1) 验证源码中的 TAB_KEYS.access 已纳入 ownerPrimary
    const tabKeysLine = source.split(/\r?\n/).find((l) => l.includes('const TAB_KEYS ='))
    assert.ok(tabKeysLine && tabKeysLine.includes("'ownerPrimary'"), 'TAB_KEYS.access 必须包含 ownerPrimary')

    // 2) GlobalAccess：主账号选择器、proactive=none 禁用、blocked 告警条、两个回退开关
    const cfg = {
      enabled: true,
      ownerQQ: '10001',
      ownerName: '主人',
      ownerLevel: 'full',
      ownerPrimary: { mode: 'fixed', platform: 'bridge', instance: 'bridge#2', account: 'b_acc', fallback: false, noticeFallback: true },
      notice: { enabled: true, approval: true, question: true },
      qqApi: { enabled: true },
      approvalViaQQ: true,
      longTasks: true,
      subagentBackground: false,
      profilePerms: {},
      platforms: {},
    }
    draftState = JSON.parse(JSON.stringify(cfg))
    hook = 0
    state = [
      {
        ok: true,
        ownerAccountOptions: [
          { key: 'qq:qq:10001', platform: 'qq', instance: 'qq', account: '10001', state: 'connected', enabled: true, canProactive: true, legacy: true, multiInstance: false },
          { key: 'bridge:bridge#2:b_acc', platform: 'bridge', instance: 'bridge#2', account: 'b_acc', state: 'disconnected', enabled: true, canProactive: true, multiInstance: true },
          { key: 'feishu:feishu:ou_nop', platform: 'feishu', instance: 'feishu', account: 'ou_nop', state: 'connected', enabled: true, canProactive: false, proactive: 'none', multiInstance: false },
        ],
        resolvedProactiveRoute: { chatId: '', blocked: true, reason: 'primary-offline', target: { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' }, fallbackUsed: false },
        resolvedNoticeRoute: { chatId: 'private:10001', blocked: false, reason: 'fallback-used', target: { platform: 'qq', instance: 'qq', account: '10001' }, fallbackUsed: true },
        lastBlockedRoute: null,
      },
      false,
      null,
    ]
    const tree = vmExport.panelTest.GlobalAccess({
      st: { config: cfg, modules: [], onebot: { state: 'connected' } },
      draft: draftState,
      setDraft: (d) => { draftState = d },
      toast() {},
    })

    const collectNodes = (node, pred, out = []) => {
      if (!node || typeof node !== 'object') return out
      if (Array.isArray(node)) { for (const x of node) collectNodes(x, pred, out); return out }
      if (pred(node)) out.push(node)
      if (node.children) collectNodes(node.children, pred, out)
      return out
    }
    const textOf = (node) => {
      if (node == null || node === false) return ''
      if (typeof node !== 'object') return String(node)
      if (Array.isArray(node)) return node.map(textOf).join('')
      return [node.props?.label, node.props?.hint, textOf(node.children)].filter(Boolean).join(' ')
    }
    const orderRows = (tree, attr) => collectNodes(tree, (n) => n.props?.[attr])

    const gaText = textOf(tree)
    assert.match(gaText, /主人的主账号与接收优先级/)
    assert.doesNotMatch(gaText, /大肥鱼主动消息接收账号/)
    assert.match(gaText, /这里管理的是主人的账号，不是她的账号/)
    assert.match(gaText, /开启时按「接收优先级」顺序改发/)
    assert.doesNotMatch(gaText, /大肥鱼的主账号/)
    assert.doesNotMatch(gaText, /当前固定主账号：/)
    assert.match(gaText, /主人 · QQ/)
    assert.match(gaText, /主人 · 飞书/)

    // 校验合并后的模式切换按钮与行内「设为主账号」按钮
    const modeDefaultBtn = collectNodes(tree, (n) => n.props && n.props['data-owner-mode'] === '__default__')[0]
    const modeRecentBtn = collectNodes(tree, (n) => n.props && n.props['data-owner-mode'] === '__recent__')[0]
    assert.ok(modeDefaultBtn && modeRecentBtn, '应渲染默认与 recent 模式切换按钮')
    const treeRows = collectNodes(tree, (n) => n.props && n.props['data-prio-key'])
    assert.equal(treeRows[0].props['data-prio-pinned'], 'true')
    assert.ok(collectNodes(treeRows[0], (n) => n.props?.className === 'ab-prio-pin' && collectNodes(n, (s) => s.type?.name === 'PinIcon').length > 0).length === 1, '固定首位行应使用 PinIcon SVG 置顶图标')
    const candidates = orderRows(tree, 'data-prio-excluded-key')
    const feishuRow0 = candidates.find((r) => r.props['data-prio-excluded-key'] === 'feishu\x00feishu\x00ou_nop')
    const feishuSetBtn = collectNodes(feishuRow0, (n) => n.type?.name === 'Btn' && textOf(n.children) === '设为主账号')[0]
    assert.equal(feishuSetBtn.props.disabled, true, '仅支持回复的实例必须禁用「设为主账号」')

    // 点击「QQ · 10001」行的「设为主账号」：切换为 QQ 并重置首位置顶预览状态
    const qqRow0 = candidates.find((r) => r.props['data-prio-excluded-key'] === 'qq\x00qq\x0010001')
    const qqSetBtn = collectNodes(qqRow0, (n) => n.type?.name === 'Btn' && textOf(n.children) === '设为主账号')[0]
    assert.ok(qqSetBtn && !qqSetBtn.props.disabled)
    qqSetBtn.props.onClick()
    assert.equal(draftState.ownerPrimary.mode, 'fixed')
    assert.equal(draftState.ownerPrimary.platform, 'qq')
    assert.equal(draftState.ownerPrimary.account, '10001')

    // 多实例未观测选项（observed:false, selectable:false）在列表行「设为主账号」中禁用
    hook = 0
    state = [
      {
        ok: true,
        ownerAccountOptions: [
          { key: 'bridge:bridge:b_acc', platform: 'bridge', instance: 'bridge', account: 'b_acc', state: 'connected', enabled: true, canProactive: true, multiInstance: true, hasInstance: true, observed: false, selectable: false },
          { key: 'bridge:bridge#2:b_acc', platform: 'bridge', instance: 'bridge#2', account: 'b_acc', state: 'connected', enabled: true, canProactive: true, multiInstance: true, hasInstance: true, observed: true, selectable: true },
          { key: 'qqbot:qqbot:qb_noinst', platform: 'qqbot', instance: 'qqbot', account: 'qb_noinst', state: 'stopped', enabled: false, canProactive: true, multiInstance: false, hasInstance: false, observed: false, selectable: false },
        ],
        resolvedProactiveRoute: { chatId: 'bridge#2:private:b_acc', blocked: false, reason: 'ok', target: { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' }, fallbackUsed: false },
        resolvedNoticeRoute: { chatId: 'bridge#2:private:b_acc', blocked: false, reason: 'ok', target: { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' }, fallbackUsed: false },
        lastBlockedRoute: null,
      },
      false,
      null,
    ]
    const treeMulti = vmExport.panelTest.GlobalAccess({
      st: { config: cfg, modules: [], onebot: { state: 'connected' } },
      draft: JSON.parse(JSON.stringify(cfg)),
      setDraft() {},
      toast() {},
    })
    const rowsMulti = orderRows(treeMulti, 'data-prio-excluded-key')
    const unobsRow = rowsMulti.find((r) => r.props['data-prio-excluded-key'] === 'bridge\x00bridge\x00b_acc')
    const noInstRow = rowsMulti.find((r) => r.props['data-prio-excluded-key'] === 'qqbot\x00qqbot\x00qb_noinst')
    assert.equal(collectNodes(unobsRow, (n) => n.type?.name === 'Btn' && textOf(n.children) === '设为主账号')[0].props.disabled, true)
    assert.equal(collectNodes(noInstRow, (n) => n.type?.name === 'Btn' && textOf(n.children) === '设为主账号')[0].props.disabled, true)

    // 恢复 GlobalAccess 原始 tree 状态供下方按钮/开关测试使用
    hook = 0
    state = [
      {
        ok: true,
        ownerAccountOptions: [
          { key: 'qq:qq:10001', platform: 'qq', instance: 'qq', account: '10001', state: 'connected', enabled: true, canProactive: true, legacy: true, multiInstance: false },
          { key: 'bridge:bridge#2:b_acc', platform: 'bridge', instance: 'bridge#2', account: 'b_acc', state: 'disconnected', enabled: true, canProactive: true, multiInstance: true },
          { key: 'feishu:feishu:ou_nop', platform: 'feishu', instance: 'feishu', account: 'ou_nop', state: 'connected', enabled: true, canProactive: false, proactive: 'none', multiInstance: false },
        ],
        resolvedProactiveRoute: { chatId: '', blocked: true, reason: 'primary-offline', target: { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' }, fallbackUsed: false },
        resolvedNoticeRoute: { chatId: 'private:10001', blocked: false, reason: 'fallback-used', target: { platform: 'qq', instance: 'qq', account: '10001' }, fallbackUsed: true },
        lastBlockedRoute: null,
      },
      false,
      null,
    ]
    draftState = JSON.parse(JSON.stringify(cfg))
    vmExport.panelTest.GlobalAccess({
      st: { config: cfg, modules: [], onebot: { state: 'connected' } },
      draft: draftState,
      setDraft: (d) => { draftState = d },
      toast() {},
    })

    // 点击「跟随最近私聊平台（recent）」按钮会触发 setDraft 清空旧字段语义交由服务端前先把 mode 置 recent、platform/instance/account 清空
    modeRecentBtn.props.onClick()
    assert.equal(draftState.ownerPrimary.mode, 'recent')
    assert.equal(draftState.ownerPrimary.instance, '')

    // 页面文本应含主账号阻塞告警和两个回退开关文案
    const fullText = textOf(tree)
    assert.match(fullText, /普通主动消息已暂停发送/)
    assert.match(fullText, /允许普通主动聊天和共享主动搭话按接收优先级改发/)
    assert.match(fullText, /允许系统重要通知与自测提醒改发其他在线平台/)

    // 点击「测试发送给主人主账号」与切换 fallback 开关
    const testSendBtn = collectNodes(tree, (n) => n.type?.name === 'Btn' && textOf(n.children).includes('测试发送给主人主账号'))[0]
    assert.ok(testSendBtn)
    await testSendBtn.props.onClick()
    assert.ok(posted.some((x) => x.url === '/aurabot/api/test-send'))
    const fbRow = collectNodes(tree, (n) => n.type?.name === 'Row' && String(n.props?.label || '').includes('允许普通主动聊天和共享主动搭话按接收优先级改发'))[0]
    assert.ok(fbRow)
    const fbSw = collectNodes(fbRow, (n) => n.type?.name === 'Switch')[0]
    fbSw.props.onChange(true)
    assert.equal(draftState.ownerPrimary.fallback, true)

    // 3) Platforms 人卡片：主人行不显示「固定平台」select，显示「当前主账号」与「设为主账号」按钮；非主人行保留「固定平台」select
    hook = 0
    state = [
      {
        ok: true, owner: 'p-owner', instances: [], catalog: [], candidates: [], configs: {},
        multiPrivate: {
          enabled: true, available: true, state: 'active', mode: 'live', retiredCount: 0,
          lastDeliveryFailure: { kind: 'failure-notice', platform: 'wechat-clawbot', at: 1767225600000, reason: 'offline' },
          lastProactiveDelivery: { platform: 'bridge', instance: 'bridge#2', account: 'b_acc', at: 1767225600000, fallbackUsed: true },
        },
      }, // data
      '', // busy
      '', // addPlatform
      null, // legacyReview
      null, // recoveryCheck
      0, // recoveryRetry
      null, // steerLimitDraft
      {
        ok: true,
        owner: 'p-owner',
        ownerPrimary: { mode: 'fixed', platform: 'qq', instance: 'qq', account: '10001' },
        ownerAccountOptions: [
          { key: 'qq:qq:10001', platform: 'qq', instance: 'qq', account: '10001', state: 'connected', enabled: true, canProactive: true, multiInstance: false, hasInstance: true, observed: true, selectable: true },
          { key: 'bridge:bridge:b_acc', platform: 'bridge', instance: 'bridge', account: 'b_acc', state: 'connected', enabled: true, canProactive: true, multiInstance: true, hasInstance: true, observed: false, selectable: false },
          { key: 'bridge:bridge#2:b_acc', platform: 'bridge', instance: 'bridge#2', account: 'b_acc', state: 'connected', enabled: true, canProactive: true, multiInstance: true, hasInstance: true, observed: true, selectable: true },
          { key: 'qqbot:qqbot:qb_noinst', platform: 'qqbot', instance: 'qqbot', account: 'qb_noinst', state: 'stopped', enabled: false, canProactive: true, multiInstance: false, hasInstance: false, observed: false, selectable: false },
        ],
        list: [
          { person: 'p-owner', name: '主人', owner: true, fixed: '', accounts: [{ platform: 'qq', account: '10001' }, { platform: 'bridge', account: 'b_acc' }, { platform: 'qqbot', account: 'qb_noinst' }] },
          { person: 'p-guest', name: '访客', owner: false, fixed: 'bridge', accounts: [{ platform: 'bridge', account: 'g_1' }] },
        ],
      }, // peopleData
      [], // chats
      '', // mergeFrom
      '', // mergeInto
      null, // mergeMsg
      '', // importPath
      null, // importPreview
      '', // importMsg
      false, // importBusy
    ]
    const platTree = vmExport.panelTest.Platforms({
      st: { config: cfg, modules: [], onebot: { state: 'connected' } },
      draft: cfg,
      setDraft() {},
      toast() {},
      reload() {},
      go() {},
    })
    const platText = textOf(platTree)
    assert.match(platText, /当前主人主账号：QQ · 10001/)
    assert.match(platText, /设为主人 bridge#2 主账号/)
    assert.match(platText, /最近一次失败回执投递异常 · 微信 ClawBot · .* · 平台离线/)
    assert.match(platText, /最近一次共享主动投递 · 通用桥（bridge#2） · b_acc · 按优先级回退/)

    const unobsQuickBtn = collectNodes(platTree, (n) => n.type?.name === 'Btn' && textOf(n.children).includes('bridge 未观测'))[0]
    assert.ok(unobsQuickBtn)
    assert.equal(unobsQuickBtn.props.disabled, true, '多实例未观测快捷按钮必须禁用')
    const noInstQuickBtn = collectNodes(platTree, (n) => n.type?.name === 'Btn' && textOf(n.children).includes('未配置实例'))[0]
    assert.ok(noInstQuickBtn)
    assert.equal(noInstQuickBtn.props.disabled, true, '无平台实例快捷按钮必须禁用')

    // 快捷按钮应走 /platforms/owner/primary
    const quickPrimaryBtn = collectNodes(platTree, (n) => n.type?.name === 'Btn' && textOf(n.children).includes('设为主人 bridge#2 主账号'))[0]
    assert.ok(quickPrimaryBtn)
    await quickPrimaryBtn.props.onClick()
    assert.deepEqual(
      posted.find((x) => x.url === '/aurabot/api/platforms/owner/primary')?.body,
      { mode: 'fixed', platform: 'bridge', instance: 'bridge#2', account: 'b_acc' },
    )

    // 只应有 1 个固定平台下拉（对应访客 p-guest，而非主人 p-owner）
    const fixedSelects = collectNodes(platTree, (n) => n.type === 'select' && collectNodes(n, (o) => o.type === 'option' && textOf(o) === '跟随最近').length > 0)
    assert.equal(fixedSelects.length, 1, '主人行不得渲染第二个冲突的固定平台下拉')

    // 4) 账号接收优先级的展示、编辑与保存。
    const missingAccount = { platform: 'qq', instance: 'qq', account: '99999_stale' }
    const prioCfg = {
      enabled: true,
      dryRun: false,
      setupDone: true,
      ownerQQ: '10001',
      ownerName: '主人',
      ownerLevel: 'full',
      persona: { current: 'default' },
      ownerPrimary: {
        mode: 'fixed',
        platform: 'bridge',
        instance: 'bridge#2',
        account: 'b_acc',
        fallback: false,
        noticeFallback: true,
        fallbackOrder: [
          missingAccount,
          { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' },
          { platform: 'qq', instance: 'qq', account: '10001' },
        ],
      },
      notice: { enabled: true, approval: true, question: true },
      qqApi: { enabled: true },
      approvalViaQQ: true,
      longTasks: true,
      subagentBackground: false,
      profilePerms: {},
      allow: { groups: [] },
      platforms: {},
      ext: {},
      modules: [],
    }
    const prioOptions = [
      { key: 'qq:qq:10001', platform: 'qq', instance: 'qq', account: '10001', state: 'connected', enabled: true, canProactive: true, legacy: true, multiInstance: false },
      { key: 'bridge:bridge#2:b_acc', platform: 'bridge', instance: 'bridge#2', account: 'b_acc', state: 'disconnected', enabled: true, canProactive: true, multiInstance: true },
      { key: 'feishu:feishu:ou_nop', platform: 'feishu', instance: 'feishu', account: 'ou_nop', state: 'connected', enabled: true, canProactive: false, proactive: 'none', multiInstance: false },
    ]
    draftState = JSON.parse(JSON.stringify(prioCfg))
    hook = 0
    refs.length = 0
    state = [
      {
        ok: true,
        ownerAccountOptions: prioOptions,
        resolvedProactiveRoute: { chatId: '', blocked: true, reason: 'primary-offline', target: { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' }, fallbackUsed: false },
        resolvedSharedProactiveRoute: { chatId: '', deferred: true, retryable: true, reason: 'primary-offline' },
        resolvedNoticeRoute: { chatId: 'private:10001', blocked: false, reason: 'fallback-used', target: { platform: 'qq', instance: 'qq', account: '10001' }, fallbackUsed: true },
        resolvedFallbackPreview: {
          available: true,
          reason: 'ok',
          chatId: 'private:10001',
          target: { platform: 'qq', instance: 'qq', account: '10001' },
          candidateTarget: { platform: 'qq', instance: 'qq', account: '10001' },
          proactiveFallbackEnabled: false,
          noticeFallbackEnabled: true,
        },
        lastBlockedRoute: null,
      },
      false,
      null,
      null,
    ]
    const prioSt = {
      config: prioCfg,
      modules: [],
      personas: [{ id: 'default', name: '默认人格' }],
      mood: { label: '平静' },
      version: '1.3.0',
      snowluma: { installed: false, running: false },
      onebot: { state: 'connected', login: {} },
      platforms: [
        { instance: 'qqbot', platform: 'qqbot', name: 'QQ 官方机器人', enabled: true, state: 'connected' },
      ],
    }
    const prioTree = vmExport.panelTest.GlobalAccess({
      st: prioSt,
      draft: draftState,
      setDraft: (d) => { draftState = d },
      toast() {},
    })
    const prioText = textOf(prioTree)
    assert.match(prioText, /主人的主账号与接收优先级/)
    assert.match(prioText, /当前主账号/)
    assert.doesNotMatch(prioText, /当前主账号（首选 · 固定首位）/)
    assert.doesNotMatch(prioText, /当前固定主账号：/)
    assert.match(prioText, /仅支持回复（将跳过）/)
    assert.match(prioText, /普通主动聊天和共享主动搭话回退：关闭｜系统通知回退：开启/)
    assert.match(prioText, /仅系统通知会改发/)
    assert.match(prioText, /当前主动搭话目标：暂无可用账号，本次将暂缓/)
    assert.match(prioText, /QQ 官方机器人（请用你的账号向该实例发一条私聊以完成绑定/)
    assert.match(prioText, /当前账号列表未返回/)

    // 固定主账号在首位，未返回的已保存账号仍出现在顺位中，未入列的候选留在列表外。
    const prioRows = collectNodes(prioTree, (n) => n.props && n.props['data-prio-key'])
    assert.deepEqual(
      prioRows.map((r) => r.props['data-prio-key']),
      ['bridge\x00bridge#2\x00b_acc', 'qq\x00qq\x0099999_stale', 'qq\x00qq\x0010001'],
    )
    assert.equal(prioRows[0].props['data-prio-pinned'], 'true', '固定主账号必须在首位且标记 pinned')
    assert.equal(prioRows[0].props.onPointerDown, undefined, '固定主账号禁止拖动')
    assert.equal(prioRows[0].props.onDrop, undefined, '固定主账号位置禁止被拖入替换')
    const excludedRows = collectNodes(prioTree, (n) => n.props && n.props['data-prio-excluded-key'])
    assert.deepEqual(
      excludedRows.map((r) => r.props['data-prio-excluded-key']),
      ['feishu\x00feishu\x00ou_nop'],
      '未入列账号不得混入活跃列表假装生效，必须落在未参与回退区域',
    )
    assert.ok(collectNodes(prioTree, (n) => n.type === 'div' && textOf(n.children) === '未加入优先排序的账号').length)

    // 校验固定主账号行（首行）上移/下移/移出全禁用，第 2 行「上移」也禁用（不可顶替第一位）
    const up0 = collectNodes(prioRows[0], (n) => n.type?.name === 'Btn' && textOf(n.children) === '上移')[0]
    const down0 = collectNodes(prioRows[0], (n) => n.type?.name === 'Btn' && textOf(n.children) === '下移')[0]
    const rm0 = collectNodes(prioRows[0], (n) => n.type?.name === 'Btn' && textOf(n.children) === '移出')[0]
    assert.equal(up0.props.disabled, true, '固定主账号「上移」应禁用')
    assert.equal(down0.props.disabled, true, '固定主账号「下移」应禁用')
    assert.equal(rm0.props.disabled, true, '固定主账号「移出」应禁用')
    const up1InTwo = collectNodes(prioRows[1], (n) => n.type?.name === 'Btn' && textOf(n.children) === '上移')[0]
    const downLast = collectNodes(prioRows[prioRows.length - 1], (n) => n.type?.name === 'Btn' && textOf(n.children) === '下移')[0]
    assert.equal(up1InTwo.props.disabled, true, '固定主账号在首位时，第 2 行「上移」应禁用')
    assert.equal(downLast.props.disabled, true, '末行「下移」应禁用')

    // 验证「加入排序」与「移出」交互，以及即使历史配置遗漏固定主账号时也不会将其放到 excluded 区
    draftState = JSON.parse(JSON.stringify(prioCfg))
    const includeFeishuBtn = collectNodes(excludedRows[0], (n) => n.type?.name === 'Btn' && textOf(n.children) === '加入排序')[0]
    assert.ok(includeFeishuBtn)
    includeFeishuBtn.props.onClick()
    assert.deepEqual(JSON.parse(JSON.stringify(draftState.ownerPrimary.fallbackOrder)), [
      { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' },
      missingAccount,
      { platform: 'qq', instance: 'qq', account: '10001' },
      { platform: 'feishu', instance: 'feishu', account: 'ou_nop' },
    ])

    // 用户可以明确移出账号列表未返回的项。其他条目仍留在顺位中。
    draftState = JSON.parse(JSON.stringify(prioCfg))
    const removeMissingBtn = collectNodes(prioRows[1], (n) => n.type?.name === 'Btn' && textOf(n.children) === '移出')[0]
    assert.equal(removeMissingBtn.props.disabled, false)
    removeMissingBtn.props.onClick()
    assert.deepEqual(JSON.parse(JSON.stringify(draftState.ownerPrimary.fallbackOrder)), [
      { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' },
      { platform: 'qq', instance: 'qq', account: '10001' },
    ])
    hook = 0
    refs.length = 0
    const afterRemoveMissing = vmExport.panelTest.GlobalAccess({
      st: prioSt,
      draft: draftState,
      setDraft: (d) => { draftState = d },
      toast() {},
    })
    const qqRow = collectNodes(afterRemoveMissing, (n) => n.props?.['data-prio-key'] === 'qq\x00qq\x0010001')[0]
    const removeQqBtn = collectNodes(qqRow, (n) => n.type?.name === 'Btn' && textOf(n.children) === '移出')[0]
    assert.ok(removeQqBtn)
    removeQqBtn.props.onClick()
    assert.deepEqual(JSON.parse(JSON.stringify(draftState.ownerPrimary.fallbackOrder)), [
      { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' },
    ])
    hook = 0
    refs.length = 0
    const singlePrioTree = vmExport.panelTest.GlobalAccess({
      st: prioSt,
      draft: draftState,
      setDraft: (d) => { draftState = d },
      toast() {},
    })
    const singleRow = collectNodes(singlePrioTree, (n) => n.props && n.props['data-prio-key'])
    assert.equal(singleRow.length, 1)
    const singleRemoveBtn = collectNodes(singleRow[0], (n) => n.type?.name === 'Btn' && textOf(n.children) === '移出')[0]
    assert.equal(singleRemoveBtn.props.disabled, true, '仅剩 1 个排序账号且为主账号时必须禁用「移出」')

    // 即使旧配置 fallbackOrder 未包含当前固定主账号且只列了 qq，渲染仍固定把 bridge#2 放在首位而非放入 excluded
    hook = 0
    refs.length = 0
    const normalizedPinnedTree = vmExport.panelTest.GlobalAccess({
      st: prioSt,
      draft: {
        ...prioCfg,
        ownerPrimary: {
          ...prioCfg.ownerPrimary,
          fallbackOrder: [{ platform: 'qq', instance: 'qq', account: '10001' }],
        },
      },
      setDraft: (d) => { draftState = d },
      toast() {},
    })
    const normalizedRows = collectNodes(normalizedPinnedTree, (n) => n.props && n.props['data-prio-key'])
    assert.deepEqual(
      normalizedRows.map((r) => r.props['data-prio-key']),
      ['bridge\x00bridge#2\x00b_acc', 'qq\x00qq\x0010001'],
      '固定主账号即使在旧顺序中被遗漏或后置，UI 也必须强制固定在第 1 位',
    )
    assert.equal(
      collectNodes(normalizedPinnedTree, (n) => n.props && n.props['data-prio-excluded-key'] === 'bridge\x00bridge#2\x00b_acc').length,
      0,
      '固定主账号绝不得出现在未加入排序区域',
    )
    const addToExistingOrder = collectNodes(normalizedPinnedTree, (n) => n.type?.name === 'Btn' && textOf(n.children) === '加入排序')[0]
    assert.ok(addToExistingOrder)
    addToExistingOrder.props.onClick()
    assert.deepEqual(JSON.parse(JSON.stringify(draftState.ownerPrimary.fallbackOrder)), [
      { platform: 'qq', instance: 'qq', account: '10001' },
      { platform: 'feishu', instance: 'feishu', account: 'ou_nop' },
    ], '编辑已有顺位时不得写入仅用于固定展示的主账号')

    // 切换固定主账号时，把旧主账号保留为第 2 顺位，并保留未返回的已保存账号。
    hook = 0
    refs.length = 0
    const savedOptsBackup = state[0].ownerAccountOptions
    state[0] = {
      ...state[0],
      ownerAccountOptions: [
        ...prioOptions,
        { key: 'qqbot:qqbot:qb_1', platform: 'qqbot', instance: 'qqbot', account: 'qb_1', state: 'connected', enabled: true, canProactive: true, multiInstance: false },
      ],
    }
    const switchDraft = {
      ...prioCfg,
      ownerPrimary: {
        ...prioCfg.ownerPrimary,
        fallbackOrder: [{ platform: 'qq', instance: 'qq', account: '10001' }, missingAccount],
      },
    }
    const switchTree = vmExport.panelTest.GlobalAccess({
      st: prioSt,
      draft: switchDraft,
      setDraft: (d) => { draftState = d },
      toast() {},
    })
    const qbExcludedRow = collectNodes(switchTree, (n) => n.props && n.props['data-prio-excluded-key'] === 'qqbot\x00qqbot\x00qb_1')[0]
    assert.ok(qbExcludedRow)
    const qbSetBtn = collectNodes(qbExcludedRow, (n) => n.type?.name === 'Btn' && textOf(n.children) === '设为主账号')[0]
    assert.ok(qbSetBtn && !qbSetBtn.props.disabled)
    qbSetBtn.props.onClick()
    assert.deepEqual(JSON.parse(JSON.stringify(draftState.ownerPrimary.fallbackOrder)), [
      { platform: 'qqbot', instance: 'qqbot', account: 'qb_1' },
      { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' },
      { platform: 'qq', instance: 'qq', account: '10001' },
      missingAccount,
    ], '切换固定主账号时，即使原自定义列表未写旧主账号，也必须把旧主账号保留为新主账号之后的备选顺位')
    state[0] = { ...state[0], ownerAccountOptions: savedOptsBackup }

    // 验证 3 项完整排序下（固定首位 bridge#2 + 可调序 qq、feishu）：
    // 1) 点击第 2 行「下移」与第 3 行「上移」均可交换第 2/3 位
    // 2) Pointer 拖拽第 2 行到第 3 行上精确交换位置（不会拖乱首位）；尝试拖到第 1 位主账号上被拦截
    draftState = JSON.parse(JSON.stringify({
      ...prioCfg,
      ownerPrimary: {
        ...prioCfg.ownerPrimary,
        fallbackOrder: [
          { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' },
          { platform: 'qq', instance: 'qq', account: '10001' },
          { platform: 'feishu', instance: 'feishu', account: 'ou_nop' },
        ],
      },
    }))
    hook = 0
    refs.length = 0
    const prioTreeDrag = vmExport.panelTest.GlobalAccess({
      st: prioSt,
      draft: draftState,
      setDraft: (d) => { draftState = d },
      toast() {},
    })
    const dragRows = collectNodes(prioTreeDrag, (n) => n.props && n.props['data-prio-key'])
    assert.equal(collectNodes(dragRows[1], (n) => n.type?.name === 'Btn' && textOf(n.children) === '上移')[0].props.disabled, true, '第 2 行不得上移取代固定第 1 位')
    collectNodes(dragRows[1], (n) => n.type?.name === 'Btn' && textOf(n.children) === '下移')[0].props.onClick()
    assert.deepEqual(JSON.parse(JSON.stringify(draftState.ownerPrimary.fallbackOrder)), [
      { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' },
      { platform: 'feishu', instance: 'feishu', account: 'ou_nop' },
      { platform: 'qq', instance: 'qq', account: '10001' },
    ])

    // 还原 3 项并验证 Pointer 拖拽交换（绕开 Windows dataTransfer \0 截断与 HTML5 限制）
    draftState = JSON.parse(JSON.stringify({
      ...prioCfg,
      ownerPrimary: {
        ...prioCfg.ownerPrimary,
        fallbackOrder: [
          { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' },
          { platform: 'qq', instance: 'qq', account: '10001' },
          { platform: 'feishu', instance: 'feishu', account: 'ou_nop' },
        ],
      },
    }))
    hook = 0
    refs.length = 0
    const prioTreePtr = vmExport.panelTest.GlobalAccess({
      st: prioSt,
      draft: draftState,
      setDraft: (d) => { draftState = d },
      toast() {},
    })
    const prioListVnode = collectNodes(prioTreePtr, (n) => n.props?.className && String(n.props.className).includes('ab-prio-list'))[0]
    assert.ok(prioListVnode?.props?.ref)
    const ptrRows = collectNodes(prioTreePtr, (n) => n.props && n.props['data-prio-key'])
    prioListVnode.props.ref.current = {
      querySelectorAll: () => [
        { getAttribute: (k) => k === 'data-prio-key' ? 'bridge\x00bridge#2\x00b_acc' : (k === 'data-prio-pinned' ? 'true' : null), getBoundingClientRect: () => ({ left: 0, right: 300, top: 0, bottom: 40 }) },
        { getAttribute: (k) => k === 'data-prio-key' ? 'qq\x00qq\x0010001' : (k === 'data-prio-pinned' ? 'false' : null), getBoundingClientRect: () => ({ left: 0, right: 300, top: 46, bottom: 86 }) },
        { getAttribute: (k) => k === 'data-prio-key' ? 'feishu\x00feishu\x00ou_nop' : (k === 'data-prio-pinned' ? 'false' : null), getBoundingClientRect: () => ({ left: 0, right: 300, top: 92, bottom: 132 }) },
      ],
    }
    // 尝试从 #3 拖到固定首位 #1（y=20）→ 必须忽略，不改顺序
    ptrRows[2].props.onPointerDown({ button: 0, pointerType: 'mouse', clientX: 50, clientY: 110, target: { closest: () => null }, preventDefault() {} })
    dispatchWinEvent('pointermove', { clientX: 50, clientY: 20 })
    dispatchWinEvent('pointerup', { clientX: 50, clientY: 20 })
    assert.deepEqual(JSON.parse(JSON.stringify(draftState.ownerPrimary.fallbackOrder)), [
      { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' },
      { platform: 'qq', instance: 'qq', account: '10001' },
      { platform: 'feishu', instance: 'feishu', account: 'ou_nop' },
    ], '拖到固定的第 1 位主账号上绝不得交换')
    // 从 #2（y=65）拖到 #3（y=110）→ 精确交换位置
    ptrRows[1].props.onPointerDown({ button: 0, pointerType: 'mouse', clientX: 50, clientY: 65, target: { closest: () => null }, preventDefault() {} })
    dispatchWinEvent('pointermove', { clientX: 50, clientY: 110 })
    dispatchWinEvent('pointerup', { clientX: 50, clientY: 110 })
    assert.deepEqual(JSON.parse(JSON.stringify(draftState.ownerPrimary.fallbackOrder)), [
      { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' },
      { platform: 'feishu', instance: 'feishu', account: 'ou_nop' },
      { platform: 'qq', instance: 'qq', account: '10001' },
    ], '拖拽到另一非固定列表项上必须交换位置')

    // 校验 touch 触摸交互（复审 §3.2）：触碰行体空白处不拦截滚动，从 .ab-prio-handle 拖动触发 swap
    draftState = JSON.parse(JSON.stringify({
      ...prioCfg,
      ownerPrimary: {
        ...prioCfg.ownerPrimary,
        fallbackOrder: [
          { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' },
          { platform: 'qq', instance: 'qq', account: '10001' },
          { platform: 'feishu', instance: 'feishu', account: 'ou_nop' },
        ],
      },
    }))
    ptrRows[1].props.onPointerDown({ button: 0, pointerType: 'touch', clientX: 50, clientY: 65, target: { closest: () => null }, preventDefault() {} })
    dispatchWinEvent('pointermove', { clientX: 50, clientY: 110 })
    dispatchWinEvent('pointerup', { clientX: 50, clientY: 110 })
    assert.deepEqual(JSON.parse(JSON.stringify(draftState.ownerPrimary.fallbackOrder)), [
      { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' },
      { platform: 'qq', instance: 'qq', account: '10001' },
      { platform: 'feishu', instance: 'feishu', account: 'ou_nop' },
    ], 'touch 非手柄区域滑动不得劫持列表滚动')
    ptrRows[1].props.onPointerDown({ button: 0, pointerType: 'touch', clientX: 50, clientY: 65, target: { closest: (sel) => (sel === '.ab-prio-handle' ? {} : null) }, preventDefault() {} })
    dispatchWinEvent('pointermove', { clientX: 50, clientY: 110 })
    dispatchWinEvent('pointerup', { clientX: 50, clientY: 110 })
    assert.deepEqual(JSON.parse(JSON.stringify(draftState.ownerPrimary.fallbackOrder)), [
      { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' },
      { platform: 'feishu', instance: 'feishu', account: 'ou_nop' },
      { platform: 'qq', instance: 'qq', account: '10001' },
    ], 'touch 从 .ab-prio-handle 手柄拖动必须精确交换位置')

    // 同时验证无固定主账号（recent 模式）下，第 1 项拖到第 3 项直接交换 #1 和 #3（而非移位）
    draftState = JSON.parse(JSON.stringify({
      ...prioCfg,
      ownerPrimary: {
        ...prioCfg.ownerPrimary,
        mode: 'recent',
        platform: '',
        instance: '',
        account: '',
        fallbackOrder: [
          { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' },
          { platform: 'qq', instance: 'qq', account: '10001' },
          { platform: 'feishu', instance: 'feishu', account: 'ou_nop' },
        ],
      },
    }))
    hook = 0
    refs.length = 0
    const prioTreeRecentSwap = vmExport.panelTest.GlobalAccess({
      st: prioSt,
      draft: draftState,
      setDraft: (d) => { draftState = d },
      toast() {},
    })
    const recentRows = collectNodes(prioTreeRecentSwap, (n) => n.props && n.props['data-prio-key'])
    const storeTransfer = new Map()
    const mkEvt = () => ({
      preventDefault() {},
      dataTransfer: {
        effectAllowed: 'move',
        setData: (k, v) => storeTransfer.set(k, v),
        getData: (k) => storeTransfer.get(k) || '',
      },
    })
    recentRows[0].props.onDragStart(mkEvt())
    recentRows[2].props.onDragOver(mkEvt())
    recentRows[2].props.onDrop(mkEvt())
    assert.deepEqual(JSON.parse(JSON.stringify(draftState.ownerPrimary.fallbackOrder)), [
      { platform: 'feishu', instance: 'feishu', account: 'ou_nop' },
      { platform: 'qq', instance: 'qq', account: '10001' },
      { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' },
    ], '拖拽 #1 到 #3 上应直接交换两者位置')

    // 点击「恢复默认顺序」置空 fallbackOrder
    const resetBtn = collectNodes(prioTreeDrag, (n) => n.type?.name === 'Btn' && textOf(n.children) === '恢复默认顺序')[0]
    assert.ok(resetBtn)
    resetBtn.props.onClick()
    assert.deepEqual(JSON.parse(JSON.stringify(draftState.ownerPrimary.fallbackOrder)), [])
    const resetDraft = draftState
    const renderOrder = (draft) => {
      hook = 0
      refs.length = 0
      return vmExport.panelTest.GlobalAccess({
        st: prioSt,
        draft,
        setDraft: (d) => { draftState = d },
        toast() {},
      })
    }
    const defaultTree = renderOrder(resetDraft)
    assert.match(textOf(defaultTree), /共享主动搭话只使用已保存的顺位/)
    assert.deepEqual(orderRows(defaultTree, 'data-prio-key').map((row) => row.props['data-prio-key']), ['bridge\x00bridge#2\x00b_acc'])
    const defaultCandidates = orderRows(defaultTree, 'data-prio-excluded-key')
    assert.deepEqual(defaultCandidates.map((row) => row.props['data-prio-excluded-key']), ['qq\x00qq\x0010001', 'feishu\x00feishu\x00ou_nop'])
    const addFirst = collectNodes(defaultCandidates[0], (n) => n.type?.name === 'Btn' && textOf(n.children) === '加入排序')[0]
    addFirst.props.onClick()
    assert.deepEqual(JSON.parse(JSON.stringify(draftState.ownerPrimary.fallbackOrder)), [{ platform: 'qq', instance: 'qq', account: '10001' }])
    draftState = resetDraft
    const addAll = collectNodes(defaultTree, (n) => n.type?.name === 'Btn' && textOf(n.children) === '全部加入排序')[0]
    assert.ok(addAll)
    addAll.props.onClick()
    assert.deepEqual(JSON.parse(JSON.stringify(draftState.ownerPrimary.fallbackOrder)), [
      { platform: 'qq', instance: 'qq', account: '10001' },
      { platform: 'feishu', instance: 'feishu', account: 'ou_nop' },
    ])
    const recentDefaultTree = renderOrder({
      ...resetDraft,
      ownerPrimary: { ...resetDraft.ownerPrimary, mode: 'recent', platform: '', instance: '', account: '' },
    })
    assert.equal(orderRows(recentDefaultTree, 'data-prio-key').length, 0)
    assert.equal(orderRows(recentDefaultTree, 'data-prio-excluded-key').length, prioOptions.length)

    // 账号列表暂时没有返回主账号时，仍能看到锁定的固定主账号行。
    const fullPeople = state[0]
    state[0] = { ...fullPeople, ownerAccountOptions: prioOptions.filter((o) => o.platform !== 'bridge') }
    const missingPrimaryTree = renderOrder(resetDraft)
    const missingPrimaryRows = orderRows(missingPrimaryTree, 'data-prio-key')
    assert.equal(missingPrimaryRows.length, 1)
    assert.equal(missingPrimaryRows[0].props['data-prio-key'], 'bridge\x00bridge#2\x00b_acc')
    assert.equal(missingPrimaryRows[0].props['data-prio-pinned'], 'true')
    assert.match(textOf(missingPrimaryRows[0]), /当前账号列表未返回/)
    state[0] = fullPeople

    // 验证多实例平台已绑定 feishu 但 feishu#2 未绑定/未观测时，unboundInstances 按实例判断仍提示 feishu#2（审阅 §4.1）
    hook = 0
    refs.length = 0
    const origPeople = state[0]
    state[0] = {
      ...origPeople,
      ownerAccountOptions: [
        ...prioOptions,
        { key: 'feishu:feishu#2:ou_nop', platform: 'feishu', instance: 'feishu#2', account: 'ou_nop', state: 'connected', enabled: true, canProactive: false, multiInstance: true, observed: false, unlinkedOnInstance: true },
      ],
      resolvedSharedProactiveRoute: {
        chatId: 'bridge#2:private:b_acc',
        target: { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' },
        fallbackUsed: true,
      },
      resolvedFallbackPreview: {
        available: true,
        reason: 'recent-preview',
        chatId: 'bridge#2:private:b_acc',
        target: { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' },
        currentTarget: { platform: 'qq', instance: 'qq', account: '10001' },
        candidateTarget: { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' },
        proactiveFallbackEnabled: false,
        noticeFallbackEnabled: true,
      },
    }
    const multiUnboundSt = {
      ...prioSt,
      platforms: [
        { instance: 'feishu', platform: 'feishu', name: '工作飞书 1', enabled: true, state: 'connected' },
        { instance: 'feishu#2', platform: 'feishu', name: '个人飞书 2', enabled: true, state: 'connected' },
      ],
    }
    const multiUnboundTree = vmExport.panelTest.GlobalAccess({
      st: multiUnboundSt,
      draft: JSON.parse(JSON.stringify(prioCfg)),
      setDraft: (d) => { draftState = d },
      toast() {},
    })
    const multiUnboundText = textOf(multiUnboundTree)
    assert.match(multiUnboundText, /个人飞书 2（feishu#2）/, 'feishu 已绑定时未观测的 feishu#2 仍须提示未绑定')
    assert.doesNotMatch(multiUnboundText, /工作飞书 1/, '已绑定的 feishu 实例不应重复出现在未绑定提示中')
    assert.match(multiUnboundText, /当前优先：最近私聊平台（QQ · 10001）；若不可用则顺延：通用桥（bridge#2） · b_acc/)
    assert.match(multiUnboundText, /当前主动搭话目标：通用桥（bridge#2） · b_acc · 共享会话 · 按优先级回退/)

    // 预览 reason === 'fallback-disabled' 渲染校验
    hook = 0
    refs.length = 0
    state[0] = {
      ...origPeople,
      resolvedFallbackPreview: {
        available: false,
        reason: 'fallback-disabled',
        chatId: '',
        target: null,
        candidateTarget: { platform: 'qq', instance: 'qq', account: '10001' },
        proactiveFallbackEnabled: false,
        noticeFallbackEnabled: false,
      },
    }
    const disabledTree = vmExport.panelTest.GlobalAccess({
      st: prioSt,
      draft: draftState,
      setDraft: (d) => { draftState = d },
      toast() {},
    })
    const disabledText = textOf(disabledTree)
    assert.match(disabledText, /普通主动聊天和共享主动搭话回退：关闭｜系统通知回退：关闭/)
    assert.match(disabledText, /回退开关均关闭，不会自动发送/)

    // 验证 AurabotPage 真实 save() 入口：
    // 1) 未修改 fallbackOrder 只改 ownerName 时，提交 /save 省略 fallbackOrder，不覆盖服务端新追加账号（审阅 §3.3）
    const dirtyCfgUnchangedOrder = JSON.parse(JSON.stringify(prioCfg))
    dirtyCfgUnchangedOrder.ownerName = '主人在保存'
    hook = 0
    refs.length = 0
    state = [prioSt, '', dirtyCfgUnchangedOrder, 'access', null, false]
    const pageTree = vmExport.panelTest.AurabotPage()
    const saveBtn = collectNodes(pageTree, (n) => n.type?.name === 'Btn' && textOf(n.children) === '保存设置')[0]
    assert.ok(saveBtn, '修改主配置后应渲染底部「保存设置」按钮')
    await saveBtn.props.onClick()
    const savedUnchangedCall = posted.find((x) => x.url === '/aurabot/api/save')
    assert.ok(savedUnchangedCall, '点击保存设置应调用 /aurabot/api/save')
    assert.equal(Object.hasOwn(savedUnchangedCall.body.ownerPrimary, 'fallbackOrder'), false, '未改动顺位时应省略 fallbackOrder 避免覆盖服务端新增')

    // 2) 改动顺位后按草稿提交。账号列表尚未返回的条目仍在请求里，由服务端校验。
    posted.length = 0
    const dirtyCfgEditedOrder = JSON.parse(JSON.stringify(prioCfg))
    dirtyCfgEditedOrder.ownerPrimary.fallbackOrder = [
      missingAccount,
      { platform: 'qq', instance: 'qq', account: '10001' },
      { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' },
    ]
    hook = 0
    refs.length = 0
    state = [prioSt, '', dirtyCfgEditedOrder, 'access', null, false]
    const pageTree2 = vmExport.panelTest.AurabotPage()
    const saveBtn2 = collectNodes(pageTree2, (n) => n.type?.name === 'Btn' && textOf(n.children) === '保存设置')[0]
    await saveBtn2.props.onClick()
    const savedEditedCall = posted.find((x) => x.url === '/aurabot/api/save')
    assert.deepEqual(savedEditedCall.body.ownerPrimary.fallbackOrder, dirtyCfgEditedOrder.ownerPrimary.fallbackOrder)

    // 3) 用户点击「恢复默认顺序」后，显式提交空数组。
    posted.length = 0
    hook = 0
    refs.length = 0
    state = [prioSt, '', resetDraft, 'access', null, false]
    const resetPage = vmExport.panelTest.AurabotPage()
    const saveResetBtn = collectNodes(resetPage, (n) => n.type?.name === 'Btn' && textOf(n.children) === '保存设置')[0]
    await saveResetBtn.props.onClick()
    const savedResetCall = posted.find((x) => x.url === '/aurabot/api/save')
    assert.deepEqual(savedResetCall.body.ownerPrimary.fallbackOrder, [])
  } finally {
    globalThis.fetch = origFetch
  }
})

test('P3-6: 成员变更（merge/unlink/claim）同步 fallbackOrder，与 validateOwnerFallbackOrder 在 /save、/platforms/owner/primary 及无 owner 时一致性', async (t) => {
  const dir = freshDataDir('aurabot-p3-member-sync-')
  const { fake, applied, adapters, ownerPerson } = await startHost(t, {
    dataDir: dir,
    seedOwnerAccounts: [['bridge', 'b_acc'], ['feishu', 'ou_nop']],
    seedConfig: {
      ownerPrimary: {
        mode: 'fixed',
        platform: 'bridge',
        instance: 'bridge#2',
        account: 'b_acc',
        fallback: true,
        noticeFallback: true,
        fallbackOrder: [{ platform: 'bridge', instance: 'bridge#2', account: 'b_acc' }],
      },
    },
  })
  adapters.get('bridge#2').pushInbound({
    chat: { kind: 'private', id: 'b_acc' },
    sender: { account: 'b_acc', name: '主人' },
    parts: [{ type: 'text', text: 'hi' }],
  })
  // 校验 fake-bot（bridge#2 默认 self.account）被拒绝

  // 1) /platforms/people/merge：先把访客 g_1 写入身份库，dryRun=true 不改 fallbackOrder，dryRun=false 合并入主人后自动追加末尾
  const guestPerson = applied.gateway.identity.resolve('feishu', 'ou_merged_guest')
  assert.notEqual(guestPerson, ownerPerson)
  // 当前主人已有 feishu:ou_nop，换一个不冲突平台 qqbot 测试 merge repoint
  const mergeGuest = applied.gateway.identity.resolve('qqbot', 'qb_merged')
  const dryRes = (await fake.call('/platforms/people/merge', { from: mergeGuest, into: ownerPerson, dryRun: true })).json()
  assert.equal(dryRes.ok, true)
  assert.deepEqual(applied.getConfig().ownerPrimary.fallbackOrder, [
    { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' },
  ])
  const realMergeRes = (await fake.call('/platforms/people/merge', { from: mergeGuest, into: ownerPerson, dryRun: false })).json()
  assert.equal(realMergeRes.ok, true)
  assert.deepEqual(applied.getConfig().ownerPrimary.fallbackOrder, [
    { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' },
    { platform: 'qqbot', instance: 'qqbot', account: 'qb_merged' },
  ], 'merge 合并进主人的新账号应自动追加到非空 fallbackOrder 末尾')

  // 2) /platforms/people/unlink 解绑 qb_merged 后立即从 fallbackOrder 移除 stale 项
  const unlinkRes = (await fake.call('/platforms/people/unlink', { platform: 'qqbot', account: 'qb_merged' })).json()
  assert.equal(unlinkRes.ok, true)
  assert.deepEqual(applied.getConfig().ownerPrimary.fallbackOrder, [
    { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' },
  ])

  // 3) 当 fallbackOrder 为空（[]）时，merge 不应主动写入非空 fallbackOrder
  await fake.call('/platforms/owner/primary', { fallbackOrder: [] })
  const guestEmpty = applied.gateway.identity.resolve('qqbot', 'qb_keep_empty')
  await fake.call('/platforms/people/merge', { from: guestEmpty, into: ownerPerson, dryRun: false })
  assert.deepEqual(applied.getConfig().ownerPrimary.fallbackOrder, [], 'fallbackOrder 为空时 merge 不得擅自填入列表')

  // 4) 显式修改顺位时，两个保存入口都拒绝非法条目，保留已有顺位和本次请求的其他配置。
  const bridgeOrder = { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' }
  const staleOrder = { platform: 'feishu', instance: 'feishu', account: 'ou_unlinked_stale' }
  const cleanSave = (await fake.call('/save', {
    ownerPrimary: { fallbackOrder: [bridgeOrder] },
  })).json()
  assert.equal(cleanSave.ok, true)
  assert.deepEqual(cleanSave.config.ownerPrimary.fallbackOrder, [bridgeOrder])
  const beforeNoticeToggle = applied.getConfig()
  const toggledNotice = (await fake.call('/notice/toggle', { kind: 'approval', value: false })).json()
  assert.equal(toggledNotice.ok, true)
  assert.equal(toggledNotice.notice.approval, false)
  assert.deepEqual(applied.getConfig(), {
    ...beforeNoticeToggle,
    notice: { ...beforeNoticeToggle.notice, approval: false },
  })
  const beforeInvalidSave = readFileSync(join(dir, 'config.json'), 'utf8')
  const invalidOrders = [
    ['bad', /数组/],
    [[{}], /格式|完整|账号/],
    [[{ ...bridgeOrder, account: 'fake-bot' }], /机器人自身/],
    [[staleOrder], /解绑|绑定|主人/],
    [[bridgeOrder, staleOrder], /解绑|绑定|主人/],
  ]
  for (const [fallbackOrder, message] of invalidOrders) {
    const save = (await fake.call('/save', { ownerName: '无效顺位不应该修改此项', ownerPrimary: { fallbackOrder } })).json()
    const primary = (await fake.call('/platforms/owner/primary', { noticeFallback: false, fallbackOrder })).json()
    for (const result of [save, primary]) {
      assert.equal(result.ok, false)
      assert.match(result.message, message)
    }
    assert.deepEqual(applied.getConfig().ownerPrimary.fallbackOrder, [bridgeOrder])
    assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), beforeInvalidSave)
  }

  // 模拟：面板加载快照后只改 ownerName（未改排序），期间服务端自动追加了新绑定账号 → 保存 /save 不得覆盖服务端新增（审阅 §3.3 & §4.4）
  await fake.call('/platforms/people/unlink', { platform: 'qqbot', account: 'qb_keep_empty' })
  const stalePanelSnapshot = JSON.parse(JSON.stringify(applied.getConfig()))
  const newServerGuest = applied.gateway.identity.resolve('qqbot', 'qb_server_added')
  const serverMergeRes = (await fake.call('/platforms/people/merge', { from: newServerGuest, into: ownerPerson, dryRun: false })).json()
  assert.equal(serverMergeRes.ok, true)
  assert.deepEqual(applied.getConfig().ownerPrimary.fallbackOrder, [
    { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' },
    { platform: 'qqbot', instance: 'qqbot', account: 'qb_server_added' },
  ])
  // 面板持有的仍是 merge 前的 stalePanelSnapshot（未改 fallbackOrder），只改 ownerName 提交 /save
  const bodyFromStalePanel = {
    ownerName: '面板改个昵称',
    ownerPrimary: {
      mode: stalePanelSnapshot.ownerPrimary.mode,
      platform: stalePanelSnapshot.ownerPrimary.platform,
      instance: stalePanelSnapshot.ownerPrimary.instance,
      account: stalePanelSnapshot.ownerPrimary.account,
      fallback: stalePanelSnapshot.ownerPrimary.fallback,
      noticeFallback: stalePanelSnapshot.ownerPrimary.noticeFallback,
    },
  }
  const keepAppendRes = (await fake.call('/save', bodyFromStalePanel)).json()
  assert.equal(keepAppendRes.ok, true)
  assert.deepEqual(keepAppendRes.config.ownerPrimary.fallbackOrder, [
    { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' },
    { platform: 'qqbot', instance: 'qqbot', account: 'qb_server_added' },
  ], '服务端自动追加新账号后，面板未改排序直接保存其他设置不得覆盖新追加账号')

  // 账号暂未出现在身份库时，普通保存和主账号开关保存均保留原顺位。
  const orderWithStale = [bridgeOrder, staleOrder]
  applied.setConfig({
    ...applied.getConfig(),
    ownerPrimary: {
      ...applied.getConfig().ownerPrimary,
      fallbackOrder: orderWithStale,
    },
  })
  const partialSave = (await fake.call('/save', { ownerName: '仅保存昵称' })).json()
  assert.equal(partialSave.ok, true)
  assert.equal(partialSave.config.ownerName, '仅保存昵称')
  assert.deepEqual(partialSave.config.ownerPrimary.fallbackOrder, orderWithStale)
  const partialPrimary = (await fake.call('/platforms/owner/primary', { noticeFallback: false })).json()
  assert.equal(partialPrimary.ok, true)
  assert.equal(partialPrimary.config.ownerPrimary.noticeFallback, false)
  assert.deepEqual(partialPrimary.config.ownerPrimary.fallbackOrder, orderWithStale)
  const unchangedOrder = (await fake.call('/save', { ownerName: '旧版面板保存昵称', ownerPrimary: { fallbackOrder: orderWithStale } })).json()
  assert.equal(unchangedOrder.ok, true)
  assert.equal(unchangedOrder.config.ownerName, '旧版面板保存昵称')
  assert.deepEqual(unchangedOrder.config.ownerPrimary.fallbackOrder, orderWithStale)

  // 显式提交空数组仍然可以清空顺位。
  const clearOrder = (await fake.call('/save', { ownerPrimary: { fallbackOrder: [] } })).json()
  assert.equal(clearOrder.ok, true)
  assert.deepEqual(clearOrder.config.ownerPrimary.fallbackOrder, [])
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).ownerPrimary.fallbackOrder, [])
  assert.ok(fake.logs.some((line) => line.includes('接收优先级已变更（/save）｜账号数 2 → 0')))

  // 5) 启动清理仍可处理磁盘里的孤立顺位。一般保存不对已有顺位做这项清理。
  const dirNoOwner = freshDataDir('aurabot-p3-no-owner-save-')
  writeFileSync(join(dirNoOwner, 'config.json'), JSON.stringify(normalize({
    enabled: false,
    dryRun: true,
    setupDone: true,
    ownerQQ: '',
    platforms: { bridge: { enabled: true } },
    ownerPrimary: {
      fallbackOrder: [{ platform: 'feishu', instance: 'feishu', account: 'ou_orphan_stale' }],
    },
  })), 'utf8')
  const fakeNoOwner = createFakeDsh({ brain: async () => '' })
  const appliedNoOwner = hostMod.apply(fakeNoOwner.ctx)
  t.after(async () => {
    try { await appliedNoOwner.gateway?.stopAll?.() } catch {}
    try { fakeNoOwner.dispose() } catch {}
  })
  await appliedNoOwner.ready
  assert.deepEqual(appliedNoOwner.getConfig().ownerPrimary.fallbackOrder, [], '无主人启动后即应清空孤立 fallbackOrder')
  const orphanOrder = [{ platform: 'feishu', instance: 'feishu', account: 'ou_orphan_live_stale' }]
  appliedNoOwner.setConfig({
    ...appliedNoOwner.getConfig(),
    ownerPrimary: {
      ...appliedNoOwner.getConfig().ownerPrimary,
      fallbackOrder: orphanOrder,
    },
  })
  const saveUnrelatedNoOwner = (await fakeNoOwner.call('/save', { ownerName: '游客改动' })).json()
  assert.equal(saveUnrelatedNoOwner.ok, true)
  assert.deepEqual(saveUnrelatedNoOwner.config.ownerPrimary.fallbackOrder, orphanOrder)
  const primaryUnrelatedNoOwner = (await fakeNoOwner.call('/platforms/owner/primary', { fallback: true })).json()
  assert.equal(primaryUnrelatedNoOwner.ok, true)
  assert.deepEqual(primaryUnrelatedNoOwner.config.ownerPrimary.fallbackOrder, orphanOrder)
  const saveOrderNoOwner = (await fakeNoOwner.call('/save', { ownerPrimary: { fallbackOrder: [bridgeOrder] } })).json()
  assert.equal(saveOrderNoOwner.ok, false)
  assert.match(saveOrderNoOwner.message, /主人/)
  assert.deepEqual(appliedNoOwner.getConfig().ownerPrimary.fallbackOrder, orphanOrder)
})

test('P3-7: resolvedFallbackPreview 全状态矩阵（ok/仅系统通知/fallback-disabled/no-route/recent）', async (t) => {
  const dir = freshDataDir('aurabot-p3-preview-')
  const { fake, adapters } = await startHost(t, {
    dataDir: dir,
    seedOwnerAccounts: [['bridge', 'b_acc'], ['feishu', 'ou_nop']],
    seedConfig: {
      ownerPrimary: {
        mode: 'fixed',
        platform: 'bridge',
        instance: 'bridge#2',
        account: 'b_acc',
        fallback: false,
        noticeFallback: true,
        fallbackOrder: [
          { platform: 'qq', instance: 'qq', account: '10001' },
          { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' },
        ],
      },
    },
  })
  adapters.get('bridge#2').pushInbound({
    chat: { kind: 'private', id: 'b_acc' },
    sender: { account: 'b_acc', name: '主人' },
    parts: [{ type: 'text', text: 'hi' }],
  })
  // 把默认 qq 网关端连上（通过 startHost 里的 legacy qq 不连通？Wait: bridge 作为主账号以外再连通 bridge 实例主动能力）
  // 将 bridge 设为 proactive: 'free' 并让 b_acc 在 bridge 也绑定观测，作为第 2 候选
  const b1 = adapters.get('bridge')
  b1.pushInbound({ chat: { kind: 'private', id: 'b_acc' }, sender: { account: 'b_acc', name: '主人' }, parts: [{ type: 'text', text: 'hi1' }] })
  await fake.call('/platforms/owner/primary', {
    fallbackOrder: [
      { platform: 'bridge', instance: 'bridge', account: 'b_acc' },
      { platform: 'bridge', instance: 'bridge#2', account: 'b_acc' },
    ],
  })

  // 1) fallback=false & noticeFallback=true：预览 available=true, proactiveFallbackEnabled=false, noticeFallbackEnabled=true
  const pDefault = (await fake.call('/platforms/people')).json().resolvedFallbackPreview
  assert.equal(pDefault.available, true)
  assert.equal(pDefault.reason, 'ok')
  assert.equal(pDefault.target?.instance, 'bridge')
  assert.equal(pDefault.proactiveFallbackEnabled, false)
  assert.equal(pDefault.noticeFallbackEnabled, true)

  // 2) fallback=false & noticeFallback=false：有候选但必须返回 reason='fallback-disabled', available=false, target=null
  const rDisabled = (await fake.call('/platforms/owner/primary', { fallback: false, noticeFallback: false })).json()
  assert.equal(rDisabled.ok, true)
  assert.equal(rDisabled.resolvedFallbackPreview.available, false)
  assert.equal(rDisabled.resolvedFallbackPreview.reason, 'fallback-disabled')
  assert.equal(rDisabled.resolvedFallbackPreview.target, null)
  assert.equal(rDisabled.resolvedFallbackPreview.candidateTarget?.instance, 'bridge')
  assert.equal(rDisabled.resolvedFallbackPreview.proactiveFallbackEnabled, false)
  assert.equal(rDisabled.resolvedFallbackPreview.noticeFallbackEnabled, false)

  // 3) recent 模式：reason='recent-preview'，同时返回当前活跃目标 currentTarget 与备选下一跳 candidateTarget（审阅 §4.3）
  adapters.get('bridge#2').pushInbound({
    chat: { kind: 'private', id: 'b_acc' },
    sender: { account: 'b_acc', name: '主人' },
    parts: [{ type: 'text', text: 'latest recent msg' }],
  })
  const rRecent = (await fake.call('/platforms/owner/primary', { mode: 'recent' })).json()
  assert.equal(rRecent.resolvedFallbackPreview.reason, 'recent-preview')
  assert.equal(rRecent.resolvedFallbackPreview.currentTarget?.instance, 'bridge#2')
  assert.equal(rRecent.resolvedFallbackPreview.candidateTarget?.instance, 'bridge')
})

test('共享主动搭话预览只使用网关主账号和显式接收优先级', async (t) => {
  const { fake, applied, adapters, ownerPerson } = await startHost(t, {
    seedOwnerAccounts: [['bridge', 'b_primary'], ['bridge', 'b_backup'], ['feishu', 'ou_passive']],
    seedConfig: {
      multiPlatformPrivateSession: true,
      ownerPrimary: { mode: 'fixed', platform: 'bridge', instance: 'bridge#2', account: 'b_primary', fallback: true },
    },
    configureDsh(ctx) {
      ctx.services.sessionController.fork = async () => { throw new Error('路由预览不应创建共享会话') }
      ctx.services.sessionProjections = {}
    },
  })
  const { gateway } = applied
  gateway.routing.noteSeen(ownerPerson, 'bridge#2:private:b_primary', Date.now())
  gateway.routing.noteSeen(ownerPerson, 'bridge:private:b_backup', Date.now())
  const preview = async () => (await fake.call('/platforms/people')).json().resolvedSharedProactiveRoute
  assert.equal((await preview())?.chatId, 'bridge#2:private:b_primary')
  adapters.get('bridge#2').setCaps({ proactive: 'none' })
  const noOrder = await preview()
  assert.equal(noOrder?.deferred, true)
  assert.equal(noOrder.chatId, '')

  const before = applied.getConfig()
  applied.setConfig({ ...before, ownerPrimary: { ...before.ownerPrimary, fallbackOrder: [
    { platform: 'qq', instance: 'qq', account: '10001' },
    { platform: 'feishu', instance: 'feishu', account: 'ou_passive' },
    { platform: 'bridge', instance: 'bridge', account: 'b_backup' },
  ] } })
  const fallback = await preview()
  assert.equal(fallback?.chatId, 'bridge:private:b_backup')
  assert.equal(fallback.fallbackUsed, true)
  const disabled = (await fake.call('/platforms/owner/primary', { fallback: false })).json().resolvedSharedProactiveRoute
  assert.equal(disabled?.deferred, true)
  assert.equal(disabled.chatId, '')
})

test('共享主动搭话跳过每次连接中仍在等待 whoami 的备用实例', async (t) => {
  let whoami = Promise.withResolvers()
  const firstIdentity = { account: 'bridge_first_bot' }
  t.after(() => whoami.resolve(firstIdentity))
  const { fake, applied, adapters, ownerPerson } = await startHost(t, {
    seedOwnerAccounts: [['bridge', 'b_primary'], ['bridge', 'b_first'], ['bridge', 'b_second']],
    seedConfig: {
      multiPlatformPrivateSession: true,
      platforms: { bridge: { enabled: true }, 'bridge#2': { enabled: true }, 'bridge#3': { enabled: true } },
      ownerPrimary: { mode: 'fixed', platform: 'bridge', instance: 'bridge#2', account: 'b_primary', fallback: true },
    },
    configureDsh(ctx) {
      ctx.services.sessionController.fork = async () => { throw new Error('路由预览不应创建共享会话') }
      ctx.services.sessionProjections = {}
    },
    configureBridgeAdapter(instance, adapter) {
      if (instance === 'bridge') adapter.whoami = () => whoami.promise
    },
  })

  const { gateway } = applied
  gateway.routing.noteSeen(ownerPerson, 'bridge#2:private:b_primary', Date.now())
  gateway.routing.noteSeen(ownerPerson, 'bridge:private:b_first', Date.now())
  gateway.routing.noteSeen(ownerPerson, 'bridge#3:private:b_second', Date.now())
  adapters.get('bridge#2').setCaps({ proactive: 'none' })
  const before = applied.getConfig()
  applied.setConfig({ ...before, ownerPrimary: { ...before.ownerPrimary, fallbackOrder: [
    { platform: 'bridge', instance: 'bridge', account: 'b_first' },
    { platform: 'bridge', instance: 'bridge#3', account: 'b_second' },
  ] } })

  const preview = async () => (await fake.call('/platforms/people')).json().resolvedSharedProactiveRoute
  const first = () => gateway.instances().find(item => item.instance === 'bridge')
  const expectSecond = async () => {
    assert.equal(first()?.state, 'connected')
    const route = await preview()
    assert.equal(route?.chatId, 'bridge#3:private:b_second')
    assert.equal(route.fallbackUsed, true)
  }
  const completeWhoami = async () => {
    whoami.resolve(firstIdentity)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(first()?.self?.account, firstIdentity.account)
    assert.equal((await preview())?.chatId, 'bridge:private:b_first')
  }

  assert.equal(first()?.self, null)
  await expectSecond()
  await completeWhoami()

  const firstAdapter = adapters.get('bridge')
  whoami = Promise.withResolvers()
  firstAdapter.disconnect()
  firstAdapter.reconnect()
  await expectSecond()
  await completeWhoami()
})
