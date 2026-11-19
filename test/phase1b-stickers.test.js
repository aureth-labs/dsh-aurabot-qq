// Step 1B（表情库去 QQ 化）端到端测试：
// 1. 纯 Feishu（无 QQ / 无 onebot）：stickers 模块正常加载、仅在媒体能力就绪时收图至本地、不触发任何 QQ 接口、
//    api.rule 不泄漏 QQ 指令、api.context 按会话切换提示、sendSticker 自动走 Part('sticker') → sticker→image 降级、
//    Feishu 发送失败有明确回执；
// 2. QQ + Feishu 双平台并存：各自独立工具面与上下文、QQ 走 sub_type=1 原生与 sticker.sync.native 收藏导入、
//    QQ native 遇 unsupported 运行时懒降级自动触发 capsChanged 收回 qq_import_qq_stickers；
// 3. client/client.js#Stickers 在纯 Feishu vs QQ 下按活跃平台显隐 QQ 专属按钮并提示图片降级。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Script } from 'node:vm'

const DATA_ROOT = mkdtempSync(join(tmpdir(), 'aurabot-phase1b-'))
process.env.AURABOT_DATA_DIR = DATA_ROOT

const { createGateway } = await import('../src/gateway/index.js')
const { createFeishuAdapter, CAPS_FEISHU } = await import('../src/adapters/feishu/index.js')
const { createQqAdapter } = await import('../src/adapters/qq/index.js')
const { createHub } = await import('../src/chat/hub.js')
const { createModules } = await import('../src/core/modules.js')
const { default: stickersModule } = await import('../src/modules/stickers/index.js')
const { normalize } = await import('../src/core/config.js')
const { emptyFeatures } = await import('../src/gateway/features.js')
const { createFakeDsh } = await import('./helpers/fake-dsh.js')

const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return silent } }
const noopDsh = { dataDir: DATA_ROOT }

// 合法 200x200 PNG 头 + 分辨率，过 imageSize & stickerSizeOk
function makePng(salt = 1, w = 200, h = 200) {
  const b = Buffer.alloc(96)
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47
  b[4] = 0x0d; b[5] = 0x0a; b[6] = 0x1a; b[7] = 0x0a
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  b[40] = salt
  return b
}

function makeIdentity({ ownerId = 'p_owner', accounts = [] } = {}) {
  return {
    owner: () => ownerId,
    isOwner: (p) => p === ownerId,
    accountsOf: (p) => (p === ownerId ? accounts : []),
    accountOn: (p, plat) => (p === ownerId ? (accounts.find((a) => a.platform === plat)?.account || '') : ''),
    resolve: (platform, account) => {
      const hit = accounts.find((a) => a.platform === platform && String(a.account) === String(account))
      return hit ? ownerId : `p_${platform}_${account}`
    },
    lookup: (platform, personId) => (personId === ownerId ? (accounts.find((a) => a.platform === platform)?.account || null) : null),
    isValid: () => true,
  }
}

function wireHubAndStickers({ t, cfg, gateway, identity, onebot = null }) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-p1b-case-'))
  process.env.AURABOT_DATA_DIR = dir
  t.after(() => {
    process.env.AURABOT_DATA_DIR = DATA_ROOT
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })
  let curCfg = cfg
  const getConfig = () => curCfg
  const setConfig = (next) => { curCfg = next }

  let mods = null
  const use = (id) => mods?.use(id) || null
  const stickers = {
    match: (q) => use('stickers')?.match?.(q) ?? null,
    partFor: (it) => use('stickers')?.partFor?.(it) ?? null,
    segmentFor: (it) => use('stickers')?.segmentFor?.(it) ?? null,
    markUsed: (md5) => use('stickers')?.markUsed?.(md5),
    pickForReply: (txt) => use('stickers')?.pickForReply?.(txt) ?? null,
    collect: async (s, chatId) => (use('stickers')?.collect ? use('stickers').collect(s, chatId) : { ok: false, reason: '表情包模块关着' }),
    library: () => use('stickers')?.library?.() ?? { items: [] },
  }

  const hub = createHub({
    dsh: noopDsh,
    getConfig,
    log: silent,
    onebot,
    gateway,
    identity,
    stickers,
    buildTools: (where) => mods.buildTools(where),
    contextProviders: [(args) => mods.contextFor(args)],
    random: () => 0,
  })

  const core = {
    hub,
    onebot,
    gateway,
    identity,
    http: {
      query: () => ({}),
      body: async () => ({}),
      send: () => {},
    },
  }
  mods = createModules({ ctx: noopDsh, core, getConfig, setConfig, logger: silent, version: '1.3.0', builtins: [stickersModule] })
  t.after(() => {
    try { mods.dispose() } catch {}
    try { hub.disposeRecentMedia() } catch {}
    try { hub.dispose() } catch {}
  })
  return { hub, mods, core, dir, getConfig, setConfig }
}

test('Step 1B 纯飞书：无 QQ 零报错启动 stickers / 按图片降级发送 / 入站图片存表情 / 失败明确回执 / 无 QQ 规则泄漏', async (t) => {
  const gwRoot = mkdtempSync(join(tmpdir(), 'aurabot-p1b-gw-'))
  t.after(() => { try { rmSync(gwRoot, { recursive: true, force: true }) } catch {} })

  const feishuImg = makePng(7)
  const sentReqs = []
  let uploadedCount = 0
  let failSendOnce = false

  const feishuClient = {
    async request(req) {
      if (req.url.includes('tenant_access_token')) {
        return { status: 200, json: { code: 0, tenant_access_token: 'tok-f', expire: 7200 } }
      }
      if (req.url.includes('/bot/v3/info')) {
        return { status: 200, json: { code: 0, bot: { open_id: 'ou_bot_f', app_name: '飞书测试' } } }
      }
      if (req.url.includes('/open-apis/im/v1/images')) {
        uploadedCount++
        return { status: 200, json: { code: 0, data: { image_key: `img_up_${uploadedCount}` } } }
      }
      if (req.url.includes('/resources/img_in_1')) {
        return { status: 200, bytes: feishuImg, headers: { 'content-type': 'image/png' } }
      }
      if (req.url.includes('/open-apis/im/v1/messages')) {
        if (failSendOnce) {
          failSendOnce = false
          return { status: 400, json: { code: 230013, msg: 'bot has no availability' } }
        }
        sentReqs.push({ url: req.url, body: JSON.parse(req.body || '{}') })
        return { status: 200, json: { code: 0, data: { message_id: `om_out_${sentReqs.length}` } } }
      }
      return { status: 404, json: { code: 404, msg: 'not found' } }
    },
  }

  const cfg = normalize({
    enabled: true,
    dryRun: false,
    botQQ: '',
    ownerQQ: '',
    stickers: { enabled: true, collect: true, collectMode: 'auto', caption: false, autoChance: 0 },
    platforms: {
      feishu: { enabled: true, transport: 'webhook', verificationToken: 'vt', appId: 'cli_f', appSecret: 'sec_f' },
    },
  })
  const identity = makeIdentity({
    ownerId: 'p_owner',
    accounts: [{ platform: 'feishu', account: 'ou_owner' }],
  })
  const gateway = createGateway({
    config: cfg,
    dataDir: (...p) => join(gwRoot, ...p),
    http: { route: () => () => {} },
    identity,
    log: silent,
    replyHoldMs: 5,
  })
  gateway.register(() => createFeishuAdapter({ client: feishuClient }))
  await gateway.sync()
  t.after(() => gateway.stopAll())

  const { hub, mods } = wireHubAndStickers({ t, cfg, gateway, identity, onebot: null })
  await mods.boot()

  const status = mods.status().find((m) => m.id === 'stickers')
  assert.equal(status.running, 'builtin', '纯飞书环境下 stickers 必须照常启动')
  assert.deepEqual(status.errors, [], '纯飞书启动 stickers 不得有任何 QQ 报错')

  // 全局规则不得再出现 qq_import_qq_stickers / QQ 收藏
  const globalRules = mods.rules('private')
  assert.equal(globalRules.some((r) => /qq_import_qq_stickers|QQ\s*收藏/.test(r)), false, 'api.rule 不得包含 QQ 专属规则')

  // 飞书群聊工具集：无 qq_import_qq_stickers、工具名不重复、context 不泄漏 QQ 收藏
  const feishuChat = { kind: 'group', chatId: 'feishu:group:oc_1', platform: 'feishu' }
  const feishuTools = mods.buildTools({ chat: feishuChat, sessionId: 's_feishu', level: 'chat' })
  const toolNames = feishuTools.map((x) => x.name)
  assert.equal(new Set(toolNames).size, toolNames.length, '单套工具名去重无冲突')
  assert.equal(toolNames.includes('qq_send_sticker'), true)
  assert.equal(toolNames.includes('qq_list_stickers'), true)
  assert.equal(toolNames.includes('qq_edit_sticker'), true)
  assert.equal(toolNames.includes('qq_collect_sticker'), true)
  assert.equal(toolNames.includes('qq_save_sticker'), true)
  assert.equal(toolNames.includes('qq_import_qq_stickers'), false, '飞书会话绝不挂 qq_import_qq_stickers')

  const feishuCtx = mods.contextFor({ chat: feishuChat, sessionId: 's_feishu' })
  assert.match(feishuCtx, /qq_save_sticker/)
  assert.match(feishuCtx, /按图片发出/)
  assert.doesNotMatch(feishuCtx, /qq_import_qq_stickers|QQ 收藏/)

  // 飞书主人入站一张图 → recentMedia → qq_save_sticker 经 gatewayMediaBytes 拉字节存入本地库
  await hub.onGatewayMessage({
    v: 1, instance: 'feishu', platform: 'feishu', chatId: 'feishu:private:ou_owner', kind: 'private',
    chat: { kind: 'private', id: 'ou_owner' },
    sender: { account: 'ou_owner', name: '主人', role: 'owner', person: 'p_owner', isOwner: true },
    messageId: 'om_in_img', at: Date.now(), mentionedMe: false,
    parts: [{ type: 'image', media: { id: 'img_in_1', messageId: 'om_in_img' } }],
    raw: {},
  })
  hub.simulateTurn('s_save_feishu', ['ou_owner'], 'feishu')
  const privTools = mods.buildTools({ chat: { kind: 'private', chatId: 'feishu:private:ou_owner', platform: 'feishu' }, sessionId: 's_save_feishu', level: 'full' })
  const saveTool = privTools.find((x) => x.name === 'qq_save_sticker')
  const saveRes = await saveTool.execute({ name: '开心猫猫', tags: ['开心'] })
  assert.equal(saveRes.ok, true, saveRes.message)
  const libItem = mods.use('stickers').library().items[0]
  assert.equal(libItem.name, '开心猫猫')
  assert.equal(libItem.emojiId, '', '纯飞书不写 QQ emojiId')

  // 飞书发送表情：<sticker> → gateway degrade → msg_type: 'image'
  const sendTool = feishuTools.find((x) => x.name === 'qq_send_sticker')
  const sendOk = await sendTool.execute({ name: '开心猫猫' })
  assert.equal(sendOk.ok, true, sendOk.message)
  assert.equal(sentReqs.length, 1)
  assert.equal(sentReqs[0].body.msg_type, 'image', '飞书 sticker 必须经由网关降级为 image 发出')
  assert.match(sentReqs[0].body.content, /img_up_/)

  // 通过 deliver 回复标签 <sticker:开心猫猫> 同样走 Part('sticker') → sticker→image 降级发出
  await hub.deliver('feishu:group:oc_1', '<sticker:开心猫猫>')
  assert.equal(sentReqs.length, 2)
  assert.equal(sentReqs[1].body.msg_type, 'image')

  // 商城表情（带 market.emojiId 但有本地预览图）在飞书上也应按预览图降级发出
  const marketItem = { ...libItem, md5: libItem.md5 + '_m', name: '商城预览', market: { emojiId: 'm_1', packageId: 1, key: 'k' } }
  const sentMarket = await hub.sendSticker('feishu:group:oc_1', marketItem, undefined, undefined, { throwOnError: true })
  assert.equal(sentMarket, true)
  assert.equal(sentReqs.length, 3)
  assert.equal(sentReqs[2].body.msg_type, 'image')

  // 飞书发送失败时工具给明确失败回执，不假装成功
  failSendOnce = true
  const sendFail = await sendTool.execute({ name: '开心猫猫' })
  assert.equal(sendFail.ok, false)
  assert.match(sendFail.message, /发送表情失败/)

  // 飞书官方 sticker（资源不可下载）自动 collect 应优雅降级且不污染库
  const libBeforeOfficialSticker = mods.use('stickers').library().items.length
  await hub.onGatewayMessage({
    v: 1, instance: 'feishu', platform: 'feishu', chatId: 'feishu:private:ou_owner', kind: 'private',
    chat: { kind: 'private', id: 'ou_owner' },
    sender: { account: 'ou_owner', name: '主人', role: 'owner', person: 'p_owner', isOwner: true },
    messageId: 'om_in_official_stk', at: Date.now(), mentionedMe: false,
    parts: [{ type: 'sticker', media: { id: 'fk_unfetchable', messageId: 'om_in_official_stk' }, label: '[表情]' }],
    raw: {},
  })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(mods.use('stickers').library().items.length, libBeforeOfficialSticker)

  // /sticker/import-qq 在纯飞书下返回明确 unsupported
  const impRes = await mods.use('stickers').importFromQQ()
  assert.equal(impRes.ok, false)
  assert.equal(impRes.unsupported, true)
})

test('Step 1B 双平台 coexistence + QQ native 懒降级 + 不可 collect 平台工具收敛', async (t) => {
  const gwRoot = mkdtempSync(join(tmpdir(), 'aurabot-p1b-dual-'))
  t.after(() => { try { rmSync(gwRoot, { recursive: true, force: true }) } catch {} })

  const favPng = makePng(11)
  const sentOb = []
  let failAddCustomFaceUnsupported = false
  let favCalls = 0
  const fakeClient = {
    state: 'connected',
    isConnected: () => true,
    start() { queueMicrotask(() => handlers.state.forEach((f) => f('connected'))) },
    stop() { handlers.state.forEach((f) => f('stopped')) },
    on(ev, fn) { handlers[ev]?.add(fn); return () => handlers[ev]?.delete(fn) },
    off(ev, fn) { handlers[ev]?.delete(fn) },
    async call(action, params) {
      if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: 20000001, nickname: '主QQ' } }
      if (action === 'get_version_info') return { status: 'ok', retcode: 0, data: { app_name: 'NapCat', app_version: '1.0' } }
      if (action === 'can_send_image' || action === 'can_send_record') return { status: 'ok', retcode: 0, data: { yes: true } }
      if (action === 'get_friend_list' || action === 'get_group_list') return { status: 'ok', retcode: 0, data: [] }
      if (action === 'get_image') return { status: 'ok', retcode: 0, data: { base64: favPng.toString('base64') } }
      if (action === 'fetch_custom_face') {
        favCalls++
        return { status: 'ok', retcode: 0, data: ['base64://' + favPng.toString('base64')] }
      }
      if (action === 'add_custom_face') {
        if (failAddCustomFaceUnsupported) {
          throw Object.assign(new Error('unsupported action'), { data: { retcode: 1404, message: '不支持的API' } })
        }
        return { status: 'ok', retcode: 0, data: { emoji_id: 'e_qq_1' } }
      }
      if (action === 'send_private_msg' || action === 'send_group_msg') {
        sentOb.push({ action, params })
        return { status: 'ok', retcode: 0, data: { message_id: sentOb.length } }
      }
      return { status: 'ok', retcode: 0, data: {} }
    },
  }
  const handlers = { event: new Set(), state: new Set() }

  const feishuClient = {
    async request(req) {
      if (req.url.includes('tenant_access_token')) return { status: 200, json: { code: 0, tenant_access_token: 'tok-f', expire: 7200 } }
      if (req.url.includes('/bot/v3/info')) return { status: 200, json: { code: 0, bot: { open_id: 'ou_bot', app_name: 'F' } } }
      if (req.url.includes('/open-apis/im/v1/images')) return { status: 200, json: { code: 0, data: { image_key: 'ik_1' } } }
      if (req.url.includes('/open-apis/im/v1/messages')) return { status: 200, json: { code: 0, data: { message_id: 'om_dual_1' } } }
      return { status: 200, json: { code: 0, data: {} } }
    },
  }

  const textOnlyAdapter = () => ({
    id: 'textonly',
    name: '纯文本测试',
    contract: 1,
    caps: () => ({
      image: false, sticker: false, voice: false, video: false, file: false, maxFileBytes: 0,
      quoteReply: false, mention: false, mentionAll: false, poke: false, typing: false,
      recall: false, card: false, listenAllInGroup: false, proactive: 'free',
      replyWindowMs: 0, repliesPerMessage: 0, history: false, memberList: false, forwardExpand: false,
      features: emptyFeatures(),
    }),
    async start(ctx) { ctx.state('connected') },
    async stop() {},
    async whoami() { return { account: 't_bot', name: 'T' } },
    async send() { return { messageId: 'm1' } },
  })

  const cfg = normalize({
    enabled: true,
    dryRun: false,
    botQQ: '',
    ownerQQ: '',
    stickers: { enabled: true, collect: true, caption: false, autoChance: 0 },
    platforms: {
      qq: { enabled: true },
      feishu: { enabled: true, transport: 'webhook', verificationToken: 'vt', appId: 'cli_f', appSecret: 'sec_f' },
      textonly: { enabled: true },
    },
  })
  const identity = makeIdentity({
    ownerId: 'p_owner',
    accounts: [
      { platform: 'qq', account: '10000001' },
      { platform: 'feishu', account: 'ou_owner' },
    ],
  })
  const gateway = createGateway({
    config: cfg,
    dataDir: (...p) => join(gwRoot, ...p),
    http: { route: () => () => {} },
    identity,
    log: silent,
    replyHoldMs: 5,
  })
  gateway.register(() => createQqAdapter({ client: fakeClient }))
  gateway.register(() => createFeishuAdapter({ client: feishuClient }))
  gateway.register(textOnlyAdapter)
  await gateway.sync()
  await new Promise((r) => setTimeout(r, 80))
  t.after(() => gateway.stopAll())

  let capsChangedCount = 0
  gateway.onCapsChanged((ev) => { if (ev.instance === 'qq') capsChangedCount++ })

  const { hub, mods } = wireHubAndStickers({ t, cfg, gateway, identity, onebot: null })
  await mods.boot()

  const qqChat = { kind: 'private', chatId: 'qq:private:10000001', platform: 'qq' }
  const feishuChat = { kind: 'group', chatId: 'feishu:group:oc_2', platform: 'feishu' }
  const textChat = { kind: 'private', chatId: 'textonly:private:u1', platform: 'textonly' }

  // 1) 初始双平台各取各的：QQ 挂 qq_import_qq_stickers，Feishu 不挂，textOnly 连发送/收藏工具都不挂
  const qqToolsBefore = mods.buildTools({ chat: qqChat, sessionId: 's_q', level: 'full' }).map((x) => x.name)
  const feishuTools = mods.buildTools({ chat: feishuChat, sessionId: 's_f', level: 'chat' }).map((x) => x.name)
  const textTools = mods.buildTools({ chat: textChat, sessionId: 's_t', level: 'chat' }).map((x) => x.name)
  assert.equal(qqToolsBefore.includes('qq_import_qq_stickers'), true, 'QQ 探测有 fetch_custom_face 应挂导入工具')
  assert.equal(feishuTools.includes('qq_import_qq_stickers'), false, '飞书会话绝不挂 qq_import_qq_stickers')
  assert.equal(textTools.includes('qq_send_sticker'), false, '无图无表情能力平台不挂发送')
  assert.equal(textTools.includes('qq_collect_sticker'), false, '无 collect 能力平台不挂收集')
  assert.equal(textTools.includes('qq_list_stickers'), true)

  assert.match(mods.contextFor({ chat: qqChat, sessionId: 's_q' }), /qq_import_qq_stickers/)
  assert.doesNotMatch(mods.contextFor({ chat: feishuChat, sessionId: 's_f' }), /qq_import_qq_stickers/)

  // 2) QQ 会话导入并发送表情：导入调 gateway native fetch_custom_face，发送走 Part('sticker') → sub_type: 1
  hub.simulateTurn('s_q', ['10000001'])
  const importTool = mods.buildTools({ chat: qqChat, sessionId: 's_q', level: 'full' }).find((x) => x.name === 'qq_import_qq_stickers')
  const imp = await importTool.execute()
  assert.equal(imp.ok, true, imp.message)
  assert.equal(favCalls >= 1, true)
  const libItem = mods.use('stickers').library().items[0]
  libItem.name = '双平台兔'
  mods.use('stickers').rename(libItem.md5, '双平台兔')

  assert.equal(await hub.sendSticker('qq:private:10000001', '双平台兔'), true)
  assert.equal(sentOb.at(-1).params.message[0].data.sub_type, 1, 'QQ 发送标准化 Part(sticker) 必须保持 sub_type=1')
  assert.equal(await hub.sendSticker('textonly:private:u1', '双平台兔'), false, '纯文本平台发送表情返回 false')

  // 3) 运行期懒降级：add_custom_face 返回 1404 unsupported 后，capsChanged 触发，sticker.sync.native 降成 false 且 qq_import_qq_stickers 自动撤销
  failAddCustomFaceUnsupported = true
  const beforeChanges = capsChangedCount
  const addRes = await mods.use('stickers').addFromBuffer(makePng(22), { name: '触发降级', from: 'tool' })
  assert.equal(addRes.ok, true, '本地库仍应留档，不能因 QQ 云收藏失败丢掉本地图')
  assert.equal(gateway.features('qq:private:10000001')['sticker.sync.native'], false, 'unsupported 后必须立即懒降级')
  assert.equal(capsChangedCount > beforeChanges, true, '懒降级必须触发 capsChanged')
  const qqToolsAfter = mods.buildTools({ chat: qqChat, sessionId: 's_q', level: 'full' }).map((x) => x.name)
  assert.equal(qqToolsAfter.includes('qq_import_qq_stickers'), false, '降级后会话不再挂 qq_import_qq_stickers')
})

test('Step 1B 面板 client/client.js#Stickers：纯飞书隐藏 QQ 专属按钮并提示图片降级，有活跃 QQ 时正常显示', () => {
  const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const marker = '    exports.apply = apply'
  const instrumented = source.replace(marker, '    exports.p1bTest = { Stickers }\n' + marker)
  const script = new Script(instrumented, { filename: 'client/client.js' })
  const storage = new Map()
  let loader
  script.runInNewContext({
    fetch: async () => ({ json: async () => ({ ok: true }) }),
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) },
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    window: { __ModuleLoader__: { load: (v) => { loader = v } }, addEventListener() {}, removeEventListener() {} },
  })

  const renderStickers = (st) => {
    let hook = 0
    const state = []
    const React = {
      Component: class {},
      Fragment: 'fragment',
      createElement: (type, props, ...children) => {
        if (typeof type === 'function') return type({ ...(props || {}), children })
        return { type, props: props || {}, children }
      },
      useState: (initial) => {
        const i = hook++
        if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial
        return [state[i], (val) => { state[i] = typeof val === 'function' ? val(state[i]) : val }]
      },
      useEffect() {},
      useRef: (init = null) => ({ current: init }),
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
    }
    const { p1bTest } = loader.factory(() => React)
    const tree = p1bTest.Stickers({ st, draft: st.config, setDraft() {}, toast() {} })
    const texts = []
    const walk = (n) => {
      if (n == null || typeof n === 'boolean') return
      if (typeof n === 'string' || typeof n === 'number') { texts.push(String(n)); return }
      if (Array.isArray(n)) { for (const x of n) walk(x); return }
      if (typeof n === 'object') {
        if (n.props?.title) texts.push(String(n.props.title))
        if (n.props?.hint) texts.push(String(n.props.hint))
        if (n.props?.children) walk(n.props.children)
        if (n.children) walk(n.children)
      }
    }
    walk(tree)
    return texts.join('\n')
  }

  const baseCfg = {
    enabled: true,
    botQQ: '',
    stickers: { enabled: true, collect: true, faces: true, react: false, autoChance: 0.1, maxPerHour: 10, maxLibrary: 200, caption: true },
    platforms: { feishu: { enabled: true } },
  }
  const feishuOnlyText = renderStickers({
    config: baseCfg,
    onebot: { state: 'stopped' },
    platforms: [{ instance: 'feishu', platform: 'feishu', enabled: true, state: 'connected', caps: CAPS_FEISHU }],
  })
  assert.match(feishuOnlyText, /不支持原生表情包的/, '纯飞书下应提示自动按图片降级发出')
  assert.doesNotMatch(feishuOnlyText, /从 QQ 收藏导入/, '纯飞书下必须隐藏 QQ 导入按钮')
  assert.doesNotMatch(feishuOnlyText, /夹 QQ 小黄脸/, '纯飞书下应隐藏 QQ 小黄脸设置')
  assert.doesNotMatch(feishuOnlyText, /贴表情/, '纯飞书下应隐藏 QQ 专属贴表情卡')

  // P2-1：纯飞书禁用 QQ 但 st.onebot 残留 connected 时，不得误显示 QQ 同步控件
  const staleOnebotText = renderStickers({
    config: { ...baseCfg, platforms: { feishu: { enabled: true }, qq: { enabled: false } } },
    onebot: { state: 'connected' },
    platforms: [
      { instance: 'feishu', platform: 'feishu', enabled: true, state: 'connected', caps: CAPS_FEISHU },
      { instance: 'qq', platform: 'qq', enabled: false, state: 'stopped', caps: null },
    ],
  })
  assert.doesNotMatch(staleOnebotText, /从 QQ 收藏导入/, 'QQ 禁用时不得仅凭 onebot.state 露出 QQ 收藏导入')
  assert.doesNotMatch(staleOnebotText, /夹 QQ 小黄脸/)

  // P2-4 & P2-5：多 QQ 实例部分可用 + QQ stripped 实例 sticker=false 提示图片降级
  const multiQqPartialSyncText = renderStickers({
    config: { ...baseCfg, platforms: { qq: { enabled: true }, 'qq#2': { enabled: true } } },
    onebot: { state: 'stopped' },
    platforms: [
      { instance: 'qq', platform: 'qq', enabled: true, state: 'connected', caps: { image: true, sticker: false, features: { 'sticker.sync.native': true } } },
      { instance: 'qq#2', platform: 'qq', enabled: true, state: 'connected', caps: { image: true, sticker: true, features: { 'sticker.sync.native': false } } },
    ],
  })
  assert.match(multiQqPartialSyncText, /从 QQ 收藏导入/, '任一已连通 QQ 实例有 sync 能力即可显示导入')
  assert.match(multiQqPartialSyncText, /不支持原生表情包的/, 'P2-5：QQ 实例 caps.sticker=false 时也应展示图片降级提示')

  const multiQqNoSyncText = renderStickers({
    config: { ...baseCfg, platforms: { qq: { enabled: true }, 'qq#2': { enabled: true } } },
    onebot: { state: 'stopped' },
    platforms: [
      { instance: 'qq', platform: 'qq', enabled: true, state: 'connected', caps: { image: true, sticker: true, features: { 'sticker.sync.native': false } } },
      { instance: 'qq#2', platform: 'qq', enabled: true, state: 'stopped', caps: null },
    ],
  })
  assert.doesNotMatch(multiQqNoSyncText, /从 QQ 收藏导入/, 'P2-4：在跑实例不支持且另一实例停机时不应盲目显示可导入')

  const qqText = renderStickers({
    config: { ...baseCfg, platforms: { qq: { enabled: true } } },
    onebot: { state: 'stopped' },
    platforms: [{ instance: 'qq', platform: 'qq', enabled: true, state: 'connected', caps: { image: true, sticker: true, features: { 'sticker.sync.native': true } } }],
  })
  assert.match(qqText, /从 QQ 收藏导入/, '有活跃 QQ 时显示导入按钮')
  assert.match(qqText, /夹 QQ 小黄脸/)
})

test('Step 1B 宿主接线：纯飞书 host.js /sticker/upload、/sticker/import-qq 与 /stickers 全链路零报错', async (t) => {
  const hostDir = mkdtempSync(join(tmpdir(), 'aurabot-p1b-host-'))
  const prevDir = process.env.AURABOT_DATA_DIR
  const prevWs = process.env.AURABOT_WORKSPACE
  const prevGlobal = globalThis.aurabot
  process.env.AURABOT_DATA_DIR = hostDir
  process.env.AURABOT_WORKSPACE = join(hostDir, 'ws')
  mkdirSync(join(hostDir, 'ws'), { recursive: true })
  writeFileSync(join(hostDir, 'config.json'), JSON.stringify({
    enabled: true,
    dryRun: false,
    setupDone: true,
    botQQ: '',
    ownerQQ: '',
    stickers: { enabled: true, caption: false, autoChance: 0 },
    platforms: { feishu: { enabled: true } },
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
    try { rmSync(hostDir, { recursive: true, force: true }) } catch {}
  })

  await app.ready
  assert.equal(app.modules.status().find((m) => m.id === 'stickers')?.running, 'builtin')
  const up = (await fake.call('/sticker/upload', { data: makePng(99).toString('base64'), name: '飞书上传' })).json()
  assert.equal(up.ok, true, up.message)
  assert.equal(up.item.emojiId, '', '纯飞书宿主上传不写 QQ emojiId')
  const list = (await fake.call('/stickers')).json()
  assert.equal(list.items.some((x) => x.name === '飞书上传'), true)
  const imp = (await fake.call('/sticker/import-qq')).json()
  assert.equal(imp.ok, false)
  assert.equal(imp.unsupported, true)
  const part = app.stickers.partFor(up.item)
  assert.equal(part.type, 'sticker')
  assert.ok(Buffer.isBuffer(part.media.bytes))
  const stView = (await fake.call('/state')).json()
  assert.equal(stView.stickers.canQqSync, false)
})

test('Step 1B 审阅 P1：传统 QQ 直连与 G3 caps=null 下收集本机路径表情成功，referenceImage 仍保持 allowLocal=false', async (t) => {
  const localDir = mkdtempSync(join(tmpdir(), 'aurabot-p1b-local-'))
  t.after(() => { try { rmSync(localDir, { recursive: true, force: true }) } catch {} })
  const localPngPath = join(localDir, 'qq_cached_sticker.png')
  const g3PngPath = join(localDir, 'g3_cached_sticker.png')
  const legacyPng = makePng(55)
  const g3Png = makePng(66)
  writeFileSync(localPngPath, legacyPng)
  writeFileSync(g3PngPath, g3Png)

  // 1) 无 gateway + legacy onebot connected + 本地路径 segment.data.file & get_image 回本地路径
  const obCalls = []
  const legacyOb = {
    state: 'connected',
    async call(action, params) {
      obCalls.push({ action, params })
      if (action === 'get_image') return { file: localPngPath }
      if (action === 'add_custom_face') return { emoji_id: 'ob_face_1' }
      return {}
    },
  }
  const legacyCfg = normalize({
    enabled: true,
    dryRun: false,
    botQQ: '20000001',
    ownerQQ: '10000001',
    allow: { private: ['10000001'], groups: [] },
    stickers: { enabled: true, collect: true, collectMode: 'ask', fromPrivate: true, caption: false, autoChance: 0 },
  })
  const identity = makeIdentity({
    ownerId: 'p_owner',
    accounts: [{ platform: 'qq', account: '10000001' }],
  })
  const legacyRig = wireHubAndStickers({ t, cfg: legacyCfg, gateway: null, identity, onebot: legacyOb })
  legacyRig.core.stickerSync = { ready: () => true, call: (a, p, o) => legacyOb.call(a, p, o) }
  await legacyRig.mods.boot()

  const gotLegacy = await legacyRig.hub.mediaBytes('private:10000001', { type: 'image', data: { file: localPngPath, sub_type: 1 } })
  assert.deepEqual(gotLegacy, legacyPng, '传统 QQ 无网关应允许读取本机缓存路径')
  await assert.rejects(
    () => legacyRig.hub.mediaBytes('invalid-chat-id', { type: 'image', data: { file: localPngPath, sub_type: 1 } }),
    /不认识的地址|没有可用的地址/,
    'Step 1B 复审 6.3：非规范地址 (!addr) 不得默认放行本机路径',
  )

  // 注入一条含本地路径的表情，分别测 qq_collect_sticker（工具路径）与 stickers.collect（自动收集路径）
  await legacyRig.hub.onMessage({
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    self_id: 20000001,
    user_id: 10000001,
    message_id: 7001,
    sender: { user_id: 10000001, nickname: '主人' },
    message: [{ type: 'image', data: { file: 'cached_id.png', sub_type: 1 } }],
  })
  await assert.rejects(
    () => legacyRig.hub.referenceImage({ chatId: 'private:10000001' }),
    /不认识的地址|没有可用的地址/,
    'referenceImage 在传统 QQ 下仍必须维持 allowLocal=false 安全边界',
  )
  legacyRig.hub.simulateTurn('s_legacy_qq', ['10000001'], 'qq')
  const legacyCollectTool = legacyRig.mods.buildTools({
    chat: { kind: 'private', chatId: 'private:10000001', platform: 'qq' },
    sessionId: 's_legacy_qq',
    level: 'full',
  }).find((x) => x.name === 'qq_collect_sticker')
  const collectRes = await legacyCollectTool.execute({ index: 1, name: '直连本地' })
  assert.equal(collectRes.ok, true, collectRes.message)
  assert.equal(legacyRig.mods.use('stickers').library().items.some((x) => x.name === '直连本地'), true)
  assert.equal(obCalls.some((c) => c.action === 'add_custom_face'), true, '直连 QQ 收集仍同步 add_custom_face')

  const autoRes = await legacyRig.mods.use('stickers').collect({ type: 'image', data: { file: g3PngPath, sub_type: 1 } }, 'private:10000001')
  assert.equal(autoRes.ok, true, autoRes.reason)

  // 2) G3 共存：gateway 存在但 qq caps=null（回退直连 onebot），本地路径同样可读取并收集
  const g3Gw = {
    instances: () => [{ instance: 'qq', platform: 'qq', enabled: true, state: 'stopped', caps: null }],
    caps: () => null,
    features: () => emptyFeatures(),
  }
  const g3Cfg = normalize({
    enabled: true,
    dryRun: false,
    botQQ: '20000001',
    ownerQQ: '10000001',
    allow: { private: ['10000001'], groups: [] },
    platforms: { qq: { enabled: true } },
    stickers: { enabled: true, collect: true, collectMode: 'ask', fromPrivate: true, caption: false, autoChance: 0 },
  })
  const g3Rig = wireHubAndStickers({ t, cfg: g3Cfg, gateway: g3Gw, identity, onebot: legacyOb })
  g3Rig.core.stickerSync = { ready: () => true, call: (a, p, o) => legacyOb.call(a, p, o) }
  await g3Rig.mods.boot()
  const gotG3 = await g3Rig.hub.mediaBytes('qq:private:10000001', { type: 'image', data: { file: g3PngPath, sub_type: 1 } })
  assert.deepEqual(gotG3, g3Png, 'G3 caps=null 回退 onebot 应允许读取本机路径')
  const g3Auto = await g3Rig.mods.use('stickers').collect({ type: 'image', data: { file: g3PngPath, sub_type: 1 } }, 'qq:private:10000001')
  assert.equal(g3Auto.ok, true, g3Auto.reason)
})
