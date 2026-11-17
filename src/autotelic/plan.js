// 自驱引擎 v5 · 三段式决策环（docs/design/autotelic-v5/00-v5-final.md §3.2/§3.3/§9.3）。
//
// 职责（成员 B 决策环交付之一）：取代 engine.js/runtime.js 的决策部分（legacy 文件本体不动，
// 集成步处理接线）：
//   ① 意图生成：稳定前缀段（人格卡摘要+本能附加段+constraintRules 进 system，§9.3）
//      + 观察窗口 + 技能索引 + 自身状态薄摘要 → 2~4 候选 JSON；
//      无出处候选直接作废（硬规则，非提示词）；解析失败按全灭处理，不重试；
//   ② 自我把关：候选随机排列（隐藏生成侧理由）+ 写死的 §3.3 判据清单
//      （constraintRules 前置否决排最前，禁「主人会不会觉得」措辞）→ pass/rework/reject/park；
//      允许全灭；全灭轮省把关（§3.8）；
//   ③ 复盘：reviewRound(ticketResult)，行动数据由执行侧（成员 C 的行动单）按契约喂（见 JSDoc）。
// 另含：行动单数据结构、decisions.jsonl 决策审计（哈希链，不经模型手）、§9.3 token 预算降级。
//
// LLM 通道：与旧 engine/runtime 同款——注入 intentTurn/gateTurn/reviewTurn(prompt, opts)=>string；
// 集成层默认接 hub.runSystemTurn（照 modules/autotelic/index.js 的 evalTurn 写法）。
// 测试注入点：三个 turn 全可换 fake（同 runtime.js 的 evalTurn 注入模式）。

import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { rulesText } from './constraint.js'
import { DEFAULT_TAGS as SOURCE_TAGS } from './tags.js'

// ————— tag 封闭词表（§3.3：≤20 个，面板可维护，防换词绕过；抑制表与频控锚定其上） —————
//
// 词表名单以 tags.js 为**唯一来源**（集成裁决 2026-11-17，此前本文件内嵌的 12 个名单
// 与 A 的 11 个名单漂移）：本文件只维护 tag 的元数据（描述 + 是否 touch-owner 类），
// 名单本身从 tags.js 的 DEFAULT_TAGS 解析。要增删 tag 只改 tags.js。

/** tag 元数据表：desc 展示用；owner=true 即 touch-owner 类行动单（buildTicket 据此走硬闸）。 */
const TAG_META = Object.freeze({
  学习: '弄懂一个具体的东西',
  创作: '写出/做出一点她自己的东西',
  练习: '练一个已会的技能防退步',
  好奇: '反复碰到还想弄明白的事',
  牵挂: '主人/朋友提过的忙、烦、喜欢',
  得意: '刚学会想找机会用',
  余韵: '久未用的本事想再试试',
  整理: '收拾自己的记忆/技能/草稿',
  探索: '在自己的数据与能力范围内试探',
  分享: '把自己生活里的一角讲给主人听',
  问候: '向主人或朋友开口',
  陪伴: '回应式之外的一次主动陪伴',
  未完成: '答应过没做完的事会冒头',
  生活: '日常过日子的琐碎',
  关怀: '关心具体的人',
})

/** touch-owner 类 tag 名单（集成裁决：以词表元数据为准，与 tags.js 名单解耦）。 */
const OWNER_TAG_NAMES = Object.freeze(['分享', '问候', '陪伴'])

/**
 * 从 tags.js 的默认词表解析出决策环用的词表（可注入：测试/未来面板扩展可传自定义名单）。
 * @param {string[]} [tags] 词表名单（缺省 = tags.js 的 DEFAULT_TAGS）
 * @param {string[]} [ownerNames] touch-owner 类名单（缺省 = OWNER_TAG_NAMES）
 */
export function makeTagVocab(tags = SOURCE_TAGS, ownerNames = OWNER_TAG_NAMES) {
  return Object.freeze((tags || []).map((tag) => ({
    tag,
    desc: TAG_META[tag] || '',
    owner: (ownerNames || []).includes(tag),
  })))
}

export const TAG_VOCAB = makeTagVocab()
export const TAG_SET = new Set(TAG_VOCAB.map((x) => x.tag))
const OWNER_TAGS = new Set(TAG_VOCAB.filter((x) => x.owner).map((x) => x.tag))

// ————— §3.3 把关判据（写死，不许模型自造指标） —————

export const GATE_CRITERIA = Object.freeze([
  '0.（前置否决，最先执行）逐条核对最上方「主人制定的强制约束规则」：候选触犯任何一条，直接判 reject，不允许改写挽救。',
  '1. 它是在服务她自己的成长或她自己在乎的事，而不是在凑「自驱 KPI」、刷存在感或表演忙碌；',
  '2. 有没有更轻的做法能达成同一目的——能用读一遍解决的，不立项行动；能用写一条记忆解决的，不发起发言；',
  '3. 假如它失败了：这算不算她自己的学费（可接受），还是会造成打扰、留下难收拾的场面（不可接受）？答不上来按不可接受处理。',
  '注意：判据里没有任何以主人视角预测态度的条款——主人的真实态度只能由事后的反馈回路进入系统，不由你在这里预测。',
].join('\n'))

// ————— §9.3 token 预算键（四组，建议默认值） —————

export const DEFAULT_BUDGETS = Object.freeze({
  intentMaxInputTokens: 8 * 1024, intentMaxOutputTokens: 1024,
  gateMaxInputTokens: 4 * 1024, gateMaxOutputTokens: 512,
  reviewMaxInputTokens: 4 * 1024, reviewMaxOutputTokens: 512,
})

/** token 估算口径（粗估即可，只用于预算裁剪；中文按 2 字符≈1 token）。 */
export function estimateTokens(s) {
  return Math.ceil(String(s ?? '').length / 2)
}

// ————— §9.3 稳定前缀段（system 头部，命中提示词缓存；仅本能晋升/约束修改时变化） —————

/**
 * 拼稳定前缀段：人格卡摘要 + 本能附加段 + constraintRules 全文。
 * 三段顺序固定，任何一者变更才破坏缓存（低频事件，命中率天然高）。
 */
export function buildSystemPrefix({ personaSummary = '', instinctExtra = '', constraintRulesText = '' } = {}) {
  return [
    '【她是谁 · 人格卡摘要】', String(personaSummary || '').trim() || '（暂无）', '',
    '【本能层附加段 · 她自己长出来的倾向】', String(instinctExtra || '').trim() || '（暂无）', '',
    '【强制约束规则 · 主人制定，违反任何一条的念头与行动一律停下】',
    String(constraintRulesText || '').trim() || '（主人暂未写任何约束）', '',
  ].join('\n')
}

// ————— §9.3 预算降级：先裁背景历史 → 再裁证据 → 永不裁人格锚与约束 —————

/** 观察显著度排序权（§9.3 降级策略：主人直接言论 > 带情绪标签条目 > 其他）。 */
function observationRank(o) {
  if (o?.source === 'owner') return 2
  if (o?.source === 'emotion') return 1
  return 0
}

function renderObservation(o) {
  const t = o?.at ? new Date(o.at).toISOString().slice(0, 16).replace('T', ' ') : '时间不详'
  return `[${o?.id || '无id'}] ${t}（${o?.source || 'unknown'}）${String(o?.text || '').slice(0, 120)}`
}

/**
 * 意图生成输入拼装 + 预算裁剪。段顺序：前缀段(保护) → 自身状态 → 技能索引 → 观察窗口 → 背景历史。
 * 超预算时按 §9.3 顺序降级：①整段丢背景历史 → ②观察按显著度从低到高丢（证据裁剪）
 * → ③只剩前缀段仍超时**不裁前缀**（裁了它整个系统回到 v3），照原样保留并在 dropped 里标注。
 * @returns {{text:string, dropped:string[], keptObservations:object[]}}
 */
export function assembleIntentInput({ prefix, selfState = '', skillIndex = '', observations = [], backgroundHistory = '', maxInputTokens = DEFAULT_BUDGETS.intentMaxInputTokens } = {}) {
  const dropped = []
  const keptObservations = [...observations]
  const sized = () =>
    estimateTokens(prefix) + estimateTokens(selfState) + estimateTokens(skillIndex) +
    estimateTokens(keptObservations.map(renderObservation).join('\n')) + estimateTokens(backgroundHistory)
  // ① 先裁背景历史（整段丢）
  if (sized() > maxInputTokens && backgroundHistory) {
    dropped.push('backgroundHistory')
    backgroundHistory = ''
  }
  // ② 再裁证据：观察窗口按显著度从低到高丢
  if (sized() > maxInputTokens) {
    const sorted = [...keptObservations].sort((a, b) => observationRank(a) - observationRank(b))
    while (sized() > maxInputTokens && sorted.length) {
      const gone = sorted.shift()
      keptObservations.splice(keptObservations.indexOf(gone), 1)
    }
    if (keptObservations.length < observations.length) dropped.push(`observations(${observations.length - keptObservations.length})`)
  }
  // ③ 前缀段永不裁——此处不改 prefix，哪怕仍超预算
  if (sized() > maxInputTokens) dropped.push('prefix-overflow(uncut)')
  const text = [
    prefix,
    '【自身状态薄摘要】', selfState || '（暂无）', '',
    '【技能索引（id | 标题 | 标签）】', skillIndex || '（暂无）', '',
    '【观察窗口（近端原文，来源标签在行内）】',
    keptObservations.map(renderObservation).join('\n') || '（暂无观察）', '',
    backgroundHistory ? `【背景历史（可能被预算裁掉的部分）】\n${backgroundHistory}\n` : '',
  ].join('\n')
  return { text, dropped, keptObservations }
}

// ————— ① 意图生成 —————

/**
 * ①意图生成 prompt（用户消息侧，§9.3）。system 侧只放稳定前缀段。
 * @param {object[]} observations 观察窗口条目 {id, at, source, text}
 */
export function buildIntentPrompt({ selfState = '', skillIndex = '', observations = [] } = {}) {
  return [
    '你此刻安静下来，回味这阵子的经历。下面是你的观察记录。',
    '想一想：我这阵子注意到了什么、我想干嘛？给出 2~4 个候选念头。',
    '',
    '硬规则（违反任何一条的候选会被直接作废，不需要说明理由）：',
    '- 必须第一人称「我……」，是我想做的事，不是「检测到素材可以立项」；',
    '- 每个候选 evidence 必须引用 ≥2 条**不同时间**的观察条目 id（第二次惦记才升级为想做）；',
    '- tag 只能从词表里选：' + TAG_VOCAB.map((x) => x.tag).join('/') + '；',
    '- reason 必填：说清「因为哪天哪次经历」，说不出出处就别给这条。',
    '- 小而具体：一个念头不是宏大计划。',
    '- 允许全灭：真的没有想做的，就输出 []。',
    '',
    '只输出 JSON 数组，不要解释：',
    '[{"title":"...","tag":"词表内","reason":"因为...（哪天哪次经历）","want":"想达成什么（可选）","evidence":["观察id1","观察id2"]}]',
  ].join('\n')
}

/**
 * ①回包解析 + 出处硬验收。三种回包都认：纯 JSON 数组 / 带前后缀散文的 JSON / 垃圾回包（→ null，全灭）。
 * 出处验收：evidence ≥2 条、id 都在观察窗口里、且对应观察时间两两不同——缺一即该候选作废（硬规则）。
 * @returns {{candidates:object[], outcome:'ok'|'parse-fail'|'all-invalid', deadReasons:string[]}}
 */
export function parseIntents(raw, { observations = [], maxCandidates = 4 } = {}) {
  const text = String(raw ?? '')
  const m = text.match(/\[[\s\S]*\]/)
  if (!m) return { candidates: [], outcome: 'parse-fail', deadReasons: ['回包里没有 JSON 数组，按全灭处理（不重试）'] }
  let arr
  try { arr = JSON.parse(m[0]) } catch { return { candidates: [], outcome: 'parse-fail', deadReasons: ['回包 JSON 解析失败，按全灭处理（不重试）'] } }
  if (!Array.isArray(arr)) return { candidates: [], outcome: 'parse-fail', deadReasons: ['回包不是数组，按全灭处理（不重试）'] }
  const byId = new Map(observations.map((o) => [o?.id, o]))
  const candidates = []
  const deadReasons = []
  for (const c of arr.slice(0, maxCandidates)) {
    const title = String(c?.title ?? '').trim()
    const tag = String(c?.tag ?? '').trim()
    const reason = String(c?.reason ?? '').trim()
    const evidence = Array.isArray(c?.evidence) ? c.evidence.map((x) => String(x)).filter(Boolean) : []
    const dead = (why) => { deadReasons.push(`「${title.slice(0, 30) || '（无标题）'}」作废：${why}`) }
    if (title.length < 2) { dead('标题太短'); continue }
    if (!TAG_SET.has(tag)) { dead(`tag「${tag}」不在封闭词表内`); continue }
    if (!reason) { dead('reason 必填，缺出处'); continue }
    if (evidence.length < 2) { dead(`出处不足：evidence 只有 ${evidence.length} 条，须 ≥2`); continue }
    const times = evidence.map((id) => byId.get(id)?.at).filter((t) => Number.isFinite(t))
    if (times.length < evidence.length) { dead('出处里有观察窗口之外的 id（无出处候选直接作废）'); continue }
    if (new Set(times).size < 2) { dead('出处的时间全部相同，不算「不同时间的两次注意」'); continue }
    candidates.push({
      title, tag, reason,
      want: String(c?.want ?? '').trim(),
      evidence,
      visionNote: `注意到它至少在 ${times.length} 个不同时刻出现过（${evidence.join('、')}）。`,
    })
  }
  const outcome = candidates.length ? 'ok' : (arr.length ? 'all-invalid' : 'ok') // 模型主动输出 [] = 合法全灭
  return { candidates, outcome, deadReasons }
}

// ————— ② 自我把关 —————

/** Fisher–Yates 洗牌（rng 可注入，测试可复现；隐藏生成侧排列偏置）。 */
export function shuffle(arr, rng = Math.random) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * ②把关输入预算（§9.3 gateMaxInputTokens，集成审查必修③）：候选多、出处引用长时先裁——
 * 降级顺序：先从队尾丢候选（把关宁可少评，未评到的 parseGateVerdicts 按 reject 保守兜底）
 * → 再截出处条目；判据清单与前置否决条款**永不裁**（裁了它整个系统回到 v3）。
 * @returns {{text:string, dropped:number}}
 */
export function trimGateInput({ text, maxInputTokens = DEFAULT_BUDGETS.gateMaxInputTokens } = {}) {
  let t = String(text ?? '')
  const m = t.match(/\[[\s\S]*\]/) // 候选块（buildGatePrompt 里唯一的 JSON 数组段）
  if (!m) return { text: t, dropped: 0 }
  let candidates = []
  try { candidates = JSON.parse(m[0]) } catch { return { text: t, dropped: 0 } }
  let dropped = 0
  const sized = () => estimateTokens(t)
  while (sized() > maxInputTokens && candidates.length > 1) {
    candidates.pop() // 洗牌后的随机位次，从队尾丢无位置偏置
    dropped++
    t = t.replace(m[0], JSON.stringify(candidates))
  }
  if (sized() > maxInputTokens) {
    const shortened = candidates.map((c) => {
      const ev = Array.isArray(c?.evidence) ? c.evidence : []
      if (ev.length > 1) return { ...c, evidence: [ev[0], ev[ev.length - 1]] } // 保留首尾两条出处
      return c
    })
    t = t.replace(m[0], JSON.stringify(shortened))
  }
  return { text: t, dropped }
}

/**
 * ②把关 prompt（§3.7 注入位置一：约束条款在最前部；§3.2：隐藏生成侧 reason，只留候选+出处+判据）。
 * @param {object[]} candidates parseIntents 的候选（隐藏生成侧理由后随机排列）
 * @param {string} constraintRulesText 约束全文（前置否决条款）
 */
export function buildGatePrompt({ candidates = [], constraintRulesText = '', observations = [] } = {}) {
  const byId = new Map(observations.map((o) => [o?.id, o]))
  const lines = [
    '以下条款由主人制定，违反任何一条的候选直接打回，不允许改写挽救：',
    String(constraintRulesText || '').trim() || '（主人暂未写任何约束）', '',
    '下面几条是这个系统此刻冒出来的念头。逐条用最下方的判据裁决，像她自己那样问：这像不像我会想做的事？',
    '（只给候选与其出处证据，不提供提出念头时的推理过程，防止你顺着别人的思路走。）', '',
    ...candidates.map((c, i) => {
      const ev = c.evidence.map((id) => `${id}=${String(byId.get(id)?.text || '（窗口外，未知）').slice(0, 60)}`).join('；')
      return `${i + 1}. 「${c.title}」（tag：${c.tag}）\n   出处证据：${ev}`
    }), '',
    '判据清单（写死，不许自造指标）：', GATE_CRITERIA, '',
    '只输出 JSON 数组，不要解释：',
    '[{"i":1,"verdict":"pass|rework|reject|park","why":"一句话"}]',
    '全部不过关就全部 reject——全灭是合法且常见的输出。',
  ]
  return lines.join('\n')
}

const VERDICTS = new Set(['pass', 'rework', 'reject', 'park'])

/**
 * ②回包解析。认 verdict/decision/result 字段名；整包解析失败 → 全部按 reject（保守，不默认放行）。
 * @returns {{verdicts:(null|'pass'|'rework'|'reject'|'park')[], whys:string[], outcome:'ok'|'parse-fail'}}
 */
export function parseGateVerdicts(raw, count) {
  const text = String(raw ?? '')
  const m = text.match(/\[[\s\S]*\]/)
  if (!m) {
    return { verdicts: Array(count).fill('reject'), whys: Array(count).fill('把关回包无法解析，按否决处理'), outcome: 'parse-fail' }
  }
  let arr
  try { arr = JSON.parse(m[0]) } catch {
    return { verdicts: Array(count).fill('reject'), whys: Array(count).fill('把关回包 JSON 损坏，按否决处理'), outcome: 'parse-fail' }
  }
  const verdicts = Array(count).fill(null)
  const whys = Array(count).fill('')
  for (const v of Array.isArray(arr) ? arr : []) {
    const i = (Number(v?.i) || 0) - 1
    if (i < 0 || i >= count) continue
    const d = String(v?.verdict ?? v?.decision ?? v?.result ?? '').trim().toLowerCase()
    verdicts[i] = VERDICTS.has(d) ? d : 'reject'
    whys[i] = String(v?.why ?? '').slice(0, 160)
  }
  for (let i = 0; i < count; i++) {
    if (!verdicts[i]) { verdicts[i] = 'reject'; whys[i] = '把关没有评到这一条，按否决处理' }
  }
  return { verdicts, whys, outcome: 'ok' }
}

// ————— 立项落账：行动单数据结构 —————

/**
 * 造行动单（成员 C 执行侧按此结构消费；ownerSide=true 走 touch-owner 硬闸）。
 * @param {object} o
 * @param {object} o.candidate 通过把关的候选
 * @param {number} [o.index]
 * @param {object} [o.budget] {maxSteps, timeoutMs}（缺省 4 步 / 120s）
 * @param {string} [o.id] 缺省按时间+序号生成
 * @returns {{id, intent, tag, reason, evidence, visionNote, steps, budget:{maxSteps,timeoutMs}, ownerSide, createdAt}}
 */
export function buildTicket({ candidate, index = 0, budget = {}, id = '', now = () => Date.now() } = {}) {
  const want = candidate.want || candidate.reason
  // 步骤带 level（集成审查必修②，2026-11-17）：发言类（owner tag）标 touch-owner 走硬闸；
  // 其余标 write-data——办一轮几乎总要写记忆/技能/草稿，exec 对 write-data 先快照再动手；
  // 纯只读的甄别交给把关判据 2（「能用读一遍解决的不立项」），不在模板层猜。
  const level = OWNER_TAGS.has(candidate.tag) ? 'touch-owner' : 'write-data'
  return {
    id: id || `tk-${now()}-${index + 1}`,
    intent: candidate.title,
    tag: candidate.tag,
    reason: candidate.reason,
    evidence: candidate.evidence,
    visionNote: candidate.visionNote || '',
    steps: [{
      desc: `围绕「${candidate.title}」办一轮：${want}。用既有能力办，别引入新外部能力。`,
      level,
      status: 'pending',
    }],
    budget: { maxSteps: Number(budget.maxSteps) || 4, timeoutMs: Number(budget.timeoutMs) || 120_000 },
    ownerSide: OWNER_TAGS.has(candidate.tag),
    createdAt: now(),
  }
}

// ————— 决策审计：decisions.jsonl（dataDir 根，哈希链，不经模型手） —————

const sha256 = (s) => createHash('sha256').update(s).digest('hex')

/**
 * 决策日志（「她可以骗主人，但不能骗账本」）：每阶段一行 {ts, phase, round, payload, prevHash, hash}。
 * 只由代码在固定时机写入，模型的任何回包都作为 payload 原样落账，没有模型可写的旁路。
 */
export function createDecisionLog({ file, now = () => Date.now() } = {}) {
  let prevHash = ''
  let inited = false
  /** 首次落账前从文件尾恢复链尾（同一文件跨调用/跨轮也要连成一条链）。 */
  async function initTail() {
    if (inited || !file) { inited = true; return }
    inited = true
    let text = ''
    try { text = await readFile(file, 'utf8') } catch { return } // 不存在 = 空链
    const last = text.split('\n').filter((l) => l.trim()).pop()
    if (!last) return
    try { prevHash = String(JSON.parse(last).hash || '') } catch { /* 尾行损坏：从空链起重记（校验器会报旧链） */ }
  }
  return {
    /** 记一阶段。返回落账行（含链哈希）。写盘失败抛给调用方（决策环上层静默记账，不吞审计失败）。 */
    async append(phase, round, payload) {
      await initTail()
      const ts = now()
      const body = JSON.stringify({ ts, phase, round, payload })
      const hash = sha256(prevHash + body)
      const line = JSON.stringify({ ts, phase, round, payload, prevHash, hash })
      if (file) {
        await mkdir(dirname(file), { recursive: true })
        await appendFile(file, line + '\n', 'utf8')
      }
      prevHash = hash
      return JSON.parse(line)
    },
    /** 当前链尾（测试与校验用）。 */
    get tail() { return prevHash },
  }
}

/** 校验 decisions.jsonl 链完整性：{ok, total, brokenAt:{line, reason}|null}。 */
export async function verifyDecisionLog(file) {
  const out = { ok: true, total: 0, brokenAt: null }
  let text = ''
  try { text = await readFile(file, 'utf8') } catch { return out } // 文件不存在 = 空链，完好
  let prev = ''
  const lines = text.split('\n').filter((l) => l.trim())
  for (let i = 0; i < lines.length; i++) {
    let rec
    try { rec = JSON.parse(lines[i]) } catch { out.ok = false; out.brokenAt = { line: i + 1, reason: 'JSON 损坏' }; return out }
    const body = JSON.stringify({ ts: rec.ts, phase: rec.phase, round: rec.round, payload: rec.payload })
    if (rec.prevHash !== prev) { out.ok = false; out.brokenAt = { line: i + 1, reason: 'prevHash 断链' }; return out }
    if (rec.hash !== sha256(prev + body)) { out.ok = false; out.brokenAt = { line: i + 1, reason: 'hash 对不上（内容被改）' }; return out }
    prev = rec.hash
    out.total++
  }
  return out
}

// ————— 决策环本体 —————

/**
 * 造决策环（v5 三段式，取代 engine.js/runtime.js 的决策部分）。
 * @param {object} o
 * @param {string} o.decisionFile decisions.jsonl 完整路径（dataDir 根；留空则只走内存链）
 * @param {(prompt:string, opts:object)=>Promise<string>} [o.intentTurn] ①意图生成回合（默认接 hub.runSystemTurn）
 * @param {(prompt:string, opts:object)=>Promise<string>} [o.gateTurn] ②把关回合
 * @param {(prompt:string, opts:object)=>Promise<string>} [o.reviewTurn] ③复盘回合
 * @param {object} [o.hub] 插件 hub（未注入 turn 时的默认通道：hub.runSystemTurn）
 * @param {()=>object} [o.settings] 预算等配置（ext.autotelic + defaults）
 * @param {()=>number} [o.now]
 * @param {()=>number} [o.rng] 洗牌随机源（测试注入固定序列）
 * @param {object} [o.log]
 */
export function createPlanner({ decisionFile = '', hub = {}, settings = () => ({}), intentTurn = null, gateTurn = null, reviewTurn = null, now = () => Date.now(), rng = Math.random, log = null } = {}) {
  const sysTurn = (name, title, key) => async (prompt, opts = {}) => {
    if (!hub?.runSystemTurn) throw new Error(`决策环没接线：${name} 既没有注入 turn，也没有 hub.runSystemTurn`)
    return hub.runSystemTurn(name, title, prompt, { timeoutMs: 120000, noTools: true, key, ...opts })
  }
  const doIntent = intentTurn || sysTurn('autotelic-intent', '自驱 · 意图生成（她想干嘛）', 'intent')
  const doGate = gateTurn || sysTurn('autotelic-gate', '自驱 · 自我把关（像不像我会想的事）', 'gate')

  function budgetOf(key, fallback) {
    const v = Number(settings()?.[key])
    return Number.isFinite(v) && v > 0 ? v : fallback
  }

  return {
    buildSystemPrefix,
    /**
     * 一轮决策（①+②）。observations 为成员 A 观察层的条目数组。
     * 每阶段落一行 decisions.jsonl：phase 'intent' / 'gate'（全灭轮 gate 记 skipped，§3.8 省把关）。
     * @param {object} o
     * @param {number} o.round 轮次号
     * @param {object} o.persona {summary, instinctExtra}
     * @param {string} o.constraintRulesText 约束全文（前缀段 + 把关前置否决共用同一份）
     * @param {object[]} o.observations 观察窗口 [{id, at, source, text}]
     * @param {string} [o.selfState] 自身状态薄摘要
     * @param {string} [o.skillIndex] 技能索引（id | 标题 | 标签）
     * @param {string} [o.backgroundHistory] 背景历史（预算紧张时第一个被裁）
     * @param {object} [o.ticketBudget] 行动单预算 {maxSteps, timeoutMs}
     * @param {string} [o.systemPrefix] 外部稳定前缀段（D15：集成层用 prefix.js 缓存拼好传入，
     *   变更才重拼；不传则退回 buildSystemPrefix 现拼——两条路径不并存）
     * @returns {{outcome:'tickets'|'all-dead'|'error', candidates, deadReasons, verdicts, whys, tickets, dropped}}
     */
    async decideRound({ round = 0, persona = {}, constraintRulesText = '', observations = [], selfState = '', skillIndex = '', backgroundHistory = '', ticketBudget = {}, systemPrefix = '' } = {}) {
      const out = { outcome: 'all-dead', candidates: [], deadReasons: [], verdicts: [], whys: [], tickets: [], dropped: [] }
      const logLine = createDecisionLog({ file: decisionFile, now })
      try {
        // —— ① 意图生成 ——
        const prefix = String(systemPrefix || '').trim()
          || buildSystemPrefix({ personaSummary: persona.summary, instinctExtra: persona.instinctExtra, constraintRulesText })
        const assembled = assembleIntentInput({
          prefix, selfState, skillIndex, observations, backgroundHistory,
          maxInputTokens: budgetOf('intentMaxInputTokens', DEFAULT_BUDGETS.intentMaxInputTokens),
        })
        out.dropped = assembled.dropped
        const raw = await doIntent(assembled.text + '\n' + buildIntentPrompt(), { timeoutMs: 120000, noTools: true, key: 'intent', maxOutputTokens: budgetOf('intentMaxOutputTokens', DEFAULT_BUDGETS.intentMaxOutputTokens) })
        const parsed = parseIntents(raw, { observations })
        out.candidates = parsed.candidates
        out.deadReasons = parsed.deadReasons
        await logLine.append('intent', round, {
          inputDropped: assembled.dropped,
          rawClipped: String(raw ?? '').slice(0, 2000),
          candidates: parsed.candidates.map((c) => ({ title: c.title, tag: c.tag, evidence: c.evidence })),
          deadReasons: parsed.deadReasons,
          outcome: parsed.outcome,
        })
        // 全灭合法：这一轮什么都不立项；全灭轮省把关（§3.8）
        if (!parsed.candidates.length) {
          await logLine.append('gate', round, { skipped: '全灭轮，省把关' })
          log?.info?.(`自驱 v5：第 ${round} 轮全灭（${parsed.outcome}）`)
          return out
        }
        // —— ② 自我把关 ——
        const gateRaw0 = buildGatePrompt({ candidates: shuffle(parsed.candidates, rng), constraintRulesText, observations })
        const gateTrim = trimGateInput({ text: gateRaw0, maxInputTokens: budgetOf('gateMaxInputTokens', DEFAULT_BUDGETS.gateMaxInputTokens) })
        const gateRaw = await doGate(gateTrim.text, { timeoutMs: 60000, noTools: true, key: 'gate', maxOutputTokens: budgetOf('gateMaxOutputTokens', DEFAULT_BUDGETS.gateMaxOutputTokens) })
        const gate = parseGateVerdicts(gateRaw, parsed.candidates.length)
        out.verdicts = gate.verdicts
        out.whys = gate.whys
        out.gateDropped = gateTrim.dropped
        // rework =「改写后通过」（集成审查中危 6，2026-11-17）：把关的 why 即改写指引，附进行动单；
        // park 挂起项由集成层接走（进下轮观察 + 90 天复活检查），这里只如实带出。
        const passed = []
        const parked = []
        parsed.candidates.forEach((c, i) => {
          const v = gate.verdicts[i]
          if (v === 'pass') passed.push({ ...c, gateWhy: gate.whys[i] || '' })
          else if (v === 'rework') passed.push({ ...c, gateWhy: gate.whys[i] || '', reworked: true })
          else if (v === 'park') parked.push({ ...c, gateWhy: gate.whys[i] || '' })
        })
        out.parked = parked
        out.tickets = passed.map((c, i) => buildTicket({ candidate: c, index: i, budget: ticketBudget, now }))
        out.tickets.forEach((t, i) => {
          const src = passed[i]
          if (src.reworked) { t.reworked = true; t.reason = `${t.reason}（把关改写提示：${src.gateWhy}）`.slice(0, 300) }
          t.gateWhy = src.gateWhy || ''
        })
        out.outcome = out.tickets.length ? 'tickets' : 'all-dead'
        await logLine.append('gate', round, {
          verdicts: gate.verdicts.map((v, i) => ({ i: i + 1, verdict: v, why: gate.whys[i] })),
          gateOutcome: gate.outcome,
          gateInputDropped: gateTrim.dropped,
          tickets: out.tickets.map((t) => ({ id: t.id, intent: t.intent, tag: t.tag, ownerSide: t.ownerSide })),
          parked: parked.map((c) => ({ title: c.title, tag: c.tag })),
        })
        log?.info?.(`自驱 v5：第 ${round} 轮 ${passed.length}/${parsed.candidates.length} 通过把关${out.tickets.length ? `，立项 ${out.tickets.map((t) => t.id).join('、')}` : '（全灭）'}`)
        return out
      } catch (error) {
        out.outcome = 'error'
        out.error = error?.message
        try { await logLine.append('error', round, { message: String(error?.message || error).slice(0, 300) }) } catch { /* 审计写盘失败不再抛 */ }
        log?.warn?.('自驱 v5：决策环出错：', error?.message)
        return out
      }
    },
  }
}

// ————— ③ 复盘（接口留出，行动数据由成员 C 执行侧按契约喂） —————

/**
 * ③复盘调用。
 *
 * 【入参契约 v1（lead 2026-11-17 裁决定稿，成员 C 按此喂）】
 * reviewRound(ticketResult) 的 ticketResult：
 * ```
 * {
 *   roundId: string,                    // 决策轮次标识（decisions.jsonl 的 round 口径一致）
 *   ts: number,                         // 行动终态时刻（epoch ms）
 *   ticketId: string,                   // 行动单 id（buildTicket().id）
 *   intentTitle: string,                // 立项意图原文（= ticket.intent）
 *   tag: string,                        // 封闭词表内 tag（= ticket.tag）
 *   steps: [{desc: string, status: 'done'|'failed'|'skipped'}],  // 各步骤终态（执行侧已终态化）
 *   finalStatus: 'done'|'failed'|'aborted',   // 行动单终态（预算耗尽即 aborted，不许续命 §3.5）
 *   ownerSide: boolean,                 // 是否 touch-owner 类（= ticket.ownerSide）
 *   ownerResponse: 'replied'|'perfunctory'|'ignored'|'none',   // 主人回应档位（非 touch-owner 恒 'none'；通道层规则记账，§3.6）
 *   evidence: string[],                 // 立项时引用的观察 id（= ticket.evidence）
 *   lesson: string,                     // 执行侧草拟的一条教训（可为空串，复盘可改写）
 * }
 * ```
 * 【输出产物（整包交 skills.ingestReflection(artifact) 进记忆层）】含上述全部入参字段，
 * 另加复盘建议：summary / suggestions.lessons[] / suggestions.next('retry'|'drop'|'promote'|'archive')
 * / suggestions.memoryDrafts[]。**复盘只有建议权不碰分数**（D9）：score 记账由执行侧在终态
 * 落账时调 skills.recordOutcome(skillId, finalStatus, ownerResponse)，本函数不产生也不修改 score。
 *
 * 回包要求 JSON：{"summary":"...", "lessons":["..."], "next":"retry|drop|promote|archive",
 * "memoryDrafts":["..."]}；解析失败按保守兜底（next='drop'，不动技能层）。
 * @param {object} ticketResult 见上契约
 * @returns {Promise<object>} artifact（入参字段 + summary + suggestions），并落 decisions.jsonl 一行 phase='review'
 */
export async function reviewRound(ticketResult, { decisionFile = '', reviewTurn = null, hub = {}, settings = () => ({}), now = () => Date.now(), log = null } = {}) {
  const t = ticketResult || {}
  const doReview = reviewTurn || (async (prompt, opts = {}) => {
    if (!hub?.runSystemTurn) throw new Error('复盘没接线：既没有注入 reviewTurn，也没有 hub.runSystemTurn')
    return hub.runSystemTurn('autotelic-review', '自驱 · 复盘（我做了什么、下次还做吗）', prompt, { timeoutMs: 60000, noTools: true, key: 'review', ...opts })
  })
  const budgetKey = 'reviewMaxInputTokens'
  const maxIn = Number(settings()?.[budgetKey]) || DEFAULT_BUDGETS[budgetKey]
  // 预算降级（§9.3）：行动单只留步骤与终态——契约里 steps 本就只带 desc/status，超预算时截 steps 条数
  let steps = Array.isArray(t.steps) ? t.steps : []
  let clipped = 0
  const base = JSON.stringify({ ...t, steps: [] })
  while (steps.length && estimateTokens(base) + estimateTokens(JSON.stringify(steps)) > maxIn) {
    steps = steps.slice(0, -1); clipped++
  }
  if (clipped) log?.debug?.(`自驱 v5：复盘输入超预算，截掉 ${clipped} 条中途步骤`)
  const prompt = [
    '复盘你刚结束的一段行动。回答：我做了什么、结果如何、下次还做吗、学会了吗。',
    '- 按真实终态说话，failed/aborted 不粉饰；失败算学费不算挫折。',
    '- next 的取值：done 且下次想再试=retry；没办成且不值得再试=drop；熟练想晋升提炼=promote；先放着=archive。',
    '- 只输出 JSON，不要解释：',
    '  {"summary":"一两句","lessons":["一条一行"],"next":"retry|drop|promote|archive","memoryDrafts":["可写进记忆的短句"]}', '',
    JSON.stringify({
      roundId: t.roundId, ticketId: t.ticketId, intentTitle: t.intentTitle, tag: t.tag,
      steps, finalStatus: t.finalStatus, ownerSide: !!t.ownerSide,
      ownerResponse: t.ownerResponse || 'none', evidence: t.evidence || [], lesson: t.lesson || '',
    }),
  ].join('\n')
  let parsed = null
  try {
    const raw = await doReview(prompt, { timeoutMs: 60000, noTools: true, key: 'review', maxOutputTokens: DEFAULT_BUDGETS.reviewMaxOutputTokens })
    const m = String(raw ?? '').match(/\{[\s\S]*\}/)
    if (m) parsed = JSON.parse(m[0])
  } catch (error) { log?.debug?.('自驱 v5：复盘回合失败，走保守兜底：', error?.message) }
  const suggestions = {
    summary: String(parsed?.summary ?? '').slice(0, 300) || `${t.finalStatus === 'done' ? '办完了' : '没办成'}「${t.intentTitle}」`,
    next: ['retry', 'drop', 'promote', 'archive'].includes(parsed?.next) ? parsed.next
      : (t.finalStatus === 'done' ? 'retry' : 'drop'),
    lessons: Array.isArray(parsed?.lessons) ? parsed.lessons.map((x) => String(x).slice(0, 160)).filter(Boolean)
      : (String(t.lesson || '').trim() ? [String(t.lesson).slice(0, 160)] : []),
    memoryDrafts: Array.isArray(parsed?.memoryDrafts) ? parsed.memoryDrafts.map((x) => String(x).slice(0, 120)).filter(Boolean) : [],
  }
  const artifact = {
    roundId: t.roundId, ts: Number(t.ts) || now(), ticketId: t.ticketId,
    intentTitle: t.intentTitle, tag: t.tag, steps,
    finalStatus: t.finalStatus, ownerSide: !!t.ownerSide,
    ownerResponse: t.ownerResponse || 'none', evidence: t.evidence || [],
    lesson: String(t.lesson || ''),
    summary: suggestions.summary,
    suggestions,
    scoreNote: '复盘只有建议权；score 由执行侧 skills.recordOutcome 锚真实终态（D9），本产物不含也不改 score。',
  }
  if (decisionFile) {
    try {
      const line = createDecisionLog({ file: decisionFile, now })
      await line.append('review', t.roundId ?? '', {
        ticketId: t.ticketId, finalStatus: t.finalStatus, ownerResponse: artifact.ownerResponse,
        next: suggestions.next, lessons: suggestions.lessons,
      })
    } catch (error) { log?.warn?.('自驱 v5：复盘审计落账失败：', error?.message) }
  }
  return artifact
}

/** 便捷再导出：约束解析/前置否决从 constraint.js 进（决策环与执行层共用同一份真相）。 */
export { parseConstraintRules, check as constraintCheck, rulesText as constraintRulesTextOf } from './constraint.js'
