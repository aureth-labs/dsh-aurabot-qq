// 看画面：优先用 B 站自带的「故事板」裁图（不用 ffmpeg、不下载视频流），
// 故事板拿不到才退回从 DASH 流里用 ffmpeg 抽帧，再交给视觉模型描述。
//
// 没开开关 / 拿不到 cid / 画面都取不到 / 模型明确不支持图片时跳过，
// 不影响原来「标题 + 简介 + 字幕 + 热评」的文本流程。

import { spawn } from 'node:child_process'
import { UA } from './api.js'
import { askModel, canSeeImages } from '../core/llm.js'
import { findFfmpeg, findSharp } from '../core/img.js'
import { assertPublicUrl } from '../core/net.js'
import { frameTargets, pickTiles } from './storyboard.js'

// ffmpeg 的查找已经抽到 core/img.js（生图那边也要用），这里保留导出，老的引用不受影响
export { findFfmpeg }

/** 抽帧时间点（秒）：跳过开头结尾各 5%，中间均匀铺开。 */
export function frameTimes(durationSec, count) {
  const d = Number(durationSec) || 0
  if (!Number.isFinite(d) || !(d > 0)) return []
  const n = Math.max(1, Math.min(12, Math.round(Number(count) || 6)))
  const out = []
  for (let i = 0; i < n; i++) {
    const p = n === 1 ? 0.5 : 0.05 + (0.9 * i) / (n - 1)
    out.push(Math.min(Math.max(0, Math.round(d * p)), Math.max(0, Math.floor(d) - 1)))
  }
  return [...new Set(out)]
}

/** 挑一路流来抽帧：优先 H.264（兼容性最好）、短边不低于 480、带宽最低的那路。 */
export function pickVideoStream(list = []) {
  const ok = (list || []).filter((v) => v && v.baseUrl)
  if (!ok.length) return null
  const avc = ok.filter((v) => /^avc/i.test(String(v.codecs || '')))
  const pool = avc.length ? avc : ok
  const decent = pool.filter((v) => Math.min(Number(v.width) || 0, Number(v.height) || 0) >= 480)
  return (decent.length ? decent : pool).slice().sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0))[0] || null
}

/** 从流里抽一帧（JPEG）。失败返回 null，不抛。 */
export function grabFrame(ffmpeg, url, at, { width = 512, timeoutMs = 15000, maxBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let settled = false
    let timer
    const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v) } }
    let proc
    try {
      proc = spawn(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        // B 站 CDN 要 Referer，否则 403
        '-headers', `Referer: https://www.bilibili.com/\r\nUser-Agent: ${UA}\r\n`,
        '-rw_timeout', String(timeoutMs * 1000),
        '-protocol_whitelist', 'http,https,tcp,tls,crypto',
        '-ss', String(at), '-i', url,
        '-frames:v', '1', '-an', '-vf', `scale=${width}:-2`,
        '-q:v', '3', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1',
      ], { windowsHide: true })
    } catch (error) {
      return finish(null)
    }
    const out = []
    let bytes = 0
    const stop = () => { try { proc.kill() } catch (error) {} finish(null) }
    timer = setTimeout(stop, timeoutMs)
    proc.stdout.on('data', (d) => {
      if (settled) return
      bytes += d.length
      if (bytes > maxBytes) return stop()
      out.push(d)
    })
    proc.stderr.on('data', () => {}) // 只用来占位，别让管道堵住
    proc.on('error', () => { clearTimeout(timer); finish(null) })
    proc.on('close', (code) => {
      clearTimeout(timer)
      const buf = Buffer.concat(out)
      finish(code === 0 && buf.length > 500 && buf[0] === 0xff && buf[1] === 0xd8 ? buf : null)
    })
  })
}

const SYSTEM = '你在看一个视频的若干张截图。只写画面上确实能看到的东西：场景、人物、物体、动作、画面里的文字 / 字幕条 / 贴纸。不要猜剧情，不要编造没出现的内容，不要发表感想。用 3~6 句中文写。'

/** 把几帧交给视觉模型，换一段画面描述。 */
export async function describeFrames(dsh, { info, frames, cfg }) {
  const images = frames.map((f) => ({ data: f.toString('base64'), mediaType: 'image/jpeg' }))
  const text = await askModel(dsh, {
    cfg,
    system: SYSTEM,
    text: `这些截图来自视频《${info.title}》（UP主 ${info.author || '?'}，时长 ${Math.round(Number(info.duration) || 0)} 秒），按时间先后排列，大致分布在全片 5%~95% 的位置。\n把它们当成「我看到了什么」如实记下来。`,
    images,
    maxTokens: 1000,
    temperature: 0.3,
  })
  return String(text || '').trim()
}

/** 面板用：开关 + ffmpeg 找到了没。 */
export function visionState(biliCfg) {
  const ffmpeg = findFfmpeg(biliCfg && biliCfg.ffmpegPath)
  return { enabled: Boolean(biliCfg && biliCfg.vision), ffmpeg, ready: Boolean(biliCfg && biliCfg.vision && ffmpeg) }
}

/**
 * 没有 DASH 时用渐进式 MP4（durl）的几段来抽帧：每段带 length（毫秒），按顺序拼起来是全片。
 * 返回 [{ url, startMs, endMs }]；length 未知时这一段算到结尾。
 */
export function progressiveWindows(list = []) {
  let start = 0
  const out = []
  for (const x of list || []) {
    if (!x || !x.url) continue
    const lenMs = Number(x.length) || 0
    out.push({ url: x.url, startMs: start, endMs: lenMs > 0 ? start + lenMs : Infinity })
    if (!(lenMs > 0)) break
    start += lenMs
  }
  return out
}

/** 第 sec 秒落在哪一段 durl 里。 */
export function windowAt(windows, sec) {
  const ms = Math.max(0, Number(sec) || 0) * 1000
  if (!windows || !windows.length) return null
  return windows.find((w) => ms >= w.startMs && ms < w.endMs) || windows[windows.length - 1]
}

/**
 * 看画面主流程：先用 B 站自带的故事板裁图（不用 ffmpeg、不下载视频流），
 * 故事板拿不到才退回 ffmpeg 抽帧。
 * 返回 { text, frames }：text 是画面描述（不可用时为空串），frames 是 [{sec, buf}] 抽到的帧
 * （调用方可以存下来当截图用；关掉看画面时两个都为空）。
 */
export async function lookWithVision({ dsh, api, info, getConfig, log, deps = {} }) {
  const empty = { text: '', frames: [] }
  const full = getConfig()
  const c = (full && full.bili) || {}
  if (!c.vision || !dsh || !api) return empty
  if (!info || !info.cid) return empty
  try {
    if (await (deps.canSeeImages || canSeeImages)(dsh, full) === false) {
      log?.debug('看画面跳过：当前模型不支持图片')
      return empty
    }
    // ① 先试故事板：B 站自己把每 N 秒抽一帧拼成一张图，裁一块就行 —— 比 ffmpeg 轻，
    //    也是「没装 ffmpeg」时唯一能看画面的路。
    const sb = await lookViaStoryboard({ api, info, c, log, deps })
    if (sb.frames.length) {
      const text = await (deps.describeFrames || describeFrames)(dsh, { info, frames: sb.frames.map((f) => f.buf), cfg: full })
      return { text: String(text || '').trim(), frames: sb.frames }
    }
  } catch (error) {
    log?.debug('故事板看画面失败：', error.message)
  }
  // ② 退回 ffmpeg
  return lookViaFfmpeg({ dsh, api, info, getConfig, log, deps, full, c })
}

/** 故事板裁图：不需要 ffmpeg，只要有 sharp。 */
async function lookViaStoryboard({ api, info, c, log, deps }) {
  const empty = { frames: [] }
  if (typeof api.storyboard !== 'function' || typeof api.storyboardTile !== 'function') return empty
  let sharp = null
  try { sharp = await (deps.findSharp || findSharp)({}) } catch (error) { sharp = null }
  if (!sharp) {
    log?.debug('故事板跳过：没有 sharp 裁不了图')
    return empty
  }
  // 多 P 视频的故事板通常只覆盖第 1P：目标时刻按第 1P 的时长算
  const pages = Array.isArray(info.pages) ? info.pages : []
  const covered = Number((pages[0] && pages[0].duration) || info.duration) || 0
  const sb = await api.storyboard({ bvid: info.bvid, aid: info.aid, cid: info.cid, duration: Number(info.duration) || 0, coveredSec: covered })
  if (!sb.ok) {
    log?.debug('故事板拿不到：', sb.reason || '')
    return empty
  }
  const targets = frameTargets(sb.covered, { count: c.visionFrames || 3 })
  const picks = pickTiles(sb.entries, targets)
  if (!picks.length) return empty
  // 一张拼图里排几块：B 站实测是 10×10 = 100 块（4800x2700，单块 480x270）。
  // ⚠️ 不能拿 entries 数量去估 —— entries 是「覆盖到的时间块总数」，不等于「每张拼图装几块」，
  //    估出来会偏小，块号一错位就裁到隔壁画面的时间上。
  const perSheet = Number(sb.tiles) || 100
  const frames = []
  for (const [tileIndex, ts] of picks) {
    const sheetNo = Math.floor(tileIndex / perSheet)
    const sheetUrl = sb.sheets[sheetNo] || sb.sheets[0]
    if (!sheetUrl) continue
    const buf = await api.storyboardTile(sheetUrl, tileIndex % perSheet, { cols: perSheet, tw: sb.tw, th: sb.th, sharp })
    if (buf) frames.push({ sec: Math.round(ts), buf })
  }
  if (!frames.length) log?.debug('故事板裁出来的帧都是空的')
  return { frames }
}

/** ffmpeg 抽帧：故事板拿不到时的兜底。 */
async function lookViaFfmpeg({ dsh, api, info, getConfig, log, deps, full, c }) {
  const empty = { text: '', frames: [] }
  if (typeof api.playurl !== 'function') return empty
  const ffmpeg = (deps.findFfmpeg || findFfmpeg)(c.ffmpegPath)
  if (!ffmpeg) {
    log?.debug('看画面跳过：没找到 ffmpeg')
    return empty
  }
  const assertUrl = deps.assertPublicUrl || assertPublicUrl
  const frames = []
  try {
    const pu = await api.playurl({ bvid: info.bvid, aid: info.aid, cid: info.cid })
    // 优先 DASH；很多账号 / 视频只回 durl（渐进式 MP4），这时按段落定位照样能抽帧。
    const stream = pickVideoStream(pu && pu.video)
    const windows = stream ? [] : progressiveWindows(pu && pu.durl)
    if (stream) await assertUrl(stream.baseUrl)
    else if (windows.length) await assertUrl(windows[0].url)
    else {
      log?.debug('看画面跳过：拿不到可抽帧的流地址')
      return empty
    }
    // durl 有时只覆盖前面一段（常见：一段 MP4 十几分钟），在这一段里均匀抽，别把时间点丢到没覆盖的地方。
    const covered = windows.length ? windows[windows.length - 1].endMs : Infinity
    const span = Number.isFinite(covered) ? Math.min(Number(info.duration) || 0, covered / 1000) : Number(info.duration)
    // 整段抽帧最多 60 秒，避免坏流按帧数倍增等待时间。
    const deadline = Date.now() + 60_000
    for (const t of frameTimes(span > 0 ? span : info.duration, c.visionFrames)) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      let url = stream && stream.baseUrl
      let at = t
      if (!url) {
        const win = windowAt(windows, t)
        if (!win) continue
        url = win.url
        at = Math.max(0, t - win.startMs / 1000) // 段内相对时间
        await assertUrl(url)
      }
      const buf = await (deps.grabFrame || grabFrame)(ffmpeg, url, at, { timeoutMs: Math.min(15000, remaining) })
      if (buf) frames.push({ sec: t, buf })
    }
    if (!frames.length) {
      log?.debug('看画面跳过：一帧都没抽出来')
      return empty
    }
    const text = await (deps.describeFrames || describeFrames)(dsh, { info, frames: frames.map((f) => f.buf), cfg: full })
    return { text: String(text || '').trim(), frames }
  } catch (error) {
    log?.debug('看画面失败，退回文字：', error.message)
    return { text: '', frames }
  }
}
