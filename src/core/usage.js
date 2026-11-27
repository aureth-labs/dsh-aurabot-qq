// Only provider-reported usage; no text/token estimation and no guessed gateway prices.
import { dataDir, readJson, writeJson } from './store.js'
import { officialCost, REFERENCE_DATE } from './official-reference.js'
import { beijingDayKey } from './offpeak.js'
export const KEEP_DAYS = 90
export const DEFAULT_PRICING = { currency: '元', models: {} }
const DAY_MS = 86_400_000
let state = null
let pricing = DEFAULT_PRICING
let timer = null
let writeFailed = false
const indexed = new Map()
const file = () => dataDir('usage.json')
const count = v => Number.isSafeInteger(v) && v >= 0 ? v : 0
const dayKey = at => beijingDayKey(at)

// Explicit provider + exact model only. A reseller model name does not establish its tariff.
export function priceOf(model, at = Date.now(), p = pricing, provider = '') {
  if (!provider || !model) return null
  const entry = p.models?.[provider + '::' + model] || p.models?.[model]
  if (!entry || entry.peak || entry.match || entry.provider !== provider || (entry.from && at < Date.parse(entry.from))) return null
  if (!['in', 'out', 'cached'].every(k => typeof entry[k] === 'number' && Number.isFinite(entry[k]) && entry[k] >= 0)) return null
  if (entry.from && !Number.isFinite(Date.parse(entry.from))) return null
  return entry
}

// 记账用的模块名：模块 id → 中文；system:xxx 的后台轮次标成「xxx（后台）」
const MODULE_LABELS = {
  memory: '记忆', mood: '心情', diary: '空间日记', purpose: '目的引擎', 'purpose-nudge': '目的引擎（追问）',
  stickers: '表情包', imagegen: '生图', bili: '刷 B 站', heybox: '刷小黑盒', douyin: '刷抖音', video: '生视频',
  voice: '语音', song: '翻唱', pet: '桌宠', profile: '改资料', contacts: '好友申请',
  'qq-tools': 'QQ 工具', 'qq-api': 'QQ 接口', 'group-admin': '群管', 'qzone-social': '空间互动',
  speakup: '主动搭话', bridge: '联动接口', 'bili-vision': 'B 站看画面', persona: '人格生成', 'model-ping': '模型测试', background: '其他后台任务',
}

/**
 * 聊天轮次里「是某个工具干的活」时，把这一步的用量记到工具所属模块名下，别全算成「聊天」。
 * 例：聊天里让她刷 B 站 → 她调 `bili_watch` → 下一步读字幕/热评那次调用算「刷 B 站」。
 * 返回 '' 表示这个工具不属于任何记账模块（就还按「聊天」算）。
 */
export function moduleOfTool(name) {
  const n = String(name || '').trim().toLowerCase()
  if (!n) return ''
  // 名字前缀猜归属（bili_watch → bili）；前缀不是模块 id 的，再看这两张表
  const owner = TOOL_MODULES[n] || n.split('_')[0]
  return MODULE_LABELS[owner] || ''
}

// 工具名 → 模块 id：只收「前缀猜不出来」和「前缀会猜错」的，其余走前缀
const TOOL_MODULES = {
  // bili 模块注册的，但名字是 qq_ 开头（B 站截图）
  qq_send_shot: 'bili',
  qq_list_shots: 'bili',
  qq_draw_image: 'imagegen',
  qq_generate_video: 'video',
  qq_send_sticker: 'stickers',
  qq_collect_sticker: 'stickers',
  qq_add_sticker: 'stickers',
  qq_edit_sticker: 'stickers',
  qq_save_sticker: 'stickers',
  qq_import_qq_stickers: 'stickers',
}

/**
 * 把「聊天 id」或「模块 id」变成记账用的名字。
 *   group:123 / private:456 → 聊天
 *   system:diary / system:bili → 空间日记（后台）/ 刷 B 站（后台）
 *   memory / mood / … → 记忆 / 心情 …
 */
export function moduleLabel(key) {
  const s = String(key || '').trim()
  if (!s) return '其他后台任务'
  if (s.startsWith('system:')) {
    const id = s.slice(7).replace(/^ext-/, '')
    return (MODULE_LABELS[id] || id) + '（后台）'
  }
  if (s.startsWith('group:') || s.startsWith('private:')) return '聊天'
  return MODULE_LABELS[s] || s
}

// 分不出来的就一律记「其他后台任务」，别在主表里摊成一堆看不懂的名字：
//   「后台任务」/「后台会话」/「其它后台」/ 空 → 其他后台任务
//   （打标签之前那批带模型名的 askModel 调用回查下来是记忆模块，单独给个「记忆（回查）」）
export const OTHER_BACKGROUND = '其他后台任务'
const LEGACY_MODULES = {
  后台任务: OTHER_BACKGROUND,
  后台会话: OTHER_BACKGROUND,
  其它后台: OTHER_BACKGROUND,
  其他后台: OTHER_BACKGROUND,
  '旧数据（未分模块）': OTHER_BACKGROUND, // 之前那版归置时写进文件的，统一收回来
}

/** 一行记录该归到哪个模块名下（兼容旧标签；认不出的一律「其他后台任务」）。 */
export function moduleOf(row) {
  const m = String(row?.module || '').trim()
  if (!m) return OTHER_BACKGROUND
  return LEGACY_MODULES[m] || m
}


export function costOf(row, at = row?.at) {
  const p = priceOf(row?.model, at, pricing, row?.provider)
  const written = count(row?.written)
  const unknown = { cost: 0, fresh: 0, cached: 0, output: 0, write: 0, unpriced: true }
  if (!p || (written && !(typeof p.cacheWrite === 'number' && Number.isFinite(p.cacheWrite) && p.cacheWrite >= 0))) return unknown
  const fresh = count(row.in) * p.in / 1e6
  const cached = count(row.cached) * p.cached / 1e6
  const output = count(row.out) * p.out / 1e6
  const write = written ? written * p.cacheWrite / 1e6 : 0
  const cost = fresh + cached + output + write
  return Number.isFinite(cost) ? { cost, fresh, cached, output, write, unpriced: false } : unknown
}

function totalsOf(rows) {
  const t = { runs: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0, unpricedCalls: 0, officialUSD: 0, officialMissing: 0 }
  for (const r of rows) {
    const c = costOf(r)
    t.runs += count(r.runs) || 1
    t.promptTokens += count(r.in) + count(r.cached) + count(r.written)
    t.completionTokens += count(r.out)
    t.cachedTokens += count(r.cached)
    t.cacheWriteTokens += count(r.written)
    const usd = officialCost(r)
    if (usd === null) t.officialMissing += count(r.runs) || 1
    else t.officialUSD += usd
    t.cost += c.cost
    if (c.unpriced) t.unpricedCalls += count(r.runs) || 1
  }
  t.totalTokens = t.promptTokens + t.completionTokens
  t.cacheHitRate = t.promptTokens ? t.cachedTokens / t.promptTokens : null
  // An incomplete subtotal is not a total price. Unknown is never shown as free.
  if (t.officialMissing === t.runs) t.officialUSD = null
  t.pricedCost = t.runs > t.unpricedCalls ? t.cost : null
  if (!t.runs || t.unpricedCalls) t.cost = null
  return t
}
function groupBy(rows, keyOf) {
  const groups = new Map()
  for (const r of rows) {
    const key = keyOf(r)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }
  return [...groups].map(([key, rs]) => ({ key, ...totalsOf(rs) })).sort((a,b) => b.totalTokens-a.totalTokens || a.key.localeCompare(b.key))
}
function prune(now = Date.now()) {
  if (!state) return
  const cut = dayKey(now - (KEEP_DAYS - 1) * DAY_MS)
  for (const [day, rows] of Object.entries(state.days)) if (day < cut) {
    for (const r of rows) if (r.id) indexed.delete(r.id)
    delete state.days[day]
  }
  for (const [id, cursor] of Object.entries(state.sessions)) if (dayKey(cursor.at || 0) < cut) delete state.sessions[id]
}
export function flushUsage() {
  if (timer) clearTimeout(timer)
  timer = null
  if (!state) return
  try { writeJson(file(), state); writeFailed = false } catch { writeFailed = true }
}
export function closeUsage() { flushUsage(); state = null; indexed.clear() }
function saveSoon() {
  if (timer) return
  timer = setTimeout(flushUsage, 1500)
  timer.unref?.()
}
export function initUsage(override) {
  if (state) flushUsage()
  const raw = readJson(file(), {})
  const days = {}
  for (const [day, value] of Object.entries(raw.days || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
    if (Array.isArray(value)) days[day] = value.filter(r => r && Number.isFinite(r.at))
    else {
      // Older totals are already sums: don't divide by calls and lose most of the usage.
      days[day] = Object.entries(value || {}).map(([module, b]) => ({
        at: Date.parse(day + 'T00:00:01+08:00'), module, chat: '', model: '', provider: '',
        in: count(b?.in), out: count(b?.out), cached: count(b?.hit), runs: count(b?.calls) || 1,
      }))
    }
  }
  state = { ...raw, version: 2, startedAt: raw.startedAt || Date.now(), days, sessions: raw.sessions || {} }
  pricing = override && typeof override === 'object' ? { ...DEFAULT_PRICING, ...override } : DEFAULT_PRICING
  indexed.clear()
  prune()
  for (const rows of Object.values(days)) for (const r of rows) if (r.id) indexed.set(r.id, r)
  saveSoon()
  return state
}
export function recordUsage({ module = '其他后台任务', task = '', chat = '', provider = '', model = '', usage, at = Date.now(), id = '' } = {}) {
  if (!state || !usage || !Number.isFinite(at)) return null
  const row = { at, module, chat: String(chat || ''), provider: String(provider || ''), model: String(model || ''),
    in: count(usage.inputTokens), out: count(usage.outputTokens), cached: count(usage.cacheReadTokens), written: count(usage.cacheWriteTokens) }
  const previous = id && indexed.get(id)
  if (!row.in && !row.out && !row.cached && !row.written && !previous) return null
  if (module === '记忆' && typeof task === 'string' && task) row.task = task
  if (id) row.id = id
  if (previous) {
    // A revised settlement replaces the same billable attempt, including its timestamp.
    const oldRows = state.days[dayKey(previous.at)]
    const pos = oldRows?.indexOf(previous) ?? -1
    if (pos >= 0) oldRows.splice(pos, 1)
  }
  ;(state.days[dayKey(at)] ||= []).push(row)
  if (id) indexed.set(id, row)
  prune()
  saveSoon()
  return row
}

// Embedding / rerank endpoints report input-only usage; the endpoint URL is not a billing provider ID.
export function recordRetrievalUsage(task, model, usage) {
  const tokens = usage?.prompt_tokens ?? usage?.total_tokens
  if (count(tokens)) recordUsage({ module: '记忆', task, model, usage: { inputTokens: tokens } })
}

// Mirrors DSH's tokenUsage fold: last settlement wins within a turn/step; retry starts a new charge.
// Stored cursors make a repeated event / a resumed session idempotent without retaining chat content.
export function recordSessionUsage(sessionId, chat, event, target = {}) {
  if (!state || !sessionId || !event || !Number.isSafeInteger(event.seq)) return
  const old = state.sessions[sessionId]
  if (old && event.seq <= old.seq) return
  const c = old || { seq: -1, at: 0, model: '', provider: '', last: null }
  state.sessions[sessionId] = c
  c.seq = event.seq
  c.at = Number.isFinite(event.time) ? event.time : Date.now()
  const d = event.data || {}
  if (event.type === 'model/selection') { c.provider = d.provider || ''; c.model = d.model || '' }
  if (event.type === 'request/header') {
    const cfg = d.header?.config
    if (cfg?.provider) c.provider = cfg.provider
    if (cfg?.model) c.model = cfg.model
  }
  if (event.type === 'tool/call') c.tool = { module: moduleOfTool(d.name), turn: d.turn }
  if (event.type === 'llm/retry-started' && c.last?.turn === d.turn && c.last?.step === d.step) c.last = null
  if (event.type === 'assistant/message' || event.type === 'assistant/attempt' || event.type === 'compaction/summary') {
    const chunks = Array.isArray(d.stream) ? d.stream : d.stream?.chunks
    const usage = d.usage ?? (Array.isArray(chunks) ? chunks.findLast(x => x?.type === 'usage')?.usage : null)
    const summary = event.type === 'compaction/summary'
    if (usage) {
      const replaces = !summary && c.last?.turn === d.turn && c.last?.step === d.step
      const id = replaces ? c.last.id : sessionId + ':' + event.seq
      const module = summary ? '对话整理' : (replaces ? indexed.get(id)?.module : '') || (!chat.startsWith('system:') && c.tool?.turn === d.turn ? c.tool.module : '') || moduleLabel(chat)
      recordUsage({ id, chat, module,
        model: summary ? d.model || '' : c.model || target.model || '',
        provider: summary ? d.provider || '' : c.provider || target.provider || '', usage, at: c.at })
      if (!summary) { c.last = { turn: d.turn, step: d.step, id }; c.tool = null }
    }
  }
  // Only numeric accounting metadata is persisted, never event messages or headers.
  saveSoon()
}
export function usageReport({ now = Date.now(), range = '7' } = {}) {
  prune(now)
  const all = Object.values(state?.days || {}).flat().filter(r => r.at <= now)
  const startToday = Date.parse(dayKey(now) + 'T00:00:00+08:00')
  const bounds = { today: [startToday, now], yesterday: [startToday - DAY_MS, startToday - 1],
    '7': [startToday - 6 * DAY_MS, now], '30': [startToday - 29 * DAY_MS, now], all: [0, now] }
  const pick = Object.hasOwn(bounds, String(range)) ? String(range) : '7'
  const rowsFor = key => all.filter(r => r.at >= bounds[key][0] && r.at <= bounds[key][1])
  const rows = rowsFor(pick)
  return {
    referenceDate: REFERENCE_DATE, currency: pricing.currency || '元', days: KEEP_DAYS, range: pick, startedAt: state?.startedAt,
    firstRecordAt: all.length ? all.reduce((n,r) => Math.min(n,r.at), Infinity) : null,
    writeFailed,
    ranges: Object.fromEntries([['today','today'],['yesterday','yesterday'],['last7','7'],['last30','30'],['all','all']].map(([label,key]) => [label,totalsOf(rowsFor(key))])),
    current: { ...totalsOf(rows),
      byChat: groupBy(rows.filter(r => /^(group|private):/.test(r.chat || '')), r => r.chat),
      background: totalsOf(rows.filter(r => !/^(group|private):/.test(r.chat || ''))),
      byModule: groupBy(rows, moduleOf),
      byMemoryTask: groupBy(rows.filter(r => moduleOf(r) === '记忆'), r => r.task || '未细分'),
      byModel: groupBy(rows, r => [r.provider, r.model].filter(Boolean).join(' / ') || '未记录模型'),
    },
  }
}
