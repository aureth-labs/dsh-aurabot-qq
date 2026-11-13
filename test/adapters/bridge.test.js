// F4 · 通用接入端（bridge）测试：契约测试包 + 协议层单测
// 契约依据：src/gateway/contracts.d.ts、docs/CONTRACTS.md §七/§八；平台端通用包：test/contract/adapter-kit.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAdapterContract, makeCtx } from '../contract/adapter-kit.js'
import { createBridgeAdapter } from '../../src/adapters/bridge/index.js'

const TOKEN = 'bridge-test-token'

// ───────────────────────── harness：bridge 靠 ctx.route 挂的回调收消息 ─────────────────────────

/** 造一个「宿主已经解析好 body」的假 req */
const req = (body, token = TOKEN) => ({ headers: { 'x-bridge-token': token }, body })
/** 造一个 GET 请求（长轮询的另一种形态：参数走 query） */
const getReq = (path, query, token = TOKEN) => ({
  method: 'GET',
  url: `${path}?${new URLSearchParams(query).toString()}`,
  headers: { 'x-bridge-token': token },
})

/** 造一个记录型假 res */
function makeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    payload: undefined,
    setHeader(k, v) { res.headers[k] = v },
    end(text) { res.payload = text === undefined ? undefined : JSON.parse(text) },
  }
  return res
}

/** 走 ctx 里挂的 handler（kit 的 ctx 把所有 route 记在 __routes） */
async function call(ctx, path, body, token = TOKEN) {
  const handler = ctx.__routes.get(path)
  assert.ok(handler, `平台端应当挂上 ${path}`)
  const res = makeRes()
  await handler(req(body, token), res)
  return res
}

/** 走 GET 形态（长轮询）：参数放 query，不读 body */
async function callGet(ctx, path, query, token = TOKEN) {
  const handler = ctx.__routes.get(path)
  assert.ok(handler, `平台端应当挂上 ${path}`)
  const res = makeRes()
  await handler(getReq(path, query, token), res)
  return res
}

const bridgeHarness = {
  // 契约测试包期望 send 直接拿到 messageId，而 bridge 的真实出站是「外部程序来取 + 回执」。
  // autoAck 模拟一个「连着、立刻取走、立刻回执」的外部程序（同步完成，无竞态）；
  // capsFile 不做（用内存态），因为 kit 的 restart 用例要验证「重启后沿用上次声明」。
  makeAdapter: () => createBridgeAdapter({ token: TOKEN, timeoutMs: 300, autoAck: true }),

  /** 合法入站：/hello 声明能力（可选）→ /inbound 推一条 */
  async injectInbound(adapter, ctx) {
    // kit 的用例 5 会在 stop 之后仍然调 injectInbound 来证明「停了就不再 emit」。
    // 此时路由已经撤销（这是对的，见 stop 用例），所以这里模拟「外部程序还在发请求」：
    // 直接调 adapter 内部的入站入口——它会先检查 running/connected，停了就丢弃，绝不 emit。
    if (!ctx.__routes.get('/inbound')) {
      adapter.__bridge.pushAfterStop({
        chat: { kind: 'private', id: 'u-1' },
        sender: { account: 'u-1', name: '张三', role: '' },
        messageId: 'm-stopped',
        at: Date.now(),
        parts: [{ type: 'text', text: '停了以后' }],
      })
      return
    }
    await call(ctx, '/hello', { protocol: 1, caps: { image: true, proactive: 'free' }, self: { account: 'bot-1', name: '外部程序' } })
    await call(ctx, '/inbound', {
      chat: { kind: 'private', id: 'u-1' },
      sender: { account: 'u-1', name: '张三', role: '' },
      messageId: 'm-1',
      at: Date.now(),
      parts: [{ type: 'text', text: '来自外部程序' }],
    })
  },

  /** 鉴权不过：token 错 → 401 且不 emit */
  async injectUnverified(adapter, ctx) {
    await call(ctx, '/inbound', {
      chat: { kind: 'private', id: 'u-1' },
      sender: { account: 'u-1', name: '张三' },
      messageId: 'm-bad',
      at: Date.now(),
      parts: [{ type: 'text', text: '伪造' }],
    }, 'wrong-token')
  },

  /** 鉴权通过也算「验签通过」这一条 */
  async injectSigned(adapter, ctx) {
    await call(ctx, '/inbound', {
      chat: { kind: 'group', id: 'g-1' },
      sender: { account: 'u-2', name: '李四' },
      messageId: 'm-signed',
      at: Date.now(),
      parts: [{ type: 'text', text: '验签通过' }],
    })
  },

  setProactive(adapter, value) {
    // caps 由外部程序声明；直接改内部状态并让网关重读（等价于外部程序重新 /hello）
    adapter.__bridge.injectCaps({ proactive: value })
  },

  failSend(adapter, why) {
    adapter.__bridge.injectFail(why)
  },

  reconnect(adapter, ctx) {
    // bridge 的「重连」= 外部程序重新连上：状态回 connected
    ctx.state('connected')
  },
}

// kit 里「验签通过」和「合法入站」是两条独立用例，都要能让 emit 恰好一次

test('bridge 平台端过全套契约（runAdapterContract）', async () => {
  await runAdapterContract(bridgeHarness.makeAdapter, bridgeHarness)
})

// ───────────────────────── 协议层单测 ─────────────────────────

test('hello：外部程序声明 caps 后网关能读到；协议版本不对拒绝', async () => {
  const adapter = createBridgeAdapter({ token: TOKEN, timeoutMs: 100 })
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  assert.equal(adapter.caps().image, false, '声明前按最保守报')
  assert.equal(adapter.caps().proactive, 'none')

  let res = await call(ctx, '/hello', { protocol: 1, caps: { image: true, mention: true, proactive: 'free', maxFileBytes: 1024 } })
  assert.equal(res.statusCode, 200)
  assert.equal(adapter.caps().image, true)
  assert.equal(adapter.caps().mention, true)
  assert.equal(adapter.caps().proactive, 'free')
  assert.equal(adapter.caps().maxFileBytes, 1024)
  assert.ok(ctx.capsChanges >= 1, '能力变了要调 capsChanged')

  res = await call(ctx, '/hello', { protocol: 2 })
  assert.equal(res.statusCode, 400)
  await adapter.stop()
})

test('鉴权：缺 token / 错 token 一律 401 且不 emit；配置里没 token 时启动即未配置', async () => {
  const adapter = createBridgeAdapter({ token: TOKEN, timeoutMs: 100 })
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  const body = { chat: { kind: 'private', id: 'u' }, sender: { account: 'u', name: '' }, messageId: 'x', at: Date.now(), parts: [{ type: 'text', text: 'hi' }] }
  let res = await call(ctx, '/inbound', body, '')
  assert.equal(res.statusCode, 401)
  res = await call(ctx, '/inbound', body, 'nope')
  assert.equal(res.statusCode, 401)
  assert.equal(ctx.emitted.length, 0, '鉴权失败绝不能 emit')
  await adapter.stop()

  // 没配 token：不允许「空口令全放行」
  const bare = createBridgeAdapter({})
  const ctx2 = makeCtx(bare)
  await bare.start(ctx2)
  assert.equal(ctx2.states.at(-1)[0], 'unconfigured')
  assert.equal(ctx2.__routes.size, 4, '路由挂着，但每个请求都会 401')
  await bare.stop()
})

test('入站校验：缺字段/非法 kind 返回 400 且不 emit', async () => {
  const adapter = createBridgeAdapter({ token: TOKEN, timeoutMs: 100 })
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  for (const bad of [
    {},
    { chat: { kind: 'voice', id: 'x' }, sender: { account: 'a' }, messageId: 'm', parts: [{ type: 'text', text: '' }] },
    { chat: { kind: 'private', id: '' }, sender: { account: 'a' }, messageId: 'm', parts: [{ type: 'text', text: '' }] },
    { chat: { kind: 'private', id: 'x' }, sender: { account: '' }, messageId: 'm', parts: [{ type: 'text', text: '' }] },
    { chat: { kind: 'private', id: 'x' }, sender: { account: 'a' }, messageId: '', parts: [{ type: 'text', text: '' }] },
    { chat: { kind: 'private', id: 'x' }, sender: { account: 'a' }, messageId: 'm', parts: [] },
  ]) {
    const res = await call(ctx, '/inbound', bad)
    assert.equal(res.statusCode, 400, `应当拒绝：${JSON.stringify(bad)}`)
  }
  assert.equal(ctx.emitted.length, 0)
  await adapter.stop()
})

test('出站：外部程序取走并回执 ok → send 成功', async () => {
  const adapter = createBridgeAdapter({ token: TOKEN, timeoutMs: 500 })
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  await call(ctx, '/hello', { protocol: 1, caps: { proactive: 'free' } })

  const pending = adapter.send({ chat: { kind: 'private', id: 'u-1' }, parts: [{ type: 'text', text: '发我' }], kind: 'reply', note: 't' })
  await delay(20)
  const res = await call(ctx, '/outbound', {})
  assert.equal(res.statusCode, 200)
  assert.equal(res.payload.message.parts[0].text, '发我')
  const ack = await call(ctx, '/ack', { id: res.payload.message.id, ok: true, messageId: 'ext-42' })
  assert.equal(ack.statusCode, 200)
  assert.deepEqual(await pending, { messageId: 'ext-42' })
  await adapter.stop()
})

test('出站失败分类：没人取 → not-sent；取走后不回执 → unknown（绝不重发）', async () => {
  // 没人取
  const a1 = createBridgeAdapter({ token: TOKEN, timeoutMs: 80 })
  const c1 = makeCtx(a1)
  await a1.start(c1)
  await call(c1, '/hello', { protocol: 1, caps: { proactive: 'free' } })
  await assert.rejects(
    () => a1.send({ chat: { kind: 'private', id: 'u' }, parts: [{ type: 'text', text: 'x' }], kind: 'reply', note: '' }),
    (e) => e.certainty === 'not-sent' && e.code === 'not-taken',
    '没人取 = 确定没发出去 = not-sent（可入队重试）',
  )
  await a1.stop()

  // 取走但没回执
  const a2 = createBridgeAdapter({ token: TOKEN, timeoutMs: 80 })
  const c2 = makeCtx(a2)
  await a2.start(c2)
  await call(c2, '/hello', { protocol: 1, caps: { proactive: 'free' } })
  const pending = a2.send({ chat: { kind: 'private', id: 'u' }, parts: [{ type: 'text', text: 'y' }], kind: 'reply', note: '' })
  await delay(10)
  await call(c2, '/outbound', {}) // 取走，但绝不回执
  await assert.rejects(
    () => pending,
    (e) => e.certainty === 'unknown' && e.code === 'no-ack',
    '已取走 = 可能发出去了 = unknown（绝不重发）',
  )
  await a2.stop()
})

test('出站：回执 ok:false → not-sent（外部程序明确说没发出去）', async () => {
  const adapter = createBridgeAdapter({ token: TOKEN, timeoutMs: 500 })
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  await call(ctx, '/hello', { protocol: 1, caps: { proactive: 'free' } })
  const pending = adapter.send({ chat: { kind: 'private', id: 'u' }, parts: [{ type: 'text', text: 'z' }], kind: 'reply', note: '' })
  await delay(20)
  const res = await call(ctx, '/outbound', {})
  await call(ctx, '/ack', { id: res.payload.message.id, ok: false, error: 'peer-500' })
  await assert.rejects(() => pending, (e) => e.certainty === 'not-sent' && e.code === 'peer-500')
  await adapter.stop()
})

test('proactive=none：主动消息被拒且不入队；带 inResponseTo 的能发', async () => {
  const adapter = createBridgeAdapter({ token: TOKEN, timeoutMs: 300 })
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  await call(ctx, '/hello', { protocol: 1, caps: { proactive: 'none' } })
  await assert.rejects(
    () => adapter.send({ chat: { kind: 'private', id: 'u' }, parts: [{ type: 'text', text: '主动' }], kind: 'reply', note: '' }),
    (e) => e.certainty === 'not-sent' && e.code === 'proactive-not-allowed',
  )
  assert.equal(adapter.__bridge.queueLength(), 0, '被拒的不入队')

  const pending = adapter.send({ chat: { kind: 'private', id: 'u' }, parts: [{ type: 'text', text: '被动' }], kind: 'reply', note: '', inResponseTo: 'm-1' })
  await delay(20)
  const res = await call(ctx, '/outbound', {})
  assert.equal(res.statusCode, 200)
  await call(ctx, '/ack', { id: res.payload.message.id, ok: true })
  assert.ok((await pending).messageId)
  await adapter.stop()
})

test('stop：在途消息一律按 unknown 结算（不重复发）', async () => {
  const adapter = createBridgeAdapter({ token: TOKEN, timeoutMs: 5000 })
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  await call(ctx, '/hello', { protocol: 1, caps: { proactive: 'free' } })
  const pending = adapter.send({ chat: { kind: 'private', id: 'u' }, parts: [{ type: 'text', text: 'q' }], kind: 'reply', note: '' })
  await delay(20)
  await call(ctx, '/outbound', {}) // 取走
  await adapter.stop()
  await assert.rejects(() => pending, (e) => e.certainty === 'unknown' && e.code === 'stopped')
})

test('stop 之后路由撤销，再请求不再生效（handler 已移除）', async () => {
  const adapter = createBridgeAdapter({ token: TOKEN, timeoutMs: 100 })
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  assert.equal(ctx.__routes.size, 4)
  await adapter.stop()
  assert.equal(ctx.__routes.size, 0, 'stop 后 ctx.route 的撤掉函数要全部执行')
})

test('whoami：声明 self 后用外部程序给的身份', async () => {
  const adapter = createBridgeAdapter({ token: TOKEN, timeoutMs: 100 })
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  await call(ctx, '/hello', { protocol: 1, caps: {}, self: { account: 'bot-9', name: '我的自建平台' } })
  assert.deepEqual(await adapter.whoami(), { account: 'bot-9', name: '我的自建平台' })
  await adapter.stop()
})

test('toParts：OneBot 风格原生段转契约 parts', () => {
  const adapter = createBridgeAdapter({ token: TOKEN })
  const parts = adapter.toParts([
    { type: 'text', data: { text: '嗨' } },
    { type: 'image', data: { url: 'https://x/a.png' } },
    { type: 'at', data: { qq: '10002', name: '小明' } },
    { type: 'weird' },
  ])
  assert.deepEqual(parts.map((p) => p.type), ['text', 'image', 'mention', 'other'])
  assert.equal(parts[0].text, '嗨')
  assert.equal(parts[2].account, '10002')
})

// ───────────────────────── 长轮询语义 ─────────────────────────

test('长轮询：GET ?wait=true 有消息立刻返回；没消息到点回 204', async () => {
  const adapter = createBridgeAdapter({ token: TOKEN, timeoutMs: 2000 })
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  await call(ctx, '/hello', { protocol: 1, caps: { proactive: 'free' } })

  const pending = adapter.send({ chat: { kind: 'private', id: 'u' }, parts: [{ type: 'text', text: '长轮询取我' }], kind: 'reply', note: '' })
  const res = await callGet(ctx, '/outbound', { wait: 'true', timeoutMs: '1000' })
  assert.equal(res.statusCode, 200, 'GET + query 也要能取件')
  assert.equal(res.payload.message.parts[0].text, '长轮询取我')
  await call(ctx, '/ack', { id: res.payload.message.id, ok: true })
  assert.ok((await pending).messageId)

  // 队列空了：带 wait 也要到点返回 204，而不是永远挂着
  const started = Date.now()
  const empty = await callGet(ctx, '/outbound', { wait: 'true', timeoutMs: '80' })
  assert.equal(empty.statusCode, 204)
  assert.ok(Date.now() - started >= 60, '确实等了，不是立刻返回')
  await adapter.stop()
})

test('长轮询：挂起期间新消息进队列会把请求唤醒（不必等满 timeout）', async () => {
  const adapter = createBridgeAdapter({ token: TOKEN, timeoutMs: 2000 })
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  await call(ctx, '/hello', { protocol: 1, caps: { proactive: 'free' } })

  const started = Date.now()
  const poll = callGet(ctx, '/outbound', { wait: 'true', timeoutMs: '5000' })
  await delay(30)
  const pending = adapter.send({ chat: { kind: 'private', id: 'u' }, parts: [{ type: 'text', text: '晚到的' }], kind: 'reply', note: '' })
  const res = await poll
  assert.equal(res.statusCode, 200, '新消息应当唤醒挂起的长轮询')
  assert.ok(Date.now() - started < 1000, `不该等满 5000ms（实际 ${Date.now() - started}ms）`)
  await call(ctx, '/ack', { id: res.payload.message.id, ok: true })
  await pending
  await adapter.stop()
})

test('长轮询：stop 会唤醒挂起的请求（不让 HTTP 干等）', async () => {
  const adapter = createBridgeAdapter({ token: TOKEN, timeoutMs: 5000 })
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  await call(ctx, '/hello', { protocol: 1, caps: { proactive: 'free' } })
  const started = Date.now()
  const poll = callGet(ctx, '/outbound', { wait: 'true', timeoutMs: '5000' })
  await delay(30)
  await adapter.stop()
  const res = await poll
  assert.equal(res.statusCode, 204)
  assert.ok(Date.now() - started < 1000, `stop 应当唤醒挂起请求（实际 ${Date.now() - started}ms）`)
})

// ───────────────────────── settings / 令牌来自配置 ─────────────────────────

test('settings 由面板配置驱动：ctx.config() 里的 token/timeoutMs/maxBytes 生效', async () => {
  // 构造时不给 token：只靠面板配置（这正是真实部署的样子）
  const adapter = createBridgeAdapter({})
  const ctx = makeCtx(adapter)
  adapter.__config = { token: 'from-panel', timeoutMs: 50 }
  await adapter.start(ctx)
  assert.equal(ctx.states.at(-1)[0], 'connected', '配置里有 token 就该连上，不是 unconfigured')

  // 旧 token 不再有效
  let res = await call(ctx, '/inbound', { chat: { kind: 'private', id: 'u' }, sender: { account: 'u' }, messageId: 'm', parts: [{ type: 'text', text: 'x' }] }, TOKEN)
  assert.equal(res.statusCode, 401)
  // 配置里的 token 有效
  res = await call(ctx, '/inbound', { chat: { kind: 'private', id: 'u' }, sender: { account: 'u' }, messageId: 'm', parts: [{ type: 'text', text: 'x' }] }, 'from-panel')
  assert.equal(res.statusCode, 200)
  assert.equal(ctx.emitted.length, 1)

  // timeoutMs 也从配置来：50ms 内没人取 → not-sent
  await call(ctx, '/hello', { protocol: 1, caps: { proactive: 'free' } }, 'from-panel')
  await assert.rejects(
    () => adapter.send({ chat: { kind: 'private', id: 'u' }, parts: [{ type: 'text', text: 'y' }], kind: 'reply', note: '' }),
    (e) => e.certainty === 'not-sent' && e.code === 'not-taken',
  )
  await adapter.stop()
})

test('入站也受 maxBytes 限制：超大消息回 413 且不 emit', async () => {
  const adapter = createBridgeAdapter({ token: TOKEN, maxBytes: 200 })
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  const res = await call(ctx, '/inbound', {
    chat: { kind: 'private', id: 'u' },
    sender: { account: 'u' },
    messageId: 'big',
    parts: [{ type: 'text', text: 'x'.repeat(500) }],
  })
  assert.equal(res.statusCode, 413)
  assert.equal(ctx.emitted.length, 0, '超限消息绝不能 emit')
  await adapter.stop()
})

test('协议版本：入站/回执里带了 protocol≠1 一律 400 且不 emit', async () => {
  const adapter = createBridgeAdapter({ token: TOKEN, timeoutMs: 100 })
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  const res = await call(ctx, '/inbound', {
    protocol: 2,
    chat: { kind: 'private', id: 'u' },
    sender: { account: 'u' },
    messageId: 'm',
    parts: [{ type: 'text', text: 'x' }],
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.payload.error, 'protocol-unsupported')
  assert.equal(ctx.emitted.length, 0)
  await adapter.stop()
})

// ───────────────────────── 重启后队列不丢 ─────────────────────────

test('重启后队列不丢：进程重启前没被取走的消息，重启后外部程序还能取到', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-queue-'))
  try {
    // 第一段进程：消息进队列，没人取走，然后「进程死掉」
    const a1 = createBridgeAdapter({ token: TOKEN, timeoutMs: 60_000, dataDir: () => dir })
    const c1 = makeCtx(a1)
    await a1.start(c1)
    await call(c1, '/hello', { protocol: 1, caps: { proactive: 'free' } })
    const first = a1.send({ chat: { kind: 'private', id: 'u-1' }, parts: [{ type: 'text', text: '重启前没发出去的' }], kind: 'reply', note: '' })
    first.catch(() => {}) // 进程「死了」，promise 永远不会 settle，忽略
    await delay(20)
    assert.equal(a1.__bridge.queueLength(), 1)
    assert.ok(a1.__bridge.pendingFile(), '给了绝对 dataDir 才落盘')
    a1.__bridge.crashForTest()

    // 第二段进程：新实例，同一个数据目录 → 队列装回来，外部程序能取到并回执
    const a2 = createBridgeAdapter({ token: TOKEN, timeoutMs: 60_000, dataDir: () => dir })
    const c2 = makeCtx(a2)
    await a2.start(c2)
    assert.equal(a2.__bridge.queueLength(), 1, '重启后应恢复 1 条未取走的消息')
    assert.equal(a2.caps().image, false, '跨进程重启 caps 退回最保守，等外部程序重新 hello')
    await call(c2, '/hello', { protocol: 1, caps: { proactive: 'free' } })
    const res = await call(c2, '/outbound', {})
    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.message.parts[0].text, '重启前没发出去的')
    assert.equal(res.payload.message.recovered, true, '恢复的消息带 recovered 标记，外部程序据此知道它比预期晚')
    await call(c2, '/ack', { id: res.payload.message.id, ok: true, messageId: 'ext-restart-1' })
    assert.equal(a2.__bridge.queueLength(), 0)
    assert.equal(a2.__bridge.inflightCount(), 0)
    await a2.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('重启后队列不丢：已被取走的不落盘（它已经是 unknown，重发就是两条）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-queue2-'))
  try {
    const a1 = createBridgeAdapter({ token: TOKEN, timeoutMs: 60_000, dataDir: () => dir })
    const c1 = makeCtx(a1)
    await a1.start(c1)
    await call(c1, '/hello', { protocol: 1, caps: { proactive: 'free' } })
    const pending = a1.send({ chat: { kind: 'private', id: 'u' }, parts: [{ type: 'text', text: '被取走了' }], kind: 'reply', note: '' })
    pending.catch(() => {})
    await delay(20)
    const res = await call(c1, '/outbound', {}) // 取走，但绝不回执
    assert.equal(a1.__bridge.queueLength(), 0)
    assert.equal(a1.__bridge.inflightCount(), 1)
    a1.__bridge.crashForTest()

    const a2 = createBridgeAdapter({ token: TOKEN, timeoutMs: 60_000, dataDir: () => dir })
    const c2 = makeCtx(a2)
    await a2.start(c2)
    assert.equal(a2.__bridge.queueLength(), 0, '已被取走的消息绝不能恢复——否则会重复发')
    assert.equal(a2.__bridge.inflightCount(), 0)
    const empty = await call(c2, '/outbound', {})
    assert.equal(empty.statusCode, 204)
    await a2.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('优雅 stop 会把未取走的消息按 not-sent 还给网关，并清空落盘（不让两层各发一次）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-queue3-'))
  try {
    const adapter = createBridgeAdapter({ token: TOKEN, timeoutMs: 60_000, dataDir: () => dir })
    const ctx = makeCtx(adapter)
    await adapter.start(ctx)
    await call(ctx, '/hello', { protocol: 1, caps: { proactive: 'free' } })
    const pending = adapter.send({ chat: { kind: 'private', id: 'u' }, parts: [{ type: 'text', text: '还没取' }], kind: 'reply', note: '' })
    await delay(20)
    await adapter.stop()
    await assert.rejects(() => pending, (e) => e.certainty === 'not-sent' && e.code === 'stopped', '未被取走 = 确定没发出去 = not-sent（网关补发队列接手）')

    // 落盘清空：重启不会再交一遍
    const again = createBridgeAdapter({ token: TOKEN, timeoutMs: 60_000, dataDir: () => dir })
    const c2 = makeCtx(again)
    await again.start(c2)
    assert.equal(again.__bridge.queueLength(), 0, '网关已经拿到 not-sent，重启不该再交一遍')
    await again.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
