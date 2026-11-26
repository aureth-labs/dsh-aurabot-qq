// 自驱引擎 v5 · tag 封闭词表（R1 配套，docs/design/autotelic-v5/00-v5-final.md §3.3）。
//
// 作用：意图与观察的 tag 只能从这个封闭枚举里选——抑制表与频控都锚定在 tag 上，
// 开放词表会被「换个说法绕过抑制」钻空子（§3.3 保守取合：采纳 03 审查 5）。
//
// 词表来源：内置默认枚举（≤20 个，见 DEFAULT_TAGS）+ 主人在面板维护的用户扩展
// （api.dataDir('tags-user.json')，数组形式，去重合并）。合并结果即为唯一合法词表。
//
// 契约：
//   resolveTags(dataDirFn) → string[]  内置 + 用户扩展，去重保序（内置在前）
//   isValidTag(tag, tags?)  → boolean  不传词表时按内置默认判（纯函数、零 IO）
//
// 坑#1 提醒：api.dataDir() 已带 modules-data/autotelic/ 前缀，直接 api.dataDir('tags-user.json')。

import { readJson } from '../core/store.js'

/** 内置默认词表（心念五源头 §2.1 + 生活面补充，≤20 个）。顺序即面板展示顺序。
 *  本文件是词表的**唯一来源**（集成裁决 2026-11-17）：plan.js 的决策环词表从这里解析，
 *  要增删 tag 只改这里，不许在别处另立名单。 */
export const DEFAULT_TAGS = [
  '未完成', // 答应过没做完的事会冒头
  '牵挂',   // 主人提过的忙/烦/喜欢
  '好奇',   // 反复碰到还不懂的东西
  '得意',   // 刚学会想找机会用
  '余韵',   // 久未用的技能想再试试
  '学习',
  '创作',
  '练习',   // 练已会的技能防退步（决策环需要）
  '整理',   // 收拾自己的记忆/技能/草稿（决策环需要）
  '生活',
  '分享',
  '问候',   // 向主人或朋友开口（touch-owner 类）
  '陪伴',   // 回应式之外的一次主动陪伴（touch-owner 类）
  '关怀',
  '探索',
]

/** 用户扩展文件的默认文件名（配合 api.dataDir 使用）。 */
export const USER_TAGS_FILE = 'tags-user.json'

/** 读用户扩展词表（文件不存在 / 不是字符串数组 / 元素非法 → 空表，不抛错）。 */
export function readUserTags(dataDirFn) {
  if (typeof dataDirFn !== 'function') return []
  const raw = readJson(dataDirFn(USER_TAGS_FILE), [])
  if (!Array.isArray(raw)) return []
  return raw
    .map((t) => String(t ?? '').trim())
    .filter((t) => t && t.length <= 24)
}

/** 合并内置 + 用户扩展：去重保序，内置在前；总量钳到 40（防面板灌爆，词表仍是封闭的）。 */
export function mergeTags(userTags = []) {
  const seen = new Set()
  const out = []
  for (const t of [...DEFAULT_TAGS, ...userTags.map((t) => String(t ?? '').trim())]) {
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
    if (out.length >= 40) break
  }
  return out
}

/**
 * 解析当前生效词表：内置默认 + tags-user.json 用户扩展。
 * @param {(...parts:string[])=>string} dataDirFn 模块的 api.dataDir（测试注入假路径即可）
 */
export function resolveTags(dataDirFn) {
  return mergeTags(readUserTags(dataDirFn))
}

/** tag 是否合法（在词表内）。tags 缺省时按内置默认判——纯函数路径，零 IO。 */
export function isValidTag(tag, tags = DEFAULT_TAGS) {
  const s = String(tag ?? '').trim()
  return Boolean(s) && tags.includes(s)
}
