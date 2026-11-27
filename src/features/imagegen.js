// 生图：OpenAI 兼容、自定义接口，以及实验性 Codex 订阅接法。
//   ① openai —— 兼容 OpenAI /v1/images/generations 的服务（硅基流动、通义万相兼容层、本地 ComfyUI / SD WebUI 的 OpenAI 代理……）
//   ② custom —— 自己填接口：GET / POST、URL 模板（{prompt} 占位）、自定义参数名、从返回 JSON 里按路径取图
// 地址和密钥由主人在面板里填；生成结果统一成 Buffer 交给 QQ 发出。

import { lstatSync, readFileSync } from 'node:fs'
import { fetchImage } from '../core/net.js'
import { paintingPath } from './paintings.js'
import { createCodexAuth } from './codex-auth.js'
import { createCodexImage } from './codex-image.js'
import { mimeOf } from '../chat/inbound.js'
import { drawFormat, gifError, gifSizeFor, gifFrameCount, GIF_FIELDS } from './image-format.js'
import { imageToolBlock } from '../core/img.js'
import { canSeeImages } from '../core/llm.js'
import { imageSizeFor, normalizeRequestedSize } from './image-shape.js'
export { imageToolBlock }

/** 把模板里的 {占位符} 替换掉；不认识的占位符原样留着。 */
function fill (tpl, vars) {
  return String(tpl ?? '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])))
}

/** "1024x768" → { width, height }。 */
function dimsOf (size) {
  const m = /^(\d+)\s*[x×*]\s*(\d+)$/i.exec(String(size || ''))
  return m ? { width: m[1], height: m[2] } : { width: '', height: '' }
}

// ---------------- MiniMax H3 Image ----------------
// 官方文档（2026-11）：
//   文生图 POST {base}/v1/images/generations，编辑 POST {base}/v1/images/edits
//   两张接口同一套 body：model / prompt / n(1~10) / size(WxH 或 auto) / aspect_ratio / area(1K|2K|4K) /
//   response_format(url|b64_json)；编辑额外收 images: [{ image_url: 公网 URL 或 data:image/...;base64,... }]（1~16 张）。
// 和语音共用一个 Key：生图这里没填就回落到 voice.minimax.apiKey。
export const MINIMAX_IMAGE_MODELS = ['MiniMax-H3-Image', 'MiniMax-H3-Image-Highspeed']
export const MINIMAX_IMAGE_AREAS = ['1K', '2K', '4K']

/** MiniMax 生图的 Key：优先用生图自己的，留空就用语音里那个（同一个开放平台 Key）。 */
export function minimaxImageKey (cfg) {
  const own = String(cfg?.imageGen?.minimax?.apiKey || '').trim()
  return own || String(cfg?.voice?.minimax?.apiKey || '').trim()
}

/** 尺寸 → MiniMax 允许的宽高比字符串（用于 size=auto + area 的增强模式）。 */
function minimaxRatioOf (size) {
  const m = /^(\d+)\s*[x×*]\s*(\d+)$/i.exec(String(size || ''))
  if (!m) return 'auto'
  const w = Number(m[1]); const h = Number(m[2])
  if (!w || !h) return 'auto'
  const gcd = (a, b) => (b ? gcd(b, a % b) : a)
  const d = gcd(w, h)
  let a = w / d; let b = h / d
  // 比例值限制在 1:3 ~ 3:1；极端值交给 auto 让服务端按提示词决定。
  if (a > b * 3 || b > a * 3) return 'auto'
  // 常见大分母比例归一成常用值，减少 1024x1536 → 2:3 之外的怪比例。
  const common = [[1, 1], [4, 3], [3, 4], [3, 2], [2, 3], [16, 9], [9, 16], [21, 9]]
  for (const [x, y] of common) if (Math.abs(a / b - x / y) < 0.02) return `${x}:${y}`
  return `${a}:${b}`
}

/** 小图按比例放大到 MiniMax 的下限 655,360 像素；超过上限 20,000,000 按比例缩小。 */
function minimaxSizeOf (size) {
  const m = /^(\d+)\s*[x×*]\s*(\d+)$/i.exec(String(size || ''))
  if (!m) return ''
  let w = Number(m[1]); let h = Number(m[2])
  if (!w || !h) return ''
  const area = w * h
  const MIN = 655360; const MAX = 20000000
  if (area < MIN) { const k = Math.sqrt(MIN / area); w = Math.round(w * k); h = Math.round(h * k) }
  else if (area > MAX) { const k = Math.sqrt(MAX / area); w = Math.round(w * k); h = Math.round(h * k) }
  return `${w}x${h}`
}

/**
 * MiniMax H3 Image 的请求（纯函数，方便单测）。
 * 返回 { endpoint: 'generations'|'edits', body, images: Buffer[] }。
 * enhance 默认 true：走官方提示词增强（短中文描述效果更好），用 aspect_ratio + area 控制尺寸；
 * enhance=false 时直接发 WxH，明确禁用提示词增强（此时服务只读前 4096 tokens）。
 */
export function minimaxImageBody ({ prompt, image, images = [], size, count, cfg } = {}) {
  const m = cfg?.imageGen?.minimax || {}
  const model = MINIMAX_IMAGE_MODELS.includes(m.model) ? m.model : 'MiniMax-H3-Image'
  const refs = (Array.isArray(images) && images.length ? images : image ? [image] : []).filter(Boolean)
  const n = Math.max(1, Math.min(10, Math.round(Number(count ?? m.n) || 1)))
  const area = MINIMAX_IMAGE_AREAS.includes(m.area) ? m.area : '2K'
  const areaPixels = { '1K': 1048576, '2K': 4194304, '4K': 16777216 }[area]
  // b64_json 的总面积有上限（png 20M；jpeg/webp 80M）。按更保守的 png 上限算，
  // 这样无论服务端实际输出 png 还是 jpeg，都不会因为大 n + 大图直接 400。
  const B64_AREA_LIMIT = 20000000
  const body = { model, prompt: String(prompt || ''), n }
  let outputPixels = areaPixels
  if (m.enhance === false) {
    const exact = minimaxSizeOf(size)
    if (exact) {
      body.size = exact
      body.disable_prompt_enhanced = true
      const dims = /^(\d+)x(\d+)$/.exec(exact)
      outputPixels = dims ? Number(dims[1]) * Number(dims[2]) : areaPixels
    } else {
      // 关闭提示词增强时若没有可用 size，必须给 aspect_ratio（官方要求），否则会 400。
      body.size = 'auto'
      body.aspect_ratio = minimaxRatioOf(size)
    }
  } else {
    body.size = 'auto'
    body.aspect_ratio = minimaxRatioOf(size)
    body.area = area
  }
  body.response_format = n * outputPixels > B64_AREA_LIMIT ? 'url' : 'b64_json'
  if (refs.length) body.images = refs.map((buf) => ({ image_url: `data:${mimeOf(buf)};base64,${buf.toString('base64')}` }))
  return { endpoint: refs.length ? 'edits' : 'generations', body, images: refs }
}

/** MiniMax baseUrl 归一化：允许用户按 OpenAI 习惯填 /v1，但拼接口时只能有一个版本前缀。 */
export function minimaxBaseUrl (baseUrl) {
  return String(baseUrl || 'https://api.minimax.cn').trim().replace(/\/+$/, '').replace(/\/v1$/i, '')
}

/** MiniMax 参考图校验：官方 /images/edits 不支持 GIF（JPG/JPEG/PNG/WEBP/HEIC/HEIF）。 */
function assertMinimaxReferences (refs) {
  if ((refs || []).some((buf) => String(mimeOf(buf)) === 'image/gif')) {
    throw new Error('MiniMax H3 的参考图不支持 GIF（官方只支持 JPG/PNG/WEBP/HEIC）；请换一张静态图，或先把 GIF 转成 PNG 再试')
  }
}

/** 按 "data.0.url" 这种路径取值。 */
function dotted (obj, path) {
  let cur = obj
  for (const k of String(path || '').split('.').map((s) => s.trim()).filter(Boolean)) {
    if (cur === null || cur === undefined) return null
    cur = cur[k]
  }
  return cur ?? null
}

/** 没配取值路径时，在返回的 JSON 里随便找个像图片的东西（http 地址 / data:image）。 */
function findImage (obj, depth = 0) {
  if (depth > 6 || obj === null || obj === undefined) return null
  if (typeof obj === 'string') {
    if (/^data:image\//i.test(obj)) return obj
    if (/^https?:\/\//i.test(obj) && /\.(png|jpe?g|webp|gif|bmp)(\?|$)/i.test(obj)) return obj
    return null
  }
  if (Array.isArray(obj)) {
    for (const it of obj) { const r = findImage(it, depth + 1); if (r) return r }
    return null
  }
  if (typeof obj === 'object') {
    for (const k of ['url', 'image', 'imageUrl', 'image_url', 'output', 'data', 'images', 'result']) {
      if (k in obj) { const r = findImage(obj[k], depth + 1); if (r) return r }
    }
    for (const v of Object.values(obj)) { const r = findImage(v, depth + 1); if (r) return r }
  }
  return null
}

/** 工具只接受聊天里的短期引用或图库文件名；绝不把模型给的路径 / URL 当图片读。 */
export async function resolveDrawImage(image, { hub, chat }) {
  if (image === undefined || image === null || image === '') return null
  if (typeof image !== 'string') throw new Error('参考图只接受 msg 图片编号、last、quote 或画作文件名')
  const ref = image.trim()
  let buf
  if (/^(last|最近|最近一张|最近发的图|对方最近发的图)$/i.test(ref)) {
    buf = await hub.referenceImage(chat, 'last')
  } else if (/^msg:-?[1-9]\d*:[1-9]\d*$/.test(ref)) {
    buf = await hub.referenceImage(chat, ref)
  } else if (/^(quote|引用|引用消息里的图)$/i.test(ref)) {
    buf = await hub.referenceImage(chat, 'quote')
  } else {
    if (!ref || /[\\/:\0]/.test(ref)) throw new Error('参考图只接受 msg 图片编号、last、quote 或画作文件名，不接受路径或网址')
    const path = paintingPath(ref)
    if (!path || !lstatSync(path).isFile()) throw new Error('找不到这张画作，请使用图库里的文件名')
    buf = readFileSync(path)
  }
  if (!Buffer.isBuffer(buf) || !String(mimeOf(buf)).startsWith('image/')) throw new Error('参考图不是可用的图片')
  return buf
}

/** Explicit references only, in caller order. Missing entries must not shift image numbers. */
export async function resolveDrawImages({ image, images }, context) {
  if (images != null && !Array.isArray(images)) throw new Error('images 必须是参考图编号或文件名的数组')
  const refs = image == null || image === '' ? [...(images || [])] : [image, ...(images || [])]
  if (refs.length > 16) throw new Error('一次最多指定 16 张参考图')
  if (refs.some(ref => typeof ref !== 'string' || !ref.trim())) throw new Error('每张参考图都需要有效的编号或文件名，不能留空')
  const result = []
  for (const ref of refs) result.push(await resolveDrawImage(ref, context))
  return result
}

/**
 * OpenAI 兼容服务：按服务地址拉一次 /models（面板「获取模型」用）。
 * 返回模型 id 数组；地址不对 / 没 Key / 连不上都给一句能看懂的错误。
 * 这是给面板按钮用的诊断请求，允许连本机服务（Ollama / LM Studio 这类常见），
 * 所以不像下载图片那样走 SSRF 闸；地址来自本机面板，最终请求仍受超时约束。
 */
export async function fetchOpenAIModels ({ baseUrl, apiKey, fetchImpl, timeoutMs = 20000 } = {}) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!base) throw new Error('请先填服务地址（一般以 /v1 结尾）')
  if (!/^https?:\/\//i.test(base)) throw new Error('服务地址要以 http:// 或 https:// 开头')
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args))
  let r
  try {
    r = await doFetch(`${base}/models`, {
      method: 'GET',
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const detail = error?.name === 'TimeoutError' ? '连接超时' : (error?.cause?.code || error?.message || '连接失败')
    throw new Error(`连接不上服务地址：${detail}`)
  }
  const raw = await r.text().catch(() => '')
  let j = null
  try { j = JSON.parse(raw) } catch {}
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) throw new Error(`API Key 没填或不对（HTTP ${r.status}）`)
    if (r.status === 404) throw new Error('这个地址没有 /models 接口（HTTP 404），确认服务地址一般以 /v1 结尾')
    const reason = j?.error?.message || j?.message
    throw new Error(`获取模型列表失败：HTTP ${r.status}${reason ? '：' + String(reason).slice(0, 200) : ''}`)
  }
  const items = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : null
  if (!items) throw new Error('接口返回的不是模型列表')
  const models = [...new Set(items.map((it) => (typeof it === 'string' ? it : it?.id || it?.model || it?.name)).map((s) => String(s || '').trim()).filter(Boolean))]
  if (!models.length) throw new Error('接口没有返回任何模型')
  return models
}

const UNSUPPORTED_REFERENCE = '这个生图服务不支持参考图'
export const isUnsupportedReference = (error) => error?.message === UNSUPPORTED_REFERENCE

function customFields(cp) {
  const method = String(cp.method || 'GET').toUpperCase() === 'GET' ? 'GET' : 'POST'
  const params = (Array.isArray(cp.params) ? cp.params : [])
    .map((p) => ({ key: String(p && p.key != null ? p.key : '').trim(), value: p ? p.value : '' }))
    .filter((p) => p.key)
  return { method, params }
}

function customSupportsReference(cp, placeholder = '{image}') {
  const { method, params } = customFields(cp)
  // 只检查实际发送的 URL 与参数；fragment 和被覆盖的重复键不算。
  const sentParams = method === 'POST' ? Object.values(Object.fromEntries(params.map((p) => [p.key, p.value]))) : params.map((p) => p.value)
  return [String(cp.url || '').split('#')[0], ...sentParams].some((v) => String(v || '').includes(placeholder))
}

export const isSingleReferenceOnly = (error) => error?.code === 'SINGLE_REFERENCE_ONLY'

function serviceError(status, message, image) {
  if (image && [400, 422].includes(status)) {
    const match = message.match(/(?:at most|max(?:imum)?(?: of)?|up to|only|最多|只支持|仅支持)\s*([1-8])\s*(?:(?:input|reference)\s*)?(?:images?|张)/i)
    const single = /(?:only (?:one|a single) (?:input )?image|(?:multiple images|image array|image\[\]).*(?:not support|unsupported)|(?:not support|unsupported).*multiple images|(?:最多|只支持|仅支持).*一张)/i.test(message)
    const limit = match ? Number(match[1]) : single ? 1 : 0
    if (limit) return Object.assign(new Error(`这个生图服务最多支持 ${limit} 张参考图`), { code: limit === 1 ? 'SINGLE_REFERENCE_ONLY' : 'REFERENCE_LIMIT', referenceLimit: limit })
  }
  const unsupported = [404, 405, 415, 501].includes(status)
    || ([400, 422].includes(status) && /(?:(?:unsupported|not support|does not support|not available|unknown|unrecognized).*(?:image|edit|model)|(?:image|edit|model).*(?:unsupported|not support|does not support|not available)|不支持.*(?:图|编辑|模型)|(?:图|编辑|模型).*不支持)/i.test(message))
  const error = new Error(image && unsupported ? UNSUPPORTED_REFERENCE : message)
  error.imageRequestFailed = true; error.imageStatus = status
  return error
}

/**
 * 自定义接口这一次要发什么（纯函数，方便单独测）。
 * 返回 { url, method, headers, body }。
 */
export function customRequest (imageGen, prompt, image, images = image ? [image] : []) {
  const cp = imageGen.custom || {}
  const { method, params } = customFields(cp)
  const { width, height } = dimsOf(imageGen.size)
  const raw = { prompt, model: imageGen.model || '', size: imageGen.size || '', width, height, image: image ? image.toString('base64') : '', images: JSON.stringify(images.map((buf) => buf.toString('base64'))) }
  const enc = { ...raw, prompt: encodeURIComponent(prompt), image: encodeURIComponent(raw.image), images: encodeURIComponent(raw.images) }
  if (images.length && !customSupportsReference(cp) && !customSupportsReference(cp, '{images}')) throw serviceError(415, UNSUPPORTED_REFERENCE, image)
  if (images.length > 1 && !customSupportsReference(cp, '{images}')) throw Object.assign(new Error('这个生图服务仅支持单张参考图'), { code: 'SINGLE_REFERENCE_ONLY' })
  let url = fill(cp.url, enc)
  if (method === 'GET' && params.length) {
    const q = params.map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(fill(p.value, raw))}`).join('&')
    const hashAt = url.indexOf('#')
    const base = hashAt < 0 ? url : url.slice(0, hashAt)
    const fragment = hashAt < 0 ? '' : url.slice(hashAt)
    url = base + (base.includes('?') ? '&' : '?') + q + fragment
  }

  const headers = {}
  if (imageGen.apiKey) headers.authorization = `Bearer ${imageGen.apiKey}`

  let body
  if (method === 'POST') {
    const obj = {}
    for (const p of params) obj[p.key] = cp.bodyType !== 'form' && p.value === '{images}' ? images.map((buf) => buf.toString('base64')) : fill(p.value, raw)
    if (cp.bodyType === 'form') {
      headers['content-type'] = 'application/x-www-form-urlencoded'
      body = new URLSearchParams(obj).toString()
    } else {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(obj)
    }
  }
  return { url, method, headers, body }
}

/** 接口返回的「图片地址 / base64」变成 Buffer。 */
async function valueToBuffer (v) {
  if (typeof v !== 'string' || !v) throw new Error('生图接口没有返回图片')
  const b64 = /^data:image\/[^;]+;base64,(.+)$/i.exec(v)
  if (b64) return Buffer.from(b64[1], 'base64')
  if (/^https?:\/\//i.test(v)) return fetchImage(v, { maxBytes: 20 * 1024 * 1024, allowLocal: false, timeoutMs: 120000 })
  throw new Error('生图接口返回的既不是图片地址也不是图片')
}

export function createImageGen({ getConfig, log, local, dsh, fetchImpl, codexAuth, upstream }) {
  const fetch = fetchImpl || ((...args) => globalThis.fetch(...args))
  const auth = codexAuth || createCodexAuth({ log, fetchImpl: fetch })
  const viaCodex = createCodexImage({ auth, fetchImpl: fetch, log })
  async function generate(prompt, { format, shape, image, images, size, count, onRetry } = {}) {
    const cfg = getConfig()
    const config = cfg.imageGen
    const gif = drawFormat(format) === 'gif'
    const defaultCount = config.provider === 'minimax' ? config.minimax?.n : 1
    const many = Math.max(1, Math.min(10, Math.round(Number(count ?? defaultCount) || 1)))
    if (gif && !config.allowGif) throw gifError('GIF 动图还没开启，请主人在生图设置中打开「允许按需生成 GIF」')
    if (gif && (config.provider !== 'openai' || local?.active('image') || upstream?.ready?.())) throw gifError('当前生图接法暂不支持按需 GIF，请使用支持 GIF 的 OpenAI 格式接口')
    if (many > 1 && config.provider !== 'minimax') throw new Error('一次生成多张目前只支持 MiniMax H3 接法')
    const requestedSize = size == null || size === '' ? '' : normalizeRequestedSize(size)
    if (size != null && size !== '' && !requestedSize) throw new Error('图片尺寸格式不对，应为 1024x1024 或 2048x2048 这类格式')
    const c = { ...config, size: requestedSize || imageSizeFor(shape, config) }
    c.gif = gif
    if (gif && !requestedSize) c.size = gifSizeFor(shape, config)
    const refs = images ?? (image ? [image] : [])
    const refLimit = c.provider === 'minimax' ? 16 : 8
    if (!Array.isArray(refs) || refs.length > refLimit || refs.some((buf) => !Buffer.isBuffer(buf) || !String(mimeOf(buf)).startsWith('image/'))) throw new Error(`参考图须为最多 ${refLimit} 张可用图片`)
    if (image != null && (!Buffer.isBuffer(image) || !String(mimeOf(image)).startsWith('image/'))) throw new Error('参考图不是可用的图片')
    if (c.provider === 'minimax') assertMinimaxReferences(refs)
    image = refs[0] || null
    if (image && c.img2img === false) throw new Error('参考图功能已关闭')
    // 外部生图模块（如社区库的「生图 · DSH 已接入模型」）：它明确接管时就用它，返回 null 则照旧。
    // 只在没有参考图时询问：对话模型通道没有统一的编辑协议，图生图落回内置接法。
    if (upstream && !image && !gif) {
      const full = [c.stylePrompt, prompt].filter(Boolean).join('，')
      const handled = await upstream(full, { shape, size: c.size })
      if (handled != null) {
        if (!Buffer.isBuffer(handled) || !handled.length) throw new Error('生图接口没有返回图片')
        if (!String(mimeOf(handled)).startsWith('image/')) throw new Error('生图接口返回的不是图片')
        log.info(`画好了一张图（${Math.round(handled.length / 1024)}KB，外部生图模块）：${prompt.slice(0, 40)}`)
        return handled
      }
    }
    // 本地接口接管：用用户自己电脑上的画图服务
    if (local?.active('image')) {
      const { toImageBuffer } = await import('../local/local.js')
      const t = Date.now()
      const buf = await toImageBuffer(await local.call('image', { prompt: [c.stylePrompt, prompt].filter(Boolean).join('，'), size: c.size, ...(refs.length > 1 ? { images: refs.map((buf) => buf.toString('base64')) } : image ? { image: image.toString('base64') } : {}) }))
      log.info(`本地画好了一张图（${Math.round(buf.length / 1024)}KB，${Math.round((Date.now() - t) / 1000)}s）：${prompt.slice(0, 40)}`)
      return buf
    }
    if (!c.enabled) throw new Error('生图还没开启')
    const full = [c.stylePrompt, prompt].filter(Boolean).join('，')
    const t = Date.now()
    let buf
    try {
      buf = c.provider === 'codex'
        ? await viaCodex(c, full, { shape, image })
        : c.provider === 'custom'
          ? await viaCustom(c, full, image, refs)
          : c.provider === 'minimax'
            ? await viaMinimaxImage(cfg, c, full, refs, many)
            : await viaOpenAI(c, full, image, refs)
    } catch (error) {
      if (gif || many > 1 || !c.fallbackEnabled || !error.imageRequestFailed) throw error
      let last = error
      for (const endpoint of c.fallbacks || []) {
        if (!endpoint.model || (endpoint.provider !== 'codex' && !endpoint.baseUrl)) continue
        if (onRetry) await onRetry({ error: last })
        try { buf = endpoint.provider === 'codex' ? await viaCodex({ ...c, codex: { ...c.codex, model: endpoint.model } }, full, { shape, image }) : await viaOpenAI({ ...c, ...endpoint }, full, image, refs); break }
        catch (next) { last = next; if (!next.imageRequestFailed) throw next }
      }
      if (!buf) throw last
    }
    // MiniMax 一次多张：把每张都校验一遍后整组返回，交给模块逐张发送 / 存盘。
    if (Array.isArray(buf)) {
      if (!buf.length) throw new Error('生图接口没有返回图片')
      if (buf.some((item) => !item || !item.length || !String(mimeOf(item)).startsWith('image/'))) throw new Error('生图接口返回的不是图片')
      log.info(`画好了 ${buf.length} 张图（${Math.round(buf.reduce((n, item) => n + item.length, 0) / 1024)}KB，${Math.round((Date.now() - t) / 1000)}s）：${prompt.slice(0, 40)}`)
      return buf
    }
    if (gif && gifFrameCount(buf) < 2) {
      const kind = ({ 'image/png': 'PNG 静态图', 'image/jpeg': 'JPEG 静态图', 'image/webp': 'WebP 图片', 'image/gif': '单帧或损坏的 GIF' })[mimeOf(buf)] || '无法识别的内容'
      throw gifError(`接口没有返回有效的多帧 GIF 动图，实际返回${kind}；已停止发送，请检查接口或模型的 GIF 支持`)
    }
    if (!buf || !buf.length) throw new Error('生图接口没有返回图片')
    if (!String(mimeOf(buf)).startsWith('image/')) throw new Error('生图接口返回的不是图片')
    log.info(`画好了一张图（${Math.round(buf.length / 1024)}KB，${Math.round((Date.now() - t) / 1000)}s）：${prompt.slice(0, 40)}`)
    return buf
  }

  /**
   * MiniMax H3 Image：同步接口（最长 600 秒），支持多图参考编辑和一次多张。
   * 文档见 minimaxImageBody() 上方注释。
   */
  async function viaMinimaxImage (cfg, c, prompt, refs, count) {
    const m = c.minimax || {}
    const key = minimaxImageKey(cfg)
    if (!key) throw new Error('没填 MiniMax API Key：面板「生图」页填上，或到「语音」页复用同一个 Key')
    const base = minimaxBaseUrl(m.baseUrl)
    const req = minimaxImageBody({ prompt, images: refs, size: c.size, count, cfg })
    if (req.images.length > 16) throw new Error('MiniMax H3 最多支持 16 张参考图')
    let r
    try {
      r = await fetch(`${base}/v1/images/${req.endpoint}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(600000),
      })
    } catch (error) { error.imageRequestFailed = true; error.imageNetworkFailure = true; throw error }
    const j = await r.json().catch(() => ({}))
    if (!r.ok) {
      const message = j?.error?.message || j?.base_resp?.status_msg || j?.message || '接口没有返回错误说明'
      const code = j?.error?.code ?? j?.base_resp?.status_code
      const error = new Error(`MiniMax 生图失败（HTTP ${r.status}${code !== undefined ? '，code ' + code : ''}）：${message}`)
      error.imageRequestFailed = true; error.imageStatus = r.status
      throw error
    }
    const items = Array.isArray(j.data) ? j.data : Array.isArray(j.images) ? j.images : []
    const bufs = []
    let firstError = ''
    for (const item of items) {
      try {
        if (item?.b64_json) bufs.push(Buffer.from(item.b64_json, 'base64'))
        else if (item?.url) {
          const url = String(item.url)
          if (/^data:image\//i.test(url)) bufs.push(await valueToBuffer(url))
          else bufs.push(await fetchImage(url, { maxBytes: 40 * 1024 * 1024, allowLocal: false, timeoutMs: 120000, fetchImpl: fetch }))
        } else if (item?.error) { firstError = firstError || String(item.error.message || item.error.code || '生成失败') }
      } catch (error) { firstError = firstError || String(error?.message || error) }
    }
    if (!bufs.length) throw new Error(`MiniMax 生图没有返回图片${firstError ? '：' + firstError : ''}`)
    if (count > 1 && bufs.length < count) log.warn?.(`MiniMax 一次请求要 ${count} 张，实际成功 ${bufs.length} 张${firstError ? '（' + firstError + '）' : ''}`)
    return count > 1 ? bufs : bufs[0]
  }

  /** OpenAI 兼容接口。 */
  async function viaOpenAI (c, prompt, image, refs) {
    const base = String(c.baseUrl || '').replace(/\/+$/, '')
    if (!base || !c.model) throw new Error('还没填生图服务地址或模型')
    const headers = image ? {} : { 'content-type': 'application/json' }
    if (c.apiKey) headers.authorization = `Bearer ${c.apiKey}`
    // 配了备用服务时，5xx 交给上层切备用（比原地重试快，也不会两边都烧钱）；没配备用才原地重试。
    const hasFallback = Boolean(c.fallbackEnabled && Array.isArray(c.fallbacks) && c.fallbacks.length)
    // response_format、image_size 不是每家都认（官方 OpenAI 就不认）：被拒了去掉再发。被拒的请求没出图，重发不会多画
    const body = { model: c.model, prompt, size: c.size, n: 1, ...(c.gif ? GIF_FIELDS : { response_format: 'b64_json', image_size: c.size }) }
    let requestBody
    if (image) {
      requestBody = new FormData()
      refs.forEach((buf, index) => requestBody.append(refs.length > 1 ? 'image[]' : 'image', new Blob([buf], { type: mimeOf(buf) }), `reference-${index + 1}.` + mimeOf(buf).split('/')[1]))
      for (const [key, value] of Object.entries({ prompt, model: c.model, size: c.size, ...(c.gif ? GIF_FIELDS : {}) })) requestBody.append(key, value)
    }
    let r, j
    let retries = 0
    for (;;) {
      try { r = await fetch(`${base}/images/${image ? 'edits' : 'generations'}`, { method: 'POST', headers, body: requestBody || JSON.stringify(body), signal: AbortSignal.timeout(180000) }) } catch (error) { error.imageRequestFailed = true; error.imageNetworkFailure = true; throw error }
      j = await r.json().catch(() => ({}))
      if (r.ok) break
      const message = j?.error?.message || j?.message || `HTTP ${r.status}`
      const bad = !image && r.status === 400 && ['response_format', 'image_size'].find((k) => k in body && message.includes(k))
      if (bad) { delete body[bad]; continue }
      // 网关类瞬时失败（502/503/504）自动重试：中转站抖一下不该让整张图报废。
      // 只重试 5xx —— 超时故意不重试：请求可能已被上游受理并在出图，重发会出两张、算两次钱。
      // GIF 不重试（一帧 8 张图，成本高）；配了 fallback 时也不重试，交给上层切备用。
      if (!c.gif && !hasFallback && r.status >= 500 && r.status <= 504 && retries < 2) {
        retries += 1
        const wait = retries === 1 ? 1000 : 3000
        log.warn?.(`生图接口 HTTP ${r.status}，${wait / 1000}s 后重试（第 ${retries}/2 次）`)
        await new Promise((resolve) => setTimeout(resolve, wait))
        continue
      }
      throw serviceError(r.status, message, image)
    }
    const item = (j.data || j.images || [])[0] || {}
    let buf
    if (item.b64_json) buf = Buffer.from(item.b64_json, 'base64')
    // 有的服务返回 CDN 链接，下载可能要几十秒（实测 22 秒），默认 20 秒会误判成失败
    else if (item.url) buf = await fetchImage(item.url, { maxBytes: 20 * 1024 * 1024, allowLocal: false, timeoutMs: 120000 })
    else throw new Error('生图服务没有返回图片')
    return buf
  }

  /** 自定义接口：GET 直接把参数拼在地址上，POST 放进 JSON / 表单。 */
  async function viaCustom (c, prompt, image, refs) {
    const cp = c.custom || {}
    if (!cp.url) throw new Error('还没填自定义生图接口地址')
    const req = customRequest(c, prompt, image, refs)
    log.info(`生图请求：${req.method} ${image ? '（含参考图）' : req.url.slice(0, 160)}`)
    let r
    try { r = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(180000),
    }) } catch (error) { error.imageRequestFailed = true; error.imageNetworkFailure = true; throw error }
    const type = String(r.headers.get('content-type') || '')
    // 直接返回图片字节（pollinations 这类）
    if (type.startsWith('image/')) {
      if (!r.ok) throw serviceError(r.status, `HTTP ${r.status}`, image)
      return Buffer.from(await r.arrayBuffer())
    }
    const j = await r.json().catch(() => null)
    if (!r.ok) throw serviceError(r.status, (j && (j.error?.message || j.message)) || `HTTP ${r.status}`, image)
    if (!j) throw new Error('生图接口没有返回图片')
    const v = (cp.responsePath ? dotted(j, cp.responsePath) : null) || findImage(j)
    if (!v) throw new Error('生图接口没有返回图片地址')
    return valueToBuffer(v)
  }

  const enabled = () => {
    if (local?.active('image')) return true
    // 外部生图模块已就绪时，插件自己的「生图」开关不是必要条件。
    try { if (upstream && upstream.ready && upstream.ready()) return true } catch {}
    const cfg = getConfig(); const c = cfg.imageGen
    if (!c.enabled) return false
    if (c.provider === 'codex') return auth.status().loggedIn
    if (c.provider === 'minimax') return Boolean(minimaxImageKey(cfg)) && Boolean(c.minimax?.model || c.model)
    return c.provider === 'custom' ? Boolean(c.custom && c.custom.url) : Boolean(c.baseUrl && c.model)
  }

  /**
   * 没配好 / 没登录时给一句人话；工具本身照常挂着，执行时再提示。
   * 这样 Codex 订阅「先开会话、后登录」时工具不会缺失，登录后下一句就能用。
   */
  const notReadyReason = () => {
    if (local?.active('image')) return ''
    try { if (upstream && upstream.ready && upstream.ready()) return '' } catch {}
    const cfg = getConfig(); const c = cfg.imageGen
    if (!c.enabled) return '生图还没开启：面板「生图」页右上角开关打开并保存'
    if (c.provider === 'codex') {
      return auth.status().loggedIn ? '' : 'ChatGPT 订阅还没登录：面板「生图」页 → Codex 订阅 → 登录'
    }
    if (c.provider === 'minimax') return minimaxImageKey(cfg) ? '' : '没填 MiniMax API Key：面板「生图」页填上，或到「语音」页复用同一个 Key'
    if (c.provider === 'custom') return c.custom && c.custom.url ? '' : '自定义生图接口地址还没填（面板「生图」页）'
    return c.baseUrl && c.model ? '' : '还没填生图服务地址或模型（面板「生图」页）'
  }

  // 保留本地调用方的附件辅助接口，与模块工具共用同一份图片登记实现。
  const canSee = async () => Boolean(dsh && (await canSeeImages(dsh, getConfig())) === true)
  const toolImage = async (buf) => dsh ? imageToolBlock(dsh, buf, { ffmpegPath: getConfig().bili?.ffmpegPath, log }) : null
  async function referenceLimit() {
    const c = getConfig().imageGen
    if (c.img2img === false) return 0
    if (local?.active('image')) {
      if (typeof local.referenceLimit === 'function') return local.referenceLimit()
      return typeof local.supportsImage === 'function' && await local.supportsImage() === true ? 1 : 0
    }
    if (!c.enabled) return 0
    if (c.provider === 'codex') return 0
    if (c.provider === 'minimax') return minimaxImageKey(getConfig()) ? 16 : 0
    if (c.provider === 'custom') return customSupportsReference(c.custom || {}, '{images}') ? 8 : customSupportsReference(c.custom || {}) ? 1 : 0
    if (!c.baseUrl || !c.model) return 0
    if (/^dall-e-3$/i.test(c.model || '')) return 0
    if (/^dall-e-2$/i.test(c.model || '')) return 1
    return 8 // OpenAI 多图协议；兼容服务的明确单图错误由 self 调用方处理。
  }
  const supportsReference = async () => await referenceLimit() > 0

  return { generate, canSee, toolImage, enabled, notReadyReason, supportsReference, referenceLimit, codexAuth: auth, dispose: () => auth.dispose?.() }
}

/**
 * qq_draw_image 工具结果里那句话。
 * 看不了图、或者「让她画完自己看一眼」关着时，都要如实说，否则她会照着提示词编画面细节。
 * 这里只回一句话，不带文件路径；能不能把「已保存到本机：路径」告诉她，由调用方按
 * 「这张图有没有真的交出去」决定（能看图 + 开关开着 + 附件登记成功才给）。
 */
export function drawToolMessage ({ visual = false, seeOwn = true } = {}) {
  if (!visual) return '画好发出去了，但这次没能把图片交给你看；别描述画面里有什么'
  if (!seeOwn) return '画好发出去了。这次没把图给你看，别描述画面里有什么'
  return '画好发出去了'
}

/**
 * qq_draw_image 的工具结果怎么渲染：一行文字 +（有图时）image 块。
 * image 一般是 DSH 附件块（imageToolBlock() 登记过的），原样透传；没图就只回文字。
 */
export function drawResultBlocks (_args, value) {
  const text = value && value.ok === false ? '✗ ' + (value.message || '没成功') : (value && value.message) || '✓'
  const blocks = [{ type: 'text', text }]
  const img = value && value.image
  if (img && img.attachment) blocks.push({ ...img, type: 'image' })
  return blocks
}
