// 自驱引擎 v5 · 强制约束规则（docs/design/autotelic-v5/00-v5-final.md §3.7 / 裁决二 / D7）。
//
// 职责（成员 B 决策环交付之二）：
// 1. parseConstraintRules：constraintRules 多行文本解析——逐行一条，解析失败的行**静默跳过**；
// 2. check：前置否决纯函数——意图（title/reason/tag/want/steps 拼出的文本）触犯任何一条即否决；
//    优先级：constraintRules > 一切自主判断（§3.7）。
// 3. createConstraintWatcher：变更感知——「主人改了规矩」是可感知事件，产出一条观察事件
//    并回调审计（观察事件由调用方 append 进 observations.jsonl，本模块不代写观察层）。
//
// 零依赖 hub / 零模型调用：约束是主人写下的物理边界，解析与核对全在代码层机械完成。

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

/** 单条规则的行长上限（超过按解析失败静默跳过，防误粘一大段文本当成一条规则）。 */
const MAX_RULE_LEN = 500

/** 剥掉行首禁令词后剩下的「内容词」才参与匹配（禁令词本身匹配任何意图都会误伤）。 */
const PROHIBITION_RE = /^(?:请)?(?:千万)?(?:一定)?(?:绝对)?(?:不要|不许|不得|不准|不可以|禁止|严禁|别|勿|避免)+/

/**
 * 解析 constraintRules 多行文本。
 * 行格式：`# 注释` 跳过；`[标签] 规则文本`（标签可选）；其余非空行 = 一条规则。
 * 解析失败（剥掉标签/空白后为空、超长）的行**静默跳过**，只计数不报错（§3.7）。
 * @param {string} text 面板多行文本框原文
 * @returns {{rules:{index:number, tag:string, text:string}[], skipped:number, raw:string}}
 */
export function parseConstraintRules(text) {
  const rules = []
  let skipped = 0
  const lines = String(text ?? '').split(/\r?\n/)
  for (const line of lines) {
    let s = String(line).trim()
    if (!s || s.startsWith('#')) continue
    let tag = ''
    const m = s.match(/^\[([^\]]{1,20})\]\s*/)
    if (m) { tag = m[1]; s = s.slice(m[0].length).trim() }
    if (!s || s.length > MAX_RULE_LEN) { skipped++; continue } // 解析失败：静默跳过该行
    rules.push({ index: rules.length + 1, tag, text: s })
  }
  return { rules, skipped, raw: String(text ?? '') }
}

/** 规则全文（注入 prompt / 前缀段用，保持原文口吻）。 */
export function rulesText(rules) {
  return (rules || []).map((r) => `- ${r.text}`).join('\n')
}

/**
 * 从一条规则里提取展示用关键词：剥禁令词 → 按标点/空白切段 → 取 ≥2 字的段。
 * （用于审计/面板展示；check 的机械匹配用二元组词片，见下。）
 * @returns {string[]}
 */
export function ruleKeywords(ruleText) {
  const core = String(ruleText || '').replace(PROHIBITION_RE, '')
  const segs = core.split(/[，。！？、；：,.!?;:\s（）()"「」'']+/)
    .map((s) => s.trim())
    .filter((s) => [...s].length >= 2)
  return segs.length ? segs : [String(ruleText || '').trim()].filter(Boolean)
}

const normalize = (s) => String(s || '').toLowerCase().replace(/\s+/g, '')

/**
 * 【前置否决 · 纯函数】意图是否触犯约束（§3.3 判据 0：排最前，触犯任何一条不进入裁决直接 reject）。
 * 机械匹配口径：取规则核心词（剥禁令词）的**相邻二元组词片**，命中 ≥2 片即视为触犯——
 * 子串匹配挡不住「半夜…说话」这种插字写法，词片匹配对中文硬约束更稳。
 * 核心词 ≤2 字的规则退回整词子串匹配。零副作用，可单测可复算。
 * @param {{index:number,text:string}[]} rules parseConstraintRules().rules
 * @param {{title?:string, reason?:string, tag?:string, want?:string, steps?:{desc?:string}[]}} intent
 * @returns {{vetoed:boolean, hits:{index:number, text:string, keyword:string}[]}}
 */
export function check(rules, intent) {
  const it = intent || {}
  const haystack = normalize([
    it.title, it.reason, it.tag, it.want,
    ...(Array.isArray(it.steps) ? it.steps.map((s) => s?.desc) : []),
  ].join('\n'))
  const hits = []
  for (const rule of rules || []) {
    const core = String(rule.text || '').replace(PROHIBITION_RE, '')
    const chars = [...normalize(core)]
    let hit = false
    if (chars.length <= 2) {
      hit = chars.length > 0 && haystack.includes(chars.join(''))
    } else {
      // 短规则（≤4 字）容许 1 片命中（「半夜说话」常被插字写成「半夜给主人说话」）；
      // 长规则要求 ≥2 片，防单字巧合误伤。
      const need = chars.length <= 4 ? 1 : 2
      let n = 0
      for (let i = 0; i < chars.length - 1; i++) {
        if (haystack.includes(chars[i] + chars[i + 1])) n++
        if (n >= need) { hit = true; break }
      }
    }
    if (hit) hits.push({ index: rule.index, text: rule.text, keyword: core })
  }
  return { vetoed: hits.length > 0, hits }
}

/**
 * 约束变更感知（§3.7 变更可感知；§2.5「改了会怎样」）。
 * 内存态 + 落盘指纹（`${file}.state.json`）双份：重启后也能认出「这版约束是新改的」。
 * @param {object} o
 * @param {string} o.file constraintRules 持久化文件路径（面板保存时由集成层写入）
 * @param {()=>number} [o.now]
 * @param {(payload:object)=>void} [o.onAudit] 变更事件回调（集成层接 decisions.jsonl / auditNote）
 * @returns {{load:()=>Promise<{rules:object[],skipped:number,text:string}>, detectChange:()=>Promise<{changed:boolean, event?:object}>}}
 */
export function createConstraintWatcher({ file, now = () => Date.now(), onAudit = null } = {}) {
  let lastText = null

  async function readText() {
    try { return String(await readFile(file, 'utf8')) } catch { return '' }
  }

  async function readState() {
    try { return JSON.parse(await readFile(`${file}.state.json`, 'utf8')) } catch { return null }
  }

  async function writeState(text, at) {
    await writeFile(`${file}.state.json`, JSON.stringify({
      hash: createHash('sha256').update(text).digest('hex').slice(0, 24),
      text, at,
    }), 'utf8')
  }

  return {
    /** 读当前约束（集成层每轮决策前调用，喂给前缀段与 check）。 */
    async load() {
      const text = await readText()
      const parsed = parseConstraintRules(text)
      return { ...parsed, text }
    },
    /**
     * 变更检测：与上次见过的文本比对（内存优先，重启后回退指纹文件）。
     * 变了 → 返回 event（含「主人改了规矩」观察条目，由调用方写观察层），并落盘新指纹 + 回调审计。
     */
    async detectChange() {
      const text = await readText()
      const state = await readState()
      if (lastText === null) lastText = state?.text ?? text
      // 首次见到约束且还没有指纹文件 → 把当前版本落成基线（重启后靠它认出变更）
      if (!state && lastText === text) {
        try { await writeState(text, now()) } catch { /* 落盘失败不影响内存态 */ }
        return { changed: false }
      }
      if (text === lastText) return { changed: false }
      const prevRules = parseConstraintRules(lastText).rules.map((r) => r.text)
      const curr = parseConstraintRules(text)
      const currTexts = curr.rules.map((r) => r.text)
      const event = {
        kind: 'constraint-changed',
        at: now(),
        observation: {
          id: `obs:constraint:${now()}`,
          text: '主人改了规矩',
          detail: curr.rules.length ? rulesText(curr.rules) : '（约束被清空）',
          source: 'constraint',
        },
        added: currTexts.filter((t) => !prevRules.includes(t)),
        removed: prevRules.filter((t) => !currTexts.includes(t)),
      }
      lastText = text
      try { await writeState(text, event.at) } catch { /* 指纹落盘失败不影响主流程（内存态仍在） */ }
      try { onAudit?.({ kind: 'autotelic/constraint-changed', args: { added: event.added.length, removed: event.removed.length }, outcome: '主人改了规矩' }) } catch { /* 审计失败静默 */ }
      return { changed: true, event }
    },
  }
}
