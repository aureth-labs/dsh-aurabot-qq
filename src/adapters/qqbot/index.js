// 平台端：QQ 官方机器人开放平台（q.qq.com / api.bot.qq.com，API v2）。
//
// 来源：F3 工作包（Aurabot 多平台化）。许可：MIT（随本仓库）。
// 契约：src/gateway/contracts.d.ts（唯一权威）＋ docs/CONTRACTS.md 第六～八节。
// 文档核对结果与能力差距评估见 docs/ADAPTER-QQBOT.md（含每条结论的官方链接）。
//
// 这个平台端只做翻译：
//   平台事件（payload op=0 dispatch）→ AdapterInbound
//   网关给的 parts → /v2/users|groups/{openid}/messages
//
// 三条硬规则写在最前面，改代码时别绕过：
//   1. 被动回复靠 msg_id（或 event_id）当凭证，它就装在 message.inResponseTo 里。
//      没有 inResponseTo 就是主动消息——本平台主动能力已收敛，默认直接拒绝。
//   2. 一条入站消息能回几条、多久之内能回，平台有硬限制（群聊 5 分钟，单聊 60 分钟）；
//      超时或超频的发出去平台一定拒，所以平台端自己先拦（网关也会拦一道，这是双保险）。
//   3. Webhook 回调必须验签（Ed25519，X-Signature-Ed25519），验不过一律拒绝且不 emit。
//
// 设计约束（任务书）：不加 npm 依赖。因此
//   - HTTP 用内置 fetch（Node >= 22）；
//   - Ed25519 用 node:crypto；
//   - WebSocket 事件订阅内置实现需要 ws 客户端，本包不引依赖，改为「宿主注入事件源」
//     （见 start() 里的 transport='websocket' 分支），默认走 Webhook。
//
// ── 测试注入点 ──
// createQqbotAdapter({ client, now })：client 是可注入的假客户端，形状见 createHttpClient。
// adapter.platform 是测试后门（deliver / break / refuseNext / hangNext / setProactive …），
// 与 _template、fake-adapter 同名同语义，供 test/contract/adapter-kit.js 的 harness 使用。

import { createPrivateKey, createPublicKey, sign as ed25519Sign, verify as ed25519Verify } from 'node:crypto'

// ───────────────────────── 平台常量（均来自官方文档，见 ADAPTER-QQBOT.md） ─────────────────────────

/** 统一接口域名（2026-08-10 变更记录：所有接口域名统一为 api.bot.qq.com） */
export const API_BASE = 'https://api.bot.qq.com'

/** 获取 access_token 的路径（POST，body: { appId, clientSecret }） */
export const PATH_TOKEN = '/app/getAppAccessToken'

/** access_token 有效期默认 7200 秒；官方允许在过期前 60 秒内拿到新 token */
export const TOKEN_TTL_MS = 7200 * 1000
export const TOKEN_REFRESH_AHEAD_MS = 60 * 1000

/**
 * 被动回复时限（毫秒）。
 * 官方两张表口径不同：单聊 60 分钟、群聊 5 分钟。caps.replyWindowMs 是全平台一个值，
 * 因此取**较严**的群聊值，宁可早一点把超窗回复判成主动消息。
 */
export const REPLY_WINDOW_MS = 5 * 60 * 1000

/**
 * 一条入站消息最多能回几条。
 * 官方两处口径不同：单聊 4 次（消息收发概述）或 5 次（send.md），群聊 5 次。
 * caps.repliesPerMessage 同样只有一个值，取较严的 4。
 */
export const REPLIES_PER_MESSAGE = 4

/** 富媒体 file_type：1 图片 / 2 视频 / 3 语音 / 4 文件 */
const FILE_TYPE = { image: 1, video: 2, voice: 3, file: 4 }

/** 参数名与官方文档保持一致，写错会被平台当主动消息处理 */
const MAX_FILE_BYTES = 200 * 1024 * 1024 // 富媒体硬限制 200MB（文档「文件类型与限制」）
const DEFAULT_TIMEOUT_MS = 8000 // 官方建议调用发消息接口 timeout ≥ 5 秒

// Ed25519 从 32 字节 seed 造私钥需要的 PKCS#8 前缀（RFC 8410）
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

// ───────────────────────── 错误分类 ─────────────────────────

/**
 * 造一个 SendError。契约要求：certainty='not-sent'（确定没发出去，可入队重试）或
 * 'unknown'（超时、连接中途断开、读不懂响应，一律不重发）。拿不准必须填 'unknown'。
 * 网关的 errors.js 还没实现（G1 的活），这里先用普通 Error 挂字段，形状与契约一致。
 */
function sendError(certainty, code, instance, message) {
  const error = new Error(message || `发送失败（${certainty}${code ? ' / ' + code : ''}）`)
  error.certainty = certainty
  if (code) error.code = code
  error.instance = instance
  return error
}

/** 客户端层的三种失败：连不上（未发出）/ 超时（不知道发没发）/ 响应读不懂 */
export class NetworkError extends Error {
  constructor(cause) { super(String(cause?.message || cause)); this.name = 'NetworkError'; this.cause = cause }
}
export class TimeoutError extends Error {
  constructor(ms) { super(`请求 ${ms}ms 内没有响应`); this.name = 'TimeoutError' }
}

/** 注入的假客户端可能抛别处的同类错误，按名字也认一下 */
const isTimeoutError = (error) => error instanceof TimeoutError || error?.name === 'TimeoutError' || error?.name === 'AbortError'
const isNetworkError = (error) => error instanceof NetworkError || error?.name === 'NetworkError'

/** 这些底层错误码说明「连都没连上」，可以确定没发出去 */
const CONNECT_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ERR_INVALID_URL'])

// ───────────────────────── HTTP 客户端（默认真实实现，测试注入假的） ─────────────────────────

/**
 * 最小 HTTP 客户端。真实实现只用内置 fetch，不引依赖。
 * 返回 { status, data }（data 为解析后的 JSON，解析不了就是 null）；
 * 连不上抛 NetworkError，超时抛 TimeoutError，交给上层做 certainty 分类。
 */
export function createHttpClient({ baseUrl = API_BASE, fetchImpl = globalThis.fetch } = {}) {
  return {
    /**
     * @param {{method?: string, path: string, body?: any, headers?: Record<string,string>, timeoutMs?: number, query?: Record<string, string|number>}} req
     */
    async request(req = {}) {
      if (typeof fetchImpl !== 'function') throw new NetworkError(new Error('运行环境没有 fetch（需要 Node >= 22）'))
      let url = String(req.path || '').startsWith('http') ? String(req.path) : baseUrl + String(req.path || '')
      if (req.query) {
        const qs = new URLSearchParams()
        for (const [k, v] of Object.entries(req.query)) if (v != null) qs.set(k, String(v))
        const s = qs.toString()
        if (s) url += (url.includes('?') ? '&' : '?') + s
      }
      const timeoutMs = Math.max(1, Number(req.timeoutMs) || DEFAULT_TIMEOUT_MS)
      const controller = new AbortController()
      let timedOut = false
      let timer
      // 用 Promise.race 兜底：真实 fetch 会响应 abort，但注入的假客户端可能不会，
      // 而「到点就抛、别傻等」是契约对平台端的硬要求（ADAPTER.md 错误分类）。
      const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new TimeoutError(timeoutMs)) }, timeoutMs)
      })
      try {
        const response = await Promise.race([
          fetchImpl(url, {
            method: req.method || 'GET',
            headers: { 'Content-Type': 'application/json', ...(req.headers || {}) },
            body: req.body === undefined ? undefined : JSON.stringify(req.body),
            signal: controller.signal,
          }),
          timeout,
        ])
        const text = await Promise.race([response.text().catch(() => ''), timeout])
        let data = null
        if (text) { try { data = JSON.parse(text) } catch { data = null } }
        return { status: response.status, headers: response.headers, data, text }
      } catch (error) {
        // 自己 abort 的 → 超时（不知道平台收没收到，上层按 unknown）
        if (timedOut || error?.name === 'TimeoutError' || error?.name === 'AbortError' || controller.signal.aborted) throw new TimeoutError(timeoutMs)
        throw new NetworkError(error)
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

// ───────────────────────── Ed25519（Webhook 验签 / 回调地址验证） ─────────────────────────

/**
 * 官方签名算法：把 Bot Secret 反复翻倍到 32 字节当 seed，用它生成 Ed25519 密钥对。
 * 验签用公钥验 timestamp+body；回调地址验证（op=13）用私钥签 event_ts+plain_token。
 */
export function deriveEd25519(botSecret) {
  let seed = Buffer.from(String(botSecret || ''), 'utf8')
  if (!seed.length) return null
  while (seed.length < 32) seed = Buffer.concat([seed, seed])
  seed = seed.subarray(0, 32)
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' })
  const publicKey = createPublicKey(privateKey)
  return { privateKey, publicKey }
}

/** 校验一次回调：signature 是 X-Signature-Ed25519（hex），msg 是 timestamp + 原始 body */
export function verifySignature(keys, signatureHex, timestamp, rawBody) {
  if (!keys || !signatureHex || !timestamp) return false
  let signature
  try { signature = Buffer.from(String(signatureHex), 'hex') } catch { return false }
  if (signature.length !== 64) return false // Ed25519 签名固定 64 字节
  if ((signature[63] & 224) !== 0) return false // 官方示例里的同一道检查
  const msg = Buffer.concat([Buffer.from(String(timestamp), 'utf8'), Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || '', 'utf8')])
  try { return ed25519Verify(null, msg, keys.publicKey, signature) } catch { return false }
}

/** 回调地址验证的应答签名：Ed25519(event_ts + plain_token)，hex 小写 */
export function signValidation(keys, eventTs, plainToken) {
  const msg = Buffer.concat([Buffer.from(String(eventTs ?? ''), 'utf8'), Buffer.from(String(plainToken ?? ''), 'utf8')])
  return ed25519Sign(null, msg, keys.privateKey).toString('hex')
}

// ───────────────────────── 平台原生事件 → parts ─────────────────────────

/** 从 message_scene.ext（形如 ['msg_idx=...', 'auth_token=...']）里取键值 */
function sceneExt(scene, key) {
  const list = Array.isArray(scene?.ext) ? scene.ext : []
  for (const item of list) {
    const s = String(item || '')
    const i = s.indexOf('=')
    if (i > 0 && s.slice(0, i) === key) return s.slice(i + 1)
  }
  return undefined
}

/** 附件 → Part。content_type 见官方 MessageAttachment 表 */
function attachmentToPart(att) {
  const mime = String(att?.content_type || '')
  const media = {
    url: att?.url ? String(att.url) : undefined,
    mime: mime || undefined,
    size: Number.isFinite(att?.size) ? Number(att.size) : undefined,
    width: Number.isFinite(att?.width) ? Number(att.width) : undefined,
    height: Number.isFinite(att?.height) ? Number(att.height) : undefined,
    name: att?.filename ? String(att.filename) : undefined,
  }
  if (mime === 'voice') {
    // 语音给的是转换后的 WAV；durationMs 官方不给，别编
    if (att?.voice_wav_url) media.url = String(att.voice_wav_url)
    return { type: 'voice', media }
  }
  if (mime.startsWith('image/')) return { type: 'image', media }
  if (mime.startsWith('video/')) return { type: 'video', media }
  if (mime === 'file') return { type: 'file', media }
  // 认不出的附件：按文件占位，不丢信息（CONTRACTS 六.1：认不出的用 other 占位，不猜）
  return { type: 'other', text: `[附件${mime ? ' ' + mime : ''}]`, native: att }
}

/** ark_data（结构化卡片）→ card Part */
function arkToPart(ark) {
  const fields = ark?.fields && typeof ark.fields === 'object' ? ark.fields : {}
  const title = fields.title ? String(fields.title) : String(ark?.ark_name || '')
  const url = fields.jump_url ? String(fields.jump_url) : undefined
  const desc = fields.desc ? String(fields.desc) : (ark?.prompt ? String(ark.prompt) : '')
  const text = [title, desc].filter(Boolean).join(' ')
  return { type: 'card', text: text || '[卡片消息]', title: title || undefined, url, from: fields.source ? String(fields.source) : undefined }
}

/**
 * 把官方事件体的 content/mentions/attachments/ark_data/msg_elements 翻成 parts。
 * 群全量模式下 @ 成员会被换成 `<@openid>`、@全体换成 `<@all>`，这里拆成 mention Part；
 * @机器人自己 不进 parts，体现在 mentionedMe（CONTRACTS §三 Part 注释）。
 */
function eventToParts(d, { selfOpenid } = {}) {
  const parts = []
  let content = typeof d?.content === 'string' ? d.content : ''
  let mentionedMe = false

  // 1) 文本里的 @ 标记（全量模式才有；群@事件里 content 已去掉 @机器人 前缀）
  if (content.includes('<@')) {
    const tokenRe = /<@(all|[0-9A-Za-z_-]+)>/g
    let last = 0
    for (let m = tokenRe.exec(content); m; m = tokenRe.exec(content)) {
      const before = content.slice(last, m.index)
      if (before) parts.push({ type: 'text', text: before })
      const who = m[1]
      if (who === 'all') {
        parts.push({ type: 'mention', account: 'all' })
      } else if (selfOpenid && who === selfOpenid) {
        // @ 的是机器人自己：不进 parts，只标 mentionedMe
        mentionedMe = true
      } else {
        const name = Array.isArray(d?.mentions) ? d.mentions.find((u) => u && (u.id === who || u.member_openid === who || u.user_openid === who))?.username : undefined
        parts.push({ type: 'mention', account: who, name: name ? String(name) : undefined })
      }
      last = m.index + m[0].length
    }
    const tail = content.slice(last)
    if (tail) parts.push({ type: 'text', text: tail })
    content = ''
  }
  if (content) parts.push({ type: 'text', text: content })

  // 2) 附件（图片/视频/语音/文件）
  for (const att of Array.isArray(d?.attachments) ? d.attachments : []) parts.push(attachmentToPart(att))

  // 3) 结构化卡片
  if (Array.isArray(d?.attachments) === false && d?.ark_data) parts.push(arkToPart(d.ark_data))

  // 4) 引用消息（message_type=103）：把被引用的正文单独标出来，不假装是这次说的话
  for (const el of Array.isArray(d?.msg_elements) ? d.msg_elements : []) {
    if (el?.message_type === 103 && el?.content) {
      parts.push({ type: 'other', text: `[引用 ${String(el.content).slice(0, 120)}]`, native: { kind: 'quote', content: el.content } })
    } else if (el?.content && String(el.message_type) !== '0') {
      parts.push({ type: 'other', text: String(el.content), native: el })
    }
  }
  return { parts, mentionedMe }
}

// ───────────────────────── 平台端 ─────────────────────────

/**
 * 建一个 QQ 官方机器人平台端。
 * options：
 *   id            平台名（默认 'qqbot'）
 *   name          显示名
 *   client        注入的 HTTP 客户端（测试用假客户端）；缺省 createHttpClient()
 *   now           时钟（测试注入以验证 token 过期刷新）
 *   connectEvents 可选：(onEvent) => stopFn，宿主注入的 WebSocket 事件源（transport='websocket' 时必需）
 */
export function createQqbotAdapter(options = {}) {
  const id = options.id || 'qqbot'
  const instance = id
  const now = typeof options.now === 'function' ? options.now : Date.now
  const client = options.client || createHttpClient()
  const connectEvents = typeof options.connectEvents === 'function' ? options.connectEvents : null
  // 适配实例自带一份默认配置（config(). 里没有的键用它兜底）。网关正常运行时配置来自
  // ctx.config()；这份兜底一是给通用契约测试包（它的 ctx.config() 返回 {}）用，
  // 二是给「面板还没填、先用环境里已有的值」这种场景用。
  const defaultConfig = { ...(options.defaultConfig || {}) }

  let ctx = null
  let running = false
  let connected = false
  let offs = [] // route 撤掉函数、事件源 stop
  let keys = null // Ed25519 密钥对（有 botSecret 时才有）
  let token = { value: '', expiresAt: 0 } // token 缓存（自动刷新）
  let self = { account: '', name: '' } // whoami 结果（READY / GET /users/@me）
  let capsOverride = null // 用户配置或探测结果叠在默认 caps 上
  let transport = 'webhook'

  // 被动回复记账
  const seenAt = new Map() // inResponseTo(messageId) → 入站时间
  const msgSeq = new Map() // `${kind}\u0000${chatId}\u0000${inResponseTo}` → 已用 msg_seq
  const replyCount = new Map() // 同上 → 已发条数（repliesPerMessage 用）
  const proactiveCount = new Map() // `${yyyymmdd}\u0000${kind}\u0000${chatId}` → 当日主动条数
  // 测试故障注入
  let failSend = null

  // ───── 能力表 ─────
  // 说真话：这个平台的能力被平台策略卡得很死，宁可报小不报大（CONTRACTS §八.1）。
  const baseCaps = () => ({
    image: true, // 富媒体 file_type=1，支持 png/jpg/gif/webp/bmp
    sticker: false, // 平台没有「表情包消息」，让网关降级成图片
    voice: 'file', // 语音条要 silk + file_type=3，本包只保证「当音频文件发」（file_type=4）
    video: true, // file_type=2，仅 mp4
    file: true, // file_type=4，任意格式
    maxFileBytes: MAX_FILE_BYTES,
    quoteReply: false, // message_reference 官方标注「暂未支持」
    mention: true, // 文本里可写 <@openid>
    mentionAll: false, // <qqbot-at-everyone /> 要求机器人是该群管理员且每群每天 1 次，默认关
    poke: false, // 平台无戳一戳
    typing: false, // 平台无 typing
    recall: true, // 撤回自己的消息，2 分钟内有效
    card: false, // 出站 ark 卡片未实现
    listenAllInGroup: false, // 只有群主开了「接收全量消息」才收得到，默认按收不到报
    proactive: 'limited', // 主动消息能力已收敛：有额度、有总开关，用户/群主可关闭
    replyWindowMs: REPLY_WINDOW_MS, // 群聊 5 分钟（单聊 60 分钟），取严
    repliesPerMessage: REPLIES_PER_MESSAGE, // 单聊 4 次 / 群聊 5 次，取严
    history: false,
    memberList: false, // 官方有群成员列表接口（2026-09-03），本包未实现，不撒谎
    forwardExpand: false,
  })

  const caps = () => ({ ...baseCaps(), ...(capsOverride || {}) })

  // ───── access_token ─────
  const cfgOf = () => {
    const fromCtx = typeof ctx?.config === 'function' ? ctx.config() || {} : {}
    return { ...defaultConfig, ...fromCtx }
  }

  /** 拿一个可用 token：有效期内复用，过期前 60 秒主动换新（官方：过期前 60 秒内会发新 token） */
  async function ensureToken({ force = false } = {}) {
    const cfg = cfgOf()
    const appId = cfg.appId || cfg.appid
    const secret = cfg.clientSecret || cfg.appSecret || cfg.secret
    if (!appId || !secret) throw sendError('not-sent', 'no-credentials', instance, '缺少 appId / clientSecret')
    if (!force && token.value && now() < token.expiresAt - TOKEN_REFRESH_AHEAD_MS) return token.value
    const res = await client.request({
      method: 'POST',
      path: PATH_TOKEN,
      body: { appId: String(appId), clientSecret: String(secret) },
      timeoutMs: Math.max(1, Number(cfg.tokenTimeoutMs) || DEFAULT_TIMEOUT_MS),
    })
    const data = res?.data || {}
    // 这个接口失败时 HTTP 仍是 200，必须看响应体的 code（官方「注意」）
    if (!data.access_token) {
      const code = data.code != null ? `token-${data.code}` : 'token-failed'
      // 100001 太频繁、100007/100016 是凭证错：都算「确定没发出」，可重试/等运维修
      throw sendError('not-sent', code, instance, `获取 access_token 失败：${data.message || res?.status}`)
    }
    const ttl = Math.max(60, Number(data.expires_in) || TOKEN_TTL_MS / 1000) * 1000
    token = { value: String(data.access_token), expiresAt: now() + ttl }
    return token.value
  }

  /** 带 token 调接口；401/403 时强制换一次 token 再试（token 过期是最常见的失败） */
  async function authedRequest({ path, method = 'POST', body, query, timeoutMs, retried = false }) {
    const accessToken = await ensureToken({ force: retried })
    const res = await client.request({
      path, method, body, query,
      headers: { Authorization: `QQBot ${accessToken}` },
      timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
    })
    if ((res?.status === 401 || res?.status === 403) && !retried) {
      token = { value: '', expiresAt: 0 }
      return authedRequest({ path, method, body, query, timeoutMs, retried: true })
    }
    return res
  }

  // ───── 出站：parts → 平台消息 ─────
  /** 一个 Part → 文本片段（平台侧只认纯文本 + <@openid> 标记） */
  function partToText(part) {
    switch (part?.type) {
      case 'text': return String(part.text ?? '')
      case 'mention': return part.account === 'all' ? '<qqbot-at-everyone />' : `<@${part.account}>`
      case 'face': return `[${part.name || '表情'}]`
      case 'card': return [part.text, part.url].filter(Boolean).join(' ')
      case 'other': return String(part.text ?? '')
      default: return ''
    }
  }

  /**
   * 把 parts 切成若干条平台消息。
   * 文本类连续聚合成一条（msg_type=0）；每个媒体单独一条（msg_type=7，一条只能带一个 media）。
   * 顺序保持：遇到媒体先把前面的文本吐出去。
   */
  function buildMessages(parts) {
    const out = []
    let buffer = ''
    const flushText = () => {
      const text = buffer.trim()
      buffer = ''
      if (text) out.push({ msg_type: 0, content: text })
    }
    for (const part of parts || []) {
      switch (part?.type) {
        case 'image':
        case 'sticker':
          buffer += ''
          flushText()
          out.push({ media: part.media, file_type: FILE_TYPE.image, placeholder: '[图片]' })
          break
        case 'video':
          flushText()
          out.push({ media: part.media, file_type: FILE_TYPE.video, placeholder: '[视频]' })
          break
        case 'voice':
          flushText()
          out.push({ media: part.media, file_type: FILE_TYPE.voice, placeholder: '[语音]' })
          break
        case 'file':
          flushText()
          out.push({ media: part.media, file_type: FILE_TYPE.file, placeholder: '[文件]' })
          break
        case 'poke':
        case 'forward':
          // 平台没有这些东西（caps 里已声明不支持，网关会先降级掉），真来了就跳过
          break
        default:
          buffer += partToText(part)
      }
    }
    flushText()
    return out
  }

  /** 媒体先上传拿 file_info（单聊/群聊上传接口不互通，必须按场景选） */
  async function uploadMedia(kind, chatId, item, timeoutMs) {
    const media = item.media || {}
    if (!media.url) {
      // 平台只支持「URL 上传」和「分片上传」。分片上传本包未实现，
      // 而 path/bytes 没有公网 URL 可用 → 明确告诉上层没发出去。
      throw sendError('not-sent', 'media-url-required', instance, '该平台只支持以公网 URL 上传富媒体')
    }
    if (Number(media.size) > MAX_FILE_BYTES) {
      throw sendError('not-sent', 'too-large', instance, `文件超过 ${MAX_FILE_BYTES} 字节`)
    }
    const path = kind === 'group'
      ? `/v2/groups/${encodeURIComponent(chatId)}/files`
      : `/v2/users/${encodeURIComponent(chatId)}/files`
    // 群聊上传接口的 body 字段官方写作 file_type + url（与单聊一致）；srv_send_msg 关掉，
    // 否则会「上传即发送」并额外吃掉一次主动消息额度。
    const res = await authedRequest({ path, body: { file_type: item.file_type, url: String(media.url), srv_send_msg: false }, timeoutMs })
    const data = res?.data || {}
    // 上传响应字段官方文档示例未给全，这里宽容取（见 ADAPTER-QQBOT.md「未确认点」）
    const fileInfo = data.file_info || data.fileInfo || data.file_uuid || (data.data && (data.data.file_info || data.data.file_uuid))
    if (!fileInfo) {
      const code = data.code != null ? `upload-${data.code}` : `upload-http-${res?.status ?? 'unknown'}`
      throw sendError('not-sent', code, instance, '富媒体上传失败：' + (data.message || '未返回 file_info'))
    }
    return String(fileInfo)
  }

  /** 按错误分类表把一次 HTTP 结果变成 SendError（拿不准必须 unknown） */
  function classifyFailure(res, fallbackCode) {
    const data = res?.data || {}
    const code = data.code != null ? String(data.code) : (data.errcode != null ? String(data.errcode) : '')
    // 22009 msg limit exceed：被动回复超频（同一 msg_id 回太多条）
    if (code === '22009') return sendError('not-sent', 'proactive-limit', instance, '平台限流：消息发送超频')
    // 304082 / 304083：富媒体资源拉取失败（我们给的 URL 平台下不到）
    if (code === '304082' || code === '304083') return sendError('not-sent', 'media-fetch-failed', instance, '平台拉取富媒体失败')
    if (res?.status === 401 || res?.status === 403) return sendError('not-sent', code || 'unauthorized', instance, '鉴权失败或无权限')
    if (res?.status >= 400 && res.status < 500) return sendError('not-sent', code || `http-${res.status}`, instance, `平台拒绝：${data.message || res.status}`)
    // 5xx / 响应读不懂：不知道平台到底处理没处理，按 unknown（绝不重发）
    return sendError('unknown', code || fallbackCode || `http-${res?.status ?? 'unreadable'}`, instance, `响应不明：${data.message || res?.status || '读不懂'}`)
  }

  async function callSend(kind, chatId, payload, { timeoutMs, inResponseTo, replyAs } = {}) {
    const path = kind === 'group'
      ? `/v2/groups/${encodeURIComponent(chatId)}/messages`
      : `/v2/users/${encodeURIComponent(chatId)}/messages`
    const body = { ...payload }
    if (inResponseTo) {
      // 被动回复凭证：msg_id（回复用户消息）或 event_id（回复事件）
      if (replyAs === 'event_id') body.event_id = inResponseTo
      else body.msg_id = inResponseTo
      // 同一个 msg_id 多次回复必须递增 msg_seq，重复的 msg_id+msg_seq 会失败（官方去重规则）
      const key = `${kind}\u0000${chatId}\u0000${inResponseTo}`
      const seq = (msgSeq.get(key) || 0) + 1
      msgSeq.set(key, seq)
      body.msg_seq = seq
    }
    // msg_type=7 时 content 仍需给一个值（官方「常见错误码」提示），填一个空格
    if (body.msg_type === 7 && !body.content) body.content = ' '

    let res
    try {
      res = await authedRequest({ path, method: 'POST', body, timeoutMs })
    } catch (error) {
      if (error?.certainty) throw error
      if (isTimeoutError(error)) throw sendError('unknown', 'timeout', instance, `平台 ${timeoutMs || DEFAULT_TIMEOUT_MS}ms 内没有响应`)
      if (isNetworkError(error)) {
        const raw = error.cause || error
        const code = String(raw?.code || raw?.cause?.code || '')
        // 连都没连上 → 确定没发出去；连接中途断开 → 不知道，按 unknown
        if (CONNECT_ERROR_CODES.has(code)) throw sendError('not-sent', 'network', instance, '连不上平台接口')
        throw sendError('unknown', 'network-unknown', instance, '请求过程中连接断开')
      }
      throw sendError('unknown', 'send-failed', instance, String(error?.message || error))
    }
    const data = res?.data || {}
    if (res && res.status >= 200 && res.status < 300 && (data.id || data.message_id)) {
      return { messageId: String(data.id || data.message_id) }
    }
    // 有些实现成功但没给 id：只要 2xx 就当发成功（但 id 用本地生成，不能空）
    if (res && res.status >= 200 && res.status < 300 && !data.code && !data.errcode) {
      return { messageId: `qqbot-${now()}-${Math.random().toString(36).slice(2, 8)}` }
    }
    throw classifyFailure(res, 'send-failed')
  }

  // ───── 入站：事件体 → AdapterInbound ─────

  /**
   * 把一个平台事件（payload.t + payload.d）翻成 AdapterInbound。
   * 只翻译，不查身份、不拼给模型看的文字、不判断回不回。
   */
  function translate(t, d) {
    const selfOpenid = self.account || cfgOf().selfOpenid || ''
    let chatKind, chatId, senderAccount, senderName, senderRole, senderAlt
    let mentionedMe = false
    let parts = []
    let replyTo

    if (t === 'C2C_MESSAGE_CREATE') {
      chatKind = 'private'
      chatId = String(d?.author?.user_openid || d?.author?.id || '')
      senderAccount = chatId
      senderName = String(d?.author?.username || '')
      senderRole = '' // 私聊没有群身份
      senderAlt = d?.author?.union_openid ? String(d.author.union_openid) : undefined
      mentionedMe = true // 单聊天然「就是在跟她说话」
      const r = eventToParts(d, { selfOpenid })
      parts = r.parts
      mentionedMe = true
    } else if (t === 'GROUP_AT_MESSAGE_CREATE' || t === 'GROUP_MESSAGE_CREATE') {
      chatKind = 'group'
      chatId = String(d?.group_openid || '')
      senderAccount = String(d?.author?.member_openid || d?.author?.id || '')
      senderName = String(d?.author?.username || '')
      // 群内角色：member=普通成员 admin=管理员 owner=群主（官方 member_role）
      const role = String(d?.author?.member_role || '')
      senderRole = role === 'owner' || role === 'admin' || role === 'member' ? role : 'member'
      senderAlt = d?.author?.union_openid ? String(d.author.union_openid) : undefined
      const r = eventToParts(d, { selfOpenid })
      parts = r.parts
      // 群@事件天生就是 @ 了她；全量模式要看 content 里有没有 <@机器人>，没有就当她没被叫
      mentionedMe = t === 'GROUP_AT_MESSAGE_CREATE' ? true : r.mentionedMe
      // 引用索引（ref_msg_idx）不是 messageId，映射不了就不假装能引用
      replyTo = undefined
    } else {
      return null
    }

    if (!chatId || !senderAccount) return null

    // 发送时间：官方是 RFC3339 字符串；解析不了才退回本地时钟
    const rawTs = d?.timestamp
    const parsed = typeof rawTs === 'string' ? Date.parse(rawTs) : NaN
    const at = Number.isFinite(parsed) ? parsed : now()
    const messageId = String(d?.id || '')
    if (!messageId) return null

    // 被动回复窗口记账：网关用同一个 messageId 当 inResponseTo 回来找凭证
    seenAt.set(messageId, now())
    if (seenAt.size > 2000) seenAt.delete(seenAt.keys().next().value)

    return {
      chat: { kind: chatKind, id: chatId },
      sender: { account: senderAccount, name: senderName, role: senderRole, alt: senderAlt },
      messageId,
      at,
      replyTo,
      mentionedMe,
      parts,
      // ext 只放平台专属、中枢用不上的东西（CONTRACTS 六.5）
      ext: {
        eventType: t,
        groupOpenid: chatKind === 'group' ? chatId : undefined,
        userOpenid: chatKind === 'private' ? chatId : undefined,
        unionOpenid: senderAlt,
        msgIdx: sceneExt(d?.message_scene, 'msg_idx'),
        authToken: sceneExt(d?.message_scene, 'auth_token'),
        messageType: d?.message_type,
      },
      raw: d,
    }
  }

  /** 收一条平台事件：消息走 emit，其余走 emitEvent（原生事件只转给绑定平台的模块） */
  function handleDispatch(t, d, raw) {
    if (!running || !connected || !ctx) return false // 停了就绝不再 emit
    const message = translate(t, d)
    if (message) {
      ctx.emit(message)
      return true
    }
    // 机器人自己发的、群成员变动、好友关系、审核结果等 → native 事件
    ctx.emitEvent({ type: 'native', name: String(t || 'unknown'), raw: raw ?? d })
    return true
  }

  // ───── Webhook 入口 ─────

  /** 从 req 取原始 body（验签必须用原文） */
  function rawBodyOf(req) {
    if (req == null) return ''
    if (Buffer.isBuffer(req.rawBody)) return req.rawBody
    if (typeof req.rawBody === 'string') return req.rawBody
    if (Buffer.isBuffer(req.body)) return req.body
    if (typeof req.body === 'string') return req.body
    // 宿主只给了解析后的对象：只能重新序列化。字段顺序/空格与原文不同会导致验签失败，
    // 所以文档里要求宿主保留原始 body（见 ADAPTER-QQBOT.md「用户接入步骤」）。
    if (req.body && typeof req.body === 'object') return JSON.stringify(req.body)
    return ''
  }

  function headerOf(req, name) {
    const headers = req?.headers || {}
    const lower = String(name).toLowerCase()
    for (const key of Object.keys(headers)) if (String(key).toLowerCase() === lower) return headers[key]
    return undefined
  }

  function respond(res, statusCode, payload) {
    if (!res) return
    try {
      res.statusCode = statusCode
      if (payload !== undefined && typeof res.end === 'function') res.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
      else if (typeof res.end === 'function') res.end()
    } catch {}
  }

  /** Webhook handler：验签 → op 13 验证 / op 0 dispatch */
  function webhookHandler(req, res) {
    const cfg = cfgOf()
    const secret = cfg.botSecret || cfg.secret || cfg.clientSecret || cfg.appSecret
    if (!keys) keys = deriveEd25519(secret)

    const timestamp = headerOf(req, 'x-signature-timestamp')
    const signature = headerOf(req, 'x-signature-ed25519')
    const raw = rawBodyOf(req)

    // 没有 edn 密钥（未配置 secret）时一律拒绝：宁可收不到消息，也不能让伪造消息写进记忆
    if (!keys || !verifySignature(keys, signature, timestamp, raw)) {
      respond(res, 401)
      return false
    }

    // 还是按 X-Bot-Appid 核对一下 AppID，避免别的机器人打到这个地址
    const appIdHeader = headerOf(req, 'x-bot-appid')
    const appId = cfg.appId || cfg.appid
    if (appIdHeader != null && appId && String(appIdHeader) !== String(appId)) {
      respond(res, 403)
      return false
    }

    let payload = null
    try { payload = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)) } catch { payload = null }
    if (!payload || typeof payload !== 'object') {
      respond(res, 400)
      return false
    }

    // op 13：开放平台验证回调地址。回 plain_token + signature，不 emit
    if (Number(payload.op) === 13) {
      const d = payload.d || {}
      respond(res, 200, { plain_token: d.plain_token, signature: signValidation(keys, d.event_ts, d.plain_token) })
      return true
    }

    // op 0 Dispatch：真正的事件
    if (Number(payload.op) === 0) {
      const ok = handleDispatch(payload.t, payload.d, payload)
      // 回调模式要回 op 12（HTTP Callback ACK），否则平台会重推
      respond(res, 200, { op: 12, d: {} })
      return ok
    }

    // 其余 opcode 在 webhook 模式下不会出现，回了也当成功但不 emit
    respond(res, 200, { op: 12, d: {} })
    return false
  }

  // ───── PlatformAdapter ─────

  const adapter = {
    id,
    name: options.name || 'QQ 官方机器人',
    contract: 1,

    /** 能力表。说真话；配置只能把它改小（网关还会再叠一次 config.caps）。 */
    caps,

    settings: [
      { key: 'appId', label: 'AppID', type: 'text', default: '', description: 'QQ 开放平台 → 机器人管理端 → 开发设置' },
      { key: 'clientSecret', label: 'AppSecret', type: 'password', default: '', description: '与 AppID 配对；只用来换 access_token，不要外泄' },
      { key: 'botSecret', label: '回调 Bot Secret（验签用）', type: 'password', default: '', description: 'Webhook 模式的 Ed25519 验签密钥，一般与 AppSecret 相同' },
      { key: 'transport', label: '事件订阅方式', type: 'select', options: ['webhook', 'websocket'], default: 'webhook', description: 'webhook 需要公网 HTTPS 地址；websocket 需要宿主注入事件源' },
      { key: 'proactive', label: '主动消息', type: 'select', options: ['limited', 'none'], default: 'limited', description: 'none = 只做被动回复（平台主动能力已收敛，建议 none）' },
      { key: 'listenAllInGroup', label: '接收群内全部消息', type: 'boolean', default: false, description: '需要群主在手机 QQ 里给机器人打开「接收所有消息」，否则只能收到 @ 她的' },
      { key: 'proactivePerDay', label: '主动消息每日上限（每聊天）', type: 'number', default: 4, description: '平台口径多变且已收敛，平台端自己按这个数记账' },
      { key: 'replyAs', label: '被动回复凭证', type: 'select', options: ['msg_id', 'event_id'], default: 'msg_id', description: '回复用户消息用 msg_id；回复事件（如入群）用 event_id' },
      { key: 'selfOpenid', label: '机器人自身 openid', type: 'text', default: '', description: '可选。用于全量模式判断「是不是 @ 了她」' },
      { key: 'timeoutMs', label: '请求超时（毫秒）', type: 'number', default: DEFAULT_TIMEOUT_MS, description: '官方建议发消息接口不低于 5 秒' },
    ],

    /** 启动：读配置 → 取 token → 核对自己是谁 → 挂回调 / 注入事件源 → connected */
    async start(context) {
      if (running) return
      ctx = context
      running = true
      const cfg = cfgOf()
      transport = String(cfg.transport || 'webhook') === 'websocket' ? 'websocket' : 'webhook'

      // 用户配置只能把能力改小：proactive / listenAllInGroup 取配置值，其余不支持手动放大
      capsOverride = { ...(capsOverride || {}) }
      if (cfg.proactive === 'none' || cfg.proactive === 'limited') capsOverride.proactive = cfg.proactive
      if (cfg.listenAllInGroup != null) capsOverride.listenAllInGroup = Boolean(cfg.listenAllInGroup)
      if (cfg.proactivePerDay != null) capsOverride.proactivePerDay = Number(cfg.proactivePerDay)

      ctx.state('connecting')

      const secret = cfg.botSecret || cfg.secret || cfg.clientSecret || cfg.appSecret
      keys = deriveEd25519(secret)
      if (!keys) keys = null

      // 缺凭证就别假装连上了：抛错让网关记启动失败（面板上会看到原因）
      if (!(cfg.appId || cfg.appid) || !(cfg.clientSecret || cfg.appSecret || cfg.secret)) {
        running = false
        ctx.state('unconfigured', '缺少 AppID / AppSecret')
        throw new Error('qqbot：缺少 AppID / AppSecret，无法启动')
      }

      if (transport === 'webhook') {
        // 官方允许的回调端口只有 80/443/8080/8443，路径由插件 HTTP 服务挂成 /platform/<实例>/callback
        const off = ctx.route('/callback', webhookHandler)
        offs.push(off)
      } else {
        if (!connectEvents) {
          running = false
          ctx.state('disconnected', 'transport=websocket 需要宿主注入事件源')
          throw new Error('qqbot：transport=websocket 需要注入 connectEvents（本包不加依赖，未内置 WebSocket 客户端）')
        }
        const stop = connectEvents((payload) => {
          if (!running) return
          if (Number(payload?.op) === 0) handleDispatch(payload.t, payload.d, payload)
          else if (Number(payload?.op) === 12) { /* READY / ACK，忽略 */ }
        })
        if (typeof stop === 'function') offs.push(stop)
      }

      connected = true
      ctx.state('connected')

      // 连上后核对身份（READY 里也有 user.id/username；GET /users/@me 同样可查）
      try {
        const res = await authedRequest({ path: '/users/@me', method: 'GET', timeoutMs: Math.max(1, Number(cfg.timeoutMs) || DEFAULT_TIMEOUT_MS) })
        const data = res?.data || {}
        if (data.id || data.username) {
          self = { account: String(data.id || ''), name: String(data.username || '') }
        }
      } catch (error) {
        // 查不到不算致命：whoami 会用配置里的兜底值
        ctx.log?.warn?.('qqbot：获取机器人自身信息失败：', error?.message || error)
      }
      if (!self.account && cfg.selfOpenid) self.account = String(cfg.selfOpenid)
      if (!self.name) self.name = String(cfg.selfName || 'QQ 机器人')
    },

    /** 停止：撤路由 / 停事件源 → stopped。停了之后绝不再 emit。 */
    async stop() {
      if (!running) return
      running = false
      connected = false
      for (const off of offs.splice(0)) { try { off() } catch {} }
      seenAt.clear()
      msgSeq.clear()
      replyCount.clear()
      proactiveCount.clear()
      ctx?.state('stopped')
    },

    /** 连上后核对「登录的是不是配置里的那个机器人」 */
    async whoami() {
      const cfg = cfgOf()
      if (!self.account) return { account: String(cfg.selfOpenid || cfg.appId || id), name: String(cfg.selfName || 'QQ 机器人') }
      return { account: self.account, name: self.name }
    },

    /**
     * 出站：parts → /v2/users|groups/{openid}/messages。
     * inResponseTo 就是 msg_id（或 event_id）——本平台的被动回复凭证。
     */
    async send(message) {
      const currentCaps = caps()
      const kind = message?.chat?.kind === 'group' ? 'group' : 'private'
      const chatId = String(message?.chat?.id ?? '')
      const cfg = cfgOf()
      const timeoutMs = Math.max(1, Number(message?.timeoutMs) || Number(cfg.timeoutMs) || DEFAULT_TIMEOUT_MS)

      // 没连上：确定没发出去
      if (!running || !connected) throw sendError('not-sent', 'offline', instance, '平台端未连接')
      if (!chatId) throw sendError('not-sent', 'no-chat', instance, '缺少会话编号')

      const inResponseTo = message?.inResponseTo ? String(message.inResponseTo) : ''
      const proactiveMode = currentCaps.proactive

      // ① 没有 inResponseTo = 主动消息
      if (!inResponseTo) {
        if (proactiveMode === 'none') {
          throw sendError('not-sent', 'proactive-not-allowed', instance, '该平台只能被动回复（proactive=none）')
        }
        if (proactiveMode === 'limited') {
          const day = new Date(now()).toISOString().slice(0, 10)
          const key = `${day}\u0000${kind}\u0000${chatId}`
          const limit = Math.max(0, Number(currentCaps.proactivePerDay ?? cfg.proactivePerDay ?? 4))
          const used = proactiveCount.get(key) || 0
          if (used >= limit) throw sendError('not-sent', 'proactive-limit', instance, '主动消息额度已用完')
        }
      } else {
        // ② 带了凭证：先看时限，再看条数（超了就当主动消息，主动又不许就直接拒）
        const windowMs = Number(currentCaps.replyWindowMs) || 0
        const at = seenAt.get(inResponseTo)
        if (windowMs > 0 && at != null && now() - at > windowMs) {
          if (proactiveMode === 'none') throw sendError('not-sent', 'proactive-not-allowed', instance, '回复已超出被动回复时限')
          // limited：超窗按主动消息算，继续走额度检查
          const day = new Date(now()).toISOString().slice(0, 10)
          const key = `${day}\u0000${kind}\u0000${chatId}`
          const limit = Math.max(0, Number(currentCaps.proactivePerDay ?? cfg.proactivePerDay ?? 4))
          if ((proactiveCount.get(key) || 0) >= limit) throw sendError('not-sent', 'proactive-limit', instance, '回复已超窗，按主动消息算但额度已用完')
        }
      }

      const messages = buildMessages(message?.parts || [])
      if (!messages.length) throw sendError('not-sent', 'nothing-to-send', instance, '没有可发送的内容')

      // ③ 一条入站消息能回几次（平台硬限制）：平台端自己先挡，不指望平台报错。
      // 计数单位是「回复」（= 一次 send），不是「平台 API 调用」：一次回复里若含多个富媒体，
      // 会被拆成多条平台消息（平台一条消息只能带一个 media），这一点在文档里写明了。
      const replyKey = `${kind}\u0000${chatId}\u0000${inResponseTo}`
      if (inResponseTo && Number(currentCaps.repliesPerMessage) > 0) {
        const used = replyCount.get(replyKey) || 0
        const limit = Number(currentCaps.repliesPerMessage)
        if (used >= limit) {
          throw sendError('not-sent', 'proactive-limit', instance, `一条消息最多回 ${limit} 次，已用 ${used} 次`)
        }
      }

      // 测试注入故障（对应真实世界的「连不上 / 一直不返回」）
      if (failSend === 'refused') {
        failSend = null
        throw sendError('not-sent', 'platform-refused', instance, '平台连接被拒绝')
      }
      if (failSend === 'timeout') {
        failSend = null
        throw sendError('unknown', 'timeout', instance, `平台 ${timeoutMs}ms 内没有响应`)
      }

      let lastId = ''
      const replyAs = cfg.replyAs === 'event_id' ? 'event_id' : 'msg_id'
      for (const item of messages) {
        let payload
        if (item.media) {
          const fileInfo = await uploadMedia(kind, chatId, item, timeoutMs)
          payload = { msg_type: 7, media: { file_info: fileInfo } }
        } else {
          payload = { msg_type: 0, content: item.content }
        }
        const result = await callSend(kind, chatId, payload, { timeoutMs, inResponseTo: inResponseTo || undefined, replyAs })
        lastId = result.messageId
      }
      // 记账：一次 send 记一次「回复」/ 一次主动消息（与平台「每消息最多回复 N 次」同一口径）
      if (inResponseTo) replyCount.set(replyKey, (replyCount.get(replyKey) || 0) + 1)
      else {
        const day = new Date(now()).toISOString().slice(0, 10)
        const key = `${day}\u0000${kind}\u0000${chatId}`
        proactiveCount.set(key, (proactiveCount.get(key) || 0) + 1)
      }
      return { messageId: lastId }
    },

    /** 原生格式（测试用）：直接把事件体翻成 parts */
    toParts(nativeMessage) {
      return eventToParts(nativeMessage?.d || nativeMessage || {}, { selfOpenid: self.account || cfgOf().selfOpenid }).parts
    },
  }

  // ───────────────────────── 测试后门（与 _template / fake-adapter 同名同语义） ─────────────────────────

  const platform = {
    /** 直接推一条平台事件（绕过 HTTP 与验签，等价 WS 推送）。返回是否送达。 */
    deliver(t, d) { return handleDispatch(t, d, { op: 0, t, d }) },
    /** 推一条完整 payload */
    deliverPayload(payload) { return handleDispatch(payload?.t, payload?.d, payload) },
    /** 走一遍真实的 webhook 处理（验签也在内），供契约测试的 injectSigned 用 */
    deliverWebhook(req, res) { return webhookHandler(req, res) },
    /** 用当前 botSecret 给一段原始 body 算签名头（测试造合法回调） */
    sign(rawBody, timestamp = '1725442341') {
      if (!keys) return ''
      const msg = Buffer.concat([Buffer.from(String(timestamp), 'utf8'), Buffer.from(String(rawBody), 'utf8')])
      return ed25519Sign(null, msg, keys.privateKey).toString('hex')
    },
    /** 模拟断线 */
    break() { connected = false; if (ctx) ctx.state('disconnected', '模拟断线') },
    /** 模拟重连 */
    restore() { connected = true; if (ctx) ctx.state('connected') },
    /** 下一次发送模拟「连不上」 */
    refuseNext() { failSend = 'refused' },
    /** 下一次发送模拟「一直不返回」 */
    hangNext() { failSend = 'timeout' },
    /** 切 proactive（会通知网关重读 caps） */
    setProactive(value) {
      capsOverride = { ...(capsOverride || {}), proactive: value === 'none' ? 'none' : 'limited' }
      if (value === 'free') capsOverride.proactive = 'free' // 仅测试用：真实平台不提供 free
      if (ctx) ctx.capsChanged()
    },
    /** 改 caps 覆盖（模拟探测后能力变化） */
    setCapsOverride(partial) {
      capsOverride = { ...(capsOverride || {}), ...partial }
      if (ctx) ctx.capsChanged()
    },
    /** 当前 token 状态（测试断言自动刷新用） */
    tokenState() { return { value: token.value, expiresAt: token.expiresAt } },
    /** 强制让 token 过期（测试用） */
    expireToken() { token = { value: token.value, expiresAt: 0 } },
    /** 已记录的被动回复条数（测试用） */
    replyCountOf(kind, chatId, inResponseTo) { return replyCount.get(`${kind}\u0000${chatId}\u0000${inResponseTo}`) || 0 },
    /** 已记录的主动消息条数（测试用） */
    proactiveCountOf(kind, chatId) {
      const day = new Date(now()).toISOString().slice(0, 10)
      return proactiveCount.get(`${day}\u0000${kind}\u0000${chatId}`) || 0
    },
  }

  adapter.platform = platform
  return adapter
}

/** 默认导出：网关按 () => createQqbotAdapter() 注册 */
export default createQqbotAdapter()
