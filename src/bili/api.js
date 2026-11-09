// B 站网页端接口：搜视频、看视频信息 / 字幕 / 评论、发评论 / 弹幕、看别人的回复。
// 登录靠用户在面板里填的 Cookie（SESSDATA、bili_jct）；部分接口要 WBI 签名，buvid3 没有就自己申请一个。
// 登录凭证由配置提供，接口不刷新或保存账号。

import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { cleanOutboundText } from '../chat/reply.js'
import { dataDir } from '../core/store.js'
import { bangumiEpisode, videoPart, danmakuParams, danmakuResponse } from './danmaku.js'
import { snapshotEntries as storyboardEntries } from './storyboard.js'

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52]

/** 把用户粘贴的 Cookie 解析成键值；只认 B 站用得到的几个。 */
export function parseCookie(raw) {
  const out = {}
  for (const part of String(raw || '').split(/;\s*/)) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    const k = part.slice(0, i).trim()
    if (['SESSDATA', 'bili_jct', 'DedeUserID', 'buvid3', 'buvid4', 'DedeUserID__ckMd5', 'sid'].includes(k)) out[k] = part.slice(i + 1).trim()
  }
  return out
}

/** WBI 签名：按 mixin 表从两段 key 里取出 32 位，参数排序后连上它取 md5。 */
export function wbiSign(params, imgKey, subKey, now = Date.now()) {
  const raw = imgKey + subKey
  const mixin = MIXIN.map((i) => raw[i]).join('').slice(0, 32)
  const p = { ...params, wts: Math.round(now / 1000) }
  const query = Object.keys(p).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`).join('&')
  return query + '&w_rid=' + createHash('md5').update(query + mixin).digest('hex')
}

/** 从链接或文字里认出视频号：BV 号、av 号、b23.tv 短链（短链要先跳转）。 */
export function findVideoId(text) {
  const s = String(text || '')
  const bv = s.match(/\b(BV[0-9A-Za-z]{10})\b/)
  if (bv) return { bvid: bv[1] }
  const av = s.match(/\bav(\d{3,})\b/i)
  if (av) return { aid: av[1] }
  const short = s.match(/https?:\/\/b23\.tv\/[0-9A-Za-z]+/)
  if (short) return { short: short[0] }
  return null
}

const stripHtml = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")

const FACE_MAX = 2 * 1024 * 1024

/** 有的图床（含 QQ multimedia.nt.qq.com）Content-Type 会给 application/octet-stream，按文件头认一下。 */
export function sniffImageType(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf || [])
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  return ''
}

/** index 为空时的兜底：pvdata 指向一个大端 uint16 秒数数组。 */
export async function storyboardEntriesFromPvdata(fetchJson, data, covered) {
  const raw = await fetchJson(String(data.pvdata), { raw: true })
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || [])
  const out = []
  for (let i = 0; i + 1 < buf.length; i += 2) out.push([buf.readUInt16BE(i), out.length])
  const biggest = out.length ? Math.max(...out.map(([v]) => v)) : 0
  const scale = covered > 0 && biggest > covered * 1.5 ? 1000 : 1
  return out.map(([v, i]) => [v / scale, i])
}

export function createBiliApi({ getCookie, log, fetchImpl = fetch, getThrottle }) {
  let wbi = null // { img, sub, at }
  let buvid = ''
  // 请求节流：连着搜好几个关键词、连着开几个视频的时候，给 B 站留一点间隔，别被当成脚本
  let lastAt = 0
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  async function throttle() {
    const gap = Math.max(0, Number(typeof getThrottle === 'function' ? getThrottle() : 0) || 0)
    if (!gap) return
    const wait = lastAt + gap - Date.now()
    if (wait > 0) await sleep(Math.min(wait, 8000))
    lastAt = Date.now()
  }

  function cookieHeader() {
    const c = parseCookie(getCookie())
    if (!c.buvid3 && buvid) c.buvid3 = buvid
    return Object.entries(c).map(([k, v]) => `${k}=${v}`).join('; ')
  }

  async function req(url, { method = 'GET', form, multipart, timeoutMs = 20000, signal, envelope = false, throttle: doThrottle = true, headers: extraHeaders } = {}) {
    if (doThrottle) await throttle()
    const headers = { 'user-agent': UA, referer: 'https://www.bilibili.com/', origin: 'https://www.bilibili.com', cookie: cookieHeader(), ...(extraHeaders || {}) }
    let body
    if (multipart) {
      body = multipart // FormData：content-type 带 boundary 由 fetch 自己填
    } else if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded'
      body = new URLSearchParams(form).toString()
    }
    const timeout = AbortSignal.timeout(timeoutMs)
    const r = await fetchImpl(url, { method, headers, body, signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
    const j = await r.json().catch(() => ({ code: r.status, message: 'HTTP ' + r.status }))
    if (envelope) return j
    if (j.code !== 0) {
      const e = new Error(`B 站返回 ${j.code}${j.message ? '：' + j.message : ''}`)
      e.code = j.code
      throw e
    }
    return j.data
  }

  /** 没有 buvid3 时申请一个（搜索等接口没有它会被风控）。 */
  async function ensureBuvid() {
    if (buvid || parseCookie(getCookie()).buvid3) return
    try {
      const d = await req('https://api.bilibili.com/x/frontend/finger/spi')
      buvid = d.b_3 || ''
    } catch (error) {
      log?.debug('申请 buvid 失败：', error.message)
    }
  }

  /** 当前在用的 buvid3（凭证里没填时就是自动申请的那个）：写进配置能少一次申请、也更稳。 */
  function currentBuvid() {
    return parseCookie(getCookie()).buvid3 || buvid || ''
  }

  /** 登录状态 + WBI 签名用的 key（没登录也能拿到 key）。 */
  async function nav() {
    const headers = { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: cookieHeader() }
    const r = await fetchImpl('https://api.bilibili.com/x/web-interface/nav', { headers, signal: AbortSignal.timeout(15000) })
    const j = await r.json()
    const d = j.data || {}
    const key = (u) => String(u || '').split('/').pop().split('.')[0]
    if (d.wbi_img) wbi = { img: key(d.wbi_img.img_url), sub: key(d.wbi_img.sub_url), at: Date.now() }
    return { isLogin: Boolean(d.isLogin), uname: d.uname || '', mid: d.mid || 0 }
  }

  async function signed(base, params) {
    if (!wbi || Date.now() - wbi.at > 6 * 3600_000) await nav()
    if (!wbi) throw new Error('拿不到 B 站的签名 key')
    return base + '?' + wbiSign(params, wbi.img, wbi.sub)
  }

  /** 搜视频：[{bvid, aid, title, author, play, pubdate, duration, desc}] */
  async function search(keyword, { page = 1 } = {}) {
    await ensureBuvid()
    const d = await req(await signed('https://api.bilibili.com/x/web-interface/wbi/search/type', { search_type: 'video', keyword, page }))
    return (d.result || []).map((v) => ({
      bvid: v.bvid, aid: v.aid, title: stripHtml(v.title), author: v.author, play: Number(v.play) || 0, pubdate: (v.pubdate || 0) * 1000, duration: v.duration, desc: stripHtml(v.description).slice(0, 200),
    }))
  }

  /** 热门视频。 */
  async function popular({ ps = 20 } = {}) {
    await ensureBuvid()
    const d = await req(`https://api.bilibili.com/x/web-interface/popular?ps=${ps}&pn=1`)
    return (d.list || []).map((v) => ({ bvid: v.bvid, aid: v.aid, title: v.title, author: v.owner?.name, play: v.stat?.view || 0, pubdate: (v.pubdate || 0) * 1000, desc: String(v.desc || '').slice(0, 200) }))
  }

  /** 视频信息。可以传 { bvid, aid }，也可以直接传 BV 号字符串。 */
  async function view(arg) {
    // 兼容两种调用：view('BVxxx') 和 view({ bvid })
    const input = typeof arg === 'string' ? { bvid: (String(arg).match(/BV[0-9A-Za-z]{10}/) || [])[0] || '' } : (arg || {})
    const bvid = input.bvid
    const aid = input.aid
    await ensureBuvid()
    // 不签名的旧接口经常被风控（412），用 WBI 签名的那个
    const d = await req(await signed('https://api.bilibili.com/x/web-interface/wbi/view', bvid ? { bvid } : { aid }))
    return {
      bvid: d.bvid, aid: d.aid, cid: d.cid, title: d.title, desc: String(d.desc || '').slice(0, 600), author: d.owner?.name, authorMid: d.owner?.mid,
      cover: d.pic, duration: d.duration,
      play: d.stat?.view || 0, like: d.stat?.like || 0, reply: d.stat?.reply || 0, pubdate: (d.pubdate || 0) * 1000, tname: d.tname,
    }
  }

  /**
   * 故事板（B 站自带的「每 N 秒抽一帧拼成一张图」）。
   * 不用 ffmpeg、不用下视频流，没装 ffmpeg 时的兜底就是它。
   * 返回 {ok, sheets, tw, th, entries, covered} 或 {ok:false, reason}
   */
  async function storyboard({ bvid, aid, cid, duration = 0, coveredSec = 0 }) {
    await ensureBuvid()
    const fetchJson = async (url, opts) => {
      if (opts?.raw) {
        const r = await fetchImpl(url, { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: cookieHeader() }, signal: AbortSignal.timeout(20000) })
        return Buffer.from(await r.arrayBuffer())
      }
      return req(url)
    }
    let lastError = null
    for (let attempt = 0; attempt < 2; attempt++) {
      let data = null
      try {
        // ⚠️ 这个接口不是 WBI 签名的那种，路径就是 /x/player/videoshot；
        //    而且 pvideo 默认 true 会走老接口拿不到故事板，必须传 false。
        const q = new URLSearchParams({
          ...(bvid ? { bvid } : { aid: String(aid) }),
          cid: String(cid),
          index: '1',
          pvideo: 'false',
        })
        data = await fetchJson('https://api.bilibili.com/x/player/videoshot?' + q.toString())
      } catch (error) { lastError = error }
      const covered = Number(coveredSec) || Number(duration) || 0
      let entries = storyboardEntries(data, covered)
      if (!entries.length && data?.pvdata) entries = await storyboardEntriesFromPvdata(fetchJson, data, covered).catch(() => [])
      const sheets = Array.isArray(data?.image) ? data.image.filter(Boolean) : []
      if (entries.length && sheets.length) {
        const storyMax = Math.max(...entries.map(([ts]) => ts), 0)
        return {
          ok: true,
          // 拼图地址是协议相对地址（//bimp.hdslb.com/...），不补 https: 的话 fetch 会报 Invalid URL
          sheets: sheets.map((u) => (String(u).startsWith('//') ? 'https:' + u : String(u))),
          entries,
          tw: Number(data.img_x_size) || 480,
          th: Number(data.img_y_size) || 270,
          // 一张拼图装几块：B 站给了块数就直接用，没给按 10×10 算（实测 4800x2700 的图 = 100 块）
          tiles: Number(data.img_x_len) && Number(data.img_y_len)
            ? Number(data.img_x_len) * Number(data.img_y_len)
            : 100,
          covered: storyMax > 0 ? Math.min(covered || storyMax, storyMax) : covered,
        }
      }
      // index 会偶发返回空（约 25%），空一次等一会儿再试
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1000))
    }
    return { ok: false, reason: lastError ? lastError.message : '取不到画面快照（试了 2 次）' }
  }

  /** 下载一张拼图并裁出第 index 块（JPEG）。sharp 不可用时返回 null。 */
  async function storyboardTile(sheetUrl, tileIndex, { cols = 5, tw = 480, th = 270, sharp = null } = {}) {
    if (!sharp || typeof sharp !== 'function') return null
    try {
      const r = await fetchImpl(sheetUrl, { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: cookieHeader() }, signal: AbortSignal.timeout(20000) })
      if (!r.ok) return null
      const buf = Buffer.from(await r.arrayBuffer())
      const meta = await sharp(buf).metadata()
      // 列数按真实图宽算（不同视频拼图排法不一样，别写死 5）
      const c = Math.max(1, Math.floor(Number(meta.width || 0) / tw) || cols)
      const col = tileIndex % c
      const row = Math.floor(tileIndex / c)
      if ((row + 1) * th > Number(meta.height || 0)) return null
      const out = await sharp(buf).extract({ left: col * tw, top: row * th, width: tw, height: th }).jpeg({ quality: 85 }).toBuffer()
      return Buffer.isBuffer(out) && out.length ? out : null
    } catch (error) {
      log?.debug('裁故事板失败：', error.message)
      return null
    }
  }

  /** DASH / 渐进式音视频流地址，视频流供 ffmpeg 定位抽帧。 */
  async function playurl({ bvid, aid, cid, qn = 64 }) {
    await ensureBuvid()
    // fnval 4048 = DASH + HDR + 4K + 杜比等全要；很多账号 / 视频现在只回 durl（渐进式 MP4），所以两种都带出去。
    const d = await req(await signed('https://api.bilibili.com/x/player/wbi/playurl', {
      ...(bvid ? { bvid } : { aid }), cid, qn, fnval: 4048, fnver: 0, fourk: 1,
    }))
    const one = (x) => (x ? { id: x.id, width: x.width, height: x.height, codecs: x.codecs || '', bandwidth: x.bandwidth || 0, baseUrl: x.baseUrl || x.base_url || '' } : null)
    // 没有 DASH 时退回 durl：每段是渐进式 MP4，length 是这一段的毫秒数（按顺序拼起来是全片）。
    const durl = (d.durl || [])
      .map((x) => ({ order: Number(x.order) || 0, url: x.url || '', length: Number(x.length) || 0, size: Number(x.size) || 0 }))
      .filter((x) => x.url)
    return {
      video: (d.dash?.video || []).map(one).filter((v) => v && v.baseUrl),
      audio: (d.dash?.audio || []).map(one).filter((v) => v && v.baseUrl),
      durl,
    }
  }

  /** 字幕全文（优先中文；AI 字幕要登录才有）。拿不到返回 ''。 */
  async function subtitle({ bvid, aid, cid }) {
    try {
      const d = await req(await signed('https://api.bilibili.com/x/player/wbi/v2', { ...(bvid ? { bvid } : { aid }), cid }))
      const list = d.subtitle?.subtitles || []
      const pick = list.find((s) => /zh|中文/.test(s.lan + s.lan_doc)) || list[0]
      if (!pick?.subtitle_url) return ''
      const url = pick.subtitle_url.startsWith('//') ? 'https:' + pick.subtitle_url : pick.subtitle_url
      const r = await fetchImpl(url, { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(15000) })
      const j = await r.json()
      return (j.body || []).map((x) => x.content).join(' ')
    } catch (error) {
      log?.debug('拿字幕失败：', error.message)
      return ''
    }
  }

  /** 热门评论：[{rpid, name, mid, text, like, replies}] */
  async function comments(aid, { limit = 12 } = {}) {
    const d = await req(await signed('https://api.bilibili.com/x/v2/reply/wbi/main', { type: 1, oid: aid, mode: 3, plat: 1, web_location: 1315875 }))
    return (d.replies || []).slice(0, limit).map((r) => ({ rpid: r.rpid, name: r.member?.uname, mid: r.mid, text: String(r.content?.message || '').slice(0, 200), like: r.like, replies: r.rcount || 0 }))
  }

  /**
   * 按时间/热度拉一级评论（圈地自萌要用「按时间」才能看到最新邀请）。
   * order: 'time' | 'like'。返回里带 mid，用来判断是不是 UP 主本人发的。
   */
  async function commentsBy(aid, { order = 'time', limit = 100 } = {}) {
    const mode = order === 'like' ? 3 : 2
    const d = await req(await signed('https://api.bilibili.com/x/v2/reply/wbi/main', { type: 1, oid: aid, mode, plat: 1, web_location: 1315875 }))
    return (d.replies || []).slice(0, Math.max(1, Math.min(100, limit))).map((r) => ({
      rpid: Number(r.rpid) || 0,
      root: Number(r.rpid) || 0,
      mid: Number(r.mid) || 0,
      name: String(r.member?.uname || ''),
      text: String(r.content?.message || '').slice(0, 300),
      like: Number(r.like) || 0,
      replies: Number(r.rcount) || 0,
    }))
  }

  /** 视频的 UP 主 mid 和昵称（圈地自萌只认这个人）。 */
  async function videoOwner(aid) {
    const d = await req(`https://api.bilibili.com/x/web-interface/view?aid=${Number(aid)}`)
    return { mid: Number(d?.owner?.mid) || 0, name: String(d?.owner?.name || '') }
  }

  /** 按昵称精确找用户，找不到返回 0。 */
  async function findUser(name) {
    await ensureBuvid()
    const d = await req(await signed('https://api.bilibili.com/x/web-interface/wbi/search/type', { search_type: 'bili_user', keyword: name }))
    return (d.result || []).find((u) => stripHtml(u.uname) === name)?.mid || 0
  }

  /** 把文字里的 @昵称 换成接口要的 { 昵称: mid }；光写文字 B 站不算 @。查不到的留作普通文字。 */
  async function resolveAts(message) {
    const names = [...new Set([...message.matchAll(/@([^\s@:：,，。!！?？]+)/g)].map((m) => m[1]))]
    const map = {}
    for (const name of names) {
      try {
        const mid = await findUser(name)
        if (mid) map[name] = mid
      } catch (error) { log?.debug?.(`查 B 站用户「${name}」失败：`, error.message) }
    }
    return { map, missed: names.filter((n) => !map[n]) }
  }

  /** 发评论；root/parent 不传就是一级评论。要登录。 */
  async function postComment(aid, rawMessage, { root, parent } = {}) {
    const message = cleanOutboundText(rawMessage, { warn: (message) => log?.warn?.(`B 站评论：${message}`) }).replace(/＠/g, '@')
    if (!message.trim()) return { silent: true, rpid: '', at: [], missed: [] }
    const csrf = parseCookie(getCookie()).bili_jct
    if (!csrf) throw new Error('没登录 B 站（Cookie 里要有 bili_jct）')
    const { map, missed } = await resolveAts(message)
    const at = Object.keys(map)
    const d = await req('https://api.bilibili.com/x/v2/reply/add', { method: 'POST', form: { type: 1, oid: aid, message, plat: 1, csrf, ...(root ? { root, parent: parent || root } : {}), ...(at.length ? { at_name_to_mid: JSON.stringify(map) } : {}) } })
    return { rpid: d.rpid, at, missed }
  }

  /**
   * 点赞 / 取消点赞。like=false 就是撤销（撤销不返还额度，额度由上层算）。
   * B 站接口是同一个：like=1 点，like=2 取消。
   */
  async function likeVideo(aid, like = true) {
    const csrf = parseCookie(getCookie()).bili_jct
    if (!csrf) throw new Error('没登录 B 站')
    await req('https://api.bilibili.com/x/web-interface/archive/like', { method: 'POST', form: { aid, like: like ? 1 : 2, csrf } })
  }

  /**
   * 收藏 / 取消收藏。
   * add_media_ids / del_media_ids 是收藏夹 id（fid），不是视频 id —— 容易写反，这里明确一下。
   * 不传 fid 时用「默认收藏夹」（调 favFolders 取第一个）。
   */
  async function favVideo(aid, { fid = 0, on = true } = {}) {
    const csrf = parseCookie(getCookie()).bili_jct
    if (!csrf) throw new Error('没登录 B 站')
    let folder = Number(fid) || 0
    if (!folder) {
      const list = await favFolders()
      folder = Number(list[0]?.id) || 0
    }
    if (!folder) throw new Error('没有可用的收藏夹（B 站账号里一个都没有？）')
    const form = { rid: aid, type: 2, csrf }
    if (on) form.add_media_ids = String(folder)
    else form.del_media_ids = String(folder)
    await req('https://api.bilibili.com/x/v3/fav/resource/deal', { method: 'POST', form })
    return { fid: folder }
  }

  /** 自己的收藏夹列表：[{id, name, count}] */
  async function favFolders() {
    const me = await nav()
    if (!me?.mid) throw new Error('拿不到自己的 B 站 uid（请检查登录）')
    const d = await req(`https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${me.mid}`)
    return (d.list || []).map((f) => ({ id: Number(f.id) || 0, name: String(f.title || ''), count: Number(f.media_count) || 0 }))
  }

  /** 某个用户最近的投稿（圈地自萌要扫 UP 主自己视频的评论区）。 */
  async function userVideos(uid, { pn = 1, ps = 10 } = {}) {
    const d = await req(`https://api.bilibili.com/x/space/wbi/arc/search?mid=${Number(uid)}&pn=${Number(pn) || 1}&ps=${Math.min(50, Number(ps) || 10)}&order=pubdate`)
    const list = d?.list?.vlist || []
    return list.map((v) => ({ bvid: String(v.bvid || ''), title: String(v.title || ''), created: Number(v.created) || 0 })).filter((v) => v.bvid)
  }

  /**
   * 复核「我发的这条评论是不是公开可见」。
   *
   * 为什么需要：B 站接口回 code=0 只代表**收下了**，不代表公开可见 ——
   * 新号 / 触发风控时评论会进审核，只有自己看得见，别人（包括被 @ 的人）都看不到，
   * 而且不会推通知。以前我们以为发出去了、还记进判重表，下一轮就不发了 ⇒ 一条都没到人。
   *
   * 两条只读接口：
   *   ① 顶层：/x/v2/reply/main?type=1&oid=<aid>&mode=2&next=0&ps=20（mode=2 按时间，刚发的在第一页）
   *   ② 楼中楼：/x/v2/reply/reply?type=1&oid=<aid>&root=<root>&ps=20
   * ⚠️ 「没查到」≠「没发出去」：翻页、热度排序都会漏。所以结论用 visible=null 表示「没查到」。
   */
  async function verifyReply({ aid, rpid, root = 0, text = '' }) {
    const want = String(rpid || '')
    if (!want) return { visible: null, how: 'none', note: '没有 rpid，复核不了' }
    const hit = (x) => String(x?.rpid || '') === want
    // ① 楼中楼（有 root 时最准，直接按 root 拉那一串）
    if (root) {
      try {
        const d = await req(`https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${aid}&root=${root}&ps=20&pn=1`)
        const list = d?.replies || []
        const me = list.find(hit)
        if (me) return { visible: Number(me.state ?? 0) === 0, how: 'sub', note: '', state: me.state, likes: me.like }
        return { visible: null, how: 'sub', note: '楼中楼里没查到（可能翻页了）' }
      } catch (error) { /* 落到底层再试 */ }
    }
    // ② 顶层按时间第一页
    try {
      const d = await req(`https://api.bilibili.com/x/v2/reply/main?type=1&oid=${aid}&mode=2&next=0&ps=30`)
      const list = d?.replies || []
      const me = list.find(hit)
      if (me) return { visible: Number(me.state ?? 0) === 0, how: 'main', note: '', state: me.state, likes: me.like }
      // 有的账号刚发的会落在第一页末尾之外，再看一眼「自己发的」列表
      return { visible: null, how: 'main', note: '第一页没查到（可能翻页或进了审核）' }
    } catch (error) {
      return { visible: null, how: 'main', note: '复核接口出错：' + error.message }
    }
  }

  /** 改自己的个性签名（B 站上限 70 字）。要登录。 */
  async function setSign(sign) {
    sign = cleanOutboundText(sign, { warn: (message) => log?.warn?.(`B 站签名：${message}`) })
    if (!sign.trim()) return
    const csrf = parseCookie(getCookie()).bili_jct
    if (!csrf) throw new Error('没登录 B 站（Cookie 里要有 bili_jct）')
    await req('https://api.bilibili.com/x/member/web/sign/update', { method: 'POST', form: { user_sign: sign, csrf } })
  }

  /** 换头像：先把图片下载下来（≤2MB，只收图片），再按网页端的方式 multipart 上传。要登录。 */
  async function setFace(imageUrl) {
    const csrf = parseCookie(getCookie()).bili_jct
    if (!csrf) throw new Error('没登录 B 站（Cookie 里要有 bili_jct）')
    const r = await fetchImpl(imageUrl, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) })
    if (r.ok === false || (typeof r.status === 'number' && (r.status < 200 || r.status >= 300))) throw new Error('图片下载失败：HTTP ' + r.status)
    let type = String(r.headers?.get?.('content-type') || '').split(';')[0].trim()
    const buf = Buffer.from(await r.arrayBuffer())
    if (!buf.length) throw new Error('图片是空的')
    if (buf.length > FACE_MAX) throw new Error('图片超过 2MB，B 站不收')
    if (!/^image\//i.test(type)) type = sniffImageType(buf)
    if (!type) throw new Error('这个网址不是图片')
    const fd = new FormData()
    fd.append('dopost', 'save')
    fd.append('DisplayRank', '10000')
    fd.append('face', new Blob([buf], { type }), 'face.' + (type.split('/')[1] || 'jpg').replace(/[^a-z0-9]/gi, ''))
    await req(`https://api.bilibili.com/x/member/web/face/update?csrf=${encodeURIComponent(csrf)}`, { method: 'POST', multipart: fd, timeoutMs: 30000 })
  }

  /** 别人回复她的消息：[{id, time, name, mid, text, myText, oid, root, parent, title, uri}] */
  async function replyFeed() {
    const d = await req('https://api.bilibili.com/x/msgfeed/reply?platform=web&build=0&mobi_app=web')
    return (d.items || []).map((x) => ({
      id: String(x.id), time: (x.reply_time || 0) * 1000, name: x.user?.nickname, mid: x.user?.mid,
      text: String(x.item?.source_content || '').slice(0, 300), myText: String(x.item?.target_reply_content || x.item?.root_reply_content || '').slice(0, 300),
      oid: x.item?.subject_id, root: x.item?.root_id || x.item?.source_id, parent: x.item?.source_id, title: x.item?.title || '', uri: x.item?.uri || '', type: x.item?.business_id,
    }))
  }

  /** b23.tv 短链跳一下拿到真实地址。 */
  async function resolveShort(url) {
    const r = await fetchImpl(url, { redirect: 'manual', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10000) })
    return r.headers.get('location') || ''
  }

  // ---------------------------------------------------------------- 私信
  // 接口口径（实测过，别乱改）：
  //   列会话 GET /session_svr/v1/session_svr/get_sessions?session_type=1&group_id=0&Build=0&mobi_app=web
  //   读消息 GET /svr_sync/v1/svr_sync/fetch_session_msgs?talker_id=<uid>&session_type=1&size=<n>&build=0&mobi_app=web
  //   发消息 POST /web_im/v1/web_im/send_msg（表单，要 csrf）
  // ⚠️ /x/im/web/session/list 和 /get_msgs 都是 404；fetch_session_msgs 用 POST 会 405。
  const IM_HEADERS = { referer: 'https://message.bilibili.com/', origin: 'https://message.bilibili.com' }

  /** 私信会话列表：[{uid, unread, lastTs, preview}] */
  async function dmSessions() {
    const d = await req('https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?session_type=1&group_id=0&Build=0&mobi_app=web', { headers: IM_HEADERS })
    return (d.session_list || []).map((s) => {
      let preview = ''
      try {
        const c = s.last_msg?.content ? JSON.parse(s.last_msg.content) : null
        preview = String(c?.content || c?.text || '').slice(0, 80)
      } catch (error) { /* 非 JSON 就留空 */ }
      return { uid: Number(s.talker_id) || 0, unread: Number(s.unread_count) || 0, lastTs: (Number(s.last_msg?.timestamp) || 0) * 1000, preview }
    }).filter((x) => x.uid > 0)
  }

  /**
   * 读某个会话最近的消息：[{key, ts, fromMe, text, kind}]
   * 分享卡片是 msg_type 7（视频）/8，content 里没有 content 字段，只有 title/jump_url/author ——
   * 以前被当成空消息丢掉，等于收不到分享。这里单独认出来。
   */
  async function dmMessages(talkerId, { size = 10 } = {}) {
    const n = Math.max(1, Math.min(50, Number(size) || 10))
    const d = await req(`https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs?talker_id=${Number(talkerId)}&session_type=1&size=${n}&build=0&mobi_app=web`, { headers: IM_HEADERS })
    // 自己的 uid：cookie 里不一定有 DedeUserID（面板只让填 SESSDATA 和 bili_jct），
    // 没有就问 nav() 要一次 —— 不然 fromMe 全是 false，会把「自己发过的」当成「别人新说的」再回一遍。
    let me = Number(parseCookie(getCookie()).DedeUserID) || 0
    if (!me) {
      try { me = Number((await nav()).mid) || 0 } catch (error) { me = 0 }
    }
    return (d.messages || []).slice().reverse().map((m) => {
      const mt = Number(m.msg_type) || 1
      let text = ''
      let isCard = false
      try {
        const c = JSON.parse(m.content || '{}')
        if ((mt === 7 || mt === 8) && (c.jump_url || c.bvid || c.author || c.title)) {
          isCard = true
          const bv = String(c.bvid || '') || (String(c.jump_url || '').match(/BV[0-9A-Za-z]{10}/) || [])[0] || ''
          const title = String(c.title || c.headline || c.desc || '').slice(0, 80)
          const who = String(c.author || '').slice(0, 30)
          text = '[分享视频] ' + (title || '(无标题)') + (who ? ' / ' + who : '') + (bv ? ' ' + bv : '')
        } else {
          text = String(c.content || c.text || '')
        }
      } catch (error) { text = String(m.content || '') }
      if (!text) text = '[非文字消息]'
      return { key: String(m.msg_key || m.msg_seqno || m.timestamp), ts: (Number(m.timestamp) || 0) * 1000, fromMe: Number(m.sender_uid) === me, kind: isCard ? mt : 1, text: text.slice(0, 500) }
    })
  }

  /**
   * 稳定的私信设备 ID：只生成一次，之后永久复用。
   * B 站要求形如 WEB-<UUID大写>；随便填或每次换新会被判成
   * 「同一个人在多台设备间高频切换」，私信直接 -400 或被风控。
   */
  let _devId = ''
  function stableDevId() {
    if (_devId) return _devId
    const file = dataDir('bili-device.json')
    try {
      const v = String(readFileSync(file, 'utf8')).trim()
      const m = v.match(/WEB-[0-9A-F-]{20,}/i)
      if (m) { _devId = m[0].toUpperCase(); return _devId }
    } catch (error) { /* 没存过，往下生成 */ }
    const v = 'WEB-' + randomUUID().toUpperCase()
    try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, v + '\n', 'utf8') } catch (error) { /* 存不下就内存里用 */ }
    _devId = v
    return _devId
  }

  /** 发私信（要 csrf；必须互关）。返回 {ok, code, message}。 */
  async function dmSend(toMid, text, devId = '') {
    const c = parseCookie(getCookie())
    // 自己的 uid：cookie 里没有 DedeUserID 就问 nav() 要（sender_uid 填 0 会被 B 站拒）
    let me = String(c.DedeUserID || '')
    if (!me) {
      try { me = String((await nav()).mid || '') } catch (error) { me = '' }
    }
    if (!me) return { ok: false, code: -1, message: '拿不到自己的 B 站 uid（请检查登录）' }
    const body = new URLSearchParams()
    body.set('msg[sender_uid]', me)
    body.set('msg[receiver_id]', String(Number(toMid)))
    body.set('msg[receiver_type]', '1')
    body.set('msg[msg_type]', '1')
    body.set('msg[msg_status]', '0')
    body.set('msg[timestamp]', String(Math.floor(Date.now() / 1000)))
    body.set('msg[dev_id]', devId || stableDevId())
    body.set('msg[content]', JSON.stringify({ content: String(text).slice(0, 300) }))
    body.set('csrf', String(c.bili_jct || ''))
    const r = await fetchImpl('https://api.vc.bilibili.com/web_im/v1/web_im/send_msg', {
      method: 'POST',
      headers: { 'user-agent': UA, ...IM_HEADERS, cookie: cookieHeader(), 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(30000),
    })
    const j = await r.json().catch(() => ({}))
    return { ok: r.ok && j.code === 0, http: r.status, code: j.code, message: j.message || '' }
  }

  /**
   * 和某人的关注关系：attribute 6 = 互关（私信要求是它）。
   * B 站把「特殊关注」也报成 6，所以 6 就是能发。
   */
  async function relation(mid) {
    try {
      const d = await req(`https://api.bilibili.com/x/relation?fid=${Number(mid)}`)
      return { ok: true, attribute: Number(d.attribute ?? -1), beAttribute: d.be_relation?.attribute == null ? null : Number(d.be_relation.attribute) }
    } catch (error) {
      return { ok: false, attribute: -1, why: error.message }
    }
  }

  /** 只读检查弹幕目标；番剧接口返回 result，普通视频按 pages 选出当前 CID。 */
  async function danmakuInfo(video, part, { signal } = {}) {
    if (/^(ep|ss)/.test(video)) {
      const param = video.startsWith('ep') ? 'ep_id' : 'season_id'
      const body = await req(`https://api.bilibili.com/pgc/view/web/season?${param}=${video.slice(2)}`, { envelope: true, signal })
      return bangumiEpisode(body, video, part)
    }
    await ensureBuvid()
    const params = video.startsWith('av') ? { aid: video.slice(2) } : { bvid: video }
    const data = await req(await signed('https://api.bilibili.com/x/web-interface/wbi/view', params), { signal })
    return videoPart(data, part)
  }

  let dmSequence = Date.now()
  async function postDanmaku(info, text, progress, mode, { beforePost, signal } = {}) {
    text = cleanOutboundText(text, { warn: (message) => log?.warn?.(`B 站弹幕：${message}`) })
    if (!text.trim()) return { silent: true }
    const csrf = parseCookie(getCookie()).bili_jct
    if (!csrf) throw Object.assign(new Error('Cookie 里缺少 bili_jct'), { code: -111 })
    const url = await signed('https://api.bilibili.com/x/v2/dm/post', {
      web_location: 1315873, csrf, ...danmakuParams(),
    })
    signal?.throwIfAborted()
    // 签名可能等待网络；在最后一次 await 后再检查开关、登录态和配额。
    beforePost?.()
    const body = await req(url, { method: 'POST', signal, envelope: true, form: {
      color: 16777215, fontsize: 25, pool: 0, mode, type: 1,
      oid: info.cid, aid: info.aid, msg: text, progress, rnd: ++dmSequence,
      plat: 1, checkbox_type: 0, colorful: '', gaiasource: 'main_web',
      polaris_app_id: 100, polaris_platform: 5, spmid: '333.788.0.0', from_spmid: '333.788.0.0',
      statistics: JSON.stringify({ appId: 100, platform: 5, abtest: '', version: '' }), csrf,
    } })
    const response = danmakuResponse(body)
    if (body.code !== 0) throw Object.assign(new Error(`B 站返回 ${body.code}`), { code: body.code, platformResponse: response })
    return { ...response.data, platformResponse: response }
  }

  /**
   * 「有人 @ 我」的消息流（评论里 @ 我 / 动态里 @ 我）。
   * 注意：这跟 replyFeed（别人回复我的评论）是两个不同接口，别混用。
   *   replyFeed → /x/msgfeed/reply
   *   atFeed    → /x/msgfeed/at
   * 实测口径（2026-11-04）：
   *   item.business='评论' 才是评论里 @ 我，'动态' 是动态 @，要滤掉；
   *   item.source_content 是那条评论的正文；
   *   item.subject_id = 视频 aid，item.source_id = 那条评论的 rpid（回复它要用这个）；
   *   item.at_details[] 里能看这条 @ 了谁（用来确认真的 @ 到了自己）。
   */
  async function atFeed() {
    const d = await req('https://api.bilibili.com/x/msgfeed/at?platform=web&build=0&mobi_app=web')
    return (d.items || []).map((x) => ({
      id: String(x.id),
      time: (Number(x.at_time) || 0) * 1000,
      name: x.user?.nickname,
      mid: x.user?.mid,
      business: String(x.item?.business || ''),
      text: String(x.item?.source_content || '').slice(0, 300),
      title: String(x.item?.title || ''),
      uri: String(x.item?.uri || ''),
      aid: x.item?.subject_id,
      rpid: x.item?.source_id,
      rootId: x.item?.root_id,
      ats: (x.item?.at_details || []).map((a) => ({ mid: Number(a.mid) || 0, name: String(a.nickname || '') })),
    }))
  }

  return {
    nav, search, popular, view, playurl, subtitle, comments, commentsBy, videoOwner, postComment, likeVideo, setSign, setFace,
    favVideo, favFolders, userVideos, verifyReply,
    replyFeed, atFeed, resolveShort, danmakuInfo, postDanmaku,
    // 私信：列会话 / 读消息 / 发消息 / 查互关
    dmSessions, dmMessages, dmSend, relation,
    // 故事板抽帧（不依赖 ffmpeg）
    storyboard, storyboardTile,
    // buvid3：凭证里没填时自动申请的那个，可以写回配置
    currentBuvid, ensureBuvid,
  }
}

/** 固定本次登录凭证；实际提交前由调用者核验它是否仍是当前凭证。 */
export async function prepareDanmaku({ cookie, video, part, signal, beforePost }) {
  const client = createBiliApi({ getCookie: () => cookie })
  const info = await client.danmakuInfo(video, part, { signal })
  return { info, post: (text, progress, mode) => client.postDanmaku(info, text, progress, mode, { signal, beforePost }) }
}
