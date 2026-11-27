// 陪伴类小功能：心情、主动搭话。

import { randomUUID } from 'node:crypto'
import { dataDir, readJson, writeJson } from '../core/store.js'
import { askModel } from '../core/llm.js'
import { cleanText, clipText } from '../core/text.js'
import { shouldDeferBackground } from '../core/offpeak.js'
import { inHourWindow } from '../core/time-window.js'
import { followUpHint } from './memory.js'
import { moodReason } from './mood-context.js'
import {
  DEFAULT_EMOTIONS, FALLBACK_EMOTION_ICON, deriveEmotionVector, emotionKeys,
  normalizeEmotionVector, normalizeEmotions, resolveEmotion, topEmotion,
} from './mood-emotions.js'
import { selfName, personaDataDir, personaNow } from '../persona/personas.js'

// ---------------- 心情 ----------------
// 0~100，基线 60。聊天里的话按关键词推一推，随时间按半衰期回到基线。
// 心情明显偏离平常时，每一轮都告诉她现在的状态和具体的说话方式；平平常常时不说（免得把性格念「定」住）。
// 心情还会实际影响行为：发表情包 / 语音的概率、回复快慢、群里插话的积极程度。

const UP = ['喜欢你', '爱你', '想你', '可爱', '好看', '漂亮', '聪明', '真棒', '厉害', '牛', '谢谢', '辛苦', '晚安', '早安', '抱抱', '摸摸', '贴贴', '乖', '宝贝', '爱了', '哈哈哈', '白米饭', '好吃', '请你吃']
const DOWN = ['讨厌', '滚', '烦死', '闭嘴', '笨', '蠢', '傻', '丑', '垃圾', '废物', '恶心', '无聊', '走开', '别理我', '不理你', '别说话', '生气', '难过', '烦人']

export function moodLabel(v) {
  if (v >= 85) return '超开心'
  if (v >= 70) return '心情不错'
  if (v >= 50) return '平平常常'
  if (v >= 35) return '有点低落'
  return '不太开心'
}

/** 每种心情下具体怎么说话（给她的提示），平平常常时为空。 */
export const MOOD_STYLE = {
  超开心: '话多一点、语气活泼，爱用语气词和感叹，更愿意发表情包、发语音，会主动接话、开玩笑',
  心情不错: '语气轻快，爱开点小玩笑，回得积极一些',
  平平常常: '',
  有点低落: '话少一点、句子短，回得有点懒，少发表情；有人关心你会慢慢好起来',
  不太开心: '有点小脾气、带点委屈，回得简短，可能会怼一句（但别伤人）；被哄、被夸会消气',
}

/** 心情对行为的影响倍数：表情包 / 语音概率、回复间隔、群里插话。 */
export function moodEffects(v) {
  if (v >= 85) return { sticker: 1.6, voice: 1.5, delay: 0.85, chatty: 1.5 }
  if (v >= 70) return { sticker: 1.25, voice: 1.2, delay: 0.92, chatty: 1.2 }
  if (v >= 50) return { sticker: 1, voice: 1, delay: 1, chatty: 1 }
  if (v >= 35) return { sticker: 0.5, voice: 0.6, delay: 1.3, chatty: 0.6 }
  return { sticker: 0.3, voice: 0.4, delay: 1.5, chatty: 0.4 }
}

export function scoreText(text) {
  const t = String(text || '')
  let d = 0
  for (const w of UP) if (t.includes(w)) d += 6
  for (const w of DOWN) if (t.includes(w)) d -= 8
  return Math.max(-20, Math.min(20, d))
}

/** 心情基线的兜底值：没有配置时用它（和上游原来的 60 一致）。改基线只改配置项 mood.base。 */
export const MOOD_BASE = 60

export function decayed(value, at, halfLifeHours, now = Date.now(), base = MOOD_BASE) {
  const h = Math.max(0, (now - at) / 3600_000)
  return base + (value - base) * Math.pow(0.5, h / halfLifeHours)
}

/** 解析模型判心情的结果：{delta, reason, confidence}；解析不了返回 null。 */
export function parseMoodJudge(out) {
  const m = String(out || '').match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const j = JSON.parse(m[0])
    const delta = Math.max(-15, Math.min(15, Math.round(Number(j.delta) || 0)))
    const confidence = Math.max(0, Math.min(1, Number(j.confidence) || 0))
    return { delta, reason: String(j.reason || '').slice(0, 40), confidence }
  } catch (error) {
    return null
  }
}

export function createMood({ getConfig, dsh, log }) {
  let judgeDeferLogged = false
  // 心情是她自己的，跟着人格走（根目录人格还是老位置，见 personas.js）；主动搭话的次数是对主人的打扰频率，仍共用
  const file = () => personaDataDir(getConfig(), personaNow(getConfig()), 'mood.json')
  /** 当前配置的基线：衰减、初始值、兜底、判断提示词四处统一读它。 */
  const base = () => {
    const v = Number(getConfig().mood?.base)
    return Number.isFinite(v) ? Math.min(90, Math.max(10, v)) : MOOD_BASE // 面板是 10~90，手写超出时夹到边上，别退回默认
  }
  const load = () => readJson(file(), () => ({ value: base(), at: Date.now(), reason: '', history: [], emotions: {}, emotionsAt: 0 }))
  const save = (s) => writeJson(file(), s)
  const current = () => {
    const s = load()
    return Math.round(decayed(s.value, s.at, getConfig().mood.halfLifeHours, Date.now(), base()))
  }
  /** 心情项配置：面板随时可改，读写都按当下配置走，不缓存（改完立刻生效，与标量同口径）。 */
  const emotions = () => normalizeEmotions(getConfig().mood?.emotions)
  /**
   * 当前的情绪向量（已衰减、按当下心情项裁剪）。
   * 只算不写：state() 是纯读，面板轮询不该产生落盘。
   */
  function emotionState(now = Date.now()) {
    const s = load()
    const list = emotions()
    const { vector, at } = deriveEmotionVector({
      vector: s.emotions,
      at: s.emotionsAt,
      halfLifeHours: getConfig().mood?.halfLifeHours,
      now,
      emotions: list,
    })
    const top = topEmotion(vector, list)
    return { vector, at, list, top }
  }
  /**
   * 推一下心情（d 可正可负），记下原因和原因所属的聊天。
   * chatId 用来防止别的私聊/群里的原因串进当前会话的上下文（issue #273）；不传时只做全局记录。
   */
  function nudge(d, reason, chatId = '') {
    if (getConfig().debug) return // 调试模式不动心情：心情是持久状态，调试不该留下痕迹
    if (!getConfig().mood.enabled || !d) return
    const s = load()
    const before = current()
    s.value = Math.max(5, Math.min(100, before + d))
    s.at = Date.now()
    reason = cleanText(reason)
    s.reason = reason
    s.reasonAt = s.at
    s.reasonChat = String(chatId || '')
    // 保留 200 条：20 条只够两小时，出问题查不到原因（实测需要回溯半天以上）
    s.history = [{ at: Date.now(), from: before, to: Math.round(s.value), reason, chatId: s.reasonChat }, ...(s.history || [])].slice(0, 200)
    save(s)
    try { log?.debug?.(`心情 ${before} → ${Math.round(s.value)}（${d > 0 ? '+' : ''}${d}）：${reason}`) } catch (error) {}
  }
  /**
   * 这一轮让她「有点什么情绪」：情绪向量里对应项抬一手（衰减在每次结算时统一做）。
   *
   * 这是目的引擎等模块上报情绪的唯一入口——
   * 心情模块是唯一真相，别人的情绪一律走这里，不再自己维护一份向量。
   *
   * @param {string|string[]|object} emotion 情绪键 / 键数组 / { 键: 权重 }
   * @param {object} opts { weight 单项权重(默认0.45)、now、silent=true 时不落盘（预演/预览用） }
   * @returns {object|null} 结算后的向量；模块关着或调试模式返回 null
   */
  function feel(emotion, { weight = 0.45, now = Date.now(), silent = false } = {}) {
    const cfg = getConfig()
    if (cfg.debug) return null
    if (!cfg.mood?.enabled) return null
    const list = emotions()
    const s = load()
    const boost = typeof emotion === 'object' && emotion !== null && !Array.isArray(emotion)
      ? emotion
      : (Array.isArray(emotion) ? { ...Object.fromEntries(emotion.map((key) => [key, weight])) } : { [String(emotion || '')]: weight })
    const { vector, at } = deriveEmotionVector({
      vector: s.emotions,
      at: s.emotionsAt,
      boost,
      halfLifeHours: cfg.mood?.halfLifeHours,
      now,
      emotions: list,
    })
    if (!silent) {
      s.emotions = vector
      s.emotionsAt = at
      save(s)
    }
    const keys = Object.keys(boost).map((key) => resolveEmotion(list, key)).filter(Boolean)
    if (keys.length) { try { log?.debug?.(`情绪 ${keys.join('、')} +${weight}`) } catch (error) {} }
    return vector
  }
  /**
   * 把别处攒起来的旧向量并进来（一次性迁移用）。
   * 只并「心情项认识且当前更弱」的项——不覆盖她此刻真实更高的情绪，
   * 迁移只是把历史搬个位置，不该在迁移瞬间改变她的状态。
   */
  function importEmotions(raw, { at = 0, now = Date.now() } = {}) {
    const cfg = getConfig()
    if (!raw || typeof raw !== 'object') return null
    const list = emotions()
    const known = emotionKeys(list)
    const s = load()
    const incoming = normalizeEmotionVector(raw, list)
    if (!Object.keys(incoming).length) return null
    const merged = { ...(s.emotions || {}) }
    for (const [key, value] of Object.entries(incoming)) {
      if (!known.has(key)) continue
      if (!(Number(merged[key]) >= value)) merged[key] = value
    }
    s.emotions = merged
    // 迁移不重置衰减起点：优先沿用旧向量自己的时间戳，没有就按传入值/现在
    s.emotionsAt = Number(s.emotionsAt) || Number(at) || now
    if (!cfg.debug) save(s)
    return s.emotions
  }
  return {
    current,
    label: () => moodLabel(current()),
    state: () => {
      const s = load()
      const es = emotionState()
      return {
        ...s,
        value: current(),
        label: moodLabel(current()),
        // 情绪向量摘要：面板画十条进度条 + 一行「此刻最强的那一项」
        emotions: es.vector,
        emotionsAt: es.at,
        emotionsItems: es.list.map((item) => ({ ...item, icon: item.icon || FALLBACK_EMOTION_ICON, value: es.vector[item.key] || 0 })),
        emotionTop: es.top,
      }
    },
    effects: () => (getConfig().mood.enabled ? moodEffects(current()) : moodEffects(base())),
    nudge,
    feel,
    importEmotions,
    emotions: () => emotions(),
    /** 情绪强弱画像（桌宠气泡辉光、提示词措辞用）；未知键回中性偏弱。 */
    emotionProfile: (key) => {
      const list = emotions()
      const item = list.find((x) => x.key === String(key || ''))
      return item ? { valence: item.valence, arousal: item.arousal } : { valence: 0, arousal: 0.4 }
    },
    /**
     * 聊天里的一句话。direct = 是对她说的（私聊、@她、叫她）；owner = 主人说的。
     * 不是对她说的群聊只算三成，主人的话算 1.5 倍。
     * chatId = 这句话来自哪个聊天：心情原因只在同一个聊天里展示，避免串聊。
     */
    observe(text, who, { direct = true, owner = false, silent = false, chatId = '' } = {}) {
      // 开了模型判断就不用关键词；但峰时省钱模式会把模型判断推迟到谷时，这时退回关键词，心情照样有起伏
      const modelJudge = getConfig().mood.judge && dsh && !shouldDeferBackground(getConfig())
      if (silent ? !modelJudge : modelJudge) return
      const d0 = scoreText(text)
      if (!d0) return
      const d = Math.round(d0 * (direct ? 1 : 0.3) * (owner ? 1.5 : 1))
      nudge(d, `${who || '有人'}说「${clipText(text, 20)}」`, chatId)
    },
    /**
     * 模型判心情（可选）：一轮聊完，看「对方说的 + 她回的」判断心情往哪走。没把握的（confidence < 0.6）不算。
     * origin：user = 有人在跟她说话；speak-up = 她自己主动找人（判她自己的心意，不是被叫来干活）。
     */
    async judge({ userText, reply, who = '对方', origin = 'user', chatId = '' }) {
      const cfg = getConfig().mood
      if (getConfig().debug) return null // 调试模式不判心情（省一次模型调用，也不留下状态）
      if (!cfg.enabled || !cfg.judge || !dsh) return null
      // 峰谷省钱：峰时不跑这次额外模型调用，observe() 已经用关键词兜底；谷时恢复模型判断
      if (shouldDeferBackground(getConfig())) {
        if (!judgeDeferLogged) { log?.debug?.('峰时：心情模型判断推迟到谷时（先用关键词）'); judgeDeferLogged = true }
        return null
      }
      judgeDeferLogged = false
      const v = current()
      const scene = origin === 'speak-up' ? `这一轮是她自己想${who}了、主动去找${who}说话（不是被叫来干活）` : `这一轮是${who}在跟她说话`
      try {
        const out = await askModel(dsh, {
        module: 'mood',
          cfg: getConfig(),
          system: `你在判断聊天角色「${selfName(getConfig())}」聊完一轮后的心情变化。她现在心情 ` + v + '/100（' + base() + ' 是平常）。' + scene + '。只看这一轮真正影响她心情的东西：被夸、被关心、被惦记会开心；被凶、被冷落、被嫌弃会难过。对方明显是在开玩笑、调侃、傲娇或亲昵称呼时（例如「讨厌~」「笨蛋」「坏蛋」「哼」），即使字面带负面词，也不要判成被嘲讽/被嫌弃，按轻松互动给 0 或轻微正向；只有明确恶意、攻击、羞辱或刻意冷落才降心情。只输出 JSON：{"delta": -15~15 的整数, "reason": "十几个字的理由", "confidence": 0~1 你有多确定}。没什么影响就 delta 为 0。',
          text: `${origin === 'speak-up' ? '她主动说' : who + '说'}：${String(userText || '').slice(0, 600)}\n她回：${String(reply || '').slice(0, 600)}`,
          maxTokens: 400,
          temperature: 0.2,
        })
        const r = parseMoodJudge(out)
        if (!r) return null
        if (r.confidence >= 0.6 && Math.abs(r.delta) >= 2) nudge(r.delta, r.reason || '刚才那一下', chatId)
        return r
      } catch (error) {
        return null
      }
    },
    /**
     * 给每一轮的上下文：心情明显偏离平常时，告诉她现在的状态和该怎么说话。
     * chat 传了聊天信息时，只有原因也来自这个聊天才带上「因为…」；旧存档没记来源就只报心情，不猜是谁。
     */
    contextLine(chat) {
      if (!getConfig().mood.enabled) return ''
      const s = load()
      const v = current()
      const label = moodLabel(v)
      const style = MOOD_STYLE[label]
      if (!style) return ''
      const chatId = typeof chat === 'string' ? chat : chat?.chatId
      const reason = chatId && s.reasonChat !== String(chatId) ? '' : moodReason(s, v, base())
      return `（你现在${label}${reason}。这会自然地影响你说话：${style}。不用说出来自己心情如何。）`
    },
  }
}

