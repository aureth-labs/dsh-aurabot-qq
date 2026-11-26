// 自驱引擎 v5 · 三层技能体系（R7/R8，docs/design/autotelic-v5/00-v5-final.md §2.4/§3.4/§9.3）。
//
// 三层架构（裁决一：全链自主，安全靠快照回滚不靠审批闸）：
//   memory/   记忆层——复盘片段顺手落下来（ingestReflection，零成本）；
//   skills/   技能层——同主题 ≥3 条记忆 或 真实复用成功（done）→ 一次提炼调用晋升上来；
//   instinct/ 本能层——技能 uses≥5 且 score≥0.8 自动晋升，写进人格卡附加段；
//   archive/  归档层——stale 条目修订/归档去处（不删除，保历史）；
//   history/<ISO时间戳>/ —— 每次晋升/修订/写人格卡前的快照（append-only，弃 .bak：
//             连续写入会互相覆盖；主人可一键回滚任意快照）。
//
// score 唯一信号源 = 行动单真实复用终态（§3.4/D9）：done +0.1 / failed −0.2 / aborted 不计；
// touch-owner 类叠加主人回应档位（ignored/perfunctory 视同 failed，数据从成员 C 的 feedback.json
// 由调用方读好后传进来——本文件只收参数不读 feedback）。模型自评没有改分的口子：
// 本文件不提供任何「直接设 score」的 API，模型给的 score 字段一律丢弃。
//
// 淘汰（§3.4）：score<0.3 且 uses≥3 标 stale，复盘建议修订或归档。
//
// 坑 #1（HANDOVER §四）：api.dataDir() 已带 modules-data/<id>/ 前缀——本文件收**现成的
// skills 根目录**（调用方传 api.dataDir('skills')），自己不再拼模块名，不会双层嵌套。
//
// 人格卡写入（R8）：人格卡在 dataDir('personas')/<id>.md（src/persona/personas.js 的口径）。
// 本文件收 personaFile 路径参数，写前必先时间戳快照进 history/；写坏只影响附加段
// （附加段用 HTML 注释成对标记，损坏可整体剥除，主卡正文不受影响）。
//
// 文件头旧接口：createSkills（P4.2 旧技能库）/ writeUserModule（P3.1 用户模块写入）
// 原样保留在文件尾——模块壳（src/modules/autotelic/index.js）与 autotelic-p3.test.js 还在用，
// 迁移走 v5 接口是模块壳属主的事，这里不动它们的行为。

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, copyFileSync, unlinkSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { readJson, writeJson } from '../core/store.js'

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const LAYERS = ['memory', 'skills', 'instinct', 'archive']
const LAYER_PRIORITY = ['instinct', 'skills', 'archive', 'memory'] // 同 id 多层并存时，进化到最高层的版本赢（与 get/recordOutcome/archive 一致）

/** 时间戳目录名：ISO 去掉 Windows 文件名非法字符。 */
function stampOf(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-')
}

/** 任意文本 → 合法目录/文件 id。 */
function slug(text, fallback = 'note') {
  const s = String(text || '').trim().toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/[\u4e00-\u9fa5]/g, '') // 中文不出现在文件名里，转成语义化英文由调用方给 id 更好
    .replace(/^-+|-+$/g, '').slice(0, 40)
  return ID_RE.test(s) ? s : fallback
}

/** 只有「非空且形状合法」的值才算 id；String(undefined) 也会匹配 ID_RE，必须先排除。 */
const validId = (v) => (v !== undefined && v !== null && String(v).trim() && ID_RE.test(String(v)) ? String(v) : null)

// ---------- markdown 读写（frontmatter + 正文四要素） ----------

function parseDoc(raw) {
  const meta = {}
  let body = String(raw || '').replace(/^﻿/, '')
  const m = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^(\w+):\s*(.*)$/)
      if (!kv) continue
      const [, k, v] = kv
      if (k === 'tags') meta.tags = v.replace(/^\[|\]$/g, '').split(/[,，]/).map((s) => s.trim()).filter(Boolean)
      else if (['score', 'uses'].includes(k)) meta[k] = v.trim() === '' ? undefined : Number(v)
      else if (k === 'stale') meta.stale = v.trim() === 'true'
      else meta[k] = v.trim()
    }
    body = body.slice(m[0].length)
  }
  return { meta, body: body.trim() }
}

function sectionOf(body, name) {
  const m = body.match(new RegExp(`##\\s*${name}[\\s\\S]*?\\n([\\s\\S]*?)(?=\\n##\\s|$)`))
  return m ? m[1].trim() : ''
}

function serialize(doc) {
  const meta = doc.meta
  const order = ['id', 'title', 'kind', 'tags', 'layer', 'score', 'uses', 'stale', 'createdAt', 'promotedAt', 'sourceSkill', 'source']
  const rest = Object.keys(meta).filter((k) => !order.includes(k) && meta[k] !== undefined && meta[k] !== '' && meta[k] !== false)
  const lines = ['---']
  for (const k of [...order, ...rest]) {
    if (meta[k] === undefined || meta[k] === '' || meta[k] === false) continue
    if (Array.isArray(meta[k])) lines.push(`${k}: [${meta[k].join(', ')}]`)
    else lines.push(`${k}: ${meta[k]}`)
  }
  lines.push('---', '')
  lines.push(doc.body || '')
  return lines.join('\n') + '\n'
}

/** 组一篇新技能文档（四要素：内容/来历/熟练度/亲缘 的人可读描述）。 */
function composeDoc({ meta, content, origin, kin }) {
  const body = [
    `# ${meta.title || meta.id}`,
    '',
    '## 内容',
    String(content || '（待补）').trim(),
    '',
    '## 来历',
    String(origin || '（复盘片段提炼）').trim(),
    '',
    '## 熟练度',
    `score=${Number(meta.score ?? 0.5)}，uses=${Number(meta.uses ?? 0)}${meta.stale ? '，已标 stale（建议修订或归档）' : ''}。熟练度只认行动单真实复用终态，模型自评无权改分。`,
    '',
    '## 亲缘',
    String(kin || '（暂无亲缘记录）').trim(),
  ].join('\n')
  return { meta, body }
}

// ---------- 主对象 ----------

/**
 * 三层技能库。root = skills 根目录（调用方传 api.dataDir('skills')，坑 #1 别再拼一层）。
 * opts.distill(entries)：提炼晋升注入点——同主题记忆晋升技能层时的一次 LLM 调用。
 *   期望返回 [{ title, content, origin?, kin? }]；不给或失败时用模板兜底（诚实降级，不炸链路）。
 * opts.personaFile：人格卡 md 绝对路径（本能晋升写附加段用；不传则本能晋升只落 instinct/ 文件）。
 * opts.now()：时间源（测试可注入）。
 */
export function createSkillStore(root, opts = {}) {
  const now = opts.now || (() => Date.now())
  const distill = opts.distill || null
  const personaFile = opts.personaFile || null
  const log = opts.log || (() => {})

  const dirOf = (layer) => join(root, layer)
  const fileOf = (layer, id) => join(root, layer, `${id}.md`)
  const historyRoot = () => join(root, 'history', stampOf(new Date(now())))
  const indexFile = join(root, 'index.json')

  function ensure() {
    for (const l of [...LAYERS]) mkdirSync(dirOf(l), { recursive: true })
    mkdirSync(join(root, 'history'), { recursive: true })
  }

  /** 快照：把给定文件（或整层）复制进 history/<时间戳>/，保持相对路径。快照失败不阻断主流程但记日志。 */
  function snapshot(paths) {
    const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean)
    if (!list.length) return null
    try {
      const stamp = historyRoot()
      let n = 0
      for (const p of list) {
        if (!existsSync(p)) continue
        const rel = p.startsWith(root) ? p.slice(root.length).replace(/^[/\\]/, '') : basename(p)
        const target = join(stamp, rel)
        mkdirSync(dirname(target), { recursive: true })
        copyFileSync(p, target)
        n++
      }
      return n ? stamp : null
    } catch (error) {
      log(`快照失败（继续主流程）：${error?.message || error}`)
      return null
    }
  }

  function readDoc(layer, id) {
    const f = fileOf(layer, id)
    if (!existsSync(f)) return null
    const { meta, body } = parseDoc(readFileSync(f, 'utf8'))
    return { meta: { ...meta, id: meta.id || id }, id: meta.id || id, layer, body, file: f }
  }

  function writeDoc(layer, doc) {
    mkdirSync(dirOf(layer), { recursive: true })
    writeFileSync(fileOf(layer, doc.meta.id), serialize(doc), 'utf8')
    touchIndex()
  }

  function listDocs(layer) {
    try {
      return readdirSync(dirOf(layer)).filter((f) => f.endsWith('.md'))
        .map((f) => readDoc(layer, f.replace(/\.md$/, ''))).filter(Boolean)
    } catch { return [] }
  }

  function touchIndex() {
    try {
      const items = []
      for (const layer of LAYERS) for (const d of listDocs(layer)) {
        items.push({ id: d.meta.id, layer, title: d.meta.title, kind: d.meta.kind, tags: d.meta.tags, score: d.meta.score, uses: d.meta.uses, stale: Boolean(d.meta.stale), updatedAt: d.meta.updatedAt })
      }
      writeJson(indexFile, { updatedAt: now(), items })
    } catch (error) { log(`index.json 写不了：${error?.message || error}`) }
  }

  function readIndex() { return readJson(indexFile, { updatedAt: 0, items: [] }) }

  /** 迁移文件位置（层间晋升/归档）。 */
  function moveDoc(fromLayer, toLayer, metaPatch = {}) {
    const doc = readDoc(fromLayer, metaPatch.id)
    if (!doc) return null
    const merged = { ...doc, meta: { ...doc.meta, ...metaPatch, layer: toLayer } }
    const { content, origin, kin } = { content: sectionOf(doc.body, '内容'), origin: sectionOf(doc.body, '来历'), kin: sectionOf(doc.body, '亲缘') }
    writeDoc(toLayer, { meta: merged.meta, body: doc.body })
    try { unlinkSync(fileOf(fromLayer, metaPatch.id)) } catch {}
    touchIndex()
    return { ...merged, content, origin, kin }
  }

  // ===== 记忆层：复盘片段进来（成员 B 复盘契约的入口，字段宽松） =====

  /**
   * 复盘片段落 memory/（成员 B 复盘契约，lead 2026-11-17 对齐）：
   *   { roundId, ts, ticketId, intentTitle, tag, steps:[{desc,status}],
   *     finalStatus:'done'|'failed'|'aborted', ownerSide:bool,
   *     ownerResponse:'replied'|'perfunctory'|'ignored'|'none', evidence:[obsId], lesson }
   * 归一化优先级（宽松，契约字段优先，常见别名兜底，全都对不上就把整个 artifact
   * JSON 化截断存下来——保真优先，宁存勿丢）。模型给的 score 一律丢弃。
   * 注意：本函数只「落片段」不改分——score 由执行侧（成员 C exec.js）在终态落账时
   * 调 recordOutcome，复盘侧只有建议权（lead 裁决）。
   * @param {object} artifact 复盘产物
   * @returns {Promise<{ok:boolean, id?:string, promoted?:string[], why?:string}>}
   */
  async function ingestReflection(artifact) {
    if (!artifact || typeof artifact !== 'object') return { ok: false, why: '复盘产物不是对象' }
    const a = artifact
    const text = firstText(a, ['lesson', 'text', 'summary', 'content', 'observation', 'note', 'body'])
    const topic = firstText(a, ['tag', 'topic', 'theme', 'subject', 'kind', 'category'])
    const title = firstText(a, ['intentTitle', 'title', 'name']) || (topic || text || '').slice(0, 30) || '复盘片段'
    const id = validId(a.skillId) || validId(a.roundId) || slug(a.roundId || a.ticketId || topic || title, `ref-${stampOf(new Date(now())).slice(0, 16).toLowerCase()}`)
    // 同 id 的记忆片段：追加正文（合并同主题），不覆盖来历
    const prev = readDoc('memory', id)
    const createdAt = prev?.meta?.createdAt || (Number(a.ts) || now())
    const content = prev ? `${sectionOf(prev.body, '内容')}\n- ${text || JSON.stringify(a).slice(0, 400)}` : (text || JSON.stringify(a).slice(0, 400))
    const evidence = Array.isArray(a.evidence) && a.evidence.length ? a.evidence.map(String) : []
    const origin = evidence.length ? `出处观察：${evidence.join('、')}${a.ticketId ? `（行动单 ${a.ticketId}）` : ''}`
      : firstText(a, ['origin', 'source', 'why']) || (prev && sectionOf(prev.body, '来历')) || `复盘产物于 ${new Date(createdAt).toISOString()} 落入（无出处观察 id，宁存勿丢）`
    const tags = Array.isArray(a.tags) && a.tags.length ? a.tags.map(String) : (topic ? [topic] : [])
    const doc = composeDoc({ meta: { id, title: prev?.meta?.title || title, kind: topic || prev?.meta?.kind, tags: [...new Set([...(prev?.meta?.tags || []), ...tags])], layer: 'memory', score: prev?.meta?.score ?? 0.5, uses: prev?.meta?.uses ?? 0, createdAt, updatedAt: now(), ticketId: a.ticketId, roundId: a.roundId, finalStatus: a.finalStatus, ownerResponse: a.ownerResponse, source: 'reflection' }, content, origin })
    try { writeDoc('memory', doc) } catch (error) { return { ok: false, why: `写不了：${error?.message || error}` } }
    const promoted = await tryMaybePromote(id)
    return { ok: true, id, promoted }
  }

  const firstText = (a, keys) => { for (const k of keys) { const v = a[k]; if (typeof v === 'string' && v.trim()) return v.trim(); if (Array.isArray(v) && v.length && typeof v[0] === 'string') return v.join('；') } return '' }

  // ===== score：唯一信号源 = 行动单真实复用终态 =====

  /**
   * 记一次真实复用终态（lead 裁决：由执行侧成员 C 的 exec.js 在终态落账时调用；
   * 终态第一见证人是执行器；复盘侧只有建议权，不碰分数）。
   * 两种签名：recordOutcome(skillId, finalStatus, ownerResponse)（C 的便捷调用）
   * 或 recordOutcome({ skillId?, tag?, kind?, status, ownerResponse?, touchOwner? })。
   *   - done +0.1 / failed −0.2 / aborted 不计（uses 也不加——没走完不算复用）；
   *   - touch-owner 且 ownerResponse ∈ {ignored, perfunctory} 视同 failed（主人不买账 = 这招不对味）；
   *   - o.score（模型自评想混进来）被显式丢弃。
   * @returns {Promise<{ok:boolean, promoted?:string[], stale?:boolean, why?:string}>}
   */
  async function recordOutcome(a, b, c) {
    const o = typeof a === 'object' && a !== null ? a : { skillId: a, status: b, ownerResponse: c }
    const status = String(o.status || '').toLowerCase()
    if (!['done', 'failed', 'aborted'].includes(status)) return { ok: false, why: `终态「${o.status}」不认（只认 done/failed/aborted）` }
    void o.score // 模型自评：丢弃，这是它唯一的下场
    // touch-owner 类叠加主人回应档位：ignored/perfunctory 视同 failed（主人不买账 = 这招不对味）。
    // 便捷签名下执行侧直接传 ownerResponse，所以档位本身就是决定性的，不再要求 touchOwner 标记。
    const failed = status === 'failed' || ['ignored', 'perfunctory'].includes(String(o.ownerResponse || '').toLowerCase())
    if (status === 'aborted') return { ok: true, why: 'aborted 不计分不计次' }

    const id = o.skillId ? String(o.skillId)
      : o.tag || o.kind ? findIdByTopic(o.tag || o.kind) : null
    if (!id) return { ok: false, why: '没有 skillId/tag，这笔终态落不到任何条目上' }
    for (const layer of LAYER_PRIORITY) {
      const doc = readDoc(layer, id)
      if (!doc) continue
      const before = { score: doc.meta.score ?? 0.5, uses: doc.meta.uses ?? 0 }
      const after = {
        score: Math.max(-1, Math.min(1, failed ? before.score - 0.2 : before.score + 0.1)),
        uses: before.uses + 1,
      }
      const stale = after.score < 0.3 && after.uses >= 3
      const files = [doc.file]
      // 真实复用成功（done 且非 touch-owner 负档）也可能触发晋升——先快照再动
      const patch = { score: Number(after.score.toFixed(4)), uses: after.uses, stale: stale || undefined, updatedAt: now() }
      if (layer === 'instinct' || layer === 'archive') { writeDoc(layer, { meta: { ...doc.meta, ...patch }, body: doc.body }); touchIndex(); return { ok: true, stale } }
      snapshot(files)
      writeDoc(layer, { meta: { ...doc.meta, ...patch }, body: doc.body })
      const promoted = await tryMaybePromote(id, { fromOutcome: true, failed })
      touchIndex()
      return { ok: true, promoted, stale }
    }
    // 记忆层都没有：done 终态本身是「真实复用成功」，按口径可以直接把这条经验立为候选
    if (o.tag || o.kind) {
      await ingestReflection({ topic: o.tag || o.kind, text: `行动单真实复用终态 ${status}，立为候选经验`, id: undefined })
      return { ok: true, why: '库里没有同名条目，已按终态立了候选记忆' }
    }
    return { ok: false, why: '库里没有这个条目' }
  }

  function findIdByTopic(topic) {
    const t = String(topic || '').toLowerCase()
    for (const layer of LAYERS) {
      const hit = listDocs(layer).find((d) => d.meta.kind === t || (d.meta.tags || []).map((x) => String(x).toLowerCase()).includes(t))
      if (hit) return hit.meta.id
    }
    return null
  }

  // ===== 晋升链 =====

  let promotionTail = Promise.resolve()

  function queuePromotion(work) {
    const pending = promotionTail.then(work).catch((error) => {
      log(`晋升检查失败：${error?.message || error}`)
      return null
    })
    promotionTail = pending
    return pending
  }

  // 入队后重新读取记忆。前一项已晋升并吸收的片段直接跳过。
  async function tryMaybePromote(id, options) {
    return (await queuePromotion(() => checkPromotion(id, options))) || []
  }

  /** 记忆条目 x 是否满足晋升技能层：同主题(kind)≥3 条 或 真实复用成功（该条 done 过）。 */
  async function checkPromotion(memoryId, { fromOutcome = false, failed = false } = {}) {
    const promoted = []
    const seed = readDoc('memory', memoryId)
    if (seed) {
      const topic = seed.meta.kind || (seed.meta.tags || [])[0]
      const sameTopic = topic ? listDocs('memory').filter((d) => (d.meta.kind === topic) || ((d.meta.tags || []).includes(topic))) : [seed]
      const reuseSuccess = fromOutcome === true && !failed // 只有 done（真实复用成功）才走这条晋升线
      if (sameTopic.length >= 3 || reuseSuccess) {
        const p = await promoteMemoryToSkill(sameTopic.length >= 3 ? sameTopic : [seed])
        if (p) promoted.push(`memory→skills:${p}`)
      }
    }
    // 技能条目是否够本能层
    for (const id of new Set([memoryId, ...promoted.map((p) => p.split(':')[1] || '')].filter(Boolean))) {
      const s = readDoc('skills', id)
      if (s && (s.meta.uses ?? 0) >= 5 && (s.meta.score ?? 0) >= 0.8) {
        const p = promoteSkillToInstinct(id)
        if (p) promoted.push(`skills→instinct:${id}`)
      }
    }
    return promoted
  }

  /** 同主题记忆 → 技能层：一次提炼调用（注入点 distill），失败用模板兜底。晋升前先快照。 */
  async function promoteMemoryToSkill(entries) {
    if (!entries.length) return null
    const files = entries.map((e) => e.file)
    snapshot(files)
    const topic = entries[0].meta.kind || (entries[0].meta.tags || [])[0] || entries[0].meta.id
    let distilled = null
    try { distilled = distill ? await distill(entries.map((e) => ({ id: e.meta.id, title: e.meta.title, kind: e.meta.kind, tags: e.meta.tags, content: sectionOf(e.body, '内容'), origin: sectionOf(e.body, '来历') }))) : null } catch (error) { log(`提炼调用失败，走模板兜底：${error?.message || error}`) }
    // 提炼期间新写入的复盘不能被旧快照吸收，留给已排队的检查处理。
    if (entries.some((entry) => readDoc('memory', entry.meta.id)?.body !== entry.body)) return null
    const first = Array.isArray(distilled) ? distilled[0] : null
    const id = validId(first?.id) || slug(topic, '') || validId(entries[0].meta.id)
      || `skill-${stampOf(new Date(now())).slice(8, 20).toLowerCase()}`
    const meta = {
      id, title: String(first?.title || entries[0].meta.title || topic).slice(0, 80), kind: topic,
      tags: [...new Set([...(first?.tags || entries.flatMap((e) => e.meta.tags || [])), topic].filter(Boolean))],
      layer: 'skills', score: 0.5, uses: 0, createdAt: now(), updatedAt: now(),
      sourceSkill: entries.map((e) => e.meta.id).join(','),
      source: 'promoted:memory',
    }
    const doc = composeDoc({
      meta,
      content: first?.content || mergeContents(entries),
      origin: `由记忆层 ${meta.sourceSkill} 于 ${new Date(now()).toISOString()} 提炼晋升（同主题 ${entries.length} 条或真实复用成功）`,
      kin: `亲缘记忆：${meta.sourceSkill}`,
    })
    try { writeDoc('skills', doc) } catch (error) { log(`技能层写不了：${error?.message || error}`); return null }
    // 吸收源记忆片段：正文已并进技能条目，出处留在 frontmatter sourceSkill 与 history/ 快照里——
    // 不删的话同 id 的记忆副本会在 priority 解析下遮住技能条目，score 更新就落错层。
    for (const e of entries) { try { unlinkSync(e.file) } catch {} }
    touchIndex()
    return id
  }

  const mergeContents = (entries) => entries.map((e) => `- ${sectionOf(e.body, '内容').split('\n')[0]}`).join('\n')

  /** 技能 → 本能层：写 instinct/ 文件 + 人格卡附加段。人格卡写前必快照；写坏只影响附加段。 */
  function promoteSkillToInstinct(skillId) {
    const doc = readDoc('skills', skillId)
    if (!doc) return null
    snapshot([doc.file, ...(personaFile && existsSync(personaFile) ? [personaFile] : [])])
    moveDoc('skills', 'instinct', { id: skillId, layer: 'instinct', promotedAt: now(), updatedAt: now(), source: doc.meta.source })
    touchIndex()
    if (personaFile) writeInstinctAddon(personaFile, doc.meta.id, doc.meta.title, sectionOf(doc.body, '内容'))
    return skillId
  }

  /**
   * 人格卡附加段读写（§3.4 本能晋升产物；§9.3 前缀段组成之二）。
   * 成对 HTML 注释标记包裹：写坏可整体剥除，主卡正文不受影响。
   */
  const ADDON_START = (id) => `<!-- instinct:${id} start -->`
  const ADDON_END = `<!-- instinct:end -->`

  function addonText(id, title, content) {
    return [ADDON_START(id), `【本能·${title}】（本段由本能层自动晋升写入，score/uses 见技能库 instinct/）`, String(content || '').trim(), ADDON_END].join('\n')
  }

  function writeInstinctAddon(file, id, title, content) {
    try {
      const prev = existsSync(file) ? readFileSync(file, 'utf8') : ''
      const re = new RegExp(`${ADDON_START(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${ADDON_END}\\n?`, 'g')
      const next = (prev.replace(re, '').trimEnd() + '\n\n' + addonText(id, title, content) + '\n')
      writeFileSync(file, next, 'utf8')
    } catch (error) { log(`人格卡附加段写不了（只影响附加段）：${error?.message || error}`) }
  }

  /** 剥除人格卡里全部本能附加段（回滚/重写用）。 */
  function stripInstinctAddons(file) {
    if (!existsSync(file)) return false
    const raw = readFileSync(file, 'utf8')
    const next = raw.replace(new RegExp(`<!-- instinct:[^\\n]*start -->[\\s\\S]*?<!-- instinct:end -->\\n?`, 'g'), '')
    if (next === raw) return false
    writeFileSync(file, next, 'utf8')
    return true
  }

  // ===== 淘汰 / 归档 / 回滚 =====

  /** stale 条目（score<0.3 且 uses≥3）：给复盘的建议清单。 */
  function suggestStale() {
    return LAYERS.flatMap((l) => listDocs(l)).filter((d) => (d.meta.score ?? 0.5) < 0.3 && (d.meta.uses ?? 0) >= 3 && d.layer !== 'archive')
      .map((d) => ({ id: d.meta.id, layer: d.layer, score: d.meta.score, uses: d.meta.uses, advice: '建议修订（先快照）或归档保历史' }))
  }

  /** 归档（不删除保历史）：条目挪 archive/，frontmatter 记 archivedAt。 */
  function archive(id) {
    for (const layer of LAYER_PRIORITY) {
      if (layer === 'archive') continue
      const doc = readDoc(layer, id)
      if (!doc) continue
      snapshot([doc.file])
      moveDoc(layer, 'archive', { id, archivedAt: now(), updatedAt: now() })
      if (layer === 'instinct' && personaFile) { snapshot([personaFile]); stripInstinctAddons(personaFile) }
      touchIndex()
      return { ok: true, from: layer }
    }
    return { ok: false, why: '没有这个条目' }
  }

  /** 修订（复盘有建议权，修订内容调用方给；修订前快照）。 */
  function revise(id, { content, title } = {}) {
    for (const layer of LAYERS) {
      const doc = readDoc(layer, id)
      if (!doc) continue
      snapshot([doc.file])
      const kin = sectionOf(doc.body, '亲缘')
      const meta = { ...doc.meta, title: title || doc.meta.title, updatedAt: now(), stale: undefined }
      const body = composeDoc({ meta, content: content || sectionOf(doc.body, '内容'), origin: sectionOf(doc.body, '来历'), kin }).body
      writeDoc(layer, { meta, body })
      if (layer === 'instinct' && personaFile) writeInstinctAddon(personaFile, id, meta.title, content || sectionOf(body, '内容'))
      touchIndex()
      return { ok: true }
    }
    return { ok: false, why: '没有这个条目' }
  }

  /** 快照回滚（面板一键回滚）：把 history/<stamp>/ 下的文件铺回原位。 */
  function listSnapshots() {
    try { return readdirSync(join(root, 'history')).sort().reverse() } catch { return [] }
  }

  function rollback(stamp) {
    const base = join(root, 'history', String(stamp))
    if (!existsSync(base)) return { ok: false, why: '没有这个快照' }
    let n = 0
    const walk = (dir, rel) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name), join(rel, e.name))
        else {
          const target = join(root, rel, e.name)
          mkdirSync(dirname(target), { recursive: true })
          copyFileSync(join(dir, e.name), target)
          n++
        }
      }
    }
    walk(base, '')
    touchIndex()
    return { ok: true, restored: n }
  }

  // ===== 方法解析（resolveMethod，三档） =====

  /**
   * 给意图（tag + want 描述）找现成方法。kind 精确 > match 关键词 > 探索模式（返回 null，
   * 由调用方走探索模板——不硬凑一条不像的技能）。
   * @returns {{mode:'kind'|'match', doc}|null}
   */
  function resolveMethod(tag, want = {}) {
    const pool = [...listDocs('instinct'), ...listDocs('skills')].filter((d) => d.layer !== 'archive')
    const wantKind = String(want.kind || tag || '').toLowerCase()
    // 1) kind 精确
    const exact = pool.filter((d) => (d.meta.kind || '').toLowerCase() === wantKind)
      .sort((a, b) => (b.meta.score ?? 0) - (a.meta.score ?? 0))[0]
    if (exact) return { mode: 'kind', doc: exact }
    // 2) match 关键词（want.text / want.keywords 对 tags/title/正文）
    const words = [...(Array.isArray(want.keywords) ? want.keywords : []), String(want.text || want.want || '')]
      .flatMap((s) => String(s || '').toLowerCase().split(/[\s，。,.;；、]+/)).filter((w) => w.length >= 2)
    if (words.length) {
      const scored = pool.map((d) => {
        const hay = `${(d.meta.tags || []).join(' ')} ${d.meta.title || ''} ${d.meta.kind || ''} ${d.body}`.toLowerCase()
        return { d, n: words.filter((w) => hay.includes(w)).length }
      }).sort((a, b) => b.n - a.n)[0]
      if (scored && scored.n > 0) return { mode: 'match', doc: scored.d }
    }
    // 3) 探索模式
    return null
  }

  ensure()
  touchIndex()
  return {
    ingestReflection, recordOutcome,
    promoteMemoryToSkill: (entries) => queuePromotion(() => promoteMemoryToSkill(
      entries.map((entry) => readDoc('memory', entry.meta.id)).filter(Boolean),
    )),
    promoteSkillToInstinct,
    suggestStale, archive, revise,
    listSnapshots, rollback,
    resolveMethod,
    get: (id) => { for (const l of LAYER_PRIORITY) { const d = readDoc(l, id); if (d) return d } return null },
    list: (layer) => (LAYERS.includes(layer) ? listDocs(layer) : LAYERS.flatMap(listDocs)),
    index: readIndex,
    addonText, stripInstinctAddons,
  }
}

// =====================================================================
// 以下为旧接口（P3.1/P4.2），模块壳与 autotelic-p3.test.js 仍在用——行为原样保留。
// =====================================================================

const MAX_CODE = 256 * 1024

/** 【旧】P4.2 技能库（manifest.json 口径）。v5 三层体系见 createSkillStore。 */
export function createSkills(dir) {
  const fileOf = (id) => join(dir, 'skills', id, 'manifest.json')

  function save({ id, title = '', script }) {
    const key = String(id || '').trim()
    if (!ID_RE.test(key)) return { ok: false, why: `技能 id「${key}」不对：小写字母开头，小写字母/数字/-，2~40 字` }
    if (typeof script !== 'string' || !script.trim()) return { ok: false, why: '脚本是空的' }
    if (script.length > MAX_CODE) return { ok: false, why: '脚本太大（>256KB）' }
    const prev = readJson(fileOf(key), null)
    const manifest = {
      id: key,
      title: String(title || prev?.title || key).slice(0, 80),
      script,
      status: 'candidate', // candidate → learned；降级见 recordRun
      streak: { ok: 0, fail: 0 },
      runs: (prev?.runs || []).slice(-40),
      createdAt: prev?.createdAt || Date.now(),
      updatedAt: Date.now(),
    }
    try { mkdirSync(join(dir, 'skills', key), { recursive: true }); writeJson(fileOf(key), manifest) } catch (error) {
      return { ok: false, why: `写不了：${error?.message || error}` }
    }
    return { ok: true, manifest }
  }

  function get(id) { return readJson(fileOf(String(id || '').trim()), null) }

  function recordRun(id, ok) {
    const key = String(id || '').trim()
    const m = get(key)
    if (!m) return { status: 'missing', changed: false, why: '没有这个技能' }
    m.runs = [...(m.runs || []), { at: Date.now(), ok: Boolean(ok) }].slice(-40)
    m.streak = m.streak || { ok: 0, fail: 0 }
    if (ok) {
      m.streak.ok += 1
      m.streak.fail = 0
      if (m.status === 'retired') m.status = 'candidate' // 重学从候选开始
      if (m.streak.ok >= 2 && m.status === 'candidate') { m.status = 'learned'; m.why = `连续复现 ${m.streak.ok} 次成功，算学会了` }
    } else {
      m.streak.fail += 1
      m.streak.ok = 0
      if (m.status === 'learned' && m.streak.fail >= 3) { m.status = 'candidate'; m.why = '连续失败 3 次，降回候选' }
      else if (m.status === 'candidate' && m.streak.fail >= 3) { m.status = 'retired'; m.why = '连续失败 3 次，退役（想重学就重新保存）' }
    }
    m.updatedAt = Date.now()
    try { writeJson(fileOf(key), m) } catch (error) { return { status: m.status, changed: false, why: error?.message } }
    return { status: m.status, changed: true, why: m.why }
  }

  function list() {
    const out = []
    try {
      for (const d of readdirSync(join(dir, 'skills'))) {
        const m = get(d)
        if (m) out.push({ id: m.id, title: m.title, status: m.status, streak: m.streak, runs: (m.runs || []).length, updatedAt: m.updatedAt })
      }
    } catch { /* 还没有技能目录 */ }
    return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  }

  return { save, get, recordRun, list }
}

/**
 * 【旧】写用户模块（P3.1/P3.2）。dir = 用户模块根目录（plugins-data/aurabot/modules）。
 * 写入成功后由插件的 3 秒 watcher 自动热加载——这里不主动 reload（watcher 是唯一加载通道，别抢）。
 * @returns {{ok:boolean, why?:string, file?:string, note?:string}}
 */
export function writeUserModule({ dir, id, code }) {
  const key = String(id || '').trim()
  if (!ID_RE.test(key)) return { ok: false, why: `模块 id「${key}」不对：小写字母开头，小写字母/数字/-，2~40 字` }
  if (typeof code !== 'string' || !code.includes('export default')) return { ok: false, why: '入口文件必须 export default 一个模块对象（照面板「模块市场→模板」的样子写）' }
  if (code.length > MAX_CODE) return { ok: false, why: '模块太大（>256KB）' }
  if (/from\s+['"](\.\.\/)+/.test(code)) return { ok: false, why: '不许 import 用户模块目录外面的东西（写不到框架，src/ 对她锁死）' }
  const file = join(dir, key, 'index.mjs')
  try {
    mkdirSync(join(dir, key), { recursive: true })
    writeFileSync(file, code, 'utf8')
  } catch (error) {
    return { ok: false, why: `写不了：${error?.message || error}` }
  }
  return {
    ok: true,
    file,
    // 诚实的边界（§1.1）：新 id 没有同名内置兜底——写坏了就是这个模块不可用，面板报错，要人工清理
    note: '几秒后自动热加载；同名内置被替换时写坏了会回退内置，全新 id 写坏了只是这个模块不可用（面板「已安装」看报错）',
  }
}
