// Breeze 云端账号：查余额、登录拿会话、每天领免费额度。
//
// 跟「合成」分开：这里只跟 BreezeBlue 的站点/接口打交道，不产生音频。
//   GET  {url}/v1/balance                    —— 带 xi-api-key，查还剩多少额度
//   POST {siteUrl}/api/auth/email/continue   —— {email,password} → 会话 Cookie
//   POST {siteUrl}/api/credits/daily-claim   —— 带 Cookie，{reward_tier:'discord'} → +400
// 参考本机 say-sing-drawPlugin 的实现（gateway/lib/say.mjs + scripts/claim-daily-credits.mjs）：
// Cookie 失效自动重登一次；discord 档被拒就降级 standard（+100）。
//
// ⚠️ 站点接口有 Origin 校验，而 Node 的 fetch（undici）**不允许设置 origin 头**（会被吞掉，服务端
// 直接 403 Request origin is not allowed），所以站点那几个请求走 node:https 手动发。
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { dataDir, readJson, writeJson } from '../core/store.js'

const DEFAULT_SITE = 'https://breezeblue.ai'
const DEFAULT_BASE = 'https://api.breeze.blue'
const DAY_MS = 24 * 3600 * 1000
// 同一天不重复领：留 20 小时，跨天时因为时区/停机也能补上
const CLAIM_GAP_MS = 20 * 3600 * 1000

const sessionFile = () => dataDir('breeze-session.json')
const siteOf = (c) => String(c?.siteUrl || DEFAULT_SITE).replace(/\/+$/, '')
const baseOf = (c) => String(c?.url || DEFAULT_BASE).replace(/\/+$/, '')
const timeoutOf = (c) => Number(c?.timeoutMs) || 20000
// 站点接口有 Origin 校验（不带就 403），跟 say-sing-drawPlugin 的脚本一致
const siteHeaders = (c, extra = {}) => ({ origin: siteOf(c), referer: siteOf(c) + '/app/studio', ...extra })

/**
 * 站点请求（node:https 手发，能带 origin 头；fetch 会被剥掉）。
 * @returns {Promise<{status:number, headers:object, text:string, json:object, cookies:string[], location?:string}>}
 */
function siteRequest(url, { method = 'GET', headers = {}, body = null, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    let target
    try { target = new URL(url) } catch (error) { reject(new Error('站点地址不对：' + url)); return }
    const send = target.protocol === 'http:' ? httpRequest : httpsRequest
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body))
    const req = send(target, {
      method,
      headers: { accept: 'application/json', ...headers, ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = {}
        try { json = JSON.parse(text) } catch (error) { json = {} }
        // set-cookie 只取「名字=值」，丢掉 Path/HttpOnly 这些属性
        const cookies = (res.headers['set-cookie'] || []).map((v) => String(v).split(';')[0].trim()).filter(Boolean)
        resolve({ status: res.statusCode || 0, headers: res.headers, text, json, cookies, location: res.headers.location })
      })
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`站点请求超时（${timeoutMs}ms）`)))
    req.on('error', (error) => reject(new Error(`连不上站点：${error.message}`)))
    if (payload) req.write(payload)
    req.end()
  })
}

/** 上次领额度的状态（面板用）。 */
export function breezeSession() {
  const s = readJson(sessionFile(), null)
  return s && typeof s === 'object' ? s : null
}

/** 清掉保存的会话（换账号时用）。 */
export function clearBreezeSession() {
  try { writeJson(sessionFile(), {}) } catch (error) {}
}

/**
 * 查余额：不抛异常，出错用 note 说清楚（面板要显示「后端在线 / 额度 N」）。
 * @returns {Promise<{ok:boolean, hasKey:boolean, balance:number|null, note:string}>}
 */
export async function breezeBalance(c = {}) {
  const key = String(c.key || '').trim()
  if (!key) return { ok: false, hasKey: false, balance: null, note: '没填 API Key' }
  try {
    const r = await fetch(`${baseOf(c)}/v1/balance`, {
      headers: { 'xi-api-key': key, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutOf(c)),
    })
    if (r.status === 401) return { ok: false, hasKey: true, balance: null, note: 'API Key 不对或已撤销' }
    if (!r.ok) return { ok: false, hasKey: true, balance: null, note: `HTTP ${r.status}` }
    const j = await r.json().catch(() => ({}))
    const raw = j.balance ?? j.credits ?? j.remaining ?? j?.data?.balance ?? j?.data?.credits
    const n = Number(raw)
    return { ok: true, hasKey: true, balance: Number.isFinite(n) ? n : null, note: '' }
  } catch (error) {
    return { ok: false, hasKey: true, balance: null, note: `连不上：${error.message}` }
  }
}

/**
 * 列出云端音色（面板「列出音色」按钮用）。
 * GET {url}/v1/voices + xi-api-key。
 * @returns {Promise<{ok:boolean, voices?:Array<{id:string,name:string,origin:string,desc:string,preview:string}>, message?:string}>}
 */
export async function breezeVoices(c = {}) {
  const key = String(c.key || '').trim()
  if (!key) return { ok: false, message: '还没填 API Key' }
  try {
    const r = await fetch(`${baseOf(c)}/v1/voices`, {
      headers: { 'xi-api-key': key, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutOf(c)),
    })
    if (r.status === 401) return { ok: false, message: 'API Key 不对或已撤销' }
    if (!r.ok) return { ok: false, message: `Breeze 返回 HTTP ${r.status}` }
    const j = await r.json().catch(() => ({}))
    const raw = j.voices || j.data || j.items || (Array.isArray(j) ? j : [])
    const voices = raw
      .map((v) => ({
        id: String(v?.voice_id || v?.voiceId || v?.id || ''),
        name: String(v?.name || v?.title || ''),
        origin: String(v?.origin || v?.voice_type || ''),
        desc: String(v?.description || '').slice(0, 80),
        preview: String(v?.preview_url || ''),
      }))
      .filter((v) => v.id)
    return { ok: true, voices }
  } catch (error) {
    return { ok: false, message: `连不上 Breeze：${error.message}` }
  }
}
/** 登录：邮箱密码换会话 Cookie，存盘。 */
export async function breezeLogin(c = {}, { log } = {}) {
  const email = String(c.email || '').trim()
  const password = String(c.password || '')
  if (!email || !password) throw new Error('没填 Breeze 账号（邮箱 / 密码）')
  const r = await siteRequest(`${siteOf(c)}/api/auth/email/continue`, {
    method: 'POST',
    headers: siteHeaders(c, { 'content-type': 'application/json' }),
    body: { email, password },
    timeoutMs: timeoutOf(c),
  })
  if (r.status !== 200) {
    const detail = (r.json?.detail || r.text || '').slice(0, 120)
    const hint = r.status === 403 ? '（Origin 被拒）' : r.status === 422 ? '（密码不对，或新账号要求至少 8 位）' : ''
    throw new Error(`Breeze 登录失败 HTTP ${r.status}${hint}：${detail}`)
  }
  if (!r.cookies.length) throw new Error('Breeze 登录没拿到会话 Cookie')
  const cookie = r.cookies.join('; ')
  writeJson(sessionFile(), { cookie, email, loginAt: Date.now() })
  log?.info?.('Breeze 已登录，额度领取就绪')
  return cookie
}

/**
 * 领今天的额度。Cookie 失效会重登一次；discord 档被拒自动降级 standard。
 * @returns {Promise<{ok:boolean, tier:string, reward:number|null, message:string}>}
 */
export async function breezeClaim(c = {}, { log, tier = 'discord' } = {}) {
  const email = String(c.email || '').trim()
  if (!email || !c.password) throw new Error('没填 Breeze 账号（邮箱 / 密码）')
  let session = breezeSession()
  const send = async (which) => {
    if (!session?.cookie) session = { ...(session || {}), cookie: await breezeLogin(c, { log }) }
    return siteRequest(`${siteOf(c)}/api/credits/daily-claim`, {
      method: 'POST',
      headers: siteHeaders(c, { 'content-type': 'application/json', cookie: session.cookie }),
      body: { reward_tier: which },
      timeoutMs: timeoutOf(c),
    })
  }
  let used = tier
  let out = await send(used)
  const statusOf = (x) => x.status
  if (statusOf(out) === 401) {
    // 会话过期：重登一次再试
    session = { ...(session || {}), cookie: await breezeLogin(c, { log }) }
    out = await send(used)
  }
  const already = (x) => x.status === 409 || x.json?.already_claimed === true || /already|claimed/i.test(String(x.text || ''))
  // discord 档要绑 Discord：失败且不是「今天领过了」就降级 standard（+100）
  if (out.status !== 200 && used !== 'standard' && !already(out)) {
    used = 'standard'
    out = await send(used)
  }
  const { status, json: j, text } = out
  const ok = status === 200 || already(out)
  if (!ok) throw new Error(`Breeze 领取额度失败 HTTP ${status}：${String(text || JSON.stringify(j)).slice(0, 140)}`)
  const reward = Number(j.credits_issued ?? j.reward ?? j.amount ?? j?.data?.reward ?? j?.data?.amount)
  const balance = Number(j.balance ?? j?.data?.balance)
  writeJson(sessionFile(), { ...(session || {}), email, lastClaimAt: Date.now(), lastTier: used })
  const msg = j.claimed === true
    ? `领到 ${Number.isFinite(reward) ? reward : '?'} 额度` + (Number.isFinite(balance) ? `，当前 ${balance}` : '')
    : already(out)
      ? '今天已经领过了' + (Number.isFinite(balance) ? `（当前 ${balance}）` : '')
      : (j.message || j.note || '领完了')
  log?.info?.(`Breeze 领取额度（${used}）：${msg}`)
  return {
    ok: true,
    already: already(out),
    tier: used,
    reward: Number.isFinite(reward) ? reward : null,
    balance: Number.isFinite(balance) ? balance : null,
    message: msg,
  }
}

/** 到点该不该自动领：开了自动领取、选了 Breeze、填了账号、距离上次够久。 */
export function shouldAutoClaim(c = {}, now = Date.now()) {
  const b = c.voice?.breeze || {}
  if (c.voice?.engine !== 'breeze') return false
  if (b.mode === 'local') return false // 本地自建不走额度
  if (!b.autoClaim) return false
  if (!String(b.email || '').trim() || !b.password) return false
  const last = Number(breezeSession()?.lastClaimAt) || 0
  return now - last >= CLAIM_GAP_MS
}

/** 一次自动领取：失败只记日志，不抛（定时任务里用）。 */
export async function autoClaimOnce(c = {}, { log } = {}) {
  if (!shouldAutoClaim(c)) return { ok: false, skipped: true }
  try {
    const r = await breezeClaim(c.voice.breeze, { log })
    return { ok: true, ...r }
  } catch (error) {
    log?.warn?.(`Breeze 自动领取额度失败：${error.message}`)
    return { ok: false, message: error.message }
  }
}

export const BREEZE_CLAIM_GAP_MS = CLAIM_GAP_MS
export const BREEZE_DAY_MS = DAY_MS
