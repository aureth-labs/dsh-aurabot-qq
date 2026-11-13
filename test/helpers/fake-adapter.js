// 内存假平台端：给中枢 / 网关 / 模块的测试当平台用，不连任何真实平台。
//
// 来源：P0 工作包。许可：MIT。
// 作用：一个完全符合 PlatformAdapter 契约的可编程假平台端——
//   - 注入入站消息（pushInbound，可重复推同一条模拟重连后的重复推送）
//   - 记录出站消息（sent）
//   - 按指令抛 'not-sent' 或 'unknown'（failNext）
//   - 模拟断线 / 重连（disconnect / reconnect）
//   - 运行中改 caps 并通知网关（setCaps）
//   - 走 ctx.route 的验签回调（pushCallback，签名不对不 emit）
//   - 发送挂起（hangNext）→ 平台端自己按 timeoutMs 超时抛 'unknown'
// 契约：src/gateway/contracts.d.ts；并作为 runAdapterContract（test/contract/adapter-kit.js）
// 的第一个通关样本——它自己必须过全套契约测试。
//
// 用法：
//   import { makeFakeAdapter, fakeHarness } from './helpers/fake-adapter.js'
//   const adapter = makeFakeAdapter()
//   const ctx = fakeHarness.makeCtx(adapter)   // 记录型 AdapterContext
//   await adapter.start(ctx)
//   adapter.pushInbound({ chat: { kind: 'private', id: '10001' }, sender: { account: '10001', name: '张三' }, parts: [{ type: 'text', text: '嗨' }] })
//   // 之后 ctx.emitted / adapter.sent 里就有东西了

import { setTimeout as delay } from 'node:timers/promises'

/** 造 SendError：普通 Error 挂 certainty / code / instance（契约形状，网关 errors.js 还没实现）。 */
function sendError(certainty, code, instance, message) {
  const error = new Error(message || `发送失败（${certainty}${code ? ' / ' + code : ''}）`)
  error.certainty = certainty
  if (code) error.code = code
  error.instance = instance
  return error
}

let seq = 0

/**
 * 建一个假平台端。
 * overrides（全部可选）：
 *   id / name            平台名 / 显示名（默认 'fake' / '假平台'）
 *   self                 { account, name } 机器人自己
 *   caps                 Partial<Caps> 覆盖默认能力表
 *   token                回调验签口令（默认 'fake-token'；签名头 x-fake-signature 必须等于它）
 *   config               ctx.config() 返回的实例配置（如 { proactive: 'none' }）
 *   latencyMs            每次平台侧发送的模拟延迟（默认 0）
 */
export function makeFakeAdapter(overrides = {}) {
  const id = overrides.id || 'fake'
  const instance = id
  const self = overrides.self || { account: 'fake-bot', name: '假机器人' }
  const token = overrides.token || 'fake-token'
  const latencyMs = overrides.latencyMs || 0

  // 默认能力表：全都要真话；overrides.caps 只能叠在这上面
  const caps = {
    image: true, sticker: true, voice: 'native', video: true, file: true, maxFileBytes: 8 * 1024 * 1024,
    quoteReply: true, mention: true, mentionAll: true, poke: true, typing: false, recall: true, card: true,
    listenAllInGroup: true, proactive: 'free', replyWindowMs: 0, repliesPerMessage: 0,
    history: false, memberList: false, forwardExpand: false,
    ...(overrides.caps || {}),
  }
  // config 里的 proactive（网关把实例 config 给 ctx.config()，模板端读它的做法一致）
  if (overrides.config?.proactive) caps.proactive = overrides.config.proactive

  let ctx = null
  let running = false
  let connected = false
  let hangNext = false
  const failQueue = [] // { certainty, code } 队列：failNext 逐条消费
  const out = []       // 出站记录：{ message, payload, at }

  const adapter = {
    id,
    name: overrides.name || '假平台',
    contract: 1,

    caps() { return { ...caps } },

    settings: [
      { key: 'proactive', label: '主动消息', type: 'select', options: ['free', 'limited', 'none'], default: 'free' },
    ],

    async start(context) {
      if (running) return
      ctx = context
      running = true
      ctx.state('connecting')
      connected = true
      // 靠回调收事件的平台挂路由（假平台模拟一个 HTTP 回调入口，验签规则同真实平台端）
      if (typeof ctx.route === 'function') {
        ctx.route('/callback', (req, res) => {
          if (req?.headers?.['x-fake-signature'] !== token) {
            res.statusCode = 401 // 验签不过：拒绝且不 emit（CONTRACTS 第八节 5）
            res.end()
            return
          }
          // 回调体可能只带正文等零散字段：统一走 pushInbound 的补齐逻辑（它内部有连接守卫）
          adapter.pushInbound(req.body)
          res.statusCode = 200
          res.end()
        })
      }
      ctx.state('connected')
    },

    async stop() {
      if (!running) return
      running = false
      connected = false
      ctx?.state('stopped')
    },

    async whoami() { return { account: self.account, name: self.name } },

    /** 出站记录（只读）：每次成功 send 都追加 { message, payload, at }。 */
    get sent() { return out },

    async send(message) {
      const parts = message?.parts || []
      // 没连上：确定没发出去 → not-sent
      if (!running || !connected) throw sendError('not-sent', 'offline', instance, '假平台未连接')
      // 被动回复平台：主动消息拒绝（网关会先拦，这里是平台端自己的保险）
      if (caps.proactive === 'none' && !message.inResponseTo) {
        throw sendError('not-sent', 'proactive-not-allowed', instance, '该平台只能被动回复')
      }
      if (!parts.length) throw sendError('not-sent', 'nothing-to-send', instance, '没有可发送的内容')
      // 挂起：平台不响应，由平台端按 timeoutMs 自己超时 → unknown
      const timeoutMs = Math.max(1, Number(message.timeoutMs) || 8000)
      if (hangNext) {
        await delay(timeoutMs)
        throw sendError('unknown', 'timeout', instance, `假平台 ${timeoutMs}ms 内没有响应`)
      }
      // 注入的失败队列：'not-sent' 确定没发出去；'unknown' 拿不准
      const planned = failQueue.shift()
      if (planned) {
        if (planned.certainty === 'unknown') await delay(timeoutMs) // unknown 模拟超时链路
        throw sendError(planned.certainty, planned.code || 'injected', instance, `假平台按指令失败（${planned.certainty}）`)
      }
      if (latencyMs) await delay(latencyMs)
      // 平台侧「真实发送」：记下来并回 messageId
      const payload = { chat: message.chat, parts, replyTo: message.replyTo, inResponseTo: message.inResponseTo }
      out.push({ message, payload, at: Date.now() })
      return { messageId: 'fake-' + out.length }
    },

    // ───────────── 测试控制面（真实平台端没有这一段）─────────────

    /** 注入一条入站。native 只需要 AdapterInbound 的一部分，缺的补默认值。重复推同一条是允许的（网关负责去重）。 */
    pushInbound(native = {}) {
      return adapter.__deliver({
        chat: native.chat || { kind: 'private', id: '10001' },
        sender: native.sender || { account: '10001', name: '张三', role: '' },
        messageId: native.messageId ?? 'in-' + (++seq),
        at: native.at ?? Date.now(),
        mentionedMe: native.mentionedMe ?? false,
        parts: native.parts || [{ type: 'text', text: String(native.text ?? '假消息') }],
        replyTo: native.replyTo,
        raw: native.raw ?? native,
      })
    },

    /** 断线：状态 disconnected，此后推送失效、send 抛 not-sent。 */
    disconnect() {
      connected = false
      ctx?.state('disconnected', '假平台断线')
    },
    /** 重连：状态 connected，推送与发送恢复。 */
    reconnect() {
      connected = true
      ctx?.state('connected')
    },
    /** 下一次（或几次）send 按指令失败。kind: 'not-sent' | 'unknown'，code 可选。 */
    failNext(kind, code) {
      failQueue.push({ certainty: kind === 'unknown' ? 'unknown' : 'not-sent', code })
    },
    /** 下一次 send 挂起不返回（触发平台端按 timeoutMs 超时 → unknown）。 */
    hangNextSend() { hangNext = true },
    /** 运行中改能力表并通知网关（模拟探测后能力变了）。 */
    setCaps(partial) {
      Object.assign(caps, partial)
      ctx?.capsChanged()
    },

    /** 内部：把一条「平台事件」翻译成 AdapterInbound 并 emit。只有连接且运行中才会发生。 */
    __deliver(native) {
      if (!running || !connected || !ctx) return false // 停了 / 断线了绝不 emit
      ctx.emit({
        chat: { kind: native.chat.kind, id: String(native.chat.id), title: native.chat.title },
        sender: { account: String(native.sender.account), name: String(native.sender.name ?? ''), role: native.sender.role || '', alt: native.sender.alt },
        messageId: String(native.messageId),
        at: Number(native.at) || Date.now(),
        replyTo: native.replyTo,
        mentionedMe: Boolean(native.mentionedMe),
        parts: native.parts,
        raw: native.raw ?? native,
      })
      return true
    },
  }

  return adapter
}

/**
 * 给 runAdapterContract 用的预配置 harness：把「平台侧注入」映射到假平台端的控制面。
 * 形状说明见 test/contract/adapter-kit.js 文件头。
 */
export const fakeHarness = {
  /** 正常通道推一条合法入站（模拟 WS / 已验签推送）。 */
  async injectInbound(adapter) { adapter.pushInbound() },
  /** 验签不过的回调：调 ctx.route 挂的 handler，签名故意错。 */
  async injectUnverified(adapter, ctx) {
    const handler = ctx.__routes?.get('/callback')
    if (!handler) throw new Error('假平台端没有挂 /callback 路由')
    handler({ headers: { 'x-fake-signature': 'wrong' }, body: { text: '不该进来的' } }, fakeRes())
  },
  /** 验签通过的回调：签名正确，应 emit 一条。 */
  async injectSigned(adapter, ctx) {
    const handler = ctx.__routes?.get('/callback')
    if (!handler) throw new Error('假平台端没有挂 /callback 路由')
    handler({ headers: { 'x-fake-signature': 'fake-token' }, body: { text: '签名正确的回调' } }, fakeRes())
  },
  /** 切 proactive 并让网关知道（ctx.capsChanged）。 */
  setProactive(adapter, value, ctx) {
    adapter.setCaps({ proactive: value })
    // setCaps 只在平台端有 ctx 时才会通知；kit 的 ctx 是另一份，这里补一刀保证 capsChanged 被记录
    ctx?.capsChanged?.()
  },
  /** 注入发送故障。 */
  failSend(adapter, why) {
    if (why === 'timeout') adapter.hangNextSend()
    else adapter.failNext('not-sent', 'injected-refused')
  },
  /** 断线重连。 */
  async reconnect(adapter) {
    adapter.disconnect()
    adapter.reconnect()
  },
}

/** 最小的 res 桩：平台端只会写 statusCode / end。 */
function fakeRes() {
  return { statusCode: 0, end() {}, setHeader() {} }
}

/** kit 需要的记录型 ctx 就用 kit 自己的 makeCtx；这里转发一份省得 import 两个文件。 */
export { makeCtx } from '../contract/adapter-kit.js'
