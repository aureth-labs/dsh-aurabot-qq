// 记忆的纯规则；配置、业务和面板派生值共用，不包含存储。
// 旧 1/2/3/0 的含义保留，补档使用新编号，读取老库无需改写时间或迁移。
export const FACT_TIERS = [
  { id: 4, label: '短暂', days: 1 },
  { id: 1, label: '琐碎', days: 7 },
  { id: 5, label: '小事', days: 15 },
  { id: 2, label: '一般', days: 30, followUp: true },
  { id: 3, label: '重要', days: 90, followUp: true },
  { id: 0, label: '永久', days: null },
]
export const DEFAULT_TIER_DAYS = Object.fromEntries(FACT_TIERS.filter((t) => t.days !== null).map((t) => [t.id, t.days]))
export const isFactTier = (tier) => FACT_TIERS.some((t) => t.id === tier)
export const isPermanentTier = (tier) => tier === 0 || tier === 'core'
export const followUpTier = (tier) => FACT_TIERS.some((t) => t.id === tier && t.followUp)
export const tierDays = (tier, configured = {}) => isFactTier(tier) && tier !== 0 ? configured[tier] ?? DEFAULT_TIER_DAYS[tier] : null
export const factTiers = (configured = {}) => FACT_TIERS.map((t) => ({ id: t.id, label: t.label, days: tierDays(t.id, configured) }))

// 新编号不表示重要程度；重复事实只提升保留期，永久不能被自动降级。
export function strongerTier(previous, next, configured = {}) {
  if (!isFactTier(next)) return previous
  if (isPermanentTier(previous)) return previous
  if (!isFactTier(previous) || next === 0) return next
  return tierDays(next, configured) > tierDays(previous, configured) ? next : previous
}

// 来源只用于显示、筛选和计数，不决定记忆归属或召回权限。
export function memoryPlatforms(item) {
  const via = Array.isArray(item.via) ? item.via : item.via ? [item.via] : []
  const platforms = [...new Set([item.meta?.platform, ...via].filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim()))]
  return platforms.length ? platforms : /^(private|group):/.test(String(item.chatId || '')) ? ['qq'] : ['unknown']
}
