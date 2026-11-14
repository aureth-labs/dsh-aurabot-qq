// Aurabot 多平台 · 飞书平台端（F1 产出）
// 来源：Aurabot 多平台化 F1 工作包。许可：MIT（随本仓库）。
// 契约依据：src/gateway/contracts.d.ts（PlatformAdapter / Caps / Part / SendError）
//          ＋ docs/CONTRACTS.md §六（入站）§七（出站）§八（能力表 / 被动回复）。
// 官方文档核对结论、逐条链接、权限清单、未确认点：**docs/ADAPTER-FEISHU.md**。
//
// ───────────────────────── 两种收事件方式（默认长连接） ─────────────────────────
//
// 官方两条路都支持，本端都实现了：
//
//   ① 长连接（transport='websocket'，**默认**）
//      官方原话：「长连接是飞书 SDK 内提供的能力……与开放平台建立一条 WebSocket 全双工通道
//      （你的服务器需要能够访问公网）」。优势是**不需要公网 IP / 域名 / 内网穿透**，
//      而且「长连接方式内置了通信加密和鉴权的逻辑……无需额外解密、验签」。
//      —— https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case
//
//   ② Webhook（transport='webhook'）
//      自建 HTTP 服务收 POST，需要「IPv4 + 公网可访问」地址，并自己做验签/解密。
//      —— https://open.feishu.cn/document/event-subscription-guide/event-subscriptions/event-subscription-configure-/choose-a-subscription-mode/send-notifications-to-developers-server
//
// **依赖说明（重要）**：长连接官方推荐装 `@larksuiteoapi/node-sdk` 用它的 WSClient。
// 本仓库铁律是「能不加依赖就不加」，所以本端按官方协议自己实现了一遍，**package.json 未改动**：
//
//   1) 端点发现：POST /callback/ws/endpoint，body `{ AppID, AppSecret }`，
//      返回 `data.URL` 与 `data.ClientConfig.PingInterval`（秒）。
//      **不能**直接连 wss://open.feishu.cn/event/ws —— 那不是 WS 端点，只会回 HTTP 200 + JSON。
//   2) 数据帧是 protobuf（官方 Go SDK 的 pbbp2.Frame），字段号：
//        1 SeqID(varint) 2 LogID(varint) 3 service(varint) 4 method(varint)
//        5 headers(repeated Header{1:key,2:value}) 6 payload_encoding(string)
//        7 payload_type(string) 8 payload(bytes) 9 LogIDNew(string)
//      —— https://pkg.go.dev/github.com/larksuite/oapi-sdk-go/v3/ws （Frame / Header / const.go）
//   3) method=1 是数据帧：解析 payload(JSON) → 处理 → 回一个同 SeqID 的应答帧，
//      payload 为 `{"code":200,"headers":{}}`。官方要求 **3 秒内**响应，否则超时重推。
//   4) 心跳：按 ClientConfig.PingInterval 发 method=0、header type=ping 的控制帧。
//
// Node >= 22 自带全局 WebSocket，所以长连接**不需要** ws 包。
// 自己实现 protobuf 编解码有风险（未与真实服务器联调，见文档「未确认点」第 1 条），
// 所以想稳妥可以切 transport='webhook'——那条路完全按文档实现，且被测试覆盖。
//
// ───────────────────────── 身份：open_id 按应用变，union_id 跨应用不变 ─────────────────────────
// 官方：open_id「标识一个用户在某个应用中的身份。同一个用户在不同应用中的 Open ID 不同」；
//      union_id「标识一个用户在某个应用开发商下的身份……同一用户在同一开发商下的应用中的
//      Union ID 是相同的」。
// —— https://open.feishu.cn/document/server-docs/im-v1/message/create
// 所以本端：account 用 open_id（发消息要用它），alt 存 union_id（换应用后靠 I1 的 alt 找回同一个人）。
//
// ───────────────────────── 三条硬规则 ─────────────────────────
//   1. 验签不过绝不 emit（Webhook）。有 Encrypt Key 就必须过 sha256 签名校验；没有就靠
//      Verification Token 核对来源。长连接由握手阶段鉴权，但仍会核对 header.token。
//   2. 语音必须是 opus。im/v1/files 的 file_type=opus 是硬要求，其他格式得自己转码。
//      所以 caps.voice 报 'file'，只有媒体本来就是 opus 才发成语音条（msg_type=audio）。
//   3. 主动消息不是「能发就发」。用户在应用可用范围外 → 230013；屏蔽机器人 → 230053；
//      机器人不在群里 → 230002。这些都按 not-sent 分类，绝不谎报成功。

import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto'

// ───────────────────────── 平台常量（全部来自官方文档，见 ADAPTER-FEISHU.md） ─────────────────────────

/** 飞书开放平台域名；国际版 Lark 是 https://open.larksuite.com（settings 可改） */
export const DEFAULT_BASE_URL = 'https://open.feishu.cn'

/** 自建应用换 tenant_access_token（POST body { app_id, app_secret }，有效期 7200 秒） */
export const PATH_TENANT_TOKEN = '/open-apis/auth/v3/tenant_access_token/internal'
/** 发送消息（POST，query receive_id_type）—— /open-apis/im/v1/messages */
export const PATH_SEND_MESSAGE = '/open-apis/im/v1/messages'
/** 上传图片（multipart，image_type=message|avatar）→ image_key */
export const PATH_UPLOAD_IMAGE = '/open-apis/im/v1/images'
/** 上传文件（multipart，file_type + file_name + file）→ file_key */
export const PATH_UPLOAD_FILE = '/open-apis/im/v1/files'
/** 机器人自身信息（GET）→ bot.open_id / bot.app_name */
export const PATH_BOT_INFO = '/open-apis/bot/v3/info'
/** 长连接端点发现（POST body { AppID, AppSecret }）→ data.URL / data.ClientConfig */
export const PATH_WS_ENDPOINT = '/callback/ws/endpoint'

/** 上传文件上限 30MB / 上传图片上限 10MB（官方「上传文件」「上传图片」使用限制） */
export const MAX_FILE_BYTES = 30 * 1024 * 1024
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
/** 单条文本消息请求体上限 150KB（官方「发送消息内容结构」注意事项） */
export const MAX_TEXT_BYTES = 150 * 1024
/** 自动分条的默认字符数：远低于 150KB，但几千字一条在客户端也不好读 */
export const DEFAULT_TEXT_CHARS = 4000

/** 飞书没有「一条消息只能回 N 条」的限制，也没有被动回复窗口 */
export const REPLIES_PER_MESSAGE = 0
export const REPLY_WINDOW_MS = 0

/**
 * 这些错误码 = 平台明确拒绝 → certainty='not-sent'（确定没发出去，可入补发队列/换方式重发）。
 * 全部抄自官方「发送消息」「上传文件」「上传图片」的错误码表。
 */
export const NOT_SENT_CODES = new Set([
  '230001', // 请求参数无效
  '230002', // 机器人不在群里（The bot can not be outside the group）
  '230006', // 未启用机器人能力
  '230013', // 用户不在应用可用范围 / 已离职 / 被禁用
  '230015', // 不能分享单聊名片
  '230017', // 只能发送自己上传的文件
  '230018', // 群设置禁止（如仅指定成员可发言）
  '230019', // 话题不存在
  '230020', // 触发频率限制
  '230022', // 内容含敏感信息
  '230025', // 消息体超长（文本 150KB / 卡片富文本 30KB）
  '230027', // 缺少必要权限
  '230028', // 数据防泄漏审查未通过
  '230029', // 用户已离职
  '230034', // receive_id 无效
  '230035', // 无发送权限（禁言 / 被屏蔽 / 租户管控）
  '230038', // 跨租户单聊禁止
  '230049', // 消息正在发送中
  '230053', // 用户已设置不再接收机器人消息
  '230054', // 私有互通群不支持该消息类型
  '230055', // 文件上传类型与发送类型不匹配
  '230099', // 创建卡片内容失败
  '234001', // 上传参数无效
  '234002', // 上传鉴权失败
  '234006', // 文件/图片超出大小限制
  '234007', // 未启用机器人能力
  '234010', // 空文件
  '234011', // 图片格式不支持
  '234039', // 图片分辨率超限
])

/** token 失效：强制换一次再重试 */
const TOKEN_INVALID_CODES = new Set(['99991663', '99991661', '99991668'])

/** 连都没连上的底层错误码 → 确定没发出去 */
const CONNECT_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ERR_INVALID_URL'])

/** 图片扩展名 → multipart 的 Content-Type（官方只认 JPG/JPEG/PNG/WEBP/GIF/BMP/ICO/TIFF/HEIC） */
const IMAGE_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', bmp: 'image/bmp', ico: 'image/x-icon', tiff: 'image/tiff', heic: 'image/heic',
}

/** im/v1/files 的 file_type 枚举；表里没有的按 'stream'（官方 Python 示例用的就是 stream） */
const FILE_TYPE_BY_EXT = {
  pdf: 'pdf', doc: 'doc', docx: 'doc', xls: 'xls', xlsx: 'xls', ppt: 'ppt', pptx: 'ppt',
  mp4: 'mp4', opus: 'opus',
}

// ───────────────────────── 错误分类 ─────────────────────────

function sendError(certainty, code, instance, message) {
  const error = new Error(message || `飞书发送失败（${certainty}${code ? ' / ' + code : ''}）`)
  error.certainty = certainty
  if (code) error.code = code
  error.instance = instance
  return error
}

/** 最保守的能力表：连上之前按这个报（CONTRACTS §八.1） */
export const CAPS_CONSERVATIVE = {
  image: false, sticker: false, voice: false, video: false, file: false, maxFileBytes: 0,
  quoteReply: false, mention: false, mentionAll: false, poke: false, typing: false,
  recall: false, card: false, listenAllInGroup: false, proactive: 'none',
  replyWindowMs: 0, repliesPerMessage: 0, history: false, memberList: false, forwardExpand: false,
}

/**
 * 按官方能力填的表（逐项依据见 docs/ADAPTER-FEISHU.md §四）。
 *   · voice: 'file'  —— 语音条必须 opus（file_type=opus），其他格式要先转码，本端不转码
 *   · sticker: false —— 只能重发「机器人收到的那个 file_key」，通用表情包发不了 → 降级成图片
 *   · listenAllInGroup: false —— 旁听全群要敏感权限 im:message.group_msg，默认按收不到报
 *   · proactive: 'free' —— 飞书没有被动回复窗口，可用范围内可随时发；
 *     频控（230020）与用户屏蔽（230053）由错误分类兜住，不是「额度」概念
 */
export const CAPS_FEISHU = {
  image: true,
  sticker: false,
  voice: 'file',
  video: true,
  file: true,
  maxFileBytes: MAX_FILE_BYTES,
  quoteReply: true,   // /im/v1/messages/:message_id/reply 就是引用回复
  mention: true,      // 文本里 <at user_id="ou_xxx">名字</at>
  mentionAll: true,   // <at user_id="all"></at>
  poke: false,        // 飞书没有戳一戳
  typing: false,
  recall: false,      // 官方有撤回接口，本端没实现，不声明
  card: true,         // interactive 卡片
  listenAllInGroup: false,
  proactive: 'free',
  replyWindowMs: REPLY_WINDOW_MS,
  repliesPerMessage: REPLIES_PER_MESSAGE,
  history: false,     // 有历史消息接口，本端没实现
  memberList: false,  // 有群成员接口，本端没实现
  forwardExpand: false, // 合并转发要用「获取指定消息的内容」展开，未实现
}

// ───────────────────────── 加解密 / 验签 ─────────────────────────

/**
 * 解飞书的事件加密包（encrypt 字段）。
 * 官方原理（「加密原理」）：AES-256-CBC；key = SHA256(Encrypt Key)；PKCS7Padding；
 * 密文 = base64(iv(16 字节随机数) + encrypted_event)。
 * —— https://open.feishu.cn/document/event-subscription-guide/event-subscriptions/event-subscription-configure-/choose-a-subscription-mode/send-notifications-to-developers-server
 * 官方示例向量（"test key" → "hello world"）在 test/adapters/feishu.test.js 里有断言。
 */
export function decryptEvent(encryptKey, encrypted) {
  const key = createHash('sha256').update(String(encryptKey), 'utf8').digest()
  const raw = Buffer.from(String(encrypted), 'base64')
  if (raw.length <= 16) throw new Error('加密包太短，解不开')
  const iv = raw.subarray(0, 16)
  const data = raw.subarray(16)
  const decipher = createDecipheriv('aes-256-cbc', key, iv)
  decipher.setAutoPadding(false)
  let out = Buffer.concat([decipher.update(data), decipher.final()])
  // 官方 Java/Go 示例是 NOPADDING + 手工去填充；这里手工校验，填充不对就说明 key 错了
  const pad = out.length ? out[out.length - 1] : 0
  if (pad < 1 || pad > 16 || pad > out.length) throw new Error('填充不合法，Encrypt Key 可能不匹配')
  for (let i = out.length - pad; i < out.length; i++) {
    if (out[i] !== pad) throw new Error('填充不合法，Encrypt Key 可能不匹配')
  }
  out = out.subarray(0, out.length - pad)
  return out.toString('utf8')
}

/**
 * 验签：X-Lark-Signature = sha256(timestamp + nonce + encryptKey + body) 的十六进制小写。
 * 官方六种语言示例一致；注意 body 必须是**原始字符串**，不能反序列化后重新序列化
 * （空格、键序都会变，签名必然对不上）。
 * —— https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case
 */
export function calculateSignature(timestamp, nonce, encryptKey, rawBody) {
  return createHash('sha256')
    .update(String(timestamp ?? ''))
    .update(String(nonce ?? ''))
    .update(String(encryptKey ?? ''))
    .update(typeof rawBody === 'string' ? rawBody : String(rawBody ?? ''))
    .digest('hex')
}

/** verifySignature({ timestamp, nonce, encryptKey, body, signature }) —— 定长比较，防计时侧信道 */
export function verifySignature({ timestamp, nonce, encryptKey, body, signature }) {
  if (!signature) return false
  const expected = calculateSignature(timestamp, nonce, encryptKey, body)
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(String(signature), 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// ───────────────────────── 长连接的 protobuf 帧编解码（pbbp2.Frame） ─────────────────────────

function writeVarint(value) {
  let n = BigInt(value)
  const bytes = []
  do {
    let b = Number(n & 0x7fn)
    n >>= 7n
    if (n > 0n) b |= 0x80
    bytes.push(b)
  } while (n > 0n)
  return Buffer.from(bytes)
}

const writeTag = (field, wireType) => writeVarint((BigInt(field) << 3n) | BigInt(wireType))

function writeLenDelimited(field, value) {
  const b = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')
  return Buffer.concat([writeTag(field, 2), writeVarint(b.length), b])
}

const encodeHeader = (h) => Buffer.concat([
  writeLenDelimited(1, h?.key ?? ''),
  writeLenDelimited(2, h?.value ?? ''),
])

/**
 * 编码 pbbp2.Frame。字段号对照官方 Go SDK（见文件头第 2 条）。
 * frame: { SeqID, LogID, Service, Method, Headers:[{key,value}], PayloadEncoding, PayloadType, Payload, LogIDNew }
 */
export function encodeFrame(frame = {}) {
  const parts = []
  if (frame.SeqID != null) parts.push(writeTag(1, 0), writeVarint(frame.SeqID))
  if (frame.LogID != null) parts.push(writeTag(2, 0), writeVarint(frame.LogID))
  if (frame.Service != null) parts.push(writeTag(3, 0), writeVarint(frame.Service))
  if (frame.Method != null) parts.push(writeTag(4, 0), writeVarint(frame.Method))
  for (const h of frame.Headers || []) parts.push(writeLenDelimited(5, encodeHeader(h)))
  if (frame.PayloadEncoding) parts.push(writeLenDelimited(6, frame.PayloadEncoding))
  if (frame.PayloadType) parts.push(writeLenDelimited(7, frame.PayloadType))
  if (frame.Payload) parts.push(writeLenDelimited(8, frame.Payload))
  if (frame.LogIDNew) parts.push(writeLenDelimited(9, frame.LogIDNew))
  return Buffer.concat(parts)
}

function readVarint(buf, offset) {
  let result = 0n
  let shift = 0n
  for (let i = offset; i < buf.length; i++) {
    const b = buf[i]
    result |= BigInt(b & 0x7f) << shift
    if ((b & 0x80) === 0) return [result, i + 1]
    shift += 7n
    if (shift > 63n) throw new Error('varint 过长')
  }
  throw new Error('varint 截断')
}

/** 解码 pbbp2.Frame；数值超出安全整数时保留 BigInt 字符串 */
export function decodeFrame(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input)
  const frame = { SeqID: 0, LogID: 0, Service: 0, Method: 0, Headers: [] }
  let offset = 0
  while (offset < buf.length) {
    const [tagValue, afterTag] = readVarint(buf, offset)
    offset = afterTag
    const field = Number(tagValue >> 3n)
    const wireType = Number(tagValue & 0x7n)
    if (wireType === 0) {
      const [value, after] = readVarint(buf, offset)
      offset = after
      const num = value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString()
      if (field === 1) frame.SeqID = num
      else if (field === 2) frame.LogID = num
      else if (field === 3) frame.Service = num
      else if (field === 4) frame.Method = num
    } else if (wireType === 2) {
      const [lenBig, afterLen] = readVarint(buf, offset)
      const len = Number(lenBig)
      offset = afterLen
      const chunk = buf.subarray(offset, offset + len)
      offset += len
      if (field === 5) {
        const header = { key: '', value: '' }
        let p = 0
        while (p < chunk.length) {
          const [t2, a2] = readVarint(chunk, p)
          p = a2
          const f2 = Number(t2 >> 3n)
          if (Number(t2 & 0x7n) !== 2) break
          const [l2big, al2] = readVarint(chunk, p)
          const l2 = Number(l2big)
          p = al2
          const val = chunk.subarray(p, p + l2).toString('utf8')
          p += l2
          if (f2 === 1) header.key = val
          else if (f2 === 2) header.value = val
        }
        frame.Headers.push(header)
      } else if (field === 6) frame.PayloadEncoding = chunk.toString('utf8')
      else if (field === 7) frame.PayloadType = chunk.toString('utf8')
      else if (field === 8) frame.Payload = Buffer.from(chunk)
      else if (field === 9) frame.LogIDNew = chunk.toString('utf8')
    } else if (wireType === 5) offset += 4
    else if (wireType === 1) offset += 8
    else throw new Error(`不支持的 wire type：${wireType}`)
  }
  return frame
}

/** 取帧头（key 大小写按官方是小写，这里不敏感） */
function headerValue(frame, key) {
  const want = String(key).toLowerCase()
  for (const h of frame?.Headers || []) if (String(h.key).toLowerCase() === want) return h.value
  return undefined
}

// ───────────────────────── 文本分条 ─────────────────────────

/**
 * 把长文本切成若干条。飞书单条上限 150KB，但几千字一条在客户端也不好看，
 * 所以默认按 4000 字符切，优先在换行处断开；最后再按字节兜底（超长无空格串）。
 */
export function splitText(text, maxChars = DEFAULT_TEXT_CHARS) {
  const source = String(text ?? '')
  if (!source) return []
  // 下限 50：再小就没法读了；上限 20000：超过就该按字节兜底而不是按字符
  const limit = Math.max(50, Math.min(Number(maxChars) || DEFAULT_TEXT_CHARS, 20000))
  const chunks = []
  let rest = source
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit * 0.5) cut = limit // 前半段没换行就硬切
    else cut += 1 // 换行留给前一条，读起来更自然
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest) chunks.push(rest)

  const out = []
  for (const chunk of chunks) {
    if (Buffer.byteLength(chunk, 'utf8') <= MAX_TEXT_BYTES) { out.push(chunk); continue }
    let piece = ''
    for (const ch of chunk) {
      if (Buffer.byteLength(piece + ch, 'utf8') > MAX_TEXT_BYTES) { out.push(piece); piece = ch }
      else piece += ch
    }
    if (piece) out.push(piece)
  }
  return out
}

// ───────────────────────── ID 类型 ─────────────────────────

/**
 * 按 ID 前缀决定 receive_id_type（官方 ID 前缀约定）：
 *   ou_ → open_id（用户）  on_ → union_id  oc_ → chat_id（群）
 * 前缀认不出时退回调用方给的建议值。这样即使网关传进来的 chat.kind 与实际 ID 形态不符，
 * 也不会用错类型被飞书拒（错误码 230034 receive_id invalid）。
 * —— https://open.feishu.cn/document/server-docs/im-v1/message/create （receive_id_type 可选值）
 */
export function receiveIdTypeOf(value, fallback = 'open_id') {
  const v = String(value || '')
  if (v.startsWith('oc_')) return 'chat_id'
  if (v.startsWith('on_')) return 'union_id'
  if (v.startsWith('ou_')) return 'open_id'
  if (v.includes('@')) return 'email'
  return fallback
}

/** receiveIdTypeOf 的别名，语义更直白（老名字仍可用） */
export const detectReceiveIdType = (value) => receiveIdTypeOf(value)

// ───────────────────────── 内容转换（入站） ─────────────────────────

/** 从 mentions 里按 key（@_user_1）或 open_id 找一条 */
function findMention(mentions, { key, openId }) {
  for (const m of Array.isArray(mentions) ? mentions : []) {
    if (key && m?.key === key) return m
    if (openId && m?.id?.open_id === openId) return m
  }
  return null
}

/**
 * 飞书 message_type + content → 契约 parts。
 * 只翻译；认不出的给 `{type:'other'}` 占位，不猜、不丢。
 * options.messageId：给了就把 `messageId` 挂在 media 上（fetch 换字节要用它拼 resources 路径）。
 * options.selfOpenId：@到她自己的 mention 不进 parts（契约六.2，体现在 mentionedMe）。
 */
export function toParts(messageType, contentRaw, mentions, options = {}) {
  let content = {}
  try { content = typeof contentRaw === 'string' ? JSON.parse(contentRaw) : (contentRaw || {}) } catch { content = {} }
  const parts = []
  const selfOpenId = String(options.selfOpenId || '')
  const messageId = options.messageId ? String(options.messageId) : ''
  const media = (key, extra = {}) => (messageId ? { id: key, messageId, ...extra } : { id: key, ...extra })

  /** text 里的 @_user_N 占位符：按 mentions 映射，@自己的跳过 */
  const pushWithPlaceholders = (text) => {
    const source = String(text ?? '')
    if (!source) return
    const re = /@_user_\d+/g
    let last = 0
    let m
    while ((m = re.exec(source))) {
      if (m.index > last) parts.push({ type: 'text', text: source.slice(last, m.index) })
      const hit = findMention(mentions, { key: m[0] })
      const openId = String(hit?.id?.open_id || '')
      if (!selfOpenId || openId !== selfOpenId) {
        if (openId) parts.push({ type: 'mention', account: openId, name: hit?.name })
        else parts.push({ type: 'other', text: m[0], native: { placeholder: m[0] } })
      }
      last = m.index + m[0].length
    }
    if (last < source.length) parts.push({ type: 'text', text: source.slice(last) })
  }

  /** 富文本/卡片里的 <at user_id="…"></at> 标签：@自己的跳过 */
  const pushWithInlineAt = (text) => {
    const source = String(text ?? '')
    if (!source) return
    const re = /<at\s+user_id="([^"]*)"[^>]*>([\s\S]*?)<\/at>/g
    let last = 0
    let m
    while ((m = re.exec(source))) {
      if (m.index > last) parts.push({ type: 'text', text: source.slice(last, m.index) })
      const id = m[1]
      if (id === 'all') parts.push({ type: 'mention', account: 'all' })
      else if (!selfOpenId || id !== selfOpenId) parts.push({ type: 'mention', account: id, name: m[2] || undefined })
      last = m.index + m[0].length
    }
    if (last < source.length) parts.push({ type: 'text', text: source.slice(last) })
  }

  switch (messageType) {
    case 'text': {
      const text = String(content.text || '')
      // 群消息里正文是 `@_user_1 hello` + mentions 数组；单聊/富文本里可能是 <at> 标签
      if (/@_user_\d+/.test(text)) pushWithPlaceholders(text)
      else if (/<at\s/.test(text)) pushWithInlineAt(text)
      else parts.push({ type: 'text', text })
      break
    }

    case 'image':
      parts.push({ type: 'image', media: media(content.image_key, { mime: 'image/png' }) })
      break

    case 'file':
      parts.push({ type: 'file', media: media(content.file_key, { name: content.file_name }) })
      break

    case 'folder':
      // 文件夹只有 key + 名字，API 下不了
      parts.push({ type: 'other', text: `[文件夹 ${content.file_name || ''}]`.trim(), native: content })
      break

    case 'audio':
      parts.push({
        type: 'voice',
        media: media(content.file_key, { mime: 'audio/opus' }),
        durationMs: Number(content.duration) || undefined,
      })
      break

    case 'media':
      parts.push({ type: 'video', media: media(content.file_key, { mime: content.mime_type, name: content.file_name }) })
      break

    case 'sticker':
      // 官方：只能拿收到的 file_key 原样重发，不能下载
      parts.push({ type: 'sticker', media: media(content.file_key), label: '[表情]', native: content })
      break

    case 'post': {
      // 富文本：{ title, content: [[{tag, ...}]] }，也可能包一层 zh_cn
      const post = content.zh_cn || content.en_us || content
      if (post?.title) parts.push({ type: 'text', text: String(post.title) })
      const rows = post?.content
      for (const row of Array.isArray(rows) ? rows : []) {
        for (const el of Array.isArray(row) ? row : []) {
          switch (el?.tag) {
            case 'text': parts.push({ type: 'text', text: String(el.text ?? '') }); break
            case 'a': parts.push({ type: 'text', text: `${el.text || ''} ${el.href || ''}`.trim() }); break
            case 'md': pushWithInlineAt(el.text); break
            case 'at': {
              const id = String(el.user_id ?? '')
              if (id === 'all') parts.push({ type: 'mention', account: 'all' })
              else if (!selfOpenId || id !== selfOpenId) parts.push({ type: 'mention', account: id, name: el.user_name || undefined })
              break
            }
            case 'img': if (el.image_key) parts.push({ type: 'image', media: media(el.image_key) }); break
            case 'media': if (el.file_key) parts.push({ type: 'video', media: media(el.file_key) }); break
            case 'emotion': parts.push({ type: 'face', name: String(el.emoji_type ?? '表情') }); break
            case 'code_block': parts.push({ type: 'text', text: String(el.text ?? '') }); break
            case 'hr': break
            default: parts.push({ type: 'other', text: `[${el?.tag || '未知'}]`, native: el })
          }
        }
        parts.push({ type: 'text', text: '\n' })
      }
      if (!parts.length) parts.push({ type: 'other', text: '[富文本]', native: content })
      break
    }

    case 'interactive': {
      // 收到的卡片结构与发送时不同：{ title, elements:[[{tag,text|content,href}]] }
      const texts = []
      let url
      const walk = (nodes) => {
        for (const node of Array.isArray(nodes) ? nodes : []) {
          if (typeof node === 'string') { texts.push(node); continue }
          if (!node || typeof node !== 'object') continue
          if (typeof node.text === 'string') texts.push(node.text)
          if (typeof node.content === 'string') texts.push(node.content)
          if (node.href) url = url || String(node.href)
          // elements / 嵌套数组（卡片元素是 [[{...}]] 这种两层结构）都要继续往下走
          if (node.elements) walk(node.elements)
          else if (Array.isArray(node)) walk(node)
        }
      }
      walk(content.elements)
      const title = content.title ? String(content.title) : undefined
      const text = [title, ...texts].filter(Boolean).join('\n').trim() || '[卡片]'
      parts.push({ type: 'card', text, title, url, native: content })
      break
    }

    case 'merge_forward':
      // 官方：content 固定为 "Merged and Forwarded Message"，子消息要调「获取指定消息的内容」展开
      parts.push({ type: 'other', text: '[合并转发]', native: content })
      break

    case 'share_chat': parts.push({ type: 'other', text: '[群名片]', native: content }); break
    case 'share_user': parts.push({ type: 'other', text: '[个人名片]', native: content }); break

    case 'share_calendar_event':
    case 'calendar':
    case 'general_calendar':
      parts.push({ type: 'other', text: `[日程 ${content.summary || ''}]`.trim(), native: content })
      break

    case 'system': {
      // 系统消息是模板 + 变量，原样回模板文本，不猜
      const template = String(content.template ?? '')
      const rendered = template.replace(/\{(\w+)\}/g, (_, key) => {
        const v = content[key]
        if (Array.isArray(v)) return v.join('、')
        if (v && typeof v === 'object') return String(v.text ?? '')
        return String(v ?? '')
      })
      parts.push({ type: 'other', text: rendered || '[系统消息]', native: content })
      break
    }

    case 'location': parts.push({ type: 'other', text: `[位置 ${content.name || ''}]`.trim(), native: content }); break
    case 'video_chat': parts.push({ type: 'other', text: '[视频通话]', native: content }); break
    case 'todo': parts.push({ type: 'other', text: '[任务]', native: content }); break
    case 'vote': parts.push({ type: 'other', text: `[投票 ${content.topic || ''}]`.trim(), native: content }); break
    case 'hongbao': parts.push({ type: 'other', text: '[红包]', native: content }); break

    default:
      parts.push({ type: 'other', text: `[${messageType || '未知消息'}]`, native: content })
  }

  // 用 mentions 补齐正文里没解析到的（官方 mentions 与正文可能不同步）
  for (const mt of Array.isArray(mentions) ? mentions : []) {
    const openId = String(mt?.id?.open_id || '')
    if (!openId) continue
    if (selfOpenId && openId === selfOpenId) continue // @自己 不进 parts
    if (!parts.some((p) => p.type === 'mention' && p.account === openId)) {
      parts.push({ type: 'mention', account: openId, name: mt.name })
    }
  }

  // 去掉空文本、合并相邻文本
  const merged = []
  for (const part of parts) {
    if (part.type === 'text') {
      if (!part.text) continue
      const prev = merged[merged.length - 1]
      if (prev && prev.type === 'text') { prev.text += part.text; continue }
    }
    merged.push(part)
  }
  return merged
}

// ───────────────────────── 内容转换（出站） ─────────────────────────

/** 媒体是不是 opus（语音条的唯一合法格式） */
export function isOpusMedia(media) {
  const mime = String(media?.mime || '').toLowerCase()
  if (mime.includes('opus')) return true
  const name = String(media?.name || '').toLowerCase()
  return name.endsWith('.opus')
}

/**
 * 契约 parts → 飞书发送序列。
 * 一条飞书消息只能带一种 msg_type，所以文本/图片/文件/卡片各成一条。
 * 语音：本来就是 opus 才发 msg_type=audio，否则按文件发（caps.voice='file' 的诚实实现）。
 */
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
        sends.push({
          msgType: 'image',
          content: JSON.stringify({ image_key: p.media?.id || '' }),
          needsUpload: { kind: 'image', media: p.media },
        })
        break

      case 'sticker':
        // caps.sticker=false，网关会先降级成 image；真收到就按图片发
        flushText()
        sends.push({
          msgType: 'image',
          content: JSON.stringify({ image_key: p.media?.id || '' }),
          needsUpload: { kind: 'image', media: p.media },
        })
        break

      case 'voice':
        flushText()
        if (isOpusMedia(p.media)) {
          sends.push({
            msgType: 'audio',
            content: JSON.stringify({ file_key: p.media?.id || '' }),
            needsUpload: { kind: 'file', media: p.media, fileType: 'opus', durationMs: p.durationMs },
          })
        } else {
          // 非 opus：按音频文件发，绝不谎报成语音条
          sends.push({
            msgType: 'file',
            content: JSON.stringify({ file_key: p.media?.id || '' }),
            needsUpload: { kind: 'file', media: p.media, fileType: 'stream', durationMs: p.durationMs },
          })
        }
        break

      case 'video':
        flushText()
        sends.push({
          msgType: 'media',
          content: JSON.stringify({ file_key: p.media?.id || '' }),
          needsUpload: { kind: 'file', media: p.media, fileType: 'mp4' },
        })
        break

      case 'file': {
        flushText()
        const ext = String(p.media?.name || '').split('.').pop()?.toLowerCase() || ''
        sends.push({
          msgType: 'file',
          content: JSON.stringify({ file_key: p.media?.id || '' }),
          needsUpload: { kind: 'file', media: p.media, fileType: FILE_TYPE_BY_EXT[ext] || 'stream' },
        })
        break
      }

      case 'card':
        flushText()
        sends.push({ msgType: 'interactive', content: JSON.stringify(cardOf(p)) })
        break

      case 'poke':
      case 'forward':
        break // 平台没有对应物

      default:
        if (p.text) textBuf += String(p.text)
    }
  }
  flushText()
  return sends
}

/** 卡片：标题 + markdown 正文 + 可选链接按钮 */
function cardOf(part) {
  const elements = []
  if (part.text) elements.push({ tag: 'markdown', content: String(part.text) })
  if (part.url) {
    elements.push({
      tag: 'action',
      actions: [{
        tag: 'button',
        text: { tag: 'plain_text', content: part.title || '打开链接' },
        type: 'default',
        multi_url: { url: part.url, pc_url: part.url, android_url: part.url, ios_url: part.url },
      }],
    })
  }
  const card = { config: { wide_screen_mode: true }, elements }
  if (part.title) card.header = { title: { tag: 'plain_text', content: String(part.title) } }
  return card
}

/** 取媒体字节：bytes 直接用；path 读文件；url 下载（飞书的媒体必须先上传换 key） */
async function loadMediaBytes(media) {
  if (media?.bytes) return Buffer.from(media.bytes)
  if (media?.path) {
    const { readFile } = await import('node:fs/promises')
    return readFile(media.path)
  }
  if (media?.url) {
    const url = String(media.url)
    // 只接受 http(s)：file:// 之类不该在这里出现
    if (!/^https?:\/\//i.test(url)) throw new Error(`媒体 URL 不是 http(s)：${url}`)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`下载媒体失败：HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }
  throw new Error('媒体没有可取的内容（bytes / path / url 都没有）')
}

// ───────────────────────── 平台端 ─────────────────────────

/**
 * 建飞书平台端。
 * options.client     可注入的 HTTP 客户端（测试用假 client）；缺省用 fetch
 * options.wsFactory  (url) => WebSocketLike，长连接用；缺省用 Node >= 22 的全局 WebSocket
 * options.now        时钟
 */
export function createFeishuAdapter(options = {}) {
  const id = options.id || 'feishu'
  const name = options.name || '飞书'
  const now = typeof options.now === 'function' ? options.now : Date.now
  const wsFactory = typeof options.wsFactory === 'function'
    ? options.wsFactory
    : (url) => new globalThis.WebSocket(url)

  let ctx = null
  let instance = id
  let running = false
  let connected = false
  let stopped = false
  let capsState = { ...CAPS_CONSERVATIVE }
  let self = null
  let tokenCache = { token: '', expiresAt: 0 }
  let transport = 'websocket'
  let injectedConfig = null
  let capsOverride = null
  const offs = []

  // 长连接状态
  let ws = null
  let wsPingTimer = null
  let wsReconnectTimer = null
  let wsRetry = 0
  const sentFrames = [] // 测试断言应答/心跳帧用

  // 测试故障注入
  let failSend = null

  const config = () => {
    const fromCtx = typeof ctx?.config === 'function' ? ctx.config() || {} : {}
    return injectedConfig ? { ...injectedConfig, ...fromCtx } : fromCtx
  }
  const log = () => ctx?.log || { debug() {}, info() {}, warn() {}, error() {} }
  const baseUrl = () => String(config().baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const timeoutMsOf = () => Math.max(1, Number(config().timeoutMs) || 15000)

  /**
   * HTTP 客户端接缝：request({ method, url, headers, body, timeoutMs }) → { status, json }
   * 测试注入同形状的假 client 即可，不打真网络。
   */
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
    const t = now()
    if (!force && tokenCache.token && tokenCache.expiresAt - 60_000 > t) return tokenCache.token
    const { appId, appSecret } = config()
    if (!appId || !appSecret) throw sendError('not-sent', 'no-credentials', instance, '还没填 appId / appSecret')
    const r = await httpClient.request({
      method: 'POST',
      url: `${baseUrl()}${PATH_TENANT_TOKEN}`,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      timeoutMs: timeoutMsOf(),
    })
    // 官方：这个接口失败时 HTTP 可能仍是 200，必须看 body.code
    const code = Number(r.json?.code ?? -1)
    if (code !== 0 || !r.json?.tenant_access_token) {
      throw sendError('not-sent', `token-${code}`, instance, `取 tenant_access_token 失败：${r.json?.msg || r.status}`)
    }
    const expire = Number(r.json.expire) || 7200
    tokenCache = { token: r.json.tenant_access_token, expiresAt: t + expire * 1000 }
    return tokenCache.token
  }

  /** 带 token 的 API 调用（401 / token 失效码换一次 token 再试） */
  async function api(method, path, payload, { retried = false, timeoutMs } = {}) {
    const token = await tenantToken({ force: retried })
    const r = await httpClient.request({
      method,
      url: `${baseUrl()}${path}`,
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      timeoutMs: timeoutMs || timeoutMsOf(),
    })
    const code = Number(r.json?.code ?? 0)
    if ((r.status === 401 || TOKEN_INVALID_CODES.has(String(code))) && !retried) {
      tokenCache = { token: '', expiresAt: 0 }
      return api(method, path, payload, { retried: true, timeoutMs })
    }
    return { status: r.status, code, json: r.json }
  }

  // ───────────────────────── 入站：事件 → AdapterInbound ─────────────────────────

  /** im.message.receive_v1 的 event → AdapterInbound */
  function toInbound(event, headerObj) {
    const msg = event?.message
    if (!msg) return null
    const senderId = event?.sender?.sender_id || {}
    const openId = String(senderId.open_id || '')
    const unionId = String(senderId.union_id || '')
    const isPrivate = msg.chat_type === 'p2p'
    const selfId = String(self?.account || '')

    const parts = toParts(msg.message_type, msg.content, msg.mentions, {
      selfOpenId: selfId,
      messageId: String(msg.message_id || ''),
    })

    // @机器人自己 → mentionedMe，且不进 parts（CONTRACTS §六.2）。
    // 判定看 mentions 数组：官方把被 @ 的人（含机器人）都列在这里，
    // 正文里是 `@_user_N` 占位符或 <at> 标签，靠 key/id 对回 mentions。
    // 注意 toParts 已经把「@自己」从 parts 里剔掉了，所以不能靠 parts 反推。
    const selfMention = selfId ? Boolean(findMention(msg.mentions, { openId: selfId })) : false

    // 私聊：会话就是「跟这个人的单聊」，chat.id 用对方 open_id（发消息也用 open_id）
    // 群聊/话题群：chat.id 用 chat_id（oc_ 开头）
    const chatId = isPrivate ? openId : String(msg.chat_id || '')
    if (!chatId) return null

    return {
      chat: { kind: isPrivate ? 'private' : 'group', id: chatId, title: msg.chat_name },
      sender: {
        account: openId,
        // 接收消息事件里没有发送者昵称（只有 mentions 里才有），空串不编造
        name: '',
        // 消息事件不带管理员/群主信息；私聊是空串，群里至少是成员
        role: isPrivate ? '' : 'member',
        alt: unionId || undefined,
      },
      // 官方：去重请用 message_id，不要依赖 event_id（可能重复推送）
      messageId: String(msg.message_id || headerObj?.event_id || ''),
      at: Number(msg.create_time) || now(),
      replyTo: msg.parent_id ? String(msg.parent_id) : undefined,
      // 私聊天然「就是在跟她说话」
      mentionedMe: isPrivate ? true : selfMention,
      parts: parts.length ? parts : [{ type: 'other', text: '[空消息]' }],
      // ext 只放平台专属、中枢用不上的东西（CONTRACTS §六.5）
      ext: {
        eventType: 'im.message.receive_v1',
        chatType: msg.chat_type,
        messageType: msg.message_type,
        senderType: event?.sender?.sender_type,
        rootId: msg.root_id,
        parentId: msg.parent_id,
        tenantKey: event?.sender?.tenant_key,
        openId,
        unionId: unionId || undefined,
      },
      raw: { schema: '2.0', header: headerObj, event },
    }
  }

  /** 处理一个已解析的事件体（长连接与 Webhook 共用） */
  function handleEventBody(payload) {
    if (!running || !ctx) return { ok: false, reason: 'not running' }
    const headerObj = payload?.header || {}
    const eventType = String(headerObj.event_type || '')

    // Verification Token 核对：事件头里带的就是它。
    // 长连接由握手阶段鉴权、Webhook 由签名鉴权，但两种通道都再核一次 token——
    // 配了 token 却收到别人的事件，说明订阅或凭证串了，宁可拒收也不写进记忆。
    const verifyToken = config().verificationToken
    if (verifyToken) {
      const got = String(headerObj.token || payload?.token || '')
      if (got !== String(verifyToken)) {
        log().warn('飞书事件 Verification Token 不匹配，已拒收（不 emit）')
        return { ok: false, reason: 'bad token' }
      }
    }

    // 机器人自己说的话不走 emit（契约六.4），走 self-sent
    const senderType = String(payload?.event?.sender?.sender_type || '')
    const senderOpenId = String(payload?.event?.sender?.sender_id?.open_id || '')
    const selfId = String(self?.account || '')
    if (senderType === 'bot' && selfId && senderOpenId === selfId) {
      const msg = payload?.event?.message
      if (msg?.message_id) {
        ctx.emitEvent({
          type: 'self-sent',
          chat: { kind: msg.chat_type === 'p2p' ? 'private' : 'group', id: String(msg.chat_id || '') },
          messageId: String(msg.message_id),
          parts: toParts(msg.message_type, msg.content, msg.mentions, { selfOpenId: selfId, messageId: String(msg.message_id) }),
          raw: payload,
        })
      }
      return { ok: true, emitted: false }
    }
    // 别的机器人发的：不进记忆，只当原生事件转给绑定平台的模块
    if (senderType === 'bot') {
      ctx.emitEvent({ type: 'native', name: eventType || 'bot-message', raw: payload })
      return { ok: true, emitted: false }
    }

    if (eventType === 'im.message.receive_v1') {
      const inbound = toInbound(payload.event, headerObj)
      if (inbound) { ctx.emit(inbound); return { ok: true, emitted: true } }
      return { ok: false, reason: 'untranslatable' }
    }

    // 其余事件（消息撤回、群成员变动、机器人进群……）→ native 事件
    if (eventType) {
      ctx.emitEvent({ type: 'native', name: eventType, raw: payload })
      return { ok: true, emitted: false }
    }
    return { ok: false, reason: 'no event_type' }
  }

  // ───────────────────────── Webhook ─────────────────────────

  function header(req, want) {
    const h = req?.headers || {}
    const key = Object.keys(h).find((k) => k.toLowerCase() === want)
    return key ? h[key] : undefined
  }

  /** 取原始 body（验签必须用原文，不能反序列化后重新序列化） */
  function rawBodyOf(req) {
    if (req == null) return ''
    if (Buffer.isBuffer(req.rawBody)) return req.rawBody.toString('utf8')
    if (typeof req.rawBody === 'string') return req.rawBody
    if (Buffer.isBuffer(req.body)) return req.body.toString('utf8')
    if (typeof req.body === 'string') return req.body
    if (req.body && typeof req.body === 'object') return JSON.stringify(req.body)
    return ''
  }

  function reply(res, status, payload) {
    if (!res) return
    res.statusCode = status
    if (typeof res.setHeader === 'function') res.setHeader('content-type', 'application/json; charset=utf-8')
    if (typeof res.end === 'function') res.end(payload === undefined ? undefined : JSON.stringify(payload))
  }

  /**
   * Webhook 回调。顺序不能省：
   *   1) 配了 Encrypt Key → 必须过签名校验
   *   2) 有 encrypt 字段 → 解密
   *   3) url_verification / challenge → 1 秒内原样回 challenge（不 emit）
   *   4) 事件分发（Verification Token 核对在 handleEventBody 里，长连接也走同一段）
   */
  function handleCallback(req, res) {
    const cfg = config()
    const raw = rawBodyOf(req)
    let bodyObj = null
    try { bodyObj = raw ? JSON.parse(raw) : null } catch { bodyObj = null }
    if (!bodyObj) return reply(res, 400, { ok: false, error: 'bad json' })

    // ① 验签
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
        log().warn('收到加密事件但没配 Encrypt Key，解不开')
        return reply(res, 400, { ok: false, error: 'no encrypt key' })
      }
      try {
        payload = JSON.parse(decryptEvent(cfg.encryptKey, bodyObj.encrypt))
      } catch (error) {
        log().warn('飞书事件解密失败：', error?.message || error)
        return reply(res, 401, { ok: false, error: 'decrypt failed' })
      }
    }

    // ③ 请求网址校验：challenge 原样返回
    if (payload?.challenge !== undefined) {
      // 没有 Encrypt Key 时，token 是唯一能核对来源的东西
      const verifyToken = cfg.verificationToken
      if (verifyToken && String(payload?.token || '') !== String(verifyToken)) {
        log().warn('飞书 URL 校验的 Verification Token 不匹配，已拒绝')
        return reply(res, 401, { ok: false, error: 'bad token' })
      }
      return reply(res, 200, { challenge: payload.challenge })
    }

    // ④ 分发
    if (!running) return reply(res, 200, { ok: true })
    const result = handleEventBody(payload)
    return reply(res, 200, { ok: true, emitted: Boolean(result.emitted) })
  }

  // ───────────────────────── 长连接 ─────────────────────────

  /**
   * 端点发现。必须走这一步：直接连 wss://open.feishu.cn/event/ws 只会拿到 HTTP 200 + JSON。
   * 官方 Go SDK：GenEndpointUri = "/callback/ws/endpoint"，body { AppID, AppSecret }。
   */
  async function discoverWsEndpoint() {
    const { appId, appSecret } = config()
    const r = await httpClient.request({
      method: 'POST',
      url: `${baseUrl()}${PATH_WS_ENDPOINT}`,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ AppID: appId, AppSecret: appSecret }),
      timeoutMs: timeoutMsOf(),
    })
    const data = r.json?.data || r.json
    const url = data?.URL || data?.url
    if (r.json?.code !== undefined && Number(r.json.code) !== 0 && !url) {
      throw new Error(`长连接端点发现失败：${r.json?.msg || r.json?.code}`)
    }
    if (!url) throw new Error(`长连接端点发现失败：${r.json?.msg || r.status || '没有返回 URL'}`)
    const pingSec = Number(data?.ClientConfig?.PingInterval ?? data?.ClientConfig?.ping_interval) || 120
    return { url: String(url), pingIntervalMs: Math.max(1000, pingSec * 1000) }
  }

  /** 发一帧（记录到 sentFrames 供测试断言） */
  function sendFrame(frame) {
    sentFrames.push(frame)
    if (!ws || typeof ws.send !== 'function') return
    try { ws.send(encodeFrame(frame)) } catch (error) { log().warn('飞书长连接发送帧失败：', error?.message || error) }
  }

  /** 处理收到的一帧 */
  function handleFrame(raw) {
    if (!running || stopped) return
    let frame
    try { frame = decodeFrame(raw) } catch (error) {
      log().warn('飞书长连接帧解析失败：', error?.message || error)
      return
    }
    const type = String(headerValue(frame, 'type') || '').toLowerCase()

    if (type === 'ping') {
      sendFrame({ Method: 0, Service: frame.Service, Headers: [{ key: 'type', value: 'pong' }] })
      return
    }
    if (type === 'pong') return
    if (frame.Method !== 1) return // 只处理数据帧

    let payload = null
    try { payload = frame.Payload ? JSON.parse(frame.Payload.toString('utf8')) : null } catch { payload = null }

    // 官方 WS SDK 会把原事件的 headers（message_id / trace_id / sum / seq / timestamp）
    // 原样带回，并补 biz_rt；只回 type=event 会被服务端当成对不上号，3 秒后记 timeout。
    const startedAt = Date.now()
    let handled = true
    try { if (payload) handleEventBody(payload) } catch (error) {
      handled = false
      log().warn('飞书长连接事件处理失败：', error?.message || error)
    }
    const responseHeaders = (frame.Headers || []).map((h) => ({ key: h.key, value: h.value }))
    responseHeaders.push({ key: 'biz_rt', value: String(Date.now() - startedAt) })

    sendFrame({
      SeqID: frame.SeqID,
      LogID: frame.LogID,
      Service: frame.Service,
      Method: frame.Method,
      Headers: responseHeaders,
      PayloadEncoding: 'json',
      PayloadType: 'json',
      Payload: JSON.stringify({ code: handled ? 200 : 500, headers: {}, data: null }),
    })
  }

  /** 建长连接；握手失败抛错（start 记启动失败） */
  async function connectWebsocket() {
    const { url, pingIntervalMs } = await discoverWsEndpoint()

    await new Promise((resolve, reject) => {
      let settled = false
      const finish = (error) => { if (settled) return; settled = true; error ? reject(error) : resolve() }
      const timer = setTimeout(() => finish(new Error('长连接建立超时')), Math.max(1000, Number(config().wsConnectTimeoutMs) || 15000))

      try {
        ws = wsFactory(url)
      } catch (error) {
        clearTimeout(timer)
        finish(error)
        return
      }
      if (!ws || typeof ws !== 'object') {
        clearTimeout(timer)
        finish(new Error('wsFactory 没有返回 WebSocket 对象'))
        return
      }

      ws.onopen = () => {
        clearTimeout(timer)
        wsRetry = 0
        connected = true
        ctx?.state('connected', '长连接已建立')
        if (wsPingTimer) clearInterval(wsPingTimer)
        wsPingTimer = setInterval(
          () => sendFrame({ Method: 0, Headers: [{ key: 'type', value: 'ping' }] }),
          pingIntervalMs,
        )
        if (wsPingTimer && typeof wsPingTimer.unref === 'function') wsPingTimer.unref()
        finish()
      }

      ws.onmessage = (event) => {
        const data = event?.data
        if (data == null) return
        if (Buffer.isBuffer(data)) handleFrame(data)
        else if (data instanceof ArrayBuffer) handleFrame(Buffer.from(data))
        else if (ArrayBuffer.isView(data)) handleFrame(Buffer.from(data.buffer, data.byteOffset, data.byteLength))
        else if (typeof data === 'string') handleFrame(Buffer.from(data, 'utf8'))
      }

      ws.onerror = () => {
        // 握手阶段报错：让 start 快速失败，而不是等到 15 秒超时
        if (!connected) { clearTimeout(timer); finish(new Error('长连接握手失败')) }
      }

      ws.onclose = () => {
        if (wsPingTimer) { clearInterval(wsPingTimer); wsPingTimer = null }
        if (!settled) {
          clearTimeout(timer)
          finish(new Error('长连接在握手阶段被关闭'))
          return
        }
        connected = false
        if (!running || stopped) return
        ctx?.state('disconnected', '长连接断开')
        scheduleReconnect()
      }
    })
  }

  /** 断线重连（指数退避，最多 60 秒一次）；stop 之后不再重连 */
  function scheduleReconnect() {
    if (!running || stopped || transport !== 'websocket' || wsReconnectTimer) return
    wsRetry += 1
    const delay = Math.min(60000, 1000 * 2 ** Math.min(5, wsRetry - 1))
    wsReconnectTimer = setTimeout(async () => {
      wsReconnectTimer = null
      if (!running || stopped) return
      try {
        ctx?.state('connecting', '长连接重连中')
        await connectWebsocket()
      } catch (error) {
        log().warn('飞书长连接重连失败：', error?.message || error)
        scheduleReconnect()
      }
    }, delay)
    if (wsReconnectTimer && typeof wsReconnectTimer.unref === 'function') wsReconnectTimer.unref()
  }

  function closeWebsocket() {
    if (wsPingTimer) { clearInterval(wsPingTimer); wsPingTimer = null }
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null }
    if (ws) {
      try { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null } catch {}
      try { ws.close?.() } catch {}
      ws = null
    }
    connected = false
  }

  // ───────────────────────── 媒体上传 ─────────────────────────

  /** 上传图片换 image_key（image_type=message） */
  async function uploadImage(media) {
    const bytes = await loadMediaBytes(media)
    if (!bytes.length) throw sendError('not-sent', 'empty-media', instance, '图片是空文件')
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw sendError('not-sent', 'too-large', instance, `图片 ${bytes.length} 字节超过飞书上限 10MB`)
    }
    const filename = String(media?.name || 'image.png')
    const ext = (filename.split('.').pop() || '').toLowerCase()
    const form = new FormData()
    form.set('image_type', 'message')
    form.set('image', new Blob([bytes], { type: media?.mime || IMAGE_MIME[ext] || 'application/octet-stream' }), filename)

    const token = await tenantToken()
    const r = await httpClient.request({
      method: 'POST',
      url: `${baseUrl()}${PATH_UPLOAD_IMAGE}`,
      headers: { authorization: `Bearer ${token}` },
      body: form,
      timeoutMs: timeoutMsOf(),
    })
    const data = r.json?.data || r.json || {}
    const key = data.image_key
    if (!key) throw classifyResponse(r, 'upload-failed')
    return String(key)
  }

  /** 上传文件换 file_key（语音要 file_type=opus） */
  async function uploadFile(media, { fileType = 'stream', durationMs } = {}) {
    const bytes = await loadMediaBytes(media)
    if (!bytes.length) throw sendError('not-sent', 'empty-media', instance, '文件是空文件')
    if (bytes.length > MAX_FILE_BYTES) {
      throw sendError('not-sent', 'too-large', instance, `文件 ${bytes.length} 字节超过飞书上限 30MB`)
    }
    const filename = String(media?.name || (fileType === 'opus' ? 'audio.opus' : 'file'))
    const form = new FormData()
    form.set('file_type', fileType)
    form.set('file_name', filename)
    if (durationMs) form.set('duration', String(Math.round(Number(durationMs))))
    form.set('file', new Blob([bytes], { type: media?.mime || 'application/octet-stream' }), filename)

    const token = await tenantToken()
    const r = await httpClient.request({
      method: 'POST',
      url: `${baseUrl()}${PATH_UPLOAD_FILE}`,
      headers: { authorization: `Bearer ${token}` },
      body: form,
      timeoutMs: timeoutMsOf(),
    })
    const data = r.json?.data || r.json || {}
    const key = data.file_key
    if (!key) throw classifyResponse(r, 'upload-failed')
    return String(key)
  }

  /** 把一次响应变成 SendError（拿不准必须 unknown） */
  function classifyResponse(r, fallbackCode = 'send-failed') {
    const code = r?.code != null ? String(r.code) : (r?.json?.code != null ? String(r.json.code) : '')
    const msg = String(r?.json?.msg || '')
    // 平台明确拒绝（权限/范围/限流/超长/格式）→ 确定没发出去
    if (code && NOT_SENT_CODES.has(code)) return sendError('not-sent', code, instance, `飞书拒绝：${msg || code}`)
    if (r?.status === 401 || r?.status === 403) return sendError('not-sent', code || 'unauthorized', instance, `鉴权失败或无权限：${msg}`)
    if (r?.status >= 400 && r.status < 500) {
      if (code) return sendError('not-sent', code, instance, `飞书拒绝：${msg || r.status}`)
      return sendError('unknown', `http-${r.status}`, instance, `飞书返回 ${r.status} 但没有可读错误码`)
    }
    // 5xx / 读不懂：不知道平台处理没处理，按 unknown（绝不重发）
    return sendError('unknown', code || fallbackCode || `http-${r?.status ?? 'unreadable'}`, instance, `响应不明：${msg || r?.status || '读不懂'}`)
  }

  /** 把一次请求异常翻成 SendError */
  function classifyThrown(error, code = 'send-failed') {
    if (error?.certainty) return error
    const name = String(error?.name || '')
    const message = String(error?.message || error)
    if (name === 'AbortError' || name === 'TimeoutError' || /timeout|aborted/i.test(message)) {
      return sendError('unknown', 'timeout', instance, '飞书请求超时（可能已发出，按 unknown 处理）')
    }
    const errCode = String(error?.code || error?.cause?.code || '')
    if (CONNECT_ERROR_CODES.has(errCode)) return sendError('not-sent', 'network', instance, '连不上飞书开放平台')
    return sendError('unknown', errCode || code, instance, `飞书请求失败：${message}`)
  }

  // ───────────────────────── 平台端契约 ─────────────────────────

  const adapter = {
    id,
    name,
    contract: 1,

    caps: () => ({ ...capsState, ...(capsOverride || {}) }),

    settings: [
      { key: 'appId', label: 'App ID', type: 'text', hint: '开发者后台 → 应用详情 → 凭证与基础信息（cli_ 开头）' },
      { key: 'appSecret', label: 'App Secret', type: 'password', hint: '与 App ID 配对；只用来换 tenant_access_token' },
      {
        key: 'transport', label: '事件订阅方式', type: 'select', options: ['websocket', 'webhook'], default: 'websocket',
        hint: 'websocket = 长连接（本机可出网即可，无需公网地址，官方推荐）；webhook = 需公网 HTTPS 地址 + 验签配置',
      },
      { key: 'encryptKey', label: 'Encrypt Key', type: 'password', hint: '事件与回调 → 加密策略。webhook 模式下填了才做签名校验与解密' },
      { key: 'verificationToken', label: 'Verification Token', type: 'password', hint: '事件与回调 → 加密策略。两种通道都会核对，防串号' },
      {
        key: 'listenAllInGroup', label: '接收群内全部消息', type: 'boolean', default: false,
        hint: '需要敏感权限 im:message.group_msg（或含机器人的 im:message.group_msg.include_bot:read）；没批下来就只能收到 @ 她的消息',
      },
      {
        key: 'maxTextChars', label: '单条文本上限（字符）', type: 'number', default: DEFAULT_TEXT_CHARS,
        hint: '超过就分条发；飞书硬上限是 150KB/条',
      },
      { key: 'baseUrl', label: 'API 域名', type: 'text', default: DEFAULT_BASE_URL, hint: 'Lark 国际版填 https://open.larksuite.com' },
      { key: 'selfOpenId', label: '机器人自身 open_id', type: 'text', hint: '可选。留空会在启动时用 /bot/v3/info 自动查' },
      { key: 'timeoutMs', label: '请求超时（毫秒）', type: 'number', default: 15000 },
    ],

    async start(gatewayCtx) {
      if (running) return
      ctx = gatewayCtx
      instance = String(ctx.instance || id)
      running = true
      stopped = false
      const cfg = config()

      // 用户配置只能把能力改小
      capsOverride = { ...(capsOverride || {}) }
      if (cfg.listenAllInGroup != null) capsOverride.listenAllInGroup = cfg.listenAllInGroup === true || cfg.listenAllInGroup === 'true'
      if (cfg.proactive === 'none' || cfg.proactive === 'limited') capsOverride.proactive = cfg.proactive

      transport = String(cfg.transport || 'websocket') === 'webhook' ? 'webhook' : 'websocket'

      // 缺凭证就别假装连上了（官方所有接口都要应用凭证）
      if (!cfg.appId || !cfg.appSecret) {
        connected = false
        ctx.state('unconfigured', '还没填 App ID / App Secret')
        running = false
        throw new Error('飞书平台端：缺少 App ID / App Secret，无法启动')
      }

      try {
        if (transport === 'webhook') {
          if (typeof ctx.route !== 'function') throw new Error('webhook 模式需要宿主提供 ctx.route')
          offs.push(ctx.route('/callback', handleCallback))
          offs.push(ctx.route('/event', handleCallback)) // 有人习惯配 /event
          await tenantToken() // 顺便验一次凭证
          connected = true
          capsState = { ...CAPS_FEISHU }
          ctx.capsChanged()
          ctx.state('connected', cfg.encryptKey ? 'Webhook 已就绪（验签+解密）' : 'Webhook 已就绪（未配 Encrypt Key，只能收明文）')
        } else {
          if (typeof globalThis.WebSocket !== 'function' && typeof options.wsFactory !== 'function') {
            throw new Error('长连接需要 WebSocket（Node >= 22 自带）；请升级 Node 或改用 transport=webhook')
          }
          await connectWebsocket() // 失败会抛，下面统一记启动失败
          capsState = { ...CAPS_FEISHU }
          ctx.capsChanged()
        }
      } catch (error) {
        running = false
        connected = false
        closeWebsocket()
        ctx.state(String(error?.message || '').includes('缺少') ? 'unconfigured' : 'disconnected', String(error?.message || error))
        throw error
      }

      // 连上后核对「登录的是不是配置里的那个机器人」
      try {
        const r = await api('GET', PATH_BOT_INFO)
        const bot = r.json?.bot || r.json?.data?.bot
        if (bot?.open_id) self = { account: String(bot.open_id), name: String(bot.app_name || '') }
      } catch (error) {
        log().warn('飞书：获取机器人自身信息失败：', error?.message || error)
      }
      if (!self?.account && cfg.selfOpenId) self = { account: String(cfg.selfOpenId), name: String(self?.name || '') }
      if (!self?.account) self = { account: `feishu-${cfg.appId || id}`, name: '飞书机器人' }
    },

    async stop() {
      if (!running) return
      running = false
      stopped = true
      for (const off of offs.splice(0)) { try { off() } catch {} }
      closeWebsocket()
      tokenCache = { token: '', expiresAt: 0 }
      ctx?.state('stopped')
    },

    /** 连上后核对身份：GET /open-apis/bot/v3/info → bot.open_id / bot.app_name（官方：无权限要求） */
    async whoami() {
      if (!self) {
        try {
          const r = await api('GET', PATH_BOT_INFO)
          const bot = r.json?.bot || {}
          self = { account: String(bot.open_id || bot.app_id || 'feishu-bot'), name: String(bot.app_name || '飞书机器人') }
        } catch {
          self = { account: 'feishu-bot', name: '飞书机器人' }
        }
      }
      return { ...self }
    },

    /**
     * 出站。一条飞书消息只能带一种 msg_type，多段拆成多次调用；
     * 超长文本按 maxTextChars 分条；媒体先上传换 key；语音只有 opus 才发成语音条。
     */
    async send(message = {}) {
      if (!running || !connected) throw sendError('not-sent', 'offline', instance, '飞书平台端未连接')
      const cfg = config()
      const chat = message.chat || {}
      const current = adapter.caps()

      // 被动回复的保险：改成 none 时，没有 inResponseTo 一律拒（网关也会先拦）
      if (current.proactive === 'none' && !message.inResponseTo) {
        throw sendError('not-sent', 'proactive-not-allowed', instance, '该实例被配置成只能被动回复')
      }

      // 测试注入故障（对应真实世界的「连不上 / 一直不返回」）
      if (failSend === 'refused') {
        failSend = null
        throw sendError('not-sent', 'platform-refused', instance, '飞书连接被拒绝')
      }
      if (failSend === 'timeout') {
        failSend = null
        throw sendError('unknown', 'timeout', instance, '飞书请求超时（可能已发出，按 unknown 处理）')
      }

      let sends = fromParts(message.parts || [])
      if (!sends.length) throw sendError('not-sent', 'nothing-to-send', instance, '没有可发送的内容')

      // 超限检查（有 size 就提前拦，不用等平台回 234006/230025）
      for (const p of message.parts || []) {
        const size = Number(p?.media?.size) || 0
        if (size && current.maxFileBytes > 0 && size > current.maxFileBytes) {
          throw sendError('not-sent', 'too-large', instance, `文件 ${size} 字节超过飞书上限 ${current.maxFileBytes}`)
        }
      }

      // 长文本分条：一条超 maxTextChars 的 text 拆成多条
      const maxChars = Number(cfg.maxTextChars) || DEFAULT_TEXT_CHARS
      sends = sends.flatMap((item) => {
        if (item.msgType !== 'text') return [item]
        const text = JSON.parse(item.content).text
        if (String(text).length <= maxChars) return [item]
        return splitText(text, maxChars).map((chunk) => ({ msgType: 'text', content: JSON.stringify({ text: chunk }) }))
      })

      const isGroup = chat.kind === 'group'
      // 引用回复：replyTo 优先（显式引用哪条），其次 inResponseTo（被动回复凭证）
      const replyTo = message.replyTo ? String(message.replyTo) : (message.inResponseTo ? String(message.inResponseTo) : '')
      const timeoutMs = Math.max(1, Number(message.timeoutMs) || timeoutMsOf())

      let lastMessageId = ''
      for (const item of sends) {
        // 需要先上传的媒体：网关只给 parts，不带 key
        if (item.needsUpload) {
          const media = item.needsUpload.media || {}
          const keyField = item.msgType === 'image' ? 'image_key' : 'file_key'
          const contentObj = JSON.parse(item.content)
          if (!contentObj[keyField] && media.id) {
            contentObj[keyField] = String(media.id) // 平台内标识直接当 key 用（入站拿到的就是它）
          }
          if (!contentObj[keyField] && (media.url || media.path || media.bytes)) {
            const key = item.needsUpload.kind === 'image'
              ? await uploadImage(media)
              : await uploadFile(media, { fileType: item.needsUpload.fileType, durationMs: item.needsUpload.durationMs })
            contentObj[keyField] = key
          }
          if (!contentObj[keyField]) {
            throw sendError('not-sent', 'media-needs-upload', instance,
              '媒体既没有平台内 key 也没有可取的位置（url/path/bytes）')
          }
          item.content = JSON.stringify(contentObj)
        }

        const payload = { msg_type: item.msgType, content: item.content }
        let r
        try {
          if (replyTo) {
            r = await api('POST', `/open-apis/im/v1/messages/${encodeURIComponent(replyTo)}/reply`, payload, { timeoutMs })
          } else {
            // receive_id_type 按 ID 前缀判定（ou_/on_/oc_），认不出才退回 kind
            const idType = receiveIdTypeOf(chat.id, isGroup ? 'chat_id' : 'open_id')
            r = await api('POST', `${PATH_SEND_MESSAGE}?receive_id_type=${idType}`, { receive_id: String(chat.id || ''), ...payload }, { timeoutMs })
          }
        } catch (error) {
          throw classifyThrown(error)
        }
        if (r.code !== 0) throw classifyResponse(r)
        lastMessageId = String(r.json?.data?.message_id || '')
      }
      if (!lastMessageId) throw sendError('unknown', 'no-message-id', instance, '飞书没返回 message_id（拿不准）')
      return { messageId: lastMessageId }
    },

    /** 取媒体字节：官方 GET /im/v1/messages/:message_id/resources/:file_key?type=image|file */
    async fetch(request) {
      if (request?.kind !== 'media') throw new Error(`飞书平台端不支持这种 fetch：${request?.kind}`)
      const media = request.media || {}
      const key = String(media.id || '')
      if (!key) throw new Error('飞书取媒体需要 media.id（file_key / image_key）')
      const messageId = String(media.messageId || '')
      if (!messageId) throw new Error('飞书取媒体需要 media.messageId（官方接口要消息 ID 才能定位资源）')
      const type = /^img_/.test(key) || String(media.mime || '').startsWith('image/') ? 'image' : 'file'
      const token = await tenantToken()
      return httpClient.request({
        method: 'GET',
        url: `${baseUrl()}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(key)}?type=${type}`,
        headers: { authorization: `Bearer ${token}` },
        timeoutMs: timeoutMsOf(),
      })
    },

    /** 上传媒体换 key（外部拿到字节后让平台端上传；本端不主动下载） */
    async uploadMedia(kind, bytes, { mime, name, fileType = 'stream', durationMs } = {}) {
      return kind === 'image'
        ? { image_key: await uploadImage({ bytes, mime, name }) }
        : { file_key: await uploadFile({ bytes, mime, name }, { fileType, durationMs }) }
    },

    /** 原生格式 → parts（接住外部传进来的飞书原生消息） */
    toParts(nativeMessage) {
      if (nativeMessage?.message) {
        return toParts(nativeMessage.message.message_type, nativeMessage.message.content, nativeMessage.message.mentions, {
          selfOpenId: String(self?.account || ''),
          messageId: String(nativeMessage.message.message_id || ''),
        })
      }
      return toParts('text', JSON.stringify({ text: String(nativeMessage ?? '') }), [], { selfOpenId: String(self?.account || '') })
    },
  }

  // ───────────────────────── 测试控制面（真实使用不会调） ─────────────────────────

  adapter.__feishu = {
    setSelf(value) { self = value },
    setCaps(partial) { capsState = { ...capsState, ...(partial || {}) }; ctx?.capsChanged?.() },
    setConfig(cfg) { injectedConfig = cfg },
    tokenCache: () => ({ ...tokenCache }),
    handleCallback,
    handleFrame,
    discoverWsEndpoint,
    sentFrames: () => sentFrames.slice(),
    transport: () => transport,
    /**
     * 测试用：模拟「平台端已停、事件还在进来」。
     * 真实路径是 /callback（stop 时路由已撤销）或长连接（已断开），这里走同一段守卫证明停了不 emit。
     */
    injectAfterStop(payload) {
      if (!running || !ctx) return { ok: false, error: 'not running' }
      return handleEventBody(payload)
    },
  }

  return adapter
}

export default createFeishuAdapter()
