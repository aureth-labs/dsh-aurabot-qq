// 自驱引擎 v5 · 稳定前缀段拼装（R13 / D15，docs/design/autotelic-v5/00-v5-final.md §9.3）。
//
// 前缀段三部分（对话轮与自驱轮共用，同前缀命中提示词缓存）：
//   1. 人格卡摘要（本能层主体，调用方从 personas 读好传进来——本文件不读人格卡文件）；
//   2. 本能附加段（本能晋升产物，来自技能库 instinct/，调用方传条目数组）；
//   3. constraintRules 全文（§3.7；成员 B 的 constraint.js 是他的文件，本文件不 import，
//      约束文本一律走参数接收——边界由调用方装配，谁装配谁保证顺序）。
//
// 该段只在「本能晋升 / 约束修改」两个低频事件时变化， getVersion() 返回内容 hash
// 供调用方做缓存判断：hash 没变就不必重算/重发前缀。
//
// 拼装是确定性的（固定段顺序 + 固定分隔符），同一输入永远同一输出——这是缓存命中的前提。
// 降级顺序原则（§9.3）：先裁背景与历史，再裁证据，永不裁人格锚与 constraintRules——
// 本文件只负责拼装不负责裁剪；任何裁剪都不许动这三段。

import { createHash } from 'node:crypto'

const SECTION_SEP = '\n\n'
const HEAD_RULES = '【强制约束规则】以下条款由主人制定，违反任何一条的行动与候选直接打回，不允许改写挽救。'

/**
 * 拼装稳定前缀段（system 提示词头部）。
 * @param {object} p
 * @param {string} p.personaSummary   人格卡摘要（本能层主体；空串则跳过该段）
 * @param {Array<{id:string,title:string,content:string}>} p.instincts 本能附加段条目（instinct/ 层晋升产物）
 * @param {string} p.constraints      constraintRules 全文（多行，逐行一条；空串则无约束段）
 * @returns {string} 稳定前缀字符串
 */
export function buildPrefix({ personaSummary = '', instincts = [], constraints = '' } = {}) {
  const parts = []
  const persona = String(personaSummary || '').trim()
  if (persona) parts.push(persona)
  for (const it of Array.isArray(instincts) ? instincts : []) {
    const content = String(it?.content || '').trim()
    if (!content) continue
    parts.push(`【本能·${String(it?.title || it?.id || '未命名')}】（本段由本能层自动晋升写入）\n${content}`)
  }
  const rules = String(constraints || '').trim()
  if (rules) parts.push(`${HEAD_RULES}\n${rules}`)
  return parts.join(SECTION_SEP)
}

/** 内容 hash（前 16 位 hex 足够做缓存键；同一内容永远同一 hash）。 */
export function hashPrefix(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex').slice(0, 16)
}

/**
 * 带缓存的版本判断：内容没变时 getVersion() 复用上次结果（last 同引用），
 * 调用方可以 `if (getVersion(...) !== lastVersion) rebuild()`。
 * createPrefixCache() 返回 { build, version, changed }：
 *   build(p)  → 前缀字符串（内存缓存命中即原样返回，不重拼）；
 *   version(p)→ hash（16 hex）；
 *   changed(p)-> boolean 相对上次 build 是否变了。
 */
export function createPrefixCache() {
  let cache = { key: null, text: '', version: '' }
  const keyOf = (p = {}) => JSON.stringify([p.personaSummary || '', (p.instincts || []).map((i) => `${i?.id}|${i?.title}|${i?.content}`), p.constraints || ''])
  return {
    build(p) {
      const key = keyOf(p)
      if (cache.key === key) return cache.text
      const text = buildPrefix(p)
      cache = { key, text, version: hashPrefix(text) }
      return text
    },
    version(p) { return hashPrefix(buildPrefix(p)) },
    changed(p) { const key = keyOf(p); return cache.key !== key },
  }
}
