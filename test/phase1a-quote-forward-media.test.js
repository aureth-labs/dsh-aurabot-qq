// Phase 1 Step 1A 端到端与边界验证：
//   - 入站 self_id 不串平台（飞书不污染 QQ selfId，自回声按实例判）
//   - sentIds 按实例分桶（同名 messageId 不串台、500 上限互不挤压、queued 不写）
//   - quotedInfo 三路统一读取（quoteCache / gateway.fetch('message') / recentInbound）
//   - isBot（sender.isBot / open_id 比对 / 非 open_id 不误判）、deleted 与 230027 分层负缓存、raw 不入缓存、historyVisible 删缓存
//   - expandForwards 飞书绝不调 onebot，QQ 网关按 FetchedMessage[] 展平
//   - gatewayMediaBytes 4xx/5xx/json 错误、超大限制、SSRF 拦截、拒绝本机 r.path
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHub } from '../src/chat/hub.js'
import { createGateway } from '../src/gateway/index.js'
import { createQqAdapter } from '../src/adapters/qq/index.js'
import { createFeishuAdapter } from '../src/adapters/feishu/index.js'
import { makeIdentity } from './gateway/helpers.js'
import { normalize } from '../src/core/config.js'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { makeFakeAdapter } from './helpers/fake-adapter.js'

const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return this } }

function setupHubTest(t, { cfgPatch = {}, onebot = null, gateway = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-p1a-'))
  const prevDir = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const cfg = normalize({ enabled: true, dryRun: false, botQQ: '20000002', ownerQQ: '10000001', allow: { private: ['10000001'], groups: ['777'] }, ...cfgPatch })
  if ('platforms' in cfgPatch) cfg.platforms = cfgPatch.platforms
  const dsh = createFakeDsh({ brain: async () => 'ok' })
  const activities = []
  const hub = createHub({
    dsh: dsh.ctx,
    getConfig: () => cfg,
    log: silent,
    onebot,
    gateway,
    onActivity: (a) => activities.push(a),
    isMuted: () => false,
  })
  t.after(async () => {
    hub.dispose()
    if (gateway?.stopAll) await gateway.stopAll()
    if (prevDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prevDir
  })
  return { dir, cfg, dsh, hub, activities }
}

test('入站 self_id 不跨平台污染；sentIds 按实例分桶防同名/超限串台且 queued 不写', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-p1a-gw1-'))
  const identity = makeIdentity()

  const gateway = createGateway({
    config: {
      platforms: {
        qq: { enabled: true },
        feishu: { enabled: true },
      },
    },
    dataDir: (...p) => join(root, 'gw', ...p),
    http: { route: () => () => {} },
    identity,
    log: silent,
    replyHoldMs: 10,
  })

  const adapters = {}
  gateway.register(() => (adapters.qq = makeFakeAdapter({
    id: 'qq',
    self: { account: '20000002', name: 'QQ鱼' },
    caps: { features: { 'message.quote.read': false } },
  })))
  gateway.register(() => (adapters.feishu = makeFakeAdapter({
    id: 'feishu',
    self: { account: 'ou_feishu_bot', name: '飞书鱼' },
    caps: { features: { 'message.quote.read': false } },
  })))
  await gateway.sync()

  const onebotCalls = []
  const fakeOnebot = {
    async call(action, params) {
      onebotCalls.push({ action, params })
      if (action === 'get_msg') throw new Error('missing')
      return {}
    },
  }
  const { hub, activities } = setupHubTest(t, {
    cfgPatch: { platforms: { qq: { enabled: true }, feishu: { enabled: true } } },
    gateway,
    onebot: fakeOnebot,
  })

  // 验证 selfAccountFor 按实例取值，非默认平台绝不回退 botQQ
  assert.equal(hub.selfAccountFor('feishu:group:oc_1'), 'ou_feishu_bot')
  assert.equal(hub.selfAccountFor('qq:group:777'), '20000002')
  assert.equal(hub.selfAccountFor('unknown:private:1'), '')

  // 飞书群消息入站：绝不能改写全局 hub.selfId（QQ）
  await hub.onGatewayMessage({
    v: 1,
    instance: 'feishu',
    platform: 'feishu',
    chatId: 'feishu:group:oc_empty',
    kind: 'group',
    chat: { kind: 'group', id: 'oc_empty' },
    sender: { account: '20000002', name: '同名飞书用户', role: 'member', person: 'p_u', isOwner: false },
    messageId: 'fm_1',
    at: Date.now(),
    mentionedMe: true,
    parts: [{ type: 'text', text: 'hi' }],
    raw: {},
  })
  assert.notEqual(hub.selfId, 'ou_feishu_bot')
  // 注：飞书来信发送者 account 正好叫 '20000002'（等于 QQ botQQ）但不同于飞书 self ('ou_feishu_bot')，
  // 通过 selfAccountFor 判定不是自回声，未因 QQ botQQ 被错扔（在非白名单检查之前也没进 selfId 赋值）。

  // 1) queued 出站绝不记入 sentIds
  let nextSendResult = { messageId: 'fake-queued-id', queued: true, degraded: [] }
  const gwWrap = Object.create(gateway)
  gwWrap.send = async () => nextSendResult
  gwWrap.instances = () => gateway.instances()
  gwWrap.caps = (cid) => gateway.caps(cid)
  gwWrap.features = (cid) => gateway.features(cid)
  const h2 = setupHubTest(t, { gateway: gwWrap })

  await h2.hub.sendParts('feishu:private:ou_user1', [{ type: 'text', text: 'queued' }])
  assert.equal(await h2.hub.repliedToBot?.('fake-queued-id', { chatId: 'feishu:private:ou_user1' }) ?? false, false)

  // 2) QQ 先发 m_shared；之后飞书连发 520 条 + 也发 m_shared
  let msgSeq = 0
  let nextId = 'm_qq_keep'
  nextSendResult = { messageId: nextId, queued: false, degraded: [] }
  await h2.hub.sendParts('qq:group:777', [{ type: 'text', text: 'qq msg' }])

  for (let i = 0; i < 520; i++) {
    nextSendResult = { messageId: `feishu_only_${++msgSeq}`, queued: false, degraded: [] }
    await h2.hub.sendParts('feishu:group:oc_1', [{ type: 'text', text: String(i) }])
  }
  nextSendResult = { messageId: 'm_shared', queued: false, degraded: [] }
  await h2.hub.sendParts('feishu:group:oc_1', [{ type: 'text', text: 'feishu shared' }])

  nextSendResult = { messageId: 'm_only_feishu', queued: false, degraded: [] }
  await h2.hub.sendParts('feishu:group:oc_1', [{ type: 'text', text: 'f only' }])

  // QQ onNotice(group_msg_emoji_like)：不得误认飞书发出的 m_only_feishu，且 QQ 桶 m_qq_keep 在飞书连发 520 条后仍存活
  const day = () => h2.hub.chatLogDays().at(-1)
  const beforeLogs = day() ? h2.hub.chatLogOf(day()).length : 0
  await h2.hub.onNotice({ post_type: 'notice', notice_type: 'group_msg_emoji_like', group_id: 777, user_id: 10000001, is_add: true, message_id: 'm_only_feishu', likes: [{ emoji_id: 76 }] })
  assert.equal(day() ? h2.hub.chatLogOf(day()).length : 0, beforeLogs, 'QQ noticeText 不得把飞书消息识别为 ownMessage')

  await h2.hub.onNotice({ post_type: 'notice', notice_type: 'group_msg_emoji_like', group_id: 777, user_id: 10000001, is_add: true, message_id: 'm_qq_keep', likes: [{ emoji_id: 76 }] })
  const logsAfter = h2.hub.chatLogOf(day())
  assert.equal(logsAfter.length, beforeLogs + 1, '飞书连发 520 条后 QQ 桶 m_qq_keep 仍应被识别为 ownMessage')
  assert.match(logsAfter.at(-1).text, /点了表情回应/)

  // repliedToBot 同理按作用域隔离：
  assert.equal(await h2.hub.repliedToBot('m_only_feishu', { chatId: 'feishu:group:oc_1' }), true)
  assert.equal(await h2.hub.repliedToBot('m_only_feishu', { chatId: 'qq:group:777' }), false)
  assert.equal(await h2.hub.repliedToBot('m_qq_keep', { chatId: 'qq:group:777' }), true)

  // quotedInfo 同理按作用域/recentInbound 隔离：
  const qFeishu = await h2.hub.quotedInfo('m_only_feishu', { chatId: 'feishu:group:oc_1' })
  assert.equal(qFeishu?.ok, true)
  assert.equal(qFeishu?.isBot, true)
  const qQqMiss = await h2.hub.quotedInfo('m_only_feishu', { chatId: 'qq:group:777' })
  assert.equal(qQqMiss?.ok, false)
  assert.equal(onebotCalls.length, 0)
  assert.equal(activities.length >= 0, true)
})

test('quotedInfo 三路融合：正常 / sender_type=app / non-open_id / deleted 撤回 / 230027 分层负缓存 / raw 防泄漏 / historyVisible 删缓存 / recall 驱逐', async (t) => {
  const fetchCalls = []
  let fetchResponder = async () => ({
    messageId: 'om_ok',
    at: 1700000000000,
    sender: { account: 'ou_u1', name: '小明', isBot: false, idType: 'open_id' },
    parts: [{ type: 'text', text: '原消息' }],
    raw: { secretRawField: 'DO_NOT_LEAK' },
  })
  const fakeGw = {
    instances: () => [{ instance: 'feishu', platform: 'feishu', enabled: true, state: 'connected', self: { account: 'ou_bot_feishu' }, caps: {} }],
    caps: () => ({ quoteReply: true, proactive: 'free', features: { 'message.quote.read': true } }),
    features: () => ({ 'message.quote.read': true, 'message.forward.expand': false }),
    async fetch(chatId, req) {
      fetchCalls.push({ chatId, req })
      return fetchResponder(chatId, req)
    },
  }

  const { hub, dsh } = setupHubTest(t, {
    cfgPatch: { platforms: { feishu: { enabled: true } } },
    gateway: fakeGw,
  })
  assert.ok(dsh)

  // 1) 正常文本 + raw 防泄漏 + cached 复用不再触发 fetch
  const q1 = await hub.quotedInfo('om_ok', { chatId: 'feishu:private:ou_u1' })
  assert.equal(q1.ok, true)
  assert.equal(q1.isBot, false)
  assert.equal(q1.text, '原消息')
  assert.equal('raw' in q1, false, 'quoteCache 不得保存 raw')
  const q1Again = await hub.quotedInfo('om_ok', { chatId: 'feishu:private:ou_u1' })
  assert.equal(q1Again.ok, true)
  assert.equal(fetchCalls.length, 1, '命中 quoteCache 后不重复调用 API')

  // 2) sender_type='app'（isBot: true，即使 account='cli_x' ≠ 'ou_bot_feishu'）
  fetchResponder = async () => ({
    messageId: 'om_app',
    at: 1700000010000,
    sender: { account: 'cli_x', isBot: true, idType: 'user_id' },
    parts: [{ type: 'text', text: '机器人消息' }],
  })
  const qApp = await hub.quotedInfo('om_app', { chatId: 'feishu:group:oc_1' })
  assert.equal(qApp.isBot, true)

  // 3) 非 open_id（idType='union_id'）且 account 巧合等于实例 self，isBot 仍必须 false
  fetchResponder = async () => ({
    messageId: 'om_union',
    at: 1700000011000,
    sender: { account: 'ou_bot_feishu', isBot: false, idType: 'union_id' },
    parts: [{ type: 'text', text: '非 open_id 同串号' }],
  })
  const qUnion = await hub.quotedInfo('om_union', { chatId: 'feishu:group:oc_1' })
  assert.equal(qUnion.isBot, false, '非 open_id 不得与实例 open_id 做相等比较')

  // 4) deleted: true 返回专属撤回状态，不落成通用没读到
  fetchResponder = async () => ({
    messageId: 'om_del',
    deleted: true,
    at: 1700000012000,
    sender: { account: 'ou_u1', isBot: false },
    parts: [{ type: 'other', text: '[该消息已撤回]' }],
  })
  const qDel = await hub.quotedInfo('om_del', { chatId: 'feishu:group:oc_1' })
  assert.equal(qDel.ok, false)
  assert.equal(qDel.deleted, true)
  assert.equal(qDel.failKind, 'deleted')

  // 5) 230027 权限错先试 recentInbound 兜底；无 recentInbound 时进长冷却负缓存（二次查询不再调 fetch）
  const before230027 = fetchCalls.length
  fetchResponder = async () => { throw Object.assign(new Error('HTTP 403 / 230027: no permission'), { code: '230027' }) }
  const qPermMiss = await hub.quotedInfo('om_no_perm', { chatId: 'feishu:group:oc_1' })
  assert.equal(qPermMiss.ok, false)
  assert.equal(qPermMiss.deleted, false)
  assert.equal(qPermMiss.failKind, 'permission')
  const qPermCached = await hub.quotedInfo('om_no_perm', { chatId: 'feishu:group:oc_1' })
  assert.equal(qPermCached.failKind, 'permission')
  assert.equal(fetchCalls.length, before230027 + 1, '长冷却负缓存命中期间不得重打 fetch')

  // 5b) 若消息曾在本进程入站（recentInbound），遇到 230027 时回退命中 recentInbound（限 20 段 / 2000 字）
  const manyParts = Array.from({ length: 25 }, (_, i) => ({ type: 'text', text: `P${i}-` + 'x'.repeat(120) }))
  await hub.onGatewayMessage({
    v: 1,
    instance: 'feishu',
    platform: 'feishu',
    chatId: 'feishu:group:oc_1',
    kind: 'group',
    chat: { kind: 'group', id: 'oc_1' },
    sender: { account: 'ou_u1', name: '小明', role: 'member', person: 'p_1', isOwner: false },
    messageId: 'om_recent_rescue',
    at: 1700000020000,
    mentionedMe: false,
    parts: manyParts,
    raw: { secret: 'RAW_IN_INBOUND' },
  })
  const qRescue = await hub.quotedInfo('om_recent_rescue', { chatId: 'feishu:group:oc_1' })
  assert.equal(qRescue.ok, true)
  assert.match(qRescue.text, /^P0-/)
  assert.equal('raw' in qRescue, false)

  // 6) 撤回事件主动驱逐 recentInbound 与 quoteCache
  hub.onGatewayRecall('feishu:group:oc_1', 'om_recent_rescue')
  const callsBeforeRecallCheck = fetchCalls.length
  const qAfterRecall = await hub.quotedInfo('om_recent_rescue', { chatId: 'feishu:group:oc_1' })
  assert.equal(fetchCalls.length, callsBeforeRecallCheck + 1, '撤回后 quoteCache 已被驱逐，应重新走 API')
  assert.equal(qAfterRecall.ok, false, '撤回后 recentInbound 也被驱逐，不再回放已撤回文本')

  // 7) 命中 quoteCache 但 historyVisible 变假 → 立即删除缓存项并返回 null
  fetchResponder = async () => ({
    messageId: 'om_mem_vis',
    at: 1700000030000,
    sender: { account: 'ou_u1', name: '小明', isBot: false },
    parts: [{ type: 'text', text: '被重置前的话' }],
  })
  const qVis1 = await hub.quotedInfo('om_mem_vis', { chatId: 'feishu:private:ou_u1' })
  assert.equal(qVis1.ok, true)
  hub.resetChat('feishu:private:ou_u1', { memoryResetAt: 1700000099000 })
  const callsBeforeResetCheck = fetchCalls.length
  const qVis2 = await hub.quotedInfo('om_mem_vis', { chatId: 'feishu:private:ou_u1' })
  assert.equal(qVis2, null, '违反 historyVisible 的 quoteCache 命中必须立即删除并返回 null')
  assert.equal(fetchCalls.length, callsBeforeResetCheck, '判定在缓存读取即拦截，也不暴露旧内容')
})

test('expandForwards 隔离（Feishu 绝不调 OneBot / QQ 网关展平 FetchedMessage[]）及传统 QQ quoteFromHistory 不调 gateway.history', async (t) => {
  const gwFetches = []
  const onebotCalls = []
  const fakeOnebot = {
    async call(action, params) {
      onebotCalls.push({ action, params })
      if (action === 'get_msg') {
        return { message_id: 1, time: 1700000001, user_id: 20000002, sender: { user_id: 20000002 }, message: [{ type: 'image', data: { file: 'only-name.png' } }] }
      }
      if (action === 'get_friend_msg_history') {
        return { messages: [{ message_id: 1, time: 1700000001, sender: { user_id: 20000002 }, message: [{ type: 'image', data: { file: 'ok.png', url: 'https://qq.example/ok.png' } }] }] }
      }
      return {}
    },
  }
  const gw = {
    instances: () => [],
    caps: (cid) => (String(cid).startsWith('feishu') ? { forwardExpand: false, features: { 'message.forward.expand': false } } : { forwardExpand: true, features: { 'message.forward.expand': true } }),
    features: (cid) => (String(cid).startsWith('feishu') ? { 'message.forward.expand': false } : { 'message.forward.expand': true }),
    async fetch(chatId, req) {
      gwFetches.push({ chatId, req })
      if (req.kind === 'forward') {
        return {
          messages: [
            { messageId: 'f1', at: 1700000001000, sender: { account: 'u1', name: '甲' }, parts: [{ type: 'text', text: '转发里的话' }, { type: 'image', media: { url: 'https://img.example/f1.png' } }] },
          ],
        }
      }
      throw new Error(`unexpected fetch kind: ${req.kind}`)
    },
  }
  const { dir, hub } = setupHubTest(t, { gateway: gw, onebot: fakeOnebot })
  assert.ok(dir)

  // 1) Feishu 无 message.forward.expand：保持 [合并转发]，绝不调 onebot
  const feishuMsg = { chatId: 'feishu:group:oc_1', forwards: ['om_fwd1'], images: [], stickers: [] }
  const outFeishu = await hub.expandForwards(feishuMsg, '看 [合并转发]')
  assert.equal(outFeishu, '看 [合并转发]')
  assert.equal(onebotCalls.length, 0)

  // 2) QQ 网关打开 message.forward.expand：走 gateway.fetch('forward') 展平 FetchedMessage[] 且不依赖 onebot
  const qqFwdMsg = { chatId: 'qq:group:777', forwards: ['fwd_1'], images: [], stickers: [] }
  const outQqFwd = await hub.expandForwards(qqFwdMsg, '转发： [合并转发]')
  assert.match(outQqFwd, /转发里的话/)
  assert.equal(qqFwdMsg.images.length, 1)
  assert.equal(qqFwdMsg.images[0]?.data?.url, 'https://img.example/f1.png')
  assert.equal(onebotCalls.length, 0)

  // 3) maybeReact：飞书消息绝不调 onebot set_msg_emoji_like
  await hub.maybeReact({ chatId: 'feishu:group:oc_1', platform: 'feishu', messageId: 'om_react' })
  assert.equal(onebotCalls.filter((c) => c.action === 'set_msg_emoji_like').length, 0)

  // 4) 传统 QQ 无网关退回 onebot quoteFromHistory，且 Phase 1A 绝不调 gateway.fetch(history)
  const gwQOnly = {
    instances: () => [],
    caps: () => null, // 触发传统 QQ 无网关分支
    features: () => ({}),
    async fetch(chatId, req) {
      gwFetches.push({ chatId, req })
      throw new Error('不应在 Phase 1A 调 gateway.fetch(history)')
    },
  }
  const hTrad = setupHubTest(t, { gateway: gwQOnly, onebot: fakeOnebot })
  const qTrad = await hTrad.hub.quotedInfo('1', { chatId: 'private:10000001', userId: '10000001' })
  assert.equal(qTrad.ok, true)
  assert.equal(qTrad.images[0]?.data?.url, 'https://qq.example/ok.png', '传统 QQ 退回 onebot quoteFromHistory')
  assert.equal(gwFetches.some((x) => x.req?.kind === 'history'), false, 'Phase 1A 绝不调未归一化的 gateway.fetch(history)')
})

test('gatewayMediaBytes 全项安全校验：status>=400 提错 / 超大 / SSRF / 拒绝 r.path / 正常 bytes+base64', async (t) => {
  let mediaResp = null
  const fakeGw = {
    instances: () => [],
    caps: () => ({}),
    features: () => ({ 'media.fetch': true }),
    async fetch() {
      return typeof mediaResp === 'function' ? mediaResp() : mediaResp
    },
  }
  const { hub } = setupHubTest(t, { gateway: fakeGw })

  // 1) 4xx/5xx（含 230027 / 403 / 404）直接提取 json code/msg，绝不吞成「没有返回图片字节」
  mediaResp = { status: 403, json: { code: 230027, msg: 'no permission' }, bytes: Buffer.from([1, 2, 3]) }
  await assert.rejects(() => hub.gatewayMediaBytes('feishu:private:ou_1', { mediaId: 'img_1' }), /230027|no permission/)

  mediaResp = { status: 404, json: { msg: 'not found' } }
  await assert.rejects(() => hub.gatewayMediaBytes('feishu:private:ou_1', { mediaId: 'img_1' }), /404|not found/)

  // 2) 彻底拒绝仅含本机 r.path 的响应
  mediaResp = { path: 'C:\\Windows\\System32\\drivers\\etc\\hosts' }
  await assert.rejects(() => hub.gatewayMediaBytes('feishu:private:ou_1', { mediaId: 'img_1' }), /本机路径|拒绝/)

  // 3) SSRF 内网 URL 拒绝（localhost / 127.0.0.1 / 169.254.169.254 / file://）
  for (const badUrl of ['http://127.0.0.1:8080/x.png', 'http://169.254.169.254/latest', 'http://localhost/x.png', 'file:///etc/passwd']) {
    mediaResp = { url: badUrl }
    await assert.rejects(() => hub.gatewayMediaBytes('feishu:private:ou_1', { mediaId: 'img_1' }), /不允许|内网|本机|只允许|不认识/)
  }

  // 4) 超大 bytes 与 base64 拦截
  mediaResp = { bytes: Buffer.alloc(1024) }
  await assert.rejects(() => hub.gatewayMediaBytes('feishu:private:ou_1', { mediaId: 'img_1' }, '', { maxBytes: 512 }), /太大/)

  mediaResp = { base64: Buffer.alloc(1024).toString('base64') }
  await assert.rejects(() => hub.gatewayMediaBytes('feishu:private:ou_1', { mediaId: 'img_1' }, '', { maxBytes: 512 }), /太大/)

  // 5) 正常 bytes / Buffer / base64
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  mediaResp = { bytes: new Uint8Array(pngMagic) }
  assert.deepEqual(await hub.gatewayMediaBytes('feishu:private:ou_1', { mediaId: 'img_1' }), pngMagic)

  mediaResp = { base64: 'base64://' + pngMagic.toString('base64') }
  assert.deepEqual(await hub.gatewayMediaBytes('feishu:private:ou_1', { mediaId: 'img_1' }), pngMagic)
})

test('referenceImage(quote) 通过 gatewayMediaBytes 取飞书引用图片而不碰 onebot', async (t) => {
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const mediaCalls = []
  const onebotCalls = []
  const fakeGw = {
    instances: () => [{ instance: 'feishu', platform: 'feishu', enabled: true, state: 'connected', self: { account: 'ou_bot' }, caps: {} }],
    caps: () => ({ features: { 'message.quote.read': true, 'media.fetch': true } }),
    features: () => ({ 'message.quote.read': true, 'media.fetch': true }),
    async fetch(chatId, req) {
      if (req.kind === 'message') {
        return {
          messageId: 'om_pic',
          at: Date.now(),
          sender: { account: 'ou_u1', name: '小明', isBot: false },
          parts: [{ type: 'image', media: { id: 'img_ref_1', messageId: 'om_pic', mime: 'image/png' } }],
        }
      }
      if (req.kind === 'media') {
        mediaCalls.push({ chatId, req })
        return { bytes: pngMagic }
      }
      throw new Error('unexpected')
    },
  }
  const { hub } = setupHubTest(t, {
    gateway: fakeGw,
    onebot: { async call(a) { onebotCalls.push(a); return {} } },
  })
  const q = await hub.quotedInfo('om_pic', { chatId: 'feishu:private:ou_u1' })
  assert.equal(q.ok, true)
  const buf = await hub.referenceImage({ chatId: 'feishu:private:ou_u1' }, 'quote')
  assert.deepEqual(buf, pngMagic)
  assert.equal(mediaCalls.length, 1)
  assert.equal(mediaCalls[0].req.media.id, 'img_ref_1')
  assert.equal(onebotCalls.length, 0)
})

test('Step 1A 复审：QQ path-only 经受控目录转 bytes 打通 gatewayMediaBytes / qq+qq#2 不串 selfId / 多层嵌套转发 / G3 回退 / 飞书真实 recall / imagesOf URL 兜底', async (t) => {
  // 1) P1-1 端到端：QQ adapter 只拿到 path-only get_image → 受控目录转 bytes → hub.gatewayMediaBytes 成功
  const root = mkdtempSync(join(tmpdir(), 'aurabot-p1a-rev-'))
  const cacheDir = join(root, 'qq-cache')
  const imgFile = join(cacheDir, 'img_only_path.png')
  // 最小合法 1x1 PNG
  const png1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  )
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(imgFile, png1x1)

  const mkOneBotClient = (selfAccount, selfNick) => {
    const handlers = { event: new Set(), state: new Set() }
    return {
      state: 'connected',
      isConnected: () => true,
      start() { queueMicrotask(() => handlers.state.forEach((f) => f('connected'))) },
      stop() { handlers.state.forEach((f) => f('stopped')) },
      on(ev, fn) { handlers[ev]?.add(fn); return () => handlers[ev]?.delete(fn) },
      off(ev, fn) { handlers[ev]?.delete(fn) },
      async call(action) {
        if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: Number(selfAccount), nickname: selfNick } }
        if (action === 'get_version_info') return { status: 'ok', retcode: 0, data: { app_name: 'NapCat', app_version: '1.0' } }
        if (action === 'can_send_image' || action === 'can_send_record') return { status: 'ok', retcode: 0, data: { yes: true } }
        if (action === 'get_image') return { status: 'ok', retcode: 0, data: { file: imgFile } } // 仅 path！无 url/base64
        if (action === 'get_msg') return { status: 'ok', retcode: 0, data: { message_id: 99, time: 1700000000, user_id: 10000001, sender: { user_id: 10000001 }, message: [{ type: 'text', data: { text: 'g3 fallback' } }] } }
        return { status: 'ok', retcode: 0, data: {} }
      },
    }
  }

  const gwP1 = createGateway({
    config: {
      platforms: {
        qq: { enabled: true },
        'qq#2': { enabled: true },
        feishu: { enabled: true, transport: 'webhook', encryptKey: '', verificationToken: 'vt-real', appId: 'cli_a', appSecret: 'sec_a' },
      },
    },
    dataDir: (...p) => join(root, 'gw', ...p),
    http: { route: () => () => {} },
    identity: makeIdentity(),
    log: silent,
    replyHoldMs: 10,
  })
  let regCount = 0
  gwP1.register(() => createQqAdapter({
    client: regCount++ <= 1 ? mkOneBotClient('20000002', '主QQ') : mkOneBotClient('30000003', '副QQ'),
    mediaDirs: [cacheDir],
  }))
  let feishuFetchCount = 0
  let feishuMsgGone = false
  const feishuFakeClient = {
    async request(req) {
      if (req.url.includes('tenant_access_token')) return { status: 200, json: { code: 0, tenant_access_token: 't-1', expire: 7200 } }
      if (req.url.includes('/bot/v3/info')) return { status: 200, json: { code: 0, bot: { open_id: 'ou_bot_real', app_name: '飞书Bot' } } }
      if (req.url.includes('/open-apis/im/v1/messages/om_real_1')) {
        feishuFetchCount++
        if (feishuMsgGone) return { status: 404, json: { code: 404, msg: 'recalled/gone' } }
        return {
          status: 200,
          json: {
            code: 0,
            data: {
              items: [{
                message_id: 'om_real_1',
                create_time: '1700000000000',
                msg_type: 'text',
                body: { content: JSON.stringify({ text: '真实飞书消息' }) },
                sender: { id: 'ou_u1', id_type: 'open_id', sender_type: 'user' },
              }],
            },
          },
        }
      }
      return { status: 404, json: { code: 404, msg: 'gone' } }
    },
  }
  gwP1.register(() => createFeishuAdapter({ client: feishuFakeClient }))
  await gwP1.sync()

  // 等 qq 与 qq#2 连接 whoami 完成
  await new Promise((r) => setTimeout(r, 80))

  const legacyFallbackOb = {
    async call(action) {
      if (action === 'get_msg') {
        return { message_id: '99', time: 1700000000, user_id: 10000001, sender: { user_id: 10000001, nickname: '老QQ友' }, message: [{ type: 'text', data: { text: '来自G3 onebot回退' } }] }
      }
      return {}
    },
  }
  const { hub } = setupHubTest(t, {
    cfgPatch: {
      platforms: {
        qq: { enabled: true },
        'qq#2': { enabled: true },
        feishu: { enabled: true },
      },
    },
    gateway: gwP1,
    onebot: legacyFallbackOb,
  })
  // 模拟 host.js gatewayReady 接线 onEvent -> onGatewayRecall
  const offEvt = gwP1.onEvent((ev) => {
    if (ev.type === 'recall' && ev.messageId) hub.onGatewayRecall(ev.chatId || '', ev.messageId)
    else if (ev.type === 'native' && ev.name === 'im.message.recalled_v1' && ev.raw?.event?.message_id) {
      hub.onGatewayRecall('', ev.raw.event.message_id)
    }
  })
  t.after(() => offEvt())

  // 验证 P1-1：QQ path-only 经受控目录读出 bytes 并通过 gatewayMediaBytes
  const mediaGot = await hub.gatewayMediaBytes('qq:private:10000001', { file: 'img_only_path.png' })
  assert.deepEqual(mediaGot, png1x1)

  // 验证 P1-2：先让 qq 入站确立 hub.selfId = '20000002'，再让 qq#2 入站（self='30000003'），hub.selfId 不得被改写
  await hub.onGatewayMessage({
    v: 1, instance: 'qq', platform: 'qq', chatId: 'qq:group:777', kind: 'group',
    chat: { kind: 'group', id: '777' },
    sender: { account: '10000001', name: '主人', role: 'owner', person: 'p_1', isOwner: true },
    messageId: 'q1_m1', at: Date.now(), mentionedMe: false, parts: [{ type: 'text', text: 'hi' }], raw: {},
  })
  assert.equal(hub.selfId, '20000002')
  await hub.onGatewayMessage({
    v: 1, instance: 'qq#2', platform: 'qq', chatId: 'qq#2:group:777', kind: 'group',
    chat: { kind: 'group', id: '777' },
    sender: { account: '10000001', name: '主人', role: 'owner', person: 'p_1', isOwner: true },
    messageId: 'q2_m1', at: Date.now(), mentionedMe: false, parts: [{ type: 'text', text: 'hi2' }], raw: {},
  })
  assert.equal(hub.selfId, '20000002', 'qq#2 入站绝不能污染全局 default QQ selfId')

  // 验证 P2-6：飞书官方 im.message.recalled_v1 真实回调结构经过 gateway.onEvent → hub.onGatewayRecall 驱逐 quoteCache
  const qFeishu = await hub.quotedInfo('om_real_1', { chatId: 'feishu:group:oc_1' })
  assert.equal(qFeishu.ok, true)
  assert.equal(feishuFetchCount, 1)
  feishuMsgGone = true
  const req = {
    url: '/platform/feishu/callback',
    method: 'POST',
    headers: {},
    body: { schema: '2.0', header: { event_id: 'ev_r1', event_type: 'im.message.recalled_v1', token: 'vt-real' }, event: { message_id: 'om_real_1', chat_id: 'oc_1', recall_time: '1700000100', recall_type: 'message_owner' } },
  }
  const res = { statusCode: 200, setHeader() {}, end() {} }
  const handled = gwP1.handleHttp(req, res)
  assert.equal(handled, true)
  assert.equal(res.statusCode, 200)
  const qFeishuAfterRecall = await hub.quotedInfo('om_real_1', { chatId: 'feishu:group:oc_1' })
  assert.equal(feishuFetchCount, 2, '真实 im.message.recalled_v1 回调必须驱逐缓存并触发重新拉取')
  assert.equal(qFeishuAfterRecall.ok, false)

  // 验证 P2-1：无 onebot + gateway media.fetch=false 时 imagesOf 按 URL 兜底读取
  const gwNoMedia = {
    instances: () => [],
    caps: () => ({ features: { 'media.fetch': false } }),
    features: () => ({ 'media.fetch': false }),
  }
  const hUrl = setupHubTest(t, { gateway: gwNoMedia, onebot: null })
  const imgs = await hUrl.hub.imagesOf({
    chatId: 'qq:private:10000001',
    platform: 'qq',
    messageId: 'm_url_1',
    images: [{ type: 'image', data: { url: 'base64://' + png1x1.toString('base64') } }],
    stickers: [],
  })
  assert.equal(imgs.length, 1)
  assert.equal(imgs[0].mediaType, 'image/png')

  // 验证 P2-3：expandForwards 支持多层嵌套递归（不读 raw）
  const gwNestedFwd = {
    instances: () => [],
    caps: () => ({ forwardExpand: true, features: { 'message.forward.expand': true } }),
    features: () => ({ 'message.forward.expand': true }),
    async fetch(_cid, req) {
      if (req.id === 'outer') {
        return {
          messages: [
            { messageId: 'o1', sender: { account: 'u1', name: '甲' }, parts: [{ type: 'text', text: '外层' }, { type: 'forward', id: 'inner' }] },
          ],
        }
      }
      return {
        messages: [
          { messageId: 'i1', sender: { account: 'u2', name: '乙' }, parts: [{ type: 'text', text: '内层深处消息' }] },
        ],
      }
    },
  }
  const hNest = setupHubTest(t, { gateway: gwNestedFwd })
  const nestOut = await hNest.hub.expandForwards({ chatId: 'qq:group:777', forwards: ['outer'], images: [], stickers: [] }, '看看 [合并转发]')
  assert.match(nestOut, /外层/)
  assert.match(nestOut, /内层深处消息/)

  // 验证 P2-4 & 复审5.4：G3 默认 QQ gateway 探针未开 message.quote.read 但直连 onebot 在线时允许回退 onebot；
  // 且仅配置 quoteReply=false（发送侧能力）不应关闭入站引用读取，只有 features['message.quote.read']=false 才拦截
  const gwQuoteFalse = {
    instances: () => [],
    caps: () => ({ quoteReply: true, features: { 'message.quote.read': false } }),
    features: () => ({ 'message.quote.read': false }),
  }
  const hG3 = setupHubTest(t, {
    cfgPatch: { platforms: { qq: { enabled: true, caps: { quoteReply: false } } } },
    gateway: gwQuoteFalse,
    onebot: legacyFallbackOb,
  })
  const qG3 = await hG3.hub.quotedInfo('99', { chatId: 'qq:private:10000001', userId: '10000001' })
  assert.equal(qG3.ok, true)
  assert.equal(qG3.text, '来自G3 onebot回退')

  const hG3ReadBlocked = setupHubTest(t, {
    cfgPatch: { platforms: { qq: { enabled: true, caps: { features: { 'message.quote.read': false } } } } },
    gateway: gwQuoteFalse,
    onebot: legacyFallbackOb,
  })
  const qG3Blocked = await hG3ReadBlocked.hub.quotedInfo('99', { chatId: 'qq:private:10000001', userId: '10000001' })
  assert.equal(qG3Blocked.ok, false)
  assert.equal(qG3Blocked.failKind, 'permission')
})
