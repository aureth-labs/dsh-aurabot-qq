import { formatChatId, normalizeChatId, parseChatId, sameChat } from './address.js'

export const SHARED_PRIVATE_KEY = 'multi:owner-private'

export function fixedSharedPrimary({ cfg, identity, instances, instancesForAccount }) {
  const ownerPersonId = identity?.owner()
  const fixed = cfg.ownerPrimary
  if (!ownerPersonId || !fixed || fixed.mode === 'recent' || (!fixed.platform && !fixed.instance)) {
    return { ok: false, reason: 'missing-primary' }
  }
  const accounts = identity.accountsOf(ownerPersonId)
  const candidates = new Map()
  const possible = new Set()
  for (const { instance, platform, legacy } of instances) {
    if (fixed.platform && fixed.platform !== platform) continue
    if (fixed.instance && fixed.instance !== instance) continue
    const platformInstances = new Set(instances.filter(item => item.platform === platform).map(item => item.instance))
    for (const { platform: accountPlatform, account } of accounts) {
      if (accountPlatform !== platform || (fixed.account && fixed.account !== account)) continue
      if (identity.lookup(platform, account) !== ownerPersonId) continue
      if (instances.some(item => item.platform === platform && item.self?.account === account)) continue
      const chatId = formatChatId({ instance, kind: 'private', id: account })
      if (!chatId || !normalizeChatId(chatId)) continue
      possible.add(chatId)
      const observed = instancesForAccount?.(platform, account) || []
      if (!legacy && (observed.length || platformInstances.size > 1) && !observed.includes(instance)) continue
      candidates.set(chatId, { binding: { platform, instance, account, chatId }, legacy })
    }
  }
  if (candidates.size !== 1) {
    return { ok: false, reason: possible.size > 1 ? 'ambiguous-primary' : 'missing-primary' }
  }
  const { binding, legacy } = candidates.values().next().value
  return legacy ? { ok: false, reason: 'gateway-required' } : { ok: true, ownerPersonId, binding }
}

// ingress is supplied by Hub only for platform adapter messages after verification.
export function sessionRouteFor(chat, { cfg, identity, primary, ingress }) {
  const ordinary = { kind: 'chat', key: chat.chatId }
  if (cfg.multiPlatformPrivateSession !== true || !primary?.ok || !ingress?.messageId) return ordinary
  const address = parseChatId(chat.chatId)
  if (address?.kind !== 'private' || address.instance !== ingress.instance || address.id !== ingress.account
    || !sameChat(chat.chatId, ingress.chatId)) return ordinary
  if (identity.owner() !== primary.ownerPersonId || identity.lookup(ingress.platform, ingress.account) !== primary.ownerPersonId) {
    return ordinary
  }
  return { kind: 'multi-private', key: SHARED_PRIVATE_KEY, mode: cfg.debug ? 'debug' : 'live' }
}
