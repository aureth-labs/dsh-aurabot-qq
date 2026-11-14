// Aurabot 多平台 · 网关骨架（G1 产出）
// 契约来源：src/gateway/contracts.d.ts 第 7/8/9 节（AdapterContext / Gateway / PlatformsConfig）；
// 文字规则：docs/CONTRACTS.md §六～§八之二、§十（本文件归 G1）。
// 实现任务书（Aurabot多平台实施拆分/包-G1-网关骨架.md）全部 13 条：实例管理、入站、渲染、
// 出站、补发队列、路由、fetch/native/caps、多实例、能力叠加、被动回复、回调入口、路由可调、errors。
//
// ── identity 接缝 ──
// createGateway({ identity }) 接受任何实现 Identity 形状（contracts.d.ts 第 2 节）的对象。
// 测试用内存假实现（见 test/gateway/helpers.js）；I1 合并后由宿主传真的 SQLite 实现。
// 网关只调 resolve / lookup / accountOn / isOwner，不关心它怎么存。
//
// ── http 注入形状（ctx.route 的挂载能力）──
//   http = {
//     /** 挂一个回调处理器到完整路径（网关已拼好 /platform/<实例>/ 前缀）。返回撤掉函数。 */
//     route(path: string, handler: (req, res) => any): () => void
//   }
// 平台端经 ctx.route('/callback', h) 挂的路径，实际是 /platform/<实例>/callback。
// http 缺席时网关自己维护路由表，并提供 handleHttp(req, res) 做最小分发（查不到回 404），
// 便于测试和轻量宿主接入；实例停掉时挂上的路径全部撤销（撤销后再请求自然 404）。
//
// 被动回复合并的设计取舍：repliesPerMessage>0 时，同一条 inResponseTo 名下的
// 「最后一条允许的文字」先短暂挂起（replyHoldMs，默认 300ms，可配），同 key 的后续文字
// 并进它一起发；挂起到点独自发出，绝不会丢内容。这样「第三条并进第二条」且总数不超限。
// 主动消息 / 被动回复三检查的失败（proactive-not-allowed 等）一律不入补发队列。

import { normalizeChatId, parseChatId, formatChatId } from './address.js'
import { makeSendError, isNotSent, toSendError } from './errors.js'
import { renderParts } from './render.js'
import { degrade, VOICE_RANK, PROACTIVE_RANK } from './degrade.js'
import { createOutbox } from './outbox.js'
import { createRouter } from './router.js'
import { createDedupe } from './dedupe.js'
import { dataDir as coreDataDir } from '../core/store.js'

const noopLog = { debug() {}, info() {}, warn() {}, error() {} }
const ARRIVAL_MAX = 5000
const ARRIVAL_TTL = 60 * 60_000 // 入站到达时间最多记一小时（被动回复时限远小于此）

/** 实例名里 # 前面的部分 = 默认平台名 */
const prefixOf = (instance) => String(instance).split('#')[0]

/**
 * 能力叠加：配置 caps 叠在平台端 caps() 上，只能往弱改，往强改忽略并记警告。
 * @returns {import('./contracts.d.ts').Caps}
 */
export function mergeCaps(adapterCaps, userCaps, instance, log = noopLog) {
  const merged = { ...adapterCaps }
  if (!userCaps || typeof userCaps !== 'object') return merged
  for (const [key, value] of Object.entries(userCaps)) {
    if (!(key in adapterCaps)) { merged[key] = value; continue }
    const base = adapterCaps[key]
    let ignored = false
    if (typeof base === 'boolean' && key !== 'maxFileBytes') {
      // true→false 允许（往弱）；false→true 忽略
      if (base === false && value === true) ignored = true
    } else if (key === 'voice') {
      if ((VOICE_RANK[value] ?? 0) > (VOICE_RANK[base] ?? 0)) ignored = true
    } else if (key === 'proactive') {
      if ((PROACTIVE_RANK[value] ?? 0) > (PROACTIVE_RANK[base] ?? 0)) ignored = true
    } else if (key === 'maxFileBytes') {
      // 上限只能调小；平台报 0（不能发文件）时任何正数都是往强
      if (Number(value) > Number(base)) ignored = true
    }
    if (ignored) {
      log.warn(`实例 ${instance} 的配置 caps 想把 '${key}' 往强改（${JSON.stringify(base)} → ${JSON.stringify(value)}），已忽略（只能往弱改）`)
      continue
    }
    merged[key] = value
  }
  return merged
}

/**
 * 创建网关。
 * @param {object} opts
 * @param {{ platforms: Record<string, object> }} opts.config 全量配置（读 config.platforms）
 * @param {((...parts: string[]) => string)=} opts.dataDir 数据目录函数；缺省用核心数据目录
 * @param {{ route(path: string, handler: (req: any, res: any) => any): () => void }=} opts.http
 *        HTTP 挂载能力，形状见文件头。缺席时网关自带最小分发 handleHttp(req, res)。
 * @param {object} opts.identity 实现 Identity 形状的对象（测试用内存假实现，I1 后换真的）
 * @param {object=} opts.log { debug/info/warn/error }
 * @param {() => number=} opts.now 时钟（测试注入以验证过期）
 * @param {number=} opts.replyHoldMs 被动回复合并的挂起时长（默认 300）
 */
export function createGateway({ config, dataDir, http, identity, log, now = Date.now, replyHoldMs = 300, isExternalInstance = null } = {}) {
  if (!identity || typeof identity.resolve !== 'function' || typeof identity.accountOn !== 'function') {
    throw new Error('createGateway 需要一个实现 Identity 形状的对象（identity.resolve / accountOn 等）；测试可传内存假实现，I1 合并后换真的')
  }
  const logger = { ...noopLog, ...(log || {}) }
  const dir = (...parts) => (dataDir ? dataDir('gateway', ...parts) : coreDataDir('gateway', ...parts))
  const platformsConfig = () => (config && config.platforms && typeof config.platforms === 'object' ? config.platforms : {})

  const factories = new Map() // 平台端 id → factory
  const runs = new Map() // 实例名 → runtime
  const idle = new Map() // 实例名 → { state, detail }（配置了但没跑起来的状态记录）
  const msgSubs = new Set()
  const evtSubs = new Set()
  const stateSubs = new Set()
  const flushedSubs = new Set()

  const dedupe = createDedupe({ max: 2000, log: logger })
  const arrivals = new Map() // `实例\u0000messageId` → 到达时间（被动回复时限用）
  const routes = new Map() // '/platform/<实例><path>' → handler
  const replyCounts = new Map() // `实例\u0000inResponseTo` → 已发出的条数
  const pendingReplies = new Map() // 同 key → 挂起中的最后一条允许的文字（等并流）

  const outbox = createOutbox({ file: dir('outbox.json'), log: logger, now })
  const router = createRouter({ file: dir('router.json'), log: logger, now })

  // ───────────────────────── 补发成功回调（G3 留痕用） ─────────────────────────
  outbox.onFlushed((message, result) => {
    for (const fn of flushedSubs) {
      try { fn(message, result) } catch (error) { logger.warn('onFlushed 订阅者出错：', error?.message || error) }
    }
  })

  // ───────────────────────── 实例运行时 ─────────────────────────

  function statusOf(run) {
    return {
      instance: run.instance,
      platform: run.platform,
      name: run.name,
      enabled: true,
      state: run.state,
      detail: run.detail,
      self: run.self,
      caps: run.caps,
    }
  }

  function recordArrival(instance, messageId, at) {
    const key = `${instance}\u0000${messageId}`
    arrivals.set(key, Number(at) || now())
    if (arrivals.size > ARRIVAL_MAX) {
      const cutoff = now() - ARRIVAL_TTL
      for (const [k, t] of arrivals) {
        if (t < cutoff) arrivals.delete(k)
        if (arrivals.size <= ARRIVAL_MAX * 0.9) break
      }
    }
  }

  function handleInbound(run, message) {
    // 去重：实例 + messageId（CONTRACTS §六.3）
    if (!dedupe.seen(run.instance, message.messageId)) return
    recordArrival(run.instance, message.messageId, message.at)
    const chatId = formatChatId({ instance: run.instance, platform: run.platform, kind: message.chat.kind, id: message.chat.id })
    if (!chatId) {
      logger.warn(`实例 ${run.instance} 推来的消息拼不出地址（chat=${JSON.stringify(message.chat)}），已丢弃`)
      return
    }
    const person = identity.resolve(run.platform, message.sender.account, message.sender.alt ? { alt: message.sender.alt } : undefined)
    const { text, wakeText } = renderParts(message.parts)
    const mentionsOthers = (Array.isArray(message.parts) ? message.parts : []).some((p) => p?.type === 'mention' && p.account !== 'all')
    const inbound = {
      v: 1,
      instance: run.instance,
      platform: run.platform,
      chatId,
      kind: message.chat.kind,
      chat: message.chat,
      sender: { ...message.sender, person, isOwner: identity.isOwner(person) },
      messageId: message.messageId,
      at: message.at,
      replyTo: message.replyTo,
      mentionedMe: Boolean(message.mentionedMe),
      parts: message.parts,
      ext: message.ext,
      raw: message.raw,
      text,
      wakeText,
      mentionsOthers,
    }
    for (const fn of msgSubs) {
      try { fn(inbound) } catch (error) { logger.warn('onMessage 订阅者出错：', error?.message || error) }
    }
  }

  function handleEvent(run, event) {
    const chatId = event?.chat ? formatChatId({ instance: run.instance, platform: run.platform, kind: event.chat.kind, id: event.chat.id }) : undefined
    const wrapped = { ...event, instance: run.instance, platform: run.platform, chatId }
    for (const fn of evtSubs) {
      try { fn(wrapped) } catch (error) { logger.warn('onEvent 订阅者出错：', error?.message || error) }
    }
  }

  function handleState(run, state, detail) {
    run.state = state
    run.detail = detail
    notifyState(run)
    if (state === 'connected') void postConnect(run)
  }

  function notifyState(run) {
    const status = statusOf(run)
    for (const fn of stateSubs) {
      try { fn(status) } catch (error) { logger.warn('onState 订阅者出错：', error?.message || error) }
    }
  }

  /** 连上之后：核对 whoami（不符即断开），然后自动补发该实例名下的队列 */
  async function postConnect(run) {
    const ok = await verifyWhoami(run)
    if (!ok) return
    try {
      await flushQueue(run.instance)
    } catch (error) {
      logger.warn(`实例 ${run.instance} 重连后的补发出错：`, error?.message || error)
    }
  }

  /** 连上后核对「登录的是不是配置里的那个机器人」。不符 → 断开该实例并报状态。 */
  async function verifyWhoami(run) {
    let me = null
    try {
      me = await run.adapter.whoami()
    } catch (error) {
      run.state = 'disconnected'
      run.detail = `whoami 失败：${error?.message || error}`
      notifyState(run)
      return false
    }
    run.self = me
    const cfg = run.rawConfig || {}
    const expected = cfg.selfId ?? cfg.account ?? cfg.selfAccount
    if (expected != null && String(expected) !== String(me.account)) {
      logger.warn(`实例 ${run.instance} whoami 不符：登录的是 ${me.account}，配置的是 ${expected}，断开`)
      try { await run.adapter.stop() } catch (error) { logger.warn('断开失败：', error?.message || error) }
      run.state = 'disconnected'
      run.detail = `whoami 不符：登录的是 ${me.account}，配置的是 ${expected}`
      // 标记「这个实例不会自己好」：再连也还是同一个错账号。出站时不当成可重连的断线，
      // 直接抛 not-sent 且不入队（否则队列会在每次重连时空转一轮，还可能发错人）。
      run.dead = true
      notifyState(run)
      return false
    }
    return true
  }

  // ───────────────────────── 回调入口（ctx.route） ─────────────────────────

  function registerRoute(run, path, handler) {
    const full = `/platform/${run.instance}${String(path || '/')}`
    routes.set(full, handler)
    const unregHttp = http && typeof http.route === 'function' ? http.route(full, handler) : null
    const unreg = () => {
      routes.delete(full)
      if (typeof unregHttp === 'function') unregHttp()
    }
    run.routeUnregs.push(unreg)
    return unreg
  }

  /**
   * 最小 HTTP 分发（http 注入缺席时用；注入了的宿主自己分发，也仍可调这个）。
   * 路径查不到（含实例停掉后撤销的）一律 404。
   */
  function handleHttp(req, res) {
    const path = String(req?.url || '').split('?')[0]
    const handler = routes.get(path)
    if (!handler) {
      if (res) {
        res.statusCode = 404
        if (typeof res.end === 'function') res.end()
      }
      return false
    }
    handler(req, res)
    return true
  }

  // ───────────────────────── 实例启停（sync） ─────────────────────────

  function adapterIdOf(instanceName, cfg) {
    const prefix = prefixOf(instanceName)
    const specified = cfg?.adapter
    // 冒充检查：显式指定 adapter 且实例名前缀等于某个已注册平台端的 id → 拒绝启动
    if (specified && factories.has(prefix)) {
      return { error: `实例名前缀 '${prefix}' 是已注册的平台端 id，不许再用 adapter='${specified}' 另指平台端（可以冒充那个平台上的人）` }
    }
    return { id: specified || prefix }
  }

  function makeCtx(run, rawConfig) {
    const ctx = {
      instance: run.instance,
      config: () => {
        const { enabled, adapter, caps, behavior, ...rest } = rawConfig || {}
        return rest
      },
      emit: (message) => handleInbound(run, message),
      emitEvent: (event) => handleEvent(run, event),
      state: (state, detail) => handleState(run, state, detail),
      capsChanged: () => {
        run.caps = mergeCaps(run.adapter.caps(), rawConfig?.caps, run.instance, logger)
      },
      log: logger,
      dataDir: (...parts) => dir('instances', run.instance, ...parts),
      route: (path, handler) => registerRoute(run, path, handler),
    }
    return ctx
  }

  async function startInstance(instanceName, rawConfig) {
    const resolved = adapterIdOf(instanceName, rawConfig)
    if (resolved.error) {
      idle.set(instanceName, { state: 'stopped', detail: resolved.error })
      logger.warn(`实例 ${instanceName} 拒绝启动：${resolved.error}`)
      return
    }
    const factory = factories.get(resolved.id)
    if (!factory) {
      idle.set(instanceName, { state: 'unconfigured', detail: `没有注册名为 '${resolved.id}' 的平台端` })
      return
    }
    let adapter
    try {
      adapter = factory()
    } catch (error) {
      idle.set(instanceName, { state: 'stopped', detail: `平台端工厂出错：${error?.message || error}` })
      return
    }
    const run = {
      instance: instanceName,
      // 平台名取实例名前缀：adapter 另指时（mychat → bridge），地址、身份表里仍用 mychat
      // （contracts.d.ts InstanceConfig.adapter 注释）
      platform: prefixOf(instanceName),
      name: adapter.name || instanceName,
      adapter,
      rawConfig,
      state: 'unconfigured',
      detail: undefined,
      self: null,
      caps: null,
      routeUnregs: [],
    }
    run.caps = mergeCaps(adapter.caps(), rawConfig?.caps, instanceName, logger)
    runs.set(instanceName, run)
    idle.delete(instanceName)
    const ctx = makeCtx(run, rawConfig)
    run.ctx = ctx
    try {
      await adapter.start(ctx)
    } catch (error) {
      unregisterRoutes(run)
      runs.delete(instanceName)
      idle.set(instanceName, { state: 'stopped', detail: `启动失败：${error?.message || error}` })
      logger.warn(`实例 ${instanceName} 启动失败：`, error?.message || error)
    }
  }

  function unregisterRoutes(run) {
    for (const unreg of run.routeUnregs.splice(0)) {
      try { unreg() } catch {}
    }
  }

  async function stopInstance(instanceName, reason) {
    const run = runs.get(instanceName)
    if (!run) return
    unregisterRoutes(run)
    // 挂起中的被动回复直接丢弃（过时限补发没有意义）
    for (const [key, p] of Array.from(pendingReplies)) {
      if (p.instance === instanceName) {
        clearTimeout(p.timer)
        pendingReplies.delete(key)
      }
    }
    try {
      await run.adapter.stop()
    } catch (error) {
      logger.warn(`实例 ${instanceName} 停止出错：`, error?.message || error)
    }
    runs.delete(instanceName)
    idle.set(instanceName, { state: 'stopped', detail: reason || '实例已停止' })
  }

  /** 按 config.platforms 启停实例；只动有变化的实例 */
  async function sync() {
    const desired = platformsConfig()
    // 停掉：被移除 / disabled / 配置变了
    for (const [instanceName, run] of Array.from(runs)) {
      const want = desired[instanceName]
      const wantJson = want ? JSON.stringify(want) : null
      if (!want || want.enabled === false || wantJson !== run.cfgJson) {
        await stopInstance(instanceName, !want ? '实例已从配置移除' : want.enabled === false ? '实例已停用' : '配置已变更')
      }
    }
    for (const [instanceName, want] of Object.entries(desired)) {
      if (!want || want.enabled === false) {
        if (!runs.has(instanceName) && !idle.has(instanceName)) idle.set(instanceName, { state: 'stopped', detail: '实例已停用' })
        continue
      }
      if (typeof isExternalInstance === 'function' && isExternalInstance(instanceName)) {
        if (runs.has(instanceName)) await stopInstance(instanceName, '由宿主直连托管')
        idle.set(instanceName, { state: 'connected', detail: '由宿主直连托管', cfgJson: JSON.stringify(want) })
        continue
      }
      if (runs.has(instanceName)) continue
      await startInstance(instanceName, want)
    }
  }

  // 记住每份配置的 JSON（sync 的「只动有变化」判据）
  const origStartInstance = startInstance
  startInstance = async function (instanceName, rawConfig) {
    const before = runs.size
    await origStartInstance(instanceName, rawConfig)
    const run = runs.get(instanceName)
    if (run) run.cfgJson = JSON.stringify(rawConfig)
    if (before === runs.size && !runs.has(instanceName)) {
      const record = idle.get(instanceName)
      if (record) record.cfgJson = JSON.stringify(rawConfig)
    }
  }

  // ───────────────────────── 补发 ─────────────────────────

  /** 直接调平台端 send（补发不再走降级/入队，parts 入队时已按当时的 caps 降过级） */
  async function flushQueue(onlyInstance) {
    return outbox.flush(async (item) => {
      const run = runs.get(item.instance)
      if (!run || run.state !== 'connected') {
        throw makeSendError('not-sent', 'offline', item.instance, `实例 ${item.instance} 未连接`)
      }
      const chatId = normalizeChatId(item.message.chatId)
      const addr = chatId ? parseChatId(chatId) : null
      if (!addr) throw makeSendError('not-sent', 'bad-chat-id', item.instance, `队列里的地址认不出：${item.message.chatId}`)
      return run.adapter.send({
        chat: { kind: addr.kind, id: addr.id },
        parts: item.message.parts,
        replyTo: item.message.replyTo,
        inResponseTo: item.message.inResponseTo,
        timeoutMs: item.message.timeoutMs,
        ext: item.message.ext,
      })
    }, onlyInstance)
  }

  // ───────────────────────── 被动回复合并 ─────────────────────────

  function flushPendingReply(key) {
    const pending = pendingReplies.get(key)
    if (!pending) return
    pendingReplies.delete(key)
    clearTimeout(pending.timer)
    void deliverPending(pending, key)
  }

  async function deliverPending(pending, key) {
    const run = runs.get(pending.instance)
    const chatId = normalizeChatId(pending.chatId)
    const addr = chatId ? parseChatId(chatId) : null
    if (!run || !addr || run.state !== 'connected') {
      logger.warn(`挂起中的被动回复发不出去，丢弃：${pending.note || pending.chatId}`)
      return
    }
    try {
      const result = await run.adapter.send({
        chat: { kind: addr.kind, id: addr.id },
        parts: pending.parts,
        replyTo: pending.replyTo,
        inResponseTo: pending.inResponseTo,
        timeoutMs: pending.timeoutMs,
      })
      bumpReplyCount(pending.instance, pending.inResponseTo)
      logger.info(`合并后的被动回复已发出：${pending.note || pending.chatId}（${result.messageId}）`)
    } catch (error) {
      // 挂起的被动回复失败不入补发队列（过时限补发没用），直接丢弃
      logger.warn(`合并后的被动回复发送失败，丢弃：${error?.message || error}`)
    }
  }

  function bumpReplyCount(instance, inResponseTo) {
    if (!inResponseTo) return
    const key = `${instance}\u0000${inResponseTo}`
    replyCounts.set(key, (replyCounts.get(key) || 0) + 1)
    if (replyCounts.size > 2000) {
      replyCounts.delete(replyCounts.keys().next().value)
    }
  }

  // ───────────────────────── 出站（send） ─────────────────────────

  function resolveTarget(chatIdOrInstance) {
    const norm = normalizeChatId(chatIdOrInstance)
    if (norm) {
      const addr = parseChatId(norm)
      if (addr && runs.has(addr.instance)) return { run: runs.get(addr.instance), chatId: norm, addr }
    }
    if (runs.has(chatIdOrInstance)) return { run: runs.get(chatIdOrInstance), chatId: null, addr: null }
    return { run: null, chatId: norm || null, addr: null }
  }

  /**
   * 唯一的出站口。顺序照 CONTRACTS §七：
   * 规范化地址 → 查实例 → 被动回复三检查 → 按 caps 降级 → 平台端 send → 失败分类 → 入队。
   */
  async function send(message = {}) {
    const chatId = normalizeChatId(message.chatId)
    if (!chatId) throw makeSendError('not-sent', 'bad-chat-id', String(message.chatId || ''), `认不出的地址：${message.chatId}`)
    const addr = parseChatId(chatId)
    const run = runs.get(addr.instance)

    // 查实例：没启用 / 不存在 → not-sent，不入队（没有可以重连的实例）
    if (!run) {
      throw makeSendError('not-sent', 'offline', addr.instance, `实例 ${addr.instance} 不存在或未启用`)
    }
    const capsNow = run.caps
    if (run.state !== 'connected' || !capsNow) {
      const error = makeSendError('not-sent', 'offline', addr.instance, `实例 ${addr.instance} 未连接`)
      // whoami 不符等「实例自己不会恢复」的情况：入队没有意义（重连还是同一个错账号），直接拒
      if (run.dead) throw error
      const queued = outbox.add(message, { instance: addr.instance })
      if (queued.ok) return { messageId: '', degraded: [], queued: true }
      throw error
    }

    // 同 key 还挂着上一轮的合并尾巴、这一条已经换了话题 → 先把它发出去
    // （只有「换了 inResponseTo 或转主动」时才冲刷，同 key 的正常并流不受影响）
    const key0 = message.inResponseTo ? `${addr.instance}\u0000${message.inResponseTo}` : null
    if (!key0 || capsNow.repliesPerMessage <= 0) {
      for (const [k] of Array.from(pendingReplies)) {
        if (pendingReplies.get(k)?.instance === addr.instance) flushPendingReply(k)
      }
    }

    // 被动回复三检查（CONTRACTS §八.4）
    const arrivalAt = message.inResponseTo ? arrivals.get(`${addr.instance}\u0000${message.inResponseTo}`) ?? null : null
    let windowExpired = false
    if (message.inResponseTo && capsNow.replyWindowMs > 0) {
      if (arrivalAt == null || now() - arrivalAt > capsNow.replyWindowMs) windowExpired = true
    }
    const proactive = !message.inResponseTo || windowExpired

    // 按 caps 降级（可能抛 nothing-to-send / too-large / proactive-not-allowed —— 这些不入队）
    const d = degrade(message.parts, message.replyTo, capsNow, { instance: addr.instance, proactive })

    const renderedText = renderParts(d.parts).text
    const limit = Number(capsNow.repliesPerMessage) || 0
    const key = message.inResponseTo && !proactive ? `${addr.instance}\u0000${message.inResponseTo}` : null

    // repliesPerMessage 合并：最后一条允许的文字先挂起，后续同 key 的文字并进来
    if (key && limit > 0) {
      const pending = pendingReplies.get(key)
      if (pending && pending.chatId === chatId) {
        // 超出条数的文字并进最后一条允许的消息里，不丢内容
        if (renderedText) pending.parts.push({ type: 'text', text: `\n${renderedText}` })
        return { messageId: '', degraded: [...d.degraded, 'replies merged into previous'], queued: false, pending: true }
      }
      const count = replyCounts.get(key) || 0
      const textSafe = d.parts.every((p) => ['text', 'mention', 'face'].includes(p.type))
      if (count + 1 >= limit && textSafe) {
        // 换了聊天对象时清掉旧挂起，避免旧 timer 冲掉新挂起
        const stale = pendingReplies.get(key)
        if (stale) { clearTimeout(stale.timer); pendingReplies.delete(key) }
        const pendingItem = {
          instance: addr.instance,
          chatId,
          parts: d.parts,
          replyTo: d.replyTo,
          inResponseTo: message.inResponseTo,
          timeoutMs: message.timeoutMs,
          note: message.note,
          timer: null,
        }
        pendingItem.timer = setTimeout(() => flushPendingReply(key), Math.max(1, replyHoldMs))
        pendingItem.timer.unref?.()
        pendingReplies.set(key, pendingItem)
        return { messageId: '', degraded: [...d.degraded, 'reply held for merging'], queued: false, pending: true }
      }
    }

    // 调平台端
    try {
      const result = await run.adapter.send({
        chat: { kind: addr.kind, id: addr.id },
        parts: d.parts,
        replyTo: d.replyTo,
        inResponseTo: proactive ? undefined : message.inResponseTo,
        timeoutMs: message.timeoutMs,
        ext: message.ext,
      })
      bumpReplyCount(addr.instance, proactive ? null : message.inResponseTo)
      return { messageId: result.messageId, degraded: d.degraded }
    } catch (error) {
      const sendError = toSendError(error, addr.instance)
      if (isNotSent(sendError)) {
        // 确定没发出去且不含媒体 → 入队；媒体消息入不了队 → 原样抛出
        const queued = outbox.add({ ...message, parts: d.parts, replyTo: d.replyTo }, { instance: addr.instance })
        if (queued.ok) return { messageId: '', degraded: d.degraded, queued: true }
      }
      throw sendError
    }
  }

  // ───────────────────────── 对外接口 ─────────────────────────

  const gateway = {
    register(factory) {
      if (typeof factory !== 'function') throw new Error('register 需要一个平台端工厂函数')
      const probe = factory()
      if (!probe?.id) throw new Error('平台端工厂必须返回带 id 的 PlatformAdapter')
      if (probe.contract !== 1) throw new Error(`平台端 ${probe.id} 的 contract 必须是 1`)
      factories.set(probe.id, factory)
      return () => factories.delete(probe.id)
    },

    sync,

    /**
     * 停掉全部实例（宿主 dispose / 插件卸载时调）。
     * 平台端的重连定时器、长轮询、HTTP 回调路由都必须在这里收掉，否则宿主关了进程还不退出。
     */
    async stopAll() {
      for (const instanceName of Array.from(runs.keys())) {
        await stopInstance(instanceName, '网关已停止')
      }
      for (const [instanceName, want] of Object.entries(platformsConfig())) {
        if (!runs.has(instanceName)) idle.set(instanceName, { state: 'stopped', detail: '网关已停止' })
      }
    },

    instances() {
      const list = []
      for (const [instanceName, want] of Object.entries(platformsConfig())) {
        const run = runs.get(instanceName)
        if (run) {
          list.push(statusOf(run))
          continue
        }
        const record = idle.get(instanceName)
        list.push({
          instance: instanceName,
          platform: prefixOf(instanceName),
          name: instanceName,
          enabled: Boolean(want?.enabled),
          state: record?.state || (want?.enabled ? 'stopped' : 'stopped'),
          detail: record?.detail || (want?.enabled ? '尚未启动' : '实例已停用'),
          self: null,
          caps: null,
        })
      }
      // 运行中但配置里没有的（理论不该有），也报出来便于排障
      for (const run of runs.values()) {
        if (!platformsConfig()[run.instance]) list.push(statusOf(run))
      }
      return list
    },

    onMessage(fn) {
      msgSubs.add(fn)
      return () => msgSubs.delete(fn)
    },
    onEvent(fn) {
      evtSubs.add(fn)
      return () => evtSubs.delete(fn)
    },
    onState(fn) {
      stateSubs.add(fn)
      return () => stateSubs.delete(fn)
    },
    /** 补发成功回调：onFlushed(message: OutboundMessage, result: SendResult)。G3 用它留痕。 */
    onFlushed(fn) {
      flushedSubs.add(fn)
      return () => flushedSubs.delete(fn)
    },

    send,

    caps(chatIdOrInstance) {
      const { run } = resolveTarget(chatIdOrInstance)
      return run ? run.caps : null
    },

    async fetch(chatIdOrInstance, request) {
      const { run } = resolveTarget(chatIdOrInstance)
      if (!run || run.state !== 'connected') throw makeSendError('not-sent', 'offline', String(chatIdOrInstance), '实例未连接')
      if (typeof run.adapter.fetch !== 'function') throw new Error(`平台端 ${run.platform} 没有实现 fetch`)
      return run.adapter.fetch(request)
    },

    async native(instance, action, params, opts) {
      const run = runs.get(instance)
      if (!run || !platformsConfig()[instance]?.enabled) throw new Error(`实例 ${instance} 未启用，native 不可用`)
      if (typeof run.adapter.native !== 'function') throw new Error(`平台端 ${run.platform} 没有实现 native`)
      return run.adapter.native(action, params, opts)
    },

    toParts(chatIdOrInstance, nativeMessage) {
      const { run } = resolveTarget(chatIdOrInstance)
      if (!run) throw new Error(`认不出实例：${chatIdOrInstance}`)
      if (typeof run.adapter.toParts !== 'function') throw new Error(`平台端 ${run.platform} 没有实现 toParts`)
      return run.adapter.toParts(nativeMessage)
    },

    routeTo(person) {
      return router.routeTo(person, { identity, getInstances: () => gateway.instances() })
    },
    noteSeen(person, chatId, at) {
      router.noteSeen(person, chatId, at)
    },

    identity,
    outbox: {
      status: () => outbox.status(),
      flush: (instance) => flushQueue(instance),
    },

    /** 路由配置（§八之二.6）：固定平台 / SendKind 优先实例。接口待后续契约化。 */
    routing: {
      setFixed: (person, platform) => router.setFixed(person, platform),
      fixedPlatform: (person) => router.fixedPlatform(person),
      noteSeen: (person, chatId, at) => router.noteSeen(person, chatId, at),
      setKindInstance: (kind, instance) => router.setKindInstance(kind, instance),
      instanceForKind: (kind) => router.instanceForKind(kind),
    },

    /** HTTP 最小分发（见文件头的 http 注入形状说明）。 */
    handleHttp,
  }

  return gateway
}
