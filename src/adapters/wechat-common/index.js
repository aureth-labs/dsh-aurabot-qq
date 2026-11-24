// W1 公共微信工具层（无平台语义：不含 adapter 身份、caps、chatId 命名空间、权限或平台专属客户端）。
// 供 wechat-clawbot 与后续企业微信 wecom 共用，严格遵守方案 §4.3 / §4.4 共享边界。

import { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export { MAX_QR_UTF8_BYTES, encodeQrMatrix, encodeQrSvg, encodeQrSvgDataUri, isSafeQrImageDataUri, renderQrDataUri } from './qr-svg.js'

const CONNECT_REFUSED_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ERR_INVALID_URL',
])

const EXT_TO_MIME = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  amr: 'audio/amr',
  silk: 'audio/silk',
  slk: 'audio/silk',
  pdf: 'application/pdf',
  txt: 'text/plain',
  json: 'application/json',
  zip: 'application/zip',
})

const MIME_TO_EXT = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/amr': 'amr',
  'audio/silk': 'silk',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'application/json': 'json',
  'application/zip': 'zip',
})

const SAFE_FFMPEG_TARGETS = Object.freeze({
  amr: { ext: 'amr', args: ['-f', 'amr', '-acodec', 'libopencore_amrnb', '-ar', '8000', '-ac', '1'], mime: 'audio/amr' },
  wav: { ext: 'wav', args: ['-f', 'wav', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1'], mime: 'audio/wav' },
  mp3: { ext: 'mp3', args: ['-f', 'mp3', '-acodec', 'libmp3lame', '-ar', '24000', '-ac', '1'], mime: 'audio/mpeg' },
})

/**
 * 按段落 → 换行 → 空格/标点 → UTF-16 码点边界安全切分长文本，不切断代理对、不超出字符/字节上限。
 * @param {string} text
 * @param {{ maxChars?: number, maxBytes?: number }} [opts]
 * @returns {string[]}
 */
export function splitWechatText(text, { maxChars = 2000, maxBytes = 6000 } = {}) {
  const s = String(text ?? '')
  if (!s) return []
  const charCap = Math.max(1, Number(maxChars) || 2000)
  const byteCap = Math.max(4, Number(maxBytes) || 6000)
  if (s.length <= charCap && Buffer.byteLength(s, 'utf8') <= byteCap) return [s]

  const chars = Array.from(s)
  const chunks = []
  let start = 0
  while (start < chars.length) {
    let end = start
    let utf16Count = 0
    let byteCount = 0
    let lastPara = -1
    let lastNewline = -1
    let lastBreak = -1

    while (end < chars.length) {
      const ch = chars[end]
      const c16 = ch.length
      const cb = Buffer.byteLength(ch, 'utf8')
      if (end > start && (utf16Count + c16 > charCap || byteCount + cb > byteCap)) break
      utf16Count += c16
      byteCount += cb
      end++
      if (ch === '\n') {
        lastNewline = end
        if (end >= start + 2 && chars[end - 2] === '\n') lastPara = end
      } else if (ch === ' ' || ch === '\t' || ch === '。' || ch === '，' || ch === '；' || ch === '！' || ch === '？' || ch === ',' || ch === '.') {
        lastBreak = end
      }
      if (utf16Count >= charCap || byteCount >= byteCap) break
    }

    let cut = end
    if (cut < chars.length) {
      const minSoft = start + Math.floor((cut - start) / 2)
      if (lastPara > minSoft) cut = lastPara
      else if (lastNewline > minSoft) cut = lastNewline
      else if (lastBreak > minSoft) cut = lastBreak
    }
    if (cut <= start) cut = start + 1
    chunks.push(chars.slice(start, cut).join(''))
    start = cut
  }
  return chunks
}

/** 根据文件名后缀猜 MIME 类型（无平台语义）。 */
export function inferMimeFromName(name) {
  const clean = String(name || '').trim().toLowerCase()
  const dot = clean.lastIndexOf('.')
  if (dot < 0 || dot === clean.length - 1) return ''
  return EXT_TO_MIME[clean.slice(dot + 1)] || ''
}

/** 根据文件魔数猜 MIME 类型；认不出返回空串。 */
export function inferMimeFromBytes(buf) {
  if (!buf || (typeof buf.length !== 'number' && typeof buf.byteLength !== 'number')) return ''
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  if (b.length < 4) return ''
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.subarray(0, 6).toString('ascii') === 'GIF87a' || b.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif'
  if (b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WAVE') return 'audio/wav'
  if (b.subarray(0, 5).toString('ascii') === '#!AMR') return 'audio/amr'
  if (b.subarray(0, 9).toString('ascii') === '#!SILK_V3' || b.subarray(0, 10).toString('ascii') === '\x02#!SILK_V3') return 'audio/silk'
  if (b.subarray(0, 4).toString('ascii') === 'OggS') return 'audio/ogg'
  if (b.subarray(0, 3).toString('ascii') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'audio/mpeg'
  if (b.subarray(0, 4).toString('ascii') === '%PDF') return 'application/pdf'
  if (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05)) return 'application/zip'
  if (b.length >= 8 && b.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4'
  return ''
}

/** 按 MIME 返回推荐扩展名（含不含点号都行）。 */
export function extForMime(mime, fallback = 'bin') {
  const clean = String(mime || '').split(';')[0].trim().toLowerCase()
  return MIME_TO_EXT[clean] || fallback
}

/**
 * 校验媒体大小与 MIME/类型约束，不造假字段。
 * @param {{ bytes?: Buffer|Uint8Array, size?: number, mime?: string, name?: string }} media
 * @param {{ kind?: string, maxBytes?: number, allowedMimes?: string[]|Set<string>|null }} [opts]
 */
export function checkMediaConstraints(media, { kind = 'file', maxBytes = 20 * 1024 * 1024, allowedMimes = null } = {}) {
  const rawBytes = media?.bytes
  const size = rawBytes ? (rawBytes.byteLength ?? rawBytes.length ?? 0) : (Number(media?.size) || 0)
  if (maxBytes > 0 && size > maxBytes) {
    return { ok: false, size, mime: '', ext: '', reason: `${kind} 大小 ${size} 字节超过上限 ${maxBytes}` }
  }
  const byBytes = rawBytes ? inferMimeFromBytes(rawBytes) : ''
  const declared = String(media?.mime || '').split(';')[0].trim().toLowerCase()
  const byName = inferMimeFromName(media?.name)
  const mime = byBytes || declared || byName
  const ext = extForMime(mime, kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : kind === 'voice' ? 'bin' : 'bin')
  if (allowedMimes) {
    const set = allowedMimes instanceof Set ? allowedMimes : new Set(allowedMimes)
    if (mime && !set.has(mime)) {
      return { ok: false, size, mime, ext, reason: `${kind} 格式 ${mime} 不在允许列表内` }
    }
  }
  return { ok: true, size, mime, ext, reason: '' }
}

/**
 * 用本机 ffmpeg 把音频字节转成目标格式；缺少 ffmpeg 或转换失败时明确返回 fallbackToFile:true，绝不谎报成功。
 * @param {Buffer|Uint8Array} inputBytes
 * @param {{ targetFormat?: 'amr'|'wav'|'mp3', ffmpegPath?: string, timeoutMs?: number, spawnImpl?: Function }} [opts]
 */
export async function transcodeAudioForWechat(inputBytes, { targetFormat = 'amr', ffmpegPath = '', timeoutMs = 15_000, spawnImpl = nodeSpawn } = {}) {
  const target = SAFE_FFMPEG_TARGETS[targetFormat]
  if (!target) {
    return { ok: false, fallbackToFile: true, reason: `不支持的目标音频格式：${targetFormat}` }
  }
  const exe = String(ffmpegPath || '').trim()
  if (!exe) {
    return { ok: false, fallbackToFile: true, reason: '未配置或未找到 ffmpeg，无法转码音频' }
  }
  const buf = Buffer.isBuffer(inputBytes) ? inputBytes : Buffer.from(inputBytes || [])
  if (!buf.length) {
    return { ok: false, fallbackToFile: true, reason: '音频内容为空，无法转码' }
  }

  const workDir = mkdtempSync(join(tmpdir(), 'aurabot-wx-audio-'))
  const srcPath = join(workDir, `in-${randomUUID().slice(0, 8)}.bin`)
  const dstPath = join(workDir, `out.${target.ext}`)
  try {
    writeFileSync(srcPath, buf)
    await new Promise((resolve, reject) => {
      let settled = false
      const done = (fn, val) => { if (!settled) { settled = true; clearTimeout(timer); fn(val) } }
      const child = spawnImpl(exe, ['-y', '-hide_banner', '-loglevel', 'error', '-i', srcPath, '-vn', ...target.args, dstPath], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
      const timer = setTimeout(() => {
        try { child.kill?.() } catch {}
        done(reject, new Error(`ffmpeg 转码超时（>${timeoutMs}ms）`))
      }, Math.max(100, Number(timeoutMs) || 15_000))
      child.on('error', (err) => done(reject, err))
      child.on('exit', (code) => {
        if (code === 0) done(resolve)
        else done(reject, new Error(stderr.trim().slice(-240) || `ffmpeg 退出码 ${code}`))
      })
    })
    const out = readFileSync(dstPath)
    if (!out.length) {
      return { ok: false, fallbackToFile: true, reason: 'ffmpeg 输出为空，无法按语音发送' }
    }
    return { ok: true, fallbackToFile: false, bytes: out, mime: target.mime, ext: target.ext, reason: '' }
  } catch (error) {
    return { ok: false, fallbackToFile: true, reason: error?.message || '音频转码失败' }
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }) } catch {}
  }
}

/**
 * 把音频转成微信 iLink 原生语音条需要的 SILK。
 *
 * - WAV（PCM16）直接解码；
 * - MP3 用 mpg123-decoder 解码；
 * - 其他格式不硬转，返回 fallbackToFile。
 *
 * 输出固定 16kHz 单声道 PCM16，再交给 silk-wasm 编码；缺少依赖或编码失败
 * 时由调用方降级成文件，绝不谎报语音条。
 */
export async function transcodeAudioToSilk(inputBytes, { targetSampleRate = 16000 } = {}) {
  const buf = Buffer.isBuffer(inputBytes) ? inputBytes : Buffer.from(inputBytes || [])
  if (!buf.length) {
    return { ok: false, fallbackToFile: true, reason: '音频内容为空，无法转 SILK' }
  }

  const rate = [8000, 12000, 16000, 24000, 32000, 44100, 48000].includes(Number(targetSampleRate))
    ? Number(targetSampleRate)
    : 16000

  let silk
  try {
    silk = await import('silk-wasm')
  } catch (error) {
    return { ok: false, fallbackToFile: true, reason: `缺少 silk-wasm，无法生成微信语音条：${error?.message || error}` }
  }

  // 已经是 SILK：不重复编码。
  if (inferMimeFromBytes(buf) === 'audio/silk') {
    let durationMs = 0
    try {
      durationMs = Number(silk.getDuration(buf)) || 0
    } catch {}
    return {
      ok: true,
      fallbackToFile: false,
      bytes: buf,
      mime: 'audio/silk',
      ext: 'silk',
      durationMs,
      alreadySilk: true,
      reason: '',
    }
  }

  let decoded
  const mime = inferMimeFromBytes(buf)
  try {
    if (mime === 'audio/wav') {
      decoded = decodeWavPcm16(buf)
      if (!decoded) {
        return { ok: false, fallbackToFile: true, reason: 'WAV 不是 16-bit PCM，无法转 SILK' }
      }
    } else if (mime === 'audio/mpeg') {
      decoded = await decodeMp3Pcm16(buf)
      if (!decoded) {
        return { ok: false, fallbackToFile: true, reason: 'MP3 解码为空，无法转 SILK' }
      }
    } else {
      return {
        ok: false,
        fallbackToFile: true,
        reason: `暂不支持把 ${mime || '未知音频格式'} 转成微信 SILK`,
      }
    }
  } catch (error) {
    return { ok: false, fallbackToFile: true, reason: `音频解码失败：${error?.message || error}` }
  }

  const mono = resampleMono(decoded.samples, decoded.sampleRate, rate)
  if (!mono?.length) {
    return { ok: false, fallbackToFile: true, reason: '音频重采样为空，无法转 SILK' }
  }
  const pcm = pcm16Buffer(mono)
  try {
    const encoded = await silk.encode(pcm, rate)
    const out = Buffer.from(encoded?.data || [])
    if (!out.length) {
      return { ok: false, fallbackToFile: true, reason: 'SILK 编码结果为空' }
    }
    const durationMs = Number(encoded?.duration) || Math.round((mono.length / rate) * 1000)
    return {
      ok: true,
      fallbackToFile: false,
      bytes: out,
      mime: 'audio/silk',
      ext: 'silk',
      durationMs,
      alreadySilk: false,
      reason: '',
    }
  } catch (error) {
    return { ok: false, fallbackToFile: true, reason: `SILK 编码失败：${error?.message || error}` }
  }
}

function decodeWavPcm16(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return null
  }
  let fmt = null
  let data = null
  let off = 12
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    const body = off + 8
    if (body + size > buf.length) break
    if (id === 'fmt ') {
      if (size < 16) return null
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      data = buf.subarray(body, body + size)
    }
    off = body + size + (size % 2)
  }
  if (!fmt || !data || fmt.format !== 1 || fmt.bits !== 16 || !fmt.channels || !fmt.sampleRate) return null
  const frames = Math.floor(data.length / (fmt.channels * 2))
  if (!frames) return null
  const samples = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (let c = 0; c < fmt.channels; c++) {
      sum += data.readInt16LE((i * fmt.channels + c) * 2) / 32768
    }
    samples[i] = sum / fmt.channels
  }
  return { samples, sampleRate: fmt.sampleRate }
}

async function decodeMp3Pcm16(buf) {
  let mod
  try {
    mod = await import('mpg123-decoder')
  } catch (error) {
    throw new Error(`缺少 mpg123-decoder，无法解码 MP3：${error?.message || error}`)
  }
  const Decoder = mod.MPEGDecoder || mod.default?.MPEGDecoder
  if (!Decoder) throw new Error('mpg123-decoder 没有导出 MPEGDecoder')
  const decoder = new Decoder()
  try {
    await decoder.ready
    const decoded = decoder.decode(new Uint8Array(buf))
    const channels = Array.isArray(decoded?.channelData) ? decoded.channelData : []
    const frames = Math.min(...channels.map((c) => c?.length || 0))
    if (!frames || !channels.length || !decoded?.sampleRate) return null
    const samples = new Float32Array(frames)
    for (let i = 0; i < frames; i++) {
      let sum = 0
      for (const channel of channels) sum += Number(channel[i]) || 0
      samples[i] = sum / channels.length
    }
    return { samples, sampleRate: Number(decoded.sampleRate) }
  } finally {
    try { decoder.free?.() } catch {}
  }
}

function resampleMono(samples, fromRate, toRate) {
  if (!samples?.length || !fromRate || !toRate) return null
  if (fromRate === toRate) return samples
  const ratio = fromRate / toRate
  const out = new Float32Array(Math.max(1, Math.round(samples.length / ratio)))
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio
    const idx = Math.floor(pos)
    const frac = pos - idx
    const a = samples[idx] || 0
    const b = samples[idx + 1] ?? a
    out[i] = a + (b - a) * frac
  }
  return out
}

function pcm16Buffer(samples) {
  const out = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, Number(samples[i]) || 0))
    out.writeInt16LE(Math.round(v * 32767), i * 2)
  }
  return out
}

/**
 * 主动消息按目标限流器（支持最小间隔 + 滑动时间窗计数），避免个人微信/企业微信触发风控。
 */
export function createProactiveRateLimiter({
  minIntervalMs = 3000,
  windowMs = 3600_000,
  maxPerWindow = 20,
  clock = () => Date.now(),
} = {}) {
  const history = new Map() // key → number[] (timestamps ms)
  const prune = (key, now) => {
    const arr = history.get(key)
    if (!arr) return []
    const cutoff = now - Math.max(1000, windowMs)
    const kept = arr.filter((t) => t > cutoff)
    if (kept.length) history.set(key, kept)
    else history.delete(key)
    return kept
  }
  return {
    check(key) {
      const k = String(key || '').trim() || '*'
      const now = clock()
      const list = prune(k, now)
      if (minIntervalMs > 0 && list.length > 0) {
        const elapsed = now - list[list.length - 1]
        if (elapsed < minIntervalMs) {
          const retryAfterMs = minIntervalMs - elapsed
          return { ok: false, retryAfterMs, reason: `主动发送太频密，需等待 ${Math.ceil(retryAfterMs / 1000)} 秒后再试` }
        }
      }
      if (maxPerWindow > 0 && list.length >= maxPerWindow) {
        const retryAfterMs = Math.max(1, (list[0] + windowMs) - now)
        return { ok: false, retryAfterMs, reason: `主动发送已达窗口上限（${maxPerWindow} 次）` }
      }
      return { ok: true, retryAfterMs: 0, reason: '' }
    },
    record(key) {
      const k = String(key || '').trim() || '*'
      const now = clock()
      const list = prune(k, now)
      list.push(now)
      history.set(k, list)
    },
    reset(key) {
      if (key === undefined) history.clear()
      else history.delete(String(key || '').trim() || '*')
    },
  }
}

/** 构造契约形状的 SendError。 */
export function createSendError(certainty, code, instance, message) {
  const error = new Error(message || `发送失败（${certainty}${code ? ' / ' + code : ''}）`)
  error.name = 'SendError'
  error.certainty = certainty
  if (code) error.code = code
  if (instance !== undefined) error.instance = instance
  return error
}

/** 传输层异常归类：超时/中断连接一律按 unknown（防重发），明确未建连才按 not-sent。 */
export function classifyTransportError(error, instance, label = '微信请求') {
  if (error?.certainty === 'not-sent' || error?.certainty === 'unknown') return error
  const msg = String(error?.message || error || '')
  const code = String(error?.code || error?.cause?.code || '')
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || /timeout|aborted/i.test(msg)) {
    return createSendError('unknown', 'timeout', instance, `${label}超时（拿不准是否已发出，按 unknown 处理）：${msg}`)
  }
  if (CONNECT_REFUSED_CODES.has(code)) {
    return createSendError('not-sent', code.toLowerCase(), instance, `${label}未连上平台（${code}）：${msg}`)
  }
  return createSendError('unknown', code || 'network-error', instance, `${label}网络异常（拿不准是否已发出）：${msg}`)
}

/** 格式化简洁人类报错并剥离敏感凭据。 */
export function formatWechatErrorSummary(prefix, code, msg, secrets = []) {
  const codeText = code !== undefined && code !== null && code !== '' ? `（${code}）` : ''
  const detailText = msg ? `：${String(msg)}` : ''
  let out = `${String(prefix || '微信接口失败')}${codeText}${detailText}`
  for (const s of Array.isArray(secrets) ? secrets : []) {
    const val = String(s || '')
    if (val.length >= 4 && out.includes(val)) out = out.split(val).join('***')
  }
  return out
}
