// G2 · QQ 平台端测试：契约测试包 + 能力探测 + 入站解析 + 错误映射
// 契约依据：src/gateway/contracts.d.ts、docs/CONTRACTS.md §七/§八；平台端通用包：test/contract/adapter-kit.js
// 全部用可注入的假 OneBot client，绝不真连网。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAdapterContract, makeCtx } from '../contract/adapter-kit.js'
import { createQqAdapter } from '../../src/adapters/qq/index.js'
import { parseMessageEvent } from '../../src/chat/inbound.js'

// ───────────────────────── 假 OneBot client ─────────────────────────
// 形状照 src/onebot/client.js 的对外面：call(action, params, opts)、on/off、stop
function makeFakeClient(opts = {}) {
  const calls = []
  const listeners = { event: new Set(), state: new Set() }
  const caps = opts.caps || {}
  const failNext = new Map()
  let started = false

  const client = {
    calls,
    state: 'disconnected',
    isConnected() { return client.state === 'connected' },
    started: () => started,
    /** 平台端 start 时调 client.start() */
    start() {
      started = true
      client.state = 'connected'
      queueMicrotask(() => { for (const fn of listeners.state) fn('connected') })
    },
    stop() {
      started = false
      client.state = 'stopped'
      for (const fn of listeners.state) fn('stopped')
    },
    on(name, fn) { listeners[name]?.add(fn); return () => listeners[name]?.delete(fn) },
    off(name, fn) { listeners[name]?.delete(fn) },
    /** 主动推一条 OneBot 事件（模拟网关推送） */
    push(event) { for (const fn of listeners.event) fn(event) },
    failOnce(action, error) { failNext.set(action, error) },
    async call(action, params, callOpts = {}) {
      calls.push({ action, params })
      if (failNext.has(action)) {
        const err = failNext.get(action)
        failNext.delete(action)
        throw err
      }
      return respond(action, params, caps, callOpts)
    },
  }
  return client
}

/** 各动作的假响应（决定能力探测结果） */
function respond(action, params, caps, opts) {
  const ok = (data) => ({ status: 'ok', retcode: 0, data })
  if (failNextHas(caps, action)) return Promise.reject(Object.assign(new Error(`不支持的 ${action}`), { transport: true, code: 'unsupported' }))
  switch (action) {
    case 'get_login_info': return ok({ user_id: 10000, nickname: '假机器人' })
    case 'get_version_info': return ok({ app_name: caps.appName || 'SnowLuma', app_version: 'v2.4.1', protocol_version: 'v11' })
    case 'send_private_msg': return ok({ message_id: 900 + (params.user_id || 0) % 100 })
    case 'send_group_msg': return ok({ message_id: 800 + (params.group_id || 0) % 100 })
    case 'upload_private_file': return ok({ file_id: 'pf-1' })
    case 'upload_group_file': return ok({ file_id: 'gf-1' })
    // 扩展动作：caps 里声明了才支持
    case 'get_group_msg_history':
    case 'get_friend_msg_history':
    case 'get_msg':
    case 'send_poke':
    case 'set_input_status':
    case 'get_group_member_info':
    case 'get_friend_list':
    case 'get_group_list':
    case 'get_group_member_list':
    case 'get_stranger_info': {
      if (caps.ext === false) return Promise.reject(Object.assign(new Error('unsupported'), { transport: true }))
      return ok({ messages: [], list: [], user_id: 1, nickname: 'x' })
    }
    case 'get_qzone_list':
    case 'get_sticker_list':
    case 'delete_sticker': {
      if (caps.snowluma !== true) return Promise.reject(Object.assign(new Error('unsupported'), { transport: true, code: 'unsupported' }))
      return ok({ list: [] })
    }
    default:
      if (opts.actionStub && typeof opts.actionStub === 'function') return opts.actionStub(action, params)
      return ok({})
  }
}

function failNextHas() { return false }

// ───────────────────────── harness ─────────────────────────

function makeHarness() {
  return {
    makeAdapter() {
      const client = makeFakeClient()
      const adapter = createQqAdapter({ client, fs: fakeFs() })
      adapter.__fakeClient = client
      return adapter
    },
    async injectInbound(adapter, ctx) {
      adapter.__fakeClient.push({
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        time: Math.floor(Date.now() / 1000),
        self_id: 10000,
        user_id: 10001,
        message_id: 12345,
        raw_message: '来自 QQ',
        message: [{ type: 'text', data: { text: '来自 QQ' } }],
        sender: { user_id: 10001, nickname: '张三' },
      })
    },
    async injectUnverified(adapter, ctx) {
      // QQ 平台端走 WS 推送，没有回调验签：这条用「未知事件」表示拒绝（不 emit）
      adapter.__fakeClient.push({ post_type: 'notice', notice_type: 'client_status', online: false })
    },
    async injectSigned(adapter, ctx) {
      await this.injectInbound(adapter, ctx)
    },
    setProactive(adapter, value) {
      adapter.__setCapsForTest({ proactive: value })
    },
    failSend(adapter, why) {
      const error = why === 'refused'
        ? Object.assign(new Error('连不上'), { transport: true, code: 'ECONNREFUSED' })
        : Object.assign(new Error('超时'), { uncertain: true, code: 'ETIMEDOUT' })
      adapter.__fakeClient.failOnce('send_private_msg', error)
    },
    reconnect(adapter, ctx) {
      adapter.__fakeClient.push({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect' })
      ctx.state('connected')
    },
  }
}

/** 假的 fs（caps.json 落到内存） */
function fakeFs() {
  const files = new Map()
  return {
    readFileSync: (p) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p) },
    writeFileSync: (p, data) => { files.set(p, data) },
    existsSync: (p) => files.has(p),
    files,
  }
}

// ───────────────────────── 契约测试包 ─────────────────────────

test('QQ 平台端过全套契约（runAdapterContract）', async () => {
  const h = makeHarness()
  await runAdapterContract(h.makeAdapter, h)
})

// ───────────────────────── 能力探测 ─────────────────────────

test('能力探测：探测前最保守，探测后按实际网关能力调 capsChanged', async () => {
  const h = makeHarness()
  const adapter = h.makeAdapter()
  const ctx = makeCtx(adapter)
  // 探测前
  const before = adapter.caps()
  assert.equal(before.image, true, 'QQ 标准能力（发图）探测前后都该是 true')

  await adapter.start(ctx)
  // 探测在 afterConnect 里异步跑，等它落定
  await new Promise((r) => setTimeout(r, 60))

  const after = adapter.caps()
  // 标准 OneBot 能力
  assert.equal(after.image, true)
  assert.equal(after.quoteReply, true)
  assert.equal(after.mention, true)
  // 扩展动作（假 client 支持）
  assert.equal(after.history, true, '历史消息探测成功 → history=true')
  assert.equal(after.poke, true, '戳一戳探测成功 → poke=true')
  assert.equal(after.memberList, true)
  assert.ok(ctx.capsChanges >= 1, '探测完要调 capsChanged')
  await adapter.stop()
})

test('能力探测：网关不支持扩展动作时对应 cap 为 false', async () => {
  const h = makeHarness()
  const client = makeFakeClient({ caps: { ext: false, snowluma: false } })
  const adapter = createQqAdapter({ client, fs: fakeFs() })
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  await new Promise((r) => setTimeout(r, 80))
  const caps = adapter.caps()
  assert.equal(caps.history, false, '不支持历史 → false（面板显示「当前网关不支持」）')
  assert.equal(caps.poke, false)
  assert.equal(caps.image, true, '标准能力不受影响')
  await adapter.stop()
})

test('能力探测：SnowLuma 专有能力只在探测到时开启', async () => {
  // 用了 SnowLuma
  const withSl = createQqAdapter({ client: makeFakeClient({ caps: { snowluma: true } }), fs: fakeFs() })
  const ctx1 = makeCtx(withSl)
  await withSl.start(ctx1)
  await new Promise((r) => setTimeout(r, 80))
  await withSl.stop()
  // 没用（NapCat 之类）
  const without = createQqAdapter({ client: makeFakeClient({ caps: { snowluma: false } }), fs: fakeFs() })
  const ctx2 = makeCtx(without)
  await without.start(ctx2)
  await new Promise((r) => setTimeout(r, 80))
  // 两者的差异应体现在返回的 caps 上（具体字段以 probe.js 的判定为准，这里只要求「探测到才开」）
  const a = withSl.__probeSummary ? withSl.__probeSummary() : null
  const b = without.__probeSummary ? without.__probeSummary() : null
  if (a && b) assert.ok((a.unsupported?.length || 0) <= (b.unsupported?.length || 0), 'SnowLuma 上不支持的项不应更多')
  await without.stop()
})

// ───────────────────────── 入站解析一致性 ─────────────────────────

test('入站：OneBot 事件转 AdapterInbound，与 inbound.js parseMessageEvent 口径一致', async () => {
  const h = makeHarness()
  const adapter = h.makeAdapter()
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  const event = {
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    time: 1700000000,
    self_id: 10000,
    group_id: 20001,
    user_id: 10001,
    message_id: 777,
    message: [
      { type: 'text', data: { text: '看这个' } },
      { type: 'image', data: { url: 'https://x/a.png', file: 'a.png' } },
      { type: 'at', data: { qq: '10002', name: '李四' } },
    ],
    sender: { user_id: 10001, nickname: '张三', card: '老张', role: 'member' },
  }
  adapter.__fakeClient.push(event)
  await new Promise((r) => setTimeout(r, 20))

  assert.equal(ctx.emitted.length, 1)
  const got = ctx.emitted[0]
  // 与现 inbound.js 的解析对照
  const ref = parseMessageEvent(event, { selfId: 10000 })
  assert.equal(got.chat.kind, 'group')
  assert.equal(got.chat.id, '20001')
  assert.equal(got.sender.account, '10001')
  assert.equal(got.messageId, '777')
  assert.equal(got.at, 1700000000000, 'at 是毫秒时间戳')
  assert.ok(Array.isArray(got.parts) && got.parts.length >= 2, '文字和图片都要进 parts')
  assert.equal(got.parts[0].type, 'text')
  // 具体字段与现解析一致（parts 的类型序列）
  if (ref && Array.isArray(ref.parts)) {
    assert.deepEqual(got.parts.map((p) => p.type), ref.parts.map((p) => p.type), 'parts 类型序列应与 parseMessageEvent 一致')
  }
  await adapter.stop()
})

test('入站：@机器人自己体现在 mentionedMe，不进 parts', async () => {
  const h = makeHarness()
  const adapter = h.makeAdapter()
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  await new Promise((r) => setTimeout(r, 60)) // 等 whoami 拿到 selfId
  adapter.__fakeClient.push({
    post_type: 'message',
    message_type: 'group',
    time: 1700000000,
    self_id: 10000,
    group_id: 20001,
    user_id: 10001,
    message_id: 778,
    message: [
      { type: 'at', data: { qq: '10000' } },
      { type: 'text', data: { text: ' 在吗' } },
    ],
    sender: { user_id: 10001, nickname: '张三' },
  })
  await new Promise((r) => setTimeout(r, 20))
  const got = ctx.emitted.at(-1)
  assert.equal(got.mentionedMe, true, '@机器人自己必须体现在 mentionedMe')
  assert.ok(!got.parts.some((p) => p.type === 'mention' && p.account === '10000'), '@自己不出现在 parts 里')
  await adapter.stop()
})

test('入站：机器人自己发的消息走 emitEvent(self-sent) 而不是 emit', async () => {
  const h = makeHarness()
  const adapter = h.makeAdapter()
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  await new Promise((r) => setTimeout(r, 60))
  const beforeEmit = ctx.emitted.length
  const beforeEvents = ctx.events.length
  // OneBot v11：机器人自己发的消息是 post_type='message_sent'（不是 message + self_id 相同）
  adapter.__fakeClient.push({
    post_type: 'message_sent',
    message_type: 'private',
    sub_type: 'friend',
    time: 1700000000,
    self_id: 10000,
    user_id: 10001,
    target_id: 10001,
    message_id: 779,
    message: [{ type: 'text', data: { text: '她自己说的' } }],
    sender: { user_id: 10000, nickname: '假机器人' },
  })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(ctx.emitted.length, beforeEmit, '自己发的消息不能进 emit（否则会写进记忆当成别人说的）')
  assert.ok(ctx.events.length > beforeEvents, '要走 emitEvent')
  assert.equal(ctx.events.at(-1).type, 'self-sent')
  await adapter.stop()
})

// ───────────────────────── 错误映射 ─────────────────────────

test('错误映射：transport → not-sent；uncertain → unknown（绝不重发）', async () => {
  const h = makeHarness()
  const adapter = h.makeAdapter()
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  await new Promise((r) => setTimeout(r, 60))

  adapter.__fakeClient.failOnce('send_private_msg', Object.assign(new Error('连不上'), { transport: true }))
  await assert.rejects(
    () => adapter.send({ chat: { kind: 'private', id: '10001' }, parts: [{ type: 'text', text: 'x' }], kind: 'reply', note: '' }),
    (e) => e.certainty === 'not-sent',
    'transport 失败 = 确定没发出去 = not-sent',
  )

  adapter.__fakeClient.failOnce('send_private_msg', Object.assign(new Error('读不懂响应'), { uncertain: true }))
  await assert.rejects(
    () => adapter.send({ chat: { kind: 'private', id: '10001' }, parts: [{ type: 'text', text: 'y' }], kind: 'reply', note: '' }),
    (e) => e.certainty === 'unknown',
    'uncertain = 拿不准 = unknown（绝不重发）',
  )
  await adapter.stop()
})

test('出站：私聊/群聊分别调 send_private_msg / send_group_msg', async () => {
  const h = makeHarness()
  const adapter = h.makeAdapter()
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  await new Promise((r) => setTimeout(r, 60))

  const r1 = await adapter.send({ chat: { kind: 'private', id: '10001' }, parts: [{ type: 'text', text: '私聊' }], kind: 'reply', note: '' })
  assert.ok(r1.messageId)
  assert.equal(adapter.__fakeClient.calls.at(-1).action, 'send_private_msg')
  assert.equal(adapter.__fakeClient.calls.at(-1).params.user_id, 10001)

  const r2 = await adapter.send({ chat: { kind: 'group', id: '20001' }, parts: [{ type: 'text', text: '群聊' }], kind: 'reply', note: '' })
  assert.ok(r2.messageId)
  assert.equal(adapter.__fakeClient.calls.at(-1).action, 'send_group_msg')
  assert.equal(adapter.__fakeClient.calls.at(-1).params.group_id, 20001)
  await adapter.stop()
})

test('whoami：返回登录账号，与配置的机器人号不符时报错/断开由网关处理', async () => {
  const h = makeHarness()
  const adapter = h.makeAdapter()
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  const me = await adapter.whoami()
  assert.equal(me.account, '10000')
  assert.equal(me.name, '假机器人')
  await adapter.stop()
})

test('native：转发到 OneBot 扩展动作（空间/收藏表情等）', async () => {
  const h = makeHarness()
  const adapter = h.makeAdapter()
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  await new Promise((r) => setTimeout(r, 60))
  if (typeof adapter.native === 'function') {
    const r = await adapter.native('get_group_list', {})
    assert.ok(r !== undefined, 'native 应把动作转发给 OneBot client')
  }
  await adapter.stop()
})

test('Step 1A：fetch(message) 与 fetch(forward) 统一输出归一化 FetchedMessage / FetchedForwardResult', async () => {
  const h = makeHarness()
  const adapter = h.makeAdapter()
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)

  const origCall = adapter.__fakeClient.call
  adapter.__fakeClient.call = async (action, params, opts) => {
    if (action === 'get_msg') {
      if (String(params.message_id) === '2001') {
        return {
          status: 'ok', retcode: 0,
          data: {
            message_id: 2001,
            time: 1700000100,
            user_id: 10000,
            sender: { user_id: 10000, nickname: '假机器人' },
            message: [{ type: 'text', data: { text: '我自己发的话' } }],
          },
        }
      }
      return {
        status: 'ok', retcode: 0,
        data: {
          message_id: 2002,
          time: 1700000200,
          user_id: 20001,
          sender: { user_id: 20001, card: '群友A' },
          message: [{ type: 'text', data: { text: '别人发的话' } }],
        },
      }
    }
    if (action === 'get_forward_msg') {
      return {
        status: 'ok', retcode: 0,
        data: {
          messages: [
            { message_id: 'fn1', time: 1700000300, sender: { user_id: 20001, card: '张三' }, message: [{ type: 'text', data: { text: '第一句' } }] },
            { message_id: 'fn2', time: 1700000301, sender: { user_id: 10000, nickname: '假机器人' }, message: [{ type: 'image', data: { file: 'abc.png', url: 'https://img.example/1.png' } }] },
          ],
        },
      }
    }
    return origCall(action, params, opts)
  }

  const selfMsg = await adapter.fetch({ kind: 'message', messageId: '2001' })
  assert.equal(selfMsg.messageId, '2001')
  assert.equal(selfMsg.at, 1700000100000)
  assert.equal(selfMsg.sender?.account, '10000')
  assert.equal(selfMsg.sender?.isBot, true)
  assert.deepEqual(selfMsg.parts, [{ type: 'text', text: '我自己发的话' }])

  const otherMsg = await adapter.fetch({ kind: 'message', messageId: '2002' })
  assert.equal(otherMsg.sender?.isBot, false)
  assert.equal(otherMsg.sender?.name, '群友A')

  const fwd = await adapter.fetch({ kind: 'forward', id: 'fwd-42' })
  assert.equal(fwd.messages.length, 2)
  assert.equal(fwd.messages[0].messageId, 'fn1')
  assert.equal(fwd.messages[0].sender?.name, '张三')
  assert.equal(fwd.messages[0].sender?.isBot, false)
  assert.deepEqual(fwd.messages[0].parts, [{ type: 'text', text: '第一句' }])
  assert.equal(fwd.messages[1].sender?.isBot, true)
  assert.equal(fwd.messages[1].parts[0]?.type, 'image')

  await adapter.stop()
})

test('Step 1A P1-1 & 复审5.3：fetch(media) 仅放行媒体子目录+合法媒体，拒绝 outbox/config/caps/越界/伪装文件', async () => {
  const controlledDir = mkdtempSync(join(tmpdir(), 'aurabot-qq-media-'))
  const outsideDir = mkdtempSync(join(tmpdir(), 'aurabot-qq-outside-'))
  const dataRoot = mkdtempSync(join(tmpdir(), 'aurabot-qq-datadir-'))
  const snowlumaDir = mkdtempSync(join(tmpdir(), 'aurabot-qq-snowluma-'))
  const dataMediaDir = join(dataRoot, 'media')
  const snowlumaConfigDir = join(snowlumaDir, 'config')
  const fakeHome = mkdtempSync(join(tmpdir(), 'aurabot-qq-home-'))
  const tencentPicDir = join(fakeHome, 'Documents', 'Tencent Files', '123456', 'nt_qq', 'nt_data', 'Pic', '2026-11')
  const tencentDbDir = join(fakeHome, 'Documents', 'Tencent Files', '123456', 'nt_qq', 'nt_db')
  const qqConfigDir = join(fakeHome, '.config', 'QQ')
  mkdirSync(dataMediaDir, { recursive: true })
  mkdirSync(snowlumaConfigDir, { recursive: true })
  mkdirSync(tencentPicDir, { recursive: true })
  mkdirSync(tencentDbDir, { recursive: true })
  mkdirSync(qqConfigDir, { recursive: true })

  const insideFile = join(controlledDir, 'cached.png')
  const dataMediaPng = join(dataMediaDir, 'in-datadir-media.png')
  const extensionlessPng = join(controlledDir, 'hash_no_ext')
  const tencentPicPng = join(tencentPicDir, 'pic.png')
  const tencentDbFile = join(tencentDbDir, 'nt_msg.db')
  const qqConfigFile = join(qqConfigDir, 'config.json')
  const outsideFile = join(outsideDir, 'secret.txt')
  const outboxFile = join(dataRoot, 'outbox.json')
  const capsFile = join(dataRoot, 'caps.json')
  const configFile = join(dataRoot, 'config.json')
  const snowlumaWebui = join(snowlumaConfigDir, 'webui.json')
  const disguisedOutbox = join(dataMediaDir, 'outbox.png')
  const disguisedJsonPng = join(dataMediaDir, 'evil.png')
  const sqliteFile = join(dataMediaDir, 'msg.db')

  const expected = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02])
  writeFileSync(insideFile, expected)
  writeFileSync(dataMediaPng, expected)
  writeFileSync(extensionlessPng, expected)
  writeFileSync(tencentPicPng, expected)
  writeFileSync(tencentDbFile, 'SQLite format 3\0nt')
  writeFileSync(qqConfigFile, '{"uin":"123"}')
  writeFileSync(outsideFile, 'do-not-read')
  writeFileSync(outboxFile, '{"queue":[{"secret":"token"}]}')
  writeFileSync(capsFile, '{"features":{}}')
  writeFileSync(configFile, '{"token":"abc"}')
  writeFileSync(snowlumaWebui, '{"password":"secret"}')
  writeFileSync(disguisedOutbox, expected)
  writeFileSync(disguisedJsonPng, '{"secret":"json-disguised-as-png"}')
  writeFileSync(sqliteFile, 'SQLite format 3\0dummy')

  const client = makeFakeClient()
  const baseCall = client.call.bind(client)
  let nextPath = insideFile
  client.call = async (action, params, opts) => {
    if (action === 'get_image') return { status: 'ok', retcode: 0, data: { file: nextPath } }
    return baseCall(action, params, opts)
  }

  const adapter = createQqAdapter({ client, mediaDirs: [controlledDir], homeDir: fakeHome })
  const ctx = makeCtx(adapter, { snowlumaDir })
  ctx.dataDir = (...p) => join(dataRoot, ...p)
  await adapter.start(ctx)
  await new Promise((r) => setTimeout(r, 60))

  // 1. 显式 mediaDirs 内的合法 PNG、ctx.dataDir('media') 内的合法 PNG、Tencent Pic 缓存子目录、以及无扩展名真实 PNG magic 放行
  for (const [label, target] of [
    ['explicit mediaDir PNG', insideFile],
    ['ctx.dataDir(media) PNG', dataMediaPng],
    ['Tencent Pic subdir PNG', tencentPicPng],
    ['extensionless media magic', extensionlessPng],
  ]) {
    nextPath = target
    const okRes = await adapter.fetch({ kind: 'media', media: { id: label } })
    assert.deepEqual(okRes.bytes, expected, label)
    assert.equal('path' in okRes, false, 'QQ fetch(media) 不应再把裸本机 path 透出给中枢')
  }

  // 2. outbox.json / config.json / caps.json / snowluma config / Tencent nt_db / .config/QQ config / 伪装文件名与伪装内容 / db 全部拒绝
  for (const denied of [
    outsideFile, outboxFile, capsFile, configFile, snowlumaWebui,
    tencentDbFile, qqConfigFile, disguisedOutbox, disguisedJsonPng, sqliteFile,
  ]) {
    nextPath = denied
    await assert.rejects(
      () => adapter.fetch({ kind: 'media', media: { id: denied } }),
      (e) => e.certainty === 'not-sent' && e.code === 'unsafe-media-path',
      `必须拒绝敏感/越界/伪装路径：${denied}`,
    )
  }

  await adapter.stop()
})

test('Phase 3A：QQ fetch(history) 统一输出按时间升序的 FetchedHistoryPage（群/私聊/before游标/hasMore）', async () => {
  const h = makeHarness()
  const adapter = h.makeAdapter()
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)

  const calls = []
  const origCall = adapter.__fakeClient.call
  adapter.__fakeClient.call = async (action, params, opts) => {
    calls.push({ action, params })
    if (action === 'get_group_msg_history') {
      if (!params.message_id) {
        // 故意倒序（新 → 旧）返回 3 条（请求 count=2 会多要到 3 条用来判定 hasMore）
        return {
          status: 'ok', retcode: 0,
          data: {
            messages: [
              { message_id: 103, time: 1700000300, sender: { user_id: 10000, nickname: '假机器人' }, message: [{ type: 'text', data: { text: '第三条' } }] },
              { message_id: 102, time: 1700000200, sender: { user_id: 20001, card: '群友A' }, message: [{ type: 'text', data: { text: '第二条' } }] },
              { message_id: 101, time: 1700000100, sender: { user_id: 20002, nickname: '群友B' }, message: [{ type: 'text', data: { text: '第一条' } }] },
            ],
          },
        }
      }
      // 带 before='102' 时可能把锚点 102 本身也带回来，且只有 1 条更早消息
      return {
        status: 'ok', retcode: 0,
        data: {
          messages: [
            { message_id: 101, time: 1700000100, sender: { user_id: 20002, nickname: '群友B' }, message: [{ type: 'text', data: { text: '第一条' } }] },
            { message_id: 102, time: 1700000200, sender: { user_id: 20001, card: '群友A' }, message: [{ type: 'text', data: { text: '第二条' } }] },
          ],
        },
      }
    }
    if (action === 'get_friend_msg_history') {
      return {
        status: 'ok', retcode: 0,
        data: {
          messages: [
            { message_id: 201, time: 1700000400, sender: { user_id: 30001, nickname: '好友C' }, message: [{ type: 'text', data: { text: '私聊历史' } }] },
          ],
        },
      }
    }
    return origCall(action, params, opts)
  }

  const histCalls = () => calls.filter((c) => c.action === 'get_group_msg_history' || c.action === 'get_friend_msg_history')

  const page1 = await adapter.fetch({ kind: 'history', chat: { kind: 'group', id: '999' }, count: 2 })
  assert.equal(histCalls()[0].action, 'get_group_msg_history')
  assert.equal(histCalls()[0].params.group_id, 999)
  assert.equal(histCalls()[0].params.count, 3)
  assert.equal(page1.hasMore, true)
  assert.equal(page1.before, '102')
  assert.deepEqual(page1.messages.map((m) => m.messageId), ['102', '103'])
  assert.equal(page1.messages[0].sender?.account, '20001')
  assert.equal(page1.messages[0].sender?.name, '群友A')
  assert.equal(page1.messages[0].sender?.isBot, false)
  assert.equal(page1.messages[1].sender?.isBot, true)
  assert.equal('raw' in page1.messages[0], false)

  const page2 = await adapter.fetch({ kind: 'history', chat: { kind: 'group', id: '999' }, count: 2, before: page1.before })
  assert.equal(histCalls()[1].params.message_id, 102)
  assert.equal(histCalls()[1].params.reverse_order, true)
  assert.equal(histCalls()[1].params.count, 4)
  assert.equal(page2.hasMore, false)
  assert.deepEqual(page2.messages.map((m) => m.messageId), ['101'])
  assert.equal(page2.before, '101')

  const dmPage = await adapter.fetch({ kind: 'history', chat: { kind: 'private', id: '30001' }, count: 5 })
  assert.equal(histCalls()[2].action, 'get_friend_msg_history')
  assert.equal(histCalls()[2].params.user_id, 30001)
  assert.equal(dmPage.hasMore, false)
  assert.equal(dmPage.messages[0]?.parts?.[0]?.text, '私聊历史')

  await assert.rejects(
    () => adapter.fetch({ kind: 'history', chat: { kind: 'group', id: 'not-a-number' } }),
    (e) => e.certainty === 'not-sent' && e.code === 'bad-fetch-request',
  )

  await adapter.stop()
})

test('QQ 平台端 groupAdmin：botState / getGroupInfo / listMembers / mute / unmute / kick 及 unsupported 懒降级', async () => {
  const calls = []
  let failTitleUnsupported = false
  const client = makeFakeClient()
  const origCall = client.call.bind(client)
  client.call = async (action, params, opts) => {
    calls.push({ action, params })
    if (action === 'get_group_member_info') return { status: 'ok', retcode: 0, data: { user_id: params.user_id, role: 'owner' } }
    if (action === 'get_group_info') return { status: 'ok', retcode: 0, data: { group_id: params.group_id, group_name: '网关QQ测试群', member_count: 18 } }
    if (action === 'get_group_member_list') {
      return {
        status: 'ok', retcode: 0,
        data: [
          { user_id: 10000, nickname: '机器人', role: 'owner' },
          { user_id: 20001, card: '群名片B', nickname: '原昵称', role: 'member' },
        ],
      }
    }
    if (action === 'set_group_ban' || action === 'set_group_kick') return { status: 'ok', retcode: 0, data: {} }
    if (action === 'set_group_special_title' && failTitleUnsupported) {
      throw Object.assign(new Error('不支持的API'), { data: { retcode: 1404, message: 'unsupported' } })
    }
    return origCall(action, params, opts)
  }

  const adapter = createQqAdapter({ client })
  await adapter.start(makeCtx(adapter))

  const st = await adapter.groupAdmin.getBotState('7001')
  assert.deepEqual(st, { role: 'owner', groupOpenid: '7001', memberOpenid: '10000' })

  const gInfo = await adapter.groupAdmin.getGroupInfo('7001')
  assert.deepEqual(gInfo, { groupOpenid: '7001', name: '网关QQ测试群', memberCount: 18 })

  const members = await adapter.groupAdmin.listMembers('7001', { startIndex: 0, limit: 10 })
  assert.deepEqual(members, [
    { openid: '10000', nick: '机器人', role: 'owner' },
    { openid: '20001', nick: '群名片B', role: 'member' },
  ])

  await adapter.groupAdmin.muteMember('7001', '20001', 120_000)
  await adapter.groupAdmin.unmuteMember('7001', '20001')
  const banCalls = calls.filter((c) => c.action === 'set_group_ban')
  assert.deepEqual(banCalls, [
    { action: 'set_group_ban', params: { group_id: 7001, user_id: 20001, duration: 120 } },
    { action: 'set_group_ban', params: { group_id: 7001, user_id: 20001, duration: 0 } },
  ])

  await adapter.groupAdmin.kickMember('7001', '20001', { addBlackList: true })
  const kickCalls = calls.filter((c) => c.action === 'set_group_kick')
  assert.deepEqual(kickCalls, [
    { action: 'set_group_kick', params: { group_id: 7001, user_id: 20001, reject_add_request: true } },
  ])

  // native(set_group_special_title) 遇 1404 时懒降级 supportedActions.title
  assert.equal(adapter.groupAdmin.supportedActions.title, true)
  failTitleUnsupported = true
  await assert.rejects(() => adapter.native('set_group_special_title', { group_id: 7001, user_id: 20001, special_title: '测试' }))
  assert.equal(adapter.groupAdmin.supportedActions.title, false)

  await assert.rejects(() => adapter.groupAdmin.getBotState('not-num'), (e) => e.code === 'bad-fetch-request')
  await adapter.stop()
})
