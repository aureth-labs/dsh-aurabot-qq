// 内置模块：生视频。三种接口，面板里选：
//   ① local  —— 本地接口的 video 脚本（ComfyUI 等，默认，行为与以前一致）
//   ② minimax —— MiniMax H3 云端异步任务（创建 → 轮询 → 下载）
//   ③ custom —— 自定义异步任务接口：创建 / 轮询 / 状态字段 / 结果字段都能填
// 通用能力（三种接口都生效）：生成前确认、提示词扩写、生成后抽帧自检。
//
// 生视频很慢，不能让这一轮一直等：工具马上返回，后台做完再发。

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dataDir } from '../../core/store.js'
import { fetchGuarded } from '../../core/net.js'
import { findFfmpeg } from '../../core/img.js'
import { askModel, canSeeImages } from '../../core/llm.js'
import { privateCapabilityAllowed } from '../../chat/access.js'
import { defineTool, str } from '../../tools/tools.js'

/** 脚本的返回值统一成文件路径：字符串或 { file }。 */
export const videoFile = (r) => String(typeof r === 'string' ? r : r?.file || '').trim()

export const MINIMAX_MODELS = ['MiniMax-H3', 'MiniMax-H3-Highspeed', 'MiniMax-H3-Lite', 'MiniMax-H3-Max']
export const RESOLUTIONS = ['480P', '768P', '2K']
export const RATIOS = ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9', 'adaptive']
const CONFIRM_RE = /^(确认|确定|可以|行|好|好的|开始|生成|生成吧|确认生成|就这个|没问题|ok|OK)$/
const CANCEL_RE = /^(取消|算了|不用了|先不要|别生成|不生成|等等|不要)$/
const TTL_MS = 15 * 60_000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 模板里的 {xxx} 换成 URL 编码后的值；不认识的占位符原样保留。 */
export function fillUrl(tpl, vars) {
  return String(tpl ?? '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : encodeURIComponent(String(vars[k]))))
}

/** 模板里的 {xxx} 换成 JSON 转义后的值（不带引号），prompt 里有引号/换行也不会把 JSON 打散。 */
export function fillJson(tpl, vars) {
  return String(tpl ?? '').replace(/\{(\w+)\}/g, (m, k) => {
    if (vars[k] === undefined || vars[k] === null) return m
    const s = JSON.stringify(String(vars[k]))
    return s.slice(1, -1)
  })
}

/** 按 "task.content.url" 这种路径取值。 */
export function dotted(obj, path) {
  let cur = obj
  for (const k of String(path || '').split('.').map((s) => s.trim()).filter(Boolean)) {
    if (cur === null || cur === undefined) return null
    cur = cur[k]
  }
  return cur ?? null
}

/** 请求头文本 → 对象：一行一个「Key: Value」。 */
export function parseHeaders(text) {
  const out = {}
  for (const line of String(text || '').split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const i = s.indexOf(':')
    if (i > 0) out[s.slice(0, i).trim()] = s.slice(i + 1).trim()
  }
  return out
}

/** 分辨率要跟模型匹配：只有 H3 支持 2K。 */
export function clampResolution(model, resolution) {
  const m = MINIMAX_MODELS.includes(model) ? model : 'MiniMax-H3'
  const r = RESOLUTIONS.includes(resolution) ? resolution : '768P'
  if (m !== 'MiniMax-H3' && r === '2K') return '768P'
  return r
}

/** MiniMax 请求体（纯函数，方便单测）。 */
export function minimaxBody({ prompt, seconds, image, cfg }) {
  const m = cfg.video?.minimax || {}
  const model = MINIMAX_MODELS.includes(m.model) ? m.model : 'MiniMax-H3'
  const minDur = model === 'MiniMax-H3-Max' ? 5 : 4
  const duration = Math.max(minDur, Math.min(15, Math.round(Number(seconds) || Number(m.duration) || 5)))
  // 文生视频必须有具体比例（不能 adaptive）；带首帧时由服务端按图片自适应
  const ratio = image ? 'adaptive' : (RATIOS.includes(m.ratio) && m.ratio !== 'adaptive' ? m.ratio : '16:9')
  const content = [{ type: 'text', text: String(prompt || '') }]
  if (image) content.push({ type: 'image_url', image_url: { url: image }, role: 'first_frame' })
  return { model, content, resolution: clampResolution(model, m.resolution), duration, ratio }
}

/** 自定义接口的请求拼装（纯函数，方便单测）。 */
export function customRequestParts({ prompt, seconds, image, cfg, taskId = '' }) {
  const c = cfg.video?.custom || {}
  const vars = { prompt: String(prompt || ''), seconds: seconds ?? '', image: image || '', reqid: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), taskId }
  const method = String(c.createMethod || 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST'
  return {
    method,
    createUrl: fillUrl(c.createUrl, vars),
    queryUrl: fillUrl(c.queryUrl, { ...vars, taskId }),
    headers: parseHeaders(c.headers),
    body: method === 'POST' ? fillJson(c.body || '{"prompt":"{prompt}"}', vars) : '',
  }
}

/** 这个接口现在能不能用（没配好就不挂工具）。 */
export function videoReady(cfg, local) {
  const v = cfg.video || {}
  if ((v.provider || 'local') === 'local') return Boolean(local?.active?.('video'))
  if (v.provider === 'minimax') return Boolean(String(v.minimax?.apiKey || '').trim())
  if (v.provider === 'custom') return Boolean(String(v.custom?.createUrl || '').trim() && String(v.custom?.queryUrl || '').trim())
  return false
}

/** 参考图：URL / data URI / 本机绝对路径 → 可直接放进请求的值。 */
function resolveImage(image) {
  const s = String(image || '').trim()
  if (!s) return ''
  if (/^https?:\/\//i.test(s) || /^data:/i.test(s)) return s
  if (isAbsolute(s) && existsSync(s)) {
    const ext = extname(s).toLowerCase().replace('.', '')
    const mime = ext === 'png' ? 'png' : ext === 'webp' ? 'webp' : ext === 'gif' ? 'gif' : 'jpeg'
    return `data:image/${mime};base64,${readFileSync(s).toString('base64')}`
  }
  throw new Error('参考图要是公网地址、data URI，或本机的绝对路径')
}

/** 落盘：文件名只留安全字符（避免远端 taskId 里带 ../ 或 :）。 */
function saveVideo(buf, name) {
  const dir = dataDir('video-out')
  mkdirSync(dir, { recursive: true })
  const safe = String(name || 'video').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'video'
  const file = join(dir, `${safe}.mp4`)
  writeFileSync(file, buf)
  return file
}

const looksLikeMp4 = (buf) => buf.length > 12 && buf.toString('ascii', 4, 8) === 'ftyp'

async function download(url, timeoutMs = 180_000) {
  const r = await fetchGuarded(url, { timeoutMs })
  if (!r.ok) throw new Error(`下载视频失败 HTTP ${r.status}`)
  const type = String(r.headers.get('content-type') || '')
  if (type && !/video|octet-stream|mp4/i.test(type)) throw new Error('下载到的不是视频（' + type + '）')
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length < 10_000) throw new Error('下载到的视频太小：' + buf.length)
  if (!looksLikeMp4(buf)) throw new Error('下载到的文件不像 mp4（可能被网关拦了）')
  return buf
}

/** 普通 JSON 请求（创建/轮询用；不经过 SSRF 闸，兼容自建局域网接口）。 */
async function requestJson(url, { label = '请求', method = 'GET', headers = {}, body, timeoutMs = 60_000, retry = false } = {}) {
  const attempts = retry ? 3 : 1
  let lastError = null
  for (let i = 1; i <= attempts; i++) {
    const r = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) })
    const raw = await r.text().catch(() => '')
    let json = null
    try { json = JSON.parse(raw) } catch (error) {}
    // 轮询期间偶发 429/5xx 不要判死整个任务，退避后重试
    if (retry && (r.status === 429 || r.status >= 500) && i < attempts) {
      lastError = new Error(`${label}失败 HTTP ${r.status}：${raw.slice(0, 120)}`)
      await sleep(1500 * i)
      continue
    }
    if (!r.ok) throw new Error(`${label}失败 HTTP ${r.status}：${(json && JSON.stringify(json).slice(0, 160)) || raw.slice(0, 160)}`)
    if (!json) throw new Error(`${label}返回不是 JSON：${raw.slice(0, 160)}`)
    return json
  }
  throw lastError || new Error(`${label}失败`)
}

/** MiniMax H3：/v2/video_generation 创建，/v2/query/video_generation/{id} 轮询。 */
async function minimaxGenerate({ prompt, seconds, image, cfg, log, timeoutMs }) {
  const m = cfg.video?.minimax || {}
  const key = String(m.apiKey || '').trim()
  if (!key) throw new Error('没填 MiniMax API Key')
  const base = String(m.baseUrl || 'https://api.minimax.cn').replace(/\/+$/, '')
  const ref = image ? resolveImage(image) : ''
  const body = minimaxBody({ prompt, seconds, image: ref, cfg })

  log?.info?.(`MiniMax ${body.model} ${body.resolution} ${body.duration}s ${body.ratio}${ref ? ' +首帧' : ''}，提交任务…`)
  const created = await requestJson(base + '/v2/video_generation', {
    label: '创建任务',
    method: 'POST',
    headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const taskId = created?.task_id
  if (!taskId) throw new Error('没拿到 task_id：' + JSON.stringify(created).slice(0, 200))

  const started = Date.now()
  const pollMs = Math.max(1000, Math.min(60_000, Number(m.pollMs) || 5000))
  for (;;) {
    await sleep(pollMs)
    const q = await requestJson(`${base}/v2/query/video_generation/${encodeURIComponent(taskId)}`, {
      label: '查询任务',
      retry: true,
      headers: { authorization: 'Bearer ' + key },
      timeoutMs: 30_000,
    })
    const task = q?.task || q
    if (task?.status === 'succeeded') {
      const url = task?.content?.url
      if (!url) throw new Error('任务成功但没有视频地址')
      return saveVideo(await download(url), 'minimax-' + taskId)
    }
    if (task?.status === 'failed' || task?.status === 'cancelled') {
      throw new Error(`生成失败（${task.status}）：${task?.error?.message || task?.error?.code || '未知原因'}`)
    }
    if (Date.now() - started > timeoutMs) throw new Error(`等太久还没好，任务 ${taskId} 可以稍后用接口查`)
    log?.info?.(`生成中（${task?.status || '排队'}），已等 ${Math.round((Date.now() - started) / 1000)} 秒`)
  }
}

/** 自定义异步任务接口：创建 → 轮询 → 下载，字段全部可配。 */
async function customGenerate({ prompt, seconds, image, cfg, log, timeoutMs }) {
  const c = cfg.video?.custom || {}
  if (!String(c.createUrl || '').trim() || !String(c.queryUrl || '').trim()) throw new Error('还没填创建地址 / 轮询地址')
  const ref = image ? resolveImage(image) : ''
  const parts = customRequestParts({ prompt, seconds, image: ref, cfg })

  log?.info?.('提交自定义视频任务…')
  const created = await requestJson(parts.createUrl, {
    label: '创建任务',
    method: parts.method,
    headers: { 'content-type': 'application/json', ...parts.headers },
    body: parts.method === 'POST' ? parts.body : undefined,
  })
  const taskId = dotted(created, c.taskIdPath || 'task_id')
  if (!taskId) throw new Error('没取到任务 ID（检查「任务 ID 路径」）：' + JSON.stringify(created).slice(0, 200))

  const started = Date.now()
  const pollMs = Math.max(1000, Math.min(60_000, Number(c.pollMs) || 5000))
  const okValue = String(c.successValue || 'succeeded')
  const failValues = String(c.failValue || 'failed,cancelled').split(',').map((s) => s.trim()).filter(Boolean)

  for (;;) {
    await sleep(pollMs)
    const qUrl = fillUrl(c.queryUrl, { taskId, reqid: '' })
    const json = await requestJson(qUrl, { label: '查询任务', headers: parts.headers, timeoutMs: 30_000, retry: true })
    const status = String(dotted(json, c.statusPath || 'status') || '')
    if (status === okValue) {
      const outUrl = dotted(json, c.urlPath || 'content.url')
      if (!outUrl) throw new Error('任务成功但没有取到视频地址（检查「结果地址路径」）')
      return saveVideo(await download(outUrl), 'custom-' + String(taskId))
    }
    if (failValues.includes(status)) throw new Error(`生成失败（${status}）：${JSON.stringify(json).slice(0, 200)}`)
    if (Date.now() - started > timeoutMs) throw new Error(`等太久还没好（任务 ${taskId}）`)
    log?.info?.(`生成中（${status || '未知状态'}），已等 ${Math.round((Date.now() - started) / 1000)} 秒`)
  }
}

/** 从本地 mp4 抽一帧（JPEG）；失败返回 null。 */
function grabFrame(ffmpeg, file, at) {
  return new Promise((resolve) => {
    let settled = false
    const chunks = []
    let timer
    const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v) } }
    let proc
    try {
      proc = spawn(ffmpeg, ['-ss', String(at), '-i', file, '-frames:v', '1', '-vf', 'scale=512:-2', '-f', 'image2', '-vcodec', 'mjpeg', 'pipe:1'], { windowsHide: true })
    } catch (error) { finish(null); return }
    timer = setTimeout(() => { try { proc.kill() } catch (error) {} finish(null) }, 20_000)
    proc.stdout.on('data', (d) => { if (chunks.reduce((n, b) => n + b.length, 0) < 2 * 1024 * 1024) chunks.push(d) })
    proc.stderr.on('data', () => {})
    proc.on('error', () => finish(null))
    proc.on('close', (code) => {
      const buf = Buffer.concat(chunks)
      finish(code === 0 && buf.length > 500 && buf[0] === 0xff && buf[1] === 0xd8 ? buf : null)
    })
  })
}

export default {
  id: 'video',
  name: '生视频',
  version: '1.1.0',
  description: '生成视频并发到聊天：本地脚本 / MiniMax / 自定义异步任务（qq_generate_video）',
  setup(api) {
    const { hub, local } = api.core
    const cfg = () => api.config()
    let running = false
    let stopped = false
    const pending = new Map() // chatId -> { args, userId, timer }
    const last = new Map() // chatId -> { at, desc, seconds }

    api.onDispose?.(() => {
      stopped = true
      for (const k of [...pending.keys()]) clearPending(k)
    })

    const v = () => cfg().video || {}
    const ready = () => videoReady(cfg(), local)
    const timeoutMs = () => Math.max(1, Number(cfg().local?.videoTimeoutMin) || 20) * 60_000

    function clearPending(chatId) {
      const p = pending.get(chatId)
      if (p?.timer) clearTimeout(p.timer)
      pending.delete(chatId)
    }

    api.context?.(({ chat }) => {
      const parts = []
      if (ready() && privateCapabilityAllowed(cfg(), chat, 'video')) parts.push('当前私聊对象已经获得主人的视频生成授权。对方请求生成视频时可以使用 qq_generate_video，以当前授权为准。')
      const mine = last.get(String(chat?.chatId || ''))
      if (mine && Date.now() - mine.at < 30 * 60_000) {
        parts.push(`你刚在这里做了一段 ${mine.seconds} 秒的视频，你抽帧看过画面：${mine.desc}\n（这是你自己的记忆，聊到相关话题可以自然地提，别假装没看过，也别逐字复述。）`)
      }
      return parts.join('\n')
    })

    async function deliver(chatId, file) {
      try {
        await hub.sendSegments(chatId, [{ type: 'video', data: { file: pathToFileURL(file).href } }], '[视频]', { throwOnError: true, timeoutMs: 120_000 })
      } catch (error) {
        api.log.warn('按视频发送失败，改发文件：', error.message)
        await hub.sendFile(chatId, file)
      }
    }

    /** 生成后抽 4 帧交给视觉模型，写一段「画面里有什么」。失败返回空，不影响发送。 */
    async function selfView(file, prompt, seconds) {
      if (v().selfView === false) return ''
      try {
        if (canSeeImages && (await canSeeImages(api.dsh, cfg())) === false) { api.log.debug('当前模型看不了图，跳过自检'); return '' }
        const ffmpeg = findFfmpeg(cfg().bili?.ffmpegPath || '')
        if (!ffmpeg) { api.log.debug('没找到 ffmpeg，跳过抽帧'); return '' }
        const d = Math.max(4, Math.round(Number(seconds) || 5))
        const frames = []
        for (const p of [0.2, 0.4, 0.6, 0.8]) {
          const f = await grabFrame(ffmpeg, file, Math.max(0, Math.round(d * p * 10) / 10))
          if (f) frames.push(f)
        }
        if (!frames.length) return ''
        const out = await askModel(api.dsh, {
          module: 'video-selfview',
          cfg: cfg(),
          system: '你在看自己刚生成的一段视频的截图。只写画面上确实能看到的东西：场景、主体、动作、光线、色调、画面里的文字。不要猜剧情，不要编造。用 2~4 句中文写。',
          text: `这些截图来自你刚才按这个描述做的视频（${d} 秒）：${prompt}\n按时间先后排列。如实记下你看到了什么。`,
          images: frames.map((f) => ({ data: f.toString('base64'), mediaType: 'image/jpeg' })),
          maxTokens: 500,
          temperature: 0.3,
        })
        return String(out || '').trim()
      } catch (error) {
        api.log.warn('视频自检失败（不影响发送）：', error.message)
        return ''
      }
    }

    /** 把一句话场景扩写成可直接喂视频模型的分镜提示词；失败用原文。 */
    async function enhance(text) {
      if (v().enhance === false) return text
      try {
        const out = await api.ask({
          system: '你是视频分镜师。把用户的一句话场景扩写成一段可直接用于文生视频模型的提示词：镜头运动、主体外形与动作、环境与光线、色调与质感，按时间顺序描述，只输出提示词本身，不要解释、不要分点。中文，120 字以内。',
          text,
          maxTokens: 400,
        })
        const s = String(out || '').trim()
        return s.length >= 20 ? s.slice(0, 900) : text
      } catch (error) {
        api.log.debug('提示词扩写失败，用原文：', error.message)
        return text
      }
    }

    async function produce(args) {
      const provider = v().provider || 'local'
      if (provider === 'minimax') return minimaxGenerate({ ...args, cfg: cfg(), log: api.log, timeoutMs: timeoutMs() })
      if (provider === 'custom') return customGenerate({ ...args, cfg: cfg(), log: api.log, timeoutMs: timeoutMs() })
      return videoFile(await local.call('video', { prompt: args.prompt, seconds: args.seconds, image: args.image }))
    }

    async function generate(chatId, args) {
      running = true
      try {
        if (v().confirm !== false) await hub.sendText(chatId, '好，开始生成，可能要等一阵子…').catch(() => {})
        const file = await produce(args)
        if (stopped) return
        if (!file) throw new Error('没拿到视频文件')
        await deliver(chatId, file)
        // 先发出去，再自检：视觉调用慢，不该拦住视频送达
        const desc = await selfView(file, args.prompt, args.seconds)
        if (desc) last.set(String(chatId), { at: Date.now(), desc, seconds: args.seconds || 5 })
      } catch (error) {
        if (!stopped) await hub.sendText(chatId, `视频没做成：${String(error.message || error).slice(0, 200)}`).catch(() => {})
      } finally {
        running = false
      }
    }

    api.rule(() => (ready()
      ? [
        '- 你能用 qq_generate_video 生成视频，主人和已授权的私聊对象可以使用。生成本身很慢，开始前先告诉对方要等多久；做好会自动发出来，不用再发一次。',
        v().confirm === false ? '' : '- 生成前系统会先把视频描述发给对方确认，对方回「确认」才会真的生成；不要自己连续调用两次。',
        '- 对方给了参考图时，把图片地址或本机绝对路径放进 image 参数，会作为首帧。',
      ].filter(Boolean)
      : []))

    api.tool(({ chat, sessionId }) => (ready() && chat.kind !== 'system' ? defineTool({
      name: 'qq_generate_video',
      description: '生成一段视频，做好后自动发到当前聊天。很慢，开始前先告诉对方要等。主人和已授权的私聊对象可以使用。',
      properties: {
        prompt: str('视频内容描述（场景、镜头、主体、光线、风格）'),
        seconds: str('可选：时长（秒），4~15'),
        image: str('可选：首帧参考图（公网地址或本机绝对路径）'),
      },
      required: ['prompt'],
      execute: async ({ prompt, seconds, image }) => {
        if (!hub.turnSendersAllOwner(sessionId) && !privateCapabilityAllowed(cfg(), chat, 'video')) return { ok: false, message: '你还没有获得视频生成权限' }
        const text = String(prompt || '').trim()
        if (!text) return { ok: false, message: '要生成什么内容？' }
        if (running || pending.has(chat.chatId)) return { ok: false, message: '上一段视频还在生成，等它好了再说' }

        const args = { prompt: await enhance(text), seconds: Math.max(4, Math.min(15, Math.round(Number(seconds) || 5))), image: image ? String(image) : '' }
        if (v().confirm === false) {
          generate(chat.chatId, args).catch(() => {})
          return { ok: true, message: '开始生成了，做好会自动发到这里。告诉对方要等一阵子，这一轮不用再发视频。' }
        }

        clearPending(chat.chatId)
        const timer = setTimeout(() => clearPending(chat.chatId), TTL_MS)
        pending.set(chat.chatId, { args, userId: String(chat.userId || ''), timer })
        await hub.sendText(chat.chatId, ['要按这段生成视频吗？', '', args.prompt, '', `（${args.seconds} 秒${args.image ? '，带首帧图' : ''}，回复「确认」开始，回复「取消」就算了）`].join('\n')).catch(() => {})
        return { ok: true, message: '已经把视频描述发出去等确认了；这一轮不要再发一次，等对方回「确认」' }
      },
    }) : []))

    // 回「确认 / 取消」时才继续：主人，或者发起这次请求的那个人
    api.on?.('message', async (msg) => {
      const chatId = msg?.chatId
      if (!chatId || !pending.has(chatId)) return false
      const item = pending.get(chatId)
      const mine = String(msg.userId || '') === item.userId
      if (!mine && !api.isOwner?.(msg.userId) && !hub.turnSendersAllOwner?.(msg.sessionId)) return false
      const text = String(msg.text || '').trim()
      if (CANCEL_RE.test(text)) {
        clearPending(chatId)
        await hub.sendText(chatId, '好，那不生成啦').catch(() => {})
        return true
      }
      if (!CONFIRM_RE.test(text)) return false
      clearPending(chatId)
      generate(chatId, item.args).catch(() => {})
      return true
    })
  },
}
