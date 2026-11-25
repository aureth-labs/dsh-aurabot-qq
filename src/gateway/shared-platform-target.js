import { formatChatId, sameChat } from './address.js'

const normalizePlatformKey = (value) => (typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, '') : '')

const PLATFORM_ALIASES = new Map([
  ['wechat', 'wechat-clawbot'],
  ['weixin', 'wechat-clawbot'],
  ['wx', 'wechat-clawbot'],
  ['微信', 'wechat-clawbot'],
  ['微信clawbot', 'wechat-clawbot'],
  ['clawbot', 'wechat-clawbot'],
  ['飞书', 'feishu'],
  ['lark', 'feishu'],
  ['qq官方机器人', 'qqbot'],
  ['qq机器人', 'qqbot'],
  ['官方qq', 'qqbot'],
  ['qq官方', 'qqbot'],
  ['qq开放平台', 'qqbot'],
  ['钉钉', 'dingtalk'],
  ['dingding', 'dingtalk'],
  ['钉钉机器人', 'dingtalk'],
  ['企业微信', 'wecom'],
  ['企微', 'wecom'],
  ['企业微信机器人', 'wecom'],
  ['企微机器人', 'wecom'],
  ['企业微信智能机器人', 'wecom'],
  ['wework', 'wecom'],
  ['通用接入端', 'bridge'],
  ['桥接', 'bridge'],
])

const failure = error => ({ ok: false, error })

/** Resolve only a private address for the current owner's verified platform binding. */
export function resolveSharedPlatformTarget({
  platform, instance, account, ownerPersonId, identity, gateway, ownerPrimary, sourceChatId,
}) {
  if (!ownerPersonId || identity?.owner?.() !== ownerPersonId) return failure('当前主人授权已变化，请重新发起请求')
  const platformName = typeof platform === 'string' ? platform.trim().toLowerCase() : ''
  const compactKey = normalizePlatformKey(platform)
  const aliasedId = PLATFORM_ALIASES.get(compactKey) || platformName
  const catalog = Array.isArray(gateway?.catalog?.()) ? gateway.catalog() : []
  const matched = catalog.find(item => item?.id === aliasedId)
    || (compactKey ? catalog.find(item => normalizePlatformKey(item?.name) === compactKey) : null)
  if (!matched) {
    const available = []
    const seenIds = new Set()
    for (const item of catalog) {
      const id = String(item?.id || '').trim()
      if (!id || seenIds.has(id)) continue
      seenIds.add(id)
      const label = String(item?.name || '').trim()
      available.push(label && label.toLowerCase() !== id.toLowerCase() ? `${id}（${label}）` : id)
    }
    return available.length
      ? failure(`指定的平台不可用，可用平台：${available.join('、')}`)
      : failure('指定的平台不可用，请选择网关已注册的平台')
  }
  const targetPlatform = matched.id

  const platformInstances = gateway.instances().filter(item => item.platform === targetPlatform)
  const selfAccounts = new Set(platformInstances.map(item => item.self?.account).filter(Boolean).map(String))
  const boundAccounts = [...new Set((identity.accountsOf(ownerPersonId) || [])
    .filter(item => item.platform === targetPlatform && item.account)
    .map(item => String(item.account))
    .filter(id => !selfAccounts.has(id) && identity.lookup(targetPlatform, id) === ownerPersonId))]
  if (!boundAccounts.length) return failure('主人在指定平台没有可用的已绑定账号')

  const primaryOnPlatform = ownerPrimary?.mode !== 'recent' && (
    ownerPrimary?.platform === targetPlatform || (!ownerPrimary?.platform
      && platformInstances.some(item => item.instance === ownerPrimary?.instance))
  )
  const primaryAccount = primaryOnPlatform ? ownerPrimary.account : undefined
  let targetAccount
  if (account !== undefined) {
    if (typeof account !== 'string' || !boundAccounts.includes(account.trim())) {
      return failure('指定账号未绑定在当前主人名下')
    }
    targetAccount = account.trim()
  } else if (boundAccounts.includes(primaryAccount)) {
    targetAccount = primaryAccount
  } else if (boundAccounts.length === 1) {
    targetAccount = boundAccounts[0]
  } else {
    return failure(`主人在该平台绑定了多个账号，请指定 account（${boundAccounts.join('、')}）`)
  }

  const enabledInstances = platformInstances.filter(item => item.enabled)
  const hasAccountRouting = typeof gateway.routing?.instancesForAccount === 'function'
  const observedInstances = hasAccountRouting ? gateway.routing.instancesForAccount(targetPlatform, targetAccount) || [] : []
  let targetInstance
  if (instance !== undefined) {
    const instanceName = typeof instance === 'string' ? instance.trim() : ''
    targetInstance = enabledInstances.find(item => item.instance === instanceName)
    if (!targetInstance) return failure('指定实例未启用或不属于该平台')
    if (hasAccountRouting && !observedInstances.includes(targetInstance.instance)) {
      return failure('尚未在指定实例观测到该账号，请先通过该实例发送一条私聊消息')
    }
  } else {
    if (!enabledInstances.length) return failure('指定平台没有启用的实例')
    // 单实例沿用共享主账号的默认路由。有多条平台连接时，只使用已观测到的账号归属。
    const candidates = hasAccountRouting && (platformInstances.length > 1 || observedInstances.length)
      ? enabledInstances.filter(item => observedInstances.includes(item.instance)) : enabledInstances
    if (!candidates.length) return failure('尚未在启用的实例中观测到该账号，请先发送一条私聊消息')
    const primaryInstance = primaryOnPlatform ? ownerPrimary.instance : undefined
    targetInstance = candidates.length === 1 ? candidates[0] : candidates.find(item => item.instance === primaryInstance)
    if (!targetInstance) return failure(`该账号可以通过多个实例发送，请指定 instance（${candidates.map(item => item.instance).join('、')}）`)
  }

  if (targetInstance.state !== 'connected') return failure('目标平台实例未连接')
  const chatId = formatChatId({ instance: targetInstance.instance, platform: targetPlatform, kind: 'private', id: targetAccount })
  if (!chatId) return failure('无法构建目标私聊地址')
  if (sameChat(sourceChatId, chatId)) return failure('目标就是当前私聊，请直接回复')
  const caps = typeof gateway.caps === 'function' ? gateway.caps(chatId) : targetInstance.caps
  if (caps?.proactive !== 'free' && caps?.proactive !== 'limited') return failure('目标平台实例无法主动发送消息')
  return { ok: true, platform: targetPlatform, instance: targetInstance.instance, account: targetAccount, chatId }
}
