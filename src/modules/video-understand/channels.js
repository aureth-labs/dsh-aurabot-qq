// video-understand 双通道实现：通道A = DSH/项目现成接口，通道B = 第三方 OpenAI 兼容 HTTP。
// 所有第三方调用都带超时与错误分类：content_filter 类内容审查错误标记为不可重试，避免重复计费。
import { describeFrames } from '../../bili/vision.js'
import { UA } from '../../bili/api.js'

// 审查拒绝特征：精确短语 + 边界/负向断言，避免 'header is case sensitive'、'safety valve'、
// 'moderation_id missing' 这类普通消息被误判成 content-filter（误判=放弃可重试的临时故障）。
// 英文短语：content filter / content policy / sensitive content / moderation(不跟 _id)；中文子串：敏感/审核/违规/内容风险。
const CONTENT_FILTER_RE = /content[_-]?filter|content[_-]?policy|sensitive\s+content|moderation(?![_-]?id)|content[_-]?policy\s+violation|policy\s+violation|审核|敏感|违规|内容风险/
const CONTENT_FILTER_HINTS = [
  'content_filter', 'content filter', 'content-filter',
  'content_policy', 'content policy', 'sensitive content',
  '敏感', '审核', '违规', '内容风险',
]
// 参数类错误（如 moderation_id missing / invalid request）：参数错误重试无用，不可重试但也不是审查。
const BAD_REQUEST_RE = /(param(eter)?|field|argument)s?\s+(is\s+)?(missing|invalid)|_id\s+missing\b|invalid\s+request|bad\s+request|bad_request/i

// 把任意错误归一为 { kind, retryable }：
// retryable=true 的（限流/服务端/超时/网络）可安全重试；
// content-filter / 鉴权 / 404 一类不可重试——重试只会重复计费。
export function classifyError(e) {
  const msg = String(e && e.message || e || '')
  if (e && e.__classified) return e
  const low = msg.toLowerCase()
  let kind = 'unknown'
  let retryable = false
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
    kind = 'timeout'
    retryable = true
  } else if (CONTENT_FILTER_RE.test(low) || CONTENT_FILTER_HINTS.some((h) => msg.includes(h))) {
    kind = 'content-filter' // 必须先于 status 分支：审查拒绝常带 HTTP 400/500 状态码，不能因可重试的状态码而重复计费
  } else if (BAD_REQUEST_RE.test(msg)) {
    kind = 'bad-request' // 参数错误（哪怕返回 500）：重试同样失败，先于 status 分支判定
  } else if (e && e.status) {
    const s = e.status
    if (s === 401 || s === 403) { kind = 'auth' }
    else if (s === 404) { kind = 'notfound' }
    else if (s === 429) { kind = 'rate-limit'; retryable = true }
    else if (s >= 500) { kind = 'server'; retryable = true }
    else { kind = 'bad-request' }
  } else if (/fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN|socket/i.test(msg)) {
    kind = 'network'
    retryable = true
  }
  try {
    e.kind = kind
    e.retryable = retryable
    e.__classified = true
  } catch {}
  return e
}

// 只对「可重试」错误做有限次退避重试；content-filter/auth 等直接抛出。
export async function withRetry(fn, { retries = 2, label = '调用', log = () => {} } = {}) {
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt)
    } catch (e) {
      lastErr = classifyError(e)
      if (!lastErr.retryable || attempt === retries) throw lastErr
      const wait = 1500 * (attempt + 1)
      log(`[video-understand] ${label} 失败(${lastErr.kind})，${wait}ms 后重试 ${attempt + 1}/${retries}`)
      await new Promise((r) => setTimeout(r, wait))
    }
  }
  throw lastErr
}

function httpError(status, bodyText, url) {
  const e = new Error(`第三方接口 HTTP ${status}: ${String(bodyText || '').slice(0, 300)} (${url})`)
  e.status = status
  return classifyError(e)
}

// 第三方 baseUrl 归一：去掉结尾斜杠与多余的 /chat/completions 后缀
function apiBase(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '')
}

function anySignal(signal, timeoutMs) {
  const t = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, t]) : t
}

/* ---------------- 视觉理解（抽帧 → 描述） ---------------- */

// 通道A：直接复用 src/bili/vision.js 的 describeFrames（内部走 DSH askModel）。
// model 为已解析的 {provider, model}（可选）；返回结构与通道B对齐。
export async function describeVisualDsh({ dsh, cfg, info, frames, model, prompt, maxTokens }) {
  const text = await describeFrames(dsh, {
    info: { title: info.title || '', author: info.author || '', duration: info.durationSec },
    frames,
    cfg,
    model: model || undefined,
    prompt: prompt || undefined,
    maxTokens,
  })
  return { text, usage: null, model: model?.model || null }
}

// 通道B：OpenAI 兼容 chat/completions，图片走 base64 image_url（智谱 GLM-4V 等兼容此格式）
export async function describeVisualThird({ settings, info, frames, signal, log }) {
  const base = apiBase(settings.visualBaseUrl)
  if (!base) throw classifyError(new Error('第三方视觉通道未配置 baseUrl'))
  if (!settings.visualApiKey) throw classifyError(new Error('第三方视觉通道未配置 apiKey'))
  const model = settings.visualModel || 'glm-4v-plus-0111'
  const prompt = settings.visualPrompt ||
    `这是一个视频的若干张截图（标题《${info.title || '未知'}》）。请根据画面推断这个视频讲了什么，用3~6句中文概括内容、场景与可能的主题。`
  const content = [{ type: 'text', text: prompt }]
  for (const f of frames) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${f.buf.toString('base64')}` },
    })
  }
  const url = `${base}/chat/completions`
  // !res.ok 的抛出必须在 withRetry 回调内：否则 HTTP 429/5xx 永远不会重试
  const res = await withRetry(async () => {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.visualApiKey}`,
        'User-Agent': UA,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        max_tokens: settings.visualMaxTokens || 1000,
      }),
      signal: anySignal(signal, 120000),
    })
    if (!r.ok) throw await r.text().then((t) => httpError(r.status, t, url))
    return r
  }, { retries: 1, label: '第三方视觉理解', log })
  const data = await res.json()
  const text = data?.choices?.[0]?.message?.content
  if (!text) throw classifyError(new Error('第三方视觉理解返回为空'))
  return { text: String(text).trim(), usage: data?.usage || null, model }
}

/* ---------------- ASR 语音识别 ---------------- */

// 通道A：DSH speechToText。wav 为 ffmpeg 产出的 16kHz 单声道 PCM16 WAV 字节。
// 与 src/chat/hub.js localTranscribe（hub.js:1293-1310）同一调用范式：
// resolve({audio}) → transcribe(spec, signal)；模型未就绪时触发 prepare 并抛可读错误。
export async function transcribeDsh({ dsh, wav, timeoutMs = 120000 }) {
  const stt = dsh.get('speechToText')
  if (!stt || typeof stt.resolve !== 'function' || typeof stt.transcribe !== 'function') {
    throw classifyError(new Error('DSH 没开启语音输入（设置 → 插件 → 语音输入）'))
  }
  // 模型还没下载好：顺手开始准备（下载一次，之后常驻），这一条按失败处理
  const snap = typeof stt.snapshot === 'function' ? stt.snapshot() : null
  const pid = snap?.selection?.providerId
  const prov = snap?.providers?.find((p) => p.id === pid)
  if (prov && prov.preparation && !['ready', 'standby'].includes(prov.preparation.phase)) {
    try { stt.prepare(pid) } catch {}
    throw classifyError(new Error(`语音识别模型还在准备（${prov.preparation.phase}）`))
  }
  const spec = stt.resolve({ audio: new Uint8Array(wav) })
  const r = await stt.transcribe(spec, AbortSignal.timeout(timeoutMs))
  const text = typeof r === 'string' ? r : r?.text || r?.transcript
  return { text: String(text || '').trim(), providerId: pid }
}

// 通道B：OpenAI 兼容 /v1/audio/transcriptions（multipart）
export async function transcribeThird({ settings, wav, language, signal, log }) {
  const base = apiBase(settings.asrBaseUrl)
  if (!base) throw classifyError(new Error('第三方 ASR 通道未配置 baseUrl'))
  if (!settings.asrApiKey) throw classifyError(new Error('第三方 ASR 通道未配置 apiKey'))
  const model = settings.asrModel || 'whisper-1'
  const form = new FormData()
  form.append('model', model)
  form.append('response_format', 'json')
  if (language) form.append('language', language)
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav')
  const url = `${base}/audio/transcriptions`
  // FormData 可跨重试复用（fetch 每次重新读取）；!res.ok 必须在 withRetry 内
  const res = await withRetry(async () => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${settings.asrApiKey}`, 'User-Agent': UA },
      body: form,
      signal: anySignal(signal, 180000),
    })
    if (!r.ok) throw await r.text().then((t) => httpError(r.status, t, url))
    return r
  }, { retries: 1, label: '第三方 ASR', log })
  const data = await res.json()
  const text = data?.text
  if (typeof text !== 'string') throw classifyError(new Error('第三方 ASR 返回缺少 text 字段'))
  return { text: text.trim(), model }
}

/* ---------------- 原生视频 API（默认关闭） ---------------- */

// OpenAI 兼容的多模态消息，视频走 video_url（智谱 GLM-4V-Plus 等支持；本地文件转 base64 data URL）
export async function nativeUnderstand({ settings, prompt, sourceUrl, localPath, sizeOk, signal, log }) {
  const base = apiBase(settings.nativeBaseUrl)
  if (!base) throw classifyError(new Error('原生视频 API 未配置 baseUrl'))
  if (!settings.nativeApiKey) throw classifyError(new Error('原生视频 API 未配置 apiKey'))
  const model = settings.nativeModel || 'glm-4v-plus-0111'
  let videoUrl = sourceUrl
  if (!videoUrl && localPath) {
    if (!sizeOk) throw classifyError(new Error('本地文件超过原生 API 大小限制，无法 base64 上传'))
    const { readFileSync } = await import('node:fs')
    const b64 = readFileSync(localPath).toString('base64')
    videoUrl = `data:video/mp4;base64,${b64}`
  }
  if (!videoUrl) throw classifyError(new Error('原生视频 API 需要可访问的视频地址'))
  const url = `${base}/chat/completions`
  const res = await withRetry(async () => {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.nativeApiKey}`,
        'User-Agent': UA,
      },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'video_url', video_url: { url: videoUrl } },
            { type: 'text', text: prompt || '请完整理解这个视频：概述内容、场景、出现的关键信息，用中文分点说明。' },
          ],
        }],
        max_tokens: 2000,
      }),
      signal: anySignal(signal, 300000),
    })
    if (!r.ok) throw await r.text().then((t) => httpError(r.status, t, url))
    return r
  }, { retries: 1, label: '原生视频 API', log })
  const data = await res.json()
  const text = data?.choices?.[0]?.message?.content
  if (!text) throw classifyError(new Error('原生视频 API 返回为空'))
  return { text: String(text).trim(), usage: data?.usage || null, model }
}
