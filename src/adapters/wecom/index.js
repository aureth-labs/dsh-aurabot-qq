// 平台端：企业微信智能机器人（WeCom AI Bot 官方 WebSocket 长连接，零第三方 npm 依赖）。
// 契约权威：src/gateway/contracts.d.ts（PlatformAdapter v1 / AdapterInbound / SendError / Caps / Feature）。
// 文档与限制见 docs/ADAPTER-WECOM.md。
//
// 硬边界（方案 §4 / §5.4）：
//   1. 与个人微信 wechat-clawbot 彻底隔离，也独立于企业微信自建应用 HTTP 回调（wecom-app）。
//   2. 只做协议翻译，不读 config.json、不查主人身份/白名单/共享会话。
//   3. aeskey 仅保存在适配器私有媒体缓存中，绝不写入 MediaRef / AdapterInbound.raw / 日志。
//   4. 收到 disconnected_event（新连接顶号）时不自动重连，避免互相踢线死循环。

import { createCipheriv, createDecipheriv, createHash, randomUUID } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPublicUrl } from '../../core/net.js'
import { createTitleCaseWebSocket, normalizeWsError } from '../../core/ws-client.js'
import { sanitizeFeaturesInput } from '../../gateway/features.js'
import { assertReplyCurrent, makeSendError } from '../../gateway/errors.js'
import { estimateAmrDurationMs, fallbackVoiceName, isAmrBytes } from '../../voice/audio-format.js'
import {
  checkMediaConstraints,
  extForMime,
  inferMimeFromBytes,
  readResponseBytesBounded,
  splitWechatText,
  transcodeAudioForWechat,
} from '../wechat-common/index.js'
import {
  createWecomAuthDriver,
  WECOM_QR_GENERATE_URL,
  WECOM_QR_POLL_URL,
} from './auth.js'

export const PLATFORM_ID = 'wecom'
export const DEFAULT_WECOM_WS_URL = 'wss://openws.work.weixin.qq.com'
export const DEFAULT_MAX_TEXT_CHARS = 6000
export const DEFAULT_MAX_TEXT_BYTES = 18_000
export const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024
export const DEFAULT_MAX_VOICE_BYTES = 2 * 1024 * 1024
export const DEFAULT_MAX_VOICE_DURATION_MS = 60_000
export const DEFAULT_TIMEOUT_MS = 15_000
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000
export const UPLOAD_CHUNK_SIZE = 512 * 1024
export const UPLOAD_MAX_CHUNKS = 100

export const WECOM_WS_CMD = Object.freeze({
  SUBSCRIBE: 'aibot_subscribe',
  HEARTBEAT: 'ping',
  RESPONSE: 'aibot_respond_msg',
  SEND_MSG: 'aibot_send_msg',
  UPLOAD_MEDIA_INIT: 'aibot_upload_media_init',
  UPLOAD_MEDIA_CHUNK: 'aibot_upload_media_chunk',
  UPLOAD_MEDIA_FINISH: 'aibot_upload_media_finish',
  CALLBACK: 'aibot_msg_callback',
  EVENT_CALLBACK: 'aibot_event_callback',
})

const MAX_REPLY_CONTEXT_ENTRIES = 1000
const MAX_MEDIA_CACHE_ENTRIES = 500
const MAX_QUOTE_CACHE_ENTRIES = 500
const MAX_MISSED_PONG = 2

/**
 * 企业微信智能机器人能力声明（全量 20 L1 Caps + 14 L2 Features；只报真实支持能力）。
 */
export const CAPS_WECOM = Object.freeze({
  image: true,
  sticker: false,
  voice: 'native',
  video: true,
  file: true,
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
  quoteReply: false,
  mention: false,
  mentionAll: false,
  poke: false,
  typing: false,
  recall: false,
  card: false,
  listenAllInGroup: false,
  proactive: 'free',
  replyWindowMs: 0,
  repliesPerMessage: 0,
  history: false,
  memberList: false,
  forwardExpand: false,
  features: Object.freeze({
    'message.quote.send': false,
    'message.quote.read': true,
    'message.history.read': false,
    'message.forward.expand': false,
    'message.recall': false,
    'message.reaction': false,
    'media.fetch': true,
    'chat.member.list': false,
    'chat.member.read': false,
    'chat.typing': false,
    'sticker.send.native': false,
    'sticker.collect': true,
    'sticker.sync.native': false,
    'card.send': false,
  }),
})

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function generateReqId(prefix) {
  return `${prefix}_${Date.now()}_${randomUUID().slice(0, 8)}`
}

function wecomTimestampMs(value, fallbackMs) {
  const n = typeof value === 'string' && value.trim() ? Number(value) : Number(value)
  if (!Number.isFinite(n) || n <= 0) return Math.trunc(fallbackMs)
  return Math.trunc(n < 10_000_000_000 ? n * 1000 : n)
}

function setBoundedMap(map, key, val, limit) {
  if (!key) return
  if (map.has(key)) map.delete(key)
  map.set(key, val)
  while (map.size > limit) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

function redactWecomSecrets(text, secrets = []) {
  let out = String(text || '')
  for (const s of secrets) {
    const v = String(s || '')
    if (v.length >= 4 && out.includes(v)) out = out.split(v).join('***')
  }
  return out
}

function sanitizeRawWecomFrame(obj) {
  if (!obj || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(sanitizeRawWecomFrame)
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (/aeskey|secret/i.test(k)) continue
    out[k] = sanitizeRawWecomFrame(v)
  }
  return out
}

function wsRawToText(ev) {
  const raw = ev && typeof ev === 'object' && 'data' in ev ? ev.data : ev
  if (typeof raw === 'string') return raw
  if (Buffer.isBuffer(raw)) return raw.toString('utf8')
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8')
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8')
  return String(raw ?? '')
}

function attachWsListeners(ws, { onOpen, onMessage, onClose, onError }) {
  if (typeof ws.addEventListener === 'function') {
    const hOpen = () => onOpen?.()
    const hMsg = (ev) => onMessage?.(wsRawToText(ev))
    const hClose = (ev) => onClose?.(ev?.code, ev?.reason)
    const hErr = (ev) => onError?.(normalizeWsError(ev, 'WebSocket 连接或握手失败'))
    ws.addEventListener('open', hOpen)
    ws.addEventListener('message', hMsg)
    ws.addEventListener('close', hClose)
    ws.addEventListener('error', hErr)
    return () => {
      try {
        ws.removeEventListener('open', hOpen)
        ws.removeEventListener('message', hMsg)
        ws.removeEventListener('close', hClose)
        ws.removeEventListener('error', hErr)
      } catch {}
    }
  }
  if (typeof ws.on === 'function') {
    const hOpen = () => onOpen?.()
    const hMsg = (data) => onMessage?.(wsRawToText(data))
    const hClose = (code, reason) => onClose?.(code, reason)
    const hErr = (err) => onError?.(normalizeWsError(err, 'WebSocket 连接或握手失败'))
    ws.on('open', hOpen)
    ws.on('message', hMsg)
    ws.on('close', hClose)
    ws.on('error', hErr)
    return () => {
      const off = ws.off || ws.removeListener
      if (typeof off === 'function') {
        try {
          off.call(ws, 'open', hOpen)
          off.call(ws, 'message', hMsg)
          off.call(ws, 'close', hClose)
          off.call(ws, 'error', hErr)
        } catch {}
      }
    }
  }
  throw new TypeError('企业微信 WebSocket 实例必须实现 addEventListener 或 on 方法')
}

/**
 * 使用企业微信智能机器人协议规范（AES-256-CBC + 32 字节块 PKCS#7 填充）解密媒体文件。
 */
export function decryptWecomFile(encryptedBuffer, aesKey) {
  const buf = Buffer.isBuffer(encryptedBuffer) ? encryptedBuffer : Buffer.from(encryptedBuffer || [])
  if (!buf.length) throw new Error('decryptWecomFile: encryptedBuffer 为空')
  const cleanKey = cleanString(aesKey)
  if (!cleanKey) throw new Error('decryptWecomFile: aesKey 不能为空')
  const key = Buffer.from(cleanKey, 'base64')
  if (key.length !== 32) throw new Error('decryptWecomFile: aesKey 解码后必须为 32 字节')
  const iv = key.subarray(0, 16)

  const decipher = createDecipheriv('aes-256-cbc', key, iv)
  // 企业微信规范采用 32 字节块 PKCS#7 填充；必须关闭 Node 默认 16 字节去填充并手动校验去除。
  decipher.setAutoPadding(false)
  const decrypted = Buffer.concat([decipher.update(buf), decipher.final()])
  if (!decrypted.length) throw new Error('decryptWecomFile: 解密结果为空')

  const padLen = decrypted[decrypted.length - 1]
  if (padLen < 1 || padLen > 32 || padLen > decrypted.length) {
    throw new Error(`decryptWecomFile: PKCS#7 填充长度无效（${padLen}）`)
  }
  for (let i = decrypted.length - padLen; i < decrypted.length; i++) {
    if (decrypted[i] !== padLen) {
      throw new Error('decryptWecomFile: PKCS#7 填充字节校验失败')
    }
  }
  return decrypted.subarray(0, decrypted.length - padLen)
}

/**
 * 使用与 decryptWecomFile 对称的 AES-256-CBC + 32 字节块 PKCS#7 填充加密数据（供测试与自检）。
 */
export function encryptWecomFile(plainBuffer, aesKey) {
  const plain = Buffer.isBuffer(plainBuffer) ? plainBuffer : Buffer.from(plainBuffer || [])
  const cleanKey = cleanString(aesKey)
  if (!cleanKey) throw new Error('encryptWecomFile: aesKey 不能为空')
  const key = Buffer.from(cleanKey, 'base64')
  if (key.length !== 32) throw new Error('encryptWecomFile: aesKey 解码后必须为 32 字节')
  const iv = key.subarray(0, 16)
  const padLen = 32 - (plain.length % 32)
  const padded = Buffer.concat([plain, Buffer.alloc(padLen, padLen)])
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(padded), cipher.final()])
}

function quoteTextSummary(quote) {
  if (!quote || typeof quote !== 'object') return ''
  if (quote.msgtype === 'text') return cleanString(quote.text?.content)
  if (quote.msgtype === 'markdown') return cleanString(quote.markdown?.content || quote.markdown?.text)
  if (quote.msgtype === 'stream') return cleanString(quote.stream?.content)
  if (quote.msgtype === 'template_card') {
    const tc = quote.template_card
    const bits = [
      cleanString(tc?.main_title?.title),
      cleanString(tc?.main_title?.desc),
      cleanString(tc?.sub_title_text),
      cleanString(tc?.quote_area?.quote_text),
    ].filter(Boolean)
    return bits.length ? bits.join(' - ') : '[卡片消息]'
  }
  if (quote.msgtype === 'voice') return cleanString(quote.voice?.content) || '[语音]'
  if (quote.msgtype === 'image') return '[图片]'
  if (quote.msgtype === 'video') return '[视频]'
  if (quote.msgtype === 'file') {
    const fn = cleanString(quote.file?.filename || quote.file?.file_name || quote.file?.name)
    return fn ? `[文件 ${fn}]` : '[文件]'
  }
  if (quote.msgtype === 'mixed' && Array.isArray(quote.mixed?.msg_item)) {
    const segs = []
    for (const it of quote.mixed.msg_item) {
      if (it?.msgtype === 'text' && cleanString(it.text?.content)) segs.push(cleanString(it.text.content))
      else if (it?.msgtype === 'image') segs.push('[图片]')
      else if (it?.msgtype === 'video') segs.push('[视频]')
      else if (it?.msgtype === 'voice') segs.push(cleanString(it.voice?.content) || '[语音]')
      else if (it?.msgtype === 'file') {
        const fn = cleanString(it.file?.filename || it.file?.file_name || it.file?.name)
        segs.push(fn ? `[文件 ${fn}]` : '[文件]')
      }
    }
    return segs.join(' ')
  }
  return ''
}

function extractWecomQuote(quote, { messageId, registerMedia } = {}) {
  if (!quote || typeof quote !== 'object' || Object.keys(quote).length === 0) return null
  const quoteParts = []
  let hasMedia = false
  let mediaSeq = 0

  const addQuoteMedia = (kind, obj) => {
    const url = cleanString(obj?.url)
    const aeskey = cleanString(obj?.aeskey)
    const name = cleanString(obj?.filename || obj?.file_name || obj?.name)
    const id = `wc_q_${messageId}_${mediaSeq++}`
    if (url && registerMedia) {
      registerMedia(id, { url, aeskey, kind, ...(name ? { name } : {}) })
    }
    return { id, url, name }
  }

  const qType = cleanString(quote.msgtype).toLowerCase()
  const pushFile = (fileObj) => {
    const { id, url, name } = addQuoteMedia('file', fileObj)
    if (url) {
      quoteParts.push({ type: 'file', media: { id, ...(name ? { name } : {}) } })
      hasMedia = true
    } else if (name) {
      quoteParts.push({ type: 'file', media: { name } })
    }
  }
  const pushVoice = (voiceObj) => {
    const { id, url } = addQuoteMedia('voice', voiceObj)
    if (url) {
      quoteParts.push({ type: 'voice', media: { id } })
      hasMedia = true
    }
    const txt = cleanString(voiceObj?.content)
    if (txt) quoteParts.push({ type: 'text', text: txt })
  }
  const pushVideo = (videoObj) => {
    const { id, url } = addQuoteMedia('video', videoObj)
    if (url) {
      quoteParts.push({ type: 'video', media: { id } })
      hasMedia = true
    } else {
      quoteParts.push({ type: 'video', media: {} })
    }
  }

  if (qType === 'image') {
    const { id, url } = addQuoteMedia('image', quote.image)
    if (url) {
      quoteParts.push({ type: 'image', media: { id } })
      hasMedia = true
    }
  } else if (qType === 'mixed' && Array.isArray(quote.mixed?.msg_item)) {
    for (const it of quote.mixed.msg_item) {
      if (!it || typeof it !== 'object') continue
      const itType = cleanString(it.msgtype).toLowerCase()
      if (itType === 'text') {
        const txt = cleanString(it.text?.content)
        if (txt) quoteParts.push({ type: 'text', text: txt })
      } else if (itType === 'image') {
        const { id, url } = addQuoteMedia('image', it.image)
        if (url) {
          quoteParts.push({ type: 'image', media: { id } })
          hasMedia = true
        }
      } else if (itType === 'file') {
        pushFile(it.file)
      } else if (itType === 'voice') {
        pushVoice(it.voice)
      } else if (itType === 'video') {
        pushVideo(it.video)
      }
    }
  } else if (qType === 'file') {
    pushFile(quote.file)
  } else if (qType === 'voice') {
    pushVoice(quote.voice)
  } else if (qType === 'video') {
    pushVideo(quote.video)
  } else {
    const s = quoteTextSummary(quote)
    if (s) quoteParts.push({ type: 'text', text: s })
  }

  const summary = quoteTextSummary(quote)
  const quoteId = cleanString(quote.msgid || quote.msg_id) || (quoteParts.length ? `wc_q_${messageId}` : '')
  const fetchedMessage = quoteId && quoteParts.length ? { messageId: quoteId, parts: quoteParts } : null
  return { quoteId, summary, fetchedMessage, hasMedia }
}

/**
 * 将企业微信 aibot_msg_callback 帧翻译为 AdapterInbound 或 self-sent 事件。
 */
export function parseWecomInbound(frame, { botId = '', now = () => Date.now(), registerMedia = null, registerQuote = null } = {}) {
  const body = frame?.body && typeof frame.body === 'object' ? frame.body : null
  if (!body) return null

  const chattype = cleanString(body.chattype || (body.chatid ? 'group' : 'single')).toLowerCase()
  const isGroup = chattype === 'group'
  const senderId = cleanString(body.from?.userid)
  const chatId = isGroup ? cleanString(body.chatid) : senderId
  const messageId = cleanString(body.msgid)
  if (!chatId || !senderId || !messageId) return null

  const chat = {
    kind: isGroup ? 'group' : 'private',
    id: chatId,
  }
  const msgtype = cleanString(body.msgtype).toLowerCase()
  const parts = []
  const redactedRaw = sanitizeRawWecomFrame(frame)

  const addMedia = (kind, obj) => {
    const url = cleanString(obj?.url)
    const aeskey = cleanString(obj?.aeskey)
    const name = cleanString(obj?.filename || obj?.file_name || obj?.name)
    const id = `wc_${messageId}_${parts.length}`
    if (url && registerMedia) {
      registerMedia(id, { url, aeskey, kind, ...(name ? { name } : {}) })
    }
    return { id, url, name }
  }

  const stripMention = (txt) => (isGroup ? String(txt || '').replace(/^\s*@\S+(?:\s+|$)/u, '').trim() : String(txt || '').trim())

  const quoteInfo = extractWecomQuote(body.quote, { messageId, registerMedia })
  if (quoteInfo?.summary) {
    parts.push({ type: 'text', text: `[引用：${quoteInfo.summary.replace(/\r?\n/g, ' ')}]\n` })
  } else if (quoteInfo) {
    parts.push({ type: 'text', text: '[引用：引用正文不可读]\n' })
  }

  if (msgtype === 'text') {
    const content = stripMention(body.text?.content)
    if (content) parts.push({ type: 'text', text: content })
  } else if (msgtype === 'voice') {
    let addedVoice = false
    if (cleanString(body.voice?.url)) {
      const { id } = addMedia('voice', body.voice)
      parts.push({ type: 'voice', media: { id } })
      addedVoice = true
    }
    const recognized = cleanString(body.voice?.content)
    if (recognized) {
      parts.push({ type: 'text', text: recognized })
      addedVoice = true
    }
    if (!addedVoice) {
      parts.push({ type: 'other', text: '[语音消息]', native: redactedRaw?.body })
    }
  } else if (msgtype === 'image') {
    const { id } = addMedia('image', body.image)
    parts.push({ type: 'image', media: { id } })
  } else if (msgtype === 'file') {
    const { id, name } = addMedia('file', body.file)
    parts.push({ type: 'file', media: { id, name: name || 'file' } })
  } else if (msgtype === 'video') {
    const { id } = addMedia('video', body.video)
    parts.push({ type: 'video', media: { id } })
  } else if (msgtype === 'mixed' && Array.isArray(body.mixed?.msg_item)) {
    for (const item of body.mixed.msg_item) {
      if (!item || typeof item !== 'object') continue
      if (item.msgtype === 'text') {
        const txt = stripMention(item.text?.content)
        if (txt) parts.push({ type: 'text', text: txt })
      } else if (item.msgtype === 'image') {
        const { id } = addMedia('image', item.image)
        parts.push({ type: 'image', media: { id } })
      }
    }
  }

  const normalizedParts = parts.length
    ? parts
    : [{ type: 'other', text: `[企业微信消息 ${msgtype || 'unknown'}]`, native: redactedRaw?.body }]

  if (cleanString(botId) && senderId === cleanString(botId)) {
    return {
      selfSent: true,
      event: {
        type: 'self-sent',
        chat: { kind: chat.kind, id: chat.id },
        messageId,
        parts: normalizedParts,
        raw: redactedRaw,
      },
    }
  }

  if (quoteInfo?.fetchedMessage && registerQuote) {
    registerQuote(quoteInfo.quoteId, quoteInfo.fetchedMessage)
  }

  const replyTo = quoteInfo?.quoteId || cleanString(body.quote?.msgid || body.quote?.msg_id)
  const inbound = {
    chat,
    sender: {
      account: senderId,
      name: cleanString(body.from?.name || body.from?.alias),
      role: isGroup ? 'member' : '',
    },
    messageId,
    at: wecomTimestampMs(body.create_time ?? body.createTime, now()),
    ...(replyTo ? { replyTo } : {}),
    mentionedMe: isGroup,
    parts: normalizedParts,
    raw: redactedRaw,
  }

  return {
    selfSent: false,
    quoteHasMedia: Boolean(quoteInfo?.hasMedia),
    inbound,
    replyContext: {
      reqId: cleanString(frame?.headers?.req_id),
      chatKind: chat.kind,
      chatId: chat.id,
      consumed: false,
      at: now(),
    },
  }
}

/**
 * 创建企业微信智能机器人 PlatformAdapter（contract v1）。
 */
export function createWecomAdapter(options = {}) {
  const id = cleanString(options.id) || PLATFORM_ID
  const name = cleanString(options.name) || '企业微信智能机器人'
  const clock = typeof options.now === 'function' ? options.now : () => Date.now()
  const resolveFetch = () => (typeof options.getFetch === 'function' ? options.getFetch() : null) || options.fetchImpl || globalThis.fetch
  const wsFactory = typeof options.createWebSocket === 'function'
    ? options.createWebSocket
    : (typeof options.getWebSocket === 'function' ? ((u) => options.getWebSocket()(u)) : ((u) => createTitleCaseWebSocket(u)))
  const verifyPublicUrl = typeof options.assertUrl === 'function' ? options.assertUrl : assertPublicUrl
  const resolveFfmpegPath = () => cleanString(typeof options.getFfmpegPath === 'function' ? options.getFfmpegPath() : options.ffmpegPath)
  const hasAllowedDirsOption = typeof options.allowedLocalDirs === 'function' || Array.isArray(options.allowedLocalDirs)
  const allowLocalPath = options.allowLocalPath !== false
  const heartbeatIntervalMs = Math.max(200, Number(options.heartbeatIntervalMs) || DEFAULT_HEARTBEAT_INTERVAL_MS)
  const connectTimeoutMs = Math.max(100, Number(options.connectTimeoutMs) || DEFAULT_CONNECT_TIMEOUT_MS)
  const reconnectBaseMs = Math.max(50, Number(options.reconnectBaseMs) || 1000)
  const reconnectMaxMs = Math.max(reconnectBaseMs, Number(options.reconnectMaxMs) || 30_000)

  let ctx = null
  let instance = id
  let running = false
  let connected = false
  let stopped = true
  let serverDisconnected = false
  let ws = null
  let detachWs = null
  let heartbeatTimer = null
  let reconnectTimer = null
  let reconnectAttempts = 0
  let missedPongCount = 0
  let connGen = 0
  let authWaiter = null
  let failSend = null
  let capsOverride = null
  let capsState = { ...CAPS_WECOM, features: { ...CAPS_WECOM.features } }
  let self = { account: '', name }

  const pendingAcks = new Map() // reqId -> { resolve, reject, timer }
  const replyContextCache = new Map()
  const mediaCache = new Map()
  const quoteCache = new Map()

  const cfgOf = () => ({ ...(adapter.__config || {}), ...(ctx?.config?.() || {}) })
  const botIdOf = () => cleanString(cfgOf().botId)
  const secretOf = () => cleanString(cfgOf().secret)
  const wsUrlOf = () => cleanString(cfgOf().wsUrl) || DEFAULT_WECOM_WS_URL
  const timeoutMsOf = () => Math.max(50, Number(cfgOf().timeoutMs) || DEFAULT_TIMEOUT_MS)
  const maxFileBytesOf = () => {
    const raw = Number(cfgOf().maxFileBytes)
    return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : DEFAULT_MAX_FILE_BYTES
  }
  const resolveAllowedDirs = () => {
    if (typeof options.allowedLocalDirs === 'function') return options.allowedLocalDirs() || []
    if (Array.isArray(options.allowedLocalDirs)) return options.allowedLocalDirs
    return []
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
    missedPongCount = 0
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function rejectAllPendingAcks(reasonErr) {
    for (const [reqId, pending] of pendingAcks) {
      clearTimeout(pending.timer)
      pending.reject(reasonErr)
      pendingAcks.delete(reqId)
    }
  }

  function closeWsOnly() {
    stopHeartbeat()
    if (detachWs) {
      try { detachWs() } catch {}
      detachWs = null
    }
    if (ws) {
      const target = ws
      ws = null
      try { target.close?.() } catch {}
    }
  }

  function sendWsFrame(frame) {
    if (!ws || typeof ws.send !== 'function') return false
    if (ws.readyState !== undefined && ws.readyState !== 1) return false
    try {
      ws.send(JSON.stringify(frame))
      return true
    } catch {
      return false
    }
  }

  function startHeartbeat() {
    stopHeartbeat()
    heartbeatTimer = setInterval(() => {
      if (!running || stopped || !connected) return
      if (missedPongCount >= MAX_MISSED_PONG) {
        connected = false
        rejectAllPendingAcks(makeSendError('unknown', 'heartbeat-timeout', instance, '企业微信心跳连续超时（按 unknown 处理）'))
        closeWsOnly()
        ctx?.state?.('disconnected', '企业微信长连接心跳超时，准备重连')
        scheduleReconnect()
        return
      }
      missedPongCount++
      sendWsFrame({
        cmd: WECOM_WS_CMD.HEARTBEAT,
        headers: { req_id: generateReqId(WECOM_WS_CMD.HEARTBEAT) },
      })
    }, heartbeatIntervalMs)
    heartbeatTimer.unref?.()
  }

  function sendWsCommand(cmd, body, { reqId = generateReqId(cmd), timeoutMs = timeoutMsOf() } = {}) {
    if (!running || stopped || !connected) {
      return Promise.reject(makeSendError('not-sent', 'not-connected', instance, '企业微信智能机器人未连接'))
    }
    const frame = { cmd, headers: { req_id: reqId }, body }
    return new Promise((resolveAck, rejectAck) => {
      const ms = Math.max(50, Number(timeoutMs) || timeoutMsOf())
      const timer = setTimeout(() => {
        pendingAcks.delete(reqId)
        rejectAck(makeSendError('unknown', 'timeout', instance, `企业微信 ${cmd} 等待回执超时（>${ms}ms，按 unknown 处理）`))
      }, ms)
      timer.unref?.()
      pendingAcks.set(reqId, { resolve: resolveAck, reject: rejectAck, timer })
      const ok = sendWsFrame(frame)
      if (!ok) {
        clearTimeout(timer)
        pendingAcks.delete(reqId)
        rejectAck(makeSendError('not-sent', 'ws-send-failed', instance, '企业微信 WebSocket 写入失败'))
      }
    })
  }

  function classifyWecomAckError(frame, cmd) {
    const code = Number(frame?.errcode ?? frame?.body?.errcode)
    if (!Number.isFinite(code) || code === 0) return null
    if (code === 48002) {
      return makeSendError('not-sent', 'permission-denied', instance, '企业微信智能机器人缺少该发送权限（errcode=48002）')
    }
    if (code === 45009) {
      return makeSendError('not-sent', 'rate-limited', instance, '企业微信发送触发频率限制（errcode=45009）')
    }
    return makeSendError('not-sent', `wecom-${code}`, instance, `企业微信拒绝 ${cmd}（errcode=${code}）`)
  }

  function handleInboundCallback(frame) {
    if (!running || stopped) return false
    const parsed = parseWecomInbound(frame, {
      botId: self.account || botIdOf(),
      now: clock,
      registerMedia: (idKey, entry) => setBoundedMap(mediaCache, idKey, entry, MAX_MEDIA_CACHE_ENTRIES),
      registerQuote: (qid, rec) => setBoundedMap(quoteCache, qid, rec, MAX_QUOTE_CACHE_ENTRIES),
    })
    if (!parsed) return false
    const rawQuote = frame?.body?.quote
    if (rawQuote && typeof rawQuote === 'object') {
      const safeFrame = sanitizeRawWecomFrame({
        cmd: frame?.cmd,
        headers: frame?.headers,
        body: {
          msgid: frame?.body?.msgid,
          msgtype: frame?.body?.msgtype,
          chattype: frame?.body?.chattype,
          quote: {
            msgid: rawQuote.msgid,
            msgtype: rawQuote.msgtype,
            keys: Object.keys(rawQuote).slice(0, 12),
          },
        },
      })
      ctx?.log?.debug?.('wecom.inbound.quote', {
        msgtype: cleanString(rawQuote.msgtype) || null,
        hasMsgId: Boolean(cleanString(rawQuote.msgid || rawQuote.msg_id)),
        hasSummary: Boolean(quoteTextSummary(rawQuote)),
        hasMedia: Boolean(parsed.quoteHasMedia),
        keys: Object.keys(rawQuote).slice(0, 12),
        cmd: cleanString(safeFrame?.cmd) || null,
      })
    }
    if (parsed.selfSent) {
      ctx?.emitEvent?.(parsed.event)
      return true
    }
    if (parsed.replyContext) {
      setBoundedMap(replyContextCache, parsed.inbound.messageId, parsed.replyContext, MAX_REPLY_CONTEXT_ENTRIES)
    }
    ctx?.emit?.(parsed.inbound)
    return true
  }

  function handleIncomingFrame(rawText) {
    if (!running || stopped) return
    let frame
    try {
      const cleaned = String(rawText || '').replace(/[\x00-\x08\x0B-\x0D\x0E-\x1F]/g, '')
      frame = JSON.parse(cleaned)
    } catch {
      return
    }
    if (!frame || typeof frame !== 'object') return

    const cmd = cleanString(frame.cmd)
    const reqId = cleanString(frame.headers?.req_id)

    if (cmd === WECOM_WS_CMD.CALLBACK) {
      handleInboundCallback(frame)
      return
    }

    if (cmd === WECOM_WS_CMD.EVENT_CALLBACK) {
      const eventType = cleanString(frame.body?.event?.eventtype)
      if (eventType === 'disconnected_event') {
        serverDisconnected = true
        connected = false
        clearReconnectTimer()
        stopHeartbeat()
        rejectAllPendingAcks(makeSendError('unknown', 'server-disconnected', instance, '企业微信长连接被新连接顶替断开（按 unknown 处理）'))
        ctx?.emitEvent?.({ type: 'offline', reason: 'disconnected_event', raw: sanitizeRawWecomFrame(frame) })
        closeWsOnly()
        ctx?.state?.('disconnected', '有新连接上线，服务端已断开当前企业微信连接（已停止自动重连）')
        return
      }
      ctx?.emitEvent?.({ type: 'native', name: eventType || 'wecom-event', raw: sanitizeRawWecomFrame(frame) })
      return
    }

    if (reqId.startsWith(WECOM_WS_CMD.SUBSCRIBE)) {
      const waiter = authWaiter
      if (waiter) {
        authWaiter = null
        if (Number(frame.errcode) === 0) waiter.resolve(frame)
        else waiter.reject(new Error(`企业微信订阅鉴权失败（errcode=${frame.errcode ?? '?'}）`))
      }
      return
    }

    if (reqId.startsWith(WECOM_WS_CMD.HEARTBEAT)) {
      if (Number(frame.errcode) === 0) missedPongCount = 0
      return
    }

    if (reqId && pendingAcks.has(reqId)) {
      const pending = pendingAcks.get(reqId)
      pendingAcks.delete(reqId)
      clearTimeout(pending.timer)
      const ackErr = classifyWecomAckError(frame, 'request')
      if (ackErr) pending.reject(ackErr)
      else pending.resolve(frame)
    }
  }

  async function openWecomWs(myGen) {
    const botId = botIdOf()
    const secret = secretOf()
    const wsUrl = wsUrlOf()
    const socket = wsFactory(wsUrl)
    ws = socket

    await new Promise((resolveConn, rejectConn) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        authWaiter = null
        rejectConn(new Error(`企业微信 WebSocket 订阅鉴权超时（>${connectTimeoutMs}ms）`))
      }, connectTimeoutMs)
      timer.unref?.()

      const settleOk = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolveConn()
      }
      const settleErr = (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        authWaiter = null
        rejectConn(err instanceof Error ? err : new Error(String(err || '企业微信连接失败')))
      }

      const sendSubscribe = () => {
        authWaiter = {
          resolve: () => {
            if (!running || stopped || myGen !== connGen) return settleErr(new Error('stopped'))
            connected = true
            reconnectAttempts = 0
            startHeartbeat()
            settleOk()
          },
          reject: (err) => settleErr(err),
        }
        const ok = sendWsFrame({
          cmd: WECOM_WS_CMD.SUBSCRIBE,
          headers: { req_id: generateReqId(WECOM_WS_CMD.SUBSCRIBE) },
          body: { bot_id: botId, secret },
        })
        if (!ok) settleErr(new Error('发送企业微信 aibot_subscribe 认证帧失败'))
      }

      detachWs = attachWsListeners(socket, {
        onOpen: () => {
          if (!running || stopped || myGen !== connGen) {
            closeWsOnly()
            return settleErr(new Error('stopped'))
          }
          sendSubscribe()
        },
        onMessage: (rawText) => {
          if (myGen !== connGen) return
          handleIncomingFrame(rawText)
        },
        onClose: () => {
          if (!settled) {
            settleErr(new Error('企业微信 WebSocket 连接关闭'))
            return
          }
          if (!running || stopped || serverDisconnected || myGen !== connGen) return
          connected = false
          stopHeartbeat()
          ws = null
          detachWs = null
          rejectAllPendingAcks(makeSendError('unknown', 'connection-closed', instance, '企业微信 WebSocket 连接中途断开（按 unknown 处理）'))
          ctx?.state?.('disconnected', '企业微信 WebSocket 连接已断开，准备重连')
          scheduleReconnect()
        },
        onError: (err) => {
          if (!settled) settleErr(err)
        },
      })

      if (socket.readyState === 1) sendSubscribe()
    })
  }

  function scheduleReconnect() {
    if (!running || stopped || serverDisconnected) return
    clearReconnectTimer()
    const delayMs = Math.min(reconnectMaxMs, reconnectBaseMs * Math.pow(2, Math.min(5, reconnectAttempts)))
    reconnectAttempts++
    const myGen = connGen
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (!running || stopped || serverDisconnected || myGen !== connGen) return
      ctx?.state?.('connecting', `企业微信 WebSocket 重连中（第 ${reconnectAttempts} 次）`)
      openWecomWs(myGen).then(() => {
        if (running && !stopped && myGen === connGen) {
          ctx?.state?.('connected')
        }
      }).catch((err) => {
        if (!running || stopped || serverDisconnected || myGen !== connGen) return
        connected = false
        closeWsOnly()
        ctx?.state?.('disconnected', redactWecomSecrets(err?.message || '企业微信重连失败', [secretOf()]))
        scheduleReconnect()
      })
    }, delayMs)
    reconnectTimer.unref?.()
  }

  async function downloadGuardedUrl(rawUrl, timeoutMs, maxBytes) {
    let current = cleanString(rawUrl)
    if (!current) throw makeSendError('not-sent', 'ssrf-blocked', instance, '媒体地址为空')
    const fetchFn = resolveFetch()
    if (typeof fetchFn !== 'function') throw makeSendError('not-sent', 'no-fetch', instance, '缺少 fetch')

    for (let hop = 0; hop <= 5; hop++) {
      try {
        await verifyPublicUrl(current)
      } catch (error) {
        throw makeSendError('not-sent', 'ssrf-blocked', instance, `媒体地址未通过安全校验：${error?.message || error}`)
      }
      const r = await fetchFn(current, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
      if ([301, 302, 303, 307, 308].includes(r?.status)) {
        const loc = typeof r.headers?.get === 'function' ? r.headers.get('location') : r.headers?.location
        if (loc) {
          current = new URL(loc, current).href
          continue
        }
      }
      if (!r || r.status < 200 || r.status >= 300) {
        throw makeSendError('not-sent', 'media-download-failed', instance, `下载企业微信媒体失败（HTTP ${r?.status ?? '?'}）`)
      }
      const bounded = await readResponseBytesBounded(r, maxBytes)
      if (!bounded.ok) {
        if (bounded.reason === 'too-large') {
          throw makeSendError('not-sent', 'too-large', instance, `媒体大小 ${bounded.size} 字节超过上限 ${maxBytes}`)
        }
        throw makeSendError('not-sent', 'empty-media', instance, '下载的企业微信媒体为空')
      }
      return bounded.bytes
    }
    throw makeSendError('not-sent', 'too-many-redirects', instance, '企业微信媒体下载地址重定向次数过多')
  }

  function readGuardedLocalFile(rawPath, maxBytes) {
    if (!allowLocalPath) throw makeSendError('not-sent', 'local-path-blocked', instance, '当前不允许读取本地文件路径')
    let p = cleanString(rawPath)
    if (!p || p.includes('\0')) throw makeSendError('not-sent', 'local-path-blocked', instance, '本地媒体路径无效')
    if (/^file:\/\//i.test(p)) {
      try { p = fileURLToPath(p) } catch { throw makeSendError('not-sent', 'local-path-blocked', instance, 'file:// 路径格式无效') }
    }
    if (!isAbsolute(p)) throw makeSendError('not-sent', 'local-path-blocked', instance, '本地媒体必须使用绝对路径')
    let st
    try { st = statSync(p) } catch (err) { throw makeSendError('not-sent', 'local-path-blocked', instance, `读取本地文件失败：${err?.message || err}`) }
    if (!st.isFile()) throw makeSendError('not-sent', 'local-path-blocked', instance, '本地媒体路径必须是常规文件')
    if (maxBytes > 0 && st.size > maxBytes) {
      throw makeSendError('not-sent', 'too-large', instance, `本地文件 ${st.size} 字节超过上限 ${maxBytes}`)
    }
    if (hasAllowedDirsOption) {
      const dirs = resolveAllowedDirs()
      if (!dirs.length) throw makeSendError('not-sent', 'local-path-blocked', instance, '未配置允许读取的本地目录范围')
      let realFile
      try { realFile = realpathSync(p) } catch { realFile = resolve(p) }
      const inside = dirs.some((d) => {
        let realDir
        try { realDir = realpathSync(d) } catch { realDir = resolve(d) }
        const rel = relative(realDir, realFile)
        return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
      })
      if (!inside) throw makeSendError('not-sent', 'local-path-blocked', instance, '本地文件路径不在允许目录范围内')
    }
    return readFileSync(p)
  }

  async function resolveOutboundMedia(media, mediaType, kindLabel, remainingTimeout, maxBytes) {
    const sizeHint = Number(media?.size)
    if (sizeHint > 0 && maxBytes > 0 && sizeHint > maxBytes) {
      throw makeSendError('not-sent', 'too-large', instance, `${kindLabel}大小 ${sizeHint} 字节超过上限 ${maxBytes}`)
    }
    let bytes = null
    if (media?.bytes) {
      bytes = Buffer.isBuffer(media.bytes) ? media.bytes : Buffer.from(media.bytes)
    } else if (media?.path) {
      bytes = readGuardedLocalFile(media.path, maxBytes)
    } else if (media?.id && !String(media.id).startsWith('wc_') && !mediaCache.has(String(media.id))) {
      return { directMediaId: String(media.id) }
    } else if (media?.url) {
      bytes = await downloadGuardedUrl(media.url, remainingTimeout(), maxBytes)
    }
    if (!bytes) {
      throw makeSendError('not-sent', 'media-needs-upload', instance, `${kindLabel}缺少可用内容（bytes/path/url 或 media_id）`)
    }
    if (!bytes.length) {
      throw makeSendError('not-sent', 'empty-media', instance, `${kindLabel}内容为空，无法发送`)
    }
    const checked = checkMediaConstraints({ bytes, mime: media?.mime, name: media?.name }, { kind: mediaType, maxBytes })
    if (!checked.ok) throw makeSendError('not-sent', 'too-large', instance, checked.reason)
    const fallbackExt = mediaType === 'image' ? 'png' : mediaType === 'video' ? 'mp4' : 'bin'
    const fileName = cleanString(media?.name) || `${mediaType}.${extForMime(checked.mime, fallbackExt)}`
    return { bytes, fileName }
  }

  async function uploadWecomMedia(bytes, mediaType, fileName, remainingTimeout) {
    const totalSize = bytes.length
    const totalChunks = Math.ceil(totalSize / UPLOAD_CHUNK_SIZE)
    if (totalChunks > UPLOAD_MAX_CHUNKS) {
      throw makeSendError('not-sent', 'too-large', instance, `分片数 ${totalChunks} 超过企业微信上限 ${UPLOAD_MAX_CHUNKS}`)
    }
    const md5 = createHash('md5').update(bytes).digest('hex')
    const initAck = await sendWsCommand(
      WECOM_WS_CMD.UPLOAD_MEDIA_INIT,
      { type: mediaType, filename: fileName, total_size: totalSize, total_chunks: totalChunks, md5 },
      { timeoutMs: remainingTimeout() },
    )
    const uploadId = cleanString(initAck?.body?.upload_id)
    if (!uploadId) {
      throw makeSendError('not-sent', 'upload-init-failed', instance, '企业微信素材初始化上传未返回 upload_id')
    }
    for (let idx = 0; idx < totalChunks; idx++) {
      const start = idx * UPLOAD_CHUNK_SIZE
      const end = Math.min(start + UPLOAD_CHUNK_SIZE, totalSize)
      const chunkBase64 = bytes.subarray(start, end).toString('base64')
      await sendWsCommand(
        WECOM_WS_CMD.UPLOAD_MEDIA_CHUNK,
        { upload_id: uploadId, chunk_index: idx, base64_data: chunkBase64 },
        { timeoutMs: remainingTimeout() },
      )
    }
    const finishAck = await sendWsCommand(
      WECOM_WS_CMD.UPLOAD_MEDIA_FINISH,
      { upload_id: uploadId },
      { timeoutMs: remainingTimeout() },
    )
    const mediaId = cleanString(finishAck?.body?.media_id)
    if (!mediaId) {
      throw makeSendError('not-sent', 'upload-finish-failed', instance, '企业微信素材完成上传未返回 media_id')
    }
    return mediaId
  }

  const adapter = {
    id,
    name,
    contract: 1,

    caps: () => ({
      ...capsState,
      ...(capsOverride || {}),
      features: { ...(capsState.features || {}), ...(capsOverride?.features || {}) },
    }),

    settings: [
      { key: 'botId', label: '机器人 Bot ID', type: 'text', default: '', hint: '推荐点击上方「企业微信扫码绑定机器人」自动获取；与个人微信 wechat-clawbot 隔离' },
      { key: 'secret', label: '机器人 Secret', type: 'password', default: '', hint: '仅保存在本机宿主配置，面板不回显原文；留空保持不变' },
      { key: 'wsUrl', label: 'WebSocket 长连接地址', type: 'text', default: DEFAULT_WECOM_WS_URL, hint: '默认 wss://openws.work.weixin.qq.com（私有部署可替换）' },
      { key: 'proactive', label: '主动消息策略', type: 'select', options: ['free', 'none'], default: 'free', hint: 'free 允许主动发送（aibot_send_msg）；设为 none 时只允许被动回复' },
      { key: 'maxTextChars', label: '单条文本上限（字符）', type: 'number', default: DEFAULT_MAX_TEXT_CHARS, hint: '受单帧 18000 UTF-8 字节限制，超出自动分段发送' },
      { key: 'timeoutMs', label: '请求超时（毫秒）', type: 'number', default: DEFAULT_TIMEOUT_MS },
    ],

    async start(gatewayCtx) {
      if (running) return
      ctx = gatewayCtx
      instance = String(ctx?.instance || id)
      const cfg = cfgOf()

      capsOverride = { ...(capsOverride || {}) }
      if (cfg.proactive === 'none' || cfg.proactive === 'free') capsOverride.proactive = cfg.proactive
      try { ctx?.capsChanged?.() } catch {}

      const botId = botIdOf()
      const secret = secretOf()
      if (!botId || !secret) {
        running = false
        connected = false
        stopped = true
        ctx?.state?.('unconfigured', '请先通过「企业微信扫码绑定机器人」获取凭证或手动填写 Bot ID / Secret')
        throw new Error('wecom：缺少 Bot ID / Secret，无法启动')
      }

      running = true
      stopped = false
      connected = false
      serverDisconnected = false
      reconnectAttempts = 0
      self = { account: botId, name: cleanString(cfg.botName) || name }
      ctx?.state?.('connecting', '正在连接企业微信智能机器人 WebSocket…')

      const myGen = ++connGen
      try {
        await openWecomWs(myGen)
      } catch (err) {
        stopped = true
        running = false
        connected = false
        closeWsOnly()
        const rawMsg = cleanString(err?.message) || cleanString(err?.cause?.message) || (err ? String(err) : '企业微信连接失败')
        const safeMsg = redactWecomSecrets(rawMsg, [secret])
        ctx?.state?.('disconnected', safeMsg)
        throw new Error(safeMsg)
      }
      ctx?.state?.('connected')
    },

    async stop() {
      stopped = true
      running = false
      connected = false
      connGen++
      authWaiter = null
      clearReconnectTimer()
      rejectAllPendingAcks(makeSendError('unknown', 'adapter-stopped', instance, '企业微信适配器已停止（可能已发出，按 unknown 处理）'))
      closeWsOnly()
      replyContextCache.clear()
      mediaCache.clear()
      quoteCache.clear()
      ctx?.state?.('stopped')
    },

    async whoami() {
      return { account: self.account || botIdOf(), name: self.name || name }
    },

    async send(message = {}, { replyGuard, proactiveGuard } = {}) {
      const guard = replyGuard || proactiveGuard
      assertReplyCurrent(guard, instance, false)

      if (!running || !connected || stopped) {
        throw makeSendError('not-sent', 'not-connected', instance, '企业微信智能机器人未连接')
      }
      if (failSend === 'refused') {
        failSend = null
        throw makeSendError('not-sent', 'platform-refused', instance, '企业微信连接被拒绝')
      }
      if (failSend === 'timeout') {
        failSend = null
        throw makeSendError('unknown', 'timeout', instance, '企业微信等待回执超时（可能已发出，按 unknown 处理）')
      }

      const currentCaps = adapter.caps()
      const chatId = cleanString(message?.chat?.id)
      if (!chatId) throw makeSendError('not-sent', 'missing-chat-id', instance, '缺少目标会话 ID')

      const inResponseTo = cleanString(message?.inResponseTo)
      if (replyGuard && !inResponseTo) {
        throw makeSendError('not-sent', 'missing-reply-id', instance, '缺少被动回复原消息 ID')
      }
      if (!inResponseTo && currentCaps.proactive === 'none') {
        throw makeSendError('not-sent', 'proactive-not-allowed', instance, '当前配置不允许主动发送（proactive=none）')
      }

      const timeoutMs = Math.max(50, Number(message?.timeoutMs) || timeoutMsOf())
      const maxChars = Math.max(10, Number(cfgOf().maxTextChars) || DEFAULT_MAX_TEXT_CHARS)
      const maxBytes = maxFileBytesOf()

      const queue = []
      const textBuf = []
      const flushText = () => {
        if (!textBuf.length) return
        const joined = textBuf.join('').trim()
        textBuf.length = 0
        if (!joined) return
        for (const chunk of splitWechatText(joined, { maxChars, maxBytes: DEFAULT_MAX_TEXT_BYTES })) {
          queue.push({ kind: 'text', text: chunk })
        }
      }

      for (const part of Array.isArray(message?.parts) ? message.parts : []) {
        if (!part || typeof part !== 'object') continue
        switch (part.type) {
          case 'text':
            if (part.text) textBuf.push(String(part.text))
            break
          case 'mention':
            textBuf.push(part.account === 'all' ? '@所有人 ' : `@${part.name || part.account} `)
            break
          case 'face':
            textBuf.push(`[${part.name || '表情'}]`)
            break
          case 'card':
            textBuf.push([part.title, part.text, part.url].filter(Boolean).join('\n'))
            break
          case 'image':
          case 'sticker':
            flushText()
            queue.push({ kind: 'image', media: part.media || {} })
            break
          case 'video':
            flushText()
            queue.push({ kind: 'video', media: part.media || {} })
            break
          case 'voice':
            flushText()
            queue.push({ kind: 'voice', media: part.media || {}, durationMs: Number(part.durationMs) || 0 })
            break
          case 'file':
            flushText()
            queue.push({ kind: 'file', media: part.media || {} })
            break
          default:
            if (part.text) textBuf.push(String(part.text))
            break
        }
      }
      flushText()

      if (!queue.length) {
        throw makeSendError('not-sent', 'nothing-to-send', instance, '没有可发送的内容')
      }

      const deadline = Date.now() + timeoutMs
      const remainingTimeout = () => Math.max(50, deadline - Date.now())
      const replyCtx = inResponseTo ? replyContextCache.get(inResponseTo) : null
      let lastMessageId = ''

      for (const item of queue) {
        assertReplyCurrent(guard, instance, Boolean(lastMessageId))
        if (item.kind === 'text') {
          const canRespondStream = Boolean(
            replyCtx
            && !replyCtx.consumed
            && replyCtx.reqId
            && replyCtx.chatId === chatId,
          )
          if (canRespondStream) {
            replyCtx.consumed = true
            const ack = await sendWsCommand(
              WECOM_WS_CMD.RESPONSE,
              {
                msgtype: 'stream',
                stream: { id: generateReqId('stream'), finish: true, content: item.text },
              },
              { reqId: replyCtx.reqId, timeoutMs: remainingTimeout() },
            )
            lastMessageId = cleanString(ack?.body?.msgid || ack?.body?.message_id) || `wc_${replyCtx.reqId}`
          } else {
            const reqId = generateReqId(WECOM_WS_CMD.SEND_MSG)
            const ack = await sendWsCommand(
              WECOM_WS_CMD.SEND_MSG,
              { chatid: chatId, msgtype: 'markdown', markdown: { content: item.text } },
              { reqId, timeoutMs: remainingTimeout() },
            )
            lastMessageId = cleanString(ack?.body?.msgid || ack?.body?.message_id) || `wc_${reqId}`
          }
          continue
        }

        if (item.kind === 'voice') {
          const resolved = await resolveOutboundMedia(item.media, 'voice', '语音', remainingTimeout, maxBytes)
          if (resolved.directMediaId) {
            assertReplyCurrent(guard, instance, Boolean(lastMessageId))
            const reqId = generateReqId(WECOM_WS_CMD.SEND_MSG)
            const ack = await sendWsCommand(
              WECOM_WS_CMD.SEND_MSG,
              { chatid: chatId, msgtype: 'voice', voice: { media_id: resolved.directMediaId } },
              { reqId, timeoutMs: remainingTimeout() },
            )
            lastMessageId = cleanString(ack?.body?.msgid || ack?.body?.message_id) || `wc_${reqId}`
            continue
          }

          let amrBytes = isAmrBytes(resolved.bytes) ? resolved.bytes : null
          if (!amrBytes) {
            const ffmpegPath = resolveFfmpegPath()
            if (ffmpegPath) {
              const tr = await transcodeAudioForWechat(resolved.bytes, {
                targetFormat: 'amr',
                ffmpegPath,
                timeoutMs: Math.min(15_000, remainingTimeout()),
              })
              if (tr.ok && isAmrBytes(tr.bytes)) amrBytes = tr.bytes
            }
          }
          const durationMs = amrBytes ? (estimateAmrDurationMs(amrBytes) || item.durationMs) : 0
          if (
            amrBytes
            && amrBytes.length <= DEFAULT_MAX_VOICE_BYTES
            && (!durationMs || durationMs <= DEFAULT_MAX_VOICE_DURATION_MS)
          ) {
            assertReplyCurrent(guard, instance, Boolean(lastMessageId))
            const mediaId = await uploadWecomMedia(amrBytes, 'voice', 'voice.amr', remainingTimeout)
            assertReplyCurrent(guard, instance, Boolean(lastMessageId))
            const reqId = generateReqId(WECOM_WS_CMD.SEND_MSG)
            const ack = await sendWsCommand(
              WECOM_WS_CMD.SEND_MSG,
              { chatid: chatId, msgtype: 'voice', voice: { media_id: mediaId } },
              { reqId, timeoutMs: remainingTimeout() },
            )
            lastMessageId = cleanString(ack?.body?.msgid || ack?.body?.message_id) || `wc_${reqId}`
            continue
          }

          const inferredMime = inferMimeFromBytes(resolved.bytes)
          const inferredExt = inferredMime ? extForMime(inferredMime, 'bin') : ''
          const { fileName: fallbackName } = fallbackVoiceName(item.media?.name, inferredExt, isAmrBytes(resolved.bytes))
          assertReplyCurrent(guard, instance, Boolean(lastMessageId))
          const mediaId = await uploadWecomMedia(resolved.bytes, 'file', fallbackName, remainingTimeout)
          assertReplyCurrent(guard, instance, Boolean(lastMessageId))
          const reqId = generateReqId(WECOM_WS_CMD.SEND_MSG)
          const ack = await sendWsCommand(
            WECOM_WS_CMD.SEND_MSG,
            { chatid: chatId, msgtype: 'file', file: { media_id: mediaId } },
            { reqId, timeoutMs: remainingTimeout() },
          )
          lastMessageId = cleanString(ack?.body?.msgid || ack?.body?.message_id) || `wc_${reqId}`
          continue
        }

        const mediaType = item.kind
        const kindLabel = mediaType === 'image' ? '图片' : mediaType === 'video' ? '视频' : '文件'
        const resolved = await resolveOutboundMedia(item.media, mediaType, kindLabel, remainingTimeout, maxBytes)
        assertReplyCurrent(guard, instance, Boolean(lastMessageId))
        const mediaId = resolved.directMediaId || await uploadWecomMedia(resolved.bytes, mediaType, resolved.fileName, remainingTimeout)
        assertReplyCurrent(guard, instance, Boolean(lastMessageId))
        const reqId = generateReqId(WECOM_WS_CMD.SEND_MSG)
        const ack = await sendWsCommand(
          WECOM_WS_CMD.SEND_MSG,
          { chatid: chatId, msgtype: mediaType, [mediaType]: { media_id: mediaId } },
          { reqId, timeoutMs: remainingTimeout() },
        )
        lastMessageId = cleanString(ack?.body?.msgid || ack?.body?.message_id) || `wc_${reqId}`
      }

      return { messageId: lastMessageId }
    },

    async fetch(request) {
      if (request?.kind === 'message') {
        const mid = cleanString(request.messageId)
        const hit = mid ? quoteCache.get(mid) : null
        if (hit) return hit
        throw makeSendError('not-sent', 'message-not-found', instance, '未找到该企业微信引用消息的缓存正文')
      }
      if (request?.kind !== 'media') {
        throw makeSendError('not-sent', 'unsupported-fetch', instance, `企业微信智能机器人不支持 fetch('${String(request?.kind || '')}')`)
      }
      const media = request.media || {}
      const cached = media.id ? mediaCache.get(String(media.id)) : null
      const url = cached?.url || cleanString(media.url)
      if (!url) {
        throw makeSendError('not-sent', 'media-not-found', instance, '未找到可下载的企业微信媒体缓存或地址')
      }
      const encryptedOrRaw = await downloadGuardedUrl(url, timeoutMsOf(), maxFileBytesOf())
      const bytes = cached?.aeskey ? decryptWecomFile(encryptedOrRaw, cached.aeskey) : encryptedOrRaw
      return {
        bytes,
        mime: inferMimeFromBytes(bytes) || media.mime || 'application/octet-stream',
        ...(cached?.name || media.name ? { name: cached?.name || media.name } : {}),
      }
    },
  }

  adapter.platform = {
    deliver(frame) {
      return handleInboundCallback(frame)
    },
    injectFrame(rawText) {
      handleIncomingFrame(typeof rawText === 'string' ? rawText : JSON.stringify(rawText))
    },
    setConfig(partial) {
      adapter.__config = { ...(adapter.__config || {}), ...(partial || {}) }
    },
    setCaps(partial) {
      const mergedFeatures = partial?.features && typeof partial.features === 'object'
        ? sanitizeFeaturesInput({ ...(capsState.features || {}), ...partial.features }, { instance, source: 'test.setCaps' })
        : capsState.features
      capsState = { ...capsState, ...(partial || {}), features: mergedFeatures || capsState.features }
      ctx?.capsChanged?.()
    },
    setProactive(value) {
      if (value === 'free' || value === 'none') {
        capsOverride = { ...(capsOverride || {}), proactive: value }
        capsState = { ...capsState, proactive: value }
        ctx?.capsChanged?.()
      }
    },
    refuseNext() { failSend = 'refused' },
    hangNext() { failSend = 'timeout' },
    reconnect() {
      if (stopped) return
      serverDisconnected = false
      connected = true
      ctx?.state?.('connected')
    },
  }

  return adapter
}

export {
  createWecomAuthDriver,
  WECOM_QR_GENERATE_URL,
  WECOM_QR_POLL_URL,
}

export default createWecomAdapter()
