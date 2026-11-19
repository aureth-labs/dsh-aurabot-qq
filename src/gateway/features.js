// L2 细粒度功能表（Feature）与 5 步不可逆能力解析。
// 契约来源：src/gateway/contracts.d.ts（Feature / Caps / Gateway.features / Gateway.onCapsChanged）
// 文字规则：docs/CONTRACTS.md §八.6；架构定案：实现计划 §2.1。

import { VOICE_RANK, PROACTIVE_RANK } from './degrade.js'

const noopLog = { debug() {}, info() {}, warn() {}, error() {} }

/** 契约冻结的 14 项 L2 Feature 全集。 */
export const ALL_FEATURES = Object.freeze([
  'message.quote.send',
  'message.quote.read',
  'message.history.read',
  'message.forward.expand',
  'message.recall',
  'message.reaction',
  'media.fetch',
  'chat.member.list',
  'chat.member.read',
  'chat.typing',
  'sticker.send.native',
  'sticker.collect',
  'sticker.sync.native',
  'card.send',
])

const FEATURE_SET = new Set(ALL_FEATURES)

/** 带 L1 强联动关系的 8 项 Feature（不含独立演进的 chat.member.read）。 */
const L1_LINKED_FEATURES = Object.freeze({
  'message.quote.send': (caps) => Boolean(caps?.quoteReply),
  'message.history.read': (caps) => Boolean(caps?.history),
  'message.forward.expand': (caps) => Boolean(caps?.forwardExpand),
  'message.recall': (caps) => Boolean(caps?.recall),
  'chat.member.list': (caps) => Boolean(caps?.memberList),
  'chat.typing': (caps) => Boolean(caps?.typing),
  'sticker.send.native': (caps) => Boolean(caps?.sticker),
  'card.send': (caps) => Boolean(caps?.card),
})

/** 返回 14 项全为 false 的新对象（未连接或 caps === null 时使用）。 */
export function emptyFeatures() {
  const out = {}
  for (const key of ALL_FEATURES) out[key] = false
  return out
}

/** 根据 L1 Caps 推导第 1 步基准 Feature 表（无 L1 键项为 false；chat.member.read 先缺省跟随 memberList）。 */
export function deriveFeatures(caps) {
  const out = emptyFeatures()
  for (const [feature, reader] of Object.entries(L1_LINKED_FEATURES)) {
    out[feature] = reader(caps)
  }
  out['chat.member.read'] = Boolean(caps?.memberList)
  return out
}

/** 校验并提取合法的 Partial<Record<Feature, boolean>> 映射，丢弃未知键或非布尔值。 */
export function sanitizeFeaturesInput(raw, { instance = '', log = noopLog, source = 'caps.features' } = {}) {
  if (raw === undefined) return null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    log?.warn?.(`实例 ${instance} 的 ${source} 不是对象，已忽略`)
    return null
  }
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!FEATURE_SET.has(key)) {
      log?.warn?.(`实例 ${instance} 的 ${source} 含未知 Feature 键 '${key}'，已丢弃`)
      continue
    }
    if (typeof value !== 'boolean') {
      log?.warn?.(`实例 ${instance} 的 ${source}['${key}'] 非布尔值（${JSON.stringify(value)}），已忽略`)
      continue
    }
    out[key] = value
  }
  return out
}

/** 复制 Caps 及其内部 features，防止外部调用方篡改网关内部状态。 */
export function cloneCaps(caps) {
  if (!caps || typeof caps !== 'object') return null
  return caps.features ? { ...caps, features: { ...caps.features } } : { ...caps }
}

/**
 * 按 5 步不可逆顺序解析 L1 Caps + L2 Features，返回合并后的完整 Caps（含完整 14 项 features）。
 * 1. adapter L1 → deriveFeatures；
 * 2. 叠加 adapter.features（带 L1 键仅允许 true→false；无 L1 键与 chat.member.read 取显式值）；
 * 3. 叠加用户 L1 caps（只紧不松，绝不整块覆盖 features）；
 * 4. 合并后 L1 联动强制收缩带 L1 键项（chat.member.read 不随用户关 memberList 关闭）；
 * 5. 叠加用户 caps.features（未知键丢弃 warn，仅允许 true→false）。
 */
export function mergeCapsWithFeatures(adapterCaps, userCaps, instance = '', log = noopLog) {
  const merged = { ...adapterCaps }
  const logger = log || noopLog

  // step 1
  const resolved = deriveFeatures(adapterCaps)

  // step 2
  const adapterExplicit = sanitizeFeaturesInput(adapterCaps?.features, {
    instance,
    log: logger,
    source: 'adapter.caps().features',
  })
  if (adapterExplicit) {
    for (const [key, value] of Object.entries(adapterExplicit)) {
      if (Object.hasOwn(L1_LINKED_FEATURES, key)) {
        if (resolved[key] === false && value === true) {
          logger.warn?.(`实例 ${instance} 的 adapter features 想把带 L1 键的 '${key}' 往强改（false → true），已忽略`)
          continue
        }
        resolved[key] = resolved[key] && value
      } else {
        resolved[key] = value
      }
    }
  }

  // step 3
  if (userCaps && typeof userCaps === 'object') {
    for (const [key, value] of Object.entries(userCaps)) {
      if (key === 'features') continue
      if (!(key in adapterCaps)) {
        merged[key] = value
        continue
      }
      const base = adapterCaps[key]
      let ignored = false
      if (typeof base === 'boolean' && key !== 'maxFileBytes') {
        if (base === false && value === true) ignored = true
      } else if (key === 'voice') {
        if ((VOICE_RANK[value] ?? 0) > (VOICE_RANK[base] ?? 0)) ignored = true
      } else if (key === 'proactive') {
        if ((PROACTIVE_RANK[value] ?? 0) > (PROACTIVE_RANK[base] ?? 0)) ignored = true
      } else if (key === 'maxFileBytes') {
        if (Number(value) > Number(base)) ignored = true
      }
      if (ignored) {
        logger.warn?.(`实例 ${instance} 的配置 caps 想把 '${key}' 往强改（${JSON.stringify(base)} → ${JSON.stringify(value)}），已忽略（只能往弱改）`)
        continue
      }
      merged[key] = value
    }
  }

  // step 4
  for (const [key, reader] of Object.entries(L1_LINKED_FEATURES)) {
    resolved[key] = resolved[key] && reader(merged)
  }

  // step 5
  const userExplicit = sanitizeFeaturesInput(userCaps?.features, {
    instance,
    log: logger,
    source: 'caps.features',
  })
  if (userExplicit) {
    for (const [key, value] of Object.entries(userExplicit)) {
      if (resolved[key] === false && value === true) {
        logger.warn?.(`实例 ${instance} 的配置 caps.features 想把 '${key}' 往强改（false → true），已忽略（只能往弱改）`)
        continue
      }
      if (value === false) resolved[key] = false
    }
  }

  merged.features = resolved
  return merged
}

/** 计算给定状态与能力下对宿主暴露的实际 14 项功能表。 */
export function effectiveFeaturesFor(state, caps) {
  if (state !== 'connected' || !caps) return emptyFeatures()
  const base = emptyFeatures()
  const source = caps.features && typeof caps.features === 'object' ? caps.features : deriveFeatures(caps)
  for (const key of ALL_FEATURES) base[key] = Boolean(source[key])
  return base
}

/** 计算 state + 14 项生效 features 的去重快照签名。 */
export function featuresSignature(state, features) {
  return `${String(state || '')}\u0000${ALL_FEATURES.map((key) => (features?.[key] ? '1' : '0')).join('')}`
}
