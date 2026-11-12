// 陪伴类小功能：心情、主动搭话。

import { randomUUID } from 'node:crypto'
import { dataDir, readJson, writeJson } from '../core/store.js'
import { askModel } from '../core/llm.js'
import { cleanText, clipText } from '../core/text.js'
import { shouldDeferBackground } from '../core/offpeak.js'
import { followUpHint } from './memory.js'
import { moodReason } from './mood-context.js'
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
  const load = () => readJson(file(), () => ({ value: base(), at: Date.now(), reason: '', history: [] }))
  const save = (s) => writeJson(file(), s)
  const current = () => {
    const s = load()
    return Math.round(decayed(s.value, s.at, getConfig().mood.halfLifeHours, Date.now(), base()))
  }
  /** 推一下心情（d 可正可负），记下原因。 */
  function nudge(d, reason) {
    if (getConfig().debug) return // 调试模式不动心情：心情是持久状态，调试不该留下痕迹
    if (!getConfig().mood.enabled || !d) return
    const s = load()
    const before = current()
    s.value = Math.max(5, Math.min(100, before + d))
    s.at = Date.now()
    reason = cleanText(reason)
    s.reason = reason
    s.reasonAt = s.at
    // 保留 200 条：20 条只够两小时，出问题查不到原因（实测需要回溯半天以上）
    s.history = [{ at: Date.now(), from: before, to: Math.round(s.value), reason }, ...(s.history || [])].slice(0, 200)
    save(s)
    try { log?.debug?.(`心情 ${before} → ${Math.round(s.value)}（${d > 0 ? '+' : ''}${d}）：${reason}`) } catch (error) {}
  }
  return {
    current,
    label: () => moodLabel(current()),
    state: () => ({ ...load(), value: current(), label: moodLabel(current()) }),
    effects: () => (getConfig().mood.enabled ? moodEffects(current()) : moodEffects(base())),
    nudge,
    /**
     * 聊天里的一句话。direct = 是对她说的（私聊、@她、叫她）；owner = 主人说的。
     * 不是对她说的群聊只算三成，主人的话算 1.5 倍。
     */
    observe(text, who, { direct = true, owner = false, silent = false } = {}) {
      // 开了模型判断就不用关键词；但峰时省钱模式会把模型判断推迟到谷时，这时退回关键词，心情照样有起伏
      const modelJudge = getConfig().mood.judge && dsh && !shouldDeferBackground(getConfig())
      if (silent ? !modelJudge : modelJudge) return
      const d0 = scoreText(text)
      if (!d0) return
      const d = Math.round(d0 * (direct ? 1 : 0.3) * (owner ? 1.5 : 1))
      nudge(d, `${who || '有人'}说「${clipText(text, 20)}」`)
    },
    /**
     * 模型判心情（可选）：一轮聊完，看「对方说的 + 她回的」判断心情往哪走。没把握的（confidence < 0.6）不算。
     * origin：user = 有人在跟她说话；speak-up = 她自己主动找人（判她自己的心意，不是被叫来干活）。
     */
    async judge({ userText, reply, who = '对方', origin = 'user' }) {
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
          system: `你在判断聊天角色「${selfName(getConfig())}」聊完一轮后的心情变化。她现在心情 ` + v + '/100（' + base() + ' 是平常）。' + scene + '。只看这一轮真正影响她心情的东西：被夸、被关心、被惦记会开心；被凶、被冷落、被嫌弃会难过；开玩笑的「讨厌~」「笨蛋」不算真骂。只输出 JSON：{"delta": -15~15 的整数, "reason": "十几个字的理由", "confidence": 0~1 你有多确定}。没什么影响就 delta 为 0。',
          text: `${origin === 'speak-up' ? '她主动说' : who + '说'}：${String(userText || '').slice(0, 600)}\n她回：${String(reply || '').slice(0, 600)}`,
          maxTokens: 400,
          temperature: 0.2,
        })
        const r = parseMoodJudge(out)
        if (!r) return null
        if (r.confidence >= 0.6 && Math.abs(r.delta) >= 2) nudge(r.delta, r.reason || '刚才那一下')
        return r
      } catch (error) {
        return null
      }
    },
    /** 给每一轮的上下文：心情明显偏离平常时，告诉她现在的状态和该怎么说话。 */
    contextLine() {
      if (!getConfig().mood.enabled) return ''
      const s = load()
      const v = current()
      const label = moodLabel(v)
      const style = MOOD_STYLE[label]
      if (!style) return ''
      return `（你现在${label}${moodReason(s, v, base())}。这会自然地影响你说话：${style}。不用说出来自己心情如何。）`
    },
  }
}

// ---------------- 主动搭话 ----------------

export function createSpeakUp({ getConfig, hub, log, isMuted, memory }) {
  const file = () => dataDir('speakup.json')
  const load = () => readJson(file(), () => ({ day: '', count: 0, nextAt: 0, last: 0 }))
  const save = (s) => writeJson(file(), s)

  // ---------------- 她的小闹钟 ----------------
  // 每条提醒都是她自己在对话里设的一次性闹钟；到点只负责把她叫醒，不直接替她发消息。
  const REMINDER_FILE = 'speakup-reminders.json'
  const REMINDER_GRACE_MS = 15 * 60_000
  const REMINDER_RETRY_MS = 5 * 60_000
  const REMINDER_WAIT_MS = 4 * 60_000
  let reminderBusy = false

  const reminderFile = () => dataDir(REMINDER_FILE)
  const two = (n) => String(n).padStart(2, '0')
  const reminderText = (at) => {
    const d = new Date(at)
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
  }
  function parseReminderTime(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(String(value || '').trim())
    if (!m) return 0
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0)
    if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])
      || d.getHours() !== Number(m[4]) || d.getMinutes() !== Number(m[5])) return 0
    return d.getTime()
  }
  function normalizeReminder(raw) {
    if (!raw || typeof raw !== 'object') return null
    const id = String(raw.id || '').trim()
    const at = Number(raw.at)
    const note = String(raw.note || '').trim().slice(0, 500)
    if (!id || !Number.isFinite(at) || !note) return null
    return {
      id,
      at,
      atText: String(raw.atText || '').trim() || reminderText(at),
      note,
      createdAt: Number(raw.createdAt) || at,
      attempts: Math.max(0, Math.round(Number(raw.attempts) || 0)),
      nextAt: Number(raw.nextAt) || at,
      expiresAt: Number(raw.expiresAt) || at + REMINDER_GRACE_MS,
      lastError: String(raw.lastError || '').slice(0, 180),
    }
  }
  function loadReminders() {
    const raw = readJson(reminderFile(), () => [])
    return (Array.isArray(raw) ? raw : []).map(normalizeReminder).filter(Boolean)
  }
  function saveReminders(list) { writeJson(reminderFile(), list) }
  function pruneReminders(now = Date.now()) {
    const raw = loadReminders()
    const live = raw.filter((r) => r.expiresAt > now)
    if (live.length !== raw.length) saveReminders(live)
    return live
  }
  function reminderList(now = Date.now()) {
    return pruneReminders(now).sort((a, b) => a.at - b.at)
  }
  function addReminder(value, noteText) {
    const cfg = getConfig()
    if (!cfg.enabled || cfg.speakUp?.enabled === false) return { ok: false, message: '主动搭话没开启' }
    if (!cfg.speakUp?.reminderEnabled) return { ok: false, message: '小闹钟没开启' }
    const at = parseReminderTime(value)
    if (!at) return { ok: false, message: '时间格式不对，要用 yyyy-mm-dd HH:MM，例如 2026-11-12 17:30' }
    const now = Date.now()
    if (at <= now) return { ok: false, message: '这个时间已经过去了，请设一个将来的时间' }
    const note = String(noteText || '').trim().slice(0, 500)
    if (!note) return { ok: false, message: '要提醒自己什么？把想说的话写进 note' }
    const live = pruneReminders(now)
    if (live.length >= (cfg.speakUp.reminderLimit ?? 5)) return { ok: false, message: '你设定的提醒太多了' }
    const reminder = {
      id: randomUUID(),
      at,
      atText: reminderText(at),
      note,
      createdAt: now,
      attempts: 0,
      nextAt: at,
      expiresAt: at + REMINDER_GRACE_MS,
      lastError: '',
    }
    saveReminders([...live, reminder])
    log.info(`小闹钟：${reminder.atText} ${note}`)
    return { ok: true, id: reminder.id, at: reminder.atText, message: `已记下，${reminder.atText} 叫醒你` }
  }
  function closeReminder(id) {
    const key = String(id || '').trim()
    const live = pruneReminders()
    if (!key || !live.some((r) => r.id === key)) return { ok: false, message: '没找到这个提醒，可能已经过期或关闭了' }
    saveReminders(live.filter((r) => r.id !== key))
    return { ok: true, message: '这个小闹钟已关闭' }
  }
  function reminderPrompt(reminder, owner) {
    return `【系统提醒，不是${owner}说的话】你之前给自己定的小闹钟到时间了：${reminder.atText}「${reminder.note}」。现在可以主动找${owner}说这件事；如果你觉得现在不适合打扰，就只回 [沉默]。`
  }
  async function attemptReminder(reminder, now = Date.now()) {
    const cfg = getConfig()
    const owner = String(cfg.ownerQQ || '')
    if (!owner || !cfg.enabled || cfg.speakUp?.enabled === false || !cfg.speakUp?.reminderEnabled) return
    const chatId = `private:${owner}`
    const outcome = await new Promise((resolve) => {
      let settled = false
      const timer = setTimeout(() => finish({ ok: false, error: '等回复超时' }), REMINDER_WAIT_MS)
      timer.unref?.()
      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result || { ok: false, error: '没有结果' })
      }
      try {
        const waiting = hub.pushToSession(
          { chatId, kind: 'private', userId: owner, nickname: cfg.ownerName || '主人' },
          [{ type: 'text', text: reminderPrompt(reminder, cfg.ownerName || '主人') }],
          '',
          { onTurnEnd: finish },
        )
        Promise.resolve(waiting).catch((error) => finish({ ok: false, error: error?.message || String(error) }))
      } catch (error) {
        finish({ ok: false, error: error?.message || String(error) })
      }
    })
    const live = loadReminders()
    const current = live.find((r) => r.id === reminder.id)
    if (!current) return
    if (outcome.ok) {
      saveReminders(live.filter((r) => r.id !== reminder.id))
      log.info(`小闹钟触发：${reminder.atText} ${reminder.note}`)
      return
    }
    const retry = cfg.speakUp?.reminderRetry !== false
    const at = Date.now()
    if (!retry) {
      saveReminders(live.filter((r) => r.id !== reminder.id))
      log.warn(`小闹钟放弃：${reminder.atText} ${outcome.error || '触发失败'}`)
      return
    }
    // 第一次失败后从现在起保留 15 分钟；之后每 5 分钟再试。
    if (current.attempts === 0) current.expiresAt = at + REMINDER_GRACE_MS
    if (at + REMINDER_RETRY_MS >= current.expiresAt) {
      saveReminders(live.filter((r) => r.id !== reminder.id))
      log.warn(`小闹钟放弃：${reminder.atText} ${outcome.error || '触发失败'}`)
      return
    }
    current.attempts += 1
    current.nextAt = at + REMINDER_RETRY_MS
    current.lastError = String(outcome.error || '触发失败').slice(0, 180)
    saveReminders(live)
    log.warn(`小闹钟触发失败，5 分钟后重试：${reminder.atText}（${current.lastError}）`)
  }
  async function tickReminders(now = Date.now()) {
    if (reminderBusy) return false
    const cfg = getConfig()
    if (!cfg.enabled || cfg.speakUp?.enabled === false || !cfg.speakUp?.reminderEnabled) return false
    const due = reminderList(now).find((r) => r.nextAt <= now)
    if (!due) return false
    reminderBusy = true
    try { await attemptReminder(due, now) } finally { reminderBusy = false }
    return true
  }

  function schedule(s, cfg) {
    const min = cfg.minIntervalMinutes
    const max = cfg.maxIntervalMinutes
    s.nextAt = Date.now() + (min + Math.random() * (max - min)) * 60_000
  }

  // 私聊里的「最近一次来往」：只看和主人的私聊，群里再热闹也不影响她想你
  const lastPrivateAt = () => Math.max(hub.lastOwnerChatAt || 0, hub.lastBotToOwner?.at || 0)

  // 每次换个由头，免得句句都是「在干嘛」
  const ANGLES = [
    '分享一件你今天遇到的小事或想到的东西',
    '接着你们上次聊的话题，问问后来怎么样了',
    '想起记忆里关于对方的一件事，顺口提一句或关心一下',
    '问问对方现在在干嘛、吃了没、累不累',
    '撒个娇或者吐槽一句，说你有点无聊',
    '随手发个表情包或者一句没头没尾的感慨',
    '看看现在几点，按时间说点应景的（早上、饭点、深夜）',
  ]

  function followUpReceipt(item) {
    let counted = false
    return item ? { onDelivered() {
      if (counted) return
      counted = true
      memory?.()?.markFollowUpAsked?.(item.id)
    } } : {}
  }

  async function fire(reason = '定时', { nudge = false } = {}) {
    const cfg = getConfig()
    if (!cfg.enabled || !cfg.speakUp.enabled || !cfg.ownerQQ || isMuted?.(`private:${cfg.ownerQQ}`) || memory?.()?.dislikes?.(cfg.ownerQQ)) return
    const followUp = !nudge ? memory?.()?.dueFollowUp?.(cfg.ownerQQ) : null
    const owner = cfg.ownerName || '主人'
    const idle = Math.round((Date.now() - lastPrivateAt()) / 60000)
    const angle = ANGLES[Math.floor(Math.random() * ANGLES.length)]
    const prompt = nudge
      ? `【系统提醒，不是${owner}说的话】你刚才跟${owner}说「${String(hub.lastBotToOwner?.text || '').slice(-60)}」，${owner}已经 ${idle} 分钟没回了。可以轻轻追一句（比如「人呢」「睡着啦？」，或者换个话题），别催、别抱怨；觉得${owner}在忙就只回 [沉默]。`
      : `【系统提醒，不是${owner}说的话】你已经 ${idle > 600 ? '很久' : idle + ' 分钟'}没和${owner}私聊了，想主动找${owner}说点什么。这次的由头可以是：${angle}。优先用手里真实的素材（最近做过的事、记忆里的、聊天流水里能查到的），没有真实素材就别硬找，也不要编；用你自己的口气，一两句就好，别用模板、别解释为什么来找；实在不想说就只回 [沉默]。`
    log.info(`主动搭话（${reason}）`)
    await hub.pushToSession({ chatId: `private:${cfg.ownerQQ}`, kind: 'private', userId: cfg.ownerQQ, nickname: owner }, [{ type: 'text', text: [prompt, followUpHint(followUp)].filter(Boolean).join('\n') }], '', followUpReceipt(followUp))
  }

  /** 找白名单里的人：不提主人的事，这是她和对方自己的聊天。 */
  async function fireFriend(qq) {
    const cfg = getConfig()
    if (!cfg.enabled || !cfg.speakUp.enabled || !(cfg.speakUp.allow || []).map(String).includes(String(qq)) || isMuted?.(`private:${qq}`) || memory?.()?.dislikes?.(qq)) return
    const followUp = memory?.()?.dueFollowUp?.(qq)
    const idle = Math.round((Date.now() - (hub.lastPrivateAt?.(qq) || 0)) / 60000)
    const angle = ANGLES[Math.floor(Math.random() * ANGLES.length)]
    const prompt = `【系统提醒，不是对方说的话】你已经 ${idle > 600 ? '很久' : idle + ' 分钟'}没和这位朋友私聊了，想主动找对方说点什么。这次的由头：${angle}。只说你和对方之间的事，别提主人或别人的私事。`
    log.info(`主动搭话（白名单 ${qq}）`)
    await hub.pushToSession({ chatId: `private:${qq}`, kind: 'private', userId: qq, nickname: qq }, [{ type: 'text', text: [prompt, followUpHint(followUp)].filter(Boolean).join('\n') }], '', followUpReceipt(followUp))
  }

  /** 白名单：每人单独算次数和间隔，一分钟最多找一个人，不一口气群发。 */
  async function tickFriends(cfg, s) {
    const c = cfg.speakUp
    const h = new Date().getHours()
    if (!(h >= c.awakeFrom && h < c.awakeTo)) return false
    const today = new Date().toDateString()
    s.friends = s.friends || {}
    for (const qq of c.allow || []) {
      if (String(qq) === String(cfg.ownerQQ) || isMuted?.(`private:${qq}`) || memory?.()?.dislikes?.(qq)) continue
      const f = s.friends[qq] || (s.friends[qq] = {})
      if (f.day !== today) Object.assign(f, { day: today, count: 0 })
      if (!f.nextAt) schedule(f, c)
      if (Date.now() - (hub.lastPrivateAt?.(qq) || 0) > c.idleMinutes * 60_000 && f.count < c.maxPerDay && Date.now() >= f.nextAt) {
        f.count++
        schedule(f, c)
        save(s)
        await fireFriend(qq)
        return true
      }
    }
    return false
  }

  async function tick() {
    const cfg = getConfig()
    const c = cfg.speakUp
    if (!cfg.enabled || !c.enabled) return
    if (await tickReminders()) return
    if (cfg.ext?.purpose?.enabled === true) return // 目的引擎开着时由它主动找人，两套都跑同一个人会被找两次
    if (isMuted?.(`private:${cfg.ownerQQ}`) || memory?.()?.dislikes?.(cfg.ownerQQ)) { // 主人在私聊里让她闭嘴了：只管主人这边，白名单照旧
      const s = load()
      if (!(await tickFriends(cfg, s))) save(s)
      return
    }
    const s = load()
    const today = new Date().toDateString()
    if (s.day !== today) Object.assign(s, { day: today, count: 0 })
    if (!s.nextAt) schedule(s, c)
    const h = new Date().getHours()
    const awake = h >= c.awakeFrom && h < c.awakeTo
    const idleOk = Date.now() - lastPrivateAt() > c.idleMinutes * 60_000
    // 追问：她最后一句是在问主人、主人 15~40 分钟没回，有一半的机会轻轻追一句（每句最多追一次，不占每天的次数）
    const lb = hub.lastBotToOwner || { at: 0, text: '' }
    const quiet = Date.now() - lb.at
    if (awake && c.nudge && lb.at > (hub.lastOwnerChatAt || 0) && lb.at !== s.nudgedFor && /[？?]|吗|呢|嘛|没$/.test(lb.text.trim()) && quiet > 15 * 60_000 && quiet < 40 * 60_000) {
      s.nudgedFor = lb.at
      save(s)
      if (Math.random() < 0.5) await fire('追问', { nudge: true })
      return
    }
    if (awake && idleOk && s.count < c.maxPerDay && Date.now() >= s.nextAt) {
      s.count++
      s.last = Date.now()
      schedule(s, c)
      save(s)
      await fire()
      return
    }
    if (!(await tickFriends(cfg, s))) save(s)
  }

  return {
    tick,
    fire,
    state: () => ({ ...load(), reminders: reminderList() }),
    reminders: reminderList,
    addReminder,
    closeReminder,
  }
}
