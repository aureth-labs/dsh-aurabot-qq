// 平台端：个人微信 ClawBot（基于腾讯官方 iLink Bot HTTP 长轮询协议，无需 OpenClaw）。
// 契约依据：src/gateway/contracts.d.ts（PlatformAdapter / AdapterInbound / SendError / Caps / Feature）
// 与 docs/CONTRACTS.md 第六～八节；平台说明见 docs/ADAPTER-WECHAT-CLAWBOT.md。
//
// 硬边界（方案 §三 / §四 / §五）：
//   1. 与企业微信 wecom 彻底分离，不共享身份、chatId 命名空间、caps 或 API 客户端。
//   2. 诚实能力声明：以 1:1 私聊为主（allowGroup 默认 false）；无原生表情包（按图片降级）；
//      语音默认按文件发送（iLink 实测会接受机器人 voice_item 但不投递）；仅 voiceOutbound=true 时尝试 SILK 语音条；无历史/成员列表/合并转发；不接入 group-admin。
//   3. emit 是特权口：机器人自身消息（message_type===2）走 self-sent 不 emit；stop() 后绝不再 emit。
//   4. 面板二维码登录通过 node 内置加密与本地 SVG 生成（不向第三方二维码服务泄漏 URL）。

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { assertPublicUrl } from '../../core/net.js'
import { ensureDir } from '../../core/store.js'
import { sanitizeFeaturesInput } from '../../gateway/features.js'
import {
  checkMediaConstraints,
  classifyTransportError,
  createProactiveRateLimiter,
  createSendError,
  encodeQrSvgDataUri,
  extForMime,
  formatWechatErrorSummary,
  inferMimeFromBytes,
  splitWechatText,
  transcodeAudioToSilk,
} from '../wechat-common/index.js'

// ───────────────────────── 平台常量（腾讯 iLink Bot 协议） ─────────────────────────

export const PLATFORM_ID = 'wechat-clawbot'
export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
export const DEFAULT_BOT_TYPE = '3'
export const CHANNEL_VERSION = '1.0.3'
export const ILINK_CLIENT_VERSION = '1'

export const PATH_QR_CODE = '/ilink/bot/get_bot_qrcode'
export const PATH_QR_STATUS = '/ilink/bot/get_qrcode_status'
export const PATH_GET_UPDATES = '/ilink/bot/getupdates'
export const PATH_SEND_MESSAGE = '/ilink/bot/sendmessage'
export const PATH_GET_UPLOAD_URL = '/ilink/bot/getuploadurl'
export const PATH_GET_CONFIG = '/ilink/bot/getconfig'
export const PATH_SEND_TYPING = '/ilink/bot/sendtyping'

export const MESSAGE_TYPE = Object.freeze({ USER: 1, BOT: 2 })
export const MESSAGE_STATE = Object.freeze({ NEW: 0, GENERATING: 1, FINISH: 2 })
export const ITEM_TYPE = Object.freeze({ TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 })
export const UPLOAD_MEDIA_TYPE = Object.freeze({ IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 })
export const TYPING_STATUS = Object.freeze({ TYPING: 1, CANCEL: 2 })

export const SESSION_EXPIRED_ERRCODE = -14
export const DEFAULT_MAX_TEXT_CHARS = 2000
export const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024
export const DEFAULT_TIMEOUT_MS = 15_000
export const DEFAULT_POLL_TIMEOUT_MS = 35_000
export const DEFAULT_STARTUP_WAIT_MS = 1500
export const DEFAULT_CONTEXT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000
export const DEFAULT_TYPING_TICKET_TTL_MS = 9 * 60 * 1000
const MAX_MEDIA_CACHE_ENTRIES = 500
const MAX_CONTEXT_ENTRIES = 2000

/**
 * 保守能力声明（方案 §1.2 / §5 / §6）：
 * 未经 W0 实测确认的能力一律报 false，绝不靠提示词掩盖。
 */
export const CAPS_WECHAT_CLAWBOT = Object.freeze({
  image: true,
  sticker: false, // 无原生微信表情包接口：按普通图片发送，禁 qq_import_stickers
  voice: 'file', // 默认按文件发；实测 iLink 接受机器人 voice_item 但不投递，voiceOutbound=true 仅作实验
  video: true,
  file: true,
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
  quoteReply: false,
  mention: false,
  mentionAll: false,
  poke: false,
  typing: true,
  recall: false,
  card: false,
  listenAllInGroup: false,
  proactive: 'limited', // 受限于 context_token 有效期与频率控制，不能无限主动连发
  replyWindowMs: 0,
  repliesPerMessage: 0,
  history: false,
  memberList: false,
  forwardExpand: false,
  features: Object.freeze({
    'message.quote.send': false,
    'message.quote.read': false,
    'message.history.read': false,
    'message.forward.expand': false,
    'message.recall': false,
    'message.reaction': false,
    'media.fetch': true,
    'chat.member.list': false,
    'chat.member.read': false,
    'chat.typing': true,
    'sticker.send.native': false,
    'sticker.collect': true,
    'sticker.sync.native': false,
    'card.send': false,
  }),
})

// ───────────────────────── 加解密与请求头工具（公开给单测） ─────────────────────────

/** PKCS#7 对齐后 AES-128-ECB 密文字节长度 */
export function aesEcbPaddedSize(rawSize) {
  const n = Math.max(0, Number(rawSize) || 0)
  return (Math.floor(n / 16) + 1) * 16
}

/**
 * 解析 iLink CDN aes_key，兼容全部三种编码形态：
 *   1. 原始 32 位十六进制串（部分入站 image_item.aeskey）
 *   2. base64(16 字节原始密钥)（图片常见 Format A）
 *   3. base64(32 字节 ASCII 十六进制串)（文件/语音/视频与出站常见 Format B）
 */
export function parseAesKey(input) {
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    if (input.length === 16) return Buffer.from(input)
    throw new Error(`aes_key Buffer 长度应为 16 字节，实际 ${input.length}`)
  }
  const s = String(input || '').trim()
  if (!s) throw new Error('缺少 aes_key')
  if (/^[0-9a-fA-F]{32}$/.test(s)) {
    return Buffer.from(s, 'hex')
  }
  const decoded = Buffer.from(s, 'base64')
  if (decoded.length === 16) {
    return decoded
  }
  if (decoded.length === 32) {
    const ascii = decoded.toString('ascii')
    if (/^[0-9a-fA-F]{32}$/.test(ascii)) {
      return Buffer.from(ascii, 'hex')
    }
  }
  throw new Error(`aes_key 格式无效（解码后 ${decoded.length} 字节，既非 16 字节原密钥也非 32 位 hex）`)
}

/** AES-128-ECB + PKCS#7 加密 */
export function encryptAesEcb(plainBuf, keyBuf) {
  const key = parseAesKey(keyBuf)
  const data = Buffer.isBuffer(plainBuf) ? plainBuf : Buffer.from(plainBuf || [])
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(data), cipher.final()])
}

/** AES-128-ECB + PKCS#7 解密 */
export function decryptAesEcb(cipherBuf, keyBuf) {
  const key = parseAesKey(keyBuf)
  const data = Buffer.isBuffer(cipherBuf) ? cipherBuf : Buffer.from(cipherBuf || [])
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(data), decipher.final()])
}

/** 出站 CDNMedia.aes_key 按 openclaw-weixin 规范编为 base64(32 位小写 hex) */
export function encodeOutboundAesKey(keyBuf) {
  const key = parseAesKey(keyBuf)
  return Buffer.from(key.toString('hex'), 'ascii').toString('base64')
}

/** 生成 X-WECHAT-UIN 随机 uint32 字符串的 base64 */
export function buildWechatUinHeader() {
  const n = randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(n), 'utf8').toString('base64')
}

export function buildIlinkHeaders({ botToken = '', routeTag = '', includeAuth = true } = {}) {
  const headers = {
    'iLink-App-ClientVersion': ILINK_CLIENT_VERSION,
    'X-WECHAT-UIN': buildWechatUinHeader(),
  }
  if (routeTag) headers.SKRouteTag = String(routeTag)
  if (includeAuth) {
    headers['Content-Type'] = 'application/json'
    headers.AuthorizationType = 'ilink_bot_token'
    if (botToken) headers.Authorization = `Bearer ${botToken}`
  }
  return headers
}

function normalizeBaseUrl(raw, fallback = DEFAULT_BASE_URL) {
  const s = String(raw || '').trim().replace(/\/+$/, '')
  return s || fallback
}

export function buildCdnDownloadUrl(cdnBaseUrl, encryptQueryParam) {
  const base = normalizeBaseUrl(cdnBaseUrl, DEFAULT_CDN_BASE_URL)
  return `${base}/download?encrypted_query_param=${encodeURIComponent(String(encryptQueryParam || ''))}`
}

export function buildCdnUploadUrl(cdnBaseUrl, uploadParam, filekey, uploadFullUrl = '') {
  if (uploadFullUrl && /^https?:\/\//i.test(String(uploadFullUrl))) return String(uploadFullUrl)
  const base = normalizeBaseUrl(cdnBaseUrl, DEFAULT_CDN_BASE_URL)
  return `${base}/upload?encrypted_query_param=${encodeURIComponent(String(uploadParam || ''))}&filekey=${encodeURIComponent(String(filekey || ''))}`
}

// ───────────────────────── HTTP 客户端（默认 fetch，测试注入假实现） ─────────────────────────

/**
 * 轻量 HTTP 客户端：原生 fetch + AbortController + Promise.race 超时兜底（支持外部 signal 随时中止长轮询）。
 */
export function createIlinkHttpClient({ fetchImpl = globalThis.fetch } = {}) {
  return {
    async request(req = {}) {
      if (typeof fetchImpl !== 'function') {
        throw createSendError('not-sent', 'no-fetch', PLATFORM_ID, '当前运行环境缺少内置 fetch（需要 Node >= 22）')
      }
      const timeoutMs = Math.max(100, Number(req.timeoutMs) || DEFAULT_TIMEOUT_MS)
      const controller = new AbortController()
      const extSignal = req.signal
      if (extSignal?.aborted) {
        const abortErr = new Error('aborted')
        abortErr.name = 'AbortError'
        throw abortErr
      }
      const onExtAbort = () => controller.abort(extSignal?.reason)
      extSignal?.addEventListener?.('abort', onExtAbort, { once: true })

      let timedOut = false
      let timer
      const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          controller.abort()
          const err = new Error(`请求 ${timeoutMs}ms 超时`)
          err.name = 'TimeoutError'
          reject(err)
        }, timeoutMs)
        timer.unref?.()
      })

      try {
        const response = await Promise.race([
          fetchImpl(String(req.url || ''), {
            method: req.method || 'GET',
            headers: req.headers || {},
            body: req.body,
            ...(req.redirect ? { redirect: req.redirect } : {}),
            signal: controller.signal,
          }),
          timeout,
        ])
        if (req.responseType === 'bytes') {
          const ab = await Promise.race([response.arrayBuffer(), timeout])
          return {
            status: response.status,
            headers: response.headers,
            bytes: Buffer.from(ab),
            json: null,
            text: '',
          }
        }
        const text = await Promise.race([response.text().catch(() => ''), timeout])
        let json = null
        if (text) {
          try { json = JSON.parse(text) } catch { json = null }
        }
        return { status: response.status, headers: response.headers, json, text, bytes: null }
      } catch (error) {
        if (timedOut || error?.name === 'TimeoutError') {
          const err = new Error(`请求 ${timeoutMs}ms 超时`)
          err.name = 'TimeoutError'
          throw err
        }
        throw error
      } finally {
        clearTimeout(timer)
        extSignal?.removeEventListener?.('abort', onExtAbort)
      }
    },
  }
}

// ───────────────────────── 扫码登录（独立可测函数，供宿主机路由调用） ─────────────────────────

/**
 * 向腾讯 iLink 请求登录二维码，并本地渲染成 SVG Data URI。
 */
export async function startQrLogin({
  baseUrl = DEFAULT_BASE_URL,
  botType = DEFAULT_BOT_TYPE,
  routeTag = '',
  client = createIlinkHttpClient(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const root = normalizeBaseUrl(baseUrl, DEFAULT_BASE_URL)
  const url = `${root}${PATH_QR_CODE}?bot_type=${encodeURIComponent(String(botType || DEFAULT_BOT_TYPE))}`
  const r = await client.request({
    method: 'GET',
    url,
    headers: buildIlinkHeaders({ routeTag, includeAuth: false }),
    timeoutMs,
  })
  if (r.status < 200 || r.status >= 300 || !r.json) {
    throw new Error(formatWechatErrorSummary('获取微信登录二维码失败', r.status, r.json?.errmsg || r.text))
  }
  if (Number(r.json.errcode || r.json.ret || 0) !== 0 && !r.json.qrcode) {
    throw new Error(formatWechatErrorSummary('获取微信登录二维码失败', r.json.errcode ?? r.json.ret, r.json.errmsg))
  }
  const qrcode = String(r.json.qrcode || '').trim()
  const content = String(r.json.qrcode_img_content || '').trim()
  if (!qrcode || !content) {
    throw new Error('iLink 未返回有效的二维码数据（缺少 qrcode 或 qrcode_img_content）')
  }
  const qrDataUri = /^data:image\//i.test(content) ? content : encodeQrSvgDataUri(content)
  return {
    ok: true,
    qrcode,
    qrcodeUrl: content,
    qrDataUri,
    baseUrl: root,
  }
}

/**
 * 轮询二维码扫码状态（wait / scaned / confirmed / expired）。
 */
export async function pollQrStatus({
  baseUrl = DEFAULT_BASE_URL,
  qrcode,
  routeTag = '',
  client = createIlinkHttpClient(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const code = String(qrcode || '').trim()
  if (!code) throw new Error('缺少 qrcode 参数')
  const root = normalizeBaseUrl(baseUrl, DEFAULT_BASE_URL)
  const url = `${root}${PATH_QR_STATUS}?qrcode=${encodeURIComponent(code)}`
  const r = await client.request({
    method: 'GET',
    url,
    headers: buildIlinkHeaders({ routeTag, includeAuth: false }),
    timeoutMs,
  })
  if (r.status < 200 || r.status >= 300 || !r.json) {
    throw new Error(formatWechatErrorSummary('查询微信扫码状态失败', r.status, r.json?.errmsg || r.text))
  }
  const rawState = String(r.json.status || 'wait').toLowerCase()
  const state = rawState === 'scanned' ? 'scaned' : rawState
  if (state === 'confirmed') {
    const botToken = String(r.json.bot_token || '').trim()
    if (!botToken) throw new Error('微信已确认授权，但返回里缺少 bot_token')
    return {
      ok: true,
      state: 'confirmed',
      botToken,
      botId: String(r.json.ilink_bot_id || '').trim(),
      baseUrl: r.json.baseurl ? normalizeBaseUrl(r.json.baseurl, root) : root,
      userId: String(r.json.ilink_user_id || '').trim(),
      message: '扫码授权成功',
    }
  }
  if (state === 'expired') {
    return { ok: true, state: 'expired', message: '二维码已过期，请重新生成' }
  }
  if (state === 'scaned') {
    return { ok: true, state: 'scaned', message: '已扫码，请在手机微信上点击确认登录' }
  }
  return { ok: true, state: 'wait', message: '等待手机微信扫码…' }
}

// ───────────────────────── 入站消息翻译（纯翻译，不编内容） ─────────────────────────

function summarizeRefMsg(refMsg) {
  if (!refMsg || typeof refMsg !== 'object') return ''
  const title = String(refMsg.title || '').trim()
  const item = refMsg.message_item
  let body = ''
  if (item && typeof item === 'object') {
    if (Number(item.type) === ITEM_TYPE.TEXT) body = String(item.text_item?.text || '').trim()
    else if (Number(item.type) === ITEM_TYPE.IMAGE) body = '[图片]'
    else if (Number(item.type) === ITEM_TYPE.VOICE) body = String(item.voice_item?.text || '[语音]')
    else if (Number(item.type) === ITEM_TYPE.FILE) body = `[文件 ${item.file_item?.file_name || ''}]`.trim()
    else if (Number(item.type) === ITEM_TYPE.VIDEO) body = '[视频]'
  }
  const combined = [title, body].filter(Boolean).join(': ')
  return combined ? combined.slice(0, 120) : ''
}

function toTimestampMs(rawMsg) {
  const cand = Number(rawMsg?.create_time_ms ?? rawMsg?.create_time ?? rawMsg?.timestamp)
  if (!Number.isFinite(cand) || cand <= 0) return Date.now()
  return Math.trunc(cand < 1e12 ? cand * 1000 : cand)
}

function firstHeader(headers, name) {
  if (!headers) return ''
  if (typeof headers.get === 'function') return String(headers.get(name) || '')
  const target = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return String(v || '')
  }
  return ''
}

/**
 * 把单条 iLink WeixinMessage 翻译为内部事件（self-sent / ignored-group / inbound）。
 */
export function parseInboundMessage(rawMsg, { selfAccount = '', allowGroup = false, listenAllInGroup = false, registerMedia = () => '' } = {}) {
  if (!rawMsg || typeof rawMsg !== 'object') return null

  const messageId = rawMsg.message_id ?? rawMsg.msg_id ?? rawMsg.seq ?? rawMsg.client_id
  const stableId = messageId !== undefined && messageId !== null ? String(messageId).trim() : ''
  const fromUser = String(rawMsg.from_user_id || '').trim()
  const rawGroupId = String(rawMsg.group_id || rawMsg.chatroom_id || '').trim()
  const sessionId = String(rawMsg.session_id || '').trim()
  const isGroup = Boolean(rawGroupId || fromUser.endsWith('@chatroom') || sessionId.endsWith('@chatroom'))
  const groupId = rawGroupId || (fromUser.endsWith('@chatroom') ? fromUser : (sessionId.endsWith('@chatroom') ? sessionId : ''))
  // 群聊 sender 绝不回退成群 ID 或 @chatroom，缺失真实发言人时下面直接丢弃
  const rawSender = isGroup
    ? String(rawMsg.sender_user_id || rawMsg.actual_user_id || (fromUser && fromUser !== groupId && !fromUser.endsWith('@chatroom') ? fromUser : '')).trim()
    : fromUser
  const senderAccount = isGroup && (rawSender === groupId || rawSender.endsWith('@chatroom')) ? '' : rawSender
  const at = toTimestampMs(rawMsg)

  const msgType = Number(rawMsg.message_type)
  if (msgType === MESSAGE_TYPE.BOT || (selfAccount && senderAccount && senderAccount === selfAccount)) {
    return {
      kind: 'self-sent',
      messageId: stableId,
      at,
      chat: isGroup ? { kind: 'group', id: groupId || 'unknown' } : { kind: 'private', id: String(rawMsg.to_user_id || fromUser || 'unknown') },
    }
  }

  if (isGroup && !allowGroup) {
    return { kind: 'ignored-group', reason: 'group-disabled', messageId: stableId }
  }
  if (isGroup && !listenAllInGroup && rawMsg.mentioned_me !== true) {
    return { kind: 'ignored-group', reason: 'group-not-mentioned', messageId: stableId }
  }
  if (isGroup && !senderAccount) {
    return { kind: 'ignored-group', reason: 'missing-group-sender', messageId: stableId }
  }

  if (!stableId || (!fromUser && !groupId) || !senderAccount) return null

  const items = Array.isArray(rawMsg.item_list) ? rawMsg.item_list : []
  const parts = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const t = Number(item.type)
    if (t === ITEM_TYPE.TEXT) {
      const txt = String(item.text_item?.text ?? '')
      const refSummary = summarizeRefMsg(item.ref_msg)
      const fullText = refSummary ? (txt ? `[引用: ${refSummary}]\n${txt}` : `[引用: ${refSummary}]`) : txt
      if (fullText) parts.push({ type: 'text', text: fullText })
    } else if (t === ITEM_TYPE.IMAGE) {
      const img = item.image_item || {}
      const media = img.media || {}
      const eqp = String(media.encrypt_query_param || '').trim()
      const aesKey = String(media.aes_key || img.aeskey || '').trim()
      const size = Number(img.hd_size || img.mid_size || img.thumb_size || 0) || undefined
      if (eqp && aesKey) {
        const id = registerMedia({ encryptQueryParam: eqp, aesKey, mime: 'image/jpeg', size, raw: item })
        parts.push({ type: 'image', media: { id, mime: 'image/jpeg', ...(size ? { size } : {}) } })
      } else if (img.url || media.full_url) {
        parts.push({ type: 'image', media: { url: String(img.url || media.full_url), mime: 'image/jpeg', ...(size ? { size } : {}) } })
      } else {
        parts.push({ type: 'other', text: '[图片]', native: item })
      }
    } else if (t === ITEM_TYPE.VOICE) {
      const voice = item.voice_item || {}
      const transcript = typeof voice.text === 'string' ? voice.text.trim() : ''
      if (transcript) {
        parts.push({ type: 'text', text: transcript })
        continue
      }
      const media = voice.media || {}
      const eqp = String(media.encrypt_query_param || '').trim()
      const aesKey = String(media.aes_key || '').trim()
      const durationMs = Number(voice.playtime || 0) > 0 ? Math.trunc(Number(voice.playtime)) : undefined
      if (eqp && aesKey) {
        const id = registerMedia({ encryptQueryParam: eqp, aesKey, mime: 'audio/silk', raw: item })
        parts.push({ type: 'voice', media: { id, mime: 'audio/silk' }, ...(durationMs ? { durationMs } : {}) })
      } else {
        parts.push({ type: 'other', text: '[语音]', native: item })
      }
    } else if (t === ITEM_TYPE.FILE) {
      const f = item.file_item || {}
      const media = f.media || {}
      const eqp = String(media.encrypt_query_param || '').trim()
      const aesKey = String(media.aes_key || '').trim()
      const name = String(f.file_name || 'file').trim()
      const size = Number(f.len || 0) || undefined
      const md5 = f.md5 ? String(f.md5) : undefined
      if (eqp && aesKey) {
        const id = registerMedia({ encryptQueryParam: eqp, aesKey, mime: 'application/octet-stream', name, size, raw: item })
        parts.push({ type: 'file', media: { id, name, ...(size ? { size } : {}), ...(md5 ? { md5 } : {}) } })
      } else {
        parts.push({ type: 'other', text: `[文件 ${name}]`, native: item })
      }
    } else if (t === ITEM_TYPE.VIDEO) {
      const v = item.video_item || {}
      const media = v.media || {}
      const eqp = String(media.encrypt_query_param || '').trim()
      const aesKey = String(media.aes_key || '').trim()
      const size = Number(v.video_size || 0) || undefined
      if (eqp && aesKey) {
        const id = registerMedia({ encryptQueryParam: eqp, aesKey, mime: 'video/mp4', size, raw: item })
        parts.push({ type: 'video', media: { id, mime: 'video/mp4', ...(size ? { size } : {}) } })
      } else {
        parts.push({ type: 'other', text: '[视频]', native: item })
      }
    } else {
      parts.push({ type: 'other', text: `[微信消息类型 ${item.type ?? '未知'}]`, native: item })
    }
  }

  if (!parts.length) return null

  const chat = isGroup
    ? { kind: 'group', id: groupId, ...(rawMsg.group_name ? { title: String(rawMsg.group_name) } : {}) }
    : { kind: 'private', id: fromUser }

  return {
    kind: 'inbound',
    chatIdForContext: chat.id,
    contextToken: String(rawMsg.context_token || '').trim(),
    inbound: {
      chat,
      sender: {
        account: senderAccount,
        name: String(rawMsg.sender_name || rawMsg.from_user_name || rawMsg.nick_name || ''),
        role: isGroup ? 'member' : '',
      },
      messageId: stableId,
      at,
      mentionedMe: isGroup ? Boolean(rawMsg.mentioned_me) : false,
      parts,
      raw: rawMsg,
    },
  }
}

// ───────────────────────── 平台端主体 ─────────────────────────

/**
 * 建一个个人微信 ClawBot（原生 iLink）平台端。
 * @param {{ id?: string, name?: string, client?: ReturnType<typeof createIlinkHttpClient>, clock?: () => number, dataDir?: () => string, assertUrl?: Function, allowLocalPath?: boolean, allowedLocalDirs?: string[] | (() => string[]), startupWaitMs?: number }} [options]
 */
export function createWechatClawbotAdapter(options = {}) {
  const id = options.id || PLATFORM_ID
  const name = options.name || '个人微信（ClawBot）'
  let instance = id
  const clock = options.clock || (() => Date.now())
  const httpClient = options.client || createIlinkHttpClient()
  const checkPublicUrl = typeof options.assertUrl === 'function' ? options.assertUrl : assertPublicUrl
  const hasAllowedDirsOption = options.allowedLocalDirs != null
  // 安全默认值 fail-closed：未配置 allowedLocalDirs 时默认禁止本地路径，除非显式传 allowLocalPath: true
  const allowLocalPath = options.allowLocalPath === true || (options.allowLocalPath !== false && hasAllowedDirsOption)

  function resolveAllowedLocalDirs() {
    const raw = typeof options.allowedLocalDirs === 'function'
      ? options.allowedLocalDirs()
      : options.allowedLocalDirs
    if (!Array.isArray(raw)) return null
    return raw.map((d) => String(d || '').trim()).filter(Boolean).map((d) => resolve(d))
  }

  let ctx = null
  let running = false
  let connected = false
  let stopped = true
  let sessionExpired = false
  let failSend = null
  let pollGen = 0
  let pollAbort = null
  let backoffTimer = null
  let serverPollTimeoutMs = 0
  let startupSettle = null

  let syncBuf = ''
  const msgContextTokens = new Map() // messageId -> { token, chatId, at }
  const chatContextTokens = new Map() // chatId -> { token, at }
  const mediaCache = new Map() // id -> { encryptQueryParam, aesKey, mime, name, size, rawsize, filesize, outboundAesKeyBase64 }
  const typingTickets = new Map() // chatId -> { ticket, expiresAt }
  let capsState = { ...CAPS_WECHAT_CLAWBOT, features: { ...CAPS_WECHAT_CLAWBOT.features } }
  let capsOverride = null
  let self = { account: '', name: '个人微信（ClawBot）' }

  let rateLimiter = createProactiveRateLimiter({ minIntervalMs: 3000, windowMs: 3600_000, maxPerWindow: 20, clock })

  const cfgOf = () => ({ ...(adapter.__config || {}), ...(ctx?.config?.() || {}) })
  const baseUrlOf = () => normalizeBaseUrl(cfgOf().baseUrl, DEFAULT_BASE_URL)
  const cdnBaseUrlOf = () => normalizeBaseUrl(cfgOf().cdnBaseUrl, DEFAULT_CDN_BASE_URL)
  const botTokenOf = () => String(cfgOf().botToken || '').trim()
  const routeTagOf = () => String(cfgOf().routeTag || '').trim()
  const timeoutMsOf = () => Math.max(1000, Number(cfgOf().timeoutMs) || DEFAULT_TIMEOUT_MS)
  const maxFileBytesOf = () => {
    const raw = Number(cfgOf().maxFileBytes)
    if (Number.isFinite(raw) && raw > 0) return Math.min(DEFAULT_MAX_FILE_BYTES, raw)
    return DEFAULT_MAX_FILE_BYTES
  }
  // 实测 iLink 会接受机器人 voice_item（ret=0）但不投递，造成“文件和语音都没有”。
  // 因此默认按文件发；只有显式 voiceOutbound=true 才尝试语音气泡。
  const voiceOutboundOf = () => {
    const value = cfgOf().voiceOutbound
    return value === true || value === 'true'
  }

  function dataDirPath() {
    let dir = null
    try {
      if (typeof options.dataDir === 'function') dir = options.dataDir()
      else if (typeof ctx?.dataDir === 'function') dir = ctx.dataDir()
    } catch { dir = null }
    return typeof dir === 'string' && dir && isAbsolute(dir) ? dir : null
  }

  /**
   * 载入游标与 context_token。落盘文件带 botId：重新扫码换号后 botId 变化（或旧文件无 botId）时，
   * 旧游标 / 旧会话令牌一律丢弃，避免首轮游标错配或回复串到旧账号的会话。
   */
  function loadStateFiles(botAccount) {
    syncBuf = ''
    msgContextTokens.clear()
    chatContextTokens.clear()
    typingTickets.clear()
    const dir = dataDirPath()
    if (!dir) return
    try {
      const rawSync = JSON.parse(readFileSync(join(dir, 'sync-buf.json'), 'utf8'))
      if (rawSync?.botId === botAccount && typeof rawSync?.get_updates_buf === 'string') syncBuf = rawSync.get_updates_buf
    } catch {}
    try {
      const rawCtx = JSON.parse(readFileSync(join(dir, 'context-tokens.json'), 'utf8'))
      if (rawCtx?.botId !== botAccount) throw new Error('bot-changed')
      const now = clock()
      const ttl = Math.max(60_000, Number(cfgOf().contextTokenTtlMs) || DEFAULT_CONTEXT_TOKEN_TTL_MS)
      if (rawCtx?.chats && typeof rawCtx.chats === 'object') {
        for (const [k, v] of Object.entries(rawCtx.chats)) {
          if (v?.token && now - (Number(v.at) || 0) < ttl) {
            chatContextTokens.set(k, { token: String(v.token), at: Number(v.at) || now })
          }
        }
      }
      if (rawCtx?.msgs && typeof rawCtx.msgs === 'object') {
        for (const [k, v] of Object.entries(rawCtx.msgs)) {
          if (v?.token && now - (Number(v.at) || 0) < ttl) {
            msgContextTokens.set(k, { token: String(v.token), chatId: String(v.chatId || ''), at: Number(v.at) || now })
          }
        }
      }
    } catch {}
  }

  function saveJsonAtomic(fileName, data) {
    const dir = dataDirPath()
    if (!dir) return
    try {
      ensureDir(dir)
      const full = join(dir, fileName)
      const tmp = `${full}.tmp-${process.pid}`
      writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, full)
    } catch (error) {
      ctx?.log?.warn?.(`wechat-clawbot 持久化 ${fileName} 失败（不影响当前运行）：`, error?.message || error)
    }
  }

  function persistSyncBuf() {
    saveJsonAtomic('sync-buf.json', { botId: self.account, get_updates_buf: syncBuf, updatedAt: clock() })
  }

  function persistContextTokens() {
    saveJsonAtomic('context-tokens.json', {
      botId: self.account,
      chats: Object.fromEntries(chatContextTokens),
      msgs: Object.fromEntries(msgContextTokens),
    })
  }

  function registerMediaDescriptor(desc) {
    const idKey = `wxm-${randomUUID().slice(0, 12)}`
    if (mediaCache.size >= MAX_MEDIA_CACHE_ENTRIES) {
      mediaCache.delete(mediaCache.keys().next().value)
    }
    mediaCache.set(idKey, desc)
    return idKey
  }

  function storeContextToken(chatId, messageId, token) {
    if (!token) return
    const now = clock()
    if (chatId) {
      if (chatContextTokens.size >= MAX_CONTEXT_ENTRIES && !chatContextTokens.has(chatId)) {
        chatContextTokens.delete(chatContextTokens.keys().next().value)
      }
      chatContextTokens.set(chatId, { token, at: now })
    }
    if (messageId) {
      if (msgContextTokens.size >= MAX_CONTEXT_ENTRIES && !msgContextTokens.has(messageId)) {
        msgContextTokens.delete(msgContextTokens.keys().next().value)
      }
      msgContextTokens.set(messageId, { token, chatId: chatId || '', at: now })
    }
    persistContextTokens()
  }

  function resolveContextToken(chatId, inResponseTo) {
    const ttl = Math.max(60_000, Number(cfgOf().contextTokenTtlMs) || DEFAULT_CONTEXT_TOKEN_TTL_MS)
    const now = clock()
    if (inResponseTo) {
      const m = msgContextTokens.get(String(inResponseTo))
      if (m && now - m.at <= ttl) return m.token
      if (m) msgContextTokens.delete(String(inResponseTo))
    }
    if (chatId) {
      const c = chatContextTokens.get(String(chatId))
      if (c && now - c.at <= ttl) return c.token
      if (c) chatContextTokens.delete(String(chatId))
    }
    return ''
  }

  function handleIncomingRaw(rawMsg) {
    if (!running || stopped || !ctx) return false
    const cfg = cfgOf()
    const allowGroup = cfg.allowGroup === true || cfg.allowGroup === 'true'
    const listenAllInGroup = allowGroup && (cfg.listenAllInGroup === true || cfg.listenAllInGroup === 'true')
    const parsed = parseInboundMessage(rawMsg, {
      selfAccount: self.account,
      allowGroup,
      listenAllInGroup,
      registerMedia: registerMediaDescriptor,
    })
    if (!parsed) return false
    if (parsed.kind === 'self-sent') {
      ctx.emitEvent?.({
        type: 'self-sent',
        messageId: parsed.messageId || `wx-self-${clock()}`,
        at: parsed.at,
        chat: parsed.chat,
      })
      return true
    }
    if (parsed.kind === 'ignored-group') {
      return false
    }
    if (parsed.contextToken) {
      storeContextToken(parsed.chatIdForContext, parsed.inbound.messageId, parsed.contextToken)
    }
    ctx.emit(parsed.inbound)
    return true
  }

  async function postIlink(path, payload, { timeoutMs = timeoutMsOf(), signal } = {}) {
    const token = botTokenOf()
    if (!token) {
      throw createSendError('not-sent', 'no-credentials', instance, '缺少微信 ClawBot botToken，请在面板扫码登录')
    }
    return await httpClient.request({
      method: 'POST',
      url: `${baseUrlOf()}${path}`,
      headers: buildIlinkHeaders({ botToken: token, routeTag: routeTagOf(), includeAuth: true }),
      body: JSON.stringify(payload),
      timeoutMs,
      signal,
    })
  }

  function markSessionExpired(reason) {
    sessionExpired = true
    connected = false
    running = false
    pollGen++
    try { pollAbort?.abort() } catch {}
    if (backoffTimer) { clearTimeout(backoffTimer); backoffTimer = null }
    ctx?.state?.('disconnected', reason || '微信 ClawBot 会话已过期（-14），请在面板重新扫码登录')
  }

  async function pollLoop(myGen, onFirstRound) {
    let consecutiveFailures = 0
    let firstNotified = false
    const notifyFirst = (outcome) => {
      if (firstNotified) return
      firstNotified = true
      onFirstRound?.(outcome)
    }

    while (running && !stopped && myGen === pollGen) {
      const cfg = cfgOf()
      const pollTimeoutMs = Math.max(5000, Math.min(65_000, Number(cfg.pollTimeoutMs) || serverPollTimeoutMs || DEFAULT_POLL_TIMEOUT_MS))
      pollAbort = new AbortController()
      try {
        const r = await postIlink(
          PATH_GET_UPDATES,
          { get_updates_buf: syncBuf, base_info: { channel_version: CHANNEL_VERSION } },
          { timeoutMs: pollTimeoutMs + 5000, signal: pollAbort.signal },
        )
        if (!running || stopped || myGen !== pollGen) {
          notifyFirst({ status: 'stopped' })
          return
        }

        const json = r.json || {}
        const code = Number(json.errcode ?? json.ret ?? 0)
        if (code === SESSION_EXPIRED_ERRCODE) {
          const reason = '微信 ClawBot 会话已过期（-14），请在面板重新扫码登录'
          markSessionExpired(reason)
          notifyFirst({ status: 'expired', error: createSendError('not-sent', 'session-expired', instance, reason) })
          return
        }
        if (r.status === 401 || r.status === 403) {
          const reason = `微信 ClawBot 授权失效（HTTP ${r.status}），请在面板重新扫码登录`
          markSessionExpired(reason)
          notifyFirst({ status: 'expired', error: createSendError('not-sent', 'session-expired', instance, reason) })
          return
        }
        if (r.status < 200 || r.status >= 300 || code !== 0) {
          throw new Error(formatWechatErrorSummary('iLink 长轮询失败', code || r.status, json.errmsg || r.text, [botTokenOf()]))
        }

        if (Number(json.longpolling_timeout_ms) > 0) {
          serverPollTimeoutMs = Math.max(5000, Math.min(65_000, Number(json.longpolling_timeout_ms)))
        }
        consecutiveFailures = 0
        if (!connected) {
          connected = true
          ctx?.state?.('connected')
        }
        if (typeof json.get_updates_buf === 'string' && json.get_updates_buf !== syncBuf) {
          syncBuf = json.get_updates_buf
          persistSyncBuf()
        }
        for (const rawMsg of Array.isArray(json.msgs) ? json.msgs : []) {
          handleIncomingRaw(rawMsg)
        }
        notifyFirst({ status: 'connected' })
      } catch (error) {
        if (!running || stopped || myGen !== pollGen) {
          notifyFirst({ status: 'stopped' })
          return
        }
        if (error?.name === 'AbortError' && pollAbort?.signal?.aborted) {
          notifyFirst({ status: 'stopped' })
          return
        }
        if (error?.name === 'TimeoutError') {
          // 长轮询正常超时：不记错误、也不在未收到成功响应前伪造 connected，直接下一轮
          continue
        }
        consecutiveFailures++
        const errDetail = formatWechatErrorSummary(
          connected ? '微信连接波动，正在重连' : '微信 iLink 首轮连接失败，正在重试',
          '',
          error?.message || error,
          [botTokenOf()],
        )
        if (!connected && consecutiveFailures === 1) {
          ctx?.state?.('connecting', errDetail)
        } else if (consecutiveFailures >= 3 && connected) {
          connected = false
          ctx?.state?.('connecting', errDetail)
        }
        notifyFirst({ status: 'retry', detail: errDetail })
        const waitMs = Math.min(30_000, 2000 * Math.pow(2, Math.min(4, consecutiveFailures - 1)))
        await new Promise((resolve) => {
          backoffTimer = setTimeout(resolve, waitMs)
          backoffTimer.unref?.()
        })
        backoffTimer = null
      } finally {
        pollAbort = null
      }
    }
  }

  async function downloadGuardedMediaUrl(rawUrl, timeoutMs, maxBytes) {
    let current = String(rawUrl || '').trim()
    if (!current) {
      throw createSendError('not-sent', 'ssrf-blocked', instance, '媒体地址为空')
    }
    for (let hop = 0; hop <= 5; hop++) {
      try {
        await checkPublicUrl(current)
      } catch (error) {
        throw createSendError('not-sent', 'ssrf-blocked', instance, `媒体地址未通过安全校验：${error?.message || error}`)
      }
      let r
      try {
        r = await httpClient.request({ method: 'GET', url: current, timeoutMs, responseType: 'bytes', redirect: 'manual' })
      } catch (error) {
        throw createSendError('not-sent', 'media-download-failed', instance, `下载媒体失败：${error?.message || error}`)
      }
      if ([301, 302, 303, 307, 308].includes(r.status)) {
        const loc = firstHeader(r.headers, 'location')
        if (loc) {
          try {
            current = new URL(loc, current).href
          } catch {
            throw createSendError('not-sent', 'ssrf-blocked', instance, '媒体重定向地址无效')
          }
          continue
        }
      }
      if (r.status < 200 || r.status >= 300 || !r.bytes?.length) {
        throw createSendError('not-sent', 'media-download-failed', instance, `下载媒体失败（HTTP ${r.status || '?'}）`)
      }
      if (maxBytes > 0 && r.bytes.length > maxBytes) {
        throw createSendError('not-sent', 'too-large', instance, `媒体 ${r.bytes.length} 字节超过微信上限 ${maxBytes}`)
      }
      return r.bytes
    }
    throw createSendError('not-sent', 'too-many-redirects', instance, '媒体下载地址重定向次数超过上限（5 次）')
  }

  function readGuardedLocalPath(rawPath, maxBytes) {
    if (!allowLocalPath) {
      throw createSendError('not-sent', 'local-path-blocked', instance, '当前配置不允许平台端直接读取本机文件路径')
    }
    const p = String(rawPath || '').trim()
    if (!p || p.includes('\0') || !isAbsolute(p)) {
      throw createSendError('not-sent', 'local-path-blocked', instance, '仅允许绝对路径读取本地媒体')
    }
    let st
    try {
      st = statSync(p)
    } catch (error) {
      throw createSendError('not-sent', 'local-path-blocked', instance, `读取本地媒体失败：${error?.message || error}`)
    }
    if (!st.isFile()) {
      throw createSendError('not-sent', 'local-path-blocked', instance, '本地媒体路径必须是常规文件')
    }
    if (maxBytes > 0 && st.size > maxBytes) {
      throw createSendError('not-sent', 'too-large', instance, `本地文件 ${st.size} 字节超过微信上限 ${maxBytes}`)
    }
    if (hasAllowedDirsOption) {
      const dirs = resolveAllowedLocalDirs()
      if (!dirs || !dirs.length) {
        throw createSendError('not-sent', 'local-path-blocked', instance, '未配置允许读取的本地目录范围')
      }
      let realFile
      try { realFile = realpathSync(p) } catch { realFile = resolve(p) }
      const inside = dirs.some((d) => {
        let realDir
        try { realDir = realpathSync(d) } catch { realDir = resolve(d) }
        const rel = relative(realDir, realFile)
        return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
      })
      if (!inside) {
        throw createSendError('not-sent', 'local-path-blocked', instance, '本地文件路径不在允许目录范围内')
      }
    }
    return readFileSync(p)
  }

  async function resolvePlainBytes(media, timeoutMs, maxBytes = maxFileBytesOf()) {
    if (media?.bytes) {
      return Buffer.isBuffer(media.bytes) ? media.bytes : Buffer.from(media.bytes)
    }
    if (media?.path) {
      return readGuardedLocalPath(media.path, maxBytes)
    }
    if (media?.url) {
      return await downloadGuardedMediaUrl(media.url, timeoutMs, maxBytes)
    }
    return null
  }

  /**
   * 语音准备：
   * - 能拿到 SILK 就发原生语音条；
   * - 转码失败/缺少依赖时返回检测过 MIME 的文件媒体，按文件发。
   *
   * 微信协议要求 voice_item 固定 16k/16bit/SILK，playtime 为秒。
   */
  async function prepareVoiceItem(media, toUserId, timeoutMs, durationMs = 0) {
    const maxBytes = maxFileBytesOf()
    const bytes = await resolvePlainBytes(media, timeoutMs, maxBytes)
    if (!bytes?.length) {
      // 入站媒体缓存只有描述符、没有明文字节：让 prepareOutboundMedia 复用缓存直传，别把语音弄丢。
      if (media?.id && mediaCache.has(String(media.id))) {
        return { item: null, fallbackMedia: media, reason: 'cached-media' }
      }
      throw createSendError('not-sent', 'media-needs-upload', instance, '语音缺少可用内容（bytes/path/url）')
    }
    if (maxBytes > 0 && bytes.length > maxBytes) {
      throw createSendError('not-sent', 'too-large', instance, `语音 ${bytes.length} 字节超过微信上限 ${maxBytes}`)
    }

    const detected = inferMimeFromBytes(bytes)
    const fallbackMime = detected || media?.mime || 'audio/mpeg'
    // 语音文件名按真实魔数纠正：中枢历史上会把 record 段标成 audio/amr，不能因此一律 voice.amr。
    const fallbackName = `voice.${extForMime(fallbackMime, 'mp3')}`
    const fallbackMedia = { ...media, bytes, mime: fallbackMime, name: fallbackName }

    if (!voiceOutboundOf()) {
      return { item: null, fallbackMedia, reason: 'voiceOutbound=false' }
    }

    const silkResult = await transcodeAudioToSilk(bytes)
    if (!silkResult.ok) {
      ctx?.log?.debug?.(`微信语音转 SILK 失败，按文件发送：${silkResult.reason}`)
      return { item: null, fallbackMedia, reason: silkResult.reason }
    }

    const uploaded = await prepareOutboundMedia(
      { bytes: silkResult.bytes, mime: 'audio/silk', name: 'voice.silk', size: silkResult.bytes.length },
      UPLOAD_MEDIA_TYPE.VOICE,
      toUserId,
      timeoutMs,
      '语音',
    )
    const totalMs = Number(silkResult.durationMs) || Number(durationMs) || 0
    const playtime = Math.max(1, Math.round(totalMs / 1000) || 1)
    return {
      item: {
        type: ITEM_TYPE.VOICE,
        voice_item: {
          media: uploaded.media,
          encode_type: 0,
          bits_per_sample: 16,
          sample_rate: 16000,
          playtime,
        },
      },
      fallbackMedia,
      reason: '',
    }
  }

  function buildFileItem(uploaded, media) {
    return {
      type: ITEM_TYPE.FILE,
      file_item: {
        media: uploaded.media,
        file_name: String(media?.name || `file.${extForMime(media?.mime, 'bin')}`),
        len: String(uploaded.rawsize || 0),
        ...(uploaded.rawfilemd5 ? { md5: uploaded.rawfilemd5 } : {}),
      },
    }
  }

  async function prepareOutboundMedia(media, uploadMediaType, toUserId, timeoutMs, kindLabel) {
    const maxBytes = maxFileBytesOf()
    if (Number(media?.size) > 0 && Number(media.size) > maxBytes) {
      throw createSendError('not-sent', 'too-large', instance, `文件 ${media.size} 字节超过微信上限 ${maxBytes}`)
    }

    // 复用同一会话入站/已上传缓存的加密描述符，无需重复下载上传
    if (media?.id && mediaCache.has(String(media.id))) {
      const cached = mediaCache.get(String(media.id))
      if (cached?.encryptQueryParam && cached?.aesKey) {
        const keyBuf = parseAesKey(cached.aesKey)
        const rawsize = Number(cached.rawsize || cached.size || media.size || 0)
        const filesize = Number(cached.filesize || aesEcbPaddedSize(rawsize))
        return {
          media: {
            encrypt_query_param: cached.encryptQueryParam,
            aes_key: cached.outboundAesKeyBase64 || encodeOutboundAesKey(keyBuf),
            encrypt_type: 1,
          },
          rawsize,
          filesize,
          rawfilemd5: cached.rawfilemd5 || media.md5 || '',
        }
      }
    }

    const plain = await resolvePlainBytes(media, timeoutMs, maxBytes)
    if (!plain) {
      throw createSendError('not-sent', 'media-needs-upload', instance, `${kindLabel}缺少可用内容（bytes/path/url 或已缓存 media.id）`)
    }
    const checked = checkMediaConstraints({ bytes: plain, mime: media?.mime, name: media?.name }, { kind: kindLabel, maxBytes })
    if (!checked.ok) {
      throw createSendError('not-sent', 'too-large', instance, checked.reason)
    }

    const rawsize = plain.length
    const rawfilemd5 = createHash('md5').update(plain).digest('hex')
    const keyBuf = randomBytes(16)
    const aesKeyHex = keyBuf.toString('hex')
    const filekey = randomBytes(16).toString('hex')
    const cipherBuf = encryptAesEcb(plain, keyBuf)
    const filesize = cipherBuf.length

    let urlResp
    try {
      urlResp = await postIlink(PATH_GET_UPLOAD_URL, {
        filekey,
        media_type: uploadMediaType,
        to_user_id: String(toUserId || ''),
        rawsize,
        rawfilemd5,
        filesize,
        aeskey: aesKeyHex,
        no_need_thumb: true,
        base_info: { channel_version: CHANNEL_VERSION },
      }, { timeoutMs })
    } catch (error) {
      throw classifyTransportError(error, instance, '获取微信上传地址')
    }

    const uJson = urlResp.json || {}
    const uCode = Number(uJson.errcode ?? uJson.ret ?? 0)
    if (uCode === SESSION_EXPIRED_ERRCODE) {
      markSessionExpired('微信 ClawBot 会话已过期（-14），请在面板重新扫码登录')
      throw createSendError('not-sent', 'session-expired', instance, '微信 ClawBot 会话已过期（-14），请在面板重新扫码登录')
    }
    if (urlResp.status < 200 || urlResp.status >= 300 || uCode !== 0 || (!uJson.upload_param && !uJson.upload_full_url)) {
      throw createSendError('not-sent', `upload-url-${uCode || urlResp.status}`, instance,
        formatWechatErrorSummary('获取微信上传地址失败', uCode || urlResp.status, uJson.errmsg || urlResp.text, [botTokenOf()]))
    }

    const uploadUrl = buildCdnUploadUrl(cdnBaseUrlOf(), uJson.upload_param, filekey, uJson.upload_full_url)
    let cdnResp
    try {
      cdnResp = await httpClient.request({
        method: 'POST',
        url: uploadUrl,
        headers: { 'Content-Type': 'application/octet-stream' },
        body: cipherBuf,
        timeoutMs,
      })
    } catch (error) {
      throw classifyTransportError(error, instance, '上传加密媒体到微信 CDN')
    }
    if (cdnResp.status < 200 || cdnResp.status >= 300) {
      throw createSendError('not-sent', `cdn-upload-${cdnResp.status}`, instance, `微信 CDN 上传失败（HTTP ${cdnResp.status}）`)
    }
    const encryptedParam = firstHeader(cdnResp.headers, 'x-encrypted-param') || String(uJson.upload_param || '')
    if (!encryptedParam) {
      throw createSendError('not-sent', 'cdn-no-encrypted-param', instance, '微信 CDN 未返回 x-encrypted-param')
    }

    return {
      media: {
        encrypt_query_param: encryptedParam,
        aes_key: encodeOutboundAesKey(keyBuf),
        encrypt_type: 1,
      },
      rawsize,
      filesize,
      rawfilemd5,
    }
  }

  function classifySendResponse(r) {
    const json = r.json || {}
    const code = Number(json.errcode ?? json.ret ?? (r.status >= 400 ? r.status : 0))
    if (code === SESSION_EXPIRED_ERRCODE || r.status === 401) {
      markSessionExpired('微信 ClawBot 会话已过期（-14），请在面板重新扫码登录')
      return createSendError('not-sent', 'session-expired', instance, '微信 ClawBot 会话已过期（-14），请在面板重新扫码登录')
    }
    if (r.status >= 500 || (!r.json && r.status >= 200 && r.status < 300)) {
      return createSendError('unknown', `http-${r.status || 'bad-json'}`, instance, `iLink 返回异常（HTTP ${r.status || '?'}，按 unknown 处理）`)
    }
    if (r.status >= 400 || code !== 0) {
      return createSendError('not-sent', `ilink-${code || r.status}`, instance,
        formatWechatErrorSummary('微信发送消息被拒绝', code || r.status, json.errmsg || r.text, [botTokenOf()]))
    }
    return null
  }

  async function getTypingTicket(chatId) {
    const key = String(chatId || '').trim()
    if (!key) return ''
    const cached = typingTickets.get(key)
    const now = clock()
    if (cached && cached.expiresAt > now) return cached.ticket
    const contextToken = resolveContextToken(key)
    const r = await postIlink(PATH_GET_CONFIG, {
      ilink_user_id: key,
      ...(contextToken ? { context_token: contextToken } : {}),
      base_info: { channel_version: CHANNEL_VERSION },
    })
    const ticket = String(r.json?.typing_ticket || '').trim()
    if (ticket) {
      typingTickets.set(key, { ticket, expiresAt: now + DEFAULT_TYPING_TICKET_TTL_MS })
    }
    return ticket
  }

  async function sendTyping(chatId, { cancel = false } = {}) {
    if (!running || !connected || stopped) return false
    const key = String(chatId || '').trim()
    if (!key) return false
    const ticket = await getTypingTicket(key)
    if (!ticket) return false
    await postIlink(PATH_SEND_TYPING, {
      ilink_user_id: key,
      typing_ticket: ticket,
      status: cancel ? TYPING_STATUS.CANCEL : TYPING_STATUS.TYPING,
      base_info: { channel_version: CHANNEL_VERSION },
    })
    return true
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
      { key: 'botToken', label: 'Bot Token（扫码自动写入）', type: 'password', hint: '推荐点下方「微信扫码登录」自动获取；不改请留空' },
      { key: 'botId', label: '机器人 ID', type: 'text', placeholder: '扫码后自动填写，例如 bot@im.bot', hint: '扫码确认后由微信 iLink 自动填写；手动填写 Bot Token 时此项必填' },
      { key: 'baseUrl', label: 'iLink 接口地址', type: 'text', default: DEFAULT_BASE_URL, hint: '默认 https://ilinkai.weixin.qq.com；扫码若下发区域域名会自动更新' },
      { key: 'cdnBaseUrl', label: 'CDN 媒体域名', type: 'text', default: DEFAULT_CDN_BASE_URL, hint: '微信加密媒体上传/下载域名，通常保持默认' },
      { key: 'routeTag', label: '路由标签（可选）', type: 'text', placeholder: 'SKRouteTag（一般留空）', hint: '仅内网/灰度环境需要填写' },
      { key: 'allowGroup', label: '允许接收群聊消息（实验性）', type: 'boolean', default: false, hint: '个人微信 ClawBot 群聊依赖官方账号灰度权限，默认只开放 1:1 私聊' },
      { key: 'listenAllInGroup', label: '群内接收全部消息', type: 'boolean', default: false, hint: '仅在开启群聊后生效；关闭时仅处理 @ 机器人消息' },
      { key: 'voiceOutbound', label: '发送原生语音条（实验性，默认关）', type: 'boolean', default: false, hint: '实测 iLink 会接受机器人 voice_item 但不投递，开了可能让语音附件无声消失；默认按文件发送。只有想验证腾讯是否已放开时才打开' },
      { key: 'maxTextChars', label: '单条文本上限（字符）', type: 'number', default: DEFAULT_MAX_TEXT_CHARS, hint: '超出自动分段发送' },
      { key: 'timeoutMs', label: '请求超时（毫秒）', type: 'number', default: DEFAULT_TIMEOUT_MS },
    ],

    async start(gatewayCtx) {
      if (running) return
      ctx = gatewayCtx
      instance = String(ctx.instance || id)
      const cfg = cfgOf()
      const token = botTokenOf()
      if (!token) {
        running = false
        connected = false
        stopped = true
        ctx.state('unconfigured', '请先在面板「微信扫码登录」授权个人微信账号')
        throw new Error('wechat-clawbot 缺少 botToken，请先扫码登录')
      }

      const botAccount = String(cfg.botId || cfg.ilinkBotId || '').trim()
      if (!botAccount) {
        running = false
        connected = false
        stopped = true
        ctx.state('unconfigured', '缺少机器人 ID（botId / ilink_bot_id）：请使用「微信扫码登录」自动获取，或手动补填 botId')
        throw new Error('wechat-clawbot 缺少 botId（ilink_bot_id），请先扫码登录或填写 botId')
      }

      running = true
      stopped = false
      sessionExpired = false
      connected = false
      serverPollTimeoutMs = 0
      loadStateFiles(botAccount)

      const allowGroup = cfg.allowGroup === true || cfg.allowGroup === 'true'
      capsState = {
        ...CAPS_WECHAT_CLAWBOT,
        maxFileBytes: maxFileBytesOf(),
        features: { ...CAPS_WECHAT_CLAWBOT.features },
      }
      capsOverride = { ...(capsOverride || {}) }
      if (cfg.listenAllInGroup != null) {
        capsOverride.listenAllInGroup = allowGroup && (cfg.listenAllInGroup === true || cfg.listenAllInGroup === 'true')
      }
      if (cfg.proactive === 'none') {
        capsOverride.proactive = 'none'
      }

      self = {
        account: botAccount,
        name: String(cfg.botName || name),
      }
      rateLimiter = createProactiveRateLimiter({
        minIntervalMs: Math.max(0, Number(cfg.proactiveMinIntervalMs) || 3000),
        windowMs: Math.max(1000, Number(cfg.proactiveWindowMs) || 3600_000),
        maxPerWindow: Math.max(1, Number(cfg.proactiveMaxPerHour) || 20),
        clock,
      })

      ctx.state('connecting', '正在连接微信 iLink 长轮询…')

      let settleFirst = null
      const firstRoundDone = new Promise((resolve) => { settleFirst = resolve })
      startupSettle = settleFirst
      const myGen = ++pollGen
      void pollLoop(myGen, settleFirst)

      const startupWaitMs = Math.max(0, Math.min(10_000, Number(options.startupWaitMs ?? cfg.startupWaitMs ?? DEFAULT_STARTUP_WAIT_MS)))
      let waitTimer = null
      const waitPromise = new Promise((resolve) => {
        waitTimer = setTimeout(() => resolve({ status: 'pending' }), startupWaitMs)
        waitTimer.unref?.()
      })
      let outcome
      try {
        outcome = await Promise.race([firstRoundDone, waitPromise])
      } finally {
        if (waitTimer) clearTimeout(waitTimer)
        if (startupSettle === settleFirst) startupSettle = null
      }
      if (outcome?.status === 'expired') {
        throw outcome.error
      }
    },

    async stop() {
      stopped = true
      running = false
      connected = false
      pollGen++
      startupSettle?.({ status: 'stopped' })
      startupSettle = null
      if (backoffTimer) { clearTimeout(backoffTimer); backoffTimer = null }
      try { pollAbort?.abort() } catch {}
      pollAbort = null
      ctx?.state?.('stopped')
    },

    whoami: async () => ({ account: self.account, name: self.name }),

    async send(message) {
      if (!running || !connected || stopped || sessionExpired) {
        throw createSendError('not-sent', sessionExpired ? 'session-expired' : 'not-connected', instance,
          sessionExpired ? '微信 ClawBot 会话已过期（-14），请重新扫码登录' : 'wechat-clawbot 尚未连接')
      }
      if (failSend === 'refused') {
        failSend = null
        throw createSendError('not-sent', 'refused', instance, '模拟发送被拒绝（not-sent）')
      }
      if (failSend === 'timeout') {
        failSend = null
        throw createSendError('unknown', 'timeout', instance, '模拟发送超时（可能已发出，按 unknown 处理）')
      }

      const cfg = cfgOf()
      const current = adapter.caps()
      const chat = message?.chat || {}
      const toUserId = String(chat.id || '').trim()
      if (!toUserId) {
        throw createSendError('not-sent', 'missing-chat-id', instance, '缺少接收方账号')
      }

      const proactive = !message?.inResponseTo
      if (proactive && current.proactive === 'none') {
        throw createSendError('not-sent', 'proactive-not-allowed', instance, '当前配置不允许主动发送，只能被动回复')
      }
      if (proactive && current.proactive === 'limited') {
        const limitCheck = rateLimiter.check(toUserId)
        if (!limitCheck.ok) {
          throw createSendError('not-sent', 'proactive-limit', instance, limitCheck.reason)
        }
      }

      const contextToken = resolveContextToken(toUserId, message?.inResponseTo)
      if (!contextToken && current.proactive !== 'free') {
        throw createSendError('not-sent', 'no-context-token', instance, '还没有收到对方消息或会话 context_token 已过期，请等对方先发消息后再回复')
      }

      const timeoutMs = Math.max(1000, Number(message?.timeoutMs) || timeoutMsOf())
      const maxChars = Math.max(10, Number(cfg.maxTextChars) || DEFAULT_MAX_TEXT_CHARS)
      const maxBytes = maxFileBytesOf()

      // 先做文件体积硬拦截再分条构建
      for (const p of message?.parts || []) {
        const size = Number(p?.media?.size) || 0
        if (size > 0 && maxBytes > 0 && size > maxBytes) {
          throw createSendError('not-sent', 'too-large', instance, `文件 ${size} 字节超过微信上限 ${maxBytes}`)
        }
      }

      const itemsToSend = []
      const textBuf = []
      const flushText = () => {
        if (!textBuf.length) return
        const joined = textBuf.join('')
        textBuf.length = 0
        for (const chunk of splitWechatText(joined, { maxChars })) {
          itemsToSend.push({ kind: 'text', item: { type: ITEM_TYPE.TEXT, text_item: { text: chunk } } })
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
            itemsToSend.push({ kind: 'image', media: part.media || {} })
            break
          case 'video':
            flushText()
            itemsToSend.push({ kind: 'video', media: part.media || {} })
            break
          case 'voice': {
            flushText()
            itemsToSend.push({ kind: 'voice', media: part.media || {}, durationMs: Number(part.durationMs) || 0 })
            break
          }
          case 'file':
            flushText()
            itemsToSend.push({ kind: 'file', media: part.media || {} })
            break
          default:
            if (part.text) textBuf.push(String(part.text))
            break
        }
      }
      flushText()

      if (!itemsToSend.length) {
        throw createSendError('not-sent', 'nothing-to-send', instance, '没有可发送的内容')
      }

      let lastMessageId = ''
      for (const entry of itemsToSend) {
        let item = entry.item
        if (!item && entry.kind === 'image') {
          const uploaded = await prepareOutboundMedia(entry.media, UPLOAD_MEDIA_TYPE.IMAGE, toUserId, timeoutMs, '图片')
          item = { type: ITEM_TYPE.IMAGE, image_item: { media: uploaded.media, mid_size: uploaded.filesize } }
        } else if (!item && entry.kind === 'video') {
          const uploaded = await prepareOutboundMedia(entry.media, UPLOAD_MEDIA_TYPE.VIDEO, toUserId, timeoutMs, '视频')
          item = { type: ITEM_TYPE.VIDEO, video_item: { media: uploaded.media, video_size: uploaded.filesize } }
        } else if (!item && entry.kind === 'voice') {
          const prepared = await prepareVoiceItem(entry.media, toUserId, timeoutMs, entry.durationMs)
          if (prepared.item) {
            item = prepared.item
          } else {
            const uploaded = await prepareOutboundMedia(prepared.fallbackMedia, UPLOAD_MEDIA_TYPE.FILE, toUserId, timeoutMs, '语音文件')
            item = buildFileItem(uploaded, prepared.fallbackMedia)
          }
        } else if (!item && entry.kind === 'file') {
          const uploaded = await prepareOutboundMedia(entry.media, UPLOAD_MEDIA_TYPE.FILE, toUserId, timeoutMs, '文件')
          item = buildFileItem(uploaded, entry.media)
        }

        const clientId = `wx-${randomUUID().replace(/-/g, '').slice(0, 16)}`
        let r
        try {
          r = await postIlink(PATH_SEND_MESSAGE, {
            msg: {
              from_user_id: '',
              to_user_id: toUserId,
              client_id: clientId,
              message_type: MESSAGE_TYPE.BOT,
              message_state: MESSAGE_STATE.FINISH,
              ...(contextToken ? { context_token: contextToken } : {}),
              item_list: [item],
            },
            base_info: { channel_version: CHANNEL_VERSION },
          }, { timeoutMs })
        } catch (error) {
          throw classifyTransportError(error, instance, '微信发送消息')
        }
        const err = classifySendResponse(r)
        if (err) throw err
        lastMessageId = String(r.json?.message_id || clientId)
      }

      if (proactive) rateLimiter.record(toUserId)
      return { messageId: lastMessageId }
    },

    async fetch(request) {
      if (request?.kind === 'media') {
        const media = request.media || {}
        const desc = media.id ? mediaCache.get(String(media.id)) : null
        if (desc?.encryptQueryParam && desc?.aesKey) {
          const url = buildCdnDownloadUrl(cdnBaseUrlOf(), desc.encryptQueryParam)
          let r
          try {
            r = await httpClient.request({ method: 'GET', url, timeoutMs: timeoutMsOf(), responseType: 'bytes' })
          } catch (error) {
            throw classifyTransportError(error, instance, '下载微信 CDN 媒体')
          }
          if (r.status < 200 || r.status >= 300 || !r.bytes?.length) {
            throw createSendError('not-sent', `cdn-download-${r.status || 'empty'}`, instance, `下载微信 CDN 媒体失败（HTTP ${r.status || '?'}）`)
          }
          const plain = decryptAesEcb(r.bytes, parseAesKey(desc.aesKey))
          const detected = inferMimeFromBytes(plain)
          return {
            bytes: plain,
            mime: detected || desc.mime || 'application/octet-stream',
            ...(desc.name ? { name: desc.name } : {}),
          }
        }
        if (media.url) {
          const bytes = await downloadGuardedMediaUrl(media.url, timeoutMsOf(), maxFileBytesOf())
          return {
            bytes,
            mime: inferMimeFromBytes(bytes) || media.mime || 'application/octet-stream',
            ...(media.name ? { name: media.name } : {}),
          }
        }
        if (media.path) {
          throw createSendError('not-sent', 'local-path-blocked', instance, 'fetch(media) 不直接读取本地路径')
        }
        throw createSendError('not-sent', 'media-not-found', instance, '未找到可拉取的微信媒体缓存或地址')
      }
      throw createSendError('not-sent', 'unsupported-fetch', instance, `微信 ClawBot 不支持 fetch('${String(request?.kind || '')}')`)
    },

    async native(action, params = {}) {
      if (action === 'send_typing') {
        return await sendTyping(params?.chatId || params?.toUserId, { cancel: Boolean(params?.cancel) })
      }
      throw new Error(`wechat-clawbot 不支持的原生动作：${String(action)}`)
    },
  }

  // 测试/契约注入点（与 _template / qqbot / feishu 对齐）
  adapter.platform = {
    deliver(rawMsg) {
      return handleIncomingRaw(rawMsg)
    },
    setConfig(partial) {
      adapter.__config = { ...(adapter.__config || {}), ...(partial || {}) }
    },
    setCaps(partial) {
      const mergedFeatures = partial?.features && typeof partial.features === 'object'
        ? sanitizeFeaturesInput({ ...(capsState.features || {}), ...partial.features }, { instance, source: 'test.setCaps' })
        : capsState.features
      capsState = {
        ...capsState,
        ...(partial || {}),
        features: mergedFeatures || capsState.features,
      }
      ctx?.capsChanged?.()
    },
    setProactive(value) {
      if (value === 'free' || value === 'limited' || value === 'none') {
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
      sessionExpired = false
      ctx?.state?.('connected')
    },
  }

  adapter.__clawbot = {
    getSyncCursor: () => syncBuf,
    getContextToken: (chatId, msgId) => resolveContextToken(chatId, msgId),
    registerMedia: registerMediaDescriptor,
    getMediaCount: () => mediaCache.size,
    isSessionExpired: () => sessionExpired,
  }

  return adapter
}

export default createWechatClawbotAdapter()
