// video-understand 核心引擎：输入归一 → 路由（字幕 → ASR → 抽帧+VLM → 原生API）→ 缓存。
// 复用 src/bili/{api,vision}.js、src/core/{llm,img,net}.js 与 channels.js 的双通道实现。
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { createBiliApi, findVideoId, UA } from '../../bili/api.js'
import { frameTimes, pickVideoStream, grabFrame } from '../../bili/vision.js'
import { assertPublicUrl } from '../../core/net.js'
import { findFfmpeg } from '../../core/img.js'
import { canUnderstandImages } from '../../core/llm.js'
import { cacheKey } from './cache.js'
import {
  classifyError, describeVisualDsh, describeVisualThird,
  transcribeDsh, transcribeThird, nativeUnderstand,
} from './channels.js'

/* ---------------- 输入归一 ---------------- */

const URL_TRACKING_PARAMS = new Set([
  'spm_id_from', 'vd_source', 'share_source', 'share_medium', 'share_plat',
  'share_tag', 'unique_k', 'share_session_id', 'from_source', 'utm_source', 'utm_medium',
])

function normalizeUrlInput(s) {
  const u = new URL(s)
  if (!/^https?:$/.test(u.protocol)) throw new Error(`不支持的 URL 协议: ${u.protocol}`)
  return { kind: 'url', url: s, raw: s }
}

function normalizePathInput(p) {
  const abs = isAbsolute(p) ? p : join(process.cwd(), p)
  return { kind: 'local', path: abs, raw: p }
}

/** 把 string / {path}|{url}|{messageId} 归一为 {kind, ...}。不 throw 识别不了的路径存在性问题，留给 understand 判断。 */
export function normalizeInput(raw) {
  if (raw && typeof raw === 'object') {
    if (raw.messageId) return { kind: 'qq-voice', messageId: raw.messageId, raw }
    const p = raw.path || raw.file || raw.localPath
    if (p) return normalizePathInput(String(p))
    const u = raw.url || raw.src
    if (u) return normalizeUrlInput(String(u))
    throw new Error('input 对象需要 path / url / messageId 之一')
  }
  const s = String(raw || '').trim()
  if (!s) throw new Error('input 不能为空')
  const vid = findVideoId(s)
  if (vid?.bvid) return { kind: 'bilibili', bvid: vid.bvid, p: urlPartP(s), raw: s }
  if (vid?.aid) return { kind: 'bilibili', aid: vid.aid, p: urlPartP(s), raw: s }
  if (vid?.short || /b23\.tv/i.test(s)) return { kind: 'bilibili-short', url: vid?.short || s, raw: s }
  if (/bilibili\.com/i.test(s)) {
    const bvid = s.match(/\b(BV[0-9A-Za-z]{10})\b/)?.[1]
    const aid = s.match(/\bav(\d+)\b/i)?.[1]
    if (bvid || aid) return { kind: 'bilibili', bvid, aid: aid ? Number(aid) : undefined, p: urlPartP(s), raw: s }
    return { kind: 'bilibili-short', url: s, raw: s }
  }
  if (/^https?:\/\//i.test(s)) return normalizeUrlInput(s)
  if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\') || isAbsolute(s) || existsSync(s)) {
    return normalizePathInput(s)
  }
  throw new Error(`无法识别的输入（支持 本地路径 / http(s) URL / BV号 / B站链接 / QQ语音条 messageId）: ${s.slice(0, 80)}`)
}

// 分P 参数（?p=N），缓存 key 需要区分
function urlPartP(s) {
  try { return Number(new URL(s).searchParams.get('p')) || 1 } catch { return 1 }
}

/** 短 hash：长/半敏感配置进缓存 key 前先摘要素（baseUrl、提示词不以明文进 key 输入之外的地方）。 */
function shortHash(s) {
  return createHash('sha256').update(String(s || '')).digest('hex').slice(0, 16)
}

/** 结果缓存 key：输入身份 + 影响结果的配置子集 + options。
 *  双通道换通道/换端点/换模型/换提示词必须命中不同 key，否则会返回旧配置的旧结果；
 *  apiKey 不进 key（baseUrl 已可区分端点）；baseUrl/prompt 走 hash 不落盘明文。 */
export function resultCacheKey(identity, cfg = {}, options = {}) {
  return cacheKey([identity, {
    nv: options.needsVisual === true,
    sf: options.saveFrames === true, // 是否落盘帧文件影响返回的 frames 字段
    fc: cfg.frameCount,
    fw: cfg.frameWidth,
    native: !!(cfg.nativeEnabled && options.native),
    vc: cfg.visualChannel || 'dsh',
    vdm: cfg.visualDshModel || '', // 通道A视觉模型覆盖
    vurl: shortHash(cfg.visualBaseUrl), // 通道B视觉端点
    vm: cfg.visualModel || '',
    vp: shortHash(cfg.visualPrompt),
    vmt: cfg.visualMaxTokens || 1000,
    ac: cfg.asrChannel || 'dsh',
    aurl: shortHash(cfg.asrBaseUrl), // 通道B ASR 端点
    am: cfg.asrModel || '',
    al: cfg.asrLanguage || '',
    olv: options.language || '', // 调用方语言提示覆盖
    psub: options.preferSubtitle ?? cfg.preferSubtitle, // 字幕开关影响路线与结果
    pasr: options.preferAsr ?? cfg.preferAsr,
    av: cfg.autoVisual, // 无文字时自动抽帧影响是否产生 visual 字段
  }])
}

/* ---------------- ffmpeg 基础操作 ---------------- */

// B站 CDN 需要 Referer，否则 403（与 src/bili/vision.js grabFrame 同款头）
const BILI_HEADERS = `Referer: https://www.bilibili.com/\r\nUser-Agent: ${UA}\r\n`

function spawnFfmpeg(ffmpeg, args, { timeoutMs = 30000, maxBytes = 100 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let proc
    try {
      proc = spawn(ffmpeg, ['-hide_banner', '-nostdin', ...args], { windowsHide: true })
    } catch {
      return resolve({ ok: false, buf: null, stderr: '' })
    }
    const out = []
    let bytes = 0
    let stderr = ''
    let settled = false
    let timer
    const finish = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok, buf: Buffer.concat(out), stderr })
    }
    timer = setTimeout(() => { try { proc.kill() } catch {} finish(false) }, timeoutMs)
    proc.stdout.on('data', (d) => {
      if (settled) return
      bytes += d.length
      if (bytes > maxBytes) { try { proc.kill() } catch {} return finish(false) }
      out.push(d)
    })
    proc.stderr.on('data', (d) => { stderr += String(d).slice(0, 8000); if (stderr.length > 8000) stderr = stderr.slice(-8000) })
    proc.on('error', () => finish(false))
    proc.on('close', (code) => finish(code === 0 && out.length > 0))
  })
}

/** 探测时长与是否有音轨（本地文件与 URL 都用 ffmpeg -i 的 stderr）。 */
export async function probeMedia(ffmpeg, src, { isBili = false, timeoutMs = 30000 } = {}) {
  const args = [
    ...(isBili ? ['-headers', BILI_HEADERS] : []),
    ...(src.startsWith('http') ? ['-rw_timeout', String(timeoutMs * 1000), '-user_agent', UA] : []),
    '-i', src,
  ]
  const { stderr } = await spawnFfmpeg(ffmpeg, args, { timeoutMs })
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  const durationSec = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null
  const hasAudio = /Stream.*Audio:/i.test(stderr)
  return { durationSec, hasAudio }
}

/** 抽音轨 → 16kHz 单声道 PCM16 WAV（DSH speechToText / OpenAI 兼容 ASR 都吃这个格式）。 */
export async function extractAudioWav(ffmpeg, src, { isBili = false, timeoutMs = 300000, maxBytes = 100 * 1024 * 1024 } = {}) {
  const args = [
    ...(isBili ? ['-headers', BILI_HEADERS] : []),
    ...(src.startsWith('http') ? ['-rw_timeout', String(timeoutMs * 1000), '-user_agent', UA] : []),
    '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', 'pipe:1',
  ]
  const { ok, buf, stderr } = await spawnFfmpeg(ffmpeg, args, { timeoutMs, maxBytes })
  if (!ok || buf.length < 44) {
    const e = new Error(`抽音轨失败（无音轨或解码失败）: ${stderr.slice(-200)}`)
    e.kind = 'no-audio'
    throw classifyError(e)
  }
  return buf
}

/** 本地文件抽帧：与 grabFrame 同参数同校验（ffd8 魔数 + >500字节），但不带 B站头/协议白名单（file 协议进不去）。 */
export function grabLocalFrame(ffmpeg, path, at, { width = 512, timeoutMs = 15000, maxBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let proc
    try {
      proc = spawn(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-ss', String(at), '-i', path,
        '-frames:v', '1', '-an', '-vf', `scale=${width}:-2`,
        '-q:v', '3', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1',
      ], { windowsHide: true })
    } catch { return resolve(null) }
    const out = []
    let bytes = 0
    let settled = false
    let timer
    const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v) } }
    timer = setTimeout(() => { try { proc.kill() } catch {} finish(null) }, timeoutMs)
    proc.stdout.on('data', (d) => {
      if (settled) return
      bytes += d.length
      if (bytes > maxBytes) { try { proc.kill() } catch {} return finish(null) }
      out.push(d)
    })
    proc.stderr.on('data', () => {})
    proc.on('error', () => finish(null))
    proc.on('close', (code) => {
      const buf = Buffer.concat(out)
      finish(code === 0 && buf.length > 500 && buf[0] === 0xff && buf[1] === 0xd8 ? buf : null)
    })
  })
}

/* ---------------- 引擎工厂 ---------------- */

export function createEngine({ api, dsh, log = () => {}, cache }) {
  const s = () => api.settings()          // 模块扁平配置
  const full = () => api.config()          // 插件全局配置（bili.cookie / bili.ffmpegPath）
  let lastError = null

  const ffmpegPath = () => findFfmpeg(full().bili?.ffmpegPath || '')

  function biliApi() {
    return createBiliApi({ getCookie: () => full().bili?.cookie || '', log: (m) => log(`[video-understand] ${m}`) })
  }

  // 'provider/model' → {provider, model}（第一个 / 分隔；空/不合法返回 null 跟随默认）
  function parseDshModel(str) {
    const v = String(str || '').trim()
    if (!v) return null
    const i = v.indexOf('/')
    if (i <= 0 || i === v.length - 1) { log(`[video-understand] visualDshModel 格式应为 'provider/model'，忽略: ${v}`); return null }
    return { provider: v.slice(0, i), model: v.slice(i + 1) }
  }

  function channelOkVisual() {
    const c = s()
    return c.visualChannel === 'third'
      ? { ok: !!(c.visualBaseUrl && c.visualApiKey), reason: c.visualBaseUrl ? (c.visualApiKey ? '' : '缺 apiKey') : '缺 baseUrl' }
      : { ok: true, reason: '' }
  }

  function channelOkAsr() {
    const c = s()
    return c.asrChannel === 'third'
      ? { ok: !!(c.asrBaseUrl && c.asrApiKey), reason: c.asrBaseUrl ? (c.asrApiKey ? '' : '缺 apiKey') : '缺 baseUrl' }
      : { ok: !!dsh.get('speechToText'), reason: dsh.get('speechToText') ? '' : 'DSH 未开启语音输入' }
  }

  /** 缓存身份：URL 归一化 / BV号 / 本地 mtime+size / messageId。 */
  async function cacheIdentity(inp) {
    if (inp.kind === 'bilibili-short') {
      const api2 = biliApi()
      const real = await api2.resolveShort(inp.url).catch(() => null)
      if (real) return cacheIdentity(normalizeInput(real))
      return `short:${inp.url}`
    }
    if (inp.kind === 'bilibili') return `bili:${inp.bvid || 'av' + inp.aid}:p${inp.p || 1}`
    if (inp.kind === 'qq-voice') return `ptt:${inp.messageId}`
    if (inp.kind === 'local') {
      let extra = ''
      try { const st = statSync(inp.path); extra = `:${st.mtimeMs}:${st.size}` } catch {}
      return `local:${inp.path}${extra}`
    }
    // url：去掉跟踪参数与 hash
    try {
      const u = new URL(inp.url)
      for (const k of [...u.searchParams.keys()]) {
        if (URL_TRACKING_PARAMS.has(k)) u.searchParams.delete(k)
      }
      u.hash = ''
      return `url:${u.origin}${u.pathname}${u.search}`
    } catch { return `url:${inp.url}` }
  }

  function limitsCheck(meta, inp) {
    const c = s()
    if (meta.durationSec && c.maxDurationSec > 0 && meta.durationSec > c.maxDurationSec) {
      const e = new Error(`视频时长 ${Math.round(meta.durationSec)}s 超过上限 ${c.maxDurationSec}s`)
      e.code = 'TOO_LONG'
      throw classifyError(e)
    }
    if (inp.kind === 'local' && c.maxSizeMB > 0) {
      try {
        const size = statSync(inp.path).size
        if (size > c.maxSizeMB * 1024 * 1024) {
          const e = new Error(`文件 ${(size / 1024 / 1024).toFixed(1)}MB 超过上限 ${c.maxSizeMB}MB`)
          e.code = 'TOO_BIG'
          throw classifyError(e)
        }
        meta.sizeBytes = size
      } catch (e) {
        if (e.code === 'TOO_BIG' || e.code === 'ENOENT') throw e
      }
    }
  }

  function keywordHit(text) {
    const kws = String(s().visualKeywords || '').split(/[,，\n]/).map((x) => x.trim()).filter(Boolean)
    return kws.some((k) => String(text || '').includes(k))
  }

  async function grabFrames({ ffmpeg, inp, meta, times }) {
    const c = s()
    const opts = { width: c.frameWidth || 512, timeoutMs: 15000, maxBytes: 2 * 1024 * 1024 }
    let src = inp.path || inp.url
    let isBili = false
    if (inp.kind === 'bilibili') {
      const api2 = biliApi()
      const info = meta.__info
      const play = await api2.playurl({ bvid: info.bvid, aid: info.aid, cid: info.cid })
      const stream = pickVideoStream(play.video || [])
      if (!stream?.baseUrl) {
        if (play.durl?.length) { throw classifyError(Object.assign(new Error('该视频是 durl(FLV分段) 格式，暂不支持抽帧'), { kind: 'unsupported' })) }
        throw classifyError(Object.assign(new Error('playurl 没有可用视频流'), { kind: 'no-stream' }))
      }
      src = stream.baseUrl
      isBili = true
      meta.width = stream.width || null
      meta.height = stream.height || null
    }
    const frames = []
    for (const t of times) {
      const buf = inp.kind === 'local'
        ? await grabLocalFrame(ffmpeg, src, t, opts)
        : await grabFrame(ffmpeg, src, t, opts) // URL：grabFrame 自带 B站头，普通 CDN 忽略多余 Referer 无害
      frames.push({ tSec: t, buf })
    }
    const got = frames.filter((f) => f.buf)
    if (!got.length) throw classifyError(Object.assign(new Error('所有抽帧都失败'), { kind: 'no-frames' }))
    return frames
  }

  async function saveFrameFiles(key8, frames) {
    const dir = api.dataDir('frames', key8)
    mkdirSync(dir, { recursive: true })
    return frames.map((f, i) => {
      if (!f.buf) return { tSec: f.tSec, path: null }
      const p = join(dir, `${String(i + 1).padStart(2, '0')}.jpg`)
      writeFileSync(p, f.buf)
      return { tSec: f.tSec, path: p, width: null, height: null }
    })
  }

  async function runVisual({ inp, meta, key8, options, tried, chosen }) {
    const c = s()
    const ffmpeg = ffmpegPath()
    if (!ffmpeg) { tried.push({ route: 'frames', ok: false, note: '找不到 ffmpeg（config.bili.ffmpegPath 或 PATH）' }); return null }
    if (!meta.durationSec) { tried.push({ route: 'frames', ok: false, note: '未知时长，无法定位抽帧点' }); return null }
    const t0 = Date.now()
    let frames
    try {
      frames = await grabFrames({ ffmpeg, inp, meta, times: frameTimes(meta.durationSec, c.frameCount || 6) })
    } catch (e) {
      tried.push({ route: 'frames', ok: false, note: e.message, ms: Date.now() - t0 })
      return null
    }
    const bufs = frames.filter((f) => f.buf).map((f) => f.buf)
    const info = { title: meta.title || inp.raw || '', author: meta.author || '', durationSec: meta.durationSec }
    // 通道选择 + 通道间降级
    const order = c.visualChannel === 'third' ? ['third', 'dsh'] : ['dsh', 'third']
    let description = null
    let usage = null
    let usedModel = null
    for (const ch of order) {
      if (ch === 'dsh') {
        if (!(await canUnderstandImages(dsh, full()).catch(() => false))) {
          tried.push({ route: 'frames:dsh', ok: false, note: '没有能看图的模型' })
          continue
        }
        try {
          const r = await describeVisualDsh({
            dsh, cfg: full(), info, frames: bufs,
            model: parseDshModel(c.visualDshModel), prompt: c.visualPrompt || undefined, maxTokens: c.visualMaxTokens,
          })
          description = r.text; usage = r.usage; usedModel = r.model
          break
        } catch (e) {
          tried.push({ route: 'frames:dsh', ok: false, note: classifyError(e).message })
        }
      } else {
        // 降级尝试第三方视觉：只有配置齐全才试
        if (!(c.visualBaseUrl && c.visualApiKey)) {
          tried.push({ route: 'frames:third', ok: false, note: '第三方视觉通道未配置(baseUrl/apiKey)' })
          continue
        }
        try {
          const r = await describeVisualThird({ settings: c, info, frames: frames.filter((f) => f.buf), signal: options.signal, log: (m) => log(m) })
          description = r.text; usage = r.usage; usedModel = r.model
          break
        } catch (e) {
          tried.push({ route: 'frames:third', ok: false, note: classifyError(e).message })
        }
      }
    }
    const ok = !!description
    tried.push({ route: 'frames', ok, note: ok ? undefined : '两个通道都没拿到画面描述', ms: Date.now() - t0 })
    if (!ok) return null
    chosen.add('frames')
    const outFrames = options.saveFrames ? await saveFrameFiles(key8, frames) : []
    return {
      description,
      frames: outFrames,
      __cost: usage?.total_tokens ? { actualTokens: usage.total_tokens, note: `视觉模型 ${usedModel || '第三方'}` } : { actualTokens: null, note: '通道A不返回token用量' },
    }
  }

  async function runAsr({ inp, meta, options, tried, chosen }) {
    const c = s()
    const ffmpeg = ffmpegPath()
    if (!ffmpeg) { tried.push({ route: 'asr', ok: false, note: '找不到 ffmpeg（config.bili.ffmpegPath 或 PATH）' }); return null }
    const t0 = Date.now()
    // 1) 拿到 16k mono wav
    let wav
    try {
      if (inp.kind === 'bilibili') {
        const api2 = biliApi()
        const info = meta.__info
        const play = await api2.playurl({ bvid: info.bvid, aid: info.aid, cid: info.cid })
        const audio = [...(play.audio || [])].sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0))[0]
        if (!audio?.baseUrl) throw classifyError(Object.assign(new Error('playurl 没有可用音轨'), { kind: 'no-audio' }))
        meta.__audioUrl = audio.baseUrl
        wav = await extractAudioWav(ffmpeg, audio.baseUrl, { isBili: true })
      } else {
        const src = inp.path || inp.url
        const probe = meta.hasAudio !== undefined ? { hasAudio: meta.hasAudio } : await probeMedia(ffmpeg, src, { timeoutMs: 30000 })
        if (probe.hasAudio === false) throw classifyError(Object.assign(new Error('该文件没有音轨'), { kind: 'no-audio' }))
        wav = await extractAudioWav(ffmpeg, src, {})
      }
    } catch (e) {
      tried.push({ route: 'asr', ok: false, note: e.message, ms: Date.now() - t0 })
      return null
    }
    // 2) 双通道识别 + 降级
    const order = c.asrChannel === 'third' ? ['third', 'dsh'] : ['dsh', 'third']
    let text = null
    let source = null
    for (const ch of order) {
      try {
        if (ch === 'dsh') {
          const r = await transcribeDsh({ dsh, wav })
          text = r.text; source = 'asr:dsh'
        } else {
          // 降级尝试第三方 ASR：只有配置齐全才试
          if (!(c.asrBaseUrl && c.asrApiKey)) {
            tried.push({ route: 'asr:third', ok: false, note: '第三方 ASR 通道未配置(baseUrl/apiKey)' })
            continue
          }
          const r = await transcribeThird({ settings: c, wav, language: options.language || c.asrLanguage || undefined, signal: options.signal, log: (m) => log(m) })
          text = r.text; source = 'asr:third'
        }
        if (text) break
      } catch (e) {
        tried.push({ route: `asr:${ch}`, ok: false, note: classifyError(e).message })
      }
    }
    const ok = !!text
    tried.push({ route: 'asr', ok, note: ok ? undefined : '两个通道都没识别出文字', ms: Date.now() - t0 })
    if (!ok) return null
    chosen.add('asr')
    return { text, source }
  }

  async function runNative({ inp, meta, options, tried, chosen }) {
    const c = s()
    if (!c.nativeEnabled) { tried.push({ route: 'native', ok: false, note: 'nativeEnabled 未开启（默认关）' }); return null }
    if (!options.native) { tried.push({ route: 'native', ok: false, note: '本次调用未显式传 options.native=true（按调用付费，需逐次确认）' }); return null }
    if (!(c.nativeBaseUrl && c.nativeApiKey)) { tried.push({ route: 'native', ok: false, note: '原生 API 未配置 baseUrl/apiKey' }); return null }
    const t0 = Date.now()
    try {
      // B站视频没有可直接外链的完整视频 URL（DASH 分轨），原生 API 只支持 URL 输入或小体积本地文件
      let sourceUrl = null
      let localPath = null
      if (inp.kind === 'url') {
        await assertPublicUrl(inp.url)
        sourceUrl = inp.url
      } else if (inp.kind === 'local') {
        localPath = inp.path
      } else {
        tried.push({ route: 'native', ok: false, note: '该输入类型暂不支持原生视频 API（需 URL 或本地文件）', ms: Date.now() - t0 })
        return null
      }
      const sizeOk = localPath ? statSync(localPath).size <= 60 * 1024 * 1024 : false
      const r = await nativeUnderstand({ settings: c, prompt: options.prompt, sourceUrl, localPath, sizeOk, signal: options.signal, log: (m) => log(m) })
      tried.push({ route: 'native', ok: true, ms: Date.now() - t0 })
      chosen.add('native')
      return {
        text: r.text,
        __cost: r.usage?.total_tokens
          ? { actualTokens: r.usage.total_tokens, note: `原生模型 ${r.model}` }
          : { actualTokens: null, note: '原生 API 未返回用量' },
      }
    } catch (e) {
      tried.push({ route: 'native', ok: false, note: classifyError(e).message, ms: Date.now() - t0 })
      return null
    }
  }

  async function runPtt({ inp, tried, chosen }) {
    const t0 = Date.now()
    try {
      const onebot = api.core?.onebot
      if (!onebot) throw new Error('拿不到 onebot 客户端')
      const r = await onebot.call('fetch_ptt_text', { message_id: Number(inp.messageId) || inp.messageId }, { timeoutMs: 20000 })
      const text = String(r?.text || '').trim()
      if (!text) throw new Error('fetch_ptt_text 返回为空')
      tried.push({ route: 'ptt', ok: true, ms: Date.now() - t0 })
      chosen.add('ptt')
      return { text, source: 'asr:ptt' }
    } catch (e) {
      tried.push({ route: 'ptt', ok: false, note: classifyError(e).message, ms: Date.now() - t0 })
      return null
    }
  }

  /* ---------------- 对外接口 ---------------- */

  /** understand(input, options?) → Promise<结构化结果>（蓝图结构）。全部路线失败时抛最后一个错误。 */
  async function understand(input, options = {}) {
    const c = s()
    const inp = normalizeInput(input)
    const chosen = new Set()
    const tried = []
    try {
      // 缓存（options 与通道/模型配置里影响结果的子集参与 key，见 resultCacheKey）
      const identity = await cacheIdentity(inp)
      const key8 = resultCacheKey(identity, c, options)
      if (c.cacheEnabled !== false) {
        const hit = cache.get(key8, (c.cacheTtlHours || 0) * 3600)
        if (hit) return hit
      }

      // meta / 限额
      const meta = { durationSec: null, sizeBytes: null, mime: null, platform: null, title: null, sourceUrl: null, width: null, height: null }
      const ffmpeg = ffmpegPath()
      if (inp.kind === 'bilibili') {
        meta.platform = 'bilibili'
        const api2 = biliApi()
        const info = await api2.view({ bvid: inp.bvid, aid: inp.aid })
        meta.__info = info
        meta.title = info.title || null
        meta.durationSec = Number(info.duration) || null
        meta.sourceUrl = info.bvid ? `https://www.bilibili.com/video/${info.bvid}` : null
        meta.author = info.author || null
      } else if (inp.kind === 'local') {
        meta.platform = 'local'
        if (!existsSync(inp.path)) throw classifyError(Object.assign(new Error(`文件不存在: ${inp.path}`), { code: 'ENOENT' }))
        meta.mime = inp.path.toLowerCase().endsWith('.mp4') ? 'video/mp4' : null
        if (ffmpeg) {
          const p = await probeMedia(ffmpeg, inp.path)
          meta.durationSec = p.durationSec
          meta.hasAudio = p.hasAudio
        }
      } else if (inp.kind === 'url') {
        meta.platform = 'url'
        meta.sourceUrl = inp.url
        await assertPublicUrl(inp.url) // SSRF 防护：挡内网地址
        if (ffmpeg) {
          const p = await probeMedia(ffmpeg, inp.url)
          meta.durationSec = p.durationSec
          meta.hasAudio = p.hasAudio
        }
      }
      limitsCheck(meta, inp)

      let transcript = { text: '', source: null, language: null, segments: [] }
      let visual = { description: null, frames: [] }
      let events = []
      let cost = { estimatedTokens: null, actualTokens: null, note: '' }

      if (inp.kind === 'qq-voice') {
        const r = await runPtt({ inp, tried, chosen })
        if (r) { transcript = { text: r.text, source: 'asr', language: null, segments: [] } }
      } else {
        // 1) 字幕（仅 B站，核心版范围）
        if (inp.kind === 'bilibili' && c.preferSubtitle !== false) {
          const t0 = Date.now()
          try {
            const text = await biliApi().subtitle({ bvid: meta.__info.bvid, aid: meta.__info.aid, cid: meta.__info.cid })
            if (text) {
              transcript = { text, source: 'subtitle', language: null, segments: [] }
              tried.push({ route: 'subtitle', ok: true, ms: Date.now() - t0 })
              chosen.add('subtitle')
            } else {
              tried.push({ route: 'subtitle', ok: false, note: '没有可用字幕', ms: Date.now() - t0 })
            }
          } catch (e) {
            tried.push({ route: 'subtitle', ok: false, note: classifyError(e).message, ms: Date.now() - t0 })
          }
        }
        // 2) ASR（无字幕时；字幕命中则跳过，省一份转写开销）
        if (!transcript.text && c.preferAsr !== false) {
          const r = await runAsr({ inp, meta, options, tried, chosen })
          if (r) transcript = { text: r.text, source: 'asr', language: options.language || c.asrLanguage || null, segments: [] }
        }
        // 3) 原生视频 API（默认关；显式 opt-in）
        if (c.nativeEnabled && options.native) {
          const r = await runNative({ inp, meta, options, tried, chosen })
          if (r) {
            transcript = { text: r.text, source: 'native', language: null, segments: [] }
            cost.actualTokens = r.__cost.actualTokens
            cost.note = r.__cost.note
          }
        }
        // 4) 抽帧+VLM：显式 needsVisual / 关键词命中 / 全无文字兜底
        const wantVisual = options.needsVisual === true
          || keywordHit(`${meta.title || ''} ${meta.author || ''}`)
          || (!transcript.text && c.autoVisual !== false)
        if (wantVisual) {
          const r = await runVisual({ inp, meta, key8, options, tried, chosen })
          if (r) {
            visual = { description: r.description, frames: r.frames }
            if (!cost.actualTokens && r.__cost.actualTokens) {
              cost.actualTokens = r.__cost.actualTokens
              cost.note = r.__cost.note
            }
          }
        }
      }

      // 全空 = 失败
      if (!transcript.text && !visual.description) {
        const last = tried.filter((t) => !t.ok).pop()
        const e = new Error(`所有路线都没拿到结果${last ? `（最后失败: ${last.route} — ${last.note || ''}）` : ''}`)
        e.code = 'NO_RESULT'
        e.tried = tried
        throw classifyError(e)
      }

      const result = {
        input: { kind: inp.kind === 'bilibili-short' ? 'bilibili' : inp.kind, raw: inp.raw },
        meta: {
          durationSec: meta.durationSec, sizeBytes: meta.sizeBytes ?? null, mime: meta.mime ?? null,
          platform: meta.platform, title: meta.title ?? null, sourceUrl: meta.sourceUrl ?? null,
        },
        transcript,
        visual,
        events,
        route: { chosen: [...chosen].join('+') || 'none', tried, fallbackReason: tried.some((t) => !t.ok) ? (tried.filter((t) => !t.ok).map((t) => `${t.route}: ${t.note || '失败'}`).join('; ')) : null },
        cost,
      }
      if (c.cacheEnabled !== false) {
        cache.put(key8, result)
        cache.trim(c.cacheMaxEntries || 200)
      }
      return result
    } catch (e) {
      lastError = { at: new Date().toISOString(), message: classifyError(e).message }
      throw e
    }
  }

  /** supports(input) → 该输入可走的路线与原因（同步、零网络开销；b23 短链按可解析算）。 */
  function supports(input) {
    const c = s()
    let inp
    try { inp = normalizeInput(input) } catch (e) { return { input: { kind: 'unknown', raw: String(input) }, routes: [], error: e.message } }
    const ff = !!ffmpegPath()
    const isBili = inp.kind === 'bilibili' || inp.kind === 'bilibili-short'
    const routes = []
    if (inp.kind === 'qq-voice') {
      routes.push({ route: 'ptt', ok: !!api.core?.onebot, reason: api.core?.onebot ? '' : '拿不到 onebot 客户端' })
    } else {
      routes.push({ route: 'subtitle', ok: isBili && c.preferSubtitle !== false, reason: isBili ? '' : '仅 B站视频有字幕路线' })
      routes.push({ route: 'asr', ok: ff && c.preferAsr !== false, reason: ff ? '' : '找不到 ffmpeg' })
      routes.push({ route: 'frames', ok: ff, reason: ff ? '' : '找不到 ffmpeg' })
      const nat = c.nativeEnabled && c.nativeBaseUrl && c.nativeApiKey
      routes.push({ route: 'native', ok: !!nat, reason: nat ? '默认关，需 nativeEnabled + options.native' : 'nativeEnabled 未开启或未配置' })
    }
    return { input: { kind: inp.kind === 'bilibili-short' ? 'bilibili' : inp.kind, raw: inp.raw }, routes }
  }

  /** estimate(input, options?) → 预计路线 / token 区间 / 耗时档位（只给档位，不伪精确）。 */
  async function estimate(input, options = {}) {
    const c = s()
    let inp
    try { inp = normalizeInput(input) } catch (e) { return { error: e.message } }
    if (inp.kind === 'qq-voice') {
      return { input: { kind: inp.kind, raw: inp.raw }, route: 'ptt', estimatedTokens: null, time: '秒级', note: 'QQ 服务端转写，不消耗模型 token' }
    }
    let durationSec = null
    let hasSubtitle = null
    if (inp.kind === 'bilibili' || inp.kind === 'bilibili-short') {
      try {
        const real = inp.kind === 'bilibili-short' ? normalizeInput(await biliApi().resolveShort(inp.url)) : inp
        const info = await biliApi().view({ bvid: real.bvid, aid: real.aid })
        durationSec = Number(info.duration) || null
        hasSubtitle = c.preferSubtitle !== false
      } catch { /* 网络不可用时给通用档位 */ }
    } else {
      if (inp.kind === 'url') {
        try {
          await assertPublicUrl(inp.url) // SSRF 防护与 understand 对齐：估算也不能碰内网
        } catch (e) {
          return { input: { kind: inp.kind, raw: inp.raw }, error: `无法访问该地址: ${classifyError(e).message}` }
        }
      }
      const ff = ffmpegPath()
      if (ff) {
        const src = inp.path || inp.url
        try {
          const p = await probeMedia(ff, src, { timeoutMs: 15000 })
          durationSec = p.durationSec
        } catch { /* 探测失败给通用档位 */ }
      }
    }
    const ff = !!ffmpegPath()
    const route = hasSubtitle ? 'subtitle' : ff ? 'asr+frames(按需)' : 'frames(需 ffmpeg)'
    const tokens = hasSubtitle
      ? { low: 0, high: 0 }
      : ff
        ? { low: (c.frameCount || 6) * 500, high: (c.frameCount || 6) * 1500 }
        : null
    const time = hasSubtitle ? '秒级' : durationSec ? (durationSec > 1800 ? '分钟级' : '十秒级') : '十秒级~分钟级'
    return {
      input: { kind: inp.kind === 'bilibili-short' ? 'bilibili' : inp.kind, raw: inp.raw },
      route, estimatedTokens: tokens, time,
      note: hasSubtitle
        ? '字幕命中时不调模型，仅拉字幕文本'
        : '抽帧+VLM 的 token 区间按每帧数百~一千估算，实际以模型计费为准',
    }
  }

  /** status() → 运行状态（同步）。 */
  function status() {
    const c = s()
    const snap = typeof dsh.get('speechToText')?.snapshot === 'function' ? dsh.get('speechToText').snapshot() : null
    const phase = snap?.providers?.find((p) => p.id === snap?.selection?.providerId)?.preparation?.phase || null
    return {
      enabled: c.enabled !== false,
      ffmpeg: ffmpegPath() || null,
      cache: { entries: cache.count(), ...cache.stats },
      channels: {
        visual: { channel: c.visualChannel, ready: channelOkVisual().ok, reason: channelOkVisual().reason },
        asr: { channel: c.asrChannel, ready: channelOkAsr().ok, reason: channelOkAsr().reason, phase },
        native: { enabled: !!c.nativeEnabled, configured: !!(c.nativeBaseUrl && c.nativeApiKey) },
      },
      lastError,
    }
  }

  /** 清缓存（连带帧文件目录）。 */
  function clearCache() {
    cache.clear()
    try {
      const dir = api.dataDir('frames')
      for (const n of readdirSync(dir)) rmSync(join(dir, n), { recursive: true, force: true })
    } catch { /* 目录不存在就算了 */ }
    return { ok: true }
  }

  return { understand, supports, estimate, status, clearCache }
}
