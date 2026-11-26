// 平台端：钉钉机器人（DingTalk Stream 长连接 + OpenAPI 主动/被动回复，零第三方 npm 依赖）。
// 契约权威：src/gateway/contracts.d.ts（PlatformAdapter v1 / AdapterInbound / SendError / Caps / Feature）。
// 文档与限制见 docs/ADAPTER-DINGTALK.md。
//
// 硬边界：
//   1. 只做平台协议翻译，不读 config.json、不查主人身份/白名单/共享会话。
//   2. 严格区分 SendError.certainty：明确拒绝/未连接/前置校验失败 → 'not-sent'；超时/5xx/断线 → 'unknown'。
//   3. 机器人自身消息走 emitEvent({ type: 'self-sent' })，stop() 后绝不再 emit。

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPublicUrl } from '../../core/net.js'
import { createTitleCaseWebSocket, normalizeWsError } from '../../core/ws-client.js'
import { sanitizeFeaturesInput } from '../../gateway/features.js'
import { assertReplyCurrent, makeSendError } from '../../gateway/errors.js'
import {
  estimateAmrDurationMs,
  estimateOggOpusDurationMs,
  fallbackVoiceName,
  isAmrBytes,
  isOggOpusBytes,
} from '../../voice/audio-format.js'
import {
  extForMime,
  inferMimeFromBytes,
  readResponseBytesBounded,
  transcodeAudioForWechat,
} from '../wechat-common/index.js'
import {
  createDingtalkAuthDriver,
  DINGTALK_REGISTRATION_BASE_URL,
  DINGTALK_REGISTRATION_SOURCE,
} from './auth.js'

export const PLATFORM_ID = 'dingtalk'
export const DINGTALK_API_BASE_URL = 'https://api.dingtalk.com'
export const DINGTALK_OAPI_BASE_URL = 'https://oapi.dingtalk.com'
export const TOPIC_ROBOT = '/v1.0/im/bot/messages/get'
export const DEFAULT_MAX_TEXT_CHARS = 4000
export const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024
export const DEFAULT_MAX_VOICE_BYTES = 2 * 1024 * 1024
export const DEFAULT_TIMEOUT_MS = 15_000
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
export const DEFAULT_IDLE_TIMEOUT_MS = 120_000
export const DEFAULT_PING_INTERVAL_MS = 30_000

const CONNECT_REFUSED_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ERR_INVALID_URL',
])
const MAX_REPLY_CONTEXT_ENTRIES = 1000
const MAX_MEDIA_CACHE_ENTRIES = 500
const MAX_QUOTE_CACHE_ENTRIES = 500
const RETRYABLE_CONNECT_CLOSE = new Set(['disconnect', 'ws-close', 'ws-error', 'ws-idle'])

/**
 * 钉钉适配器能力声明（含全部 20 项 L1 Caps 与 14 项 L2 Features；只报真实支持能力）。
 */
export const CAPS_DINGTALK = Object.freeze({
  image: true,
  sticker: false,
  voice: 'native',
  video: false,
  file: true,
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
  quoteReply: false,
  mention: true,
  mentionAll: true,
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

function stripTrailingSlash(url) {
  return String(url || '').trim().replace(/\/+$/, '')
}

function isDingtalkHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '')
  return host === 'dingtalk.com' || host.endsWith('.dingtalk.com')
}

function dingtalkTimestampMs(value, fallbackMs) {
  const n = typeof value === 'string' && value.trim() ? Number(value) : Number(value)
  if (!Number.isFinite(n) || n <= 0) return Math.trunc(fallbackMs)
  return Math.trunc(n < 10_000_000_000 ? n * 1000 : n)
}

function parsedPayloadContent(payload) {
  if (payload?.content && typeof payload.content === 'object') return payload.content
  if (typeof payload?.content === 'string') {
    try {
      const parsed = JSON.parse(payload.content)
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }
  return null
}

function richTextEntryText(entry) {
  if (typeof entry?.text === 'string') return cleanString(entry.text)
  if (typeof entry?.text?.content === 'string') return cleanString(entry.text.content)
  if (String(entry?.type || '').toLowerCase() === 'text' && typeof entry?.content === 'string') {
    return cleanString(entry.content)
  }
  return ''
}

export function makeDingtalkMediaId(robotCode, downloadCode) {
  return `dt:${encodeURIComponent(String(robotCode || ''))}:${encodeURIComponent(String(downloadCode || ''))}`
}

export function parseDingtalkMediaId(mediaId) {
  const s = String(mediaId || '').trim()
  if (!s.startsWith('dt:')) return null
  const rest = s.slice(3)
  const sepIdx = rest.indexOf(':')
  if (sepIdx < 0) return null
  try {
    const robotCode = decodeURIComponent(rest.slice(0, sepIdx))
    const downloadCode = decodeURIComponent(rest.slice(sepIdx + 1))
    if (!downloadCode) return null
    return { robotCode, downloadCode }
  } catch {
    return null
  }
}

/**
 * 校验并规范化钉钉入站回传的 sessionWebhook，只接受默认端口 HTTPS dingtalk.com 域名。
 */
export function normalizeDingtalkSessionWebhook(rawUrl) {
  const raw = cleanString(rawUrl)
  if (!raw) throw new Error('钉钉会话回复地址为空')
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('钉钉会话回复地址格式无效')
  }
  if (
    parsed.protocol !== 'https:'
    || !isDingtalkHost(parsed.hostname)
    || (parsed.port && parsed.port !== '443')
    || parsed.username
    || parsed.password
  ) {
    throw new Error('钉钉会话回复地址不受信任')
  }
  parsed.hash = ''
  return parsed.toString()
}

/**
 * 校验并规范化钉钉 connections/open 返回的 Stream WebSocket 地址。
 * 默认要求默认端口 443 的 wss:// *.dingtalk.com；当显式配置自定义 apiBaseUrl 时，
 * 允许同主机的自定义测试/代理地址或 dingtalk.com 域名。
 */
export function normalizeDingtalkStreamEndpoint(rawUrl, { allowedHost = '', allowInsecure = false } = {}) {
  const raw = cleanString(rawUrl)
  if (!raw) throw new Error('钉钉 connections/open 未返回有效 endpoint')
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('钉钉 connections/open 返回了无效的 WebSocket 地址')
  }
  const protoOk = parsed.protocol === 'wss:' || (allowInsecure === true && parsed.protocol === 'ws:')
  if (!protoOk || parsed.username || parsed.password) {
    throw new Error('钉钉 connections/open 返回了不受信任的 WebSocket 地址')
  }
  const hostOk = allowInsecure === true
    ? (isDingtalkHost(parsed.hostname) || (Boolean(allowedHost) && parsed.hostname.toLowerCase() === String(allowedHost).toLowerCase()))
    : (isDingtalkHost(parsed.hostname) && (!parsed.port || parsed.port === '443'))
  if (!hostOk) {
    throw new Error('钉钉 connections/open 返回了不受信任的 WebSocket 地址')
  }
  parsed.hash = ''
  return parsed
}

/**
 * 按换行符与长度上限切分钉钉文本，保证拼接后与原文逐字一致。
 */
export function splitDingtalkText(text, maxChars = DEFAULT_MAX_TEXT_CHARS) {
  const s = String(text ?? '')
  if (!s) return []
  const cap = Math.max(1, Math.trunc(Number(maxChars) || DEFAULT_MAX_TEXT_CHARS))
  if (s.length <= cap) return [s]
  const chunks = []
  let rest = s
  while (rest.length > cap) {
    let cut = rest.lastIndexOf('\n', cap)
    if (cut < Math.floor(cap * 0.6)) cut = cap
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest) chunks.push(rest)
  return chunks
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

function nonWildcardMime(m) {
  const s = cleanString(m)
  return s && !s.includes('*') ? s : ''
}

function redactDingtalkSecrets(msg, secrets = []) {
  let out = String(msg || '').replace(/([?&]ticket=)[^&\s"'<>]+/gi, '$1***')
  for (const s of secrets) {
    const v = String(s || '')
    if (v.length >= 4 && out.includes(v)) out = out.split(v).join('***')
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

function attachWsListeners(ws, { onOpen, onMessage, onPing, onPong, onClose, onError }) {
  if (typeof ws.addEventListener === 'function') {
    const hOpen = () => onOpen?.()
    const hMsg = (ev) => onMessage?.(wsRawToText(ev))
    const hPing = (ev) => onPing?.(ev?.data ?? ev)
    const hPong = (ev) => onPong?.(ev?.data ?? ev)
    const hClose = (ev) => onClose?.(ev?.code, ev?.reason)
    const hErr = (ev) => onError?.(normalizeWsError(ev, 'WebSocket 连接或握手失败'))
    ws.addEventListener('open', hOpen)
    ws.addEventListener('message', hMsg)
    ws.addEventListener('ping', hPing)
    ws.addEventListener('pong', hPong)
    ws.addEventListener('close', hClose)
    ws.addEventListener('error', hErr)
    return () => {
      try {
        ws.removeEventListener('open', hOpen)
        ws.removeEventListener('message', hMsg)
        ws.removeEventListener('ping', hPing)
        ws.removeEventListener('pong', hPong)
        ws.removeEventListener('close', hClose)
        ws.removeEventListener('error', hErr)
      } catch {}
    }
  }
  if (typeof ws.on === 'function') {
    const hOpen = () => onOpen?.()
    const hMsg = (data) => onMessage?.(wsRawToText(data))
    const hPing = (data) => onPing?.(data)
    const hPong = (data) => onPong?.(data)
    const hClose = (code, reason) => onClose?.(code, reason)
    const hErr = (err) => onError?.(normalizeWsError(err, 'WebSocket 连接或握手失败'))
    ws.on('open', hOpen)
    ws.on('message', hMsg)
    ws.on('ping', hPing)
    ws.on('pong', hPong)
    ws.on('close', hClose)
    ws.on('error', hErr)
    return () => {
      const off = ws.off || ws.removeListener
      if (typeof off === 'function') {
        try {
          off.call(ws, 'open', hOpen)
          off.call(ws, 'message', hMsg)
          off.call(ws, 'ping', hPing)
          off.call(ws, 'pong', hPong)
          off.call(ws, 'close', hClose)
          off.call(ws, 'error', hErr)
        } catch {}
      }
    }
  }
  throw new TypeError('钉钉 WebSocket 实例必须实现 addEventListener 或 on 方法')
}

function sanitizeInboundPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload
  const copy = { ...payload }
  if (copy.sessionWebhook) copy.sessionWebhook = '[redacted]'
  return copy
}

/**
 * 将钉钉机器人回调载荷翻译为标准 AdapterInbound 或 self-sent 事件。
 */
export function parseDingtalkInbound(payload, { botId = '', callbackMessageId = '', now = () => Date.now(), registerMedia = null, registerQuote = null } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null

  const conversationType = String(payload.conversationType ?? '')
  const isGroup = conversationType === '2'
  const senderStaffId = cleanString(payload.senderStaffId)
  const senderId = cleanString(payload.senderId)
  const senderAccount = senderStaffId || senderId
  const chatId = isGroup ? cleanString(payload.conversationId) : senderAccount
  const messageId = cleanString(payload.msgId) || cleanString(payload.messageId) || cleanString(callbackMessageId)
  if (!chatId || !senderAccount || !messageId) return null

  const chat = {
    kind: isGroup ? 'group' : 'private',
    id: chatId,
    ...(isGroup && cleanString(payload.conversationTitle) ? { title: cleanString(payload.conversationTitle) } : {}),
  }
  const msgtype = cleanString(payload.msgtype ?? payload.msgType).toLowerCase()
  const content = parsedPayloadContent(payload)
  const robotCode = cleanString(payload.robotCode) || cleanString(botId)
  const chatbotUserId = cleanString(payload.chatbotUserId)
  const parts = []
  let replyTo
  let quoteRecord = null

  /**
   * Extract summary text and normalized quote parts (registering downloadable media) from DingTalk `repliedMsg`.
   * @param {any} replied
   * @returns {{ summary: string, quoteParts: any[], refId: string, fetchedMessage: any }}
   */
  const extractDingtalkReplied = (replied) => {
    if (!replied || typeof replied !== 'object') return { summary: '', quoteParts: [], refId: '', fetchedMessage: null }
    /** @param {any} val */
    const tryParseObj = (val) => {
      if (val && typeof val === 'object') return val
      if (typeof val !== 'string') return null
      const trimmed = val.trim()
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
      try {
        const parsed = JSON.parse(trimmed)
        return parsed && typeof parsed === 'object' ? parsed : null
      } catch {
        return null
      }
    }
    /** @param {string} s */
    const usefulText = (s) => {
      const c = cleanString(s)
      return c && c !== '[interactive card message]' ? c : ''
    }
    const qType = cleanString(replied.msgType ?? replied.msgtype ?? replied.type).toLowerCase()
    const rawContent = replied.content
    const parsedContent = tryParseObj(rawContent)
    const quoteParts = []
    let summary = ''

    const richItems = Array.isArray(parsedContent?.richText)
      ? parsedContent.richText
      : Array.isArray(replied.richText)
        ? replied.richText
        : Array.isArray(parsedContent?.content?.richText)
          ? parsedContent.content.richText
          : null

    if (qType === 'picture' || qType === 'image') {
      summary = '[图片]'
      const dc = cleanString(parsedContent?.downloadCode || parsedContent?.pictureDownloadCode || replied.downloadCode || replied.pictureDownloadCode)
      if (dc) {
        const id = makeDingtalkMediaId(robotCode, dc)
        if (registerMedia) registerMedia(id, { robotCode, downloadCode: dc, mime: 'image/*' })
        quoteParts.push({ type: 'image', media: { id, mime: 'image/png' } })
      }
    } else if (qType === 'video') {
      summary = '[视频]'
      const dc = cleanString(parsedContent?.downloadCode || replied.downloadCode)
      if (dc) {
        const id = makeDingtalkMediaId(robotCode, dc)
        if (registerMedia) registerMedia(id, { robotCode, downloadCode: dc, mime: 'video/mp4' })
        quoteParts.push({ type: 'video', media: { id } })
      } else {
        quoteParts.push({ type: 'video', media: {} })
      }
    } else if (qType === 'file') {
      const dc = cleanString(parsedContent?.downloadCode || replied.downloadCode)
      const fn = cleanString(parsedContent?.fileName || parsedContent?.filename || parsedContent?.name || replied.fileName || replied.filename || replied.name)
      summary = fn ? `[文件 ${fn}]` : '[文件]'
      if (dc) {
        const id = makeDingtalkMediaId(robotCode, dc)
        if (registerMedia) registerMedia(id, { robotCode, downloadCode: dc, ...(fn ? { name: fn } : {}) })
        quoteParts.push({ type: 'file', media: { id, ...(fn ? { name: fn } : {}) } })
      } else if (fn) {
        quoteParts.push({ type: 'file', media: { name: fn } })
      }
    } else if (qType === 'voice' || qType === 'audio') {
      const dc = cleanString(parsedContent?.downloadCode || replied.downloadCode)
      const rec = cleanString(parsedContent?.recognition || replied.recognition)
      summary = rec ? `[语音：${rec}]` : '[语音]'
      if (dc) {
        const id = makeDingtalkMediaId(robotCode, dc)
        if (registerMedia) registerMedia(id, { robotCode, downloadCode: dc, mime: 'audio/*' })
        quoteParts.push({ type: 'voice', media: { id } })
      }
      if (rec) quoteParts.push({ type: 'text', text: rec })
    } else if (qType === 'richtext' || richItems) {
      const segs = []
      for (const item of richItems || []) {
        if (!item || typeof item !== 'object') continue
        const itemType = cleanString(item.msgType ?? item.msgtype ?? item.type).toLowerCase()
        const txt = usefulText(typeof item.text === 'string' ? item.text : (item.text?.content ?? item.content))
        const dc = cleanString(item.downloadCode || item.pictureDownloadCode)
        if (itemType === 'picture' || itemType === 'image' || cleanString(item.pictureDownloadCode) || (itemType !== 'text' && dc && !txt)) {
          segs.push('[图片]')
          if (dc) {
            const id = makeDingtalkMediaId(robotCode, dc)
            if (registerMedia) registerMedia(id, { robotCode, downloadCode: dc, mime: 'image/*' })
            quoteParts.push({ type: 'image', media: { id, mime: 'image/png' } })
          } else {
            quoteParts.push({ type: 'text', text: '[图片]' })
          }
        } else if (txt) {
          segs.push(txt)
          quoteParts.push({ type: 'text', text: txt })
        }
      }
      summary = segs.join(' ').trim()
    }

    if (!summary) {
      const textCandidate =
        usefulText(parsedContent?.text) ||
        usefulText(parsedContent?.content) ||
        usefulText(parsedContent?.title) ||
        usefulText(typeof replied.text === 'string' ? replied.text : replied.text?.content) ||
        (typeof rawContent === 'string' && !parsedContent ? usefulText(rawContent) : '')
      if (textCandidate) {
        summary = textCandidate
        if (quoteParts.length === 0) quoteParts.push({ type: 'text', text: textCandidate })
      }
    }

    const refId = cleanString(replied.msgId || replied.messageId || replied.msg_id) || (quoteParts.length ? `dt_q_${messageId}` : '')
    const qSenderId = cleanString(replied.senderId)
    const qSenderStaffId = cleanString(replied.senderStaffId)
    const qSenderAcc = qSenderStaffId || qSenderId
    const qSenderName = cleanString(replied.senderNick || replied.senderName)
    const qIsBot = Boolean(
      (chatbotUserId && (qSenderId === chatbotUserId || qSenderStaffId === chatbotUserId))
      || (cleanString(botId) && qSenderId === cleanString(botId)),
    )
    const qSender = (qSenderAcc || qSenderName || qIsBot)
      ? { account: qSenderAcc, ...(qSenderName ? { name: qSenderName } : {}), ...(qIsBot ? { isBot: true } : {}) }
      : undefined
    const rawQAt = replied.createdAt ?? replied.createTime
    const qAtNum = typeof rawQAt === 'string' && rawQAt.trim() ? Number(rawQAt) : Number(rawQAt)
    const qAt = Number.isFinite(qAtNum) && qAtNum > 0
      ? Math.trunc(qAtNum < 10_000_000_000 ? qAtNum * 1000 : qAtNum)
      : undefined

    const fetchedMessage = refId && quoteParts.length
      ? {
          messageId: refId,
          ...(qAt !== undefined ? { at: qAt } : {}),
          ...(qSender ? { sender: qSender } : {}),
          parts: quoteParts,
        }
      : null
    return { summary, quoteParts, refId, fetchedMessage }
  }

  const replied = payload.text?.repliedMsg || payload.repliedMsg || (content && typeof content === 'object' ? content.repliedMsg : null)
  if (replied && typeof replied === 'object' && Object.keys(replied).length > 0) {
    const qInfo = extractDingtalkReplied(replied)
    if (qInfo.refId) replyTo = qInfo.refId
    if (qInfo.fetchedMessage) quoteRecord = qInfo.fetchedMessage
    if (qInfo.summary) {
      parts.push({ type: 'text', text: `[引用：${qInfo.summary.replace(/\r?\n/g, ' ')}]\n` })
    } else {
      parts.push({ type: 'text', text: '[引用：引用内容不可读]\n' })
    }
  }

  if (msgtype === 'text') {
    const text = cleanString(payload.text?.content) || cleanString(content?.text) || cleanString(content?.content)
    if (text) parts.push({ type: 'text', text })
  } else if (msgtype === 'picture') {
    const downloadCode = cleanString(content?.downloadCode || content?.pictureDownloadCode)
    const id = downloadCode ? makeDingtalkMediaId(robotCode, downloadCode) : ''
    if (id && registerMedia) registerMedia(id, { robotCode, downloadCode, mime: 'image/*' })
    parts.push({ type: 'image', media: { ...(id ? { id } : {}), mime: 'image/png' } })
  } else if (msgtype === 'file') {
    const downloadCode = cleanString(content?.downloadCode)
    const fileName = cleanString(content?.fileName || content?.file_name) || 'file'
    const id = downloadCode ? makeDingtalkMediaId(robotCode, downloadCode) : ''
    if (id && registerMedia) registerMedia(id, { robotCode, downloadCode, name: fileName })
    parts.push({ type: 'file', media: { ...(id ? { id } : {}), name: fileName } })
  } else if (msgtype === 'voice' || msgtype === 'audio') {
    const downloadCode = cleanString(content?.downloadCode)
    const id = downloadCode ? makeDingtalkMediaId(robotCode, downloadCode) : ''
    const recognition = cleanString(content?.recognition || payload.recognition)
    const duration = Number(content?.duration)
    if (id && registerMedia) registerMedia(id, { robotCode, downloadCode, mime: 'audio/*' })
    parts.push({
      type: 'voice',
      media: { ...(id ? { id } : {}) },
      ...(Number.isFinite(duration) && duration > 0 ? { durationMs: Math.trunc(duration) } : {}),
    })
    if (recognition) parts.push({ type: 'text', text: recognition })
  } else if (msgtype === 'richtext') {
    const entries = Array.isArray(content?.richText ?? content?.rich_text) ? (content.richText ?? content.rich_text) : []
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue
      const entryType = cleanString(entry.type || entry.msgType || entry.msgtype).toLowerCase()
      if (entryType === 'picture') {
        const downloadCode = cleanString(entry.downloadCode || entry.pictureDownloadCode)
        const id = downloadCode ? makeDingtalkMediaId(robotCode, downloadCode) : ''
        if (id && registerMedia) registerMedia(id, { robotCode, downloadCode, mime: 'image/*' })
        parts.push({ type: 'image', media: { ...(id ? { id } : {}), mime: 'image/png' } })
      } else {
        const txt = richTextEntryText(entry)
        if (txt) parts.push({ type: 'text', text: txt })
      }
    }
  } else if (msgtype === 'video') {
    const downloadCode = cleanString(content?.downloadCode)
    const id = downloadCode ? makeDingtalkMediaId(robotCode, downloadCode) : ''
    if (id && registerMedia) registerMedia(id, { robotCode, downloadCode, mime: 'video/mp4' })
    parts.push({ type: 'video', media: { ...(id ? { id } : {}) } })
  }

  const normalizedParts = parts.length
    ? parts
    : [{ type: 'other', text: `[钉钉消息 ${msgtype || 'unknown'}]`, native: sanitizeInboundPayload(payload) }]

  const isSelf = Boolean(
    (chatbotUserId && (senderId === chatbotUserId || senderStaffId === chatbotUserId))
    || (cleanString(botId) && senderId === cleanString(botId)),
  )
  if (isSelf) {
    return {
      selfSent: true,
      event: {
        type: 'self-sent',
        chat: { kind: chat.kind, id: chat.id },
        messageId,
        parts: normalizedParts,
        raw: sanitizeInboundPayload(payload),
      },
    }
  }

  if (quoteRecord && registerQuote) {
    registerQuote(quoteRecord.messageId, quoteRecord)
  }

  const role = isGroup ? (payload.isAdmin ? 'admin' : 'member') : ''
  const inbound = {
    chat,
    sender: {
      account: senderAccount,
      name: cleanString(payload.senderNick),
      role,
      ...(senderStaffId && senderId && senderStaffId !== senderId ? { alt: senderId } : {}),
    },
    messageId,
    at: dingtalkTimestampMs(payload.createAt ?? payload.createTime, now()),
    ...(replyTo ? { replyTo } : {}),
    mentionedMe: isGroup ? (payload.isInAtList !== undefined ? Boolean(payload.isInAtList) : true) : false,
    parts: normalizedParts,
    raw: sanitizeInboundPayload(payload),
  }

  let sessionWebhook = ''
  if (payload.sessionWebhook) {
    try { sessionWebhook = normalizeDingtalkSessionWebhook(payload.sessionWebhook) } catch {}
  }

  return {
    selfSent: false,
    inbound,
    replyContext: {
      chatKind: chat.kind,
      chatId: chat.id,
      robotCode,
      senderAccount,
      sessionWebhook,
      expiresAt: payload.sessionWebhookExpiredTime
        ? dingtalkTimestampMs(payload.sessionWebhookExpiredTime, now() + 3600_000)
        : 0,
    },
  }
}

/**
 * 创建钉钉机器人 PlatformAdapter（contract v1）。
 */
export function createDingtalkAdapter(options = {}) {
  const id = cleanString(options.id) || PLATFORM_ID
  const name = cleanString(options.name) || '钉钉'
  const clock = typeof options.now === 'function' ? options.now : () => Date.now()
  const resolveFetch = () => (typeof options.getFetch === 'function' ? options.getFetch() : null) || options.fetchImpl || globalThis.fetch
  const wsFactory = typeof options.createWebSocket === 'function'
    ? options.createWebSocket
    : (typeof options.getWebSocket === 'function' ? ((u) => options.getWebSocket()(u)) : ((u) => createTitleCaseWebSocket(u)))
  const verifyPublicUrl = typeof options.assertUrl === 'function' ? options.assertUrl : assertPublicUrl
  const resolveFfmpegPath = () => cleanString(typeof options.getFfmpegPath === 'function' ? options.getFfmpegPath() : options.ffmpegPath)
  const hasAllowedDirsOption = typeof options.allowedLocalDirs === 'function' || Array.isArray(options.allowedLocalDirs)
  const allowLocalPath = options.allowLocalPath !== false
  const reconnectBaseMs = Math.max(50, Number(options.reconnectBaseMs) || 1000)
  const reconnectMaxMs = Math.max(reconnectBaseMs, Number(options.reconnectMaxMs) || 30_000)
  const connectTimeoutMs = Math.max(100, Number(options.connectTimeoutMs) || DEFAULT_CONNECT_TIMEOUT_MS)
  const rawIdleMs = options.idleTimeoutMs === undefined ? DEFAULT_IDLE_TIMEOUT_MS : Number(options.idleTimeoutMs)
  const idleTimeoutMs = Number.isFinite(rawIdleMs) && rawIdleMs > 0 ? Math.max(50, rawIdleMs) : 0
  const rawPingMs = options.pingIntervalMs === undefined
    ? (idleTimeoutMs ? Math.max(20, Math.min(DEFAULT_PING_INTERVAL_MS, Math.floor(idleTimeoutMs / 3))) : 0)
    : Number(options.pingIntervalMs)
  const pingIntervalMs = Number.isFinite(rawPingMs) && rawPingMs > 0 && idleTimeoutMs > 0 ? Math.max(15, rawPingMs) : 0

  let ctx = null
  let instance = id
  let running = false
  let connected = false
  let stopped = true
  let ws = null
  let detachWs = null
  let reconnectTimer = null
  let idleTimer = null
  let pingTimer = null
  let reconnectAttempts = 0
  let connGen = 0
  let failSend = null
  let capsOverride = null
  let capsState = { ...CAPS_DINGTALK, features: { ...CAPS_DINGTALK.features } }
  let self = { account: '', name }

  let tokenCache = { value: '', expiresAt: 0, clientId: '' }
  let tokenInFlight = null
  const replyContextCache = new Map()
  const mediaCache = new Map()
  const quoteCache = new Map()

  const cfgOf = () => ({ ...(adapter.__config || {}), ...(ctx?.config?.() || {}) })
  const clientIdOf = () => cleanString(cfgOf().clientId)
  const clientSecretOf = () => cleanString(cfgOf().clientSecret)
  const apiBaseOf = () => stripTrailingSlash(cfgOf().apiBaseUrl || DINGTALK_API_BASE_URL) || DINGTALK_API_BASE_URL
  const oapiBaseOf = () => stripTrailingSlash(cfgOf().oapiBaseUrl || DINGTALK_OAPI_BASE_URL) || DINGTALK_OAPI_BASE_URL
  const timeoutMsOf = () => Math.max(100, Number(cfgOf().timeoutMs) || DEFAULT_TIMEOUT_MS)
  const maxFileBytesOf = () => {
    const raw = Number(cfgOf().maxFileBytes)
    return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : DEFAULT_MAX_FILE_BYTES
  }
  const resolveAllowedDirs = () => {
    if (typeof options.allowedLocalDirs === 'function') return options.allowedLocalDirs() || []
    if (Array.isArray(options.allowedLocalDirs)) return options.allowedLocalDirs
    return []
  }

  function clearIdleWatchdog() {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  function clearPingTimer() {
    if (pingTimer) {
      clearInterval(pingTimer)
      pingTimer = null
    }
  }

  function armPingTimer(myGen = connGen) {
    clearPingTimer()
    if (!pingIntervalMs || !running || stopped || !connected || myGen !== connGen) return
    pingTimer = setInterval(() => {
      if (!running || stopped || !connected || myGen !== connGen) {
        clearPingTimer()
        return
      }
      if (typeof ws?.ping === 'function') {
        try { ws.ping() } catch {}
      }
    }, pingIntervalMs)
    pingTimer.unref?.()
  }

  function closeWsOnly() {
    clearIdleWatchdog()
    clearPingTimer()
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

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function armIdleWatchdog(myGen = connGen) {
    clearIdleWatchdog()
    if (!idleTimeoutMs || !running || stopped || !connected || myGen !== connGen) return
    idleTimer = setTimeout(() => {
      idleTimer = null
      if (!running || stopped || !connected || myGen !== connGen) return
      connected = false
      closeWsOnly()
      ctx?.state?.('disconnected', '钉钉 Stream 长连接长时间无心跳，准备重连')
      scheduleReconnect('ws-idle')
    }, idleTimeoutMs)
    idleTimer.unref?.()
  }

  function sendWsJson(obj) {
    if (!ws || typeof ws.send !== 'function') return false
    if (ws.readyState !== undefined && ws.readyState !== 1) return false
    try {
      ws.send(JSON.stringify(obj))
      return true
    } catch {
      return false
    }
  }

  async function requestJsonWithBudget(url, { method = 'POST', headers = {}, body, timeoutMs, action = '钉钉请求', isForm = false } = {}) {
    const fetchFn = resolveFetch()
    if (typeof fetchFn !== 'function') {
      throw makeSendError('not-sent', 'no-fetch', instance, '当前运行环境不支持 fetch')
    }
    const ms = Math.max(50, Number(timeoutMs) || timeoutMsOf())
    const ac = new AbortController()
    let timedOut = false
    let timer = null
    const timeoutPromise = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        try { ac.abort(new Error('TimeoutError')) } catch {}
        reject(makeSendError('unknown', 'timeout', instance, `${action}超时（>${ms}ms，按 unknown 处理）`))
      }, ms)
      timer.unref?.()
    })

    let response
    try {
      response = await Promise.race([
        fetchFn(String(url), {
          method,
          headers: isForm ? headers : { accept: 'application/json', 'content-type': 'application/json', ...headers },
          body: body === undefined ? undefined : (isForm ? body : JSON.stringify(body)),
          redirect: 'error',
          signal: ac.signal,
        }),
        timeoutPromise,
      ])
    } catch (error) {
      clearTimeout(timer)
      if (error?.certainty === 'unknown' || error?.certainty === 'not-sent') throw error
      const code = String(error?.code || error?.cause?.code || '')
      if (timedOut || error?.name === 'TimeoutError' || error?.name === 'AbortError' || /timeout|aborted/i.test(String(error?.message || ''))) {
        throw makeSendError('unknown', 'timeout', instance, `${action}超时（按 unknown 处理）`)
      }
      if (CONNECT_REFUSED_CODES.has(code)) {
        throw makeSendError('not-sent', code.toLowerCase(), instance, `${action}未连上平台（${code}）`)
      }
      throw makeSendError('unknown', code || 'network-error', instance, `${action}网络异常（按 unknown 处理）：${redactDingtalkSecrets(error?.message || error, [clientSecretOf()])}`)
    }

    let data = null
    let text = ''
    let parseOk = true
    try {
      if (typeof response?.text === 'function') {
        text = await Promise.race([response.text(), timeoutPromise])
        if (text) {
          try { data = JSON.parse(text) } catch { parseOk = false }
        }
      } else if (typeof response?.json === 'function') {
        data = await Promise.race([response.json(), timeoutPromise])
      }
    } catch (error) {
      clearTimeout(timer)
      if (error?.certainty === 'unknown' || error?.certainty === 'not-sent') throw error
      throw makeSendError('unknown', 'read-failed', instance, `${action}读取响应异常（按 unknown 处理）`)
    } finally {
      clearTimeout(timer)
    }

    const status = Number(response?.status ?? (response?.ok === false ? 500 : 200))
    if (status >= 500 || (status >= 200 && status < 300 && !parseOk)) {
      throw makeSendError('unknown', status >= 500 ? `http-${status}` : 'invalid-response', instance, `${action}返回异常响应（HTTP ${status}，按 unknown 处理）`)
    }
    if (status === 408) {
      throw makeSendError('unknown', 'http-408', instance, `${action}请求超时（HTTP 408，按 unknown 处理）`)
    }
    if (status >= 400 || response?.ok === false) {
      const pCode = cleanString(String(data?.code ?? data?.errcode ?? ''))
      const errTag = status === 429 ? 'rate-limited' : (status === 401 || status === 403 ? 'permission-denied' : (pCode || `http-${status}`))
      const err = makeSendError('not-sent', errTag, instance, `${action}被平台拒绝（HTTP ${status}${pCode ? ' / ' + pCode : ''}）`)
      err.httpStatus = status
      throw err
    }
    if (!data || typeof data !== 'object') {
      throw makeSendError('unknown', 'empty-response', instance, `${action}响应格式无效`)
    }
    return { status, data }
  }

  function invalidateAccessToken(badToken = '') {
    if (!badToken || tokenCache.value === badToken) {
      tokenCache = { value: '', expiresAt: 0, clientId: '' }
    }
  }

  function isInvalidTokenError(err) {
    if (!err) return false
    if (err.httpStatus === 401) return true
    const code = String(err.code || '')
    return code === 'upload-40014' || code === 'InvalidAuthentication'
  }

  async function runWithAccessToken(fn, { timeoutMs = timeoutMsOf, guard = null, hasSent = false } = {}) {
    const budgetMs = () => (typeof timeoutMs === 'function' ? timeoutMs() : timeoutMs)
    const tok1 = await getAccessToken(budgetMs())
    try {
      return await fn(tok1)
    } catch (err) {
      if (!isInvalidTokenError(err) || err?.certainty === 'unknown') throw err
      invalidateAccessToken(tok1)
      if (guard) assertReplyCurrent(guard, instance, hasSent)
      if (budgetMs() <= 50) throw err
      const tok2 = await getAccessToken(budgetMs())
      if (guard) assertReplyCurrent(guard, instance, hasSent)
      return fn(tok2)
    }
  }

  async function getAccessToken(timeoutMs = timeoutMsOf()) {
    const clientId = clientIdOf()
    const clientSecret = clientSecretOf()
    if (!clientId || !clientSecret) {
      throw makeSendError('not-sent', 'unconfigured', instance, '钉钉缺少 clientId 或 clientSecret')
    }
    const now = clock()
    if (tokenCache.value && tokenCache.clientId === clientId && tokenCache.expiresAt > now) {
      return tokenCache.value
    }
    if (tokenInFlight) return tokenInFlight
    tokenInFlight = (async () => {
      const { data } = await requestJsonWithBudget(`${apiBaseOf()}/v1.0/oauth2/accessToken`, {
        method: 'POST',
        body: { appKey: clientId, appSecret: clientSecret },
        timeoutMs,
        action: '获取钉钉 access_token',
      })
      const token = cleanString(data.accessToken)
      if (!token) {
        throw makeSendError('not-sent', 'invalid-access-token', instance, '钉钉鉴权未返回 accessToken')
      }
      const expireSec = Number(data.expireIn ?? data.expiresIn)
      const ttlMs = Number.isFinite(expireSec) && expireSec > 60 ? (expireSec - 60) * 1000 : 6000 * 1000
      tokenCache = { value: token, clientId, expiresAt: clock() + ttlMs }
      return token
    })().finally(() => { tokenInFlight = null })
    return tokenInFlight
  }

  function handleInboundPayload(payload, callbackMessageId = '') {
    if (!running || stopped) return false
    const parsed = parseDingtalkInbound(payload, {
      botId: self.account || clientIdOf(),
      callbackMessageId,
      now: clock,
      registerMedia: (idKey, entry) => setBoundedMap(mediaCache, idKey, entry, MAX_MEDIA_CACHE_ENTRIES),
      registerQuote: (qid, rec) => setBoundedMap(quoteCache, qid, rec, MAX_QUOTE_CACHE_ENTRIES),
    })
    if (!parsed) return false
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

  function handleWsMessage(rawText) {
    if (!running || stopped) return
    armIdleWatchdog(connGen)
    let msg
    try {
      msg = JSON.parse(rawText)
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return

    const msgId = msg.headers?.messageId
    const topic = String(msg.headers?.topic || '')

    if (msg.type === 'SYSTEM') {
      if (topic === 'ping') {
        sendWsJson({ code: 200, headers: msg.headers, message: 'OK', data: msg.data })
      } else if (topic === 'disconnect') {
        connected = false
        closeWsOnly()
        ctx?.state?.('disconnected', '钉钉 Stream 服务端要求断开，准备重连')
        scheduleReconnect('disconnect')
      }
      return
    }

    if (msg.type === 'EVENT') {
      if (msgId) {
        sendWsJson({
          code: 200,
          headers: { contentType: 'application/json', messageId: msgId },
          message: 'OK',
          data: JSON.stringify({ status: 'SUCCESS' }),
        })
      }
      ctx?.emitEvent?.({ type: 'native', name: topic || 'dingtalk-event', raw: msg })
      return
    }

    if (msg.type === 'CALLBACK') {
      // 官方 Stream 要求及时 ACK，防止超时触发重投
      if (msgId) {
        sendWsJson({
          code: 200,
          headers: { contentType: 'application/json', messageId: msgId },
          message: 'OK',
          data: JSON.stringify({ response: { success: true } }),
        })
      }
      if (topic === TOPIC_ROBOT) {
        let payload = msg.data
        if (typeof payload === 'string') {
          try { payload = JSON.parse(payload) } catch { return }
        }
        handleInboundPayload(payload, msgId)
      }
    }
  }

  async function openStreamConnection(myGen) {
    const clientId = clientIdOf()
    const clientSecret = clientSecretOf()
    const openRes = await requestJsonWithBudget(`${apiBaseOf()}/v1.0/gateway/connections/open`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: {
        clientId,
        clientSecret,
        ua: 'aurabot-dingtalk/1.0',
        subscriptions: [
          { type: 'EVENT', topic: '*' },
          { type: 'CALLBACK', topic: TOPIC_ROBOT },
        ],
      },
      timeoutMs: connectTimeoutMs,
      action: '注册钉钉 Stream 连接',
    })
    if (!running || stopped || myGen !== connGen) return

    const endpoint = cleanString(openRes.data?.endpoint)
    const ticket = cleanString(openRes.data?.ticket)
    if (!endpoint || !ticket) {
      throw new Error('钉钉 connections/open 未返回有效 endpoint 或 ticket')
    }
    const apiBase = apiBaseOf()
    const customApiBase = apiBase !== DINGTALK_API_BASE_URL
    let customApiHost = ''
    if (customApiBase) {
      try { customApiHost = new URL(apiBase).hostname } catch {}
    }
    const wsUrlObj = normalizeDingtalkStreamEndpoint(endpoint, {
      allowInsecure: customApiBase,
      allowedHost: customApiHost,
    })
    wsUrlObj.searchParams.set('ticket', ticket)
    const socket = wsFactory(wsUrlObj.toString())
    ws = socket

    await new Promise((resolveConn, rejectConn) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        rejectConn(new Error(`钉钉 WebSocket 建连超时（>${connectTimeoutMs}ms）`))
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
        rejectConn(err instanceof Error ? err : new Error(String(err || 'WebSocket connection failed')))
      }

      detachWs = attachWsListeners(socket, {
        onOpen: () => {
          if (!running || stopped || myGen !== connGen) {
            closeWsOnly()
            settleErr(new Error('stopped'))
            return
          }
          connected = true
          reconnectAttempts = 0
          armIdleWatchdog(myGen)
          armPingTimer(myGen)
          settleOk()
        },
        onMessage: (rawText) => {
          if (myGen !== connGen) return
          handleWsMessage(rawText)
        },
        onPing: () => {
          if (!running || stopped || !connected || myGen !== connGen) return
          armIdleWatchdog(myGen)
        },
        onPong: () => {
          if (!running || stopped || !connected || myGen !== connGen) return
          armIdleWatchdog(myGen)
        },
        onClose: () => {
          const wasInitialPending = !settled
          if (wasInitialPending) {
            settleErr(new Error('钉钉 Stream WebSocket 连接关闭'))
            return
          }
          if (!running || stopped || myGen !== connGen) return
          connected = false
          ws = null
          detachWs = null
          clearIdleWatchdog()
          clearPingTimer()
          ctx?.state?.('disconnected', '钉钉 Stream 连接已断开，准备重连')
          scheduleReconnect('ws-close')
        },
        onError: (err) => {
          if (!settled) settleErr(err)
        },
      })

      if (socket.readyState === 1) {
        connected = true
        reconnectAttempts = 0
        armIdleWatchdog(myGen)
        armPingTimer(myGen)
        settleOk()
      }
    })
  }

  function scheduleReconnect(reason) {
    if (!running || stopped || !RETRYABLE_CONNECT_CLOSE.has(reason)) return
    clearReconnectTimer()
    const delayMs = Math.min(reconnectMaxMs, reconnectBaseMs * Math.pow(2, Math.min(5, reconnectAttempts)))
    reconnectAttempts++
    const myGen = connGen
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (!running || stopped || myGen !== connGen) return
      ctx?.state?.('connecting', `钉钉 Stream 重连中（第 ${reconnectAttempts} 次）`)
      openStreamConnection(myGen).then(() => {
        if (running && !stopped && myGen === connGen) {
          ctx?.state?.('connected')
        }
      }).catch((err) => {
        if (!running || stopped || myGen !== connGen) return
        connected = false
        closeWsOnly()
        ctx?.state?.('disconnected', redactDingtalkSecrets(err?.message || '钉钉重连失败', [clientSecretOf()]))
        scheduleReconnect('ws-close')
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
        throw makeSendError('not-sent', 'media-download-failed', instance, `下载媒体失败（HTTP ${r?.status ?? '?'}）`)
      }
      const bounded = await readResponseBytesBounded(r, maxBytes)
      if (!bounded.ok) {
        if (bounded.reason === 'too-large') {
          throw makeSendError('not-sent', 'too-large', instance, `媒体大小 ${bounded.size} 字节超过钉钉上限 ${maxBytes}`)
        }
        throw makeSendError('not-sent', 'empty-media', instance, '下载的媒体为空')
      }
      return bounded.bytes
    }
    throw makeSendError('not-sent', 'too-many-redirects', instance, '媒体下载地址重定向次数过多')
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
      throw makeSendError('not-sent', 'too-large', instance, `本地文件 ${st.size} 字节超过钉钉上限 ${maxBytes}`)
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

  async function resolveOutboundMedia(media, kindLabel, timeoutMs, maxBytes) {
    const sizeHint = Number(media?.size)
    if (sizeHint > 0 && maxBytes > 0 && sizeHint > maxBytes) {
      throw makeSendError('not-sent', 'too-large', instance, `${kindLabel}大小 ${sizeHint} 字节超过钉钉上限 ${maxBytes}`)
    }
    let bytes = null
    if (media?.bytes) {
      bytes = Buffer.isBuffer(media.bytes) ? media.bytes : Buffer.from(media.bytes)
    } else if (media?.path) {
      bytes = readGuardedLocalFile(media.path, maxBytes)
    } else if (media?.id && !String(media.id).startsWith('dt:') && !mediaCache.has(String(media.id))) {
      // 允许直接复用已上传返回的 mediaId 或契约测试内置 id（离线不请求外网 URL）
      return { directMediaId: String(media.id), fileName: cleanString(media?.name) || (kindLabel === '图片' ? 'image.png' : 'file.bin') }
    } else if (media?.url) {
      bytes = await downloadGuardedUrl(media.url, timeoutMs, maxBytes)
    }
    if (!bytes) {
      throw makeSendError('not-sent', 'media-needs-upload', instance, `${kindLabel}缺少可用内容（bytes/path/url 或 mediaId）`)
    }
    if (!bytes.length) {
      throw makeSendError('not-sent', 'empty-media', instance, `${kindLabel}内容为空，无法发送`)
    }
    if (maxBytes > 0 && bytes.length > maxBytes) {
      throw makeSendError('not-sent', 'too-large', instance, `${kindLabel}大小 ${bytes.length} 字节超过钉钉上限 ${maxBytes}`)
    }
    return {
      bytes,
      mime: cleanString(media?.mime) || 'application/octet-stream',
      fileName: cleanString(media?.name) || (kindLabel === '图片' ? 'image.png' : 'file.bin'),
    }
  }

  async function uploadMediaBytes({ bytes, mime, fileName, uploadType }, timeoutMs, guard = null, hasSent = false) {
    const deadline = Date.now() + Math.max(50, Number(timeoutMs) || timeoutMsOf())
    const remaining = () => Math.max(50, deadline - Date.now())
    return runWithAccessToken(async (token) => {
      const uploadUrl = new URL('media/upload', oapiBaseOf())
      uploadUrl.searchParams.set('access_token', token)
      uploadUrl.searchParams.set('type', uploadType)
      const form = new FormData()
      form.append('media', new Blob([bytes], { type: mime }), fileName)
      const { data } = await requestJsonWithBudget(uploadUrl.toString(), {
        method: 'POST',
        body: form,
        isForm: true,
        timeoutMs: remaining(),
        action: `钉钉上传${uploadType === 'image' ? '图片' : uploadType === 'voice' ? '语音' : '文件'}`,
      })
      if (data.errcode !== undefined && Number(data.errcode) !== 0) {
        throw makeSendError('not-sent', `upload-${data.errcode}`, instance, `钉钉媒体上传被拒绝（errcode=${data.errcode}）`)
      }
      const mediaId = cleanString(data.media_id)
      if (!mediaId) {
        throw makeSendError('not-sent', 'missing-media-id', instance, '钉钉媒体上传未返回 media_id')
      }
      return mediaId
    }, { timeoutMs: remaining, guard, hasSent })
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
      { key: 'clientId', label: 'Client ID（AppKey）', type: 'text', default: '', hint: '推荐使用上方「钉钉扫码创建机器人」自动填写；也可在钉钉开放平台 → 应用凭证复制' },
      { key: 'clientSecret', label: 'Client Secret（AppSecret）', type: 'password', default: '', hint: '仅保存在本机宿主配置，面板不回显原文；留空保持不变' },
      { key: 'apiBaseUrl', label: 'OpenAPI 服务地址', type: 'text', default: DINGTALK_API_BASE_URL, hint: '默认 https://api.dingtalk.com' },
      { key: 'oapiBaseUrl', label: 'OAPI 服务地址', type: 'text', default: DINGTALK_OAPI_BASE_URL, hint: '默认 https://oapi.dingtalk.com' },
      { key: 'proactive', label: '主动消息策略', type: 'select', options: ['free', 'none'], default: 'free', hint: 'free 允许主动发送机器人消息；设为 none 时只允许被动回复' },
      { key: 'maxTextChars', label: '单条文本上限（字符）', type: 'number', default: DEFAULT_MAX_TEXT_CHARS, hint: '超出自动分段发送' },
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

      const cid = clientIdOf()
      const csec = clientSecretOf()
      if (!cid || !csec) {
        running = false
        connected = false
        stopped = true
        ctx?.state?.('unconfigured', '请先通过「钉钉扫码创建机器人」获取凭证或手动填写 Client ID / Client Secret')
        throw new Error('dingtalk：缺少 Client ID / Client Secret，无法启动')
      }

      running = true
      stopped = false
      connected = false
      reconnectAttempts = 0
      self = { account: cid, name: cleanString(cfg.botName) || name }
      ctx?.state?.('connecting', '正在连接钉钉 Stream 长连接…')

      const myGen = ++connGen
      try {
        await openStreamConnection(myGen)
      } catch (err) {
        stopped = true
        running = false
        connected = false
        closeWsOnly()
        const rawMsg = cleanString(err?.message) || cleanString(err?.cause?.message) || (err ? String(err) : '钉钉连接失败')
        const safeMsg = redactDingtalkSecrets(rawMsg, [csec])
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
      clearReconnectTimer()
      closeWsOnly()
      tokenCache = { value: '', expiresAt: 0, clientId: '' }
      replyContextCache.clear()
      mediaCache.clear()
      quoteCache.clear()
      ctx?.state?.('stopped')
    },

    async whoami() {
      return { account: self.account || clientIdOf(), name: self.name || name }
    },

    async send(message = {}, { replyGuard, proactiveGuard } = {}) {
      const guard = replyGuard || proactiveGuard
      assertReplyCurrent(guard, instance, false)

      if (!running || !connected || stopped) {
        throw makeSendError('not-sent', 'not-connected', instance, '钉钉平台端未连接')
      }
      if (failSend === 'refused') {
        failSend = null
        throw makeSendError('not-sent', 'platform-refused', instance, '钉钉连接被拒绝')
      }
      if (failSend === 'timeout') {
        failSend = null
        throw makeSendError('unknown', 'timeout', instance, '钉钉请求超时（可能已发出，按 unknown 处理）')
      }

      const currentCaps = adapter.caps()
      const chatKind = message?.chat?.kind === 'group' ? 'group' : 'private'
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
      let textBuf = []
      let atUsers = []
      let isAtAll = false

      const flushText = () => {
        if (!textBuf.length) return
        const joined = textBuf.join('').trim()
        textBuf = []
        if (!joined) {
          atUsers = []
          isAtAll = false
          return
        }
        const atSnapshot = (atUsers.length || isAtAll)
          ? { ...(atUsers.length ? { atUserIds: [...atUsers] } : {}), ...(isAtAll ? { isAtAll: true } : {}) }
          : null
        atUsers = []
        isAtAll = false
        for (const chunk of splitDingtalkText(joined, maxChars)) {
          queue.push({ kind: 'text', text: chunk, at: atSnapshot })
        }
      }

      for (const part of Array.isArray(message?.parts) ? message.parts : []) {
        if (!part || typeof part !== 'object') continue
        switch (part.type) {
          case 'text':
            if (part.text) textBuf.push(String(part.text))
            break
          case 'mention':
            if (part.account === 'all') {
              isAtAll = true
              textBuf.push('@所有人 ')
            } else if (part.account) {
              atUsers.push(String(part.account))
              textBuf.push(`@${part.name || part.account} `)
            }
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

      const replyCtx = inResponseTo ? replyContextCache.get(inResponseTo) : null
      const canUseWebhook = Boolean(
        replyCtx?.sessionWebhook
        && replyCtx.chatKind === chatKind
        && replyCtx.chatId === chatId
        && (!replyCtx.expiresAt || clock() < replyCtx.expiresAt),
      )

      const deadline = Date.now() + timeoutMs
      const remainingTimeout = () => Math.max(50, deadline - Date.now())
      let lastMessageId = ''

      for (const item of queue) {
        assertReplyCurrent(guard, instance, Boolean(lastMessageId))
        if (item.kind === 'text' && canUseWebhook) {
          const { data } = await runWithAccessToken(async (token) => {
            assertReplyCurrent(guard, instance, Boolean(lastMessageId))
            return requestJsonWithBudget(replyCtx.sessionWebhook, {
              method: 'POST',
              headers: { 'x-acs-dingtalk-access-token': token },
              body: { msgtype: 'text', text: { content: item.text }, ...(item.at ? { at: item.at } : {}) },
              timeoutMs: remainingTimeout(),
              action: '钉钉 sessionWebhook 回复',
            })
          }, { timeoutMs: remainingTimeout, guard, hasSent: Boolean(lastMessageId) })
          if ((data.errcode !== undefined && Number(data.errcode) !== 0) || (data.code !== undefined && Number(data.code) !== 0)) {
            throw makeSendError('not-sent', String(data.errcode ?? data.code ?? 'send-rejected'), instance, '钉钉拒绝了回复消息')
          }
          lastMessageId = cleanString(data.processQueryKey || data.messageId) || `dt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
          continue
        }

        const robotCode = cleanString(replyCtx?.robotCode) || clientIdOf()
        let msgKey = 'sampleText'
        let msgParamObj = { content: item.text }

        if (item.kind === 'image') {
          const resolved = await resolveOutboundMedia(item.media, '图片', remainingTimeout(), maxBytes)
          const mediaId = resolved.directMediaId || await uploadMediaBytes({ ...resolved, uploadType: 'image' }, remainingTimeout(), guard, Boolean(lastMessageId))
          msgKey = 'sampleImageMsg'
          msgParamObj = { photoURL: mediaId }
        } else if (item.kind === 'voice') {
          const resolved = await resolveOutboundMedia(item.media, '语音', remainingTimeout(), maxBytes)
          if (resolved.directMediaId) {
            if (item.durationMs > 0) {
              msgKey = 'sampleAudio'
              msgParamObj = { mediaId: resolved.directMediaId, duration: String(Math.round(item.durationMs)) }
            } else {
              const fName = resolved.fileName && !resolved.fileName.endsWith('.bin') ? resolved.fileName : 'voice.amr'
              const fileType = extname(fName).slice(1).toLowerCase() || 'bin'
              msgKey = 'sampleFile'
              msgParamObj = { mediaId: resolved.directMediaId, fileName: fName, fileType }
            }
          } else {
            let voiceBytes = null
            let voiceExt = ''
            let voiceMime = ''
            let durationMs = 0
            if (isAmrBytes(resolved.bytes)) {
              voiceBytes = resolved.bytes
              voiceExt = 'amr'
              voiceMime = 'audio/amr'
              durationMs = estimateAmrDurationMs(voiceBytes) || item.durationMs
            } else if (isOggOpusBytes(resolved.bytes)) {
              voiceBytes = resolved.bytes
              voiceExt = 'ogg'
              voiceMime = 'audio/ogg'
              durationMs = estimateOggOpusDurationMs(voiceBytes) || item.durationMs
            } else {
              const ffmpegPath = resolveFfmpegPath()
              if (ffmpegPath) {
                const tr = await transcodeAudioForWechat(resolved.bytes, {
                  targetFormat: 'amr',
                  ffmpegPath,
                  timeoutMs: Math.min(15_000, remainingTimeout()),
                })
                if (tr.ok && isAmrBytes(tr.bytes)) {
                  voiceBytes = tr.bytes
                  voiceExt = 'amr'
                  voiceMime = 'audio/amr'
                  durationMs = estimateAmrDurationMs(voiceBytes) || item.durationMs
                }
              }
            }
            if (voiceBytes && voiceBytes.length <= DEFAULT_MAX_VOICE_BYTES && durationMs > 0) {
              const mediaId = await uploadMediaBytes({
                bytes: voiceBytes,
                mime: voiceMime,
                fileName: `voice.${voiceExt}`,
                uploadType: 'voice',
              }, remainingTimeout(), guard, Boolean(lastMessageId))
              msgKey = 'sampleAudio'
              msgParamObj = { mediaId, duration: String(Math.round(durationMs)) }
            } else {
              const inferredMime = inferMimeFromBytes(resolved.bytes)
              const realExt = inferredMime ? extForMime(inferredMime, 'bin') : ''
              const { fileName, ext: fileType } = fallbackVoiceName(item.media?.name, realExt, isAmrBytes(resolved.bytes))
              const mediaId = await uploadMediaBytes({
                bytes: resolved.bytes,
                mime: inferredMime || resolved.mime || 'application/octet-stream',
                fileName,
                uploadType: 'file',
              }, remainingTimeout(), guard, Boolean(lastMessageId))
              msgKey = 'sampleFile'
              msgParamObj = { mediaId, fileName, fileType }
            }
          }
        } else if (item.kind === 'file') {
          const resolved = await resolveOutboundMedia(item.media, '文件', remainingTimeout(), maxBytes)
          const mediaId = resolved.directMediaId || await uploadMediaBytes({ ...resolved, uploadType: 'file' }, remainingTimeout(), guard, Boolean(lastMessageId))
          const fName = resolved.fileName || 'file.bin'
          const fileType = extname(fName).slice(1).toLowerCase() || 'bin'
          msgKey = 'sampleFile'
          msgParamObj = { mediaId, fileName: fName, fileType }
        }

        const apiPath = chatKind === 'group' ? 'v1.0/robot/groupMessages/send' : 'v1.0/robot/oToMessages/batchSend'
        const sendBody = {
          robotCode,
          msgKey,
          msgParam: JSON.stringify(msgParamObj),
          ...(chatKind === 'group' ? { openConversationId: chatId } : { userIds: [chatId] }),
        }
        const { data } = await runWithAccessToken(async (token) => {
          assertReplyCurrent(guard, instance, Boolean(lastMessageId))
          return requestJsonWithBudget(`${apiBaseOf()}/${apiPath}`, {
            method: 'POST',
            headers: { 'x-acs-dingtalk-access-token': token },
            body: sendBody,
            timeoutMs: remainingTimeout(),
            action: '钉钉发送机器人消息',
          })
        }, { timeoutMs: remainingTimeout, guard, hasSent: Boolean(lastMessageId) })
        if ((data.errcode !== undefined && Number(data.errcode) !== 0) || (data.code !== undefined && Number(data.code) !== 0 && data.code !== '0')) {
          throw makeSendError('not-sent', String(data.errcode ?? data.code ?? 'send-rejected'), instance, '钉钉拒绝了机器人消息')
        }
        lastMessageId = cleanString(data.processQueryKey || data.messageId) || `dt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      }

      return { messageId: lastMessageId }
    },

    async fetch(request) {
      if (request?.kind === 'message') {
        const mid = cleanString(request.messageId)
        const hit = mid ? quoteCache.get(mid) : null
        if (hit) return hit
        throw makeSendError('not-sent', 'message-not-found', instance, '未找到该钉钉引用消息的缓存正文')
      }
      if (request?.kind !== 'media') {
        throw makeSendError('not-sent', 'unsupported-fetch', instance, `钉钉不支持 fetch('${String(request?.kind || '')}')`)
      }
      const media = request.media || {}
      const cached = media.id ? mediaCache.get(String(media.id)) : null
      const parsedId = media.id ? parseDingtalkMediaId(media.id) : null
      const downloadCode = cached?.downloadCode || parsedId?.downloadCode
      const robotCode = cached?.robotCode || parsedId?.robotCode || clientIdOf()

      if (downloadCode && robotCode) {
        const timeoutMs = timeoutMsOf()
        const deadline = Date.now() + timeoutMs
        const remaining = () => Math.max(50, deadline - Date.now())
        const { data } = await runWithAccessToken(async (token) => requestJsonWithBudget(`${apiBaseOf()}/v1.0/robot/messageFiles/download`, {
          method: 'POST',
          headers: { 'x-acs-dingtalk-access-token': token },
          body: { downloadCode, robotCode },
          timeoutMs: remaining(),
          action: '换取钉钉媒体下载地址',
        }), { timeoutMs: remaining })
        let downloadUrl = cleanString(data.downloadUrl ?? data.download_url)
        if (!downloadUrl) throw makeSendError('not-sent', 'missing-download-url', instance, '钉钉未返回媒体下载地址')
        const u = new URL(downloadUrl)
        if (u.protocol === 'http:' && (!u.port || u.port === '80')) {
          u.protocol = 'https:'
          u.port = ''
          downloadUrl = u.toString()
        }
        const bytes = await downloadGuardedUrl(downloadUrl, remaining(), maxFileBytesOf())
        return {
          bytes,
          mime: inferMimeFromBytes(bytes) || nonWildcardMime(cached?.mime) || nonWildcardMime(media.mime) || 'application/octet-stream',
          ...(cached?.name || media.name ? { name: cached?.name || media.name } : {}),
        }
      }
      if (media.url) {
        const bytes = await downloadGuardedUrl(media.url, timeoutMsOf(), maxFileBytesOf())
        return {
          bytes,
          mime: inferMimeFromBytes(bytes) || nonWildcardMime(media.mime) || 'application/octet-stream',
          ...(media.name ? { name: media.name } : {}),
        }
      }
      throw makeSendError('not-sent', 'media-not-found', instance, '未找到可下载的钉钉媒体标识或地址')
    },
  }

  adapter.platform = {
    deliver(payload, callbackMessageId = '') {
      return handleInboundPayload(payload, callbackMessageId)
    },
    injectFrame(rawText) {
      handleWsMessage(typeof rawText === 'string' ? rawText : JSON.stringify(rawText))
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
      connected = true
      ctx?.state?.('connected')
    },
    getFetch: resolveFetch,
  }

  return adapter
}

export {
  createDingtalkAuthDriver,
  DINGTALK_REGISTRATION_BASE_URL,
  DINGTALK_REGISTRATION_SOURCE,
}

export default createDingtalkAdapter()
