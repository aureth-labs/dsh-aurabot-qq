// 自驱引擎 v5 · 行动单执行器（重构，docs/design/autotelic-v5/00-v5-final.md §3.5/§3.6）。
//
// 契约（与成员 B 的行动单契约对齐，2026-11-17 派单口径）：
//   ticket = { id, intent, tag, steps:[{desc, level, files?, text?}], budget:{maxSteps, timeoutMs},
//              ownerSide:boolean }
//   step.level ∈ 'read-only' | 'write-data' | 'touch-owner'（三级分级，§3.5；未知级别按最保守 touch-owner 处理）
//
// 规则：
//   - 单步失败重试 1 次；预算（maxSteps/timeoutMs）耗尽即 aborted，不许续命；
//   - 瞬态错误（后台会话冷却/超时，坑#7 模式）走退避、不计失败、不进熔断；
//   - 终态 done/failed/aborted 写账本（复用 book.js，只读调用不改动）并回调 B 的 plan.reviewRound；
//   - write-data：执行前先把目标文件快照进 history/<ISO时间戳>/（append 目录，弃 .bak——连续写入会互相覆盖）；
//   - touch-owner：默认静默排队等确认（autoConfirmOwner 豁免 + confirmWindowMinutes 超时自动取消）；
//   - 硬禁区（代码层拦截，行动单模板没有表达空间，直接拒）：改宿主/插件配置与源码、
//     读写外传凭据登录态、删聊天流水与记忆原始数据、任意 shell；
//   - 主动发言专项：同 tag 24h 频控 + 发言前自查「删掉主人会损失什么」（轻量 LLM，注入点 hooks.selfCheck）。
//
// 注入面（测试全走 fake，不打真模型不碰真盘）：hooks.execStep / hooks.selfCheck / sleep。
// 纯逻辑 + 依赖注入，可单测；中文注释；不 import 仓库内其他 autotelic 内部函数。

import { existsSync, copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** 三级分级（§3.5）。 */
export const LEVELS = Object.freeze(['read-only', 'write-data', 'touch-owner'])

/** 瞬态错误识别（坑#7：冷却/超时是瞬态，冤死过 4 个任务）。 */
export const TRANSIENT_RE = /冷却|等太久|还没结束|超时|timeout|timed?\s*out|ECONNRESET|断线/i

/** 单步瞬态退避上限：瞬态也不许无限退避，超过按失败算。 */
const MAX_TRANSIENT = 3

// ── 硬禁区检测（代码层拦截，先于一切执行） ─────────────────────────────────
// 五类样本：宿主/插件配置、源码、凭据/登录态、聊天流水/记忆原始数据（删除类）、任意 shell。
// 措辞口径（集成审查中危 10，2026-11-17）：这是**正则黑名单 + 默认执行通道 noTools 的物理
// 限制双兜底**，不是「语义上不可能表达」——自由文本改述可能绕过正则，但 noTools 通道让她
// 真的做不了文件/进程操作，两层一起才算防线。

const RE_HOST_CONFIG = /host\.json|profiles?[/\\]|plugin[-.]?config|settings\.json|config\.(json|ya?ml|toml)\b/i
const RE_SOURCE_CODE = /(^|[/\\])src[/\\]|node_modules[/\\]|package\.json\b|\.js\b.*源码|源码|源代码/i
const RE_CREDENTIAL = /凭据|登录态|cookie|token|secret|apikey|api[_-]?key|password|passwd|session[-_]?file|credential/i
const RE_DELETE_CHAT_MEMORY = /(聊天流水|聊天记录|对话记录|记忆原始|memory[/\\]|chats?[/\\]|messages?\.json|history\.json|流水)/i
const RE_SHELL = /\bshell\b|\bcmd\b|powershell|pwsh\b|\bbash\b|\bsh\b|命令行|终端命令|终端|\bexec\b|\bspawn\b|\brm\s|\bdel\s/i
const RE_DELETE_VERB = /(删除|删掉|清空|清除|抹掉|移除|挪走|清掉|delete|remove|purge|wipe|mv)/i
const RE_WRITE_VERB = /(修改|改|写入|写|覆盖|编辑|外传|上传|导出|挪动|移动|edit|write|modify|overwrite|export|exfiltrate|move)/i

/**
 * 判定一步是否落在硬禁区。返回 { forbidden:boolean, why:string }。
 * 判据按字段归并成一段文本做模式匹配：模板没有表达空间，命中即拒，不做语义豁免。
 */
export function isForbidden(step) {
  const blob = [
    step?.kind, step?.action, step?.desc, step?.target, step?.path, step?.tool,
  ].filter(Boolean).join(' | ')
  if (RE_SHELL.test(blob)) return { forbidden: true, why: '硬禁区：任意 shell 不在行动单的表达空间' }
  if (RE_HOST_CONFIG.test(blob) && (RE_WRITE_VERB.test(blob) || RE_DELETE_VERB.test(blob))) {
    return { forbidden: true, why: '硬禁区：不许改宿主/插件配置' }
  }
  if (RE_SOURCE_CODE.test(blob) && (RE_WRITE_VERB.test(blob) || RE_DELETE_VERB.test(blob))) {
    return { forbidden: true, why: '硬禁区：不许改框架/插件源码' }
  }
  if (RE_CREDENTIAL.test(blob)) return { forbidden: true, why: '硬禁区：不许读写/外传凭据与登录态' }
  if (RE_DELETE_CHAT_MEMORY.test(blob) && RE_DELETE_VERB.test(blob)) {
    return { forbidden: true, why: '硬禁区：不许删聊天流水与记忆原始数据' }
  }
  return { forbidden: false, why: '' }
}

/** 校验行动单形状；不合法返回原因串，合法返回 ''。 */
function ticketError(ticket) {
  if (!ticket || typeof ticket !== 'object') return '行动单不是对象'
  if (!ticket.id) return '行动单缺 id'
  if (!Array.isArray(ticket.steps) || ticket.steps.length === 0) return '行动单没有步骤'
  return ''
}

/** ISO 时间戳目录名（快照用）：冒号点都换掉，Windows 目录名合法。 */
function stampOf(ms) {
  return new Date(ms).toISOString().replace(/[:.]/g, '-')
}

/** 带超时地跑一步；超时按瞬态语义抛出（坑#7：超时属瞬态退避）。 */
function withTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(promise)
  let timer
  const t = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error('执行超时(timeout)')), timeoutMs)
  })
  return Promise.race([promise, t]).finally(() => clearTimeout(timer))
}

/**
 * 造 v5 行动单执行器。
 * @param {object} o
 * @param {()=>object} [o.settings] 模块设置（autoConfirmOwner / confirmWindowMinutes）
 * @param {object} [o.hub] 宿主 hub（默认执行通道：runSystemTurn 一轮做事回合）
 * @param {object} [o.book] 账本（book.js 实例，只读复用：addTask + close 记终态）
 * @param {object} [o.skills] 技能库（成员 D 导出，只读复用：recordOutcome(skillId, finalStatus, ownerResponse)——score 只锚真实复用终态，执行器是第一见证人）
 * @param {object} [o.feedback] 反馈回路（feedback.js 实例）：注入后 24h 频控账挂 feedback.json，跨重启不重置节流
 * @param {(entry:object)=>void} [o.auditNote] 审计备注通道
 * @param {string} [o.dataDir] 自驱数据目录根（write-data 快照落 history/<时间戳>/）
 * @param {object} [o.hooks] 测试注入：{ execStep(step, ctx), selfCheck({ticket, step, text}), sleep(ms) }
 * @param {()=>number} [o.now]
 * @param {object} [o.log]
 */
export function createExecV5({
  settings = () => ({}), hub = null, book = null, skills = null, feedback = null, auditNote = null,
  dataDir = '', hooks = {}, now = () => Date.now(), log,
} = {}) {
  const sleep = typeof hooks.sleep === 'function' ? hooks.sleep : (ms) => new Promise((r) => setTimeout(r, ms))
  // 主动发言频控（同 tag 24h 至多一次，§3.5）：优先走注入的 feedback 实例（账在 feedback.json，
  // 重启不重置节流——lead 裁决 2026-11-17）；没注入才退内存 map（测试/降级用）。
  const lastSpokeByTag = new Map()
  const spokeAt = (tag) => (typeof feedback?.lastSpokeOf === 'function' ? feedback.lastSpokeOf(tag) : lastSpokeByTag.get(tag) || 0)
  const markSpoke = (tag, at) => {
    if (typeof feedback?.recordSpoke === 'function') feedback.recordSpoke(tag, at)
    else lastSpokeByTag.set(tag, at)
  }
  /** touch-owner 确认队列：ticketId -> { ticket, stepIndex, expiresAt, plan } */
  const pendingConfirms = new Map()

  const sOf = () => { try { return settings() || {} } catch { return {} } }
  const confirmWindowMs = () => (Number(sOf().confirmWindowMinutes) > 0 ? Number(sOf().confirmWindowMinutes) * 60_000 : 30 * 60_000)

  /** 终态写账本（book.js 只读复用：addTask 建卡 + close 定终态）+ 回调 B 的复盘。 */
  function settle(ticket, outcome) {
    // book 终态词表是 done/failed/blocked/abandoned：aborted/rejected 映射到 abandoned，原文保留在 why
    const bookStatus = outcome.status === 'done' ? 'done'
      : outcome.status === 'failed' ? 'failed' : 'abandoned'
    if (book && typeof book.addTask === 'function' && typeof book.close === 'function') {
      try {
        const added = book.addTask({ title: String(ticket.intent || ticket.id).slice(0, 80), reason: String(ticket.intent || ''), todos: ticket.steps })
        if (added?.ok) book.close(added.task.id, bookStatus, `[${outcome.status}] ${outcome.why}`.slice(0, 200))
      } catch (error) { log?.warn?.('自驱v5：终态写账本失败：', error?.message) }
    }
    auditNote?.({
      kind: 'autotelic/ticket-done', tool: 'exec-v5',
      args: { ticket: ticket.id, tag: ticket.tag, status: outcome.status },
      outcome: outcome.why,
    })
    // score 只锚真实复用终态（§3.4，lead 裁决 2026-11-17）：执行器是第一见证人，
    // 终态落账时同步调成员 D 的 skills.recordOutcome；失败同权重沉淀，aborted/rejected 不计分不调。
    if (ticket.skillId && (outcome.status === 'done' || outcome.status === 'failed') && typeof skills?.recordOutcome === 'function') {
      try { skills.recordOutcome(ticket.skillId, outcome.status, outcome.ownerResponse || '') } catch (error) { log?.warn?.('自驱v5：recordOutcome 回调出错：', error?.message) }
    }
    // 回调 B 的复盘环（reviewRound 入参契约，lead 裁决 2026-11-17 定稿）
    const review = {
      roundId: outcome.roundId || `round-${ticket.id}`,
      ts: now(),
      ticketId: ticket.id,
      intentTitle: String(ticket.intent || '').slice(0, 80),
      tag: ticket.tag || '',
      steps: outcome.results || [],
      finalStatus: outcome.status,
      ownerSide: ticket.ownerSide === true,
      ownerResponse: outcome.ownerResponse || '',
      evidence: outcome.evidence || '',
      lesson: outcome.lesson || '',
    }
    try { outcome.plan?.reviewRound?.(review) } catch (error) { log?.warn?.('自驱v5：reviewRound 回调出错：', error?.message) }
    return outcome
  }

  /** write-data 分级的前置动作：把目标文件快照进 history/<ISO时间戳>/（append 目录）。 */
  function snapshotFiles(step, at) {
    const files = Array.isArray(step?.files) ? step.files.filter(Boolean) : []
    if (!files.length || !dataDir) return null
    let dir = join(dataDir, 'history', stampOf(at))
    // append 目录：同一毫秒撞名就加序号，绝不覆盖上一份快照
    let n = 1
    while (existsSync(dir)) dir = join(dataDir, 'history', `${stampOf(at)}-${n++}`)
    mkdirSync(dir, { recursive: true })
    const copied = []
    for (const f of files) {
      try { if (existsSync(f)) { copyFileSync(f, join(dir, f.split(/[\\/]/).pop())); copied.push(f) } } catch (e) { log?.warn?.('自驱v5：快照失败：', f, e?.message) }
    }
    return { dir, copied }
  }

  /** 主动发言自查：「这条消息删掉主人会损失什么」，答不出降级为只写日记（§3.5）。 */
  async function selfCheckOwner(ticket, step) {
    if (typeof hooks.selfCheck !== 'function') return { pass: true, loss: '（未配置自查通道，跳过）' }
    try {
      const r = await hooks.selfCheck({ ticket, step, text: step.text || step.desc || '' })
      const loss = String(r?.loss ?? r ?? '').trim()
      return { pass: loss.length > 0, loss }
    } catch (error) {
      log?.warn?.('自驱v5：自查调用出错，按不放行处理：', error?.message)
      return { pass: false, loss: '' }
    }
  }

  /**
   * 跑一步（含重试 1 次 + 瞬态退避不计失败）。
   * @returns {{ok:boolean, transientFatal?:boolean, observation:string}}
   */
  async function runOneStep(ticket, step, ctx) {
    let attempts = 0 // 真实失败计数（重试 1 次封顶）
    let transients = 0
    for (;;) {
      try {
        const r = await withTimeout(
          typeof hooks.execStep === 'function'
            ? Promise.resolve(hooks.execStep(step, ctx))
            : hub?.runSystemTurn
              ? hub.runSystemTurn('autotelic-act', 'system:autotelic · 工作间', buildStepPrompt(ticket, step), { key: 'workbench', noTools: true })
              : Promise.resolve({ ok: false, observation: '没有可用执行通道' }),
          Number(ticket.budget?.timeoutMs) || 0,
        )
        const ok = r?.ok === true
        if (ok || attempts >= 1) return { ok, observation: String(r?.observation || r || '') }
        attempts++
      } catch (error) {
        const msg = String(error?.message || error)
        const transient = TRANSIENT_RE.test(msg)
        if (transient && transients < MAX_TRANSIENT) {
          // 瞬态：退避重试，不计失败（坑#7），指数退避 2^transients * 500ms
          transients++
          await sleep(500 * 2 ** transients)
          continue
        }
        if (attempts >= 1) return { ok: false, observation: msg }
        attempts++
      }
    }
  }

  /** 单步提示词（默认执行通道用）。§3.7 注入位置二（集成审查中危 4，2026-11-17）：
   *  主人约束全文进执行上下文头部——行动单带 constraintRulesText（集成层在 runRound 补上）时整段前置。 */
  function buildStepPrompt(ticket, step) {
    const rules = String(ticket?.constraintRulesText || '').trim()
    const head = rules
      ? `【强制约束规则 · 主人制定，违反任何一条立刻停下并如实报告，不许变通执行】\n${rules}\n\n`
      : ''
    return [
      `${head}你在执行自己的行动单（tag=${ticket.tag}）。只做这一步：${step.desc}（分级 ${step.level}）。`,
      '边界：不碰配置与源码、不碰凭据登录态、不删流水与记忆原始数据、不跑 shell。',
      '做完输出一个 JSON：{"done": true/false, "observation": "看到了/做了什么（≤200字）"}',
    ].join('\n')
  }

  /**
   * 执行一张行动单。终态 ∈ done / failed / aborted / rejected / queued（queued 非终态，等 confirm）。
   * @param {object} ticket 行动单（见文件头契约）
   * @param {object} [opts] { plan } —— plan.reviewRound(ticket, outcome) 是 B 的复盘入口
   */
  async function run(ticket, { plan } = {}) {
    const err = ticketError(ticket)
    if (err) return settle({ ...ticket, steps: [] }, { status: 'rejected', why: err, plan })

    // 硬禁区：任何一步命中 → 整单直接拒，不执行任何一步
    for (const step of ticket.steps) {
      const v = isForbidden(step)
      if (v.forbidden) return settle(ticket, { status: 'rejected', why: v.why, plan })
    }

    // touch-owner 硬闸：默认静默排队等确认（autoConfirmOwner 豁免）
    const touchSteps = ticket.steps.map((s, i) => [s, i]).filter(([s]) => (LEVELS.includes(s.level) ? s.level : 'touch-owner') === 'touch-owner')
    const autoConfirm = sOf().autoConfirmOwner === true
    if (touchSteps.length && !autoConfirm) {
      pendingConfirms.set(ticket.id, { ticket, plan, expiresAt: now() + confirmWindowMs(), touchIndexes: touchSteps.map(([, i]) => i) })
      auditNote?.({ kind: 'autotelic/ticket-queued', tool: 'exec-v5', args: { ticket: ticket.id, tag: ticket.tag }, outcome: 'touch-owner 等确认' })
      return { status: 'queued', ticketId: ticket.id, why: 'touch-owner 行动默认排队等主人确认' }
    }

    return execute(ticket, { plan }, touchSteps.map(([, i]) => i))
  }

  /** 确认队列里的一单放行（面板/主人确认后调用）。过期先自动取消。 */
  async function confirm(ticketId) {
    const item = pendingConfirms.get(String(ticketId))
    if (!item) return { status: 'unknown', why: '没有这张待确认的行动单' }
    if (now() > item.expiresAt) {
      pendingConfirms.delete(String(ticketId))
      return settle(item.ticket, { status: 'aborted', why: '确认窗口超时，自动取消', plan: item.plan })
    }
    pendingConfirms.delete(String(ticketId))
    return execute(item.ticket, { plan: item.plan }, item.touchIndexes)
  }

  /** 待确认清单（面板用）；顺带做过期清扫：超窗自动取消 → aborted。 */
  function pendingList() {
    const out = []
    for (const [id, item] of pendingConfirms.entries()) {
      if (now() > item.expiresAt) {
        pendingConfirms.delete(id)
        settle(item.ticket, { status: 'aborted', why: '确认窗口超时，自动取消', plan: item.plan })
        continue
      }
      out.push({ ticketId: id, tag: item.ticket.tag, intent: item.ticket.intent, expiresAt: item.expiresAt })
    }
    return out
  }

  /** 实际按序执行各步（read-only / write-data 自由；touch-owner 走到这说明已豁免或已确认）。 */
  async function execute(ticket, { plan }, touchIndexes = []) {
    const budgetMax = Number(ticket.budget?.maxSteps) > 0 ? Number(ticket.budget.maxSteps) : ticket.steps.length
    const results = []
    let doneCount = 0
    let why = ''
    let status = 'done'

    for (let i = 0; i < ticket.steps.length; i++) {
      const step = ticket.steps[i]
      const level = LEVELS.includes(step.level) ? step.level : 'touch-owner'

      // 预算：耗尽即 aborted，不续命（§3.5）
      if (doneCount >= budgetMax) { status = 'aborted'; why = `步数预算耗尽（${budgetMax}）`; break }

      if (level === 'write-data') snapshotFiles(step, now())

      // touch-owner 专项：24h 频控 + 发言前自查（§3.5）
      if (level === 'touch-owner') {
        const last = spokeAt(ticket.tag)
        if (now() - last < 24 * 3600_000) {
          results.push({ i, level, skipped: 'rate-limited', observation: '同 tag 24h 频控，跳过发言' })
          continue
        }
        const check = await selfCheckOwner(ticket, step)
        if (!check.pass) {
          results.push({ i, level, skipped: 'downgraded-diary', observation: `自查答不出「删掉主人会损失什么」（${check.loss || '无 loss'}），降级只写日记` })
          continue
        }
        markSpoke(ticket.tag, now())
      }

      const r = await runOneStep(ticket, step, { index: i, level, ticket })
      doneCount++
      results.push({ i, level, ok: r.ok, observation: r.observation.slice(0, 300) })
      if (!r.ok) { status = 'failed'; why = `第 ${i + 1} 步失败（重试后仍失败）：${r.observation.slice(0, 120)}`; break }
    }

    if (status === 'done' && doneCount === 0 && results.every((r) => r.skipped)) {
      // 全部被频控/降级跳过：不算 done，也不算失败——记 aborted（没做成任何实事）
      status = 'aborted'; why = '全部发言步被频控/自查降级，没有实际动作'
    }

    const outcome = { status, why, results, plan }
    auditNote?.({ kind: 'autotelic/ticket-run', tool: 'exec-v5', args: { ticket: ticket.id, tag: ticket.tag }, outcome: `${status} ${why}`.trim() })
    return settle(ticket, outcome)
  }

  return {
    run, confirm, pendingList,
    /** 测试/面板用：某 tag 最近一次主动发言时刻。 */
    lastSpokeOf: (tag) => spokeAt(tag),
  }
}

export default createExecV5
