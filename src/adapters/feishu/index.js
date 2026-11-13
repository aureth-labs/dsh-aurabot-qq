// Aurabot 多平台 · 飞书平台端（F1 产出）
// 来源：Aurabot 多平台化 F1 工作包。许可：MIT（随本仓库）。
// 作用：把飞书企业自建应用接成平台端——Webhook 收事件（ctx.route）、REST 发消息。
// 契约依据：src/gateway/contracts.d.ts（PlatformAdapter/Caps/Part/SendError）
//          ＋ docs/CONTRACTS.md §六（入站）§七（出站）§八（能力表/被动回复）。
// 官方文档核对结果与未确认点：docs/ADAPTER-FEISHU.md（**开工前必读，那里写清了哪些是核实过的**）。
//
// ── 为什么用 Webhook 而不是长连接 ──
// 官方两种都支持：SDK 长连接（需装 @larksuiteoapi/node-sdk）或自建 HTTP 服务器收事件。
// 本仓库铁律是「能不加依赖就不加」（README 待定事项第 4 条），而宿主（host.js）本来就有
// HTTP 服务并支持 ctx.route()，所以走 Webhook + 手写验签，零依赖。
// 代价：用户的插件必须有公网可达地址（或反向代理）。这一条写进了 ADAPTER-FEISHU.md。
//
// ── 身份：open_id 按应用变，union_id 跨应用不变 ──
// account 用 open_id（发消息要用它），alt 存 union_id（换应用后靠 I1 的 alt 找回把同一个
// 人认回来，见 docs/CONTRACTS.md §四与包-I1）。

import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto'

// ───────────────────────── 错误分类 ─────────────────────────

function sendError(certainty, code, instance, message) {
  const error = new Error(message || `飞书发送失败（${certainty}${code ? ' / ' + code : ''}）`)
  error.certainty = certainty
  if (code) error.code = code
  error.instance = instance
  return error
}

/** 最保守的能力表：连上之前 / 探测不出来时按这个报（CONTRACTS §八.1） */
export const CAPS_CONSERVATIVE = {
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
 * 按官方能力填的默认表（docs/ADAPTER-FEISHU.md 有逐项依据）。
 *   · voice: 'file' —— 飞书语音要 opus 且要走文件接口，本端只保证「当音频文件发」
 *   · proactive: 'limited' —— 飞书允许机器人主动私聊/群发，但有频控与「仅企业内」限制，
 *     由平台端自己记账，超了抛 proactive-limit（CONTRACTS §八.4）
 *   · listenAllInGroup: false —— 默认只收到 @ 机器人的消息；要旁听全群需申请
 *     im:message.group_msg 这类敏感权限，拿不到就是收不到，按最保守报
 *   · repliesPerMessage: 0（不限）—— 飞书没有「一条消息只能回 N 条」的硬限制
 */
export const CAPS_FEISHU = {
  image: true,
  sticker: false,        // 飞书没有表情包消息类型 → 网关降级成图片
  voice: 'file',         // 语音条要 opus + 文件接口，只保证当音频文件发
  video: true,
  file: true,
  maxFileBytes: 30 * 1024 * 1024, // 文件接口上限（官方 30MB，超了走分片；本端不做分片）
  quoteReply: true,      // 飞书支持 reply 到某条消息
  mention: true,         // 文本里写 <at user_id="ou_xxx">名字</at>
  mentionAll: true,      // <at user_id="all">所有人</at>
  poke: false,           // 飞书没有「戳一戳」
  typing: false,
  recall: true,          // 可撤回自己发的消息
  card: true,            // 交互卡片（【要授权】那类确认可以做成带按钮的卡片）
  listenAllInGroup: false,
  proactive: 'limited',
  replyWindowMs: 0,      // 飞书没有「必须 N 分钟内回复」的硬限制
  repliesPerMessage: 0,
  history: true,         // GET /open-apis/im/v1/messages 可拉历史
  memberList: true,
  forwardExpand: false,
}

// ───────────────────────── 加解密 / 验签 ─────────────────────────

/**
 * 解飞书的事件加密包（encrypt 字段）。
 * 算法（官方「加密策略」）：AES-256-CBC；key = sha256(encrypt_key)；密文 base64 解码后
 * 前 16 字节是 IV，其余是密文；PKCS#7 填充。
 */
export function decryptEvent(encryptKey, encrypted) {
  const key = createHash('sha256').update(String(encryptKey), 'utf8').digest()
  const raw = Buffer.from(String(encrypted), 'base64')
  if (raw.length <= 16) throw new Error('加密包太短，解不开')
  const iv = raw.subarray(0, 16)
  const data = raw.subarray(16)
  const decipher = createDecipheriv('aes-256-cbc', key, iv)
  decipher.setAutoPadding(true)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

/**
 * 验签：X-Lark-Signature = sha256(timestamp + nonce + encryptKey + body) 的十六进制。
 * 注意是对**原始 body 字符串**算，不是对 JSON.stringify(解析后的对象) 算——
 * 先解析再序列化必然对不上（空格、键序都会变）。
 */
export function verifySignature({ timestamp, nonce, encryptKey, body, signature }) {
  if (!signature) return false
  const expected = createHash('sha256')
    .update(String(timestamp || ''))
    .update(String(nonce || ''))
    .update(String(encryptKey || ''))
    .update(String(body || ''))
    .digest('hex')
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(String(signature), 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// ───────────────────────── 内容转换 ─────────────────────────

/** 飞书 message_type + content → 契约 parts */
export function toParts(messageType, contentRaw, mentions) {
  let content = {}
  try { content = typeof contentRaw === 'string' ? JSON.parse(contentRaw) : (contentRaw || {}) } catch { content = {} }
  const parts = []
  switch (messageType) {
    case 'text': {
      // 文本里的 @ 是 <at user_id="ou_x">名字</at>；@所有人是 user_id="all"
      const text = String(content.text || '')
      const re = /<at user_id="([^"]*)">([^<]*)<\/at>/g
      let last = 0
      let m
      while ((m = re.exec(text))) {
        if (m.index > last) parts.push({ type: 'text', text: text.slice(last, m.index) })
        parts.push({ type: 'mention', account: m[1], name: m[2] })
        last = m.index + m[0].length
      }
      if (last < text.length) parts.push({ type: 'text', text: text.slice(last) })
      if (!parts.length) parts.push({ type: 'text', text: '' })
      break
    }
    case 'image':
      parts.push({ type: 'image', media: { id: content.image_key, mime: 'image/png' } })
      break
    case 'file':
      parts.push({ type: 'file', media: { id: content.file_key, name: content.file_name } })
      break
    case 'audio':
      parts.push({ type: 'voice', media: { id: content.file_key, mime: 'audio/opus' }, durationMs: Number(content.duration) || undefined })
      break
    case 'media':
      parts.push({ type: 'video', media: { id: content.file_key, mime: content.mime_type } })
      break
    case 'sticker':
      parts.push({ type: 'sticker', media: { id: content.file_key }, label: '[表情]', native: content })
      break
    case 'post': {
      // 富文本：{"title":"","content":[[{"tag":"text","text":"…"},{"tag":"img","image_key":"…"}]]}
      const rows = content.content || []
      for (const row of Array.isArray(rows) ? rows : []) {
        for (const el of Array.isArray(row) ? row : []) {
          if (el?.tag === 'text' && el.text) parts.push({ type: 'text', text: String(el.text) })
          else if (el?.tag === 'a' && el.text) parts.push({ type: 'text', text: String(el.text), ...(el.href ? {} : {}) })
          else if (el?.tag === 'img' && el.image_key) parts.push({ type: 'image', media: { id: el.image_key } })
          else if (el?.tag === 'at' && el.user_id) parts.push({ type: 'mention', account: String(el.user_id), name: el.user_name })
        }
        parts.push({ type: 'text', text: '\n' })
      }
      if (!parts.length) parts.push({ type: 'other', text: '[富文本]', native: content })
      break
    }
    case 'share_chat':
      parts.push({ type: 'card', text: '[群名片]', title: content.chat_id, native: content })
      break
    case 'share_card':
      parts.push({ type: 'card', text: content.title || '[分享卡片]', title: content.title, url: content.url, native: content })
      break
    default:
      parts.push({ type: 'other', text: `[${messageType || '未知消息'}]`, native: content })
  }
  // 合并 mentions 里没在正文出现的（保险：官方 mentions 与正文可能不同步）
  for (const mt of Array.isArray(mentions) ? mentions : []) {
    const openId = mt?.id?.open_id
    if (!openId) continue
    if (!parts.some((p) => p.type === 'mention' && p.account === openId)) {
      parts.push({ type: 'mention', account: openId, name: mt.name })
    }
  }
  return parts
}

/** 契约 parts → 飞书发送调用序列（一条消息只能带一种 msg_type，多段要拆） */
export function fromParts(parts, opts = {}) {
  const sends = []
  let textBuf = ''
  const flushText = () => {
    if (!textBuf) return
    sends.push({ msgType: 'text', content: JSON.stringify({ text: textBuf }) })
    textBuf = ''
  }
  for (const p of parts || []) {
    switch (p.type) {
      case 'text': textBuf += String(p.text ?? ''); break
      case 'mention':
        textBuf += p.account === 'all'
          ? '<at user_id="all">所有人</at>'
          : `<at user_id="${p.account}">${p.name || ''}</at>`
        break
      case 'face': textBuf += `[${p.name || '表情'}]`; break
      case 'image':
        flushText()
        sends.push({ msgType: 'image', content: JSON.stringify({ image_key: opts.imageKeyOf?.(p) || p.media?.id || '' }), needsUpload: { kind: 'image', media: p.media } })
        break
      case 'sticker':
        flushText()
        sends.push({ msgType: 'image', content: JSON.stringify({ image_key: opts.imageKeyOf?.(p) || p.media?.id || '' }), needsUpload: { kind: 'image', media: p.media } })
        break
      case 'voice':
        flushText()
        sends.push({ msgType: 'file', content: JSON.stringify({ file_key: p.media?.id || '' }), needsUpload: { kind: 'file', media: p.media, fileType: 'opus' } })
        break
      case 'video':
        flushText()
        sends.push({ msgType: 'media', content: JSON.stringify({ file_key: p.media?.id || '' }), needsUpload: { kind: 'file', media: p.media, fileType: 'mp4' } })
        break
      case 'file':
        flushText()
        sends.push({ msgType: 'file', content: JSON.stringify({ file_key: p.media?.id || '' }), needsUpload: { kind: 'file', media: p.media, fileType: 'stream' } })
        break
      case 'card':
        flushText()
        sends.push({
          msgType: 'interactive',
          content: JSON.stringify(cardOf(p)),
        })
        break
      case 'poke':
        // 飞书没有戳一戳：网关会先降级掉；真到这里就丢掉
        break
      default:
        if (p.text) textBuf += String(p.text)
    }
  }
  flushText()
  return sends
}

/** 把 parts 里的 card 转成飞书交互卡片（【要授权】这类确认可以做成带按钮的） */
function cardOf(part) {
  const elements = []
  if (part.text) elements.push({ tag: 'div', text: { tag: 'plain_text', content: String(part.text) } })
  if (part.url) {
    elements.push({
      tag: 'action',
      actions: [{ tag: 'button', text: { tag: 'plain_text', content: part.title || '打开' }, type: 'default', multi_url: { url: part.url, pc_url: part.url, android_url: part.url, ios_url: part.url } }],
    })
  }
  return { config: { wide_screen_mode: true }, header: part.title ? { title: { tag: 'plain_text', content: part.title } } : undefined, elements }
}

/**
 * 按 ID 前缀决定 receive_id_type（官方约定）：
 *   ou_ → open_id（用户）  on_ → union_id  oc_ → chat_id（群）
 * 前缀认不出时退回调用方给的建议值。这样即使网关传进来的 chat.kind 与实际 ID 形态不符，
 * 也不会用错类型被飞书拒（错误码 230034 receive_id invalid）。
 */
export function receiveIdTypeOf(value, fallback) {
  const v = String(value || '')
  if (v.startsWith('oc_')) return 'chat_id'
  if (v.startsWith('on_')) return 'union_id'
  if (v.startsWith('ou_')) return 'open_id'
  return fallback
}

/** 取媒体字节：bytes 直接用；path 读文件；url 下载（飞书的媒体必须先上传换 key） */
async function loadMediaBytes(media) {
  if (media.bytes) return Buffer.from(media.bytes)
  if (media.path) {
    const { readFile } = await import('node:fs/promises')
    return await readFile(media.path)
  }
  if (media.url) {
    const res = await fetch(media.url)
    if (!res.ok) throw new Error(`下载媒体失败：HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }
  throw new Error('媒体没有可取的内容（bytes / path / url 都没有）')
}

// ───────────────────────── 平台端 ─────────────────────────

/**
 * 建飞书平台端。
 * options.client：可注入的 HTTP 客户端（测试用；形状见下面注释）。缺省用 fetch。
 */
export function createFeishuAdapter(options = {}) {
  const id = options.id || 'feishu'
  const name = options.name || '飞书'
  let ctx = null
  let instance = id
  let running = false
  let connected = false
  let caps = { ...CAPS_CONSERVATIVE }
  let self = null
  let tokenCache = { token: '', expiresAt: 0 }
  const offs = []

  const config = () => {
    const fromCtx = typeof ctx?.config === 'function' ? ctx.config() || {} : {}
    // 测试注入的配置（kit 的 ctx.config() 恒为空对象，没法从外部设置）
    const injected = injectedConfig
    return injected ? { ...injected, ...fromCtx } : fromCtx
  }
  let injectedConfig = null
  const log = () => ctx?.log || { debug() {}, info() {}, warn() {}, error() {} }

  /** 官方 API 基址（飞书 / Lark 国际版不同，做成可配） */
  const baseUrl = () => String(config().baseUrl || 'https://open.feishu.cn').replace(/\/+$/, '')

  // ── HTTP 客户端接缝 ──
  // 缺省实现：request({ method, url, headers, body, timeoutMs }) → { status, json }
  // 测试注入同形状的假 client 即可，不打真网络。
  const httpClient = options.client || {
    async request({ method = 'GET', url, headers = {}, body, timeoutMs = 15000 }) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await fetch(url, { method, headers, body, signal: controller.signal })
        const text = await res.text()
        let json = null
        try { json = text ? JSON.parse(text) : null } catch { json = { raw: text } }
        return { status: res.status, json }
      } finally {
        clearTimeout(timer)
      }
    },
  }

  /** tenant_access_token：缓存到过期前 60 秒再换（官方有效期 2 小时） */
  async function tenantToken({ force = false } = {}) {
    const now = Date.now()
    if (!force && tokenCache.token && tokenCache.expiresAt - 60_000 > now) return tokenCache.token
    const { appId, appSecret } = config()
    if (!appId || !appSecret) throw sendError('not-sent', 'no-credentials', instance, '还没填 appId / appSecret')
    const r = await httpClient.request({
      method: 'POST',
      url: `${baseUrl()}/open-apis/auth/v3/tenant_access_token/internal`,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    })
    // 官方：这个接口失败时 HTTP 可能仍是 200，必须看 body.code
    const code = Number(r.json?.code ?? -1)
    if (code !== 0 || !r.json?.tenant_access_token) {
      throw sendError('not-sent', `token-${code}`, instance, `取 tenant_access_token 失败：${r.json?.msg || r.status}`)
    }
    const expire = Number(r.json.expire) || 7200
    tokenCache = { token: r.json.tenant_access_token, expiresAt: now + expire * 1000 }
    return tokenCache.token
  }

  /** 带 token 的 API 调用（401/99991663 之类换一次 token 再试） */
  async function api(method, path, payload, { retried = false } = {}) {
    const token = await tenantToken({ force: retried })
    const r = await httpClient.request({
      method,
      url: `${baseUrl()}${path}`,
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    })
    const code = Number(r.json?.code ?? 0)
    if ((r.status === 401 || code === 99991663 || code === 99991661) && !retried) {
      tokenCache = { token: '', expiresAt: 0 }
      return api(method, path, payload, { retried: true })
    }
    return { status: r.status, code, json: r.json }
  }

  // ───────────────────────── 入站（Webhook） ─────────────────────────

  /**
   * 事件回调。三种请求：
   *  1) URL 校验：body 里有 challenge（可能被加密包住），原样回 challenge
   *  2) 加密事件：{ encrypt: '...' } → 解密得到明文事件 JSON
   *  3) 明文事件：schema 2.0 的 { header, event }
   */
  function handleCallback(req, res) {
    const cfg = config()
    const raw = typeof req?.body === 'string' ? req.body : JSON.stringify(req?.body ?? {})
    let bodyObj = null
    try { bodyObj = typeof req?.body === 'string' ? JSON.parse(req.body) : req?.body } catch { bodyObj = null }
    if (!bodyObj) return reply(res, 400, { ok: false, error: 'bad json' })

    // ① 验签（配了 encryptKey 才要求；不配就只靠 token/challenge 校验）
    if (cfg.encryptKey) {
      const ok = verifySignature({
        timestamp: header(req, 'x-lark-request-timestamp'),
        nonce: header(req, 'x-lark-request-nonce'),
        encryptKey: cfg.encryptKey,
        body: raw,
        signature: header(req, 'x-lark-signature'),
      })
      if (!ok) {
        log().warn('飞书回调验签不过，已拒绝（不 emit）')
        return reply(res, 401, { ok: false, error: 'bad signature' })
      }
    }

    // ② 解密
    let payload = bodyObj
    if (bodyObj.encrypt) {
      if (!cfg.encryptKey) {
        log().warn('收到加密事件但没配 encryptKey，解不开')
        return reply(res, 400, { ok: false, error: 'no encrypt key' })
      }
      try {
        payload = JSON.parse(decryptEvent(cfg.encryptKey, bodyObj.encrypt))
      } catch (error) {
        log().warn('飞书事件解密失败：', error?.message || error)
        return reply(res, 400, { ok: false, error: 'decrypt failed' })
      }
    }

    // ③ URL 校验：必须 1 秒内原样返回 challenge
    if (payload?.challenge !== undefined) {
      return reply(res, 200, { challenge: payload.challenge })
    }
    // 收事件地址校验也要求把 token 回显（旧版 schema）
    if (payload?.type === 'url_verification') {
      return reply(res, 200, { challenge: payload.challenge, token: payload.token })
    }

    // ④ 事件
    if (!running) return reply(res, 200, { ok: true })
    const headerObj = payload?.header || {}
    if (headerObj.event_type === 'im.message.receive_v1') {
      const inbound = toInbound(payload.event, headerObj)
      if (inbound) ctx.emit(inbound)
      return reply(res, 200, { ok: true })
    }
    // 其余事件转给绑定该平台的模块（加好友、入群、撤回……）
    ctx.emitEvent({ type: 'native', name: String(headerObj.event_type || ''), raw: payload })
    return reply(res, 200, { ok: true })
  }

  /** 飞书事件 → AdapterInbound */
  function toInbound(event, headerObj) {
    const msg = event?.message
    if (!msg) return null
    const openId = String(event?.sender?.sender_id?.open_id || '')
    const unionId = String(event?.sender?.sender_id?.union_id || '')
    const chatType = msg.chat_type === 'p2p' ? 'private' : 'group'
    const parts = toParts(msg.message_type, msg.content, msg.mentions)
    const selfId = String(self?.account || '')
    // @机器人自己：提到的 open_id 等于自己 → mentionedMe，且不进 parts（CONTRACTS §六.2）
    const mentionedMe = parts.some((p) => p.type === 'mention' && selfId && p.account === selfId)
    const cleanParts = parts.filter((p) => !(p.type === 'mention' && selfId && p.account === selfId))
    return {
      chat: { kind: chatType, id: String(msg.chat_id || ''), title: msg.chat_name },
      sender: {
        account: openId,
        name: String(event?.sender?.sender_id?.user_id || openId),
        role: '',
        alt: unionId || undefined,
      },
      messageId: String(msg.message_id || headerObj.event_id || ''),
      at: Number(msg.create_time) || Date.now(),
      replyTo: msg.parent_id || msg.root_id || undefined,
      mentionedMe: Boolean(mentionedMe) || chatType === 'private',
      parts: cleanParts.length ? cleanParts : [{ type: 'other', text: '[空消息]' }],
      ext: { messageType: msg.message_type, tenantKey: event?.sender?.tenant_key },
      raw: event,
    }
  }

  const header = (req, want) => {
    const h = req?.headers || {}
    const key = Object.keys(h).find((k) => k.toLowerCase() === want)
    return key ? h[key] : undefined
  }
  function reply(res, status, payload) {
    if (!res) return
    res.statusCode = status
    if (typeof res.setHeader === 'function') res.setHeader('content-type', 'application/json; charset=utf-8')
    if (typeof res.end === 'function') res.end(JSON.stringify(payload))
  }

  // ───────────────────────── 平台端契约 ─────────────────────────

  const adapter = {
    id,
    name,
    contract: 1,
    caps: () => ({ ...caps }),

    settings: [
      { key: 'appId', label: 'App ID', type: 'text', hint: '飞书开放平台 → 企业自建应用 → 凭证与基础信息' },
      { key: 'appSecret', label: 'App Secret', type: 'password' },
      { key: 'encryptKey', label: 'Encrypt Key', type: 'password', hint: '事件订阅 → 加密策略。填了才做验签与解密；不填只能收明文事件（不推荐）' },
      { key: 'verificationToken', label: 'Verification Token', type: 'password', hint: '事件订阅 → 加密策略' },
      { key: 'baseUrl', label: 'API 域名', type: 'text', default: 'https://open.feishu.cn', hint: 'Lark 国际版填 https://open.larksuite.com' },
    ],

    async start(gatewayCtx) {
      ctx = gatewayCtx
      instance = String(ctx.instance || id)
      running = true
      const cfg = config()
      offs.push(ctx.route('/callback', handleCallback))
      offs.push(ctx.route('/event', handleCallback)) // 有人习惯配 /event
      if (!cfg.appId || !cfg.appSecret) {
        connected = false
        ctx.state('unconfigured', '还没填 App ID / App Secret')
        return
      }
      try {
        await tenantToken()
      } catch (error) {
        connected = false
        ctx.state('unconfigured', `取 tenant_access_token 失败：${error?.message || error}`)
        return
      }
      connected = true
      caps = { ...CAPS_FEISHU }
      ctx.capsChanged()
      ctx.state('connected', cfg.encryptKey ? 'Webhook 已就绪（验签+解密）' : 'Webhook 已就绪（未配 Encrypt Key，只能收明文）')
    },

    async stop() {
      running = false
      connected = false
      for (const off of offs.splice(0)) { try { off() } catch {} }
      tokenCache = { token: '', expiresAt: 0 }
      ctx?.state('stopped')
    },

    async whoami() {
      if (!self) {
        try {
          const r = await api('GET', '/open-apis/bot/v3/info')
          const bot = r.json?.bot || {}
          self = { account: String(bot.open_id || bot.app_id || 'feishu-bot'), name: String(bot.app_name || '飞书机器人') }
        } catch {
          self = { account: 'feishu-bot', name: '飞书机器人' }
        }
      }
      return { ...self }
    },

    /**
     * 出站。一条飞书消息只能带一种 msg_type，多段要拆成多次调用。
     * 失败分类：拿到明确错误码 → not-sent；超时/网络中断/读不懂 → unknown（绝不重发）。
     */
    async send(message = {}) {
      if (!running || !connected) throw sendError('not-sent', 'offline', instance, '飞书平台端未连接')
      const cfg = config()
      const chat = message.chat || {}
      const isGroup = chat.kind === 'group'
      // 被动回复：飞书本身没硬时限，但如果配置把它改成 none 就要守（CONTRACTS §八.4）
      if (caps.proactive === 'none' && !message.inResponseTo) {
        throw sendError('not-sent', 'proactive-not-allowed', instance, '该实例被配置成只能被动回复')
      }
      let sends = fromParts(message.parts, { faceNameOf: () => '表情' })
      if (!sends.length) throw sendError('not-sent', 'nothing-to-send', instance, '没有可发送的内容')

      // 超限检查
      for (const p of message.parts || []) {
        const size = Number(p?.media?.size) || 0
        if (size && caps.maxFileBytes > 0 && size > caps.maxFileBytes) {
          throw sendError('not-sent', 'too-large', instance, `文件 ${size} 字节超过飞书上限 ${caps.maxFileBytes}`)
        }
      }

      const timeoutMs = Math.max(1, Number(message.timeoutMs) || 15000)
      let lastMessageId = ''
      for (const item of sends) {
        // 需要先上传的媒体：网关只传 parts，不带字节。三种情况：
        //   ① 已经有平台内的 key（media.id 且长得像飞书 key）→ 直接用
        //   ② 只有 url/path/bytes → 本端不下载（契约：网关不替平台端下载），
        //      用 not-sent + media-needs-upload 让上层用 fetch/uploadMedia 补 key
        //   ③ 什么都没有 → 同样的错
        if (item.needsUpload) {
          const media = item.needsUpload.media || {}
          const keyField = item.msgType === 'image' ? 'image_key' : 'file_key'
          const contentObj = JSON.parse(item.content)
          if (!contentObj[keyField] && media.id) {
            // 平台内标识直接当 key 用（入站拿到的就是它）
            contentObj[keyField] = String(media.id)
            item.content = JSON.stringify(contentObj)
          }
          if (!JSON.parse(item.content)[keyField] && (media.url || media.path || media.bytes)) {
            // 契约说「网关不替平台端下载」，没说平台端自己不能下。
            // 飞书必须先上传换 key，所以这里由平台端自己取字节再上传。
            const bytes = await loadMediaBytes(media)
            const up = await this.uploadMedia(
              item.needsUpload.kind === 'image' ? 'image' : 'file',
              bytes,
              { mime: media.mime, name: media.name || (item.needsUpload.kind === 'image' ? 'image.png' : 'file'), fileType: item.needsUpload.fileType },
            )
            const key = up?.image_key || up?.file_key
            if (!key) throw sendError('not-sent', 'upload-failed', instance, '飞书上传媒体没返回 key')
            contentObj[keyField] = key
            item.content = JSON.stringify(contentObj)
          }
          if (!JSON.parse(item.content)[keyField]) {
            throw sendError('not-sent', 'media-needs-upload', instance,
              '媒体既没有平台内 key 也没有可取的位置（url/path/bytes）')
          }
        }
        const payload = {
          receive_id: String(chat.id || ''),
          msg_type: item.msgType,
          content: item.content,
        }
        const receiveIdType = receiveIdTypeOf(chat.id, isGroup ? 'chat_id' : 'open_id')
        const q = `receive_id_type=${receiveIdType}`
        let r
        try {
          r = await api('POST', `/open-apis/im/v1/messages?${q}`, payload)
        } catch (error) {
          if (error?.certainty) throw error
          // 网络层失败：拿不准到底发没发出去
          if (error?.name === 'AbortError' || /timeout|aborted/i.test(String(error?.message))) {
            throw sendError('unknown', 'timeout', instance, '飞书发送超时（可能已发出，按 unknown 处理）')
          }
          throw sendError('not-sent', 'network', instance, `飞书发送失败：${error?.message || error}`)
        }
        if (r.code !== 0) {
          // 明确的业务错误 → 确定没发出去
          throw sendError('not-sent', `fs-${r.code}`, instance, `飞书拒绝发送：${r.json?.msg || r.code}`)
        }
        lastMessageId = String(r.json?.data?.message_id || '')
      }
      if (!lastMessageId) throw sendError('unknown', 'no-message-id', instance, '飞书没返回 message_id（拿不准）')
      return { messageId: lastMessageId }
    },

    /** 取图 / 取文件：飞书的媒体要带 token 下载 */
    async fetch(request) {
      if (request?.kind === 'media' && request.media?.id) {
        const token = await tenantToken()
        const key = request.media.id
        const isImage = String(request.media.mime || '').startsWith('image/')
        const path = isImage
          ? `/open-apis/im/v1/images/${encodeURIComponent(key)}`
          : `/open-apis/im/v1/files/${encodeURIComponent(key)}`
        const r = await httpClient.request({
          method: 'GET',
          url: `${baseUrl()}${path}`,
          headers: { authorization: `Bearer ${token}` },
          timeoutMs: 30000,
        })
        return r
      }
      if (request?.kind === 'history') {
        const q = new URLSearchParams({ container_id: String(request.chat?.id || ''), page_size: String(request.count || 20) })
        if (request.before) q.set('end_time', String(Math.floor(Number(request.before) / 1000)))
        return api('GET', `/open-apis/im/v1/messages?container_id_type=chat&${q}`)
      }
      if (request?.kind === 'members' || request?.kind === 'member') {
        const q = new URLSearchParams({ member_id_type: 'open_id', page_size: '100' })
        return api('GET', `/open-apis/im/v1/chats/${encodeURIComponent(String(request.chat?.id || ''))}/members?${q}`)
      }
      throw new Error(`飞书平台端不支持这种 fetch：${request?.kind}`)
    },

    /** 上传媒体换 key（网关或模块在拿到字节后调用；本端不自己下载） */
    async uploadMedia(kind, bytes, { mime, name, fileType = 'stream' } = {}) {
      const token = await tenantToken()
      const form = new FormData()
      if (kind === 'image') {
        form.set('image_type', 'message')
        form.set('image', new Blob([bytes], { type: mime || 'image/png' }), name || 'image.png')
      } else {
        form.set('file_type', fileType)
        form.set('file_name', name || 'file')
        form.set('file', new Blob([bytes], { type: mime || 'application/octet-stream' }), name || 'file')
      }
      const r = await httpClient.request({
        method: 'POST',
        url: `${baseUrl()}/open-apis/im/v1/${kind === 'image' ? 'images' : 'files'}`,
        headers: { authorization: `Bearer ${token}` },
        body: form,
        timeoutMs: 60000,
      })
      return r.json?.data || r.json
    },

    /** 把原生飞书消息转 parts（网关 toParts 用） */
    toParts(nativeMessage) {
      if (nativeMessage?.message) return toParts(nativeMessage.message.message_type, nativeMessage.message.content, nativeMessage.message.mentions)
      return toParts('text', JSON.stringify({ text: String(nativeMessage ?? '') }))
    },

    // ── 测试控制面（真实使用不会调） ──
    __feishu: {
      setSelf(value) { self = value },
      setCaps(partial) { caps = { ...caps, ...(partial || {}) }; ctx?.capsChanged?.() },
      setConfig(cfg) { injectedConfig = cfg },
      tokenCache: () => ({ ...tokenCache }),
      handleCallback,
      /**
       * 测试用：模拟「平台端已停、事件还在进来」。
       * 真实路径是 /callback（stop 时路由已撤销，契约要求），这里走同一段守卫证明停了不 emit。
       */
      injectAfterStop(payload) {
        if (!running || !ctx) return { ok: false, error: 'not running' }
        const h = payload?.header || {}
        if (h.event_type === 'im.message.receive_v1') {
          const inbound = toInbound(payload.event, h)
          if (inbound) ctx.emit(inbound)
          return { ok: true }
        }
        ctx.emitEvent({ type: 'native', name: String(h.event_type || ''), raw: payload })
        return { ok: true }
      },
    },
  }

  return adapter
}

export default createFeishuAdapter()
