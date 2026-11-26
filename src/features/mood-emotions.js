/**
 * 心情项（情绪向量）的纯逻辑层：默认项、可配置归一化、跨轮衰减推导。
 *
 * 为什么单独一个文件：
 *   · 心情模块（src/features/mood.js）要在写状态前把向量衰减 + 抬升算完；
 *   · 目的引擎（src/purpose/engine.js）要用同一套键/标签/强弱画像做提示词与候选打分。
 *   两边如果各留一份「十种情绪」的写死表，就会重演「两份心情对不上」的老问题
 *   （2026-11-17 合并前：心情模块单标量 + 目的引擎十维向量，两个半衰期、两处面板）。
 *
 * 约定：
 *   · 键（key）只认小写字母开头、点划线组成的短标识，模型回包里也按它对齐；
 *   · 标签（label）是给人和模型看的名字，可随时改（不改键，历史数据不丢）；
 *   · 图标（icon）可空，面板没图标时用 💭 兜底；
 *   · valence（-1~1 正负倾向）与 arousal（0~1 强弱）只为「怎么说话」和桌宠辉光服务。
 *
 * 纯函数、零 import、零 I/O。
 */

/** 心情项数量上限：面板是窄容器，再多也看不过来；同时兜住配置被手写炸掉的情况。 */
export const MAX_EMOTIONS = 24

/** 键名格式：小写字母开头，1~24 位，允许数字、下划线与短横线（允许单字母，用户可能就想叫「a」）。 */
export const EMOTION_KEY_RE = /^[a-z][a-z0-9_-]{0,23}$/

/**
 * 出厂十项，键与旧版 engine.js 的 EMOTION_LABELS 完全一致——
 * 这样老存档里的 moods 向量、历史记录里的 emotion 字段都能直接对上，不需要翻译。
 */
export const DEFAULT_EMOTIONS = Object.freeze([
  Object.freeze({ key: 'curious', label: '好奇', icon: '🤔', valence: 0.3, arousal: 0.6 }),
  Object.freeze({ key: 'excited', label: '兴奋', icon: '🤩', valence: 0.8, arousal: 0.9 }),
  Object.freeze({ key: 'lonely', label: '寂寞', icon: '😔', valence: -0.6, arousal: 0.3 }),
  Object.freeze({ key: 'envious', label: '羡慕', icon: '😒', valence: -0.4, arousal: 0.5 }),
  Object.freeze({ key: 'worried', label: '担心', icon: '😟', valence: -0.5, arousal: 0.6 }),
  Object.freeze({ key: 'proud', label: '得意', icon: '😌', valence: 0.6, arousal: 0.5 }),
  Object.freeze({ key: 'affectionate', label: '亲近', icon: '🥰', valence: 0.7, arousal: 0.4 }),
  Object.freeze({ key: 'bored', label: '无聊', icon: '😐', valence: -0.2, arousal: 0.2 }),
  Object.freeze({ key: 'amused', label: '好笑', icon: '😄', valence: 0.6, arousal: 0.7 }),
  Object.freeze({ key: 'content', label: '平静', icon: '😊', valence: 0.2, arousal: 0.3 }),
])

/** 出厂十项的深拷贝：调用方要改（面板编辑、归一化）时不能污染冻结常量。 */
export function defaultEmotions() {
  return DEFAULT_EMOTIONS.map((item) => ({ ...item }))
}

const clamp = (v, lo, hi, fallback = 0) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}

/** 标签：去掉控制字符与多余空白，最多 8 个字（面板一行放得下）。 */
function cleanLabel(raw, fallback = '') {
  const text = String(raw ?? '')
    // 控制字符、零宽字符与换行会让面板与提示词都变脏
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(text).slice(0, 8).join('') || fallback
}

/** 图标：最多两个码位（emoji 常带变体选择符），非 emoji 的内容原样截断也不会崩。 */
function cleanIcon(raw) {
  return Array.from(String(raw ?? '').replace(/\s+/g, '')).slice(0, 2).join('')
}

/** 没配图标时的兜底。 */
export const FALLBACK_EMOTION_ICON = '💭'

/**
 * 把配置里的心情项归一化成可用列表。
 * 坏项（缺键、键格式不对、重复键、非对象）直接丢弃；一条都不剩时回落到出厂十项——
 * 宁可让用户回到默认，也不能让「一个心情项都没有」把心情功能整块废掉。
 */
export function normalizeEmotions(raw) {
  const list = Array.isArray(raw) ? raw : []
  const out = []
  const seen = new Set()
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const key = String(item.key ?? '').trim().toLowerCase()
    if (!EMOTION_KEY_RE.test(key) || seen.has(key)) continue
    seen.add(key)
    out.push({
      key,
      label: cleanLabel(item.label, key),
      icon: cleanIcon(item.icon),
      // 新加的项没写倾向时给「中性偏弱」，不至于让提示词的强弱措辞变成空
      valence: clamp(item.valence, -1, 1, 0.2),
      arousal: clamp(item.arousal, 0, 1, 0.5),
    })
    if (out.length >= MAX_EMOTIONS) break
  }
  return out.length ? out : defaultEmotions()
}

/** 键集合：给「这个键还认不认」这类判断用。 */
export function emotionKeys(emotions) {
  return new Set(normalizeEmotions(emotions).map((item) => item.key))
}

/** 键 → 心情项。 */
export function emotionMap(emotions) {
  const map = new Map()
  for (const item of normalizeEmotions(emotions)) map.set(item.key, item)
  return map
}

/** 键 → 标签（目的引擎的 EMOTION_LABELS 兼容层用）。 */
export function emotionLabels(emotions) {
  const labels = {}
  for (const item of normalizeEmotions(emotions)) labels[item.key] = item.label
  return labels
}

/** 键 → { valence, arousal }。 */
export function emotionProfiles(emotions) {
  const profiles = {}
  for (const item of normalizeEmotions(emotions)) profiles[item.key] = { valence: item.valence, arousal: item.arousal }
  return profiles
}

/**
 * 取某个键的二维画像；未知键回中性偏弱。
 * 与原 engine.js 的 emotionProfile() 同语义（未知 → { valence: 0, arousal: 0.4 }）。
 */
export function profileOf(emotions, key) {
  const item = emotionMap(emotions).get(String(key || ''))
  return item ? { valence: item.valence, arousal: item.arousal } : { valence: 0, arousal: 0.4 }
}

/**
 * 把「引擎内部写死的情绪键」映射到用户配置里真实存在的键。
 *
 * 背景：目的引擎的情绪来源里有一部分是写死的（需要→情绪表、关键词判定），
 * 用户删掉某一项之后那些键就不在配置里了。与其让它变成空字符串（提示词少半句话），
 * 不如按 valence/arousal 找最接近的一项——用户删掉「无聊」时，「有点闷」映射到「平静」也说得通。
 */
export function resolveEmotion(emotions, key) {
  const list = normalizeEmotions(emotions)
  const want = String(key || '')
  if (!want) return ''
  const exact = list.find((item) => item.key === want)
  if (exact) return exact.key
  const target = (DEFAULT_EMOTIONS.find((item) => item.key === want) || {}).valence !== undefined
    ? DEFAULT_EMOTIONS.find((item) => item.key === want)
    : null
  if (!target || !list.length) return ''
  let best = ''
  let bestScore = Infinity
  for (const item of list) {
    // 正负方向差得越多越不像；强弱差按一半权重算
    const score = Math.abs(item.valence - target.valence) + Math.abs(item.arousal - target.arousal) * 0.5
    if (score < bestScore) { bestScore = score; best = item.key }
  }
  return best
}

/** 向量归一化：只认配置里现存的键，每维钳到 0~1；未知键丢弃（用户删项后旧向量自然瘦下来）。 */
export function normalizeEmotionVector(raw, emotions) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const item of normalizeEmotions(emotions)) {
    const v = Number(raw[item.key])
    if (Number.isFinite(v)) out[item.key] = clamp(v, 0, 1, 0)
  }
  return out
}

const HOUR = 3600_000

/**
 * 心情向量的跨轮推导：先按半衰期整体向 0 衰减（心情会淡忘），再给触发它的那一项抬一手。
 *
 * 与旧 engine.js 的 deriveMoods 的差别只有一处：抬升从「固定 +0.45」改成可传权重，
 * 因为现在由心情模块统一记账，聊天里的关键词/模型判断也可能想推一把弱的。
 *
 * @param {object} opts
 * @param {object} opts.vector 上一轮的向量
 * @param {number} opts.at 上一轮的结算时间（0/非法 = 不衰减，避免刚启动就把心情洗光）
 * @param {string|string[]|object} opts.boost 要抬的键（数组 = 每项抬一次；对象 = 键→权重）
 * @param {number} opts.halfLifeHours 半衰期（小时），非正数回落 6
 * @param {number} opts.now 现在
 * @param {Array} opts.emotions 心情项配置
 */
export function deriveEmotionVector({
  vector = {},
  at = 0,
  boost = null,
  halfLifeHours = 6,
  now = Date.now(),
  emotions = DEFAULT_EMOTIONS,
} = {}) {
  const next = normalizeEmotionVector(vector, emotions)
  const last = Number(at) || 0
  // 最长只认 72 小时：隔了很久才跑一次时，别把「三天前的兴奋」按精确公式留一点点，
  // 直接当成已经淡完了（与旧 deriveMoods 的上限一致）。
  const hours = last > 0 ? Math.min(72, Math.max(0, (now - last) / HOUR)) : 0
  const decay = Math.pow(0.5, hours / Math.max(0.1, Number(halfLifeHours) || 6))
  for (const key of Object.keys(next)) next[key] = clamp(next[key] * decay, 0, 1, 0)
  const boosts = []
  if (typeof boost === 'string') boosts.push([boost, 0.45])
  else if (Array.isArray(boost)) for (const key of boost) boosts.push([String(key), 0.45])
  else if (boost && typeof boost === 'object') for (const [key, value] of Object.entries(boost)) boosts.push([String(key), value])
  const known = emotionKeys(emotions)
  for (const [rawKey, rawWeight] of boosts) {
    const key = resolveEmotion(emotions, rawKey)
    if (!key || !known.has(key)) continue
    // 抬升权重钳在 0~1：一次抬满就是「满格」，多次叠加也不会超过 1
    const weight = clamp(rawWeight, 0, 1, 0.45)
    if (!weight) continue
    next[key] = clamp((next[key] || 0) + weight, 0, 1, 0)
  }
  return { vector: next, at: now }
}

/**
 * 现在最强的那一项（面板摘要、状态行用）。
 * 全部低于 min 时返回 null——「没什么心情」也是一种状态，不要硬报一个 0.01 的项。
 */
export function topEmotion(vector, emotions, min = 0.02) {
  const list = normalizeEmotions(emotions)
  const normalized = normalizeEmotionVector(vector, list)
  let best = null
  for (const item of list) {
    const value = normalized[item.key] || 0
    if (value < min) continue
    if (!best || value > best.value) best = { key: item.key, label: item.label, icon: item.icon || FALLBACK_EMOTION_ICON, value }
  }
  return best
}
