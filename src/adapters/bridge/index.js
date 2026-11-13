// Aurabot 多平台 · 通用接入端（bridge 平台端，F4 产出）
// 来源：Aurabot 多平台化 F4 工作包（Aurabot多平台实施拆分/包-F4-通用接入端.md）。许可：MIT（随本仓库）。
// 作用：让**外部程序**按一份简单 JSON 协议接入，不写插件代码就能接自建平台 / 脚本 / 临时通道。
// 契约依据：src/gateway/contracts.d.ts（PlatformAdapter / AdapterContext / Part / Caps / SendError）
//           ＋ docs/CONTRACTS.md 第六～八节（§六入站只翻译、§七出站失败分类、§八能力表）
//           ＋ §八之二.7.3「不写代码：让外部程序连通用接入端」。
// 协议说明（给不写插件的人看的那份）：docs/BRIDGE-PROTOCOL.md。
//
// ── 为什么这个平台端的 send 与别家完全不同 ──
// 飞书 / QQ 是插件主动调对方的 API，成没成对方立刻告诉你。这里是反过来的**异步长轮询**：
//   插件把要发的消息放进本实例的队列 → 外部程序 GET/POST /outbound 取走 → 再 POST /ack 回执。
// 于是「到底发出去没有」被拆成三种状态，SendError.certainty 必须按状态判断：
//
//   ① 消息还在本地队列里、没被任何一次 /outbound 取走
//        → 外部程序根本没碰上这条消息 → 确定没发出去 → certainty='not-sent'（可入队、可重试）
//   ② 已被 /outbound 取走（记进 inflight）但等到超时都没等到 /ack
//        → 消息已在外部程序手里，它可能已经发出去了、也可能进程死在半路 → 拿不准 → certainty='unknown'
//        → **绝不重发**（网关唯一允许重试的是 not-sent；重发就是两条）
//   ③ 外部程序回了 /ack 且 ok:false
//        → 对方明确说没发出去 → certainty='not-sent'，code 用它报的
//
// ① 与 ② 的分界线就是 takeOne()：从 queue 移到 inflight 的那一下。这个边界必须由**队列状态**
// 决定，不能由「超时了多久」「连接还在不在」推断——所以超时回调先查 inflight：在里面 → unknown；
// 还在 queue 里 → not-sent，并且要从队列与落盘里摘掉（否则重试时会重复交付）。
//
// ── 鉴权（emit 是特权口）──
// 所有请求必须带 x-bridge-token，等于 settings 里声明的 token。不对一律 401，且**绝不 emit**：
// 能往这个口子塞入站消息，就等于能伪造「某人说了某话」并写进记忆（CONTRACTS §六.6）。
// 没配 token 的实例永远 401（不给「空口令全放行」开绿灯），状态报 unconfigured。
//
// ── 队列跨重启 ──
// 进程重启（面板重载、宿主重启）会丢掉队列，而那时调用 send 的网关侧 promise 也一起没了
// ——没有任何一层记得这条消息，等于静默丢消息。所以**未取走**的队列项落盘（pending.json），
// 重启后原样装回，外部程序连上即可继续取。
// 只落盘「还没被取走」的：已被取走的已经是 unknown（可能已发出），落盘会让重启后重发一遍。
// 优雅 stop() 时队列项以 not-sent 还给网关（网关补发队列接手）并清空落盘，
// 避免「网关补发一次 + 重启后队列再交一次」变成两条。

import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { ensureDir } from '../../core/store.js'

/** 协议版本。不一致一律拒绝（宁可连不上，也不猜字段含义）。 */
const PROTOCOL = 1

/** 长轮询单次最长挂起时间：防止外部程序写出「永不返回」的请求把连接占死。 */
const MAX_WAIT_MS = 60_000

function sendError(certainty, code, instance, message) {
  const error = new Error(message || `bridge 发送失败（${certainty}${code ? ' / ' + code : ''}）`)
  error.certainty = certainty
  if (code) error.code = code
  error.instance = instance
  error.name = 'SendError'
  return error
}

/**
 * 最保守的能力表：外部程序还没 /hello 声明 caps 之前就报这个（CONTRACTS §八.1「探测前按最保守报」）。
 * 全 false + proactive='none'：网关会因此不往这里发语音/图片，也不主动找人，直到声明到达。
 */
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

/**
 * 外部程序声明的 caps：只认契约里有的键、逐项校验类型；不认识的键忽略。
 * 为什么要白名单：caps 决定网关怎么降级，外部程序乱塞键或塞错类型会让降级表算错。
 */
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

/**
 * 校验一条外部程序推来的入站消息（AdapterInbound 的 JSON 形态）。
 * 不合格 → { error }（调用方回 4xx，且**不 emit**）；合格 → { message }（补齐可选字段）。
 * 只做形状校验，不替外部程序编内容（没有的字段就用契约允许的默认/空值）。
 */
function sanitizeInbound(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: '消息必须是 JSON 对象' }
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
      chat: { kind: chat.kind, id: chat.id, title: typeof chat.title === 'string' ? chat.title : undefined },
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
 * options：
 *   token       接入令牌（也可由面板配置走 ctx.config().token 给；两边都没有 → unconfigured）
 *   timeoutMs   消息被取走后等回执的时限（默认 15000）
 *   maxBytes    单条消息上限（默认 4MB），入站请求体与出站 parts 都按它卡
 *   self        { account, name } 默认的机器人身份（/hello 里的 self 会覆盖它）
 *   dataDir     () => 绝对目录；不给就用 ctx.dataDir()（网关会指到实例数据目录）
 *   clock       时钟（测试注入）
 *   autoAck     契约测试用：模拟「立刻取走并立刻回执」的外部程序，不经过 HTTP
 */
export function createBridgeAdapter(options = {}) {
  const id = options.id || 'bridge'
  const name = options.name || '通用接入端'
  // 报错里的 instance 要写真实实例名（配置里可能叫 mychat，由 bridge 来跑）；
  // start() 时从 ctx.instance 取。拿不到就退回 id（契约测试里两者相同）。
  let instance = id
  const clock = options.clock || (() => Date.now())

  // 运行期配置：start() 里会被 ctx.config()（面板里填的那一段）覆盖；options 只是默认值。
  let token = String(options.token || '')
  let defaultTimeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 15_000
  let maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : 4 * 1024 * 1024
  const self = { account: options.self?.account || 'bridge-bot', name: options.self?.name || '外部程序' }

  let ctx = null
  let running = false
  let connected = false
  let caps = { ...CONSERVATIVE_CAPS }
  let announced = false // 外部程序是否已经 /hello 声明过 caps
  const offs = []
  let seq = 0

  // 出站队列：外部程序还没来取的消息。每项：
  // { id, chat, parts, replyTo, inResponseTo, enqueuedAt, takenAt, timer, resolve, reject, recovered }
  const queue = []
  const inflight = new Map() // id → item（已被取走、等回执）
  const waiters = new Set() // 挂起中的长轮询请求的唤醒函数
  // 模拟故障（测试/运维用）：'refused' 下一次 send 直接 not-sent；'timeout' 下一次 send 挂起超时
  let failSend = null

  const authorized = (req) => {
    if (!token) return false // 没配 token 就一律拒绝（不是「全放行」）
    const got = req?.headers?.['x-bridge-token'] ?? req?.headers?.['X-Bridge-Token'] ?? req?.headers?.['X-BRIDGE-TOKEN']
    return String(got || '') === token
  }

  /** 统一读 body：支持宿主已经解析好的对象（req.body），也支持原始字符串 */
  function readBody(req) {
    if (req && req.body !== undefined) {
      if (typeof req.body === 'string') {
        try { return JSON.parse(req.body) } catch { return null }
      }
      return req.body
    }
    return null
  }

  /** 读 query（GET /outbound?wait=true&timeoutMs=30000 用） */
  function queryOf(req) {
    try { return Object.fromEntries(new URL(String(req?.url || ''), 'http://x').searchParams) } catch { return {} }
  }

  /** GET 还是 POST：宿主没给 method 时按 POST 处理（测试与最小宿主都这么调） */
  const methodOf = (req) => String(req?.method || 'POST').toUpperCase()

  function json(res, status, payload) {
    if (!res) return
    res.statusCode = status
    if (typeof res.setHeader === 'function') res.setHeader('content-type', 'application/json; charset=utf-8')
    if (typeof res.end === 'function') res.end(JSON.stringify({ protocol: PROTOCOL, ...payload }))
  }

  /** 协议版本校验：带了 protocol 就必须是 1；没带按 1 处理（兼容只在 /hello 里报版本的老客户端） */
  function protocolProblem(body) {
    if (!body || typeof body !== 'object') return null
    if (body.protocol === undefined || body.protocol === null) return null
    if (Number(body.protocol) !== PROTOCOL) return `只支持 protocol:${PROTOCOL}（收到 ${JSON.stringify(body.protocol)}）`
    return null
  }

  // ───────────────────────── 队列 / 落盘 ─────────────────────────

  /**
   * 数据目录：优先 options.dataDir，其次 ctx.dataDir()。只认绝对路径——
   * 相对路径/拼出来的伪路径（契约测试的 ctx.dataDir 就是拼字符串）落盘会污染工作目录。
   */
  function dataDirPath() {
    let dir = null
    try {
      if (typeof options.dataDir === 'function') dir = options.dataDir()
      else if (typeof ctx?.dataDir === 'function') dir = ctx.dataDir()
    } catch { dir = null }
    if (typeof dir !== 'string' || !dir || !isAbsolute(dir)) return null
    return dir
  }

  function pendingFile() {
    const dir = dataDirPath()
    return dir ? join(dir, 'pending.json') : null
  }

  const serialize = (item) => ({
    id: item.id,
    chat: item.chat,
    parts: item.parts,
    replyTo: item.replyTo,
    inResponseTo: item.inResponseTo,
    enqueuedAt: item.enqueuedAt,
  })

  /** 把「还没被取走」的队列落盘。已被取走的不写：那已经是 unknown，重发就是两条。 */
  function savePending() {
    const file = pendingFile()
    if (!file) return
    try {
      ensureDir(dirname(file))
      const tmp = `${file}.tmp-${process.pid}`
      writeFileSync(tmp, JSON.stringify({ protocol: PROTOCOL, items: queue.map(serialize) }, null, 2), { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, file)
    } catch (error) {
      ctx?.log?.warn?.('bridge 待发队列落盘失败（不影响本次运行）：', error?.message || error)
    }
  }

  /** 重启后把上次没取走的队列装回来：外部程序连上就能继续取，不会静默丢消息。 */
  function loadPending() {
    const file = pendingFile()
    if (!file) return 0
    let raw
    try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch { return 0 }
    const items = Array.isArray(raw?.items) ? raw.items : []
    let restored = 0
    for (const it of items) {
      if (!it || typeof it.id !== 'string' || !it.id) continue
      if (!it.chat || (it.chat.kind !== 'private' && it.chat.kind !== 'group') || typeof it.chat.id !== 'string') continue
      if (!Array.isArray(it.parts) || it.parts.length === 0) continue
      if (queue.some((q) => q.id === it.id)) continue
      queue.push({
        id: it.id,
        chat: { kind: it.chat.kind, id: it.chat.id, title: it.chat.title },
        parts: it.parts,
        replyTo: typeof it.replyTo === 'string' ? it.replyTo : undefined,
        inResponseTo: typeof it.inResponseTo === 'string' ? it.inResponseTo : undefined,
        enqueuedAt: Number(it.enqueuedAt) || clock(),
        takenAt: null,
        timer: null,
        resolve: null, // 重启前的 promise 已随进程消失，这里只负责把内容交出去
        reject: null,
        recovered: true,
      })
      restored++
    }
    if (restored) ctx?.log?.info?.(`bridge 从落盘队列恢复了 ${restored} 条上次没被取走的消息`)
    return restored
  }

  /** 外部程序取走一条 → 移进 inflight 等回执；这一步之后超时就是 unknown。 */
  function takeOne() {
    const item = queue.shift()
    if (!item) return null
    item.takenAt = clock()
    inflight.set(item.id, item)
    savePending() // 已取走的不再落盘：它已进入 unknown 的可能范围
    return item
  }

  /** 有新消息进队列：唤醒挂起中的长轮询（唤醒后它们自己去取） */
  function notifyWaiters() {
    for (const wake of Array.from(waiters)) {
      try { wake() } catch {}
    }
  }

  /** stop 时唤醒挂起中的长轮询：队列已清空，直接让请求返回，别让 HTTP 干等满 60 秒 */
  function abortWaiters() {
    for (const wake of Array.from(waiters)) {
      try { wake(true) } catch {}
    }
    waiters.clear()
  }

  /** 长轮询等待：等到有消息、到点、或 stop 被唤醒（返回 null） */
  function waitForItem(ms) {
    return new Promise((resolve) => {
      let settled = false
      const done = (item) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        waiters.delete(wake)
        resolve(item || null)
      }
      // 被唤醒时必须**再取一次队列**：唤醒只说「有变化」，不代表这条请求拿得到
      //（另一个挂起的请求可能已经把消息取走了）。
      // force=true 是 stop 发出来的：队列已清空，直接回 null，让 HTTP 请求立刻结束。
      const wake = (force) => {
        if (force) return done(null)
        const item = takeOne()
        if (item) done(item)
      }
      const timer = setTimeout(() => done(null), Math.max(1, ms))
      timer.unref?.()
      waiters.add(wake)
      // 注册时队列里可能已经有消息（上一次检查到注册之间没有 await，理论上不会，但保险）
      const item = takeOne()
      if (item) done(item)
    })
  }

  // ───────────────────────── 路由 ─────────────────────────

  /** POST /inbound：外部程序推一条入站消息进来（转 AdapterInbound 后 ctx.emit） */
  function handleInbound(req, res) {
    if (!authorized(req)) return json(res, 401, { ok: false, error: 'unauthorized' })
    const body = readBody(req)
    const badProto = protocolProblem(body)
    if (badProto) return json(res, 400, { ok: false, error: 'protocol-unsupported', message: badProto })
    // 入站也受 settings 里的 maxBytes 限制：超了不 emit，回 413
    try {
      if (body != null && Buffer.byteLength(JSON.stringify(body), 'utf8') > maxBytes) {
        return json(res, 413, { ok: false, error: 'too-large', message: `消息超过上限 ${maxBytes} 字节` })
      }
    } catch {}
    const checked = sanitizeInbound(body)
    if (checked.error) return json(res, 400, { ok: false, error: 'bad-inbound', message: checked.error })
    // 停了 / 没连上 → 收下但绝不 emit（emit 是特权口，宁可丢也不能进记忆）
    if (!running || !connected) return json(res, 409, { ok: false, error: 'not-connected' })
    ctx.emit(checked.message)
    return json(res, 200, { ok: true, instance, messageId: checked.message.messageId })
  }

  /** POST /hello：外部程序声明能力表（之后网关按它降级）与机器人身份（对应 whoami） */
  function handleHello(req, res) {
    if (!authorized(req)) return json(res, 401, { ok: false, error: 'unauthorized' })
    const body = readBody(req) || {}
    const badProto = protocolProblem(body)
    if (badProto) return json(res, 400, { ok: false, error: 'protocol-unsupported', message: badProto })
    caps = sanitizeCaps(body.caps)
    announced = true
    if (body.self && typeof body.self.account === 'string' && body.self.account) {
      self.account = body.self.account
      self.name = typeof body.self.name === 'string' ? body.self.name : self.name
    }
    // 能力变了要让网关重新读（CONTRACTS §八.1）
    ctx?.capsChanged?.()
    const declared = Object.entries(caps).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' ') || '（全不支持）'
    ctx?.log?.info?.(`bridge 收到能力声明：${declared}`)
    return json(res, 200, { ok: true, instance, caps })
  }

  /**
   * /outbound：长轮询取一条待发消息。
   * POST 带 JSON body，或 GET 带 query：?wait=true&timeoutMs=30000。
   * 没有消息且不等待 → 204（外部程序按自己的节奏再轮询）。
   */
  async function handleOutbound(req, res) {
    if (!authorized(req)) return json(res, 401, { ok: false, error: 'unauthorized' })
    if (!running || !connected) return json(res, 409, { ok: false, error: 'not-connected' })
    const isGet = methodOf(req) === 'GET'
    const source = isGet ? queryOf(req) : (readBody(req) || {})
    const badProto = protocolProblem(source)
    if (badProto) return json(res, 400, { ok: false, error: 'protocol-unsupported', message: badProto })
    const wait = source.wait === true || source.wait === 'true' || source.wait === '1'
    const waitMs = Math.min(Math.max(Number(source.timeoutMs) || 0, 0), MAX_WAIT_MS)
    let item = takeOne()
    if (!item && wait && waitMs > 0) item = await waitForItem(waitMs)
    if (!item) return json(res, 204, { ok: true, message: null })
    return json(res, 200, {
      ok: true,
      message: {
        id: item.id,
        chat: item.chat,
        parts: item.parts,
        replyTo: item.replyTo,
        inResponseTo: item.inResponseTo,
        recovered: Boolean(item.recovered) || undefined,
      },
    })
  }

  /** POST /ack：外部程序回执（取走的那条到底发出去没有） */
  function handleAck(req, res) {
    if (!authorized(req)) return json(res, 401, { ok: false, error: 'unauthorized' })
    const body = readBody(req) || {}
    const badProto = protocolProblem(body)
    if (badProto) return json(res, 400, { ok: false, error: 'protocol-unsupported', message: badProto })
    const ackId = String(body.id || '')
    if (!ackId) return json(res, 400, { ok: false, error: 'bad-ack', message: '缺 id' })
    const item = inflight.get(ackId)
    // 找不到：多半是已经超时结算成 unknown 了。回 404 让外部程序知道「这条已不算数」，
    // 但**不要**因此再发一次（是否重发由网关按 unknown 规则决定：不重发）。
    if (!item) return json(res, 404, { ok: false, error: 'unknown-id', message: '没有这条在途消息（可能已超时结算为 unknown）' })
    inflight.delete(ackId)
    clearTimeout(item.timer)
    if (body.ok === false) {
      // 外部程序明确说「没发出去」→ not-sent（可重试）
      item.reject?.(sendError('not-sent', String(body.error || 'peer-refused'), instance, `外部程序回执失败：${body.error || ''}`))
    } else {
      item.resolve?.({ messageId: String(body.messageId || ackId) })
    }
    return json(res, 200, { ok: true, id: ackId })
  }

  // ───────────────────────── 平台端契约 ─────────────────────────

  const adapter = {
    id,
    name,
    contract: 1,

    caps: () => ({ ...caps }),

    settings: [
      { key: 'token', label: '接入令牌', type: 'password', hint: '必填。外部程序每个请求都要带 x-bridge-token 等于它；不填则拒绝连接（不给空口令开绿灯）' },
      { key: 'timeoutMs', label: '发送超时（毫秒）', type: 'number', default: 15000, hint: '消息被外部程序取走后等回执的时限；超时按 unknown 处理，绝不重发' },
      { key: 'maxBytes', label: '单条消息上限（字节）', type: 'number', default: 4194304, hint: '入站请求体与出站内容都按它卡，超了拒绝' },
    ],

    async start(gatewayCtx) {
      ctx = gatewayCtx
      if (gatewayCtx && typeof gatewayCtx.instance === 'string' && gatewayCtx.instance) instance = gatewayCtx.instance
      running = true
      connected = true
      // 配置优先：面板填的 token/timeoutMs/maxBytes 经 ctx.config() 进来（settings 声明的就是这三项）
      const cfg = (typeof gatewayCtx.config === 'function' ? gatewayCtx.config() : null) || {}
      if (typeof cfg.token === 'string' && cfg.token) token = cfg.token
      if (Number(cfg.timeoutMs) > 0) defaultTimeoutMs = Number(cfg.timeoutMs)
      if (Number(cfg.maxBytes) > 0) maxBytes = Number(cfg.maxBytes)

      // 进程内重启（同一实例再 start）沿用内存里已声明的能力；跨进程重启一律退回最保守，
      // 等外部程序重新 /hello（CONTRACTS §八.1：探测前按最保守报）。
      caps = announced ? caps : { ...CONSERVATIVE_CAPS }

      offs.push(gatewayCtx.route('/hello', handleHello))
      offs.push(gatewayCtx.route('/inbound', handleInbound))
      offs.push(gatewayCtx.route('/outbound', handleOutbound))
      offs.push(gatewayCtx.route('/ack', handleAck))

      // 把上次没取走的队列装回来（跨进程重启不丢消息）
      const restored = loadPending()

      // 没有 token 就明确报未配置——不能假装连上了，否则入站口等于敞着
      if (!token) {
        connected = false
        gatewayCtx.state('unconfigured', '还没填接入令牌（token），外部程序连不上')
        return
      }
      gatewayCtx.state('connected', announced
        ? '沿用本进程内已声明的能力，等外部程序连上'
        : restored
          ? `从落盘队列恢复 ${restored} 条待发消息；等外部程序 /hello 声明能力`
          : '等待外部程序 /hello 声明能力')
    },

    async stop() {
      running = false
      connected = false
      for (const off of offs.splice(0)) {
        try { off() } catch {}
      }
      // 唤醒挂起的长轮询：让在途 HTTP 请求立刻返回，而不是等满 60 秒
      abortWaiters()
      // 结算所有在途：已被取走但没回执 → unknown（可能已经发出去了，绝不能重试）
      for (const [key, item] of Array.from(inflight)) {
        clearTimeout(item.timer)
        item.reject?.(sendError('unknown', 'stopped', instance, '平台端停止，回执未到，按 unknown 处理避免重复'))
        inflight.delete(key)
      }
      // 队列里没被取走的 → not-sent 还给网关（网关补发队列接手），同时清空落盘，
      // 避免「网关补发一次 + 重启后队列再交一次」变成两条。
      for (const item of queue.splice(0)) {
        clearTimeout(item.timer)
        item.reject?.(sendError('not-sent', 'stopped', instance, '平台端停止，消息还没被取走（确定没发出去）'))
      }
      savePending()
      ctx?.state('stopped')
    },

    async whoami() {
      return { account: self.account, name: self.name }
    },

    /**
     * 出站。结局只有四种，全部按上面的状态机落 certainty：
     *  1) 没运行 / 没连接（含没配 token）→ not-sent 'offline'
     *  2) proactive='none' 且不是被动回复 → not-sent 'proactive-not-allowed'
     *  3) 到点还没被取走 → not-sent 'not-taken'（确定没发出去，可重试）
     *  4) 已被取走但没回执 → unknown 'no-ack'（拿不准，绝不重发）
     * 另外：外部程序回 ack ok:false → not-sent（用它报的 code）。
     */
    async send(message = {}) {
      if (!running || !connected) throw sendError('not-sent', 'offline', instance, 'bridge 平台端未连接')
      if (!message.inResponseTo && caps.proactive === 'none') {
        throw sendError('not-sent', 'proactive-not-allowed', instance, '这个接入端只允许被动回复（proactive=none）')
      }
      const parts = message.parts || []
      if (!parts.length) throw sendError('not-sent', 'nothing-to-send', instance, '没有可发送的内容')
      if (!message.chat || (message.chat.kind !== 'private' && message.chat.kind !== 'group')) {
        throw sendError('not-sent', 'bad-chat', instance, 'send 的 chat 不合法')
      }

      // 测试/运维注入的故障（对应真实世界里的两种情况，见 BRIDGE-PROTOCOL.md「失败分类」）
      if (failSend === 'refused') {
        failSend = null
        throw sendError('not-sent', 'refused', instance, '注入的「确定没发出去」故障')
      }

      const timeoutMs = Number(message.timeoutMs) > 0 ? Number(message.timeoutMs) : defaultTimeoutMs
      if (Buffer.byteLength(JSON.stringify(parts), 'utf8') > maxBytes) {
        throw sendError('not-sent', 'too-large', instance, `消息超过 bridge 上限 ${maxBytes} 字节`)
      }

      const item = {
        id: `b-${++seq}-${clock()}`,
        chat: { kind: message.chat.kind, id: String(message.chat.id), title: message.chat.title },
        parts,
        replyTo: message.replyTo,
        inResponseTo: message.inResponseTo,
        enqueuedAt: clock(),
        takenAt: null,
        timer: null,
        resolve: null,
        reject: null,
      }

      // 注入超时：模拟「已经交出去了但永远等不到回执」——直接进 inflight、不进队列，
      // 这样任何 /outbound 都取不到它，到点必然按 unknown 结算（正是最危险的那一类失败）。
      if (failSend === 'timeout') {
        failSend = null
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
          // 关键判断：到点时这条消息在哪个状态，决定 certainty。
          if (inflight.has(item.id)) {
            // 已被取走 → 在外部程序手里 → 可能已经发出去了 → unknown，且绝不重发
            inflight.delete(item.id)
            reject(sendError('unknown', 'no-ack', instance, '外部程序取走后没回执（可能已发出，按 unknown 不重发）'))
            return
          }
          const at = queue.indexOf(item)
          if (at >= 0) queue.splice(at, 1)
          savePending() // 也从落盘摘掉：not-sent 已交给网关，后续由网关补发队列负责
          // 压根没人来取 → 确定没发出去 → not-sent（可入队重试）
          reject(sendError('not-sent', 'not-taken', instance, '外部程序没有来取这条消息（确定没发出去）'))
        }, Math.max(1, timeoutMs))
        item.timer.unref?.()

        if (options.autoAck) {
          // 契约测试用：模拟「立刻取走并立刻回执」的配合型外部程序。
          // 注意这里同步 resolve、不登记 inflight——否则 stop() 结算 inflight 时会和
          // 这个已完成的 promise 抢，历史上踩过「永远 settle 不了」的挂死。
          clearTimeout(item.timer)
          item.takenAt = clock()
          resolve({ messageId: item.id })
          return
        }

        queue.push(item)
        savePending()
        notifyWaiters()
      })
    },

    /**
     * 把 OneBot 风格的原生消息段转成契约 parts（网关 gateway.toParts 会调它）。
     * 外部程序也可以按 docs/BRIDGE-PROTOCOL.md 直接推 Part，不必走这里。
     */
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

  // 测试/运维控制面：注入故障、改能力、窥探队列。真实使用不暴露给外部程序。
  adapter.__bridge = {
    injectFail(why) { failSend = why },
    /** 等价于外部程序重新 /hello 只改 caps（测试用，不必造 HTTP 请求） */
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
    pendingFile,
    reloadPending: () => loadPending(),
    /** 仅供测试：模拟「进程突然死掉」——停掉定时器、不结算 promise、落盘保持原样。 */
    crashForTest() {
      running = false
      connected = false
      for (const off of offs.splice(0)) { try { off() } catch {} }
      for (const item of [...queue, ...inflight.values()]) clearTimeout(item.timer)
      inflight.clear()
      abortWaiters()
    },
    /**
     * 测试用：模拟「平台端已经停了、外部程序还在推入站」。
     * 真实路径是 /inbound——但 stop 时路由已撤销（契约要求），所以这里直接走同一段守卫逻辑。
     */
    pushAfterStop(message) {
      if (!running || !connected || !ctx) return { ok: false, error: 'not-connected' }
      const checked = sanitizeInbound(message)
      if (checked.error) return { ok: false, error: checked.error }
      ctx.emit(checked.message)
      return { ok: true }
    },
  }

  return adapter
}

export default createBridgeAdapter()
