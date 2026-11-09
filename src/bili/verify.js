// 评论复核 + 点赞收藏记账。
//
// 两件事分开看：
//  ① 复核：B 站回 code=0 只代表「收下了」，不代表公开可见。新号 / 触发风控时评论会进审核，
//     只有自己看得见，别人看不到，也不推通知。所以发完要回头查一眼。
//  ② 记账：点赞 / 收藏是**可撤销的状态**，不是一次性事件。用追加式事件流记
//     （一行一个事件，撤销就再追加一条 like:false），当前状态取最后一条。
//     这样「赞了又撤」不会把记录吃掉，额度也才算得准。

import { readFileSync, writeFileSync, appendFileSync, existsSync, statSync, renameSync } from 'node:fs'
import { dataDir } from '../core/store.js'

const likesFile = () => dataDir('bili-likes.jsonl')
const verifyFile = () => dataDir('bili-verify.json')

const isBvid = (s) => /^BV[0-9A-Za-z]{10}$/.test(String(s || ''))
export const KINDS = ['like', 'fav']

/** 一行一个事件；坏行（进程被 kill 时写了半行）跳过，不报错。 */
export function readLikeEvents() {
  const p = likesFile()
  if (!existsSync(p)) return []
  const out = []
  let text = ''
  try { text = readFileSync(p, 'utf8') } catch (error) { return [] }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      if (!e || !isBvid(e.bvid) || !KINDS.includes(e.kind) || typeof e.like !== 'boolean') continue
      out.push({ ...e, ts: Number(e.ts) || 0, day: String(e.day || '') })
    } catch (error) { /* 半行跳过 */ }
  }
  return out.sort((a, b) => a.ts - b.ts)
}

export function appendLikeEvent(ev) {
  const p = likesFile()
  try {
    // 只追加的文件会一直长；2MB 轮转一次，只留当前 + 上一份
    if (existsSync(p) && statSync(p).size > 2 * 1024 * 1024) renameSync(p, p + '.1')
  } catch (error) { /* 轮转失败不影响写入 */ }
  try { appendFileSync(p, JSON.stringify(ev) + '\n', 'utf8') } catch (error) { /* 写不进去下次再说 */ }
  return ev
}

/** 同一个 (kind,bvid) 的当前状态；没记录返回 null。 */
export function currentLike(kind, bvid) {
  const list = readLikeEvents().filter((e) => e.kind === kind && e.bvid === bvid)
  const last = list[list.length - 1]
  return last ? { like: last.like, ts: last.ts, reason: last.reason || '' } : null
}

/** 今天「真的点出去」了几条 —— 只数 like:true。撤销不返还额度（防赞了撤、撤了赞地刷）。 */
export function countToday(kind, day, sinceTs = 0) {
  return readLikeEvents().filter((e) => e.kind === kind && e.day === day && e.like && e.ts >= sinceTs).length
}

/** 面板要的形状：每个 bvid 一条，最近的在前。 */
export function listLikesForUi() {
  const byKey = new Map()
  for (const e of readLikeEvents()) byKey.set(`${e.kind}|${e.bvid}`, e)
  const mk = (kind) => [...byKey.values()]
    .filter((e) => e.kind === kind)
    .sort((a, b) => b.ts - a.ts)
    .map((e) => ({
      bvid: e.bvid, ts: e.ts, day: e.day,
      title: String(e.title || ''), owner: String(e.owner || ''),
      reason: String(e.reason || ''), undone: !e.like,
    }))
  return { like: mk('like'), fav: mk('fav') }
}

// ---------------------------------------------------------------- 复核记录
// 只存最近 200 条：它是「回头看一眼」的台账，不是档案。

export function readVerify() {
  try {
    const j = JSON.parse(readFileSync(verifyFile(), 'utf8'))
    return Array.isArray(j?.items) ? j.items : []
  } catch (error) { return [] }
}

export function rememberVerify(item) {
  const list = readVerify()
  list.unshift({ at: Date.now(), ...item })
  try { writeFileSync(verifyFile(), JSON.stringify({ items: list.slice(0, 200) }, null, 2), 'utf8') } catch (error) { /* 写不进去不影响发评论 */ }
  return item
}

/**
 * 给「这条评论要不要提醒主人」下一个判断。
 * 注意措辞：**没查到 ≠ 没发出去**（翻页 / 热度排序都会漏），所以只有明确 state≠0 才算「进了审核」。
 */
export function judgeVerify(r) {
  if (!r) return { level: 'unknown', text: '没复核' }
  if (r.visible === true) return { level: 'ok', text: '公开可见' }
  if (r.visible === false) return { level: 'hidden', text: `进审核了（state=${r.state}），别人看不到` }
  return { level: 'unknown', text: r.note || '没查到（不等于没发出去）' }
}
