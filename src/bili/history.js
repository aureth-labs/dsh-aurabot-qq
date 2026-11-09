// B 站这边「看了什么」的数据层：日报 / 封面墙 / 肥鱼日记。
//
// 设计原则（跟参考实现一致）：
//  ① 只存**原始事实**（时间、BV、标题、封面、UP、时长、播放量、挑中还是跳过 + 原因）。
//     分组、筛选、统计一律在渲染时算 —— 以后想改分组规则不用重写历史。
//  ② 缺的字段**不编**：老记录没封面就先留空，界面显示占位，不假装有。
//
// 存储：`<data>/bili-history.jsonl`，一行一条，按 (day, bvid) 去重（后来者覆盖先来者）。
// 为什么不塞进 bili.json：那份是「今天跑了几轮、发了几条」的当日状态，会被反复覆盖；
// 历史是要长期留的，混在一起迟早被覆盖掉。

import { readFileSync, writeFileSync, appendFileSync, existsSync, statSync, renameSync, readdirSync } from 'node:fs'
import { dataDir, ensureDir } from '../core/store.js'

const historyFile = () => dataDir('bili-history.jsonl')
const diaryFile = () => dataDir('bili-diary.jsonl')

export const isBvid = (s) => /^BV[0-9A-Za-z]{10}$/.test(String(s || ''))
export const dayOf = (ts = Date.now()) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 读全部历史（坏行跳过）。
 *
 * 同一 (day, bvid) 只留最后一条：一轮里「看了 → 评论 → 收藏 → 分享」会追加好几次，
 * 一天里也可能再看一遍。以前全都留着，面板上同一个视频叠成四行，看着像刷屏。
 * 现在按 (day,bvid) 取最新的那份，动作合并进 kinds 里。
 */
export function readHistory() {
  const p = historyFile()
  if (!existsSync(p)) return []
  let text = ''
  try { text = readFileSync(p, 'utf8') } catch (error) { return [] }
  const byKey = new Map()
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      if (!e || !isBvid(e.bvid)) continue
      const it = { ...e, ts: Number(e.ts) || 0 }
      const key = `${it.day || dayOf(it.ts)}|${it.bvid}`
      const prev = byKey.get(key)
      byKey.set(key, prev ? mergeEntry(prev, it) : it)
    } catch (error) { /* 半行跳过 */ }
  }
  return [...byKey.values()].sort((a, b) => a.ts - b.ts)
}

/** 同一天同一个视频的两条记录合并：新的覆盖旧的非空字段，动作取并集。 */
function mergeEntry(prev, next) {
  const [old, cur] = next.ts >= prev.ts ? [prev, next] : [next, prev]
  const kinds = [...new Set([...(old.kinds || []), ...(cur.kinds || [])])]
  const out = { ...old }
  for (const k of ['title', 'owner', 'cover', 'reason', 'comment', 'link']) {
    if (cur[k]) out[k] = cur[k]
  }
  for (const k of ['duration', 'views']) {
    if (Number(cur[k])) out[k] = Number(cur[k])
  }
  if (cur.pick === 'pick') out.pick = 'pick'
  out.ts = Math.max(prev.ts, next.ts)
  if (kinds.length) out.kinds = kinds
  return out
}

/** 追加 / 覆盖一条（同一 day+bvid 在读取时只留最新那条）。 */
export function appendHistory(entry) {
  const e = {
    ts: Date.now(), day: dayOf(), bvid: '', title: '', owner: '', cover: '',
    duration: 0, views: 0, pick: 'skip', kinds: [], reason: '', comment: '', link: '',
    ...entry,
  }
  if (!isBvid(e.bvid)) return null
  const p = historyFile()
  try {
    if (existsSync(p) && statSync(p).size > 4 * 1024 * 1024) renameSync(p, p + '.1')
  } catch (error) { /* 轮转失败不影响写入 */ }
  try { appendFileSync(p, JSON.stringify(e) + '\n', 'utf8') } catch (error) { return null }
  return e
}

/** 按天分组（渲染时算，不存进文件）。同一天同一个视频只算一条（readHistory 已去重）。 */
export function groupByDay(entries) {
  const map = new Map()
  for (const e of entries) {
    const k = e.day || dayOf(e.ts)
    if (!map.has(k)) map.set(k, [])
    map.get(k).push(e)
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([day, items]) => ({
      day,
      total: items.length,
      picked: items.filter((x) => x.pick === 'pick').length,
      items: items.sort((a, b) => b.ts - a.ts),
    }))
}

// ---------------------------------------------------------------- 肥鱼日记
// 一天一篇，用她自己的语气写：今天看了什么、为什么挑中、有什么感受。
// 不是操作日志 —— 那个 bili.json 的 history 已经在记了。

export function readDiary() {
  const p = diaryFile()
  if (!existsSync(p)) return []
  let text = ''
  try { text = readFileSync(p, 'utf8') } catch (error) { return [] }
  const out = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      if (!e || !e.day || !e.text) continue
      out.push({ ...e, ts: Number(e.ts) || 0 })
    } catch (error) { /* 半行跳过 */ }
  }
  return out.sort((a, b) => b.ts - a.ts)
}

export function writeDiary({ day = dayOf(), text = '', mood = '', picks = [] } = {}) {
  const body = String(text || '').trim()
  if (!body) return null
  const e = { ts: Date.now(), day, text: body.slice(0, 2000), mood: String(mood || '').slice(0, 20), picks: (picks || []).slice(0, 10) }
  const p = diaryFile()
  try {
    if (existsSync(p) && statSync(p).size > 2 * 1024 * 1024) renameSync(p, p + '.1')
  } catch (error) { /* 忽略 */ }
  try { appendFileSync(p, JSON.stringify(e) + '\n', 'utf8') } catch (error) { return null }
  return e
}

/** 今天写过日记没有（一天一篇，别重复写）。 */
export function hasDiaryToday(day = dayOf()) {
  return readDiary().some((x) => x.day === day)
}

// ---------------------------------------------------------------- 日报
// 日报是给人看的 markdown。存成文件，面板上能翻回来。

const reportFile = (day) => dataDir('bili-reports', `${day}.md`)

/** 渲染一份日报 markdown（纯字符串，不依赖任何模板库）。 */
export function renderReport({ day, entries = [], diary = null, stats = {} } = {}) {
  const lines = []
  lines.push(`# B 站日报 · ${day}`)
  lines.push('')
  const picked = entries.filter((x) => x.pick === 'pick')
  const skipped = entries.filter((x) => x.pick !== 'pick')
  lines.push(`看了 ${entries.length} 个，挑中 ${picked.length} 个。`)
  if (stats.comments) lines.push(`发了 ${stats.comments} 条评论。`)
  lines.push('')
  if (picked.length) {
    lines.push('## 挑中的')
    lines.push('')
    for (const x of picked) {
      const bits = [x.owner, x.duration ? fmtDur(x.duration) : '', x.views ? fmtNum(x.views) + '播放' : ''].filter(Boolean)
      lines.push(`### ${x.title || x.bvid}`)
      if (bits.length) lines.push(`- ${bits.join(' · ')}`)
      lines.push(`- ${x.link || 'https://www.bilibili.com/video/' + x.bvid}`)
      if (x.reason) lines.push(`- 为什么：${x.reason}`)
      if (x.comment) lines.push(`- 我的评论：${x.comment}`)
      lines.push('')
    }
  }
  if (skipped.length) {
    lines.push('## 看过但跳过')
    lines.push('')
    for (const x of skipped) {
      lines.push(`- ${x.title || x.bvid}${x.reason ? ` — ${x.reason}` : ''}`)
    }
    lines.push('')
  }
  if (diary?.text) {
    lines.push('## 今天想说的')
    lines.push('')
    lines.push(diary.text)
    lines.push('')
  }
  return lines.join('\n')
}

export function saveReport(day, markdown) {
  try {
    ensureDir(dataDir('bili-reports'))
    writeFileSync(reportFile(day), markdown, 'utf8')
    return true
  } catch (error) { return false }
}

export function readReport(day) {
  try { return readFileSync(reportFile(day), 'utf8') } catch (error) { return '' }
}

/** 有日报的日期列表（新的在前）。 */
export function reportDays() {
  try {
    return readdirSync(dataDir('bili-reports'))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map((f) => f.replace(/\.md$/, ''))
      .sort()
      .reverse()
  } catch (error) { return [] }
}

const fmtDur = (sec) => {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}:${String(m).padStart(2, '0')}:00` : `${m}:${String(s % 60).padStart(2, '0')}`
}
const fmtNum = (n) => {
  const v = Number(n) || 0
  if (v >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, '') + '万'
  return String(v)
}
