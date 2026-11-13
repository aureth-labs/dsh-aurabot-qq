// F1 · 飞书平台端测试：契约测试包 + 加解密/验签 + 事件转换 + 错误分类
// 契约依据：src/gateway/contracts.d.ts、docs/CONTRACTS.md §六/§七/§八
// 全部用可注入的假 HTTP client，不打真网络。加解密用 node:crypto 真算（可离线验证）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createHash } from 'node:crypto'
import { runAdapterContract, makeCtx } from '../contract/adapter-kit.js'
import {
  createFeishuAdapter,
  decryptEvent,
  verifySignature,
  toParts,
  fromParts,
} from '../../src/adapters/feishu/index.js'

const APP_ID = 'cli_test'
const APP_SECRET = 'secret'
const ENCRYPT_KEY = 'test-encrypt-key'

// ───────────────────────── 假 HTTP client ─────────────────────────

function makeFakeClient() {
  const calls = []
  let failNext = null
  return {
    calls,
    failOnce(why) { failNext = why },
    async request(req) {
      calls.push({ ...req })
      if (failNext) {
        const why = failNext
        failNext = null
        if (why === 'timeout') throw Object.assign(new Error('timeout'), { name: 'AbortError' })
        if (why === 'network') throw new Error('ECONNRESET')
        if (why === 'reject') return { status: 400, json: { code: 230001, msg: 'invalid receive_id' } }
      }
      if (req.url.includes('/tenant_access_token/')) return { status: 200, json: { code: 0, tenant_access_token: 't-test', expire: 7200 } }
      if (req.url.includes('/open-apis/bot/v3/info')) return { status: 200, json: { code: 0, bot: { open_id: 'ou_bot', app_name: '测试机器人' } } }
      if (req.url.includes('/open-apis/im/v1/messages')) return { status: 200, json: { code: 0, data: { message_id: `om_${calls.length}` } } }
      if (req.url.includes('/open-apis/im/v1/images')) return { status: 200, json: { code: 0, data: { image_key: 'img_key_1' } } }
      if (req.url.includes('/open-apis/im/v1/files')) return { status: 200, json: { code: 0, data: { file_key: 'file_key_1' } } }
      return { status: 200, json: { code: 0, data: {} } }
    },
  }
}

// ───────────────────────── 加解密工具（造加密包） ─────────────────────────

function encryptEvent(encryptKey, plaintext) {
  const key = createHash('sha256').update(encryptKey, 'utf8').digest()
  const iv = Buffer.from('0123456789abcdef', 'utf8')
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  return Buffer.concat([iv, enc]).toString('base64')
}

function sign({ timestamp, nonce, encryptKey, body }) {
  return createHash('sha256').update(timestamp).update(nonce).update(encryptKey).update(body).digest('hex')
}

// ───────────────────────── harness ─────────────────────────

const makeRes = () => ({ statusCode: 0, payload: undefined, setHeader() {}, end(t) { this.payload = t ? JSON.parse(t) : undefined } })

async function post(ctx, path, bodyObj, headers = {}) {
  const res = makeRes()
  const handler = ctx.__routes.get(path)
  if (!handler) return { statusCode: 0, payload: { skipped: true } }
  await handler({ headers, body: JSON.stringify(bodyObj) }, res)
  return res
}

const CFG = { appId: APP_ID, appSecret: APP_SECRET }

function inboundEvent(over = {}) {
  return {
    schema: '2.0',
    header: { event_id: 'ev-1', event_type: 'im.message.receive_v1', tenant_key: 'tk' },
    event: {
      sender: { sender_id: { open_id: 'ou_user1', union_id: 'on_union1' } },
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

function makeHarness({ encrypted = false } = {}) {
  return {
    makeAdapter() {
      const client = makeFakeClient()
      const adapter = createFeishuAdapter({ client })
      adapter.__fakeClient = client
      // 两种模式都配上 encryptKey：飞书里「配了加密策略」就一定会带 X-Lark-Signature，
      // 明文事件也可以带签名。契约用例 7（验签不过必须拒绝）只有在配了 key 时才有意义。
      adapter.__feishu.setConfig({ ...CFG, encryptKey: ENCRYPT_KEY })
      return adapter
    },
    async injectInbound(adapter, ctx) {
      const event = inboundEvent()
      // kit 用例 5 在 stop 之后再调一次，证明「停了不再 emit」。
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

// ───────────────────────── 契约测试包 ─────────────────────────

test('飞书平台端过全套契约（明文模式）', async () => {
  const h = makeHarness()
  await runAdapterContract(h.makeAdapter, h)
})

test('飞书平台端过全套契约（加密+验签模式）', async () => {
  const h = makeHarness({ encrypted: true })
  await runAdapterContract(h.makeAdapter, h)
})

// ───────────────────────── 加解密 / 验签 ─────────────────────────

test('解密：AES-256-CBC + sha256(key) + IV 前缀，能还原明文', () => {
  const plain = JSON.stringify({ hello: '世界', n: 42 })
  const enc = encryptEvent(ENCRYPT_KEY, plain)
  assert.equal(decryptEvent(ENCRYPT_KEY, enc), plain)
  assert.throws(() => decryptEvent('wrong-key', enc))
  assert.throws(() => decryptEvent(ENCRYPT_KEY, Buffer.from('short').toString('base64')))
})

test('验签：sha256(timestamp+nonce+encryptKey+body)，篡改 body 必失败', () => {
  const args = { timestamp: '1700000000', nonce: 'abc', encryptKey: ENCRYPT_KEY, body: '{"a":1}' }
  const sig = sign(args)
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
  const res = await post(ctx, '/callback', { challenge: 'abc123', type: 'url_verification', token: 't' })
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
  ctx.__routes.get('/callback')({ headers: { 'x-lark-request-timestamp': timestamp, 'x-lark-request-nonce': nonce, 'x-lark-signature': 'bad' }, body: encrypted }, res)
  assert.equal(res.statusCode, 401)
  assert.equal(ctx.emitted.length, 0, '验签不过绝不能 emit')

  res = makeRes()
  ctx.__routes.get('/callback')({
    headers: { 'x-lark-request-timestamp': timestamp, 'x-lark-request-nonce': nonce, 'x-lark-signature': sign({ timestamp, nonce, encryptKey: ENCRYPT_KEY, body: encrypted }) },
    body: encrypted,
  }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(ctx.emitted.length, 1)
  assert.equal(ctx.emitted[0].parts[0].text, '来自飞书')
  await adapter.stop()
})

// ───────────────────────── 事件转换 ─────────────────────────

test('事件转换：p2p/群聊、open_id 作 account、union_id 作 alt', async () => {
  const adapter = createFeishuAdapter({ client: makeFakeClient() })
  adapter.__feishu.setConfig(CFG)
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  await post(ctx, '/callback', inboundEvent({ message: { chat_id: 'oc_g', chat_type: 'group' } }))
  const m = ctx.emitted.at(-1)
  assert.equal(m.chat.kind, 'group')
  assert.equal(m.chat.id, 'oc_g')
  assert.equal(m.sender.account, 'ou_user1', 'account 用 open_id')
  assert.equal(m.sender.alt, 'on_union1', 'alt 存 union_id')
  assert.equal(m.messageId, 'om-1')
  await adapter.stop()
})

test('事件转换：文本里的 @ 拆成 mention；@自己 → mentionedMe 且不进 parts', async () => {
  const adapter = createFeishuAdapter({ client: makeFakeClient() })
  adapter.__feishu.setConfig(CFG)
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  adapter.__feishu.setSelf({ account: 'ou_me', name: '我' })

  await post(ctx, '/callback', inboundEvent({
    message: {
      chat_id: 'oc_1', chat_type: 'group', message_type: 'text',
      content: JSON.stringify({ text: '<at user_id="ou_me">我</at> <at user_id="ou_other">小明</at> 你们看' }),
    },
  }))
  const m = ctx.emitted.at(-1)
  assert.equal(m.mentionedMe, true, '@自己体现在 mentionedMe')
  assert.ok(!m.parts.some((p) => p.type === 'mention' && p.account === 'ou_me'), '@自己不进 parts')
  assert.ok(m.parts.some((p) => p.type === 'mention' && p.account === 'ou_other'))
  assert.ok(m.parts.some((p) => p.type === 'text' && p.text.includes('你们看')))
  await adapter.stop()
})

test('事件转换：图片/文件/语音/富文本/未知类型', () => {
  assert.deepEqual(toParts('image', JSON.stringify({ image_key: 'k1' }))[0], { type: 'image', media: { id: 'k1', mime: 'image/png' } })
  const f = toParts('file', JSON.stringify({ file_key: 'k2', file_name: 'a.pdf' }))[0]
  assert.equal(f.type, 'file')
  const v = toParts('audio', JSON.stringify({ file_key: 'k3', duration: 1200 }))[0]
  assert.equal(v.type, 'voice')
  assert.equal(v.durationMs, 1200)
  const rich = toParts('post', JSON.stringify({ title: '', content: [[{ tag: 'text', text: '你好' }, { tag: 'img', image_key: 'k4' }]] }))
  assert.ok(rich.some((p) => p.type === 'text' && p.text === '你好'))
  assert.ok(rich.some((p) => p.type === 'image' && p.media.id === 'k4'))
  assert.equal(toParts('weird_type', '{}')[0].type, 'other')
})

test('出站转换：一条飞书消息只能带一种 msg_type，多段要拆', () => {
  const sends = fromParts([
    { type: 'text', text: '看图' },
    { type: 'image', media: { id: 'ik1' } },
    { type: 'text', text: '还有字' },
    { type: 'mention', account: 'ou_x', name: '小明' },
  ])
  assert.equal(sends.length, 3, '文本 / 图片 / 文本+@ 要拆成三条')
  assert.equal(sends[0].msgType, 'text')
  assert.equal(sends[1].msgType, 'image')
  // content 是 JSON 字符串，引号在里面是转义的，所以解出来再比
  assert.ok(JSON.parse(sends[2].content).text.includes('<at user_id="ou_x">小明</at>'))

  const all = fromParts([{ type: 'mention', account: 'all', name: '' }])
  assert.ok(JSON.parse(all[0].content).text.includes('user_id="all"'), '@全体成员用 user_id=all')
})

// ───────────────────────── 出站 / 错误分类 ─────────────────────────

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
  await adapter.stop()
})

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

test('caps：voice 是 file、listenAllInGroup=false、sticker=false、card=true', async () => {
  const adapter = createFeishuAdapter({ client: makeFakeClient() })
  adapter.__feishu.setConfig(CFG)
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  const caps = adapter.caps()
  assert.equal(caps.voice, 'file')
  assert.equal(caps.listenAllInGroup, false)
  assert.equal(caps.sticker, false)
  assert.equal(caps.card, true)
  assert.equal(caps.proactive, 'limited')
  await adapter.stop()
})

test('token：缓存复用', async () => {
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

test('未配置：没 appId/appSecret 时报 unconfigured，不发请求', async () => {
  const client = makeFakeClient()
  const adapter = createFeishuAdapter({ client })
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  assert.equal(ctx.states.at(-1)[0], 'unconfigured')
  assert.equal(client.calls.length, 0)
  await adapter.stop()
})
