// QQ 平台端（G2 产出）—— Aurabot 多平台的第二个平台端，id='qq'。
//
// 作用：把「怎么和 OneBot v11 网关说话」收进一个符合 PlatformAdapter 契约的平台端。
//   - 入站：OneBot 事件 → AdapterInbound / AdapterEvent（见 inbound.js）
//   - 出站：parts → OneBot 消息段 / upload_* / send_poke（见 outbound.js）
//   - 能力探测：连上后挨个问扩展动作，得出 caps 并缓存（见 probe.js，本包的核心）
//   - native：扩展动作透传（见 native.js）
//   - SnowLuma 管理：可选的「帮你启停本机网关」（见 snowluma.js，仅 Windows + 配了目录）
//   - 失败分类：transport → not-sent，uncertain → unknown（见 errors.js，判定全部复用 onebot/client.js）
//
// 契约：src/gateway/contracts.d.ts（PlatformAdapter / Caps / Part / SendError.certainty）
//       docs/CONTRACTS.md §六～§九；docs/ADAPTER.md 的六步清单。
// 任务书：Aurabot多平台实施拆分/包-G2-QQ平台端.md。
//
// ── 这一版**不改**任何现有代码 ──
// src/onebot/client.js、src/snowluma/**、src/chat/inbound.js 全部只 import 不修改（G3 切换后再删/搬）。
// 连接层复用 createOneBotClient：连接、重连、HTTP/WS 双通道、超时与 transport/uncertain 分类，
// 一行都没有重写（重写就等于把已经测过的防重复发送地基换成没人测过的）。
//
// ── 测试注入点（真实运行不会用到）──
// createQqAdapter({ client, fs, faceName, faceIdOf, probeTable, managerFactory })
//   都不给时按生产默认：真连 OneBot、真读写 caps.json、不维护表情名表。
//   client 只要求有 { start, stop, call, isConnected, state, restart } —— 就是 createOneBotClient 的返回。

import { createOneBotClient, isDefiniteFailure } from '../../onebot/client.js'
import { fromOneBotEvent, toAdapterEvent, segmentsToParts, toParts as partsOf } from './inbound.js'
import { buildParts } from './outbound.js'
import { createNative } from './native.js'
import { makeSendError, toSendError } from './errors.js'
import {
  CAPS_CONSERVATIVE, FILE_MAX_BYTES, cacheMatchesGateway, capsFromProbes, probeGateway,
  readCapsCache, supportedActions, writeCapsCache,
} from './probe.js'
import { createSnowlumaSidecar, snowlumaEnabled } from './snowluma.js'

/**
 * 建一个 QQ 平台端实例。
 * @param {object} [options] 见文件头的「测试注入点」
 * @returns {import('../../gateway/contracts.d.ts').PlatformAdapter}
 */
export function createQqAdapter(options = {}) {
  const id = 'qq'
  let instance = id // start 时由 ctx.instance 给（qq#2 这种多实例也能跑）
  let ctx = null
  let running = false
  let connected = false
  let client = options.client || null
  let sidecar = null // SnowLuma 控制器（只有 backend=snowluma 才有）
  let caps = { ...CAPS_CONSERVATIVE }
  let probeState = null // { probed, supported:Set, entries, gateway, unsupported, unknown }
  let probeCache = null
  let capsFile = null
  let selfId = '' // 机器人自己的号：@自己 要判定成 mentionedMe
  let probing = false
  let unbindClient = null

  const fsImpl = options.fs || null // 测试注入的假 fs（决定 caps.json 走哪）
  const log = () => (ctx?.log || noopLog)

  // ───────────────────────── 配置 ─────────────────────────

  const config = () => (typeof ctx?.config === 'function' ? ctx.config() || {} : {})

  /**
   * 从配置里取 OneBot 端点。三档优先级：
   *   1. 用户手填的 wsUrl / httpUrl（backend='onebot' 就是这一档，接别人家的网关）
   *   2. SnowLuma 自己的配置文件里读出来的（backend='snowluma' 且没手填时）
   *   3. 都没有 → 空地址：客户端会立刻以 transport 失败，whoami/send 都按 not-sent 走，不会静默冒充在线
   */
  function endpoint() {
    const cfg = config()
    const wsUrl = String(cfg.wsUrl || '').trim()
    const httpUrl = String(cfg.httpUrl || '').trim()
    const token = String(cfg.token || cfg.accessToken || '').trim()
    if (wsUrl || httpUrl) {
      return {
        wsUrl,
        httpUrl,
        wsToken: String(cfg.wsToken || token).trim(),
        httpToken: String(cfg.httpToken || token).trim(),
      }
    }
    if (sidecar) {
      try {
        const ep = sidecar.endpoint()
        if (ep && (ep.wsUrl || ep.httpUrl)) return ep
      } catch (error) {
        log().debug?.('读 SnowLuma 的 OneBot 配置失败：', error?.message || error)
      }
    }
    return { wsUrl: '', httpUrl: '', wsToken: '', httpToken: '' }
  }

  // ───────────────────────── 客户端（可注入） ─────────────────────────

  /**
   * 真实客户端返回的是 OneBot 响应里的 data；有的假客户端（测试）直接回整个信封
   * { status, retcode, data }。两种都收，省得平台端里到处写 `?.data`。
   */
  function unwrap(result) {
    if (result && typeof result === 'object' && 'data' in result && ('retcode' in result || result.status === 'ok' || result.status === 'failed')) return result.data
    return result
  }

  /** 走一次动作（统一 unwrap + 统一错误形状）。 */
  const call = (action, params, opts) => {
    if (!client) return Promise.reject(makeSendError('not-sent', 'offline', instance, 'QQ 网关客户端还没建'))
    return Promise.resolve(client.call(action, params, opts)).then(unwrap)
  }

  /** 建生产用的 OneBot 客户端（复用 src/onebot/client.js，不重写连接层）。 */
  function makeClient() {
    return createOneBotClient({
      endpoint,
      log: log(),
      onState: (state, detail) => onClientState(state, detail),
      onEvent: (event) => onClientEvent(event),
    })
  }

  /**
   * 给客户端接上状态与事件回调。
   * makeClient() 走的是 createOneBotClient 的构造参数（onState/onEvent），注入的 client
   * （测试替身、宿主自带客户端）只能靠 on()/off() 订阅，两种形状都支持。
   */
  function bindClient() {
    if (!client || typeof client.on !== 'function') return
    try { unbindClient?.() } catch {}
    const offState = client.on('state', (state, detail) => onClientState(state, detail))
    const offEvent = client.on('event', (event) => onClientEvent(event))
    unbindClient = () => {
      try { offState?.() } catch {}
      try { offEvent?.() } catch {}
    }
  }

  function onClientState(state, detail) {    if (!running || !ctx) return
    if (state === 'connected') {
      if (connected) return // 已经处理过这次连上（避免 start 里与回调重复触发 afterConnect）
      connected = true
      ctx.state('connected')
      void afterConnect()
      return
    }
    connected = false
    // 客户端自己的状态词（connecting/disconnected/unconfigured/stopped）与契约的 ConnState 不完全重合，
    // 这里只翻译契约里有的三个值，stopped 交给平台端的 stop() 报，避免「停了又报一次 stopped」。
    if (state === 'connecting') ctx.state('connecting')
    else if (state === 'disconnected') ctx.state('disconnected', detail)
    else if (state === 'unconfigured') ctx.state('unconfigured', detail || '没有配置 OneBot 地址')
  }

  function onClientEvent(event) {
    // 停完就不许再 emit（CONTRACTS 第六节第 3 条、adapter-kit 用例 5）
    if (!running || !ctx) return
    try {
      if (event?.post_type === 'message') {
        const inbound = fromOneBotEvent(event, { selfId, faceName: options.faceName })
        if (inbound && inbound.messageId) ctx.emit(inbound)
        return
      }
      if (event?.post_type === 'message_sent') {
        // 机器人自己发的：走 emitEvent({type:'self-sent'})，绝不走 emit（CONTRACTS §六.4）
        const evt = toAdapterEvent(event, { selfId })
        if (evt) ctx.emitEvent(evt)
        return
      }
      const evt = toAdapterEvent(event, { selfId })
      if (evt) ctx.emitEvent(evt)
    } catch (error) {
      log().warn?.('处理 OneBot 事件出错：', error?.message || error)
    }
  }

  // ───────────────────────── 能力探测 ─────────────────────────

  /** caps.json 的完整路径（在实例自己的数据目录里）。 */
  function cacheFilePath() {
    if (capsFile) return capsFile
    try {
      capsFile = ctx?.dataDir ? ctx.dataDir('caps.json') : 'caps.json'
    } catch (error) {
      capsFile = 'caps.json'
    }
    return capsFile
  }

  /** 探测前先读缓存：这一版按「保守」起步，缓存只用来加速 —— 见下方 writeCapsCache 的注释。 */
  function loadCapsCache() {
    const file = cacheFilePath()
    probeCache = readCapsCache(file, { fs: fsImpl, log: log() })
    if (probeCache) log().info?.(`读到了能力缓存（${probeCache.gateway?.app || '?'} ${probeCache.gateway?.version || ''}，${probeCache.supported.length} 个动作）`)
    return probeCache
  }

  /**
   * 跑一遍探测（连上之后调，或 native 前发现还没探完时调）。
   * @param {{ reason?: string }} [opts]
   */
  async function runProbe({ reason = 'connected' } = {}) {
    if (!client || probing) return probeState
    probing = true
    try {
      // 先读版本，用来判断缓存还能不能用
      let gateway = { app: '', version: '' }
      try {
        const v = await call('get_version_info', {}, { timeoutMs: 5000, retries: 0 })
        gateway = { app: String(v?.app_name || v?.appName || ''), version: String(v?.app_version || v?.appVersion || v?.version || '') }
      } catch (error) {
        log().debug?.('读网关注册信息失败，按「版本未知」处理')
      }
      const cacheOk = probeCache && cacheMatchesGateway(probeCache, gateway)
      if (cacheOk && reason === 'connected') {
        // 缓存命中且网关版本没变：先用缓存，后台再复探一次（用户换了网关也能自己发现）
        applyProbe({ caps: probeCache.caps, supported: probeCache.supported, entries: {}, unknown: [], unsupported: [], probedAt: probeCache.probedAt, fromCache: true })
        log().info?.('能力缓存命中，先用缓存报能力，后台继续复探')
        // 不 await：后台复探，失败只降级不抛
        void realProbe(gateway).catch((error) => log().warn?.('后台复探失败（继续用缓存）：', error?.message || error))
        return probeState
      }
      await realProbe(gateway)
      return probeState
    } finally {
      probing = false
    }
  }

  async function realProbe(gateway) {
    const result = await probeGateway((action, params, opts) => call(action, params, opts), {
      log: log(),
      table: options.probeTable,
    })
    const finalGateway = { ...result.gateway, ...(gateway || {}) }
    const payload = {
      gateway: finalGateway,
      caps: result.caps,
      supported: result.supported,
      probedAt: result.probedAt,
    }
    writeCapsCache(cacheFilePath(), payload, { fs: fsImpl, log: log() })
    probeCache = { ...payload, actions: result.supported, unknown: result.unknown }
    applyProbe({ ...result, gateway: finalGateway })
    log().info?.(`能力探测完成（${finalGateway.app || '?'} ${finalGateway.version || ''}）：支持 ${result.supported.length} 个动作，不支持 ${result.unsupported.length} 个`)
    // 探测失败的那些单项要能在面板看到（「当前网关不支持 X」）
    for (const entry of Object.values(result.entries)) {
      if (entry.exists === false) log().warn?.(`当前网关不支持「${entry.label}」（${entry.action}）`)
    }
  }

  /** 把探测结果装进 caps，并通知网关重读（capsChanged）。 */
  function applyProbe({ caps: probedCaps, supported, entries = {}, unknown = [], unsupported = [], probedAt = 0 }) {
    caps = { ...CAPS_CONSERVATIVE, ...(probedCaps || {}) }
    probeState = { probed: true, supported: supportedActions({ supported }), entries, unknown, unsupported, probedAt }
    // 探测后才敢说「这个网关有哪些扩展动作」：通知网关重新读 caps（契约 §八.1）
    try { ctx?.capsChanged?.() } catch (error) { log().debug?.('capsChanged 回调出错：', error?.message || error) }
  }

  // ───────────────────────── 连接后 ─────────────────────────

  async function afterConnect() {
    if (!running) return
    // ① 核对登录的是不是配置里的那个机器人；顺带拿到 selfId（@自己 要用）
    let me = null
    try {
      me = await whoami()
      selfId = String(me?.account || '')
    } catch (error) {
      log().warn?.('连上了但 reads 不到登录信息：', error?.message || error)
    }
    if (!running) return
    // ② SnowLuma 场景：核对登录的号（不是机器人号就撤销注入、断开）
    if (sidecar && selfId) {
      try {
        const ok = await sidecar.confirmLogin(selfId)
        if (!ok) {
          log().warn?.('登录的号不是机器人号，已断开这个实例')
          try { client?.stop() } catch (inner) {}
          if (ctx) ctx.state('disconnected', '登录的号不是配置里的机器人号')
          return
        }
      } catch (error) {
        log().debug?.('SnowLuma 核对登录号失败（不影响连接）：', error?.message || error)
      }
    }
    // ③ 能力探测（缓存命中就先报缓存，后台复探）
    try {
      await runProbe()
    } catch (error) {
      log().warn?.('能力探测失败，继续按最保守的能力表运行：', error?.message || error)
    }
  }

  // ───────────────────────── 发送 ─────────────────────────

  /**
   * 出站主路径。
   * 失败分类的全部来源是 src/onebot/client.js 的 transport / uncertain（见 errors.js）。
   */
  async function send(message = {}) {
    const cfg = config()
    const chat = message?.chat || {}
    const parts = Array.isArray(message?.parts) ? message.parts : []
    const kind = chat.kind === 'group' ? 'group' : 'private'
    // 被动回复的平台才需要这层保险：本平台 proactive='free'，走到这里说明是配置把它改小了
    if (caps.proactive === 'none' && !message.inResponseTo) {
      throw makeSendError('not-sent', 'proactive-not-allowed', instance, '该实例被配置成只能被动回复')
    }
    if (!parts.length) throw makeSendError('not-sent', 'nothing-to-send', instance, '没有可发送的内容')
    if (!running || !client || !connected) throw makeSendError('not-sent', 'offline', instance, 'QQ 网关未连接')
    const targetId = String(chat.id ?? '')
    if (!targetId) throw makeSendError('not-sent', 'bad-chat-id', instance, '出站缺少聊天编号')

    const { segments, uploads, pokes, degraded } = buildParts(parts, {
      voiceMode: caps.voice,
      faceIdOf: options.faceIdOf,
      log: log(),
    })
    const timeoutMs = Math.max(1, Number(message.timeoutMs) || 15000)
    let messageId = ''

    try {
      // ① 文件：走 upload_private_file / upload_group_file（和 hub.js sendFile 同一条路）
      const uploaded = []
      for (const up of uploads) {
        const size = Number(parts.find((p) => p?.type === 'file' || p?.type === 'voice')?.media?.size) || 0
        if (size && caps.maxFileBytes > 0 && size > caps.maxFileBytes) {
          throw makeSendError('not-sent', 'too-large', instance, `文件 ${size} 字节超过该网关上限 ${caps.maxFileBytes}`)
        }
        const action = kind === 'group' ? 'upload_group_file' : 'upload_private_file'
        const params = kind === 'group'
          ? { group_id: Number(targetId), file: up.file, name: up.name || 'file' }
          : { user_id: Number(targetId), file: up.file, name: up.name || 'file' }
        const r = await call(action, params, { timeoutMs, retries: 0 })
        uploaded.push({ action, name: up.name || 'file', id: r?.file_id })
      }

      // ② 消息段：引用回复要放在最前面（OneBot 规定 reply 段必须在首位）
      const outSegments = [...segments]
      if (message.replyTo && caps.quoteReply) outSegments.unshift({ type: 'reply', data: { id: String(message.replyTo) } })
      if (outSegments.length || uploaded.length) {
        const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg'
        const params = kind === 'group'
          ? { group_id: Number(targetId), message: outSegments }
          : { user_id: Number(targetId), message: outSegments }
        // 群里的戳一戳要靠 send_poke 单独发；私聊的 poke 段直接算进消息里（对面网关自己认）
        if (outSegments.length) {
          const r = await call(action, params, { timeoutMs, retries: 0 })
          messageId = String(r?.message_id ?? '')
        }
      }

      // ③ 戳一戳：独立的动作（不是消息段）
      if (pokes.length) {
        try {
          // 群里要带 group_id；私聊只有 user_id
          await call('send_poke', kind === 'group' ? { group_id: Number(targetId), user_id: 0 } : { user_id: Number(targetId) }, { timeoutMs, retries: 0 })
        } catch (error) {
          degraded.push('poke dropped')
          log().debug?.('戳一戳没发出去（不影响这条消息）：', error?.message || error)
        }
      }

      if (!messageId && uploaded.length) messageId = String(uploaded[0].id || `file-${Date.now()}`)
      if (!messageId) throw makeSendError('not-sent', 'nothing-sent', instance, '降级后没有可发送的内容')
      return { messageId }
    } catch (error) {
      // 已经是 SendError 的直接抛；其余的按 onebot/client.js 的 transport/uncertain 判定翻译
      if (error?.certainty === 'not-sent' || error?.certainty === 'unknown') throw error
      throw toSendError(error, { instance, isDefiniteFailure })
    }
  }

  // ───────────────────────── fetch ─────────────────────────

  async function fetch(request = {}) {
    if (!running || !client || !connected) throw makeSendError('not-sent', 'offline', instance, 'QQ 网关未连接')
    const chat = request.chat || {}
    const kind = chat.kind === 'group' ? 'group' : 'private'
    const id = String(chat.id ?? '')
    try {
      switch (request.kind) {
        case 'media': {
          const media = request.media || {}
          // 图片和语音走不同的取文件动作；文件地址看 chat 类型
          const file = media.id || (media.url ? String(media.url) : '')
          if (!file) throw makeSendError('not-sent', 'no-media', instance, 'media 里没有可取的标识')
          const record = String(media.mime || '').startsWith('audio') || media.kind === 'voice'
          const action = record ? 'get_record' : 'get_image'
          const r = await call(action, record ? { file, out_format: 'wav' } : { file }, { timeoutMs: 30000 })
          return { url: r?.url ? String(r.url) : undefined, path: r?.file ? String(r.file) : undefined, base64: r?.base64 || undefined }
        }
        case 'forward': {
          const r = await call('get_forward_msg', { id: String(request.id ?? '') }, { timeoutMs: 20000 })
          // 转成 parts 数组返回：网关不认识 OneBot 的 node 结构
          const nodes = Array.isArray(r?.messages) ? r.messages : []
          return { messages: nodes.map((n) => segmentsToParts(n?.message ?? n?.content ?? [], { selfId, faceName: options.faceName })) }
        }
        case 'history': {
          const count = Math.max(1, Math.min(100, Number(request.count) || 20))
          const action = kind === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history'
          const params = kind === 'group' ? { group_id: Number(id), count } : { user_id: Number(id), count }
          const r = await call(action, params, { timeoutMs: 20000 })
          return Array.isArray(r?.messages) ? r.messages : []
        }
        case 'member': {
          if (kind !== 'group') throw makeSendError('not-sent', 'no-member', instance, '私聊没有成员信息')
          return await call('get_group_member_info', { group_id: Number(id), user_id: Number(request.account), no_cache: true }, { timeoutMs: 10000 })
        }
        case 'members': {
          if (kind !== 'group') throw makeSendError('not-sent', 'no-member', instance, '私聊没有成员列表')
          return await call('get_group_member_list', { group_id: Number(id) }, { timeoutMs: 20000 })
        }
        case 'chats': {
          const groups = await call('get_group_list', {}, { timeoutMs: 15000 }).catch(() => [])
          const friends = await call('get_friend_list', {}, { timeoutMs: 15000 }).catch(() => [])
          return { groups: Array.isArray(groups) ? groups : [], friends: Array.isArray(friends) ? friends : [] }
        }
        default:
          throw makeSendError('not-sent', 'bad-fetch-kind', instance, `认不出的 fetch 类型：${String(request.kind)}`)
      }
    } catch (error) {
      if (error?.certainty === 'not-sent' || error?.certainty === 'unknown') throw error
      throw toSendError(error, { instance, isDefiniteFailure })
    }
  }

  // ───────────────────────── PlatformAdapter ─────────────────────────

  const native = createNative({
    probeState: () => probeState,
    call: (action, params, opts) => {
      if (!client) return Promise.reject(makeSendError('not-sent', 'offline', instance, 'QQ 网关客户端还没建'))
      return call(action, params, opts)
    },
    instance: () => instance,
    log: log(),
  })

  const adapter = {
    id,
    name: 'QQ',

    contract: 1,

    /** 能力表。探测前是最保守的那一版；探测完会换成探测结果（并调过 ctx.capsChanged）。 */
    caps() {
      return { ...caps }
    },

    /** 面板表单。字段与契约 InstanceConfig 的约定一致：平台专属配置由平台端自己声明。 */
    settings: [
      { key: 'backend', label: '接入方式', type: 'select', options: [{ value: 'snowluma', label: 'SnowLuma（插件帮你启停本机网关，仅 Windows）' }, { value: 'onebot', label: '已有 OneBot 网关（NapCat / LLOneBot / 自己部署的）' }], default: 'onebot', description: 'snowluma 会替你启动、注入、核对机器人号；onebot 只按下面填的地址连，不碰本机进程' },
      { key: 'wsUrl', label: 'WebSocket 地址', type: 'text', default: '', placeholder: 'ws://127.0.0.1:3001', description: 'OneBot v11 正向 WS（Universal 模式）。留空时若接了 SnowLuma 就自动从它的配置里读' },
      { key: 'httpUrl', label: 'HTTP 地址', type: 'text', default: '', placeholder: 'http://127.0.0.1:3000', description: '留着也能用：WS 没连上时走 HTTP 调动作' },
      { key: 'token', label: '访问令牌', type: 'password', default: '', description: '对方设了 access_token 就填，没设留空（WS 和 HTTP 共用）' },
      { key: 'snowlumaManaged', label: '由插件管理 SnowLuma', type: 'switch', default: false, description: '只在 Windows + backend=snowluma 时生效：替你启停本机的 SnowLuma，并只给机器人号注入' },
      { key: 'snowlumaDir', label: 'SnowLuma 目录', type: 'text', default: '', placeholder: 'C:\\Aurabot\\snowluma', description: '主人自己下载解压的那一份（插件不下载、不解压、不替你同意协议）' },
    ],

    async start(context) {
      if (running) return
      ctx = context
      instance = String(ctx.instance || id)
      running = true
      ctx.state('connecting')

      const cfg = config()

      // ── 0. SnowLuma 子模块：只在这个实例显式选了 snowluma 后端时才建 ──
      const want = snowlumaEnabled({
        backend: cfg.backend,
        snowlumaManaged: cfg.snowlumaManaged,
        snowlumaDir: cfg.snowlumaDir ?? cfg.dir,
      })
      // snowlumaManaged=false 时完全不碰本机进程（用户自己开着 SnowLuma，我们只连它的端点）
      if (want.enabled && cfg.snowlumaManaged === true) {
        try {
          sidecar = createSnowlumaSidecar({
            config,
            account: () => selfId || String(cfg.selfId || cfg.account || ''),
            log: log(),
            savePassword: typeof cfg.savePassword === 'function' ? cfg.savePassword : undefined,
            managerFactory: options.managerFactory,
          })
          const r = await sidecar.start()
          if (r && r.ok === false) {
            // 启动不了不是致命错：用户可能已经把 SnowLuma 开着，照样去连它的端点
            log().warn?.('SnowLuma 没能替你启动：', r.message || '未知原因')
            ctx.state('connecting', `SnowLuma：${r.message || '启动失败'}，继续尝试连接已有网关`)
          } else if (r?.message) {
            log().info?.(`SnowLuma：${r.message}`)
          }
          if (cfg.autoAttach !== false) {
            const a = await sidecar.attachBot()
            if (a?.message) log().info?.(`SnowLuma 注入：${a.message}`)
          }
        } catch (error) {
          log().warn?.('SnowLuma 子模块出错（继续按纯 OneBot 连接）：', error?.message || error)
          sidecar = null
        }
      } else if (String(cfg.backend || '') === 'snowluma' && want.reason) {
        log().debug?.(`不启用 SnowLuma 管理：${want.reason}`)
      }

      // ── 1. 读 caps 缓存（先用缓存再后台复探）──
      loadCapsCache()

      // ── 2. 建客户端并连 ──
      if (!client) client = makeClient()
      // 注入的 client（测试替身 / 宿主自带的 OneBot 客户端）不会走 makeClient 里的 onState 接线，
      // 这里补一次：有 on() 就订阅状态与事件。不订阅的话，注入客户端永远报不出 connected，
      // 也推不出入站事件（历史上就是这么漏的：start 之后一直卡在 connecting）。
      bindClient()
      if (typeof client.start === 'function') client.start()

      // ② 连不上时不能假装连上：等一次连接结果（adapter-kit 要求 start 后状态到 connected）
      const ok = await waitConnected(client, Number(cfg.connectTimeoutMs) || 5000)
      if (!ok) {
        // 没有地址 / 对面没起：按「未连接」报，不抛错（网关会记成断线，之后自动重连）
        ctx.state('unconfigured', endpoint().wsUrl || endpoint().httpUrl ? 'QQ 网关暂时连不上（会自动重连）' : '还没配置 OneBot 地址')
        return
      }
      // 连上后的状态由 onClientState 报（它会触发 afterConnect：whoami + 探测）
    },

    async stop() {
      if (!running) return
      running = false
      connected = false
      if (typeof unbindClient === 'function') { try { unbindClient() } catch (error) {} unbindClient = null }
      try { client?.stop?.() } catch (error) { log().debug?.('停 OneBot 客户端出错：', error?.message || error) }
      if (sidecar) {
        try { sidecar.dispose?.() } catch (error) { log().debug?.('停 SnowLuma 出错：', error?.message || error) }
        sidecar = null
      }
      ctx?.state('stopped')
      // 停了之后绝不能再 emit：onClientEvent 里有 running 守卫，这里再把 ctx 留着给状态用
    },

    async whoami() {
      if (!client) throw makeSendError('not-sent', 'offline', instance, 'QQ 网关未连接')
      try {
        const info = await call('get_login_info', {}, { timeoutMs: 10000, retries: 0 })
        const account = String(info?.user_id ?? info?.uin ?? '')
        const name = String(info?.nickname ?? info?.name ?? account)
        if (account) selfId = account
        return { account, name }
      } catch (error) {
        throw toSendError(error, { instance, isDefiniteFailure })
      }
    },

    send,

    fetch,

    native,

    /** 旧接口 sendSegments 的兼容口：OneBot 消息段 → parts（入站翻译用同一个函数）。 */
    toParts(nativeMessage) {
      return partsOf(nativeMessage, { selfId, faceName: options.faceName })
    },

    // ───────────── 测试 / 面板用的控制面（真实网关不会调）─────────────

    /** 当前探测状态（面板显示「当前网关不支持 X」用）。 */
    probeInfo() {
      return {
        probed: Boolean(probeState?.probed),
        entries: probeState?.entries || {},
        supported: [...(probeState?.supported || [])],
        unknown: probeState?.unknown || [],
        fromCache: Boolean(probeCache && probeState?.probedAt === probeCache.probedAt && !probeState?.entries),
      }
    },

    /** 手动重探（面板上的「重新探测」）。 */
    async reprobe() {
      probeCache = null
      return runProbe({ reason: 'manual' })
    },

    /** 测试用：直接拿到客户端对象（不经过平台端）。 */
    get __client() { return client },
    /** 测试用：把一条 OneBot 事件送进来（等价于 WS 推一条）。 */
    __push(event) { onClientEvent(event) },
    /** 测试用：模拟客户端状态变化。 */
    __state(state, detail) { onClientState(state, detail) },
    /**
     * 测试用：临时改 caps 并通知网关（等价于「探测结果变了」或「配置把能力关小了」）。
     * adapter-kit 的 setProactive 需要它。
     */
    __setCapsForTest(partial = {}) {
      caps = { ...caps, ...(partial || {}) }
      try { ctx?.capsChanged?.() } catch {}
      return { ...caps }
    },
  }

  return adapter
}

const noopLog = { debug() {}, info() {}, warn() {}, error() {} }

/** 等客户端连上（连不上就返回 false，由调用方按「未连接」处理）。 */
function waitConnected(client, timeoutMs) {
  if (!client) return Promise.resolve(false)
  if (typeof client.isConnected === 'function' && client.isConnected()) return Promise.resolve(true)
  if (typeof client.state === 'function' ? client.state() === 'connected' : client.state === 'connected') return Promise.resolve(true)
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = () => {
      const now = typeof client.isConnected === 'function' ? client.isConnected() : client.state === 'connected'
      if (now) return resolve(true)
      if (Date.now() - started >= timeoutMs) return resolve(false)
      setTimeout(tick, 25).unref?.()
    }
    tick()
  })
}

/** 默认导出一个预配置实例（网关 register 时用工厂包一层：() => createQqAdapter()）。 */
export default createQqAdapter()

export { createQqAdapter as createAdapter }
export { FILE_MAX_BYTES, CAPS_CONSERVATIVE }
