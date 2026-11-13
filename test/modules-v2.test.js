// U1 第一段过关条件：模块接口 v2（platforms 声明与过滤 / api.caps / api.native / api.platformOf / api.sendParts / platform/state / v1 兼容与强失败）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  API_VERSION,
  MIN_API_VERSION,
  checkDef,
  createModules,
  modulePlatforms,
} from '../src/core/modules.js'
import { BUILTINS } from '../src/modules/index.js'
import groupAdminDef from '../src/modules/group-admin/index.js'
import qqApiDef from '../src/modules/qq-api/index.js'
import { createHub } from '../src/chat/hub.js'
import { createGateway } from '../src/gateway/index.js'
import { normalize } from '../src/core/config.js'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { makeFakeAdapter } from './helpers/fake-adapter.js'
import { makeIdentity } from './gateway/helpers.js'

const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return this } }

function makeHarness(t, { cfgPatch = {}, builtins = [], onebot = null, snowluma = null, gateway = null, hub: customHub = null, withRealHub = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-mod-v2-'))
  const prevDir = process.env.AURABOT_DATA_DIR
  const prevGlobal = globalThis.aurabot
  process.env.AURABOT_DATA_DIR = dir
  let cfg = normalize({ enabled: true, dryRun: false, botQQ: '20000002', ownerQQ: '10000001', ...cfgPatch })
  if ('platforms' in cfgPatch) cfg.platforms = cfgPatch.platforms
  const getConfig = () => cfg
  const setConfig = (next) => { cfg = next; return cfg }
  const dsh = createFakeDsh({ brain: async () => 'ok' })
  const hub = customHub || (withRealHub ? createHub({
    dsh: dsh.ctx,
    getConfig,
    log: silent,
    onebot,
    gateway,
    isMuted: () => false,
  }) : {
    sendText: async () => ({ message_id: 'stub-1' }),
    sendImage: async () => ({ message_id: 'stub-2' }),
    sendFile: async () => ({ message_id: 'stub-3' }),
    sendVoiceFile: async () => ({ message_id: 'stub-4' }),
    sendSegments: async () => ({ message_id: 'stub-5' }),
    deliver: async () => ({ message_id: 'stub-6' }),
    runSystemTurn: async () => 'ok',
    subagentFor: () => () => 'ok',
    turnSendersAllOwner: () => true,
  })
  const core = { hub, onebot, snowluma, gateway, local: { active: () => false }, groupRoles: { peek: () => '', get: () => null }, mutes: { muted: () => false }, ask: async () => '' }
  const mods = createModules({
    ctx: dsh.ctx,
    core,
    getConfig,
    setConfig,
    logger: silent,
    version: '1.3.0-test',
    builtins,
  })
  t.after(async () => {
    mods.dispose()
    if (withRealHub) hub.dispose?.()
    if (gateway?.stopAll) await gateway.stopAll()
    if (prevDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prevDir
    if (prevGlobal === undefined) delete globalThis.aurabot
    else globalThis.aurabot = prevGlobal
  })
  return {
    dir,
    mods,
    hub,
    core,
    getConfig,
    setConfig: (next) => { cfg = next; return cfg },
    writeUserMod(id, code) {
      const mdir = join(dir, 'modules', id)
      mkdirSync(mdir, { recursive: true })
      writeFileSync(join(mdir, 'index.mjs'), code, 'utf8')
    },
  }
}

function makeTestGateway(t, { platforms = {}, nativeHandlers = {}, ids = ['fake', 'qq'] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-mod-v2-gw-'))
  const adaptersById = new Map()
  const gateway = createGateway({
    config: { platforms },
    dataDir: (...p) => join(root, 'gw', ...p),
    http: { route: () => () => {} },
    identity: makeIdentity(),
    log: silent,
    replyHoldMs: 20,
  })
  for (const id of ids) {
    const created = []
    gateway.register(() => {
      const a = makeFakeAdapter({ id, name: `假${id}` })
      if (nativeHandlers[id]) a.native = nativeHandlers[id]
      created.push(a)
      return a
    })
    adaptersById.set(id, created)
  }
  t.after(async () => { await gateway.stopAll() })
  return { gateway, adaptersOf: (id) => adaptersById.get(id) || [] }
}

test('API_VERSION = 2 且向后兼容 MIN_API_VERSION = 1；v1 模块默认 platforms = ["qq"]', () => {
  assert.equal(API_VERSION, 2)
  assert.equal(MIN_API_VERSION, 1)
  assert.deepEqual(modulePlatforms({ id: 'old', setup() {} }), ['qq'])
  assert.deepEqual(modulePlatforms({ id: 'multi', api: 2, platforms: ['*', 'fake'], setup() {} }), ['*', 'fake'])
  assert.equal(checkDef({ id: 'old', api: 1, setup() {} }), '')
  assert.equal(checkDef({ id: 'new', api: 2, platforms: ['*'], setup() {} }), '')
  assert.match(checkDef({ id: 'bad', api: 2, platforms: [], setup() {} }), /platforms/)
  assert.match(checkDef({ id: 'bad2', api: 2, platforms: 'qq', setup() {} }), /platforms/)
  assert.match(checkDef({ id: 'future', api: 3, setup() {} }), /v3/)
})

test('内置模块平台声明完备，只开假平台时 QQ 模块跳过（「未启用对应平台」），[*] 模块全部正常运行', async (t) => {
  const expectedUniversal = ['memory', 'mood', 'purpose', 'autotelic', 'song', 'speakup', 'bili', 'voice', 'imagegen', 'video']
  const expectedQq = ['qq-api', 'qq-tools', 'qzone-social', 'diary', 'contacts', 'profile', 'stickers']
  for (const def of BUILTINS) {
    if (expectedUniversal.includes(def.id)) {
      assert.deepEqual(def.platforms, ['*'], `${def.id} 应声明 platforms: ['*']`)
    } else if (expectedQq.includes(def.id)) {
      assert.deepEqual(def.platforms, ['qq'], `${def.id} 应声明 platforms: ['qq']`)
    }
  }
  assert.deepEqual(groupAdminDef.platforms, ['qq'])

  const { gateway } = makeTestGateway(t, { platforms: { fake: { enabled: true }, qq: { enabled: false } }, ids: ['fake', 'qq'] })
  await gateway.sync()
  const { mods } = makeHarness(t, {
    cfgPatch: { platforms: { fake: { enabled: true }, qq: { enabled: false } } },
    builtins: BUILTINS,
    gateway,
  })
  await mods.boot()
  const list = mods.status()
  for (const id of expectedQq) {
    const item = list.find((m) => m.id === id)
    assert.equal(item.running, null, `只开 fake 时 ${id} 不应启动`)
    assert.equal(item.skipReason, '未启用对应平台', `${id} 应标明未启用对应平台`)
  }
  assert.equal(list.find((m) => m.id === 'mood').running, 'builtin', 'platform=["*"] 模块 mood 应照常启动')
  assert.equal(list.find((m) => m.id === 'speakup').running, 'builtin', 'platform=["*"] 模块 speakup 应照常启动')
  assert.equal(list.find((m) => m.id === 'voice').running, 'builtin', 'platform=["*"] 模块 voice 应照常启动')
})

test('按平台启停模块 & 平台开关热切换 sync：用户/内置模块随平台状态自动启停', async (t) => {
  const gwCfg = { fake: { enabled: true }, qq: { enabled: false } }
  const { gateway } = makeTestGateway(t, { platforms: gwCfg, ids: ['fake', 'qq'] })
  await gateway.sync()
  let qqSetupCount = 0
  let qqDisposeCount = 0
  let fakeDisposeCount = 0
  const builtins = [
    {
      id: 'mod-qq-only',
      name: 'QQ专属',
      api: 1, // 没写 platforms → 默认 ['qq']
      setup(api) { qqSetupCount += 1; api.onDispose(() => { qqDisposeCount += 1 }) },
    },
    {
      id: 'mod-fake-only',
      name: 'Fake专属',
      api: 2,
      platforms: ['fake'],
      setup(api) { api.onDispose(() => { fakeDisposeCount += 1 }) },
    },
  ]
  const h = makeHarness(t, { cfgPatch: { platforms: { ...gwCfg } }, builtins, gateway })
  h.writeUserMod('user-qq', "export default { id: 'user-qq', name: '用户QQ', api: 1, setup() { throw new Error('不该在无QQ时执行') } }")
  await h.mods.boot()

  assert.equal(qqSetupCount, 0)
  assert.equal(h.mods.has('mod-qq-only'), false)
  assert.equal(h.mods.has('user-qq'), false)
  assert.equal(h.mods.has('mod-fake-only'), true)
  const st0 = h.mods.status()
  assert.equal(st0.find((x) => x.id === 'mod-qq-only').skipReason, '未启用对应平台')
  assert.equal(st0.find((x) => x.id === 'user-qq').skipReason, '未启用对应平台')

  // 打开 QQ，关闭 fake → qq 模块启动（含用户 v1 模块），fake 模块自动停掉
  gwCfg.qq = { enabled: true }
  gwCfg.fake = { enabled: false }
  h.setConfig({ ...h.getConfig(), platforms: { qq: { enabled: true }, fake: { enabled: false } } })
  await gateway.sync()
  await h.mods.sync()
  // 用户模块这次不抛错了？改写成正常模块再试，验证跳过期间不报错、切开后正常跑
  h.writeUserMod('user-qq-ok', "export default { id: 'user-qq-ok', name: '用户QQ正常', api: 1, setup() { return { ok: true } } }")
  gwCfg.qq = { enabled: false }
  h.setConfig({ ...h.getConfig(), platforms: { qq: { enabled: false }, fake: { enabled: false } } })
  await gateway.sync()
  await h.mods.sync()
  assert.equal(h.mods.has('mod-qq-only'), false)
  assert.equal(fakeDisposeCount, 1)

  // user-qq-ok 在无 QQ 时首次扫描被跳过（未调 setup），打开 QQ 后无需改文件即刻启动
  assert.equal(h.mods.has('user-qq-ok'), false)
  assert.equal(h.mods.status().find((x) => x.id === 'user-qq-ok').skipReason, '未启用对应平台')
  gwCfg.qq = { enabled: true }
  h.setConfig({ ...h.getConfig(), platforms: { qq: { enabled: true }, fake: { enabled: false } } })
  await gateway.sync()
  await h.mods.sync()
  assert.equal(qqSetupCount >= 1, true)
  assert.equal(h.mods.has('mod-qq-only'), true)
  assert.equal(h.mods.has('user-qq-ok'), true)
  assert.equal(h.mods.use('user-qq-ok').ok, true)

  // 再关 QQ → 已启动的 QQ 模块应停下并释放资源
  gwCfg.qq = { enabled: false }
  h.setConfig({ ...h.getConfig(), platforms: { qq: { enabled: false }, fake: { enabled: false } } })
  await gateway.sync()
  await h.mods.sync()
  assert.equal(h.mods.has('mod-qq-only'), false)
  assert.equal(qqDisposeCount >= 1, true)
})

test('按平台过滤 hooks / tools / context / model / onebot / platform/state，且 msg 带 platform/instance/parts/person', async (t) => {
  const { gateway } = makeTestGateway(t, { platforms: { fake: { enabled: true }, qq: { enabled: true } }, ids: ['fake', 'qq'] })
  await gateway.sync()
  const logQq = { msg: [], poke: [], reply: [], model: [], activity: [], onebot: [], onebotState: [], platState: [] }
  const logFake = { msg: [], poke: [], reply: [], activity: [], onebot: [], platState: [] }
  const logAll = { msg: [], onebot: [], platState: [] }

  const builtins = [
    {
      id: 'm-qq',
      api: 2,
      platforms: ['qq'],
      setup(api) {
        api.on('message', (m) => { logQq.msg.push(m); return false })
        api.on('poke', (ev) => { logQq.poke.push(ev); return false })
        api.on('reply', (v) => { logQq.reply.push(v); return v })
        api.on('model', (sel) => { logQq.model.push(sel); return { provider: 'p-qq', model: 'm' } })
        api.on('activity', (a) => logQq.activity.push(a))
        api.on('onebot', (ev) => logQq.onebot.push(ev))
        api.on('onebot/state', (st) => logQq.onebotState.push(st))
        api.on('platform/state', (st) => logQq.platState.push(st))
        api.tool(() => api.defineTool({ name: 'tool_qq', description: 'qq', execute: async () => ({ ok: true }) }))
        api.context(() => 'CTX_QQ')
      },
    },
    {
      id: 'm-fake',
      api: 2,
      platforms: ['fake'],
      setup(api) {
        api.on('message', (m) => { logFake.msg.push(m); return false })
        api.on('poke', (ev) => { logFake.poke.push(ev); return false })
        api.on('reply', (v) => { logFake.reply.push(v); return v + '!' })
        api.on('activity', (a) => logFake.activity.push(a))
        api.on('onebot', (ev) => logFake.onebot.push(ev))
        api.on('platform/state', (st) => logFake.platState.push(st))
        api.tool(() => api.defineTool({ name: 'tool_fake', description: 'fake', execute: async () => ({ ok: true }) }))
        api.context(() => 'CTX_FAKE')
      },
    },
    {
      id: 'm-all',
      api: 2,
      platforms: ['*'],
      setup(api) {
        api.on('message', (m) => { logAll.msg.push(m); return false })
        api.on('onebot', (ev) => logAll.onebot.push(ev))
        api.on('platform/state', (st) => logAll.platState.push(st))
        api.tool(() => api.defineTool({ name: 'tool_all', description: 'all', execute: async () => ({ ok: true }) }))
        api.context(() => 'CTX_ALL')
      },
    },
  ]

  const { mods } = makeHarness(t, { cfgPatch: { platforms: { fake: { enabled: true }, qq: { enabled: true } } }, builtins, gateway })
  await mods.boot()

  const fakeMsg = {
    kind: 'private',
    chatId: 'fake:private:u_9',
    userId: 'u_9',
    groupId: '',
    nickname: '小王',
    role: '',
    messageId: 'fm-1',
    text: '你好',
    mentioned: false,
    replyId: '',
    images: [],
    stickers: [],
    records: [],
    forwards: [],
    raw: { __gateway: { chatId: 'fake:private:u_9', platform: 'fake', instance: 'fake', person: 'p-0001', parts: [{ type: 'text', text: '你好' }] } },
  }
  await mods.claim('message', fakeMsg)
  assert.equal(logQq.msg.length, 0, 'QQ 模块收不到 fake 平台消息')
  assert.equal(logFake.msg.length, 1)
  assert.equal(logAll.msg.length, 1)
  assert.equal(logFake.msg[0].platform, 'fake')
  assert.equal(logFake.msg[0].instance, 'fake')
  assert.equal(logFake.msg[0].person, 'p-0001')
  assert.deepEqual(logFake.msg[0].parts, [{ type: 'text', text: '你好' }])

  // tools / context / reply / model / poke / activity 均按平台隔离
  const fakeTools = mods.buildTools({ chat: { chatId: 'fake:private:u_9', kind: 'private' }, level: 'full', sessionId: 's1' }).map((x) => x.name)
  assert.deepEqual(fakeTools.sort(), ['tool_all', 'tool_fake'])
  const qqTools = mods.buildTools({ chat: { chatId: 'qq:private:10001', kind: 'private' }, level: 'full', sessionId: 's2' }).map((x) => x.name)
  assert.deepEqual(qqTools.sort(), ['tool_all', 'tool_qq'])

  const fakeCtx = mods.contextFor({ chat: { chatId: 'fake:group:g1', kind: 'group' }, sessionId: 's1' })
  assert.equal(fakeCtx.includes('CTX_QQ'), false)
  assert.equal(fakeCtx.includes('CTX_FAKE'), true)
  assert.equal(fakeCtx.includes('CTX_ALL'), true)

  const filteredReply = await mods.filter('reply', 'hello', { chatId: 'fake:private:u_9', userText: 'hi' })
  assert.equal(filteredReply, 'hello!')
  assert.equal(logQq.reply.length, 0)

  const fakeModel = mods.filterSync('model', { provider: 'orig', model: 'base' }, { chatId: 'fake:private:u_9', kind: 'private' })
  assert.deepEqual(fakeModel, { provider: 'orig', model: 'base' })
  assert.equal(logQq.model.length, 0)

  await mods.claim('poke', { chatId: 'fake:private:u_9', userId: 'u_9' })
  assert.equal(logQq.poke.length, 0)
  assert.equal(logFake.poke.length, 1)

  mods.emit('activity', { kind: 'in', chatId: 'fake:private:u_9', text: 'hi' })
  assert.equal(logQq.activity.length, 0)
  assert.equal(logFake.activity.length, 1)

  // onebot & onebot/state 只到声明了 'qq' 的模块（不给 ['*'] 也不给 ['fake']）
  mods.emit('onebot', { post_type: 'notice' })
  mods.emit('onebot/state', 'connected')
  assert.equal(logQq.onebot.length, 1)
  assert.equal(logQq.onebotState.length, 1)
  assert.equal(logFake.onebot.length, 0)
  assert.equal(logAll.onebot.length, 0)

  // platform/state 来自 gateway.onState，按平台过滤
  mods.emit('platform/state', { instance: 'fake', platform: 'fake', name: '假', enabled: true, state: 'reconnecting', caps: null })
  assert.equal(logQq.platState.some((s) => s.platform === 'fake'), false)
  assert.equal(logFake.platState.some((s) => s.state === 'reconnecting'), true)
  assert.equal(logAll.platState.some((s) => s.state === 'reconnecting'), true)
})

test('api.platformOf / api.caps / api.native / api.sendParts 与 hub/gateway 端到端打通', async (t) => {
  const { gateway, adaptersOf } = makeTestGateway(t, {
    platforms: { fake: { enabled: true }, qq: { enabled: true } },
    ids: ['fake', 'qq'],
    nativeHandlers: {
      fake: async (action, params) => {
        if (action === 'ping') return { pong: params }
        throw Object.assign(new Error('unsupported'), { code: 'unsupported-action' })
      },
      qq: async (action, params) => ({ qqEcho: action, params }),
    },
  })
  await gateway.sync()
  const apis = {}
  const builtins = [
    {
      id: 'mod-fake',
      api: 2,
      platforms: ['fake'],
      setup(api) { apis.fake = api },
    },
    {
      id: 'mod-all',
      api: 2,
      platforms: ['*'],
      setup(api) { apis.all = api },
    },
    {
      id: 'mod-v1',
      api: 1, // 旧 QQ 模块
      setup(api) { apis.v1 = api },
    },
  ]
  const h = makeHarness(t, {
    cfgPatch: { platforms: { fake: { enabled: true }, qq: { enabled: true } } },
    builtins,
    gateway,
    withRealHub: true,
  })
  await h.mods.boot()

  assert.equal(apis.fake.platformOf('private:10001'), 'qq')
  assert.equal(apis.fake.platformOf('feishu:group:oc_1'), 'feishu')
  assert.equal(apis.fake.platformOf('fake:private:u_1'), 'fake')
  assert.equal(apis.fake.platformOf('bad-id'), '')

  const fakeCaps = apis.fake.caps('fake:private:u_1')
  assert.equal(fakeCaps.image, true)
  assert.equal(fakeCaps.voice, 'native')

  // api.native 权限校验：仅显式声明的平台放行；['*'] 与未声明平台一律拒绝
  assert.deepEqual(await apis.fake.native('fake', 'ping', { v: 42 }), { pong: { v: 42 } })
  await assert.rejects(() => apis.fake.native('fake', 'nope'), (e) => e.code === 'unsupported-action')
  assert.throws(() => apis.fake.native('qq', 'get_login_info'), /没有在 platforms 里声明/)
  assert.throws(() => apis.all.native('fake', 'ping'), /没有在 platforms 里声明/)

  // api.sendParts 走 real hub.sendParts → gateway.send → adapter.sent
  const res = await apis.fake.sendParts('fake:private:u_1', [{ type: 'text', text: '跨平台发送成功' }], { note: 'v2-test' })
  assert.ok(res.messageId)
  const fakeRuntime = adaptersOf('fake')[1]
  assert.equal(fakeRuntime.sent.length, 1)
  assert.deepEqual(fakeRuntime.sent[0].payload.parts, [{ type: 'text', text: '跨平台发送成功' }])

  // v1 兼容：api.onebot / api.core.onebot.call → api.native('qq', ...)；api.sendSegments → api.sendParts
  assert.deepEqual(await apis.v1.onebot('get_login_info', { a: 1 }), { qqEcho: 'get_login_info', params: { a: 1 } })
  assert.deepEqual(await apis.v1.core.onebot.call('get_group_list', {}), { qqEcho: 'get_group_list', params: {} })
  await apis.v1.sendSegments('qq:private:10001', [{ type: 'text', data: { text: '旧QQ片段兼容' } }])
  const qqRuntime = adaptersOf('qq')[1]
  assert.equal(qqRuntime.sent.length, 1)
  assert.deepEqual(qqRuntime.sent[0].payload.parts, [{ type: 'text', text: '旧QQ片段兼容' }])

  // v1 模块传非 QQ chatId 给 api.sendSegments 必须强失败
  assert.throws(() => apis.v1.sendSegments('fake:private:u_1', [{ type: 'text', data: { text: 'x' } }]), /非 QQ 会话/)
  assert.throws(() => apis.v1.core.hub.sendSegments('fake:private:u_1', [{ type: 'text', data: { text: 'x' } }]), /非 QQ 会话/)

  // 未声明 'qq' 的 v2 模块调旧口必须强失败，不静默
  assert.throws(() => apis.fake.onebot('get_login_info'), /未在 platforms 中声明/)
  assert.throws(() => apis.all.core.onebot.call('get_login_info'), /未在 platforms 中声明/)
  assert.throws(() => apis.fake.core.snowluma.start(), /未在 platforms 中声明|不可用/)
  assert.throws(() => apis.all.sendSegments('qq:private:10001', [{ type: 'text', data: { text: 'x' } }]), /未在 platforms 中声明/)
  // ['*'] 读 api.core.onebot?.state 不崩（供 speakup / bili 等节流巡检用）
  assert.equal(apis.all.core.onebot.state, 'connected')
})

test('QQ 关闭时或 G3 未同步共存下的旧口强失败与回退', async (t) => {
  // 1) QQ 关闭时，连带 core.snowluma / onebot / sendSegments 全抛错，onebot.state 返回 stopped
  const snowlumaCalls = []
  const onebotCalls = []
  const { gateway: fakeOnlyGw } = makeTestGateway(t, { platforms: { fake: { enabled: true }, qq: { enabled: false } }, ids: ['fake', 'qq'] })
  await fakeOnlyGw.sync()
  let multiApi = null
  const hOff = makeHarness(t, {
    cfgPatch: { platforms: { fake: { enabled: true }, qq: { enabled: false } } },
    builtins: [{ id: 'm-both', api: 2, platforms: ['fake', 'qq'], setup(api) { multiApi = api } }],
    gateway: fakeOnlyGw,
    onebot: { state: 'connected', call: (...a) => { onebotCalls.push(a); return { ok: true } } },
    snowluma: { start: () => snowlumaCalls.push('start') },
  })
  await hOff.mods.boot()
  assert.throws(() => multiApi.onebot('get_login_info'), /QQ 平台未启用/)
  assert.throws(() => multiApi.core.onebot.call('get_login_info'), /QQ 平台未启用/)
  assert.throws(() => multiApi.core.snowluma.start(), /QQ 平台未启用/)
  assert.throws(() => multiApi.sendSegments('qq:private:10001', [{ type: 'text', data: { text: 'x' } }]), /QQ 平台未启用/)
  assert.equal(multiApi.core.onebot.state, 'stopped')
  assert.equal(onebotCalls.length, 0)
  assert.equal(snowlumaCalls.length, 0)

  // 2) G3 共存：gateway 中存在 enabled qq 但 caps === null（宿主仍在直连 core.onebot）时，api.native('qq', ...) 自动回退到 core.onebot.call
  const g3Gw = {
    instances: () => [{ instance: 'qq', platform: 'qq', name: 'QQ', enabled: true, state: 'stopped', caps: null }],
    caps: () => null,
    native: () => { throw new Error('不应直调未启动 run 的 gateway.native') },
    onState: () => () => {},
  }
  const directCalls = []
  let g3Api = null
  const hG3 = makeHarness(t, {
    cfgPatch: { platforms: { qq: { enabled: true } } },
    builtins: [{ id: 'm-g3', api: 2, platforms: ['qq'], setup(api) { g3Api = api } }],
    gateway: g3Gw,
    onebot: { state: 'connected', call: async (a, p) => { directCalls.push([a, p]); return { direct: a } } },
  })
  await hG3.mods.boot()
  assert.deepEqual(await g3Api.native('qq', 'get_login_info', { ok: 1 }), { direct: 'get_login_info' })
  assert.equal(directCalls.length, 1)
  assert.equal(g3Api.caps('qq:private:10001').voice, 'native')
})

test('QQ 内置模块收到 unsupported-action 时给出清晰失败提示而不崩溃', async (t) => {
  const { gateway } = makeTestGateway(t, {
    platforms: { qq: { enabled: true } },
    ids: ['qq'],
    nativeHandlers: {
      qq: async () => { throw Object.assign(new Error('unsupported action'), { code: 'unsupported-action' }) },
    },
  })
  await gateway.sync()
  const { mods } = makeHarness(t, {
    cfgPatch: { platforms: { qq: { enabled: true } }, allow: { groups: ['123456'], private: ['10000001'] } },
    builtins: [qqApiDef, groupAdminDef],
    gateway,
  })
  await mods.boot()

  const tools = mods.buildTools({ chat: { chatId: 'qq:group:123456', kind: 'group', groupId: '123456', userId: '10000001' }, level: 'social', sessionId: 's1' })
  const apiCallTool = tools.find((x) => x.name === 'qq_api_call')
  const adminTool = tools.find((x) => x.name === 'qq_group_admin')

  const r1 = await apiCallTool.execute({ action: 'get_essence_msg_list', param: '{"group_id":123456}' })
  assert.equal(r1.ok, false)
  assert.match(r1.message, /不支持/)

  const r2 = await adminTool.execute({ action: 'ban', group_id: '123456', user_id: '10000099', minutes: 5 })
  assert.equal(r2.ok, false)
  assert.match(r2.message, /不支持/)
})
