// 自驱引擎 v5 · 双轨排程触发（R10/D4，docs/design/autotelic-v5/00-v5-final.md §2.2）。
//
// 两轨并存（裁决三）：
//   · 定时回味——生物钟：60s tick 心跳 + 醒着窗口（awakeFrom/awakeTo，安静时段=补集）
//     + 间隔区间（minIntervalMinutes/maxIntervalMinutes，区间内按主人回话时刻直方图轻推，
//     风格同 purpose 的 replyHours/bestReplyHourShift）+ maxPerDay 单日上限；
//   · 心念点火——「忽然想起来」：技能沉淀完成、重要对话结束等事件点燃一次回味（ignite），
//     另有面板「现在想想」手动入口（fire）。两者都**跳过排程闸**（间隔/当日次数），
//     但**不跳过总开关与安静时段**（§2.2）。
//
// 防重入（坑#8）：自建 in-flight 标记（参考旧 runtime.js:51 的 running 模式——purpose 的
// runOnce 没有锁，别抄）；in-flight 时 tick/fire/ignite 一律跳过，记 skipped-busy。
//
// 静默时段不触发：awakeFrom/awakeTo 取补集得安静窗口（core/time-window.js 的 quietWindowOf，
// 判定复用 purpose 引擎的 inQuietHours——同一套跨天窗口口径，别另写一份）。

import { readJson, writeJson } from '../core/store.js'
import { quietWindowOf } from '../core/time-window.js'
import { inQuietHours, quietEndAfter, nextDayStartAfter, bestReplyHourShift } from '../purpose/engine.js'

const MINUTE = 60_000

/** 防抖随机数（测试注入）。 */
const defaultRandom = Math.random

const clampInt = (v, d, lo, hi) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d
}

/**
 * 配置映射（对齐 purpose.module.js 的 purposeConfig 风格）：模块 settings → 引擎配置。
 * @param {{enabled?, awakeFrom?, awakeTo?, minIntervalMinutes?, maxIntervalMinutes?, maxPerDay?, igniteCooldownMinutes?}} s
 */
export function scheduleConfig(s = {}) {
  return {
    enabled: s.enabled !== false,
    awakeFrom: clampInt(s.awakeFrom, 8, 0, 24),
    awakeTo: clampInt(s.awakeTo, 23, 0, 24),
    minIntervalMinutes: clampInt(s.minIntervalMinutes, 90, 5, 2880),
    maxIntervalMinutes: clampInt(s.maxIntervalMinutes, 240, 5, 2880),
    maxPerDay: clampInt(s.maxPerDay, 3, 0, 20), // 0 = 不限（仍受安静时段约束）
    igniteCooldownMinutes: clampInt(s.igniteCooldownMinutes, 45, 1, 720),
  }
}

/** 安静窗口（醒着窗口的补集；全天醒 = 00:00/00:00，引擎约定 start===end 视为不启用）。 */
export function quietOf(cfg) {
  return quietWindowOf(cfg.awakeFrom, cfg.awakeTo)
}

/**
 * 纯函数：从 now 出发排下一次定时回味时刻。
 * 间隔在 [min, max] 区间随机；主人回话直方图样本 ≥5 时向高回话小时轻推（≤3h）；
 * 落在安静时段就推到安静结束 + 0~20 分钟抖动；当日额度用尽推到次日起点。
 */
export function computeNextFire({ now, cfg, lastRunAt = 0, countToday = 0, replyHours = [], random = defaultRandom } = {}) {
  const quiet = quietOf(cfg)
  const qcfg = { quietStart: quiet.quietStart, quietEnd: quiet.quietEnd }
  const minMs = cfg.minIntervalMinutes * MINUTE
  const maxMs = Math.max(minMs, cfg.maxIntervalMinutes * MINUTE)
  let at
  if (cfg.maxPerDay > 0 && countToday >= cfg.maxPerDay) {
    at = nextDayStartAfter(now, qcfg)
  } else if (lastRunAt > 0) {
    at = lastRunAt + Math.round(minMs + random() * (maxMs - minMs))
    if (at < now + 2 * MINUTE) at = now + 2 * MINUTE // 停机很久：别攒一堆补发，只补一枪
  } else {
    at = now + Math.max(MINUTE, minMs / 2)
  }
  const shift = bestReplyHourShift(at, replyHours) // 直方图轻推（样本 <5 不偏置，引擎内判）
  if (shift > 0) at += shift
  if (inQuietHours(at, qcfg)) at = quietEndAfter(at, qcfg) + Math.round(random() * 20 * MINUTE)
  return at
}

/**
 * 造排程器。
 * @param {object} o
 * @param {()=>object} o.settings 模块设置（enabled/awakeFrom/...）
 * @param {string|(()=>string)} [o.file] 状态文件（api.dataDir('schedule.json')；不传=内存态，测试方便）
 * @param {(reason:string, meta:object)=>Promise<any>} o.run 一轮回味（决策环入口；集成步接线）
 * @param {()=>number} [o.now]
 * @param {()=>number} [o.random]
 * @param {object} [o.hooks] 测试注入点（照 api.__petTestHooks 模式）：{ onError }
 */
export function createSchedule({ settings, file = '', run, now = () => Date.now(), random = defaultRandom, hooks = {} } = {}) {
  let inFlight = false // 坑#8：自建防重入标记，finally 复位
  let lastIgniteAt = 0
  let state = null

  const fileOf = () => (typeof file === 'function' ? file() : file)
  const dayKeyOf = (t) => new Date(t).toDateString()

  function load(nowMs = now()) {
    const f = fileOf()
    // 没接状态文件（测试/内存态）：只初始化一次，绝不用空态覆盖内存里的账
    if (!f) {
      if (!state) state = {}
    } else {
      const raw = readJson(f, null)
      state = raw && typeof raw === 'object' ? raw : {}
    }
    if (state.day !== dayKeyOf(nowMs)) {
      // 跨天：当日计数清零（直方图与 seen 保留）
      state.day = dayKeyOf(nowMs)
      state.countToday = 0
    }
    state.lastRunAt = Number(state.lastRunAt) || 0
    state.nextFireAt = Number(state.nextFireAt) || 0
    state.countToday = Number(state.countToday) || 0
    state.replyHours = Array.isArray(state.replyHours) && state.replyHours.length === 24 ? state.replyHours : new Array(24).fill(0)
    state.replyHoursSeen = Array.isArray(state.replyHoursSeen) ? state.replyHoursSeen : []
    return state
  }
  const save = () => { const f = fileOf(); if (f) { try { writeJson(f, state) } catch (e) { hooks.onError?.(e) } } }

  /** 主人回话时刻直方图（24 桶，按素材 id 去重；与 purpose.recordOwnerReplyHours 同款口径）。 */
  function recordReply(at, id = '') {
    load()
    const t = Number(at) || 0
    if (!t || t > now()) return
    const key = String(id) || `t:${t}`
    const seen = new Set(state.replyHoursSeen.map(String))
    if (seen.has(key)) return
    seen.add(key)
    state.replyHoursSeen = [...seen].slice(-200)
    state.replyHours[new Date(t).getHours()] += 1
    save()
  }

  /** 执行一轮（共用通道）：防重入 + 计数 + 状态落盘。 */
  async function perform(reason, meta = {}, nowMs = now()) {
    if (inFlight) return { outcome: 'skipped-busy', reason }
    load(nowMs) // fire/ignite 可能先于 tick 被调：先把状态从盘上读齐（跨天清零也在这里做）
    inFlight = true
    const startedAt = nowMs
    try {
      const result = await run(reason, { scheduled: Boolean(meta.scheduled), startedAt, ...meta })
      state.lastRunAt = startedAt
      state.nextFireAt = 0
      state.countToday += 1
      state.lastOutcome = meta.scheduled ? 'tick' : reason
      state.lastSkip = null
      save()
      // 定时轨：跑完立刻排下一次（含直方图轻推）
      if (meta.scheduled) state.nextFireAt = computeNextFire({ now: nowMs, cfg: scheduleConfig(settings()), lastRunAt: state.lastRunAt, countToday: state.countToday, replyHours: state.replyHours, random })
      save()
      return { outcome: 'run', result, reason }
    } catch (error) {
      state.lastOutcome = 'failed'
      state.lastSkip = { at: now(), reason: String(error?.message || error).slice(0, 120) }
      save()
      hooks.onError?.(error)
      return { outcome: 'failed', error, reason }
    } finally {
      inFlight = false
    }
  }

  /**
   * 60s tick（接线层用 api.every(60_000, ...) 驱动；这里只判定，不自己起定时器——测试不打真定时）。
   * 排程闸顺序：总开关 → 安静时段 → 当日上限 → 到点 → 防重入（perform 内）。
   * @returns {{action:'run'|'wait'|'skipped-busy', reason:string, nextFireAt?:number, outcome?:string}}
   */
  async function tick(nowMs = now()) {
    const cfg = scheduleConfig(settings())
    load(nowMs)
    if (!cfg.enabled) return { action: 'wait', reason: 'disabled' } // 总开关：关着时连状态都不写
    const quiet = quietOf(cfg)
    const qcfg = { quietStart: quiet.quietStart, quietEnd: quiet.quietEnd }
    if (inQuietHours(nowMs, qcfg)) return { action: 'wait', reason: 'quiet', nextFireAt: quietEndAfter(nowMs, qcfg) }
    if (cfg.maxPerDay > 0 && state.countToday >= cfg.maxPerDay) {
      return { action: 'wait', reason: 'daily-max', nextFireAt: nextDayStartAfter(nowMs, qcfg) }
    }
    // 首次（无 nextFireAt）先排一次再等
    if (!state.nextFireAt) {
      state.nextFireAt = computeNextFire({ now: nowMs, cfg, lastRunAt: state.lastRunAt, countToday: state.countToday, replyHours: state.replyHours, random })
      save()
    }
    if (nowMs < state.nextFireAt) return { action: 'wait', reason: 'waiting', nextFireAt: state.nextFireAt }
    if (inFlight) return { action: 'skipped-busy', reason: 'in-flight' } // 撞上在途回味：跳过（坑#8）
    const r = await perform(`定时回味`, { scheduled: true }, nowMs)
    return { action: r.outcome === 'run' ? 'run' : r.outcome, reason: 'due', ...r }
  }

  /**
   * 手动入口 fire(reason)：面板「现在想想」与心念点火共用。
   * 跳过排程闸（间隔/当日次数），但**不跳过总开关与安静时段**（§2.2）。
   */
  async function fire(reason = '手动', nowMs = now()) {
    const cfg = scheduleConfig(settings())
    if (!cfg.enabled) return { outcome: 'skipped-disabled', reason }
    const quiet = quietOf(cfg)
    const qcfg = { quietStart: quiet.quietStart, quietEnd: quiet.quietEnd }
    if (inQuietHours(nowMs, qcfg)) return { outcome: 'skipped-quiet', reason }
    return perform(reason, { scheduled: false }, nowMs)
  }

  /**
   * 心念点火 ignite(reason)：由技能沉淀完成、重要对话结束等事件触发。
   * 本体走 fire（跳排程闸、不跳开关与安静），额外带事件侧冷却防事件风暴。
   */
  async function ignite(reason = '心念', nowMs = now()) {
    const cfg = scheduleConfig(settings())
    if (!cfg.enabled) return { outcome: 'skipped-disabled', reason }
    if (nowMs - lastIgniteAt < cfg.igniteCooldownMinutes * MINUTE) {
      return { outcome: 'skipped-ignite-cooldown', reason, retryAt: lastIgniteAt + cfg.igniteCooldownMinutes * MINUTE }
    }
    const r = await fire(`点火:${reason}`, nowMs)
    if (r.outcome === 'run' || r.outcome === 'failed') lastIgniteAt = nowMs
    return r
  }

  /** 面板/测试视图。 */
  function view(nowMs = now()) {
    load(nowMs)
    const cfg = scheduleConfig(settings())
    return {
      enabled: cfg.enabled,
      quiet: quietOf(cfg),
      inFlight,
      countToday: state.countToday,
      maxPerDay: cfg.maxPerDay,
      nextFireAt: state.nextFireAt,
      lastRunAt: state.lastRunAt,
      lastOutcome: state.lastOutcome || '',
      lastSkip: state.lastSkip || null,
      replyHours: state.replyHours,
    }
  }

  function dispose() {
    // 无自有定时器（tick 由接线层 api.every 驱动）；在途回味等它自然结束
  }

  return { tick, fire, ignite, recordReply, view, dispose, load, save }
}
