// SPDX-License-Identifier: MIT
// Source-grounded conversation recall. Generated replies remain labelled replies,
// never promoted to facts about a person. This module makes no model/network calls.
import { randomUUID, createHash } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync, appendFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const POINTER = /然后|后来|那个|这个|那件|这件|当时|刚才|继续|上次|之前|还记得|接着|\b(it|that|then|continue|previous|earlier)\b/i
const RESET = /^(换个话题|另一个问题|不说这个|先不聊|new topic\b)/i
const STOP = new Set(['然后', '后来', '那个', '这个', '什么', '怎么', '之前', '刚才', '我们', '你们', '他们', '一下', '记得', '时候'])
export const clip = (text, length) => Array.from(String(text || '')).slice(0, Math.max(0, length)).join('')

export function terms(text) {
  const normalized = String(text || '').normalize('NFKC').toLowerCase()
  const result = normalized.match(/[a-z0-9][a-z0-9_+.-]*/g) || []
  for (const run of normalized.match(/[\p{Script=Han}]+/gu) || []) {
    for (let i = 0; i + 1 < run.length; i++) if (!STOP.has(run.slice(i, i + 2))) result.push(run.slice(i, i + 2))
  }
  return result
}

export function queriesFor(query, recent = []) {
  const current = String(query || '').trim()
  if (!current) return []
  const result = [clip(current, 600)]
  const hasNamedTopic = /[a-z][a-z0-9_+.-]{2,}/i.test(current) || terms(current).length >= 2
  if (RESET.test(current) || (!POINTER.test(current) && hasNamedTopic)) return result
  // Most recent user cues have priority. Assistant text is only a last-resort
  // discourse cue and is never evidence for a user/prototype fact.
  const users = recent.filter(m => m.role === 'user' && m.text).slice(-3).reverse()
  for (const m of users) if (terms(m.text).length) result.push(clip(m.text, 400))
  if (result.length === 1) {
    const last = recent.filter(m => m.role === 'assistant' && m.text).at(-1)
    if (last) result.push(clip(last.text, 250))
  }
  return [...new Set(result)].slice(0, 4)
}

/** BM25 over independent query variants, reciprocal-rank fusion, and diversity. */
export function retrieve(queries, documents, { limit = 6, textOf = d => d.text, eligible = () => true } = {}) {
  const docs = documents.filter(eligible).map(item => {
    // 片段的分词结果可以随片段对象缓存（群里每轮都要对几千个片段重新分词，占大半时间）
    const words = item._terms || terms(textOf(item)), tf = new Map()
    for (const word of words) tf.set(word, (tf.get(word) || 0) + 1)
    return { item, tf, length: words.length || 1 }
  })
  const df = new Map(), avg = docs.reduce((n, d) => n + d.length, 0) / (docs.length || 1)
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1)
  const fused = new Map()
  queries.forEach((query, qi) => {
    const words = [...new Set(terms(query))]
    const hits = docs.map(d => {
      let score = 0
      for (const word of words) {
        const f = d.tf.get(word) || 0
        if (f) score += Math.log(1 + (docs.length - df.get(word) + .5) / (df.get(word) + .5)) * f * 2.2 / (f + 1.2 * (.25 + .75 * d.length / avg))
      }
      return { d, score }
    }).filter(h => h.score >= (docs.length < 4 ? .1 : .45)).sort((a, b) => b.score - a.score).slice(0, 30)
    hits.forEach((h, i) => {
      const previous = fused.get(h.d.item) || { item: h.d.item, score: 0, lexical: 0, tf: h.d.tf }
      previous.score += (qi === 0 ? 2.5 : .65) / (30 + i + 1)
      previous.lexical = Math.max(previous.lexical, h.score)
      fused.set(h.d.item, previous)
    })
  })
  const selected = []
  for (const hit of [...fused.values()].sort((a, b) => b.score - a.score || b.lexical - a.lexical)) {
    const duplicate = selected.some(other => {
      let shared = 0
      for (const t of hit.tf.keys()) if (other.tf.has(t)) shared++
      const overlap = shared / (hit.tf.size + other.tf.size - shared || 1)
      // Keep versions of a fact: similar wording can contain a crucial negation.
      return overlap > .94 && String(textOf(hit.item)) === String(textOf(other.item))
    })
    if (!duplicate) selected.push(hit)
    if (selected.length >= limit) break
  }
  return selected.map(h => ({ ...h.item, retrievalScore: h.score }))
}

export function packEvidence(items, render, maxCharacters = 4000) {
  const result = [], selected = []
  let used = 0
  for (const item of items) {
    const line = render(item), size = Array.from(line).length + 1
    // Do not cut JSON/source records in half, and try smaller remaining records.
    if (used + size > maxCharacters) continue
    result.push(line); selected.push(item); used += size
  }
  return { text: result.join('\n'), selected, characters: Math.max(0, used - 1) }
}

export function recentWithin(messages, maxCharacters = 6000) {
  const result = []; let used = 0
  // Preserve complete user/assistant exchanges. A final outstanding user message
  // is also retained as a complete unit. Oversized units are skipped, not sliced.
  const units = []
  for (const message of messages) {
    if (message.role === 'user' || !units.length) units.push([])
    units.at(-1).push(message)
  }
  for (const unit of units.reverse()) {
    const size = unit.reduce((n, m) => n + Array.from(m.text || '').length, 0)
    if (used + size > maxCharacters) break
    result.unshift(...unit); used += size
  }
  return result
}

/** Durable, persona- and chat-isolated archive; append-only journal is the source. */
export function createConversationArchive({ directory, namespace = 'default', now = Date.now, visible = () => true, visibleKey = null } = {}) {
  if (!directory) throw new Error('Conversation archive directory required')
  const cache = new Map()
  const keyFor = chatId => createHash('sha256').update(namespace + '\0' + String(chatId)).digest('hex')
  function state(chatId) {
    if (!/^(private|group):[^\s:]+$/.test(String(chatId))) throw new Error('Invalid conversation identity')
    const key = keyFor(chatId)
    if (cache.has(key)) return cache.get(key)
    const journal = join(directory, key + '.jsonl'), checkpoint = join(directory, key + '.json')
    const exclusions = join(directory, key + '.excluded.json')
    const excluded = new Set(existsSync(exclusions) ? JSON.parse(readFileSync(exclusions, 'utf8')) : [])
    const value = { journal, checkpoint, exclusions, excluded, messages: [], revision: 0 }
    // Recover from the journal, including a turn appended before a checkpoint
    // write was interrupted. Reject malformed committed lines rather than reset.
    if (existsSync(journal)) {
      const raw = readFileSync(journal, 'utf8'), lines = raw.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue
        try { value.messages.push(JSON.parse(lines[i])) }
        catch (error) {
          if (i !== lines.length - 1) throw new Error('Conversation journal is corrupt; preserving source')
          throw new Error('Conversation journal has an incomplete tail; preserving source for recovery')
        }
      }
    }
    cache.set(key, value); return value
  }
  function append(chatId, { role, text, id = randomUUID(), speakerId = '', at = now(), contextAt = at, contextId }) {
    if (!['user', 'assistant'].includes(role)) throw new Error('Invalid conversation role')
    const value = state(chatId), body = String(text || '').trim()
    if (!body || value.messages.some(m => m.id === id)) return false
    const message = { ...(contextId ? { contextId } : {}), id, role, text: body, speakerId: String(speakerId), at: Number(at) || now(), contextAt: Number(contextAt) || Number(at) || now() }
    mkdirSync(directory, { recursive: true })
    appendFileSync(value.journal, JSON.stringify(message) + '\n', { encoding: 'utf8', mode: 0o600 })
    value.messages.push(message); value.revision++
    // Checkpoint is inspectable metadata, not a second source of truth.
    const temp = value.checkpoint + '.' + process.pid + '.tmp'
    writeFileSync(temp, JSON.stringify({ version: 1, namespace, chatId, messages: value.messages.length, lastId: id }), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, value.checkpoint)
    return true
  }
  const available = chatId => {
    const value = state(chatId)
    return value.messages.filter(m => !value.excluded.has(m.contextId) && visible(chatId, m))
  }
  function recent(chatId, limit = 32) {
    const count = Math.max(0, Math.min(256, Math.trunc(Number(limit) || 0)))
    return count ? available(chatId).slice(-count).map(m => ({ ...m })) : []
  }
  // 群聊每轮都会重算「相关较早片段」，语密的群历史能到几万条：整份重切要逐条 JSON.stringify，
  // 卡在回合开头（#520 之后群里一开口就慢）。这里按聊天缓存切块结果，只补追加的尾部；
  // 可见性规则或清理记忆截止时间一变就整份重建（visibleKey 由宿主给）。
  // 窗口设上限：超过后只保留最近 EPISODE_SCAN_MAX 条参与召回，避免历史越长每轮越慢。
  const episodeCache = new Map() // `${chatId}|${maxCharacters}` → { vis, start, consumed, list, block, serializedSize }
  const EPISODE_CACHE_MAX = 16
  const EPISODE_SCAN_MAX = 20_000
  // 窗口起点按步长对齐：否则每来一条消息窗口就滑动一格，缓存全废、整份重切。
  const EPISODE_WINDOW_STEP = 2_000
  const viewStamp = (chatId) => {
    if (!visibleKey) return ''
    try { return String(visibleKey(chatId)) } catch (error) { return 'error:' + error.message }
  }
  function episodeOf (block) {
    return { id: 'conversation-' + block[0].id, at: block[0].at, source: 'new_conversation',
      visibility: 'same_conversation', evidence_ids: block.map(m => m.id), context: block.map(m => ({ ...m })),
      text: block.map(m => `${m.role}: ${m.text}`).join('\n') }
  }
  function episodes(chatId, { maxCharacters = 2000 } = {}) {
    const value = state(chatId)
    // Reserve the episode wrapper and evidence IDs. Split at source-message
    // boundaries, so a large paste cannot hide its small neighboring facts.
    const recordBudget = Math.max(1, maxCharacters - 256)
    const vis = viewStamp(chatId)
    const key = chatId + '|' + maxCharacters
    const overflow = value.messages.length - EPISODE_SCAN_MAX
    const start = overflow <= 0 ? 0 : Math.floor(overflow / EPISODE_WINDOW_STEP) * EPISODE_WINDOW_STEP
    let entry = episodeCache.get(key)
    episodeCache.delete(key) // 命中与否都重插到队尾，当 LRU 用
    if (!entry || entry.vis !== vis || entry.start !== start || entry.consumed > value.messages.length) {
      entry = { vis, start, consumed: start, list: [], block: [], serializedSize: 0 }
    }
    const emit = () => {
      if (!entry.block.length) return
      entry.list.push(episodeOf(entry.block)); entry.block = []; entry.serializedSize = 0
    }
    for (let i = entry.consumed; i < value.messages.length; i++) {
      const m = value.messages[i]
      entry.consumed = i + 1
      if (value.excluded.has(m.contextId) || !visible(chatId, m)) continue
      const size = JSON.stringify(m).length + JSON.stringify(m.id).length + 2
      const block = entry.block
      if (block.length && (m.at - block.at(-1).at > 30 * 60_000 || (m.role === 'user' && block.length >= 8) || entry.serializedSize + size > recordBudget)) emit()
      entry.block.push(m); entry.serializedSize += size
      if (entry.serializedSize >= recordBudget) emit()
    }
    episodeCache.set(key, entry)
    while (episodeCache.size > EPISODE_CACHE_MAX) episodeCache.delete(episodeCache.keys().next().value)
    // 尾部那段还开着（下一条可能接着进同一段），返回时只临时包一层，不改缓存状态。
    return entry.block.length ? [...entry.list, episodeOf(entry.block)] : entry.list.slice()
  }
  // 每轮的预算过滤也要把每个片段重新 stringify 一遍，几千个片段就是几百毫秒。
  // 片段内容不随查询变，只有「含近期窗口里那些消息」的片段才需要重算，其余记下长度复用。
  const renderCache = new WeakMap() // episode → 全量渲染字数
  function recall(chatId, query, { maxCharacters = 4000, recentMessages = recent(chatId), excludeIds = [] } = {}) {
    const excluded = new Set([...excludeIds, ...recentMessages.map(m => m.id)])
    const render = e => JSON.stringify({ id: e.id, source: e.source, evidence_ids: e.evidence_ids, context: e.context })
    const docs = []
    for (const e of episodes(chatId, { maxCharacters: Math.min(2000, maxCharacters) })) {
      if (e.context.some(m => excluded.has(m.id))) {
        const context = e.context.filter(m => !excluded.has(m.id))
        const doc = { ...e, context, evidence_ids: context.map(m => m.id), text: context.map(m => `${m.role}: ${m.text}`).join('\n') }
        if (render(doc).length <= maxCharacters) docs.push(doc)
        continue
      }
      let cached = renderCache.get(e)
      if (!cached) {
        cached = { chars: render(e).length }
        renderCache.set(e, cached)
      }
      if (cached.chars <= maxCharacters) {
        if (!e._terms) Object.defineProperty(e, '_terms', { value: terms(e.text), enumerable: false, configurable: true })
        docs.push(e)
      }
    }
    const hits = retrieve(queriesFor(query, recentMessages), docs, { limit: 6 })
    return packEvidence(hits, render, maxCharacters)
  }
  function excludeContext(chatId, contextId) {
    const value = state(chatId)
    if (value.excluded.has(contextId)) return
    const next = new Set(value.excluded).add(contextId)
    mkdirSync(directory, { recursive: true })
    const temp = value.exclusions + '.' + process.pid + '.tmp'
    writeFileSync(temp, JSON.stringify([...next]), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, value.exclusions)
    value.excluded = next
    for (const key of episodeCache.keys()) if (key.startsWith(chatId + '|')) episodeCache.delete(key)
  }
  return { append, recent, recall, episodes, excludeContext }
}
