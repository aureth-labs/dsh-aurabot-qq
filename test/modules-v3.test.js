// Step 0C 过关条件：Module API v3（方案 A 生命周期 / L2 api.features+can+require / FeatureUnavailableError / 全表面过滤 / api.rule 防泄露 / onCapsChanged 100ms 去抖重挂 / 12-Part 回退）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  API_VERSION,
  FeatureUnavailableError,
  checkDef,
  createModules,
} from '../src/core/modules.js'
import { createGateway } from '../src/gateway/index.js'
import { ALL_FEATURES } from '../src/gateway/features.js'
import { partsToSegmentsFallback, segmentsToPartsFallback } from '../src/chat/part-fallback.js'
import { normalize } from '../src/core/config.js'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { makeFakeAdapter } from './helpers/fake-adapter.js'
import { makeIdentity } from './gateway/helpers.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const noopLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return this } }

function makeHarness(t, { cfgPatch = {}, builtins = [], onebot = null, gateway = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-mod-v3-'))
  const prevDir = process.env.AURABOT_DATA_DIR
  const prevGlobal = globalThis.aurabot
  process.env.AURABOT_DATA_DIR = dir
  let cfg = normalize({ enabled: true, dryRun: false, botQQ: '20000002', ownerQQ: '10000001', ...cfgPatch })
  if ('platforms' in cfgPatch) cfg.platforms = cfgPatch.platforms
  const getConfig = () => cfg
  const setConfig = (next) => { cfg = next; return cfg }
  const warns = []
  const logger = {
    debug() {},
    info() {},
    warn(...a) { warns.push(a.map(String).join(' ')) },
    error() {},
    child() { return this },
  }
  const dsh = createFakeDsh({ brain: async () => 'ok' })
  const hub = {
    sendText: async () => ({ message_id: 's1' }),
    sendImage: async () => ({ message_id: 's2' }),
    sendFile: async () => ({ message_id: 's3' }),
    sendVoiceFile: async () => ({ message_id: 's4' }),
    sendSegments: async () => ({ message_id: 's5' }),
    deliver: async () => ({ message_id: 's6' }),
    runSystemTurn: async () => 'ok',
    subagentFor: () => () => 'ok',
    turnSendersAllOwner: () => true,
  }
  const mods = createModules({
    ctx: dsh.ctx,
    core: { hub, onebot, gateway, local: { active: () => false }, groupRoles: { peek: () => '', get: () => null }, mutes: { muted: () => false }, ask: async () => '' },
    getConfig,
    setConfig,
    logger,
    version: '1.3.0-test',
    builtins,
  })
  t.after(async () => {
    mods.dispose()
    if (gateway?.stopAll) await gateway.stopAll()
    if (prevDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prevDir
    if (prevGlobal === undefined) delete globalThis.aurabot
    else globalThis.aurabot = prevGlobal
  })
  return {
    dir,
    mods,
    warns,
    getConfig,
    setConfig: (next) => { cfg = next; return cfg },
    writeUserMod(id, code) {
      const mdir = join(dir, 'modules', id)
      mkdirSync(mdir, { recursive: true })
      writeFileSync(join(mdir, 'index.mjs'), code, 'utf8')
    },
  }
}

function makeGatewayWithAdapters(t, { platforms = {}, adapters = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-mod-v3-gw-'))
  const byId = new Map()
  const gateway = createGateway({
    config: { platforms },
    dataDir: (...p) => join(root, 'gw', ...p),
    http: { route: () => () => {} },
    identity: makeIdentity(),
    log: noopLog,
    replyHoldMs: 20,
  })
  for (const spec of adapters) {
    const id = typeof spec === 'string' ? spec : spec.id
    const caps = typeof spec === 'object' ? spec.caps : undefined
    const list = []
    gateway.register(() => {
      const a = makeFakeAdapter({ id, name: `假${id}`, caps })
      list.push(a)
      return a
    })
    byId.set(id, list)
  }
  t.after(async () => { await gateway.stopAll() })
  return { gateway, adaptersOf: (id) => byId.get(id) || [] }
}

test('API_VERSION = 3 与 def.features 校验；方案 A 不因能力未满足而阻断加载或重启模块', async (t) => {
  assert.equal(API_VERSION, 3)
  assert.equal(checkDef({ id: 'okv3', api: 3, platforms: ['*'], features: { required: ['message.quote.read'], optional: ['chat.typing'] }, setup() {} }), '')
  assert.match(checkDef({ id: 'badf1', api: 3, platforms: ['*'], features: ['message.recall'], setup() {} }), /features/)
  assert.match(checkDef({ id: 'badf2', api: 3, platforms: ['*'], features: { required: 'message.recall' }, setup() {} }), /required/)
  assert.match(checkDef({ id: 'badf3', api: 3, platforms: ['*'], features: { required: ['not.a.feature'] }, setup() {} }), /未知能力键/)
  assert.match(checkDef({ id: 'badf4', api: 3, platforms: ['*'], features: { optional: ['typo.key'] }, setup() {} }), /未知能力键/)
  assert.match(checkDef({ id: 'badv4', api: 4, platforms: ['*'], setup() {} }), /v4/)

  let setups = 0
  let disposes = 0
  const modV3 = {
    id: 'quote-helper',
    name: '引用助手',
    api: 3,
    platforms: ['*'],
    features: { required: ['message.quote.read'], optional: ['chat.typing'] },
    setup(api) {
      setups++
      assert.equal(api.apiVersion, 3)
      api.onDispose(() => { disposes++ })
      return { seenFeatures: (cid) => api.features(cid) }
    },
  }
  const modQqOnly = {
    id: 'qq-only-v3',
    name: '仅QQ',
    api: 3,
    platforms: ['qq'],
    setup() {},
  }

  const { gateway, adaptersOf } = makeGatewayWithAdapters(t, {
    platforms: { fake: { enabled: true }, qq: { enabled: false } },
    adapters: [{ id: 'fake', caps: { features: { 'message.quote.read': false } } }, 'qq'],
  })
  await gateway.sync()
  const fakeAdapter = adaptersOf('fake')[0]
  // 初始断线：全部 L2 features 为 false
  fakeAdapter.disconnect()

  const { mods, setConfig } = makeHarness(t, {
    cfgPatch: { platforms: { fake: { enabled: true }, qq: { enabled: false } } },
    builtins: [modV3, modQqOnly],
    gateway,
  })
  await mods.boot()

  const st1 = mods.status()
  const quoteRow = st1.find((m) => m.id === 'quote-helper')
  const qqRow = st1.find((m) => m.id === 'qq-only-v3')
  assert.equal(quoteRow.running, 'builtin', '必需能力未满足时方案 A 仍应正常加载模块')
  assert.deepEqual(quoteRow.features, { required: ['message.quote.read'], optional: ['chat.typing'] })
  assert.equal(quoteRow.skipReason, '')
  assert.equal(qqRow.running, null)
  assert.equal(qqRow.error, '')
  assert.equal(qqRow.skipReason, '未启用对应平台')

  // 重连、能力变更、配置关停后再次 sync：模块始终保持挂载且不触发重装
  fakeAdapter.reconnect()
  fakeAdapter.setCaps({ typing: true, features: { 'message.quote.read': true } })
  setConfig({ ...normalize({ enabled: true }), platforms: { fake: { enabled: true, caps: { features: { 'message.quote.read': false } } }, qq: { enabled: false } } })
  await mods.sync()
  fakeAdapter.disconnect()
  await mods.sync()

  assert.equal(setups, 1, '方案 A 不应因能力切换或断线重连重新 setup 模块')
  assert.equal(disposes, 0, '方案 A 不应因能力切换或断线重连卸载模块')
})

test('用户模块即使禁用也保留 features 元信息到 userMeta/status', async (t) => {
  const { mods, writeUserMod } = makeHarness(t, {
    cfgPatch: { platforms: { fake: { enabled: true } }, modules: { 'u-feat': { enabled: false } } },
  })
  writeUserMod('u-feat', `export default {
    id: 'u-feat', name: '用户v3', api: 3, platforms: ['*'],
    features: { required: ['message.history.read'], optional: [] },
    setup() {},
  }`)
  await mods.boot()
  const row0 = mods.status().find((m) => m.id === 'u-feat')
  assert.equal(row0.enabled, false)

  // 开启模块使 startUser 执行并缓存 userMeta，再模拟禁用/跳过平台验证保留
  const h2 = makeHarness(t, { cfgPatch: { platforms: { fake: { enabled: true } } } })
  h2.writeUserMod('u-meta', `export default {
    id: 'u-meta', name: '用户Meta', api: 3, platforms: ['fake'],
    features: { required: ['message.quote.read'], optional: ['card.send'] },
    setup() {},
  }`)
  await h2.mods.boot()
  let row = h2.mods.status().find((m) => m.id === 'u-meta')
  assert.equal(row.running, 'user')
  assert.deepEqual(row.features, { required: ['message.quote.read'], optional: ['card.send'] })

  h2.setConfig({ ...h2.getConfig(), platforms: { fake: { enabled: false } } })
  await h2.mods.sync()
  row = h2.mods.status().find((m) => m.id === 'u-meta')
  assert.equal(row.running, null)
  assert.equal(row.skipReason, '未启用对应平台')
  assert.deepEqual(row.features, { required: ['message.quote.read'], optional: ['card.send'] })
})

test('api.features / api.can / api.require 与 FeatureUnavailableError (offline / disabled-by-config / unsupported) 及 G3 回退', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-mod-v3-gw2-'))
  const gw = createGateway({
    config: {
      platforms: {
        qq: { enabled: true },
        'qq#2': { enabled: true, caps: { memberList: false, features: { 'message.recall': false } } },
      },
    },
    dataDir: (...p) => join(root, 'gw', ...p),
    http: { route: () => () => {} },
    identity: makeIdentity(),
    log: noopLog,
    replyHoldMs: 20,
  })
  t.after(async () => { await gw.stopAll() })
  const started = new Map()
  gw.register(() => {
    const a = makeFakeAdapter({
      id: 'qq',
      caps: { recall: true, card: false, memberList: true, features: { 'message.quote.read': true, 'chat.member.read': true } },
    })
    const origStart = a.start
    a.start = (ctx) => {
      started.set(ctx.instance, a)
      return origStart(ctx)
    }
    return a
  })
  await gw.sync()

  let capturedApi = null
  const { mods } = makeHarness(t, {
    cfgPatch: {
      platforms: {
        qq: { enabled: true },
        'qq#2': { enabled: true, caps: { memberList: false, features: { 'message.recall': false } } },
      },
    },
    builtins: [{ id: 'probe', api: 3, platforms: ['*'], setup(api) { capturedApi = api } }],
    gateway: gw,
  })
  await mods.boot()

  const f1 = capturedApi.features('qq:private:1')
  assert.equal(Object.keys(f1).length, ALL_FEATURES.length)
  assert.equal(f1['message.recall'], true)
  assert.equal(f1['message.quote.read'], true)
  assert.equal(f1['card.send'], false)
  assert.equal(capturedApi.can('message.quote.read', 'qq:private:1'), true)
  assert.equal(capturedApi.can('card.send', 'qq:private:1'), false)
  assert.doesNotThrow(() => capturedApi.require('message.quote.read', 'qq:private:1'))

  // 1) unsupported（实例在线、配置未关，平台本身不支持 card.send）
  assert.throws(
    () => capturedApi.require('card.send', 'qq:private:1'),
    (e) => e instanceof FeatureUnavailableError
      && e.code === 'FEATURE_UNAVAILABLE'
      && e.reason === 'unsupported'
      && e.feature === 'card.send'
      && e.instance === 'qq',
  )

  // 2) disabled-by-config（qq#2 通过 caps.features 关闭了 message.recall，而 memberList:false 不关独立的 chat.member.read）
  assert.equal(capturedApi.can('chat.member.list', 'qq#2:group:1'), false)
  assert.equal(capturedApi.can('chat.member.read', 'qq#2:group:1'), true)
  assert.throws(
    () => capturedApi.require('message.recall', 'qq#2:group:1'),
    (e) => e instanceof FeatureUnavailableError
      && e.code === 'FEATURE_UNAVAILABLE'
      && e.reason === 'disabled-by-config'
      && e.instance === 'qq#2',
  )

  // 3) 多实例且无当前平台上下文时省略 chatId 保守返回全 false（P2-3）
  const omittedMulti = capturedApi.features()
  assert.equal(Object.values(omittedMulti).every((v) => v === false), true)

  // 4) offline（断线后触发 offline 且 features 全 false）
  started.get('qq').disconnect()
  assert.equal(capturedApi.can('message.recall', 'qq:private:1'), false)
  assert.throws(
    () => capturedApi.require('message.recall', 'qq:private:1'),
    (e) => e instanceof FeatureUnavailableError
      && e.code === 'FEATURE_UNAVAILABLE'
      && e.reason === 'offline'
      && e.instance === 'qq',
  )

  // 5) G3 旧 QQ 共存回退（P1-2 / P1-3）：按实例读 platforms[instance].caps，且无 L1 键的 6 项保持 false
  let legacyApi = null
  const legacyGw = {
    instances: () => [
      { instance: 'qq', platform: 'qq', enabled: true, state: 'stopped', caps: null },
      { instance: 'qq#2', platform: 'qq', enabled: true, state: 'stopped', caps: null },
    ],
    caps: () => null,
    features: () => ({}),
  }
  const hLegacy = makeHarness(t, {
    cfgPatch: {
      platforms: {
        qq: { enabled: true },
        'qq#2': { enabled: true, caps: { features: { 'message.recall': false } } },
      },
    },
    builtins: [{ id: 'legacy-probe', api: 3, platforms: ['qq'], setup(api) { legacyApi = api } }],
    onebot: { state: 'connected', call: async () => ({}) },
    gateway: legacyGw,
  })
  await hLegacy.mods.boot()
  assert.equal(legacyApi.can('message.quote.send', 'private:1'), true)
  assert.equal(legacyApi.can('message.recall', 'qq:private:1'), true)
  assert.equal(legacyApi.can('message.recall', 'qq#2:private:1'), false, 'qq#2 应按自身实例读取 platforms["qq#2"].caps')
  assert.throws(
    () => legacyApi.require('message.recall', 'qq#2:private:1'),
    (e) => e instanceof FeatureUnavailableError && e.reason === 'disabled-by-config' && e.instance === 'qq#2',
  )
  assert.equal(legacyApi.can('chat.member.read', 'private:1'), true, 'G3 回退按 Step 1 deriveFeatures 从 memberList 推导 chat.member.read')
  for (const unprobed of ['message.quote.read', 'message.reaction', 'media.fetch', 'sticker.collect', 'sticker.sync.native']) {
    assert.equal(legacyApi.can(unprobed, 'private:1'), false, `G3 回退无 L1 映射项 ${unprobed} 应保持 false`)
  }
  assert.throws(
    () => legacyApi.require('sticker.sync.native', 'private:1'),
    (e) => e instanceof FeatureUnavailableError && e.reason === 'unsupported' && e.instance === 'qq',
  )

  // 6) 无 gateway + onebot.state !== 'connected'（§5.3 边界）：api.features 全 false 且 require 判 offline
  let offlineLegacyApi = null
  const hOfflineLegacy = makeHarness(t, {
    cfgPatch: { platforms: { qq: { enabled: true } } },
    builtins: [{ id: 'legacy-offline-probe', api: 3, platforms: ['qq'], setup(api) { offlineLegacyApi = api } }],
    onebot: { state: 'disconnected', call: async () => ({}) },
    gateway: null,
  })
  await hOfflineLegacy.mods.boot()
  const offFeats = offlineLegacyApi.features('private:1')
  assert.equal(Object.values(offFeats).every((v) => v === false), true, '无 gateway 且 onebot 断线时 features 必须全 false')
  assert.equal(offlineLegacyApi.can('message.recall', 'private:1'), false)
  assert.throws(
    () => offlineLegacyApi.require('message.recall', 'private:1'),
    (e) => e instanceof FeatureUnavailableError && e.reason === 'offline' && e.instance === 'qq',
  )
})

test('全表面过滤：api.tool / api.context / api.command 按实例 L2 能力与平台过滤，mods.commands() 全量目录不变', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-mod-v3-gw3-'))
  const gw = createGateway({
    config: {
      platforms: {
        qq: { enabled: true },
        'qq#2': { enabled: true, caps: { features: { 'message.recall': false, 'message.quote.read': false } } },
        feishu: { enabled: true },
      },
    },
    dataDir: (...p) => join(root, 'gw', ...p),
    http: { route: () => () => {} },
    identity: makeIdentity(),
    log: noopLog,
    replyHoldMs: 20,
  })
  t.after(async () => { await gw.stopAll() })
  gw.register(() => makeFakeAdapter({ id: 'qq', caps: { recall: true, features: { 'message.quote.read': true } } }))
  gw.register(() => makeFakeAdapter({ id: 'feishu', caps: { recall: false, features: { 'message.quote.read': true } } }))
  await gw.sync()

  const { mods } = makeHarness(t, {
    cfgPatch: {
      platforms: {
        qq: { enabled: true },
        'qq#2': { enabled: true, caps: { features: { 'message.recall': false, 'message.quote.read': false } } },
        feishu: { enabled: true },
      },
    },
    builtins: [
      {
        id: 'surface-v3',
        api: 3,
        platforms: ['*'],
        setup(api) {
          api.tool(({ features }) => {
            assert.equal(typeof features, 'object')
            return features['message.recall']
              ? api.defineTool({ name: 'v3_recall', description: '撤回', execute: async () => ({ ok: true }) })
              : []
          })
          // 静态 defineTool 透传 platforms / features（P2-1 / P2-2）
          api.tool(api.defineTool({
            name: 'static_qq_recall',
            description: '静态QQ撤回',
            platforms: ['qq'],
            features: ['message.recall'],
            execute: async () => ({ ok: true }),
          }))
          api.tool(api.defineTool({
            name: 'static_feishu_only',
            description: '静态仅飞书',
            platforms: ['feishu'],
            execute: async () => ({ ok: true }),
          }))
          api.context({
            platforms: ['qq', 'feishu'],
            features: ['message.quote.read'],
            fn: ({ chat, features }) => `ctx:${chat.chatId}:${features['message.quote.read']}`,
          })
          api.command({ name: 'qqrecall', platforms: ['qq'], features: ['message.recall'], desc: 'QQ撤回命令', run: () => 'rec' })
          api.command({ name: 'unicmd', platforms: ['*'], desc: '通用命令', run: () => 'uni' })
        },
      },
    ],
    gateway: gw,
  })
  await mods.boot()

  // status() 中的 toolNames 应执行 matchesFilter 过滤（探测实例为 qq：包含 v3_recall + static_qq_recall，不含 static_feishu_only）
  const statusRow = mods.status().find((m) => m.id === 'surface-v3')
  assert.deepEqual(statusRow.tools, ['v3_recall', 'static_qq_recall'])

  // 同平台不同实例（qq vs qq#2）L2 能力隔离，且 defineTool 透传 platforms/features 生效
  const qqTools = mods.buildTools({ chat: { chatId: 'qq:group:1', kind: 'group', platform: 'qq' }, level: 'social', sessionId: 's1' })
  const qq2Tools = mods.buildTools({ chat: { chatId: 'qq#2:group:1', kind: 'group', platform: 'qq' }, level: 'social', sessionId: 's2' })
  const feishuTools = mods.buildTools({ chat: { chatId: 'feishu:group:oc1', kind: 'group', platform: 'feishu' }, level: 'social', sessionId: 's3' })
  assert.deepEqual(qqTools.map((x) => x.name), ['v3_recall', 'static_qq_recall'])
  assert.deepEqual(qq2Tools.map((x) => x.name), [])
  assert.deepEqual(feishuTools.map((x) => x.name), ['static_feishu_only'])

  // api.context 过滤 + features 注入
  assert.equal(mods.contextFor({ chat: { chatId: 'qq:group:1', kind: 'group', platform: 'qq' }, sessionId: 's1' }), 'ctx:qq:group:1:true')
  assert.equal(mods.contextFor({ chat: { chatId: 'qq#2:group:1', kind: 'group', platform: 'qq' }, sessionId: 's2' }), '', 'qq#2 缺少 message.quote.read 时跳过该 context')
  assert.equal(mods.contextFor({ chat: { chatId: 'feishu:group:oc1', kind: 'group', platform: 'feishu' }, sessionId: 's3' }), 'ctx:feishu:group:oc1:true')

  // api.command：无参全量目录（面板/权限目录） vs 带聊天上下文过滤
  assert.deepEqual(mods.commands().map((c) => c.name).sort(), ['qqrecall', 'unicmd'])
  assert.deepEqual(mods.commands({ platform: 'qq', chatId: 'qq:group:1' }).map((c) => c.name).sort(), ['qqrecall', 'unicmd'])
  assert.deepEqual(mods.commands({ platform: 'qq', chatId: 'qq#2:group:1' }).map((c) => c.name), ['unicmd'])
  assert.deepEqual(mods.commands({ platform: 'feishu', chatId: 'feishu:group:oc1' }).map((c) => c.name), ['unicmd'])
})

test('api.rule 全局预设防跨平台泄露：多平台屏蔽局部/带 features 规则，单平台向后兼容', async (t) => {
  const qqMod = {
    id: 'qq-rule',
    api: 3,
    platforms: ['qq'],
    setup(api) { api.rule(() => 'QQ 专属全局规则') },
  }
  const uniMod = {
    id: 'uni-rule',
    api: 3,
    platforms: ['*'],
    setup(api) {
      api.rule(() => '全平台共享规则')
      api.rule({ platforms: ['qq'], fn: () => '局部描述规则' })
      api.rule({ features: ['message.recall'], fn: () => '能力绑定规则' })
    },
  }

  // 场景 A：单平台 QQ 时允许 QQ 模块全局 api.rule 生效
  const single = makeHarness(t, {
    cfgPatch: { platforms: { qq: { enabled: true }, feishu: { enabled: false } } },
    builtins: [qqMod],
  })
  await single.mods.boot()
  assert.deepEqual(single.mods.rules('private'), ['QQ 专属全局规则'])

  // 场景 B：QQ + 飞书多平台共存
  const dual = makeHarness(t, {
    cfgPatch: { platforms: { qq: { enabled: true }, feishu: { enabled: true } } },
    builtins: [qqMod, uniMod],
  })
  await dual.mods.boot()
  assert.deepEqual(dual.mods.rules('private'), ['全平台共享规则'], '共享全局预设不得混入 qq-rule、局部 rule 或 features rule')
  assert.deepEqual(dual.mods.rules('private', { platform: 'qq' }), ['QQ 专属全局规则', '全平台共享规则', '局部描述规则'])
  assert.ok(dual.warns.some((w) => w.includes('qq-rule') && w.includes('api.context')))
  assert.ok(dual.warns.some((w) => w.includes('uni-rule') && w.includes('api.context')))
})

test('12 种契约 Part 回退覆盖：src/chat/part-fallback.js 全类型转 OneBot 消息段与反向还原', () => {
  const parts = [
    { type: 'reply', messageId: 'm0' },
    { type: 'text', text: 'hello' },
    { type: 'mention', account: 'all' },
    { type: 'mention', account: '10002' },
    { type: 'image', media: { url: 'https://img.example/a.png' } },
    { type: 'sticker', media: { url: 'https://stk.example/s.webp' }, label: '贴纸', native: { id: 'stk1' } },
    { type: 'voice', media: { bytes: Buffer.from('abc') } },
    { type: 'video', media: { url: 'https://v.example/a.mp4' } },
    { type: 'file', media: { url: 'https://f.example/doc.pdf', name: 'doc.pdf' } },
    { type: 'face', name: '微笑', value: '3' },
    { type: 'card', text: '分享文章：标题', title: '标题', url: 'https://card.example' },
    { type: 'forward', id: 'fwd-9' },
    { type: 'poke' },
    { type: 'other', text: '[未知卡片]' },
  ]
  const segs = partsToSegmentsFallback(parts, { faceIdOf: (n) => (n === '微笑' ? 14 : null) })
  assert.deepEqual(segs[0], { type: 'reply', data: { id: 'm0' } })
  assert.deepEqual(segs[1], { type: 'text', data: { text: 'hello' } })
  assert.deepEqual(segs[2], { type: 'at', data: { qq: 'all' } })
  assert.deepEqual(segs[3], { type: 'at', data: { qq: '10002' } })
  assert.deepEqual(segs[4], { type: 'image', data: { file: 'https://img.example/a.png' } })
  assert.deepEqual(segs[5], { type: 'image', data: { file: 'https://stk.example/s.webp', sub_type: 1, summary: '贴纸' } })
  assert.equal(segs[6].type, 'record')
  assert.match(segs[6].data.file, /^base64:\/\//)
  assert.deepEqual(segs[7], { type: 'video', data: { file: 'https://v.example/a.mp4' } })
  assert.deepEqual(segs[8], { type: 'file', data: { file: 'https://f.example/doc.pdf', name: 'doc.pdf' } })
  assert.deepEqual(segs[9], { type: 'face', data: { id: '14', resultId: '3' } })
  assert.deepEqual(segs[10], { type: 'text', data: { text: '分享文章：标题 https://card.example' } })
  assert.deepEqual(segs[11], { type: 'text', data: { text: '[合并转发 #fwd-9]' } })
  assert.deepEqual(segs[12], { type: 'poke', data: {} })
  assert.deepEqual(segs[13], { type: 'text', data: { text: '[未知卡片]' } })

  // 反向 segmentsToPartsFallback 验证 poke / face / at / text
  const round = segmentsToPartsFallback([
    { type: 'text', data: { text: 'hi' } },
    { type: 'at', data: { qq: 'all' } },
    { type: 'poke', data: {} },
    { type: 'forward', data: { id: 'f1' } },
  ])
  assert.deepEqual(round, [
    { type: 'text', text: 'hi' },
    { type: 'mention', account: 'all' },
    { type: 'poke' },
    { type: 'forward', id: 'f1' },
  ])
})

test('宿主接线：gw.onCapsChanged 100ms 去抖触发 hub.remountAll，/modules/simulate 命令过滤而 /commands 全量', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aurabot-host-v3-'))
  const prevDir = process.env.AURABOT_DATA_DIR
  const prevWs = process.env.AURABOT_WORKSPACE
  const prevGlobal = globalThis.aurabot
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mkdirSync(join(dataDir, 'modules', 'v3cmd'), { recursive: true })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    dryRun: false,
    setupDone: true,
    ownerQQ: '10000001',
    botQQ: '20000002',
    allow: { private: ['10000001'], groups: ['777'] },
    platforms: { fake: { enabled: true }, qq: { enabled: false } },
  }))
  writeFileSync(join(dataDir, 'modules', 'v3cmd', 'index.mjs'), `export default {
    id: 'v3cmd', name: 'V3命令', api: 3, platforms: ['*'],
    setup(api) {
      api.command({ name: 'onlyrecall', platforms: ['fake'], features: ['message.recall'], desc: '仅fake撤回', run: () => 'recall-ok' })
      api.command({ name: 'anycmd', platforms: ['*'], desc: '全平台命令', run: () => 'any-ok' })
    },
  }`)

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
  let fakeAdapter = null
  app.gateway.register(() => (fakeAdapter = makeFakeAdapter({
    id: 'fake',
    caps: { recall: false, features: { 'message.recall': false } },
  })))
  await app.gateway.sync()

  // 1) /commands 保持全量目录不受当前实例关闭 recall 的影响
  const allCmds = (await fake.call('/commands')).json().list
  assert.ok(allCmds.some((c) => c.name === 'onlyrecall'))
  assert.ok(allCmds.some((c) => c.name === 'anycmd'))

  // 2) /modules/simulate 在 recall=false 时不匹配 onlyrecall，开启 recall=true 后可命中
  const simOff = (await fake.call('/modules/simulate', { as: 'owner', kind: 'private', platform: 'fake', text: '/onlyrecall' })).json()
  assert.equal(simOff.sent.length, 0)
  assert.match(simOff.steps.join('\n'), /没有模块接管/)

  // 3) 连续触发 3 次 setCaps → 100ms 去抖后合并调用 1 次 hub.remountAll('平台能力变化')
  const remountCalls = []
  const origRemount = app.hub.remountAll
  app.hub.remountAll = (reason) => {
    remountCalls.push(reason)
    return origRemount(reason)
  }

  fakeAdapter.setCaps({ typing: true })
  fakeAdapter.setCaps({ history: true })
  fakeAdapter.setCaps({ recall: true, features: { 'message.recall': true } })
  assert.equal(remountCalls.length, 0, '100ms 去抖期内不应立即重挂')
  await sleep(180)
  assert.equal(remountCalls.length, 1, '连续能力变化应在 100ms 后合并成 1 次 remountAll')
  assert.equal(remountCalls[0], '平台能力变化')

  const simOn = (await fake.call('/modules/simulate', { as: 'owner', kind: 'private', platform: 'fake', text: '/onlyrecall' })).json()
  assert.ok(simOn.sent.some((s) => s.text === 'recall-ok'))
})
