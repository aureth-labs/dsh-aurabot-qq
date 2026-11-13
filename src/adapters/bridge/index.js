// Aurabot 多平台 · 通用接入端（bridge 平台端，F4 产出）
// 来源：Aurabot 多平台化 F4 工作包。许可：MIT（随本仓库）。
// 作用：让**外部程序**按一份简单 JSON 协议接入，不写插件代码就能接自建平台 / 脚本 / 临时通道。
//       契约依据：src/gateway/contracts.d.ts（PlatformAdapter / AdapterContext / Part / Caps / SendError）
//       ＋ docs/CONTRACTS.md 第六～八节；协议说明见 docs/BRIDGE-PROTOCOL.md。
//
// ── 与别的平台端最不一样的地方：出站是「外部程序来取」 ──
// 飞书/QQ 是插件主动调它们的 API，成败立刻知道。这里是反过来：插件把消息放进本地队列，
// 外部程序长轮询取走，再用回执确认。这让 SendError.certainty 的判断变得关键：
//   · 消息还在队列里、没被取走      → 'not-sent'（确定没到，可入队重试）
//   · 已被取走但没等到回执（超时）  → 'unknown'（可能已经发出去了，绝不能重发）
// 搞反了就会重复发消息，所以下面 pump() 里这条边界写得非常小心。
//
// ── 鉴权 ──
// 所有请求必须带 x-bridge-token，等于 settings 里的 token。不对一律 401，且绝不 emit
// （emit 是特权口：能伪造「某人说了某话」，见 CONTRACTS §六.6）。

// ───────────────────────── 错误分类 ─────────────────────────

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ensureDir } from '../../core/store.js'

function sendError(certainty, code, instance, message) {
  const error = new Error(message || `bridge 发送失败（${certainty}${code ? ' / ' + code : ''}）`)
  error.certainty = certainty
  if (code) error.code = code
  error.instance = instance
  return error
}

/** 最保守的能力表：外部程序还没声明 caps 之前就报这个（CONTRACTS §八.1「探测前按最保守报」） */
const CONSERVATIVE_CAPS = {
  image: false,
  sticker: false,
  voice: false,
  video: false,
  file: false,
  maxFileBytes: 0,
  quoteReply: false,
  mention: false,
  mentionAll: false,
  poke: false,
  typing: false,
  recall: false,
  card: false,
  listenAllInGroup: false,
  proactive: 'none',
  replyWindowMs: 0,
  repliesPerMessage: 0,
  history: false,
  memberList: false,
  forwardExpand: false,
}

/** 外部程序声明的 caps 只认已知键，且逐项校验类型；不认识的键忽略（不让外部程序塞垃圾） */
function sanitizeCaps(input) {
  const caps = { ...CONSERVATIVE_CAPS }
  if (!input || typeof input !== 'object') return caps
  for (const key of Object.keys(CONSERVATIVE_CAPS)) {
    if (!(key in input)) continue
    const value = input[key]
    if (key === 'voice') {
      if (value === 'native' || value === 'file' || value === false) caps.voice = value
    } else if (key === 'proactive') {
      if (value === 'free' || value === 'limited' || value === 'none') caps.proactive = value
    } else if (key === 'maxFileBytes' || key === 'replyWindowMs' || key === 'repliesPerMessage') {
      const n = Number(value)
      if (Number.isFinite(n) && n >= 0) caps[key] = n
    } else if (typeof CONSERVATIVE_CAPS[key] === 'boolean') {
      caps[key] = Boolean(value)
    }
  }
  return caps
}

/** 校验一条外部程序推来的入站消息；不合格返回 { error }，合格返回 { message } */
function sanitizeInbound(body) {
  if (!body || typeof body !== 'object') return { error: '消息必须是 JSON 对象' }
  const chat = body.chat
  if (!chat || typeof chat !== 'object') return { error: '缺 chat' }
  if (chat.kind !== 'private' && chat.kind !== 'group') return { error: 'chat.kind 只能是 private 或 group' }
  if (typeof chat.id !== 'string' || !chat.id) return { error: 'chat.id 必须是非空字符串' }
  const sender = body.sender
  if (!sender || typeof sender !== 'object') return { error: '缺 sender' }
  if (typeof sender.account !== 'string' || !sender.account) return { error: 'sender.account 必须是非空字符串' }
  if (typeof body.messageId !== 'string' || !body.messageId) return { error: 'messageId 必须是非空字符串' }
  const parts = Array.isArray(body.parts) ? body.parts : null
  if (!parts || parts.length === 0) return { error: 'parts 必须是非空数组' }
  for (const part of parts) {
    if (!part || typeof part !== 'object' || typeof part.type !== 'string') return { error: 'parts 里每一项都要有 type' }
  }
  return {
    message: {
      chat: { kind: chat.kind, id: chat.id, title: chat.title },
      sender: {
        account: sender.account,
        name: typeof sender.name === 'string' ? sender.name : '',
        role: ['owner', 'admin', 'member', ''].includes(sender.role) ? sender.role : '',
        alt: typeof sender.alt === 'string' ? sender.alt : undefined,
      },
      messageId: body.messageId,
      at: Number.isFinite(Number(body.at)) ? Number(body.at) : Date.now(),
      replyTo: typeof body.replyTo === 'string' ? body.replyTo : undefined,
      mentionedMe: Boolean(body.mentionedMe),
      parts,
      ext: body.ext && typeof body.ext === 'object' ? body.ext : undefined,
      raw: body.raw ?? body,
    },
  }
}

/**
 * 建一个 bridge 平台端。
 * options.token：必填，缺了 start 直接失败（不鉴权的入站口等于开放伪造）
 * options.id / options.name / options.timeoutMs / options.maxBytes / options.self
 * options.clock：测试注入
 */
export function createBridgeAdapter(options = {}) {
  const id = options.id || 'bridge'
  const name = options.name || '通用接入端'
  const instance = id
  const clock = options.clock || (() => Date.now())
  const defaultTimeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 15_000
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : 4 * 1024 * 1024
  const self = options.self || { account: options.token ? 'bridge-bot' : 'bridge-bot', name: '外部程序' }

  let ctx = null
  let running = false
  let connected = false
  let caps = { ...CONSERVATIVE_CAPS }
  let announced = false // 外部程序是否已经 /hello 声明过 caps
  const offs = []
  let seq = 0

  // 出站队列：外部程序还没来取的消息。
  // 每项：{ id, chat, parts, replyTo, inResponseTo, timeoutMs, enqueuedAt, takenAt?, resolve, reject, timer }
  const queue = []
  const inflight = new Map() // id → { resolve, reject, timer, takenAt }
  // 模拟故障（测试/运维用）：'refused' 下一次 send 直接 not-sent；'timeout' 下一次 send 挂起超时
  let failSend = null

  const tokenOf = () => String(options.token || '')
  const authorized = (req) => {
    const want = tokenOf()
    if (!want) return false // 没配 token 就一律拒绝（不是「全放行」，那样等于开放伪造入站）
    const got = req?.headers?.['x-bridge-token'] ?? req?.headers?.['X-Bridge-Token']
    return String(got || '') === want
  }

  /** 统一读 body：支持宿主已经解析好的对象（req.body），也支持原始字符串/流 */
  function readBody(req) {
    if (req && req.body !== undefined) {
      if (typeof req.body === 'string') {
        try { return JSON.parse(req.body) } catch { return null }
      }
      return req.body
    }
    return null
  }

  function json(res, status, payload) {
    if (!res) return
    res.statusCode = status
    if (typeof res.setHeader === 'function') res.setHeader('content-type', 'application/json; charset=utf-8')
    if (typeof res.end === 'function') res.end(JSON.stringify(payload))
  }

  /** 外部程序取走一条消息 → 计入 inflight，等回执。取走后再超时就是 'unknown'。 */
  function takeOne() {
    const item = queue.shift()
    if (!item) return null
    item.takenAt = clock()
    inflight.set(item.id, item)
    return item
  }

  // ───────────────────────── 路由 ─────────────────────────

  /** POST /inbound：外部程序推一条入站消息进来 */
  function handleInbound(req, res) {
    if (!authorized(req)) return json(res, 401, { ok: false, error: 'unauthorized' })
    const body = readBody(req)
    const checked = sanitizeInbound(body)
    if (checked.error) return json(res, 400, { ok: false, error: checked.error })
    if (!running || !connected) return json(res, 409, { ok: false, error: 'adapter not connected' })
    ctx.emit(checked.message)
    return json(res, 200, { ok: true, messageId: checked.message.messageId })
  }

  /** POST /hello：外部程序声明自己的能力表；之后网关按它降级 */
  function handleHello(req, res) {
    if (!authorized(req)) return json(res, 401, { ok: false, error: 'unauthorized' })
    const body = readBody(req) || {}
    if (body.protocol !== undefined && Number(body.protocol) !== 1) {
      return json(res, 400, { ok: false, error: '只支持 protocol:1' })
    }
    caps = sanitizeCaps(body.caps)
    announced = true
    if (body.self && typeof body.self.account === 'string' && body.self.account) {
      self.account = body.self.account
      self.name = typeof body.self.name === 'string' ? body.self.name : self.name
    }
    // 能力变了要让网关重新读（CONTRACTS §八.1）
    saveCaps()
    ctx.capsChanged()
    return json(res, 200, { ok: true, instance, caps })
  }

  /**
   * POST /outbound：长轮询取一条待发消息。
   * 请求体可带 wait:true + timeoutMs（长轮询）；不带就立刻返回（没有则 204）。
   */
  async function handleOutbound(req, res) {
    if (!authorized(req)) return json(res, 401, { ok: false, error: 'unauthorized' })
    if (!running || !connected) return json(res, 409, { ok: false, error: 'adapter not connected' })
    const body = readBody(req) || {}
    const wait = Boolean(body.wait)
    const waitMs = Math.min(Math.max(Number(body.timeoutMs) || 0, 0), 60_000)
    let item = takeOne()
    if (!item && wait && waitMs > 0) {
      // 长轮询：等到有消息或到点
      item = await new Promise((resolve) => {
        const started = clock()
        const tick = setInterval(() => {
          const got = takeOne()
          if (got) { clearInterval(tick); resolve(got) }
          else if (clock() - started >= waitMs) { clearInterval(tick); resolve(null) }
        }, 20)
        tick.unref?.()
      })
    }
    if (!item) return json(res, 204, { ok: true, message: null })
    return json(res, 200, {
      ok: true,
      protocol: 1,
      message: {
        id: item.id,
        chat: item.chat,
        parts: item.parts,
        replyTo: item.replyTo,
        inResponseTo: item.inResponseTo,
      },
    })
  }

  /** POST /ack：外部程序回执（取走的那条到底发出去没有） */
  function handleAck(req, res) {
    if (!authorized(req)) return json(res, 401, { ok: false, error: 'unauthorized' })
    const body = readBody(req) || {}
    const id = String(body.id || '')
    const item = inflight.get(id)
    if (!item) return json(res, 404, { ok: false, error: 'unknown message id（可能已超时结算为 unknown）' })
    inflight.delete(id)
    clearTimeout(item.timer)
    if (body.ok === false) {
      // 外部程序明确说「没发出去」→ not-sent（可重试）
      item.reject(sendError('not-sent', String(body.error || 'peer-refused'), instance, `外部程序回执失败：${body.error || ''}`))
    } else {
      item.resolve({ messageId: String(body.messageId || id) })
    }
    return json(res, 200, { ok: true })
  }

  // ───────────────────────── 平台端契约 ─────────────────────────

  /**
   * 持久化上次声明的能力：外部程序可能比插件晚起来（重启顺序不定），
   * 重启后先沿用上次声明的 caps，等它重新 /hello 再覆盖。
   * 契约上这是允许的：§八.1 要求「探测前按最保守报」——已经探测过就沿用上次的结果。
   */
  function loadCaps() {
    const file = options.capsFile
    if (!file) return null
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      return sanitizeCaps(raw?.caps)
    } catch { return null }
  }

  function saveCaps() {
    const file = options.capsFile
    if (!file) return
    try {
      ensureDir(dirname(file))
      writeFileSync(file, JSON.stringify({ caps, self, at: clock() }), { encoding: 'utf8', mode: 0o600 })
    } catch { /* 存不下不影响本次运行 */ }
  }

  const adapter = {
    id,
    name,
    contract: 1,

    caps: () => ({ ...caps }),

    settings: [
      { key: 'token', label: '接入令牌', type: 'password', hint: '外部程序每个请求都要带 x-bridge-token 等于它；不填则拒绝所有请求（不给空口令开绿灯）' },
      { key: 'timeoutMs', label: '发送超时（毫秒）', type: 'number', default: 15000, hint: '消息被外部程序取走后等回执的时限；超时按 unknown 处理，绝不重发' },
      { key: 'maxBytes', label: '单条消息上限（字节）', type: 'number', default: 4194304 },
    ],

    async start(gatewayCtx) {
      ctx = gatewayCtx
      running = true
      connected = true
      // 优先沿用上次声明的能力：进程内重启（同一实例再 start）直接用内存里的；
      // 进程重启则用 capsFile 落盘的那份。外部程序可能比插件晚起来，不能一上来就退回最保守。
      const restored = announced ? caps : loadCaps()
      caps = restored || { ...CONSERVATIVE_CAPS }
      announced = Boolean(restored)
      offs.push(gatewayCtx.route('/inbound', handleInbound))
      offs.push(gatewayCtx.route('/hello', handleHello))
      offs.push(gatewayCtx.route('/outbound', handleOutbound))
      offs.push(gatewayCtx.route('/ack', handleAck))
      // 没有 token 就明确报未配置——不能假装连上了，否则入站口等于敞着
      if (!tokenOf()) {
        connected = false
        gatewayCtx.state('unconfigured', '还没填接入令牌（token），外部程序连不上')
        return
      }
      gatewayCtx.state('connected', restored ? '沿用上次声明的能力，等外部程序重新 /hello' : '等待外部程序 /hello 声明能力')
    },

    async stop() {
      running = false
      connected = false
      for (const off of offs.splice(0)) {
        try { off() } catch {}
      }
      // 结算所有在途：还没回执的一律 unknown（可能已经发出去了，不能再重试）
      for (const [id2, item] of inflight) {
        clearTimeout(item.timer)
        item.reject(sendError('unknown', 'stopped', instance, '平台端停止，回执未到，按 unknown 处理避免重复'))
        inflight.delete(id2)
      }
      // 队列里没被取走的：not-sent，交回网关决定补发（这里只清空自己的队列；
      // 网关的补发队列是另一层，见 CONTRACTS §七.4）
      queue.length = 0
      ctx?.state('stopped')
    },

    async whoami() {
      return { account: self.account, name: self.name }
    },

    /**
     * 出站。三种结局：
     *  1) 主动消息但 caps.proactive='none' → not-sent proactive-not-allowed（网关本来会先拦，这里也守一道）
     *  2) 外部程序没来取 → 等 timeoutMs 仍没取走 → not-sent（确定没到）
     *  3) 被取走但没回执 → 超时 → unknown（可能已发，绝不重发）
     */
    async send(message = {}) {
      if (!running || !connected) throw sendError('not-sent', 'offline', instance, 'bridge 平台端未连接')
      if (!message.inResponseTo && caps.proactive === 'none') {
        throw sendError('not-sent', 'proactive-not-allowed', instance, '这个接入端只允许被动回复（proactive=none）')
      }
      // 测试/运维注入的故障
      if (failSend === 'refused') {
        failSend = null
        throw sendError('not-sent', 'refused', instance, '注入的「确定没发出去」故障')
      }
      const timeoutMs = Number(message.timeoutMs) > 0 ? Number(message.timeoutMs) : defaultTimeoutMs
      const payload = JSON.stringify(message.parts || [])
      if (Buffer.byteLength(payload, 'utf8') > maxBytes) {
        throw sendError('not-sent', 'too-large', instance, `消息超过 bridge 上限 ${maxBytes} 字节`)
      }

      const item = {
        id: `b-${++seq}-${clock()}`,
        chat: message.chat,
        parts: message.parts || [],
        replyTo: message.replyTo,
        inResponseTo: message.inResponseTo,
        enqueuedAt: clock(),
        takenAt: null,
        timer: null,
        resolve: null,
        reject: null,
      }

      const timeoutKind = failSend === 'timeout' ? 'unknown-forced' : null
      if (failSend === 'timeout') failSend = null

      // 注入超时：模拟「已经交出去了但永远等不到回执」——直接进 inflight，不放队列，
      // 这样外部程序的取件泵拿不到它，到点必然按 unknown 结算（这正是最危险的那一类失败）。
      if (timeoutKind) {
        return await new Promise((resolve, reject) => {
          item.takenAt = clock()
          inflight.set(item.id, item)
          item.timer = setTimeout(() => {
            inflight.delete(item.id)
            reject(sendError('unknown', 'timeout-forced', instance, '注入的超时故障：已交出、无回执（按 unknown 不重发）'))
          }, Math.max(1, timeoutMs))
          item.timer.unref?.()
        })
      }

      return await new Promise((resolve, reject) => {
        item.resolve = resolve
        item.reject = reject
        item.timer = setTimeout(() => {
          if (inflight.has(item.id)) {
            // 已被取走没回执 → unknown（最危险的情况，绝不能重发）
            inflight.delete(item.id)
            reject(sendError('unknown', 'no-ack', instance, '外部程序取走后没回执（可能已发出，按 unknown 不重发）'))
            return
          }
          const at = queue.indexOf(item)
          if (at >= 0) queue.splice(at, 1)
          // 外部程序压根没来取 → 确定没发出去 → not-sent（可入队重试）
          reject(sendError('not-sent', 'not-taken', instance, '外部程序没有来取这条消息（确定没发出去）'))
        }, Math.max(1, timeoutMs))
        item.timer.unref?.()
        if (options.autoAck) {
          // 契约测试用：模拟一个「立刻取走并立刻回执」的配合型外部程序。
          // 注意这里同步 resolve，且不登记 inflight——否则 stop() 结算 inflight 时
          // 会和这个已完成的 promise 抢，导致它永远 settle 不了（历史上踩过这个挂死）。
          clearTimeout(item.timer)
          item.takenAt = clock()
          resolve({ messageId: item.id })
          return
        }
        queue.push(item)
      })
    },

    /** 兼容旧接口：把 OneBot 风格的原生消息段转 parts（网关 toParts 会调它） */
    toParts(nativeMessage) {
      const segments = Array.isArray(nativeMessage) ? nativeMessage : []
      const parts = []
      for (const seg of segments) {
        switch (seg?.type) {
          case 'text': parts.push({ type: 'text', text: String(seg.data?.text ?? seg.text ?? '') }); break
          case 'image': parts.push({ type: 'image', media: { url: seg.data?.url || seg.url, mime: seg.data?.mime } }); break
          case 'at': parts.push({ type: 'mention', account: String(seg.data?.qq ?? seg.account ?? ''), name: seg.data?.name }); break
          case 'face': parts.push({ type: 'face', name: String(seg.data?.name ?? seg.name ?? '表情') }); break
          default: parts.push({ type: 'other', text: `[${seg?.type || '未知'}]`, native: seg })
        }
      }
      return parts
    },
  }

  // 测试/运维控制面：注入故障、改能力、直接窥探队列（真实使用不暴露给外部程序）
  adapter.__bridge = {
    injectFail(why) { failSend = why },
    /** 等价于外部程序重新 /hello 只改 caps（测试用，不需要造 HTTP 请求） */
    injectCaps(partial) {
      caps = sanitizeCaps({ ...caps, ...(partial || {}) })
      announced = true
      ctx?.capsChanged?.()
      return { ...caps }
    },
    queueLength: () => queue.length,
    inflightCount: () => inflight.size,
    announced: () => announced,
    takenCount: () => seq,
    /**
     * 测试用：模拟「平台端已经停了、外部程序还在推入站」。
     * 真实路径是 /inbound 请求——但 stop 时路由已经撤销（契约要求），所以这里直接走
     * 增加一条消息的同一段守卫逻辑，用来证明「停了就不再 emit」。
     */
    pushAfterStop(message) {
      if (!running || !connected || !ctx) return { ok: false, error: 'adapter not connected' }
      const checked = sanitizeInbound(message)
      if (checked.error) return { ok: false, error: checked.error }
      ctx.emit(checked.message)
      return { ok: true }
    },
  }

  return adapter
}

export default createBridgeAdapter()
