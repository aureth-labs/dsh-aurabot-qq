// 平台端通用契约测试包：每一个平台端（内置的、模块注册的、内存假的）都要过这套。
//
// 来源：P0 工作包。许可：MIT。作用：把任务书过关项逐条写成可复用的断言，
// 契约依据：src/gateway/contracts.d.ts（PlatformAdapter / AdapterInbound / SendError / Caps）
// 与 docs/CONTRACTS.md 第六～八节。
//
// 用法（在 test/ 下任一用例文件里）：
//   import { test } from 'node:test'
//   import { runAdapterContract } from './adapter-kit.js'
//   import { makeFakeAdapter, fakeHarness } from '../helpers/fake-adapter.js'
//   test('假平台端过全套契约', async () => {
//     await runAdapterContract(makeFakeAdapter, fakeHarness)
//   })
//
// ───────────────────────── harness 需要的形状 ─────────────────────────
//
// runAdapterContract(makeAdapter, harness)。kit 自己负责 new 一个记录用的 AdapterContext、
// 调 adapter.start(ctx) / adapter.stop()；harness 只负责「平台侧」的事——因为每个平台端
// 连平台的方式不一样（HTTP 回调、WS 推送、内存直推），注入点只能由调用方提供。
//
//   makeAdapter(): PlatformAdapter | Promise<PlatformAdapter>
//       每次给一个全新实例（用例之间不能共用状态）。
//   injectInbound(adapter, ctx): void | Promise<void>
//       让平台往这个平台端推一条**合法**入站（走该平台端的正常收消息通道，
//       比如 WS 推送、验签通过的回调），平台端应因此恰好 ctx.emit 一条 AdapterInbound。
//   injectUnverified(adapter, ctx): void | Promise<void>
//       让平台以「验签不过」的方式送来一条回调。平台端必须拒绝且**不 emit**。
//       （走 ctx.route 挂的 handler 的平台，实现里调 ctx.__routes.get('/callback')(req, res) 即可，
//        kit 的 ctx 把所有挂上的 handler 记在 ctx.__routes 这个 Map 里，路径原样。）
//   injectSigned(adapter, ctx): void | Promise<void>
//       让平台以「验签通过」的方式送来一条回调，平台端应恰好 emit 一条。
//   setProactive(adapter, value): void | Promise<void>
//       把 caps().proactive 切成 'free' 或 'none'（切完要让网关知道，即调 ctx.capsChanged()；
//       harness 拿不到 ctx 就把这件事做在 setProactive 的实现里，kit 只看行为）。
//   failSend(adapter, why): void
//       why = 'refused'：下一次 send 模拟「连不上 / 平台明确拒绝」，平台端必须抛
//                        certainty='not-sent' 的 SendError；
//       why = 'timeout'：下一次 send 模拟「一直不返回」，平台端必须按 timeoutMs 超时并抛
//                        certainty='unknown' 的 SendError。
//   reconnect(adapter, ctx)?（可选）：模拟断线后重连。不提供就跳过对应条目。
//   config（可选）：这个实例在 config.platforms 里的那一段，经 makeCtx(adapter, config)
//       注入给平台端的 ctx.config()。平台端的 settings（token / appId / wsUrl …）靠它生效。
//       **不要再靠 adapter.__config 后门**（那是 P0 早期的缺陷，现在有正式入口）。
//
// kit 对 emit 的计数是精确的（增量必须恰好为 1 或 0），所以 harness 的注入一次只送一条。

import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

/** 本 kit 自己的 SendError 判定：普通 Error 带 certainty / instance 字段（网关 errors.js 还没实现）。 */
function assertSendError(error, certainty, instance, label) {
  assert.ok(error instanceof Error, `${label}：应抛 Error，实际抛了 ${typeof error}`)
  assert.equal(error.certainty, certainty, `${label}：certainty 应为 '${certainty}'，实际是 '${error.certainty}'`)
  if (instance != null) assert.equal(error.instance, instance, `${label}：SendError.instance 应为 '${instance}'`)
}

/** 发一条消息的快捷方式。 */
const send = (adapter, partial = {}) => adapter.send({
  chat: { kind: 'private', id: '10001' },
  parts: [{ type: 'text', text: '契约测试' }],
  kind: 'reply',
  note: 'adapter-kit',
  ...partial,
})

/**
 * 按 caps 造「声明支持的」parts：文本 + 逐个媒体类型。
 * 媒体同时带 id 和 url：有 id 的平台端直接用（飞书/QQ 这类要用平台内 key 的），
 * 只有 url 的平台端自己下载或忽略——契约不要求平台端一定能抓到外网 URL
 * （kit 跑在离线环境里，真去下载 example.com 必然失败）。
 */
function supportedParts(caps) {
  const parts = [{ type: 'text', text: '能力自检' }]
  if (caps.image) parts.push({ type: 'image', media: { id: 'kit-image-1', url: 'https://example.com/a.png', mime: 'image/png' } })
  if (caps.sticker) parts.push({ type: 'sticker', media: { id: 'kit-sticker-1', url: 'https://example.com/s.png' }, label: '[测试表情]' })
  if (caps.voice) parts.push({ type: 'voice', media: { id: 'kit-voice-1', url: 'https://example.com/a.mp3' }, durationMs: 1200 })
  if (caps.video) parts.push({ type: 'video', media: { id: 'kit-video-1', url: 'https://example.com/v.mp4' } })
  if (caps.file) parts.push({ type: 'file', media: { id: 'kit-file-1', url: 'https://example.com/f.txt', name: 'f.txt', size: Math.min(1024, caps.maxFileBytes || 1024) } })
  if (caps.mention) parts.push({ type: 'mention', account: '10002', name: '小明' })
  if (caps.poke) parts.push({ type: 'poke' })
  return parts
}

/**
 * 跑完整套平台端契约。断言失败直接抛（外层 test 会红）。
 * @param {Function} makeAdapter  每次返回全新 PlatformAdapter
 * @param {object}   harness      形状见文件头
 */
export async function runAdapterContract(makeAdapter, harness) {
  assert.ok(harness, 'runAdapterContract 需要第二个参数 harness（形状见本文件头）')
  for (const key of ['injectInbound', 'injectUnverified', 'injectSigned', 'setProactive', 'failSend']) {
    assert.equal(typeof harness[key], 'function', `harness.${key} 必须是函数（形状见 adapter-kit 文件头）`)
  }

  // ── 用例 1：start → connected，whoami 返回账号 ──
  {
    const adapter = await makeAdapter()
    assert.equal(adapter.contract, 1, `${adapter.id}：contract 必须是 1`)
    const ctx = makeCtx(adapter, harness.config)
    await adapter.start(ctx)
    assert.equal(ctx.states.at(-1)?.[0], 'connected', `${adapter.id}：start 后最后一个状态应为 connected（实际：${ctx.states.map((s) => s[0]).join(' → ')}）`)
    const me = await adapter.whoami()
    assert.ok(me && typeof me.account === 'string' && me.account, `${adapter.id}：whoami() 要返回非空 account`)
    assert.ok('name' in me, `${adapter.id}：whoami() 要返回 name`)
    // caps 必须是完整的一张表（网关直接叠 config.caps 用，缺键 = 撒谎）
    const caps = adapter.caps()
    for (const key of ['image', 'sticker', 'voice', 'video', 'file', 'maxFileBytes', 'quoteReply', 'mention', 'mentionAll', 'poke', 'typing', 'recall', 'card', 'listenAllInGroup', 'proactive', 'replyWindowMs', 'repliesPerMessage', 'history', 'memberList', 'forwardExpand']) {
      assert.ok(key in caps, `${adapter.id}：caps() 缺少 ${key}（能力表要给全，见 CONTRACTS 第八节）`)
    }
    await adapter.stop()
  }

  // ── 用例 2：入站字段齐全 ──
  {
    const adapter = await makeAdapter()
    const ctx = makeCtx(adapter, harness.config)
    await adapter.start(ctx)
    await harness.injectInbound(adapter, ctx)
    assert.equal(ctx.emitted.length, 1, `${adapter.id}：注入一条合法入站后应恰好 emit 一条（实际 ${ctx.emitted.length} 条）`)
    const m = ctx.emitted[0]
    assert.ok(m.chat && (m.chat.kind === 'private' || m.chat.kind === 'group') && m.chat.id, `${adapter.id}：入站 chat 要有 kind（private|group）和非空 id`)
    assert.ok(m.sender && typeof m.sender.account === 'string' && m.sender.account, `${adapter.id}：入站 sender.account 要非空`)
    assert.equal(typeof m.sender.name, 'string', `${adapter.id}：入站 sender.name 要是字符串（可为空串）`)
    assert.ok(['owner', 'admin', 'member', ''].includes(m.sender.role), `${adapter.id}：sender.role 只能是 owner|admin|member|''`)
    assert.equal(typeof m.messageId, 'string', `${adapter.id}：messageId 要是字符串`)
    assert.ok(m.messageId, `${adapter.id}：messageId 要非空（网关按 实例+messageId 去重）`)
    assert.ok(Number.isInteger(m.at) && m.at > 1e11, `${adapter.id}：at 要是毫秒级时间戳（实际 ${m.at}）`)
    assert.equal(typeof m.mentionedMe, 'boolean', `${adapter.id}：mentionedMe 要是布尔值`)
    assert.ok(Array.isArray(m.parts), `${adapter.id}：parts 要是数组`)
    assert.ok('raw' in m, `${adapter.id}：要带 raw（平台原始事件，排障用）`)
    await adapter.stop()
  }

  // ── 用例 3：send 收到 caps 声明支持的 parts 不抛错 ──
  // 注意：platform 若 proactive='none'（只能被动回复），主动 send 必然被拒——这是契约要求的，
  // 不是缺陷。所以这里凡是 proactive 不是 'free' 的平台，先拿一条入站消息的 messageId 当
  // inResponseTo，把这次发送变成「被动回复」，才符合「声明支持的 parts 要能发出去」的原意。
  {
    const adapter = await makeAdapter()
    const ctx = makeCtx(adapter, harness.config)
    await adapter.start(ctx)
    const caps = adapter.caps()
    let inResponseTo
    if (caps.proactive !== 'free') {
      await harness.injectInbound(adapter, ctx)
      inResponseTo = ctx.emitted.at(-1)?.messageId
      assert.ok(inResponseTo, `${adapter.id}：proactive='${caps.proactive}' 时需要入站消息拿 inResponseTo`)
    }
    const result = await send(adapter, { parts: supportedParts(caps), inResponseTo })
    assert.ok(result && typeof result.messageId === 'string' && result.messageId, `${adapter.id}：send 应返回非空 messageId`)
    await adapter.stop()
  }

  // ── 用例 4：连不上 → not-sent；超时 → unknown ──
  // 同用例 3：proactive 不是 'free' 的平台必须先拿一条入站的 messageId 当 inResponseTo，
  // 否则会被 proactive 检查先拦下（那是 not-sent，测不出「超时应为 unknown」这一条）。
  {
    const adapter = await makeAdapter()
    const ctx = makeCtx(adapter, harness.config)
    await adapter.start(ctx)
    const caps = adapter.caps()
    let inResponseTo
    if (caps.proactive !== 'free') {
      await harness.injectInbound(adapter, ctx)
      inResponseTo = ctx.emitted.at(-1)?.messageId
    }
    harness.failSend(adapter, 'refused')
    await assert.rejects(
      () => send(adapter, { inResponseTo }),
      (e) => { assertSendError(e, 'not-sent', ctx.instance, `${adapter.id} 连不上`); return true },
      `${adapter.id}：模拟连不上时应抛 certainty='not-sent' 的 SendError`,
    )
    harness.failSend(adapter, 'timeout')
    await assert.rejects(
      () => send(adapter, { inResponseTo, timeoutMs: 150 }),
      (e) => { assertSendError(e, 'unknown', ctx.instance, `${adapter.id} 超时`); return true },
      `${adapter.id}：模拟超时应抛 certainty='unknown' 的 SendError`,
    )
    await adapter.stop()
  }

  // ── 用例 5：stop 后不再 emit；再 start 能恢复 ──
  {
    const adapter = await makeAdapter()
    const ctx = makeCtx(adapter, harness.config)
    await adapter.start(ctx)
    await harness.injectInbound(adapter, ctx)
    const before = ctx.emitted.length
    await adapter.stop()
    assert.equal(ctx.states.at(-1)?.[0], 'stopped', `${adapter.id}：stop 后状态应为 stopped`)
    await harness.injectInbound(adapter, ctx)
    await delay(20) // 给可能存在的异步 emit 留出落地的机会
    assert.equal(ctx.emitted.length, before, `${adapter.id}：stop 之后平台再推消息也绝不能再 emit`)
    await adapter.start(ctx) // 再 start 要能恢复
    assert.equal(ctx.states.at(-1)?.[0], 'connected', `${adapter.id}：重新 start 后应回到 connected`)
    const me = await adapter.whoami()
    assert.ok(me?.account, `${adapter.id}：重启后 whoami 应正常`)
    await harness.injectInbound(adapter, ctx)
    assert.equal(ctx.emitted.length, before + 1, `${adapter.id}：重启后入站要能继续进来`)
    await adapter.stop()
  }

  // ── 用例 6：proactive='none' 时，不带 inResponseTo 的发送抛 not-sent ──
  {
    const adapter = await makeAdapter()
    const ctx = makeCtx(adapter, harness.config)
    await adapter.start(ctx)
    await harness.setProactive(adapter, 'none')
    assert.equal(adapter.caps().proactive, 'none', `${adapter.id}：harness.setProactive 后 caps().proactive 应为 'none'`)
    await assert.rejects(
      () => send(adapter), // 主动消息：没有 inResponseTo
      (e) => { assertSendError(e, 'not-sent', ctx.instance, `${adapter.id} proactive=none`); return true },
      `${adapter.id}：proactive='none' 时主动消息应抛 certainty='not-sent'`,
    )
    // 带 inResponseTo（被动回复）要能发出去
    await harness.injectInbound(adapter, ctx)
    const inbound = ctx.emitted.at(-1)
    const ok = await send(adapter, { inResponseTo: inbound.messageId, parts: [{ type: 'text', text: '被动回复' }] })
    assert.ok(ok?.messageId, `${adapter.id}：proactive='none' 时带 inResponseTo 的回复应能发出`)
    // 恢复 free，确认主动消息又可用
    await harness.setProactive(adapter, 'free')
    await send(adapter, { parts: [{ type: 'text', text: '恢复主动' }] })
    await adapter.stop()
  }

  // ── 用例 7：验签不过不 emit；验签通过恰好 emit 一条 ──
  {
    const adapter = await makeAdapter()
    const ctx = makeCtx(adapter, harness.config)
    await adapter.start(ctx)
    await harness.injectUnverified(adapter, ctx)
    await delay(20)
    assert.equal(ctx.emitted.length, 0, `${adapter.id}：验签不过的回调必须拒绝且不 emit（CONTRACTS 第八节 5）`)
    await harness.injectSigned(adapter, ctx)
    await delay(20)
    assert.equal(ctx.emitted.length, 1, `${adapter.id}：验签通过的回调应恰好 emit 一条`)
    await adapter.stop()
  }

  // ── 用例 8（可选）：断线重连 ──
  if (typeof harness.reconnect === 'function') {
    const adapter = await makeAdapter()
    const ctx = makeCtx(adapter, harness.config)
    await adapter.start(ctx)
    // 同用例 3/4：proactive 不是 'free' 的平台不能主动发，先拿一条入站消息当 inResponseTo
    const caps = adapter.caps()
    let inResponseTo
    if (caps.proactive !== 'free') {
      await harness.injectInbound(adapter, ctx)
      inResponseTo = ctx.emitted.at(-1)?.messageId
    }
    await harness.reconnect(adapter, ctx)
    assert.equal(ctx.states.at(-1)?.[0], 'connected', `${adapter.id}：重连后状态应回到 connected`)
    const ok = await send(adapter, { inResponseTo })
    assert.ok(ok?.messageId, `${adapter.id}：重连后 send 应恢复`)
    await adapter.stop()
  }
}

/**
 * kit 自带的记录型 AdapterContext：状态、emit、事件、路由都有记录，harness 直接用。
 *
 * @param adapter 平台端
 * @param configOrNull 这个实例在 config.platforms 里的那一段（可选）。
 *   平台端的 settings（token / appId / wsUrl …）就靠它注入——不给就是空对象。
 *   注意：以前只能靠 `adapter.__config` 后门，那是 P0 的缺陷，现在有正式入口了。
 */
export function makeCtx(adapter, configOrNull = null) {
  const ctx = {
    instance: adapter.id, // 单实例约定：实例名 = 平台名
    config: () => ({ ...(adapter.__config || {}), ...(configOrNull || {}) }),
    emitted: [],   // ctx.emit 收到的 AdapterInbound
    events: [],    // ctx.emitEvent 收到的 AdapterEvent
    states: [],    // [state, detail] 序列
    capsChanges: 0,
    routes: new Map(), // path → handler（验签用例的 harness 从这里取 handler）
    route(path, handler) {
      ctx.routes.set(String(path), handler)
      return () => ctx.routes.delete(String(path))
    },
    emit(message) { ctx.emitted.push(message) },
    emitEvent(event) { ctx.events.push(event) },
    state(state, detail) { ctx.states.push([state, detail]) },
    capsChanged() { ctx.capsChanges++ },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    dataDir: (...parts) => parts.join('/'),
  }
  // __routes 是 __routes Map 的别名：文档里写 harness 调 ctx.__routes.get(path) 即可
  ctx.__routes = ctx.routes
  return ctx
}
