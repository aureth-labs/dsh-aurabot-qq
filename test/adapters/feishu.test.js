// F1 · 飞书平台端测试：契约测试包 + 加解密/验签 + 长连接帧 + 事件转换 + 出站 + 错误分类
// 契约依据：src/gateway/contracts.d.ts、docs/CONTRACTS.md §六/§七/§八
// 全部用可注入的假 HTTP client / 假 WebSocket，不打真网络。加解密用 node:crypto 真算（可离线验证）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createHash } from 'node:crypto'
import { runAdapterContract, makeCtx } from '../contract/adapter-kit.js'
import {
  createFeishuAdapter,
  decryptEvent,
  verifySignature,
  calculateSignature,
  toParts,
  fromParts,
  splitText,
  isOpusMedia,
  receiveIdTypeOf,
  encodeFrame,
  decodeFrame,
  NOT_SENT_CODES,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
} from '../../src/adapters/feishu/index.js'

const APP_ID = 'cli_test'
const APP_SECRET = 'secret'
const ENCRYPT_KEY = 'test-encrypt-key'
const VERIFY_TOKEN = 'vt-test'

// ───────────────────────── 假 HTTP client ─────────────────────────

function makeFakeClient() {
  const calls = []
  let failNext = null
  let uploads = 0
  return {
    calls,
    get uploadCalls() { return calls.filter((c) => c.url.includes('/im/v1/images') || c.url.includes('/im/v1/files')) },
    failOnce(why) { failNext = why },
    async request(req) {
      calls.push({ ...req })
      if (failNext) {
        const why = failNext
        failNext = null
        if (why === 'timeout') throw Object.assign(new Error('timeout'), { name: 'AbortError' })
        if (why === 'network') throw Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' })
        if (why === 'reject') return { status: 400, json: { code: 230001, msg: 'invalid receive_id' } }
        if (why === 'range') return { status: 400, json: { code: 230013, msg: 'bot has no availability to this user' } }
        if (why === 'server') return { status: 500, json: null }
      }
      if (req.url.includes('/tenant_access_token/')) return { status: 200, json: { code: 0, tenant_access_token: 't-test', expire: 7200 } }
      if (req.url.includes('/callback/ws/endpoint')) {
        return { status: 200, json: { code: 0, data: { URL: 'wss://fake/ws', ClientConfig: { PingInterval: 120 } } } }
      }
      if (req.url.includes('/open-apis/bot/v3/info')) return { status: 200, json: { code: 0, bot: { open_id: 'ou_bot', app_name: '测试机器人' } } }
      if (req.url.includes('/open-apis/im/v1/images')) { uploads++; return { status: 200, json: { code: 0, data: { image_key: `img_key_${uploads}` } } } }
      if (req.url.includes('/open-apis/im/v1/files')) { uploads++; return { status: 200, json: { code: 0, data: { file_key: `file_key_${uploads}` } } } }
      if (req.url.includes('/open-apis/im/v1/messages')) return { status: 200, json: { code: 0, data: { message_id: `om_${calls.length}` } } }
      return { status: 200, json: { code: 0, data: {} } }
    },
  }
}

// ───────────────────────── 假 WebSocket ─────────────────────────

/**
 * 一个够用的 WebSocket 替身。
 * 注意：平台端 start() 是「await wsFactory(url) 之后才挂 onopen」的，
 * 所以这里**不能**在构造时就把 open 掉，必须等一个宏任务（setTimeout 0），
 * 让 onopen/onmessage 都挂好再触发握手成功。
 */
function makeFakeWs(url) {
  const ws = {
    url,
    sent: [], // 平台端发出去的原始 Buffer
    readyState: 0,
    closed: false,
    onopen: null, onmessage: null, onclose: null, onerror: null,
    send(data) { ws.sent.push(Buffer.isBuffer(data) ? data : Buffer.from(data)) },
    close() { ws.closed = true; ws.readyState = 3; ws.onclose?.() },
    /** 让 start 的握手成功 */
    open() { ws.readyState = 1; ws.onopen?.() },
    /** 推一帧给平台端（Buffer） */
    push(buf) { ws.onmessage?.({ data: buf }) },
    /** 平台端发出去的帧解码后返回 */
    frames() { return ws.sent.map((b) => decodeFrame(b)) },
  }
  // 等平台端把 onopen/onmessage 挂好之后再握手
  setTimeout(() => { if (ws.readyState === 0) ws.open() }, 0)
  return ws
}

/** 建一个已连上的长连接平台端，返回 { adapter, ws, ctx, client } */
async function bootWs(config = {}) {
  const client = makeFakeClient()
  let ws = null
  const adapter = createFeishuAdapter({
    client,
    wsFactory: (url) => { ws = makeFakeWs(url); return ws },
  })
  adapter.__feishu.setConfig({ appId: APP_ID, appSecret: APP_SECRET, transport: 'websocket', ...config })
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  return { adapter, ws, ctx, client }
}

// ───────────────────────── 加解密工具（造加密包） ─────────────────────────

function encryptEvent(encryptKey, plaintext) {
  const key = createHash('sha256').update(encryptKey, 'utf8').digest()
  const iv = Buffer.from('0123456789abcdef', 'utf8')
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  return Buffer.concat([iv, enc]).toString('base64')
}

const sign = ({ timestamp, nonce, encryptKey, body }) =>
  createHash('sha256').update(timestamp).update(nonce).update(encryptKey).update(body).digest('hex')

// ───────────────────────── 事件样例 ─────────────────────────

const makeRes = () => ({ statusCode: 0, payload: undefined, setHeader() {}, end(t) { this.payload = t ? JSON.parse(t) : undefined } })

function inboundEvent(over = {}) {
  return {
    schema: '2.0',
    header: { event_id: 'ev-1', event_type: 'im.message.receive_v1', token: VERIFY_TOKEN, tenant_key: 'tk' },
    event: {
      sender: { sender_id: { open_id: 'ou_user1', union_id: 'on_union1' }, sender_type: 'user' },
      message: {
        message_id: 'om-1',
        create_time: String(Date.now()),
        chat_id: 'oc_chat1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '来自飞书' }),
        mentions: [],
        ...(over.message || {}),
      },
      ...(over.event || {}),
    },
  }
}

/** 官方文档「接收消息」里的群 @ 机器人事件样例（字段名全部照抄官方示例） */
const OFFICIAL_GROUP_AT_EVENT = {
  schema: '2.0',
  header: {
    event_id: '5e3702a84e847582be8db7fb73283c02',
    event_type: 'im.message.receive_v1',
    create_time: '1608725989000',
    token: VERIFY_TOKEN,
    app_id: 'cli_9f5343c580712544',
    tenant_key: '2ca1d211f64f6438',
  },
  event: {
    sender: {
      sender_id: {
        union_id: 'on_8ed6aa67826108097d9ee143816345',
        user_id: 'e33ggbyz',
        open_id: 'ou_84aad35d084aa403a838cf73ee18467',
      },
      sender_type: 'user',
      tenant_key: '736588c9260f175e',
    },
    message: {
      message_id: 'om_5ce6d572455d361153b7cb51da133945',
      create_time: '1609073151345',
      chat_id: 'oc_5ce6d572455d361153b7xx51da133945',
      chat_type: 'group',
      message_type: 'text',
      content: '{"text":"@_user_1 hello"}',
      mentions: [{
        key: '@_user_1',
        id: { union_id: 'on_8ed6aa67826108097d9ee143816345', user_id: 'e33ggbyz', open_id: 'ou_bot' },
        name: 'Tom',
        tenant_key: '736588c9260f175e',
      }],
    },
  },
}

// ───────────────────────── harness ─────────────────────────

const CFG = { appId: APP_ID, appSecret: APP_SECRET, transport: 'webhook', verificationToken: VERIFY_TOKEN }

async function post(ctx, path, bodyObj, headers = {}) {
  const res = makeRes()
  const handler = ctx.__routes.get(path)
  if (!handler) return { statusCode: 0, payload: { skipped: true } }
  await handler({ headers, body: typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj) }, res)
  return res
}

function makeHarness({ encrypted = false } = {}) {
  const config = { ...CFG, encryptKey: ENCRYPT_KEY }
  return {
    config,
    makeAdapter() {
      const client = makeFakeClient()
      const adapter = createFeishuAdapter({ client })
      adapter.__fakeClient = client
      return adapter
    },
    async injectInbound(adapter, ctx) {
      const event = inboundEvent()
      // kit 用例 5 在 stop 之后再调一次，证明「停了不再 emit」
      if (!ctx.__routes.get('/callback')) {
        adapter.__feishu.injectAfterStop?.(event)
        return
      }
      const body = encrypted ? JSON.stringify({ encrypt: encryptEvent(ENCRYPT_KEY, JSON.stringify(event)) }) : JSON.stringify(event)
      const timestamp = '1700000000'
      const nonce = 'n0nce'
      const res = makeRes()
      await ctx.__routes.get('/callback')({
        headers: {
          'x-lark-request-timestamp': timestamp,
          'x-lark-request-nonce': nonce,
          'x-lark-signature': sign({ timestamp, nonce, encryptKey: ENCRYPT_KEY, body }),
        },
        body,
      }, res)
    },
    async injectUnverified(adapter, ctx) {
      const handler = ctx.__routes.get('/callback')
      if (!handler) return
      const res = makeRes()
      const body = JSON.stringify(inboundEvent())
      await handler({ headers: { 'x-lark-request-timestamp': '1', 'x-lark-request-nonce': 'n', 'x-lark-signature': 'deadbeef' }, body }, res)
      assert.equal(res.statusCode, 401, '验签不过必须回 4xx')
    },
    async injectSigned(adapter, ctx) {
      await this.injectInbound(adapter, ctx)
    },
    setProactive(adapter, value) {
      adapter.__feishu.setCaps({ proactive: value })
    },
    failSend(adapter, why) {
      adapter.__fakeClient.failOnce(why === 'refused' ? 'reject' : 'timeout')
    },
    reconnect(adapter, ctx) {
      ctx.state('connected')
    },
  }
}

// ───────────────────────── 1. 契约测试包 ─────────────────────────

test('飞书平台端过全套契约（webhook · 明文）', async () => {
  const h = makeHarness()
  await runAdapterContract(h.makeAdapter, h)
})

test('飞书平台端过全套契约（webhook · 加密+验签）', async () => {
  const h = makeHarness({ encrypted: true })
  await runAdapterContract(h.makeAdapter, h)
})

test('飞书平台端过全套契约（websocket 长连接）', async () => {
  const harness = {
    config: { appId: APP_ID, appSecret: APP_SECRET, transport: 'websocket', verificationToken: VERIFY_TOKEN },
    makeAdapter() {
      let ws = null
      const client = makeFakeClient()
      const adapter = createFeishuAdapter({
        client,
        wsFactory: (url) => { ws = makeFakeWs(url); return ws },
      })
      // injectInbound 要拿到这台实例的 ws，用不可枚举属性挂上去
      Object.defineProperty(adapter, '__ws', { get: () => ws, configurable: true })
      adapter.__fakeClient = client
      return adapter
    },
    async injectInbound(adapter) {
      const ws = adapter.__ws
      if (!ws) return
      const payload = JSON.stringify(inboundEvent())
      ws.push(encodeFrame({ Method: 1, Service: 1, SeqID: 7, Headers: [{ key: 'type', value: 'event' }], PayloadType: 'json', Payload: payload }))
    },
    async injectUnverified(adapter) {
      // 长连接由握手阶段鉴权；「验签不过」对应 token 不匹配的事件头 —— 必须不 emit
      const ws = adapter.__ws
      const bad = inboundEvent()
      bad.header.token = 'someone-elses-token'
      ws.push(encodeFrame({ Method: 1, Service: 1, SeqID: 8, Headers: [{ key: 'type', value: 'event' }], Payload: JSON.stringify(bad) }))
    },
    async injectSigned(adapter) {
      await harness.injectInbound(adapter)
    },
    setProactive(adapter, value) { adapter.__feishu.setCaps({ proactive: value }) },
    failSend(adapter, why) { adapter.__fakeClient.failOnce(why === 'refused' ? 'reject' : 'timeout') },
    reconnect(adapter, ctx) {
      adapter.__ws?.open()
      ctx.state('connected')
    },
  }
  await runAdapterContract(harness.makeAdapter, harness)
})

// ───────────────────────── 2. 加解密 / 验签 ─────────────────────────

test('解密：官方示例向量（"test key" → "hello world"）能解出来', () => {
  // 官方文档「事件解密」给的例子，硬抄的
  assert.equal(decryptEvent('test key', 'P37w+VZImNgPEO1RBhJ6RtKl7n6zymIbEG1pReEzghk='), 'hello world')
})

test('解密：AES-256-CBC + sha256(key) + IV 前缀，key 不对就抛', () => {
  const plain = JSON.stringify({ hello: '世界', n: 42 })
  const enc = encryptEvent(ENCRYPT_KEY, plain)
  assert.equal(decryptEvent(ENCRYPT_KEY, enc), plain)
  assert.throws(() => decryptEvent('wrong-key', enc), /填充不合法/)
  assert.throws(() => decryptEvent(ENCRYPT_KEY, Buffer.from('short').toString('base64')), /加密包太短/)
})

test('验签：sha256(timestamp+nonce+encryptKey+body)，篡改 body 必失败', () => {
  const args = { timestamp: '1700000000', nonce: 'abc', encryptKey: ENCRYPT_KEY, body: '{"a":1}' }
  const sig = sign(args)
  assert.equal(calculateSignature(args.timestamp, args.nonce, args.encryptKey, args.body), sig)
  assert.equal(verifySignature({ ...args, signature: sig }), true)
  assert.equal(verifySignature({ ...args, body: '{"a":2}', signature: sig }), false)
  assert.equal(verifySignature({ ...args, signature: '' }), false)
  assert.equal(verifySignature({ ...args, signature: sig.slice(0, 10) }), false)
})

test('URL 校验：challenge 原样返回（1 秒内）', async () => {
  const adapter = createFeishuAdapter({ client: makeFakeClient() })
  adapter.__feishu.setConfig(CFG)
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  const res = await post(ctx, '/callback', { challenge: 'abc123', type: 'url_verification', token: VERIFY_TOKEN })
  assert.equal(res.statusCode, 200)
  assert.equal(res.payload.challenge, 'abc123')
  await adapter.stop()
})

test('加密回调：签名错 → 401 且不 emit；签名对 → 解密并 emit', async () => {
  const adapter = createFeishuAdapter({ client: makeFakeClient() })
  adapter.__feishu.setConfig({ ...CFG, encryptKey: ENCRYPT_KEY })
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)

  const event = inboundEvent()
  const encrypted = JSON.stringify({ encrypt: encryptEvent(ENCRYPT_KEY, JSON.stringify(event)) })
  const timestamp = '1700000000'
  const nonce = 'nn'

  let res = makeRes()
  await ctx.__routes.get('/callback')({ headers: { 'x-lark-request-timestamp': timestamp, 'x-lark-request-nonce': nonce, 'x-lark-signature': 'bad' }, body: encrypted }, res)
  assert.equal(res.statusCode, 401)
  assert.equal(ctx.emitted.length, 0, '验签不过绝不能 emit')

  res = makeRes()
  await ctx.__routes.get('/callback')({
    headers: { 'x-lark-request-timestamp': timestamp, 'x-lark-request-nonce': nonce, 'x-lark-signature': sign({ timestamp, nonce, encryptKey: ENCRYPT_KEY, body: encrypted }) },
    body: encrypted,
  }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(ctx.emitted.length, 1)
  assert.equal(ctx.emitted[0].parts[0].text, '来自飞书')
  await adapter.stop()
})

test('Verification Token 不匹配：不 emit（长连接与 webhook 共用同一段守卫）', async () => {
  const adapter = createFeishuAdapter({ client: makeFakeClient() })
  adapter.__feishu.setConfig({ ...CFG, encryptKey: ENCRYPT_KEY })
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)

  const bad = inboundEvent()
  bad.header.token = 'wrong-token'
  const body = JSON.stringify(bad)
  const timestamp = '1700000000'
  const nonce = 'nn'
  const res = makeRes()
  await ctx.__routes.get('/callback')({
    headers: { 'x-lark-request-timestamp': timestamp, 'x-lark-request-nonce': nonce, 'x-lark-signature': sign({ timestamp, nonce, encryptKey: ENCRYPT_KEY, body }) },
    body,
  }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(ctx.emitted.length, 0, 'token 不对绝不能 emit')

  await adapter.stop()
})

// ───────────────────────── 3. 长连接（协议细节） ─────────────────────────

test('长连接：先调 /callback/ws/endpoint 拿 URL，再连；不会直连 open.feishu.cn', async () => {
  const { adapter, ws, client } = await bootWs()
  const endpointCall = client.calls.find((c) => c.url.includes('/callback/ws/endpoint'))
  assert.ok(endpointCall, '必须走端点发现')
  assert.equal(endpointCall.method, 'POST')
  // 官方 Go SDK 的 body 字段名就是 AppID / AppSecret（大写）
  assert.deepEqual(JSON.parse(endpointCall.body), { AppID: APP_ID, AppSecret: APP_SECRET })
  assert.equal(ws.url, 'wss://fake/ws', '必须连服务端下发的那个 URL，不能自己拼 /event/ws')
  await adapter.stop()
})

test('长连接：收到数据帧 → emit 一条；并回一个同 SeqID 的应答帧（3 秒内）', async () => {
  const { adapter, ws, ctx } = await bootWs({ verificationToken: VERIFY_TOKEN })
  const before = ws.sent.length

  ws.push(encodeFrame({
    SeqID: 42, LogID: 9, Service: 1, Method: 1,
    Headers: [{ key: 'type', value: 'event' }, { key: 'message_id', value: 'msg-1' }],
    PayloadEncoding: 'json', PayloadType: 'json',
    Payload: JSON.stringify(inboundEvent()),
  }))

  assert.equal(ctx.emitted.length, 1, '数据帧应 emit 一条')
  assert.equal(ctx.emitted[0].messageId, 'om-1')

  const replyFrames = ws.frames().slice(before)
  assert.ok(replyFrames.length >= 1, '必须回一个应答帧')
  const ack = replyFrames[0]
  assert.equal(Number(ack.SeqID), 42, '应答帧要带同样的 SeqID')
  assert.equal(Number(ack.Method), 1)
  const ackPayload = JSON.parse(ack.Payload.toString('utf8'))
  assert.equal(ackPayload.code, 200, '应答 payload 的 code 应是 200')
  const ackHeaders = Object.fromEntries((ack.Headers || []).map((h) => [h.key, h.value]))
  assert.equal(ackHeaders.message_id, 'msg-1', '应答要带回原事件 message_id')
  assert.ok(ackHeaders.biz_rt, '应答要带 biz_rt')

  await adapter.stop()
})

test('长连接：ping 帧回 pong；pong 不做事', async () => {
  const { adapter, ws, ctx } = await bootWs()
  const before = ws.sent.length
  ws.push(encodeFrame({ Method: 0, Service: 1, Headers: [{ key: 'type', value: 'ping' }] }))
  const frames = ws.frames().slice(before)
  assert.ok(frames.some((f) => String(f.Headers?.[0]?.value).toLowerCase() === 'pong'), 'ping 要回 pong')
  assert.equal(ctx.emitted.length, 0)

  const before2 = ws.sent.length
  ws.push(encodeFrame({ Method: 0, Service: 1, Headers: [{ key: 'type', value: 'pong' }] }))
  assert.equal(ws.sent.length, before2, 'pong 不该再回东西')
  await adapter.stop()
})

test('帧编解码：encode → decode 往返一致（含 headers / payload）', () => {
  const frame = {
    SeqID: 123, LogID: 456, Service: 3, Method: 1,
    Headers: [{ key: 'type', value: 'event' }, { key: 'trace_id', value: 'abc' }],
    PayloadEncoding: 'json', PayloadType: 'json',
    Payload: Buffer.from('{"a":1}', 'utf8'),
  }
  const decoded = decodeFrame(encodeFrame(frame))
  assert.equal(decoded.SeqID, 123)
  assert.equal(decoded.LogID, 456)
  assert.equal(decoded.Service, 3)
  assert.equal(decoded.Method, 1)
  assert.deepEqual(decoded.Headers, frame.Headers)
  assert.equal(decoded.Payload.toString('utf8'), '{"a":1}')
})

test('长连接：连不上时 start 抛错，状态是 disconnected（不假装连上）', async () => {
  const adapter = createFeishuAdapter({
    client: makeFakeClient(),
    // 握手阶段直接报错：不能等 15 秒超时
    wsFactory: () => {
      const ws = makeFakeWs('wss://x')
      ws.open = () => {} // 别自动握手成功
      setTimeout(() => ws.onerror?.(), 0)
      return ws
    },
  })
  adapter.__feishu.setConfig({ appId: APP_ID, appSecret: APP_SECRET, transport: 'websocket' })
  const ctx = makeCtx(adapter)
  await assert.rejects(() => adapter.start(ctx))
  assert.ok(['disconnected', 'unconfigured'].includes(ctx.states.at(-1)[0]))
})

// ───────────────────────── 4. 事件转换 ─────────────────────────

test('事件转换：官方群 @ 样例（@_user_1 占位符 + mentions）→ mentionedMe 且不进 parts', async () => {
  const adapter = createFeishuAdapter({ client: makeFakeClient() })
  adapter.__feishu.setConfig(CFG)
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  adapter.__feishu.setSelf({ account: 'ou_bot', name: '我' })

  await post(ctx, '/callback', OFFICIAL_GROUP_AT_EVENT)
  const m = ctx.emitted.at(-1)
  assert.equal(m.chat.kind, 'group')
  assert.equal(m.chat.id, 'oc_5ce6d572455d361153b7xx51da133945')
  assert.equal(m.sender.account, 'ou_84aad35d084aa403a838cf73ee18467')
  assert.equal(m.sender.alt, 'on_8ed6aa67826108097d9ee143816345', 'alt 存 union_id')
  assert.equal(m.messageId, 'om_5ce6d572455d361153b7cb51da133945')
  assert.equal(m.at, 1609073151345, 'at 用 message.create_time（毫秒）')
  assert.equal(m.mentionedMe, true, '@到机器人 → mentionedMe')
  assert.ok(!m.parts.some((p) => p.type === 'mention' && p.account === 'ou_bot'), '@自己不进 parts')
  assert.ok(m.parts.some((p) => p.type === 'text' && p.text.includes('hello')))
  await adapter.stop()
})

test('事件转换：私聊 chat.id 用对方 open_id；群里 @ 别人 → mentionedMe=false', async () => {
  const adapter = createFeishuAdapter({ client: makeFakeClient() })
  adapter.__feishu.setConfig(CFG)
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  adapter.__feishu.setSelf({ account: 'ou_bot', name: '我' })

  // 私聊
  await post(ctx, '/callback', inboundEvent({ message: { chat_type: 'p2p' } }))
  let m = ctx.emitted.at(-1)
  assert.equal(m.chat.kind, 'private')
  assert.equal(m.chat.id, 'ou_user1', '私聊会话 id 用对方 open_id（发消息也用它）')
  assert.equal(m.mentionedMe, true, '私聊天然是在跟她说话')

  // 群里 @ 的是别人
  await post(ctx, '/callback', inboundEvent({
    message: {
      chat_type: 'group', chat_id: 'oc_g2', message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 你看' }),
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_other' }, name: '小明' }],
    },
  }))
  m = ctx.emitted.at(-1)
  assert.equal(m.mentionedMe, false)
  assert.ok(m.parts.some((p) => p.type === 'mention' && p.account === 'ou_other'))
  await adapter.stop()
})

test('事件转换：图片/文件/语音(opus 时长)/视频/表情包/富文本/卡片/合并转发/未知类型', () => {
  // 图片：media 上带 messageId，fetch 换字节时要用它拼 resources 路径
  const img = toParts('image', JSON.stringify({ image_key: 'img_v2_x' }), [], { messageId: 'om_9' })[0]
  assert.equal(img.type, 'image')
  assert.equal(img.media.id, 'img_v2_x')
  assert.equal(img.media.messageId, 'om_9')

  const file = toParts('file', JSON.stringify({ file_key: 'file_v2_f', file_name: '报告.pdf' }))[0]
  assert.equal(file.type, 'file')
  assert.equal(file.media.name, '报告.pdf')

  const audio = toParts('audio', JSON.stringify({ file_key: 'file_v2_a', duration: 2000 }))[0]
  assert.equal(audio.type, 'voice')
  assert.equal(audio.durationMs, 2000, '官方 audio 的 duration 单位是毫秒')

  const video = toParts('media', JSON.stringify({ file_key: 'file_v2_v', image_key: 'img_cover', file_name: 'v.mp4' }))[0]
  assert.equal(video.type, 'video')

  const sticker = toParts('sticker', JSON.stringify({ file_key: 'file_v2_s' }))[0]
  assert.equal(sticker.type, 'sticker')

  // 富文本：title + 文本 + 图片 + @ + 表情
  const rich = toParts('post', JSON.stringify({
    title: '标题',
    content: [[
      { tag: 'text', text: '第一行' },
      { tag: 'a', text: '链接', href: 'https://example.com' },
      { tag: 'at', user_id: 'ou_x', user_name: '小明' },
    ], [{ tag: 'img', image_key: 'img_r' }], [{ tag: 'emotion', emoji_type: 'SMILE' }]],
  }))
  assert.ok(rich.some((p) => p.type === 'text' && p.text.includes('标题')))
  assert.ok(rich.some((p) => p.type === 'text' && p.text.includes('第一行')))
  assert.ok(rich.some((p) => p.type === 'text' && p.text.includes('https://example.com')))
  assert.ok(rich.some((p) => p.type === 'mention' && p.account === 'ou_x'))
  assert.ok(rich.some((p) => p.type === 'image' && p.media.id === 'img_r'))
  assert.ok(rich.some((p) => p.type === 'face' && p.name === 'SMILE'))

  // 卡片：取出标题 + 正文 + 链接
  const card = toParts('interactive', JSON.stringify({
    title: '卡片标题',
    elements: [[{ tag: 'text', text: '正文' }, { tag: 'a', href: 'https://feishu.cn', text: '飞书' }]],
  }))[0]
  assert.equal(card.type, 'card')
  assert.equal(card.title, '卡片标题')
  assert.ok(card.text.includes('正文'))
  assert.equal(card.url, 'https://feishu.cn')

  // 合并转发：官方 content 固定是 "Merged and Forwarded Message"，本端不展开 → other
  const merged = toParts('merge_forward', JSON.stringify({ content: 'Merged and Forwarded Message' }))[0]
  assert.equal(merged.type, 'other')
  assert.equal(merged.text, '[合并转发]')

  // 未知类型：占位不丢，native 留着
  const unknown = toParts('weird_type', JSON.stringify({ a: 1 }))[0]
  assert.equal(unknown.type, 'other')
  assert.ok(unknown.text.includes('weird_type'))
  assert.deepEqual(unknown.native, { a: 1 })
})

test('事件转换：机器人自己发的消息走 self-sent，不 emit', async () => {
  const adapter = createFeishuAdapter({ client: makeFakeClient() })
  adapter.__feishu.setConfig(CFG)
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  adapter.__feishu.setSelf({ account: 'ou_bot', name: '我' })

  const selfEvent = inboundEvent()
  selfEvent.event.sender.sender_type = 'bot'
  selfEvent.event.sender.sender_id.open_id = 'ou_bot'
  await post(ctx, '/callback', selfEvent)

  assert.equal(ctx.emitted.length, 0, '自己的话不走 emit')
  assert.equal(ctx.events.length, 1)
  assert.equal(ctx.events[0].type, 'self-sent')
  await adapter.stop()
})

test('非消息事件 → native 事件（撤回/入群这些只转给绑定该平台的模块）', async () => {
  const adapter = createFeishuAdapter({ client: makeFakeClient() })
  adapter.__feishu.setConfig(CFG)
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)

  await post(ctx, '/callback', {
    schema: '2.0',
    header: { event_id: 'e2', event_type: 'im.message.recalled_v1', token: VERIFY_TOKEN },
    event: { message_id: 'om_1' },
  })
  assert.equal(ctx.emitted.length, 0)
  assert.equal(ctx.events.length, 1)
  assert.equal(ctx.events[0].type, 'native')
  assert.equal(ctx.events[0].name, 'im.message.recalled_v1')
  await adapter.stop()
})

// ───────────────────────── 5. 出站 ─────────────────────────

test('出站：一条飞书消息只能带一种 msg_type，多段要拆', () => {
  const sends = fromParts([
    { type: 'text', text: '看图' },
    { type: 'image', media: { id: 'ik1' } },
    { type: 'text', text: '还有字' },
    { type: 'mention', account: 'ou_x', name: '小明' },
  ])
  assert.equal(sends.length, 3, '文本 / 图片 / 文本+@ 要拆成三条')
  assert.equal(sends[0].msgType, 'text')
  assert.equal(sends[1].msgType, 'image')
  // content 是 JSON 字符串，解出来再比
  assert.ok(JSON.parse(sends[2].content).text.includes('<at user_id="ou_x">小明</at>'))

  const all = fromParts([{ type: 'mention', account: 'all', name: '' }])
  assert.ok(JSON.parse(all[0].content).text.includes('user_id="all"'), '@全体用 user_id=all')
})

test('出站：语音只有 opus 才发成 audio，其他格式降级成 file（不谎报）', () => {
  const opus = fromParts([{ type: 'voice', media: { id: 'k', name: 'a.opus', mime: 'audio/opus' }, durationMs: 1200 }])
  assert.equal(opus[0].msgType, 'audio')
  assert.equal(opus[0].needsUpload.fileType, 'opus')
  assert.equal(opus[0].needsUpload.durationMs, 1200)

  const mp3 = fromParts([{ type: 'voice', media: { id: 'k', name: 'a.mp3', mime: 'audio/mpeg' } }])
  assert.equal(mp3[0].msgType, 'file', '非 opus 只能是文件，不能装成语音条')
  assert.equal(mp3[0].needsUpload.fileType, 'stream')

  assert.equal(isOpusMedia({ mime: 'audio/opus' }), true)
  assert.equal(isOpusMedia({ name: 'x.opus' }), true)
  assert.equal(isOpusMedia({ name: 'x.mp3', mime: 'audio/mpeg' }), false)
})

test('出站：媒体先上传换 key，再发消息（bytes → image_key）', async () => {
  const client = makeFakeClient()
  const adapter = createFeishuAdapter({ client })
  adapter.__feishu.setConfig(CFG)
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)

  await adapter.send({
    chat: { kind: 'private', id: 'ou_a' },
    parts: [{ type: 'image', media: { bytes: Buffer.from('PNGDATA'), name: 'a.png', mime: 'image/png' } }],
    kind: 'reply', note: '',
  })
  const uploads = client.uploadCalls
  assert.equal(uploads.length, 1, '要先上传一次')
  assert.ok(uploads[0].url.includes('/im/v1/images'))
  const sent = client.calls.filter((c) => c.url.includes('/open-apis/im/v1/messages'))
  assert.equal(sent.length, 1)
  assert.equal(JSON.parse(sent[0].body).content, JSON.stringify({ image_key: 'img_key_1' }), '发出去要用上传拿到的 key')
  await adapter.stop()
})

test('出站：媒体既没有 key 也没有 bytes/path/url → not-sent / media-needs-upload', async () => {
  const adapter = createFeishuAdapter({ client: makeFakeClient() })
  adapter.__feishu.setConfig(CFG)
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  await assert.rejects(
    () => adapter.send({ chat: { kind: 'private', id: 'ou_a' }, parts: [{ type: 'image', media: {} }], kind: 'reply', note: '' }),
    (e) => e.certainty === 'not-sent' && e.code === 'media-needs-upload',
  )
  await adapter.stop()
})

test('出站：私聊用 open_id、群聊用 chat_id 作 receive_id_type', async () => {
  const client = makeFakeClient()
  const adapter = createFeishuAdapter({ client })
  adapter.__feishu.setConfig(CFG)
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)

  await adapter.send({ chat: { kind: 'private', id: 'ou_a' }, parts: [{ type: 'text', text: '私聊' }], kind: 'reply', note: '' })
  assert.ok(client.calls.at(-1).url.includes('receive_id_type=open_id'))

  await adapter.send({ chat: { kind: 'group', id: 'oc_1' }, parts: [{ type: 'text', text: '群聊' }], kind: 'reply', note: '' })
  assert.ok(client.calls.at(-1).url.includes('receive_id_type=chat_id'))

  assert.equal(receiveIdTypeOf('ou_x'), 'open_id')
  assert.equal(receiveIdTypeOf('on_x'), 'union_id')
  assert.equal(receiveIdTypeOf('oc_x'), 'chat_id')
  await adapter.stop()
})

test('出站：带 inResponseTo / replyTo 时走 /messages/:id/reply（引用回复）', async () => {
  const client = makeFakeClient()
  const adapter = createFeishuAdapter({ client })
  adapter.__feishu.setConfig(CFG)
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)

  await adapter.send({
    chat: { kind: 'private', id: 'ou_a' },
    parts: [{ type: 'text', text: '引用回复' }],
    inResponseTo: 'om_parent', kind: 'reply', note: '',
  })
  const call = client.calls.at(-1)
  assert.ok(call.url.includes('/open-apis/im/v1/messages/om_parent/reply'), `应走 reply 接口，实际 ${call.url}`)
  assert.equal(JSON.parse(call.body).receive_id, undefined, 'reply 接口不需要 receive_id')
  await adapter.stop()
})

test('长文本分条：超过 maxTextChars 拆成多条发出，内容不丢', async () => {
  const client = makeFakeClient()
  const adapter = createFeishuAdapter({ client })
  adapter.__feishu.setConfig({ ...CFG, maxTextChars: 200 })
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)

  const long = Array.from({ length: 60 }, (_, i) => `第${i}行内容`).join('\n')
  await adapter.send({ chat: { kind: 'private', id: 'ou_a' }, parts: [{ type: 'text', text: long }], kind: 'reply', note: '' })

  const sent = client.calls.filter((c) => c.url.includes('/open-apis/im/v1/messages'))
  assert.ok(sent.length > 1, `长文本应拆成多条，实际 ${sent.length} 条`)
  const joined = sent.map((c) => JSON.parse(JSON.parse(c.body).content).text).join('')
  assert.equal(joined, long, '拆条后拼起来要等于原文（一个字都不能丢）')
  for (const c of sent) {
    assert.ok(JSON.parse(JSON.parse(c.body).content).text.length <= 200)
  }
  await adapter.stop()
})

test('splitText：按换行切，超长无空格串按字节兜底', () => {
  const text = 'a'.repeat(50) + '\n' + 'b'.repeat(50)
  const parts = splitText(text, 60)
  assert.ok(parts.length >= 2)
  assert.equal(parts.join(''), text)

  // 单条超过 150KB 的硬上限时继续硬切
  const huge = 'x'.repeat(200 * 1024)
  const cut = splitText(huge, 20000)
  assert.ok(cut.length >= 2)
  assert.ok(cut.every((c) => Buffer.byteLength(c, 'utf8') <= 150 * 1024))
  assert.equal(cut.join(''), huge)
})

// ───────────────────────── 6. 错误分类 ─────────────────────────

test('错误分类：业务错误码 → not-sent；超时 → unknown（绝不重发）', async () => {
  const client = makeFakeClient()
  const adapter = createFeishuAdapter({ client })
  adapter.__feishu.setConfig(CFG)
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)

  client.failOnce('reject')
  await assert.rejects(
    () => adapter.send({ chat: { kind: 'private', id: 'ou_a' }, parts: [{ type: 'text', text: 'x' }], kind: 'reply', note: '' }),
    (e) => e.certainty === 'not-sent',
  )

  client.failOnce('timeout')
  await assert.rejects(
    () => adapter.send({ chat: { kind: 'private', id: 'ou_a' }, parts: [{ type: 'text', text: 'y' }], kind: 'reply', note: '' }),
    (e) => e.certainty === 'unknown',
  )
  await adapter.stop()
})

test('错误分类：230013（不在可用范围）→ not-sent；5xx / 读不懂 → unknown', async () => {
  const client = makeFakeClient()
  const adapter = createFeishuAdapter({ client })
  adapter.__feishu.setConfig(CFG)
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)

  client.failOnce('range')
  await assert.rejects(
    () => adapter.send({ chat: { kind: 'private', id: 'ou_a' }, parts: [{ type: 'text', text: 'x' }], kind: 'reply', note: '' }),
    (e) => e.certainty === 'not-sent' && e.code === '230013',
    '用户不在应用可用范围 = 确定没发出去',
  )

  client.failOnce('server')
  await assert.rejects(
    () => adapter.send({ chat: { kind: 'private', id: 'ou_a' }, parts: [{ type: 'text', text: 'y' }], kind: 'reply', note: '' }),
    (e) => e.certainty === 'unknown',
    '5xx 拿不准 → unknown，绝不重发',
  )
  await adapter.stop()
})

test('错误分类表：几个关键错误码都在 NOT_SENT_CODES 里', () => {
  for (const code of ['230013', '230002', '230053', '230020', '230025', '234006']) {
    assert.ok(NOT_SENT_CODES.has(code), `${code} 应被归为 not-sent`)
  }
  assert.ok(!NOT_SENT_CODES.has('500'))
})

// ───────────────────────── 7. caps / 配置 / token ─────────────────────────

test('caps：voice=file、sticker=false、listenAllInGroup=false、card=true、proactive=free', async () => {
  const adapter = createFeishuAdapter({ client: makeFakeClient() })
  adapter.__feishu.setConfig(CFG)
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  const caps = adapter.caps()
  assert.equal(caps.voice, 'file', '语音条要 opus，只能按文件发')
  assert.equal(caps.sticker, false, '通用表情包发不了 → 降级成图片')
  assert.equal(caps.listenAllInGroup, false, '旁听全群要敏感权限，默认按收不到报')
  assert.equal(caps.card, true)
  assert.equal(caps.proactive, 'free', '飞书没有被动回复窗口，可用范围内可随时发')
  assert.equal(caps.replyWindowMs, 0)
  assert.equal(caps.repliesPerMessage, 0)
  assert.equal(caps.maxFileBytes, MAX_FILE_BYTES)
  assert.equal(MAX_FILE_BYTES, 30 * 1024 * 1024, '官方 im/v1/files 上限 30MB')
  assert.equal(MAX_IMAGE_BYTES, 10 * 1024 * 1024, '官方 im/v1/images 上限 10MB')
  await adapter.stop()
})

test('caps：配置只能改小（listenAllInGroup 打开、proactive 收成 none）', async () => {
  const adapter = createFeishuAdapter({ client: makeFakeClient() })
  adapter.__feishu.setConfig({ ...CFG, listenAllInGroup: true, proactive: 'none' })
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  assert.equal(adapter.caps().listenAllInGroup, true, '用户确认申请到权限后可以打开')
  assert.equal(adapter.caps().proactive, 'none')
  await adapter.stop()
})

test('token：缓存复用（两次发送只换一次 token）', async () => {
  const client = makeFakeClient()
  const adapter = createFeishuAdapter({ client })
  adapter.__feishu.setConfig(CFG)
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  const tokenCalls = () => client.calls.filter((c) => c.url.includes('/tenant_access_token/')).length
  const first = tokenCalls()
  assert.ok(first >= 1)
  await adapter.send({ chat: { kind: 'private', id: 'ou_a' }, parts: [{ type: 'text', text: 'a' }], kind: 'reply', note: '' })
  await adapter.send({ chat: { kind: 'private', id: 'ou_a' }, parts: [{ type: 'text', text: 'b' }], kind: 'reply', note: '' })
  assert.equal(tokenCalls(), first, '两次发送应复用缓存 token')
  await adapter.stop()
})

test('未配置：没 appId/appSecret 时报 unconfigured 并抛错，不发请求', async () => {
  const client = makeFakeClient()
  const adapter = createFeishuAdapter({ client })
  const ctx = makeCtx(adapter)
  await assert.rejects(() => adapter.start(ctx), /缺少 App ID/)
  assert.equal(ctx.states.at(-1)[0], 'unconfigured')
  assert.equal(client.calls.length, 0)
})

test('whoami：用 /bot/v3/info 拿 bot.open_id / bot.app_name', async () => {
  const adapter = createFeishuAdapter({ client: makeFakeClient() })
  adapter.__feishu.setConfig(CFG)
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  const me = await adapter.whoami()
  assert.equal(me.account, 'ou_bot')
  assert.equal(me.name, '测试机器人')
  await adapter.stop()
})

test('stop 之后再推事件不 emit，且状态是 stopped', async () => {
  const adapter = createFeishuAdapter({ client: makeFakeClient() })
  adapter.__feishu.setConfig(CFG)
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  await adapter.stop()
  assert.equal(ctx.states.at(-1)[0], 'stopped')
  assert.equal(ctx.__routes.size, 0, 'stop 要撤掉路由')
  const result = adapter.__feishu.injectAfterStop(inboundEvent())
  assert.equal(result.ok, false)
  assert.equal(ctx.emitted.length, 0)
})
