// 内置模块：自驱引擎 v5（彻底推翻 v3 决策管线，方案 docs/design/autotelic-v5/00-v5-final.md）。
//
// v5 生活叙事五环：感知 → 想要 → 行动 → 沉淀 → 分享。本模块是接线层（集成属主）：
//   · 感知：api.every(60s) → 聊天流水采集 + 情绪观察桥 → observations.jsonl（只积累不决策）
//   · 想要：schedule 双轨触发（定时回味 + 心念点火）→ plan.decideRound 三段决策环
//     （意图生成 → 自我把关 → 集成层 constraint.check 前置否决）→ buildTicket
//   · 行动：exec.run（三级分级 + 硬禁区 + 预算 + touch-owner 确认闸）
//   · 沉淀：exec 终态 → plan.reviewRound → skills.ingestReflection；score 只锚真实复用终态
//   · 反馈：feedback.json（抑制/偏好/冷度/熔断）+ constraintRules 强制约束（主人缰绳）
//
// 旧 v3 的 engine.js / runtime.js（好奇判分→预审→立项）已删除：打分器整层退场是 D1 裁决。
// 保留并继续使用的 legacy 件：audit.js（哈希链审计）、book.js（账本）、takeover.js（接管）、
// python.js、reconcile.js、reflect.js（日志刊物）；skills.js 的旧接口（createSkills /
// writeUserModule）供她的 Python 技能与用户模块工具继续用。
//
// 铁律（HANDOVER）：她可以骗主人但不能骗账本；enabled=false 时零 IO、零调用、行为同旧版。

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { readFile as readFileP, writeFile as writeFileP } from 'node:fs/promises'
import { join } from 'node:path'
import { verifyAuditChain, readAuditDay } from '../../autotelic/audit.js'
import { createObserve, createChatCollector, createEmotionBridge } from '../../autotelic/observe.js'
import { resolveTags } from '../../autotelic/tags.js'
import { createSchedule, scheduleConfig, quietOf } from '../../autotelic/schedule.js'
import { createPlanner, reviewRound, verifyDecisionLog } from '../../autotelic/plan.js'
import { createConstraintWatcher, check as constraintCheck, rulesText as rulesTextOf } from '../../autotelic/constraint.js'
import { createExecV5 } from '../../autotelic/exec.js'
import { createFeedback } from '../../autotelic/feedback.js'
import { createSkillStore, createSkills, writeUserModule } from '../../autotelic/skills.js'
import { createPrefixCache } from '../../autotelic/prefix.js'
import { createBook } from '../../autotelic/book.js'
import { probePython, loadEnvCache, saveEnvCache, envUsable, runPython } from '../../autotelic/python.js'
import { probeTakeovers, applyTakeover, restoreTakeover, findFlipped, repressTakeover, takeoverView } from '../../autotelic/takeover.js'
import { reconcileDay, problemsText } from '../../autotelic/reconcile.js'
import { createJournal } from '../../autotelic/reflect.js'
import { inQuietHours } from '../../purpose/engine.js'
import { dataDir } from '../../core/store.js'
import { personaDataDir, personaNow, currentPersonaText } from '../../persona/personas.js'

export default {
  id: 'autotelic',
  name: '自驱引擎',
  version: '0.5.0',
  api: 2,
  platforms: ['*'],
  description: 'v5：她自己的日子——观察积累 → 定时回味/心念点火 → 三段决策环（生成/把关分离，全灭合法）→ 行动单执行（三级分级+硬禁区）→ 技能三层沉淀（score 锚真实复用终态）→ 反馈回路（抑制/冷度/熔断）+ constraintRules 强制约束 + 接管。默认关闭。',
  files: [
    'autotelic/audit.js', 'autotelic/book.js', 'autotelic/observe.js', 'autotelic/tags.js',
    'autotelic/schedule.js', 'autotelic/plan.js', 'autotelic/constraint.js', 'autotelic/prefix.js',
    'autotelic/exec.js', 'autotelic/feedback.js', 'autotelic/skills.js', 'autotelic/reflect.js',
    'autotelic/python.js', 'autotelic/takeover.js', 'autotelic/reconcile.js',
  ],
  // 独立标签页「自驱引擎」（页面在 client/client.js）。
  tab: 'autotelic',
  defaults: {
    // —— 总开关与生活节奏（裁决三：对齐目的引擎风格）——
    enabled: false, // 总开关：默认关。关着时模块零 IO，验收场景 1
    awakeFrom: 8, // 醒着窗口 从（点）；安静时段 = 补集
    awakeTo: 23, // 醒着窗口 到（点）
    minIntervalMinutes: 90, // 回味间隔下限（分钟）
    maxIntervalMinutes: 240, // 回味间隔上限（分钟）
    maxPerDay: 3, // 单日回味上限（0 = 不限，仍受安静时段约束）
    igniteCooldownMinutes: 45, // 心念点火事件侧冷却（分钟，防事件风暴）
    // —— 主人的缰绳（裁决二 / D7）——
    constraintRules: '', // 强制约束规则（多行文本，逐行一条；把关前置否决 + 执行注入，最高优先级）
    // —— touch-owner 硬闸（§3.5）——
    autoConfirmOwner: false, // 豁免确认（默认全要确认）
    confirmWindowMinutes: 720, // 确认等待时长（分钟），超时自动取消
    // —— 无回应负反馈调参（§3.6）——
    responseWindowHours: 48, // 投递后观察窗（小时）
    chillHalfLifeDays: 14, // 冷度半衰（天）
    chillParkThreshold: 3, // 冷度到多少自动 park 90 天
    // —— §9.3 token 预算（四组；chat 组留给对话轮前缀段复用）——
    chatMaxInputTokens: 4096, chatMaxOutputTokens: 1024,
    intentMaxInputTokens: 8192, intentMaxOutputTokens: 1024,
    gateMaxInputTokens: 4096, gateMaxOutputTokens: 512,
    reviewMaxInputTokens: 4096, reviewMaxOutputTokens: 512,
    // —— 账本预算（C5：上限她调不动）——
    maxSteps: 8,
    maxTasksActive: 8,
    budgetActionsPerHour: 12,
    // —— 能力（P3/P4 保留）——
    allowUserModules: true,
    allowPython: true,
    pythonBin: '',
    scriptTimeoutMs: 120000,
    // —— 接管浏览模块（主人手动点，不自动）——
    takeover: false,
    takenOver: {}, // 内部键：接管原值备份（面板只读；重启据此重压）
    presetIdOverride: false, // 内部键：hub 的 presetId 覆盖总闸（§9，默认关）
  },
  settings: [
    { key: 'enabled', label: '启用自驱引擎', type: 'switch', hint: '默认关。开着时她按「定时回味 + 心念点火」过日子：安静时刻回味经历长出念头，多数时候空手而归（这是健康态）' },
    { key: 'awakeFrom', label: '醒着窗口 从（点）', type: 'number', min: 0, max: 24, hint: '回味只排在醒着窗口内；安静时段连点火都只攒不触发' },
    { key: 'awakeTo', label: '醒着窗口 到（点）', type: 'number', min: 0, max: 24 },
    { key: 'minIntervalMinutes', label: '回味间隔下限（分钟）', type: 'number', min: 5, max: 2880 },
    { key: 'maxIntervalMinutes', label: '回味间隔上限（分钟）', type: 'number', min: 5, max: 2880, hint: '间隔在区间内随机，并向主人更常回话的小时轻推' },
    { key: 'maxPerDay', label: '单日回味上限', type: 'number', min: 0, max: 20, hint: '0 = 不限。一个天天立项的 AI 不是活着，是焦虑' },
    { key: 'igniteCooldownMinutes', label: '心念点火冷却（分钟）', type: 'number', min: 1, max: 720, hint: '技能沉淀/重要事件点燃回味的冷却，防事件风暴' },
    { key: 'constraintRules', label: '强制约束规则（主人制定）', type: 'textarea', placeholder: '一行一条，例如：\n不许半夜给主人发消息\n[钱] 不许任何花钱的操作', hint: '她的物理边界：不是偏好，是「能不能」。触犯的念头直接打回、在路上的行动立刻停；改了她会知道' },
    { key: 'autoConfirmOwner', label: '发言类行动免确认', type: 'switch', hint: '默认关：所有碰主人侧的行动先排队等确认。开了之后按自查与频控兜底' },
    { key: 'confirmWindowMinutes', label: '确认等待时长（分钟）', type: 'number', min: 5, max: 10080 },
    { key: 'responseWindowHours', label: '回应观察窗（小时）', type: 'number', min: 1, max: 168, hint: '主动投递后这么多小时内主人没回应 = ignored（最响亮的负反馈）' },
    { key: 'chillHalfLifeDays', label: '冷度半衰（天）', type: 'number', min: 1, max: 90 },
    { key: 'chillParkThreshold', label: '自动 park 冷度阈值', type: 'number', min: 1, max: 10, hint: '某个方向连续被冷落到这个冷度，90 天内不再主动触发（可恢复）' },
    { key: 'intentMaxInputTokens', label: '意图生成输入预算（token）', type: 'number', min: 512, max: 65536 },
    { key: 'intentMaxOutputTokens', label: '意图生成输出预算（token）', type: 'number', min: 128, max: 8192 },
    { key: 'gateMaxInputTokens', label: '自我把关输入预算（token）', type: 'number', min: 512, max: 65536 },
    { key: 'gateMaxOutputTokens', label: '自我把关输出预算（token）', type: 'number', min: 128, max: 8192 },
    { key: 'reviewMaxInputTokens', label: '复盘输入预算（token）', type: 'number', min: 512, max: 65536 },
    { key: 'reviewMaxOutputTokens', label: '复盘输出预算（token）', type: 'number', min: 128, max: 8192 },
    { key: 'chatMaxInputTokens', label: '对话轮输入预算（token）', type: 'number', min: 512, max: 65536, hint: '§9.3 对话轮前缀段与情绪小段的预算（预留给对话侧拼装）' },
    { key: 'chatMaxOutputTokens', label: '对话轮输出预算（token）', type: 'number', min: 128, max: 8192 },
    { key: 'maxSteps', label: '单行动单步数上限', type: 'number', min: 1, max: 32 },
    { key: 'maxTasksActive', label: '同时进行的行动单数', type: 'number', min: 1, max: 16 },
    { key: 'budgetActionsPerHour', label: '动作数 / 小时', type: 'number', min: 1, max: 120 },
    { key: 'allowUserModules', label: '允许写用户模块', type: 'switch', hint: '写不到框架（src/ 锁死），只能写自己数据目录的 modules/<id>/' },
    { key: 'allowPython', label: '允许跑 Python 脚本', type: 'switch' },
    { key: 'pythonBin', label: 'Python 解释器路径', type: 'string', hint: '留空 = 自动探测（会滤掉商店占位别名）；探测不到时填全路径' },
    { key: 'scriptTimeoutMs', label: '脚本超时（毫秒）', type: 'number', min: 1000, max: 600000 },
    { key: 'takeover', label: '接管浏览模块', type: 'switch', hint: '手动点开才生效：压制抖音/B站的自主循环（不关模块总开关，她的手还在）。关掉自动还原原配置' },
  ],
  setup(api) {
    // 审计目录：api.dataDir 已自动带 modules-data/autotelic 前缀，别再叠一层（坑#1）。
    const auditDir = () => api.dataDir('audit')
    const auditWired = () => Boolean(api.core?.autotelicAuditOn)
    const note = (entry) => api.core?.autotelicAudit?.note?.(entry)
    const log = api.log

    // 她自己的东西跟着人格走（人格隔离）：根目录人格沿用模块数据目录，其他人格放 persona-data/<id>/autotelic/。
    const own = (...parts) => {
      const dir = personaDataDir(api.config(), personaNow(api.config()))
      return dir === dataDir() ? api.dataDir(...parts) : join(dir, 'autotelic', ...parts)
    }
    const hub = api.core?.hub || {}
    const settings = () => api.settings()

    // ---------- 感知层（无 IO 副作用，可安全在 setup 构造） ----------
    const tagsOf = () => { try { return resolveTags((...p) => api.dataDir(...p)) } catch { return undefined } }
    const observe = createObserve({
      file: () => own('observations.jsonl'),
      tagsOf,
      hooks: {
        // 主人纠偏（§3.6 最高优先级）：观察层识别出「别做X」→ 抑制表进 feedback.json
        onCorrection: (c) => { try { ctx()?.feedback.ingestCorrection(c.text, { tags: [c.tag] }) } catch (e) { log.debug?.('自驱v5：纠偏入表失败：', e?.message) } },
      },
    })
    const chatCollector = createChatCollector({ hub, identity: api.core?.identity, observe })

    // 情绪观察桥（§9.2 R12）：mood 模块的情绪状态 advancing → 一条 source=emotion 观察。
    // 轮询接线（宿主 session/event 不直达模块；轮询是既有模块惯例），接不到就惰性 not-wired。
    let lastEmoAt = 0
    const emotionBridge = createEmotionBridge({
      observe,
      fetchEmotions: () => {
        let s = null
        try { s = api.use('mood')?.state?.() } catch { s = null }
        if (!s || !Number(s.emotionsAt) || Number(s.emotionsAt) <= lastEmoAt) return []
        lastEmoAt = Number(s.emotionsAt)
        const top = s.emotionTop?.[0]?.key
          || (s.emotions && Object.entries(s.emotions).sort((a, b) => (b[1] || 0) - (a[1] || 0))[0]?.[0])
          || ''
        if (!top) return []
        return [{ text: `这阵子心里主要的感觉是「${top}」`, tag: '牵挂', salience: 0.6, ts: Number(s.emotionsAt) }]
      },
    })

    // ---------- 决策环 / 排程 / 执行（纯闭口，setup 期零 IO） ----------
    const constraintFile = () => own('constraints.txt')
    const prefixCache = createPrefixCache()

    let ctx = null // 重件（有 IO 面）懒初始化：enabled=false 时绝不构造（场景 1 零 IO）
    function ctxOf() {
      if (ctx) return ctx
      const feedback = createFeedback({
        file: own('feedback.json'),
        // 中危 9（集成审查）：feedback 的事件流水另立文件，不再 append 进 decisions.jsonl——
        // 那条链由 plan.js 的哈希链独占，旁路写入会被 verifyDecisionLog 判成断链。
        decisionsFile: own('feedback-events.jsonl'),
        settings,
        log,
      })
      const watcher = createConstraintWatcher({ file: constraintFile(), onAudit: note })
      const skillsStore = createSkillStore(api.dataDir('skills'), {
        distill: (entries) => distillViaLlm(entries),
        personaFile: personaCardPath(),
        log: (...v) => log.debug?.(...v),
      })
      // 决策环（decisions.jsonl 路径在初始化时定死；人格切换后由下一次 init 生效）
      const planner = createPlanner({ decisionFile: own('decisions.jsonl'), hub, settings, log })
      // 执行器（book/skills/feedback 全部接已解析实例；touch-owner 确认队列在本实例内）
      const exec = createExecV5({
        settings,
        hub,
        book: {
          addTask: (...a) => getBook().addTask(...a),
          close: (...a) => getBook().close(...a),
        },
        skills: skillsStore,
        feedback,
        auditNote: note,
        dataDir: own(''),
        hooks: { selfCheck: selfCheckOwner },
        log,
      })
      ctx = { feedback, watcher, skillsStore, planner, exec }
      return ctx
    }
    function personaCardPath() {
      try {
        const id = personaNow(api.config())
        return personaDataDir(api.config(), id, `${id}.md`)
      } catch { return '' }
    }
    /** 技能提炼调用（晋升注入点）：一次 LLM 调用把同主题记忆合成方法论；失败由 skills.js 模板兜底。 */
    async function distillViaLlm(entries) {
      if (!hub?.runSystemTurn) return null
      const raw = await hub.runSystemTurn('autotelic-distill', '自驱 · 技能提炼',
        [
          '把下面这几条同主题的经历片段，提炼成一条她自己的做事方法论。',
          '只输出 JSON 数组：[{"title":"方法名（≤20字）","content":"分步怎么做（≤300字）"}]',
          JSON.stringify(entries),
        ].join('\n'),
        { timeoutMs: 60000, noTools: true, key: 'distill' })
      const m = String(raw ?? '').match(/\[[\s\S]*\]/)
      return m ? JSON.parse(m[0]) : null
    }

    /** touch-owner 发言自查（§3.5）：「这条消息删掉主人会损失什么」，答不出就不放行。 */
    async function selfCheckOwner({ ticket, step, text }) {
      if (!hub?.runSystemTurn) return { pass: false, loss: '' }
      const raw = await hub.runSystemTurn('autotelic-selfcheck', '自驱 · 发言自查',
        [
          '你想对主人说下面这句话。回答一个问题：删掉这条消息，主人会损失什么？',
          '答不出具体损失就输出 {"loss":""}（那就不该发）；答得出输出 {"loss":"一句话"}。只输出 JSON。',
          `场景：${ticket?.intent || ''}；内容：${String(text || '').slice(0, 400)}`,
        ].join('\n'),
        { timeoutMs: 60000, noTools: true, key: 'selfcheck' })
      const m = String(raw ?? '').match(/\{[\s\S]*\}/)
      const loss = m ? String(JSON.parse(m[0]).loss || '') : ''
      return { pass: loss.length > 0, loss }
    }

    // 账本按人格惰性切换（文件跟着 own() 走，人格一换就换一本，切回来接着记）。
    let bookInst = null
    let bookKey = ''
    function getBook() {
      const dir = own('')
      if (!bookInst || bookKey !== dir) {
        bookInst = createBook({
          file: join(dir, 'ledger.json'),
          maxActive: Number(settings().maxTasksActive) || 8,
          maxSteps: Number(settings().maxSteps) || 8,
          actionsPerHour: Number(settings().budgetActionsPerHour) || 12,
          log,
        })
        bookKey = dir
      }
      return bookInst
    }

    const journal = createJournal(() => own())

    // ---------- 心念点火事件（沉淀完成 → 下一拍点燃一次回味） ----------
    let igniteQueuedAt = 0
    function queueIgnite() { igniteQueuedAt = Date.now() }

    // ---------- 复盘接线：exec 终态 → plan.reviewRound → skills.ingestReflection ----------
    function makeReviewer() {
      const c = ctxOf()
      return async (review) => {
        const artifact = await reviewRound(review, { decisionFile: own('decisions.jsonl'), hub, settings, log })
        const ing = c.skillsStore.ingestReflection(artifact)
        if (ing.ok) {
          note({ kind: 'autotelic/reflect', args: { ticket: review.ticketId, next: artifact.suggestions?.next }, outcome: `沉淀：${ing.id}` })
          if ((ing.promoted || []).length) queueIgnite() // 晋升发生 → 下一拍点燃一次回味（心念点火）
        }
        return artifact
      }
    }

    const exec = { // 路由面用的稳定句柄：真身懒构造在 ctx.exec（确认队列同实例，跨路由一致）
      run: (ticket, opts) => ctxOf().exec.run(ticket, opts),
      confirm: (id) => ctxOf().exec.confirm(id),
      pendingList: () => (ctx ? ctx.exec.pendingList() : []),
    }

    // ---------- 一轮回味（schedule.run 回调）：观察窗口 → 生成 → 把关 → 前置否决 → 行动 ----------
    async function runRound(reason, meta = {}) {
      const c = ctxOf()
      const s = settings()
      // 1) 约束同步（面板文本框 → constraints.txt）+ 变更感知（「主人改了规矩」可感知）
      await syncConstraints()
      const chg = await c.watcher.detectChange().catch(() => ({ changed: false }))
      if (chg.changed && chg.event) {
        observe.append({ source: 'note', tag: '牵挂', text: `主人改了规矩：${(chg.event.added || []).length} 增 ${(chg.event.removed || []).length} 删`, salience: 1 })
        queueIgnite()
      }
      const rules = (await c.watcher.load()).rules
      const constraintRulesText = rulesTextOf(rules)

      // 2) 静默轮（熔断期）：只积累不立项（§3.6）
      if (c.feedback.isSilent()) return { outcome: 'silent', why: '熔断静默期' }

      // 3) 观察窗口（近端 3 天原文；ts → plan 契约的 at；抑制/park 中 tag 的观察不进窗口）
      const since = Date.now() - 3 * 24 * 3600_000
      const window = observe.list({ since, limit: 120 })
        .map((r) => ({ id: r.id, at: r.ts, source: r.source, tag: r.tag, text: r.text }))
        .filter((o) => c.feedback.weightOf(o.tag) > 0)
      if (window.length < 2) return { outcome: 'skipped-no-observation' }

      // 4) 人格锚 + 本能附加段 + 技能索引 + 自身状态薄摘要（§9.3：前缀段稳定可缓存）
      let personaSummary = ''
      try { personaSummary = String(currentPersonaText(personaNow(api.config())) || '').slice(0, 1200) } catch { personaSummary = '' }
      const instincts = c.skillsStore.list('instinct').map((d) => ({ id: d.id, title: d.meta.title, content: String(d.body || '').slice(0, 300) }))
      const instinctExtra = instincts.map((d) => `【本能·${d.title}】${d.content}`).join('\n')
      const prefixText = prefixCache.build({ personaSummary, instincts, constraints: constraintRulesText })
      const skillIndex = (c.skillsStore.index().items || [])
        .filter((i) => i.layer === 'skills' || i.layer === 'instinct')
        .map((i) => `${i.id} | ${i.title || ''} | ${(i.tags || []).join('/')}`)
        .join('\n')
      const selfState = `近期行动：${getBook().list().slice(-3).map((t) => `${t.title}:${t.status}`).join('；') || '（无）'}；观察总量 ${observe.stats().total}`

      // 5) 三段决策环（①生成 → ②把关；constraintRules 已在前缀段与把关前置否决注入）
      const round = Math.floor(Date.now() / 60000)
      const res = await planner.decideRound({
        round,
        persona: { summary: personaSummary, instinctExtra },
        constraintRulesText,
        observations: window,
        selfState,
        skillIndex,
        ticketBudget: { maxSteps: 4, timeoutMs: Number(s.scriptTimeoutMs) || 120000 },
        // D15：前缀段走 prefix.js 的缓存拼装（同一输入永远同一输出，version hash 没变就不重拼）
        systemPrefix: prefixText,
      })
      const dead = res.outcome !== 'tickets'
      const breaker = c.feedback.recordRound({ dead })
      if (dead) return { outcome: res.outcome, deadReasons: res.deadReasons, dropped: res.dropped, breaker }

      // 5.5) park 挂起项：进下轮观察（挂起的念头不蒸发）+ 90 天复活检查（集成审查中危 6）
      for (const p of res.parked || []) recordParked(p)

      // 6) 集成层前置否决（constraint.check 机械核对，排最前，§3.3 判据 0）+ 反馈权重过滤 → 执行
      const reviewer = makeReviewer()
      const results = []
      for (const tk of res.tickets) {
        const veto = constraintCheck(rules, tk)
        if (veto.vetoed) {
          note({ kind: 'autotelic/constraint-veto', args: { ticket: tk.id, tag: tk.tag, rules: veto.hits.map((h) => h.index) }, outcome: 'constraintRules 前置否决：在念头阶段就停下' })
          c.feedback.recordStop()
          results.push({ ticket: tk.id, status: 'rejected', why: '触犯强制约束规则' })
          continue
        }
        if (c.feedback.weightOf(tk.tag) <= 0) {
          results.push({ ticket: tk.id, status: 'skipped', why: '该方向被抑制/park 中' })
          continue
        }
        // §3.7 注入位置二：约束全文进行动单，exec 会在每个执行回合头部前置
        tk.constraintRulesText = constraintRulesText
        // 必修①（D9 链路）：立项时把「她会不会这件事」锚到既有技能——resolveMethod 命中
        // 就写 skillId（exec 终态落账时会调 skills.recordOutcome(skillId, …)）；
        // 未命中（探索模式）不硬凑，行动结束后按对象形态 { tag, status } 记账（skills 已支持）。
        const method = c.skillsStore.resolveMethod(tk.tag, { kind: tk.tag, text: `${tk.intent} ${tk.reason}` })
        if (method?.doc?.meta?.id) tk.skillId = method.doc.meta.id
        // recordDelivery 挪到真实投递之后（集成审查中危 8 后半）：确认排队中不开观察窗，
        // 免得没发出去的行动到点被记 ignored 折磨冷度。
        const outcome = await exec.run(tk, { plan: { reviewRound: reviewer } })
        if (tk.ownerSide && outcome.status !== 'queued') c.feedback.recordDelivery({ id: tk.id, tag: tk.tag, text: tk.intent })
        // 未锚到技能的行动单：熟练度链路也要全通——按对象形态记账（aborted 内部不计分）；
        // 库里还没有该方向条目时（探索模式），把真实终态立为候选记忆（下一轮就能被 resolveMethod 命中）
        if (!tk.skillId && (outcome.status === 'done' || outcome.status === 'failed')) {
          try {
            const rec = c.skillsStore.recordOutcome({ tag: tk.tag, status: outcome.status, ownerResponse: outcome.ownerResponse || '' })
            if (!rec.ok && String(rec.why || '').includes('落不到任何条目')) {
              c.skillsStore.ingestReflection({ topic: tk.tag, text: `行动「${tk.intent}」真实复用终态 ${outcome.status}（立为候选经验）`, finalStatus: outcome.status })
            }
          } catch (e) { log.debug?.('自驱v5：终态记账失败：', e?.message) }
        }
        results.push({ ticket: tk.id, status: outcome.status, why: outcome.why || '' })
        if (outcome.status === 'aborted' || outcome.status === 'rejected') c.feedback.recordStop()
      }
      return { outcome: 'tickets', tickets: res.tickets.map((t) => ({ id: t.id, intent: t.intent, tag: t.tag })), results, breaker }
    }

    // ---------- park 挂起表：挂起的念头进下轮观察 + 90 天复活检查（集成审查中危 6） ----------
    function recordParked(p) {
      const file = own('parked.json')
      const list = readJsonSafe(file, [])
      const at = Date.now()
      const entry = { title: String(p.title || '').slice(0, 120), tag: String(p.tag || ''), evidence: Array.isArray(p.evidence) ? p.evidence : [], gateWhy: String(p.gateWhy || '').slice(0, 160), parkedAt: at }
      // 复活检查：挂满 90 天的念头——摘掉，写一条高显著度观察让下一轮重新惦记它
      const revive = []
      const keep = []
      for (const e of [...list, entry]) {
        if (at - (e.parkedAt || 0) >= 90 * 24 * 3600_000) revive.push(e)
        else keep.push(e)
      }
      writeJsonSafe(file, keep.slice(-50))
      const tagOf = (t) => (isValidParkTag(t) ? t : '未完成')
      for (const e of revive) {
        observe.append({ source: 'note', tag: tagOf(e.tag), text: `这个念头挂了 90 天，重新想想：${e.title}`, salience: 0.9 })
      }
      observe.append({ source: 'note', tag: tagOf(entry.tag), text: `有个念头被自己挂起了（等换个时机或主人松口）：${entry.title}`, salience: 0.8 })
    }
    function isValidParkTag(tag) { try { return resolveTags((...p) => api.dataDir(...p)).includes(tag) } catch { return false } }

    /** 面板 constraintRules 文本框 → constraints.txt 落盘（watcher 的真相来源）。 */
    async function syncConstraints() {
      const text = String(settings().constraintRules ?? '')
      try {
        const cur = await readFileP(constraintFile(), 'utf8').catch(() => null)
        if (cur !== text) {
          await writeFileP(constraintFile(), text, 'utf8')
          note({ kind: 'autotelic/constraint-sync', args: { chars: text.length }, outcome: '面板约束已同步落盘' })
        }
      } catch (e) { log.debug?.('自驱v5：约束同步失败：', e?.message) }
    }

    // ---------- 排程（双轨：定时回味 + 心念点火） ----------
    const schedule = createSchedule({ settings, file: () => own('schedule.json'), run: runRound, hooks: { onError: (e) => log.debug?.('自驱v5：回味出错：', e?.message) } })

    // ---------- 主人回应记账（通道层规则，不耗模型调用，§3.6） ----------
    /** 从一段文本里抽 ≥2 字关键词段（判「主人的话是否在回应这次行动」用）。 */
    const keywordsOf = (text) => String(text || '')
      .split(/[，。！？、；：,.!?;:\s（）()"「」''—…]+/)
      .map((s) => s.trim())
      .filter((s) => [...s].length >= 2)
    function scanOwnerReplies() {
      const c = ctxOf()
      const windows = c.feedback.snapshot().windows
      if (!windows.length) return
      const ownerId = String(api.core?.identity?.owner?.() || '')
      if (!ownerId) return
      let entries = []
      try {
        const days = hub.chatLogDays?.() || []
        for (const day of days.slice(-2)) entries = entries.concat(hub.chatLogOf?.(day) || [])
      } catch { return }
      for (const w of windows) {
        const replies = entries.filter((e) => e?.chatId === `private:${ownerId}` && e.who !== 'bot' && (Number(e.t) || 0) >= w.at)
        if (!replies.length) continue
        // 中危 8（集成审查）：判档收紧——只有「话头对得上这次行动」的私聊才算回应，
        // 主人在窗口里聊别的事不记 replied（否则 ignored 信号被稀释）。
        const kws = keywordsOf(w.text || '')
        const related = replies.filter((e) => {
          const t = String(e.text || '')
          return kws.some((k) => t.includes(k))
        })
        if (!related.length) continue // 窗口继续开着：真无关就等它到点记 ignored
        const last = related[related.length - 1]
        const text = String(last.text || '').trim()
        const perfunctory = text.length < 6 || /^(嗯+|哦+|好+|行+|噢+|哈+|6+|666+)[。！~\s]*$/i.test(text)
        c.feedback.recordResponse(w.id, perfunctory ? 'perfunctory' : 'replied')
      }
    }

    /** 恢复条件一（mention）自动检测（集成审查中危 7）：主人主动提及相关话题 → park 解封。 */
    function scanParkMentions() {
      const c = ctxOf()
      const park = c.feedback.snapshot().park || {}
      const tags = Object.keys(park)
      if (!tags.length) return
      const ownerId = String(api.core?.identity?.owner?.() || '')
      if (!ownerId) return
      let entries = []
      try {
        const days = hub.chatLogDays?.() || []
        for (const day of days.slice(-2)) entries = entries.concat(hub.chatLogOf?.(day) || [])
      } catch { return }
      const ownerMsgs = entries.filter((e) => e?.chatId === `private:${ownerId}` && e.who !== 'bot')
      for (const tag of tags) {
        const sinceAt = park[tag]?.at || 0
        const hit = ownerMsgs.find((e) => (Number(e.t) || 0) >= sinceAt && String(e.text || '').includes(tag))
        if (hit) {
          c.feedback.resume(tag, 'mention')
          note({ kind: 'autotelic/resume-mention', args: { tag }, outcome: `主人主动提及相关话题，${tag} 解封` })
        }
      }
    }

    // ---------- 60s 心跳（接线层）：接管兜底 → 反馈维护 → 感知 → 排程 ----------
    api.every(60_000, async () => {
      const s = settings()
      if (!s.enabled) return // 总开关关着：什么都不做（场景 1）
      // 接管兜底：主人手动把它改回 true → 压回去并留痕
      try {
        const flipped = findFlipped({ getConfig: api.config, backup: takeoverBackup() })
        if (flipped.length) {
          repressTakeover({ getConfig: api.config, setConfig: api.setConfig, backup: takeoverBackup() })
          note({ kind: 'autotelic/takeover', args: { action: 'resuppress', targets: flipped.map((f) => f.id) }, outcome: '主人手动改回，接管期间被压回' })
          log.info?.(`自驱：接管兜底，压回 ${flipped.map((f) => f.id).join('、')}`)
        }
      } catch (error) { log.debug?.('自驱：接管兜底出错：', error?.message) }

      try {
        const c = ctxOf()
        c.feedback.tick() // 回应窗到期记 ignored、冷度半衰
        scanOwnerReplies() // 主人回话了（且话头对得上）→ replied/perfunctory 记账
        scanParkMentions() // 主人主动提及相关话题 → park 解封（恢复条件一）
        chatCollector.collect() // 聊天流水 → 观察
        emotionBridge.collect() // 情绪波动 → 观察（情绪也是经历）
        getBook().heartbeat('等待下一拍')
        if (igniteQueuedAt && Date.now() - igniteQueuedAt > 1000) {
          igniteQueuedAt = 0
          await schedule.ignite('沉淀完成').catch(() => {})
        }
        await schedule.tick()
      } catch (error) { log.debug?.('自驱：心跳出错：', error?.message) }
    }, '自驱引擎心跳')

    // ---------- 她的手（P3/P4 保留，只在 system:autotelic* 的会话里出现） ----------
    const oldSkills = createSkills(api.dataDir())
    const userModulesDir = () => { try { return (typeof api.core?.modules?.dir === 'function') ? api.core.modules.dir() : '' } catch { return '' } }
    let envCache = null
    const probeFn = api.__autotelicTestHooks?.probePython || probePython
    const readEnv = () => { if (envCache == null) envCache = loadEnvCache(api.dataDir('env.json')); return envCache }
    const pythonEnv = async ({ force = false } = {}) => {
      const cached = readEnv()
      const s = settings()
      if (!force && envUsable(cached) && (!s.pythonBin || cached.source === 'configured')) return cached
      envCache = await probeFn({ configured: s.pythonBin })
      if (envCache) envCache.source = s.pythonBin ? 'configured' : 'probed'
      saveEnvCache(api.dataDir('env.json'), envCache)
      if (!envCache) log.info?.('自驱：本机没有探测到可用 Python，这项能力关闭')
      else log.info?.(`自驱：Python 用 ${envCache.bin}（${envCache.version}，${envCache.source === 'configured' ? '手填' : '自动探测'}）`)
      return envCache
    }
    const spend = (what) => {
      const bk = getBook()
      if (bk.actionsInLastHour() >= settings().budgetActionsPerHour) return { ok: false, message: `动作预算到顶（${settings().budgetActionsPerHour}/小时），这小时不再动手` }
      bk.recordAction()
      note({ kind: 'autotelic/tool', tool: what, outcome: '动作预算内' })
      return { ok: true }
    }
    const isHer = (where) => String(where?.chat?.chatId || '').startsWith('system:autotelic')
    const clip = (s, n) => { const t = String(s || ''); return t.length > n ? t.slice(0, n) + '…' : t }
    /** 安静时段判定（v5 口径：醒着窗口的补集）。 */
    const quietNow = () => {
      const cfg = scheduleConfig(settings())
      const q = quietOf(cfg)
      return inQuietHours(Date.now(), { quietStart: q.quietStart, quietEnd: q.quietEnd })
    }

    // 接管浏览模块（保留 v3 交付，主人手动点）
    const liveModuleIds = () => {
      try {
        const list = api.core?.modules?.status?.() || []
        return list.filter((m) => m && m.running !== false).map((m) => m.id).filter(Boolean)
      } catch { return [] }
    }
    const takeoverProbe = () => probeTakeovers({ getConfig: api.config, liveIds: liveModuleIds(), extra: settings().takeoverExtra || [] })
    const takeoverBackup = () => (settings().takenOver && typeof settings().takenOver === 'object') ? settings().takenOver : {}
    const saveBackup = (backup) => api.saveSettings({ takenOver: backup })
    function repressIfNeeded() {
      const backup = takeoverBackup()
      if (!Object.keys(backup).length) return []
      const done = repressTakeover({ getConfig: api.config, setConfig: api.setConfig, backup })
      if (done.length) {
        log.info?.(`自驱：恢复接管，重压 ${done.map((d) => d.id).join('、')}`)
        note({ kind: 'autotelic/takeover', args: { action: 'repress', targets: done }, outcome: '重启后恢复接管（幂等重压）' })
      }
      return done
    }
    repressIfNeeded()

    api.tool((where) => {
      if (!settings().enabled || !isHer(where)) return []
      return [
        api.defineTool({
          name: 'autotelic_note',
          description: '写一篇笔记到你自己的目录（notes/ 年月日-标题.md）。用于记录你查到的东西、想留给以后的想法。',
          properties: { title: { type: 'string', description: '标题（做文件名用）' }, text: { type: 'string', description: '正文' } },
          required: ['title', 'text'],
          execute: async ({ title, text }) => {
            const spendR = spend('autotelic_note')
            if (!spendR.ok) return spendR
            try {
              const day = new Date()
              const p2 = (n) => String(n).padStart(2, '0')
              const safe = String(title || '无题').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40) || '无题'
              mkdirSync(own('notes'), { recursive: true })
              const file = own('notes', `${day.getFullYear()}-${p2(day.getMonth() + 1)}-${p2(day.getDate())}-${safe}.md`)
              const { writeFileSync } = await import('node:fs')
              writeFileSync(file, `# ${title}\n\n${text}\n`, 'utf8')
              return { ok: true, message: `写好了：${file}` }
            } catch (error) { return { ok: false, message: `写不了：${error.message}` } }
          },
        }),
        api.defineTool({
          name: 'autotelic_run_python',
          description: '跑一段 Python 脚本（子进程，超时会杀，不继承主程序的任何密钥环境变量）。stdout 会回给你；要留产物就写到你目录的 out/ 附近。',
          properties: { code: { type: 'string', description: 'Python 3 源码' }, saveAs: { type: 'string', description: '可选：保存为技能（id，小写字母/数字/-）。跑成功会累计，连续 2 次成功就学会' } },
          required: ['code'],
          execute: async ({ code, saveAs }) => {
            const s = settings()
            if (!s.allowPython) return { ok: false, message: '「允许跑 Python 脚本」没开（主人关的）' }
            const env = await pythonEnv()
            if (!env || !env.pythonBin) return { ok: false, message: '本机没有可用 Python（这项能力关闭；面板「自驱引擎」页可手动填解释器路径）' }
            const spendR = spend('autotelic_run_python')
            if (!spendR.ok) return spendR
            const r = await runPython({ dir: api.dataDir(), pythonBin: env.pythonBin, code, timeoutMs: Number(s.scriptTimeoutMs) || 120000 })
            note({ kind: 'autotelic/python', tool: 'run_python', args: { bytes: String(code || '').length, saveAs: saveAs || '' }, outcome: r.ok ? 'ok' : (r.error || 'failed') })
            let skillMsg = ''
            if (saveAs && String(saveAs).trim()) {
              const saved = oldSkills.save({ id: saveAs, script: code })
              skillMsg = saved.ok ? `；技能「${saveAs}」${oldSkills.recordRun(saveAs, r.ok).status}` : `；技能没存上：${saved.why}`
            } else {
              const m = (oldSkills.list() || []).find((x) => { const g = oldSkills.get(x.id); return g && g.script === code && g.status !== 'learned' })
              if (m) skillMsg = `；技能「${m.id}」${oldSkills.recordRun(m.id, r.ok).status}`
            }
            return { ok: r.ok, message: `${r.ok ? '跑完了' : '没跑成'}（${r.ms}ms）${r.error ? '：' + r.error : ''}${r.stdout ? '\n输出：' + clip(r.stdout, 3000) : ''}${skillMsg}` }
          },
        }),
        api.defineTool({
          name: 'autotelic_write_module',
          description: '给自己写一个用户模块（扩展能力，升级不丢）。只能写你自己的模块目录；框架代码永远写不到。',
          properties: { id: { type: 'string', description: '模块 id（小写字母开头，小写字母/数字/-）' }, code: { type: 'string', description: 'index.mjs 完整内容，必须 export default 模块对象' } },
          required: ['id', 'code'],
          execute: async ({ id, code }) => {
            if (!settings().allowUserModules) return { ok: false, message: '「允许写用户模块」没开（主人关的）' }
            const dir = userModulesDir()
            if (!dir) return { ok: false, message: '拿不到用户模块目录（模块系统不可用）' }
            const spendR = spend('autotelic_write_module')
            if (!spendR.ok) return spendR
            const r = writeUserModule({ dir, id, code })
            note({ kind: 'autotelic/module', tool: 'write_module', args: { id }, outcome: r.ok ? 'ok' : r.why })
            return { ok: r.ok, message: r.ok ? `写好了 ${r.file}。${r.note}` : r.why }
          },
        }),
        api.defineTool({
          name: 'autotelic_propose_say',
          description: '你想对主人说一句话。不直接发：交给出站治理统筹排程；安静时段先攒着。说不说、怎么说由治理和你判断，但「想过要说」会留痕。',
          properties: { text: { type: 'string', description: '想说的话' }, reason: { type: 'string', description: '为什么现在想说' } },
          required: ['text'],
          execute: async ({ text, reason }) => {
            const body = clip(text, 2000)
            if (quietNow()) {
              const pending = readJsonSafe(own('say-pending.json'), [])
              pending.push({ at: Date.now(), text: body, reason: clip(reason, 200) })
              writeJsonSafe(own('say-pending.json'), pending.slice(-20))
              return { ok: true, message: '现在是安静时段，这句先攒着（没丢，安静结束再交给治理）' }
            }
            const r = await api.proactive.submit({ text: body, itemId: `say-${Date.now()}`, cause: { kind: 'background' } })
            note({ kind: 'autotelic/say', tool: 'propose_say', args: { reason: clip(reason, 120) }, outcome: r?.state || 'unknown' })
            if (!r || r.state === 'unsupported') return { ok: false, message: '出站治理没开成 broker 档，这句话送不出去（要主人把 outboundPolicy.tier 设为 broker）' }
            if (r.state === 'dropped') return { ok: false, message: `治理没放行：${r.reason || 'denied'}（可以攒着以后再说）` }
            return { ok: true, message: `交给出站治理了（${r.state}）` }
          },
        }),
        api.defineTool({
          name: 'autotelic_propose',
          description: '给主人写提案（proposals/）：想要新能力、想改框架、想加工具，都写在这里。你永远改不到框架代码（src/）。',
          properties: { title: { type: 'string' }, body: { type: 'string' } },
          required: ['title', 'body'],
          execute: async ({ title, body }) => {
            const safe = String(title || '无题').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40) || '无题'
            try {
              mkdirSync(own('proposals'), { recursive: true })
              const file = own('proposals', `${Date.now()}-${safe}.md`)
              const { writeFileSync } = await import('node:fs')
              writeFileSync(file, `# 提案：${title}\n\n${body}\n`, 'utf8')
              note({ kind: 'autotelic/proposal', args: { title: clip(title, 60) }, outcome: 'ok' })
              return { ok: true, message: `提案写好了：${file}` }
            } catch (error) { return { ok: false, message: `写不了：${error.message}` } }
          },
        }),
        api.defineTool({
          name: 'autotelic_modules',
          description: '看看现在有哪些模块装着、开着（比如抖音、B站）。你只能看到清单——每个模块的具体能力要等主人逐个接给你。',
          properties: {},
          execute: async () => {
            const want = ['douyin', 'bili', 'heybox', 'tophub', 'tieba-reader', 'pet', 'phone', 'song', 'imagegen', 'memory']
            const rows = []
            for (const id of want) {
              let mod = null
              try { mod = api.use(id) } catch { mod = null }
              rows.push(`${mod ? '✓' : '✗'} ${id}${mod ? '（开着，能力待接入）' : '（没装或没开）'}`)
            }
            return { ok: true, message: rows.join('\n') }
          },
        }),
      ]
    })

    // ---------- 面板路由 ----------
    api.route('/autotelic/proposals', async () => {
      let list = []
      try { list = readdirSync(own('proposals')).filter((f) => f.endsWith('.md')).sort().reverse().slice(0, 20) } catch {}
      return { ok: true, list }
    })
    api.route('/autotelic/env', async (req) => {
      let probeOnly = false
      if (req && req.method === 'POST') {
        const body = await api.core.http.body(req).catch(() => ({}))
        if (body && typeof body.pythonBin === 'string' && body.pythonBin.trim()) {
          const bin = body.pythonBin.trim()
          const hit = await probeFn({ configured: bin })
          if (!hit || hit.bin !== bin) return { ok: false, message: `这个路径跑不出 Python 3（${bin}）。检查一下是不是全路径、是不是真装了` }
          api.setConfig({ ext: { autotelic: { pythonBin: bin } } })
          envCache = null
        }
        probeOnly = Boolean(body?.probe)
      }
      const s = settings()
      const env = s.enabled && s.allowPython ? await pythonEnv({ force: probeOnly }) : readEnv()
      return {
        ok: true,
        env: env || null,
        usable: envUsable(env),
        source: env?.source || '',
        hint: env?.pythonBin ? `${env.pythonBin}（${env.version}，${env.source === 'configured' ? '手填' : '自动探测'}，已持久化 env.json）` : '本机没有可用 Python（可以在这里手填解释器路径，会先验真再存）',
      }
    })
    // 手动入口（面板「现在想一轮」/「现在想想」）：schedule.fire——跳排程闸，不跳总开关与安静时段。
    api.route('/autotelic/plan', async () => {
      if (!settings().enabled) return { ok: false, message: '自驱引擎没开（本页可以打开）' }
      const r = await schedule.fire('手动回味')
      return { ok: r.outcome === 'run', message: roundMessage(r), ...r }
    })
    // 旧面板按钮的别名：同一入口。
    api.route('/autotelic/run', async () => {
      if (!settings().enabled) return { ok: false, message: '自驱引擎没开（本页可以打开）' }
      const r = await schedule.fire('手动回味')
      return { ok: r.outcome === 'run', message: roundMessage(r), ...r }
    })
    // v5 没有单步推进（行动单整单跑），旧按钮给一句实话。
    api.route('/autotelic/step', async () => ({ ok: false, message: 'v5 没有单步推进：行动单整单自动跑，用「现在想一轮」代替' }))
    // 零副作用预览（旧面板按钮兼容）：她最近的观察与想事过程，不写任何状态。
    api.route('/autotelic/preview', async () => {
      const c = ctx
      const stats = observe.stats()
      const recent = observe.list({ limit: 8 }).map((r) => ({ id: r.id, at: r.ts, source: r.source, tag: r.tag, text: r.text }))
      return {
        ok: true,
        v5: true,
        observe: stats,
        recent,
        schedule: schedule.view(),
        feedback: c ? c.feedback.snapshot() : null,
        nextFireAt: schedule.view().nextFireAt,
        hint: 'v5 的决策是三段式回味：这里能看到她最近注意到什么、下一次回味排在什么时候',
      }
    })
    // touch-owner 确认闸：放行 / 待确认清单。
    api.route('/autotelic/confirm', async (req) => {
      if (!settings().enabled) return { ok: false, message: '自驱引擎没开' }
      const body = await api.core.http.body(req).catch(() => ({}))
      const c = ctxOf()
      if (body?.list) return { ok: true, pending: exec.pendingList() }
      const ticketId = String(body?.ticketId || '')
      if (!ticketId) return { ok: false, message: '缺 ticketId', pending: exec.pendingList() }
      // 主人点了确认 = 真实投递 → 这时才开回应观察窗（集成审查中危 8：排队中不折靡冷度）
      const pendingItem = exec.pendingList().find((p) => p.ticketId === ticketId)
      const r = await exec.confirm(ticketId)
      if (pendingItem?.tag && r.status !== 'queued' && r.status !== 'aborted') {
        c.feedback.recordDelivery({ id: ticketId, tag: pendingItem.tag, text: pendingItem.intent })
      }
      return { ok: r.status === 'done' || r.status === 'failed', message: `行动单 ${ticketId}：${r.status}${r.why ? '（' + r.why + '）' : ''}`, ...r }
    })
    // 技能库面板口（GET 清单 + POST 回滚/归档——裁决一的安全兜底要能「按」不能只「看」，集成审查中危 5）。
    api.route('/autotelic/skills', async (req) => {
      const c = ctx?.skillsStore ? ctx : null
      if (req && req.method === 'POST' && c) {
        const body = await api.core.http.body(req).catch(() => ({}))
        if (body?.action === 'rollback' && body.stamp) {
          const r = c.skillsStore.rollback(String(body.stamp))
          note({ kind: 'autotelic/skill-rollback', args: { stamp: body.stamp, restored: r.restored || 0 }, outcome: r.ok ? '主人一键回滚技能库快照' : (r.why || '回滚失败') })
          return { ok: r.ok, message: r.ok ? `回滚了快照 ${body.stamp}（${r.restored} 个文件）` : (r.why || '回滚失败') }
        }
        if (body?.action === 'archive' && body.id) return { ok: true, ...c.skillsStore.archive(String(body.id)) }
        if (body?.action === 'revise' && body.id) return { ok: true, ...c.skillsStore.revise(String(body.id), { content: body.content, title: body.title }) }
        return { ok: false, message: '不认识的操作' }
      }
      return {
        ok: true,
        list: oldSkills.list(),
        v5: c ? { index: c.skillsStore.index(), stale: c.skillsStore.suggestStale(), snapshots: c.skillsStore.listSnapshots().slice(0, 20) } : null,
      }
    })
    // 反馈回路面板：快照 / 恢复 / 检视完成。
    api.route('/autotelic/feedback', async (req) => {
      const c = ctxOf()
      if (req && req.method === 'POST') {
        const body = await api.core.http.body(req).catch(() => ({}))
        if (body?.action === 'resume' && body.tag) return { ok: true, ...c.feedback.resume(String(body.tag), ['mention', 'explicit', 'panel'].includes(body.source) ? body.source : 'panel'), snapshot: c.feedback.snapshot() }
        if (body?.action === 'clearReview') { c.feedback.clearReview(); return { ok: true, snapshot: c.feedback.snapshot() } }
        return { ok: false, message: '不认识的操作' }
      }
      return { ok: true, snapshot: c.feedback.snapshot() }
    })
    // 决策审计面板：「她最近想事的过程」（decisions.jsonl 尾部 + 链校验）。
    api.route('/autotelic/decisions', async () => {
      const file = own('decisions.jsonl')
      const chain = await verifyDecisionLog(file)
      let tail = []
      try {
        const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
        tail = lines.slice(-20).map((l) => { try { return JSON.parse(l) } catch { return { phase: 'corrupt' } } })
      } catch { /* 还没有决策日志 */ }
      return { ok: true, chain, tail: tail.reverse() }
    })
    // 接管 / 还原（保留）。
    api.route('/autotelic/takeover', async (req) => {
      const body = await api.core.http.body?.(req).catch(() => ({})) || {}
      const want = body.on === undefined ? !settings().takeover : Boolean(body.on)
      if (want) {
        const probe = takeoverProbe()
        if (!probe.length) {
          const live = liveModuleIds()
          return { ok: false, message: `没找到可接管的浏览模块${live.length ? `（在跑：${live.join('、')}）` : '（没有模块在跑？）'}。装了抖音/B站之类的模块再点`, takeover: takeoverView(takeoverBackup()) }
        }
        const backup = applyTakeover({ getConfig: api.config, setConfig: api.setConfig, probe })
        saveBackup(backup)
        api.saveSettings({ takeover: true })
        note({ kind: 'autotelic/takeover', args: { action: 'on', targets: Object.keys(backup) }, outcome: '主人手动点开接管' })
        log.info?.(`自驱：接管浏览模块 ${Object.keys(backup).join('、')}`)
        return { ok: true, message: `接管了 ${Object.keys(backup).join('、')}：自主循环已压制。刷什么由她的回味决定`, takeover: takeoverView(backup) }
      }
      const done = restoreTakeover({ getConfig: api.config, setConfig: api.setConfig, backup: takeoverBackup() })
      saveBackup({})
      api.saveSettings({ takeover: false })
      note({ kind: 'autotelic/takeover', args: { action: 'off', targets: done.map((d) => d.id) }, outcome: '主人手动关掉接管，原值已还原' })
      return { ok: true, message: done.length ? `已还原 ${done.map((d) => d.id).join('、')} 的原配置` : '没接管过，不用还原', takeover: takeoverView({}) }
    })
    api.route('/autotelic/takeover-status', async () => ({
      ok: true,
      on: Boolean(settings().takeover),
      takeover: takeoverView(takeoverBackup()),
      candidates: takeoverProbe().map((t) => ({ id: t.id, key: t.key, from: t.from })),
      live: liveModuleIds(),
    }))
    // 调参（v5 收窄：只许动节奏键，其余主人面板改）。
    api.route('/autotelic/tune', async (req) => {
      const body = await api.core.http.body(req).catch(() => ({}))
      const patch = body && typeof body === 'object' ? body.patch || body : {}
      const ALLOWED = ['awakeFrom', 'awakeTo', 'minIntervalMinutes', 'maxIntervalMinutes', 'maxPerDay', 'igniteCooldownMinutes']
      const applied = {}
      const rejected = {}
      for (const [k, v] of Object.entries(patch || {})) {
        if (!ALLOWED.includes(k)) { rejected[k] = '不在可调清单'; continue }
        const n = Number(v)
        if (!Number.isFinite(n)) { rejected[k] = '要数字'; continue }
        applied[k] = n
      }
      if (Object.keys(applied).length) api.setConfig({ ext: { autotelic: applied } })
      note({ kind: 'autotelic/tune', args: { patch: applied, rejected: Object.keys(rejected) }, outcome: '调参动作本身进审计（C5）' })
      return { ok: true, message: `调好了：${Object.entries(applied).map(([k, v]) => `${k}=${v}`).join('、')}${Object.keys(rejected).length ? `（拒了 ${Object.keys(rejected).length} 项）` : ''}`, applied, rejected }
    })
    // 复盘刊物（保留）。
    api.route('/autotelic/journal', async () => ({ ok: true, daily: journal.list('daily'), dreams: journal.list('dreams') }))
    // 某一天的记录（保留：账本/审计/对账跟着人格走）。
    api.route('/autotelic/day', async (req) => {
      const q = api.core.http.query(req)
      const date = String(q.date || '').trim()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, message: '日期格式要 YYYY-MM-DD' }
      const audit = await readAuditDay(auditDir(), date)
      const dayTs = new Date(`${date}T00:00:00`).getTime()
      const dayEnd = dayTs + 24 * 3600_000
      const inDay = (ts) => ts >= dayTs && ts < dayEnd
      const taskId = String(q.taskId || '').trim()
      const book = getBook()
      if (taskId) {
        const task = book.list().find((t) => t.id === taskId)
        if (!task) return { ok: false, message: '账本里没有这条任务了（可能被修剪掉）' }
        const from = task.createdAt
        const to = task.status === 'active' ? Date.now() : (task.updatedAt || task.createdAt)
        const notes = []
        try {
          const nDir = own('notes')
          const all = readdirSync(nDir).filter((f) => f.endsWith('.md'))
          for (const f of all) {
            const full = join(nDir, f)
            const st = statSync(full)
            if (st.mtimeMs >= from && st.mtimeMs <= to + 60_000) notes.push({ file: f, at: st.mtimeMs, text: readFileSync(full, 'utf8').slice(0, 6000) })
          }
        } catch { /* notes 目录还没有 */ }
        notes.sort((a, b) => a.at - b.at)
        return { ok: true, date, taskId, task, notes, audit: audit.filter((a) => { const at = Date.parse(a.at || ''); return Number.isFinite(at) && at >= from && at <= to + 60_000 }) }
      }
      const tasks = book.list().filter((t) => inDay(t.createdAt) || inDay(t.updatedAt))
      const chain = await verifyAuditChain(auditDir(), date)
      const reconciled = reconcileDay({ audit, tasks, dailyText: journal.read('daily', date), chain })
      return { ok: true, date, audit, tasks, daily: journal.read('daily', date), dream: journal.read('dreams', date), reconcile: { ok: reconciled.ok, problems: reconciled.problems, text: problemsText(reconciled.problems) } }
    })

    // 状态路由（v5：新状态 + 兼容旧面板字段 + takenOver 透明）。
    api.route('/autotelic/status', async () => {
      const cfg = settings()
      const chain = await verifyAuditChain(auditDir())
      const book = getBook()
      const tasks = book.list()
      const c = ctx
      const scfg = scheduleConfig(cfg)
      const quiet = quietOf(scfg)
      let decisions = null
      try { decisions = await verifyDecisionLog(own('decisions.jsonl')) } catch { decisions = null }
      return {
        ok: true,
        enabled: !!cfg.enabled,
        quiet: { now: quietNow(), quietStart: quiet.quietStart, quietEnd: quiet.quietEnd, awakeFrom: cfg.awakeFrom, awakeTo: cfg.awakeTo },
        audit: { wired: auditWired(), dir: auditDir(), today: countToday(auditDir()), chain },
        summary: book.summary(),
        tasks: tasks.slice(-20).reverse(),
        heartbeats: book.meta().ticks,
        env: cfg.enabled && cfg.allowPython ? await pythonEnv() : readEnv(),
        skills: oldSkills.list().slice(0, 12),
        proposals: (() => { try { return readdirSync(own('proposals')).filter((f) => f.endsWith('.md')).length } catch { return 0 } })(),
        sayPending: (() => { try { return (JSON.parse(readFileSync(own('say-pending.json'), 'utf8') || '[]') || []).length } catch { return 0 } })(),
        takeover: takeoverView(takeoverBackup()),
        takenOver: takeoverBackup(),
        // —— v5 新状态 ——
        schedule: schedule.view(),
        observe: observe.stats(),
        feedback: c ? {
          suppress: Object.keys(c.feedback.snapshot().suppress),
          park: c.feedback.snapshot().park,
          breaker: c.feedback.snapshot().breaker,
          needsReview: c.feedback.needsReview(),
          silent: c.feedback.isSilent(),
        } : null,
        pendingConfirms: exec.pendingList(),
        decisions,
        constraintRuleChars: (() => { try { return readFileSync(constraintFile(), 'utf8').length } catch { return 0 } })(),
        screenVetoes: [],
      }
    })

    return {
      auditDir,
      schedule,
      observe,
      /** 决策环真身懒构造在 ctx（decisions.jsonl 按当前人格落位）；这里是稳定句柄。 */
      get planner() { return ctxOf().planner },
      exec,
      runRound,
      ctxOf,
      getBook,
      takeover: {
        probe: takeoverProbe,
        status: () => ({ on: Boolean(settings().takeover), ...takeoverView(takeoverBackup()) }),
        repress: repressIfNeeded,
      },
    }
  },
}

// ---------- helpers（模块级，无状态） ----------

function readJsonSafe(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}
function writeJsonSafe(file, value) {
  try { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, JSON.stringify(value), 'utf8') } catch { /* 攒话失败不致命 */ }
}

/** 手动/定时一轮的消息文案。 */
function roundMessage(r) {
  const o = r?.result?.outcome || r?.outcome
  if (o === 'tickets') {
    const done = (r?.result?.results || []).filter((x) => x.status === 'done').length
    const tks = r?.result?.tickets || []
    return `立项 ${tks.length} 个：${tks.map((t) => `「${t.intent}」`).join('、')}${done ? `，办完 ${done} 件` : ''}`
  }
  if (o === 'all-dead') return '这轮空手而归——没有想做的事（这是健康态）'
  if (o === 'silent') return '熔断静默期，这轮只积累不立项'
  if (o === 'skipped-no-observation') return '最近没什么可回味的观察，这轮不立项'
  if (o === 'parse-fail') return '这轮没读出自己的念头（回包没解析出来），按全灭处理'
  if (o === 'skipped-busy') return '上一轮还没想完，先不叠'
  if (o === 'skipped-disabled') return '自驱引擎没开'
  if (o === 'skipped-quiet') return '现在是安静时段，想事了但不点火'
  if (o === 'skipped-ignite-cooldown') return '刚点燃过，歇一会儿再想'
  if (o === 'failed') return '这轮出错了，看日志'
  return `这轮结束：${o}`
}

/** 今天的审计条数（读文件数行，供面板显示；出错按 0 处理）。 */
function countToday(dir) {
  try {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    const text = readFileSync(join(dir, `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.jsonl`), 'utf8')
    return text.split('\n').filter((l) => l.trim()).length
  } catch {
    return 0
  }
}
