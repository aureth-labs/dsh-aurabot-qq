// B 站扫码登录：自己起一个独立的 headless Chrome，打开 passport 登录页，把二维码交给面板；
// 主人用手机 B 站 App 扫完确认后，从 CDP 里取出属于这台机器人的票（SESSDATA / bili_jct / 三个设备指纹）。
//
// 全程不打印任何 cookie 值，只打状态和公开的 mid。每个会话一个临时 profile，结束就删干净。

import { spawn } from 'node:child_process'
import { accessSync, constants, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { buildBiliCookie } from '../core/config.js'

const TTL_MS = 180_000
const LOGIN_URL = 'https://passport.bilibili.com/login'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36'
const PROFILE_LOCKS = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const isExecutable = (p) => {
  try { accessSync(p, constants.X_OK); return true } catch { return false }
}

/** 浏览器定位顺序：BILI_CHROME_BIN → /usr/local/bin/aur-chrome → PATH 里的 chrome-headless-shell。 */
function findChrome() {
  const fromEnv = String(process.env.BILI_CHROME_BIN || '').trim()
  if (fromEnv && isExecutable(fromEnv)) return fromEnv
  if (isExecutable('/usr/local/bin/aur-chrome')) return '/usr/local/bin/aur-chrome'
  for (const dir of String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue
    const p = join(dir, 'chrome-headless-shell')
    if (isExecutable(p)) return p
  }
  return ''
}

function cleanProfile(dir) {
  for (const name of PROFILE_LOCKS) {
    try { rmSync(join(dir, name), { force: true }) } catch {}
  }
}

function removeProfile(dir) {
  if (!dir) return
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) } catch {}
}

/**
 * 整组杀掉浏览器：Chrome 是以 detached 起的，自己就是一个进程组，
 * zygote / renderer / gpu 全在这个组里，只杀父进程会把它们留成孤儿。
 */
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return
  try { process.kill(-child.pid, 'SIGKILL') } catch {}
  try { child.kill('SIGKILL') } catch {}
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 1
    this.pending = new Map()
    ws.addEventListener('message', (e) => {
      let m = null
      try { m = JSON.parse(String(e.data)) } catch { return }
      if (!m || !m.id || !this.pending.has(m.id)) return
      const { resolve, reject } = this.pending.get(m.id)
      this.pending.delete(m.id)
      m.error ? reject(new Error(m.error.message)) : resolve(m.result)
    })
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      ws.addEventListener('open', () => resolve(new Cdp(ws)), { once: true })
      ws.addEventListener('error', () => reject(new Error('连不上浏览器调试端口')), { once: true })
    })
  }

  send(method, params = {}) {
    const id = this.id++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        reject(new Error(method + ' timeout'))
      }, 20_000).unref?.()
    })
  }

  close() {
    try { this.ws.close() } catch {}
    this.pending.clear()
  }
}

function decodeDataUrl(src) {
  const m = /^data:image\/png;base64,(.+)$/.exec(String(src || ''))
  return m ? Buffer.from(m[1], 'base64') : null
}

/** 登录成功判据：拿到 SESSDATA，再用 nav 确认这个号真的是登录状态。不打印任何令牌。 */
async function verifyNav(creds) {
  try {
    const cookie = buildBiliCookie(creds)
    const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie },
      signal: AbortSignal.timeout(15_000),
    })
    const j = await r.json().catch(() => ({}))
    if (j.code !== 0 || !j.data?.isLogin) return null
    return { mid: j.data.mid ?? null, uname: j.data.uname || '' }
  } catch {
    return null
  }
}

/**
 * 扫码登录会话管理器。
 * @param {{ log?: any, dataDir: (...parts: string[]) => string }} options
 */
export function createQrLogin({ log, dataDir } = {}) {
  const sessions = new Map()
  const note = (level, msg) => {
    try { (log?.[level] || log?.info || (() => {}))(msg) } catch {}
  }

  const killChild = (session) => {
    const child = session.child
    session.child = null
    if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve()
    return new Promise((resolve) => {
      // SIGKILL 通常立刻退；3 秒还没退就不等了，别把调用方卡住
      const timer = setTimeout(() => resolve(), 3_000)
      timer.unref?.()
      child.once('exit', () => { clearTimeout(timer); resolve() })
      killTree(child)
    })
  }

  const closeBrowser = async (session) => {
    if (session.cdp) { session.cdp.close(); session.cdp = null }
    await killChild(session)
    removeProfile(session.dir)
    session.dir = ''
  }

  // 宿主进程退出时兜底：不留孤儿 chrome，也不留临时 profile
  const onExit = () => {
    for (const session of sessions.values()) {
      killTree(session.child)
      if (session.dir) removeProfile(session.dir)
    }
  }
  process.once('exit', onExit)

  function prune() {
    const now = Date.now()
    for (const [id, s] of sessions) {
      if ((s.state === 'done' || s.state === 'expired' || s.state === 'error') && now - (s.endedAt || now) > 10 * 60_000) sessions.delete(id)
    }
  }

  async function readPort(session) {
    const file = join(session.dir, 'DevToolsActivePort')
    const end = Date.now() + 25_000
    while (Date.now() < end) {
      if (session.child && session.child.exitCode !== null) throw new Error('浏览器进程提前退出了')
      try {
        const first = readFileSync(file, 'utf8').trim().split('\n')[0]
        if (first) return Number(first)
      } catch {}
      await sleep(150)
    }
    throw new Error('浏览器没起来（等不到调试端口）')
  }

  async function connectTarget(session, port) {
    const end = Date.now() + 15_000
    while (Date.now() < end) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/list`)
        if (r.ok) {
          const target = (await r.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
          if (target) return await Cdp.connect(target.webSocketDebuggerUrl)
        }
      } catch {}
      await sleep(200)
    }
    throw new Error('浏览器没有可用的页面')
  }

  async function waitQr(session) {
    const expression = `(() => { const i=[...document.querySelectorAll('img')].find(x=>x.src.startsWith('data:image/png')&&x.getBoundingClientRect().width>50); return i?i.src:''; })()`
    const end = Date.now() + 20_000
    while (Date.now() < end) {
      try {
        const r = await session.cdp.send('Runtime.evaluate', { expression, returnByValue: true })
        const buf = decodeDataUrl(r?.result?.value)
        if (buf && buf.length > 0) return buf.toString('base64')
      } catch {}
      await sleep(250)
    }
    return ''
  }

  async function start() {
    prune()
    // 同一时刻只留一个会话：已有活着（还没结束）的先取消
    for (const s of [...sessions.values()]) {
      if (s.state === 'starting' || s.state === 'waiting') await cancel(s.id)
    }
    const id = randomUUID().replace(/-/g, '').slice(0, 16)
    const session = {
      id, state: 'starting', expiresAt: Date.now() + TTL_MS, png: '', account: null, creds: null,
      message: '', saved: false, dir: '', child: null, cdp: null, checking: null, endedAt: 0,
    }
    sessions.set(id, session)

    const bin = findChrome()
    if (!bin) {
      session.state = 'error'
      session.message = '没找到 chrome-headless-shell，扫码登录不可用'
      session.endedAt = Date.now()
      note('warn', '扫码登录：' + session.message)
      return { id, png: '', expiresAt: session.expiresAt, message: session.message }
    }

    try {
      session.dir = dataDir('tmp/qr-' + id)
      mkdirSync(session.dir, { recursive: true })
      cleanProfile(session.dir)
      session.child = spawn(bin, [
        '--remote-debugging-port=0',
        `--user-data-dir=${session.dir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--window-size=1280,900',
        LOGIN_URL,
      ], { stdio: ['ignore', 'ignore', 'ignore'], detached: process.platform !== 'win32' })
      session.child.on('error', () => {})
      // 浏览器自己退了（崩溃 / 被外部杀掉）：立刻标记失败并清掉 profile，别让 poll 一直干等到 TTL。
      // 正常收尾（取消 / 过期 / 成功）时由 closeBrowser 负责，state 已经不是这两个了。
      session.child.on('exit', () => {
        if (session.state !== 'starting' && session.state !== 'waiting') return
        session.state = 'error'
        session.message = '浏览器提前退出了，重新生成一个'
        session.endedAt = Date.now()
        if (session.cdp) { session.cdp.close(); session.cdp = null }
        removeProfile(session.dir)
        session.dir = ''
        note('warn', '扫码登录：' + session.message)
      })

      const port = await readPort(session)
      session.cdp = await connectTarget(session, port)
      await session.cdp.send('Page.enable')
      await session.cdp.send('Network.enable')
      const png = await waitQr(session)
      if (!png) throw new Error('二维码没出来，稍后再试')
      // 出码期间用户可能已经关掉浮层（cancel 了），别再把它当成活会话
      if (sessions.get(id) !== session) {
        session.state = 'cancelled'
        await closeBrowser(session)
        return { id, png: '', expiresAt: session.expiresAt, message: '会话已取消' }
      }
      session.png = png
      session.state = 'waiting'
      note('info', '扫码登录：已出码')
      return { id, png, expiresAt: session.expiresAt }
    } catch (error) {
      session.state = 'error'
      session.message = String(error?.message || error || '扫码登录准备失败')
      session.endedAt = Date.now()
      note('warn', '扫码登录准备失败：' + session.message)
      await closeBrowser(session)
      return { id, png: '', expiresAt: session.expiresAt, message: session.message }
    }
  }

  function donePayload(session) {
    return { state: 'done', account: session.account, creds: session.creds, message: '' }
  }

  async function expire(session) {
    session.state = 'expired'
    session.message = '二维码过期了，重新生成一个'
    session.endedAt = Date.now()
    await closeBrowser(session)
  }

  async function checkCookies(session) {
    const r = await session.cdp.send('Network.getAllCookies')
    const all = r?.cookies || []
    const get = (name) => all.find((c) => c.name === name && String(c.domain || '').includes('bilibili.com'))?.value || ''
    const sessdata = get('SESSDATA')
    if (!sessdata) return
    const creds = {
      sessdata,
      biliJct: get('bili_jct'),
      buvid3: get('buvid3'),
      buvid4: get('buvid4'),
      dedeUserId: get('DedeUserID'),
    }
    const nav = await verifyNav(creds)
    if (!nav) return
    session.creds = creds
    session.account = { mid: nav.mid, uname: nav.uname }
    session.state = 'done'
    session.endedAt = Date.now()
    note('info', `扫码登录成功 mid=${nav.mid ?? ''}`)
    // 票已经拿到，浏览器立刻收掉，别让一个登录着的浏览器挂着
    await closeBrowser(session)
  }

  async function poll(id) {
    const session = sessions.get(String(id || ''))
    if (!session) return { state: 'expired', message: '会话已经结束了，重新生成一个' }
    if (session.state === 'done') return donePayload(session)
    if (session.state === 'error') return { state: 'error', message: session.message }
    if (session.state === 'expired') return { state: 'expired', message: session.message }
    if (Date.now() > session.expiresAt) {
      await expire(session)
      return { state: 'expired', message: session.message }
    }
    if (session.state === 'waiting' && session.cdp) {
      session.checking ||= checkCookies(session).catch(() => {}).finally(() => { session.checking = null })
      await session.checking
      if (session.state === 'done') return donePayload(session)
    }
    return { state: 'waiting' }
  }

  async function cancel(id) {
    const session = sessions.get(String(id || ''))
    if (!session) return { ok: true }
    sessions.delete(session.id)
    session.state = 'cancelled' // 先标掉，否则 exit 监听会把这次主动收尾当成「浏览器崩了」
    await closeBrowser(session)
    return { ok: true }
  }

  async function dispose() {
    process.removeListener('exit', onExit)
    for (const id of [...sessions.keys()]) await cancel(id)
  }

  return { start, poll, cancel, dispose }
}
