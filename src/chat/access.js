// 谁能跟她说话、她在每个会话里有多大权限。纯函数。

import { formatChatId, normalizeChatId, parseChatId } from '../gateway/address.js'

/** 权限档位：full = DSH 完整工具；social = 只有 QQ 社交工具；chat = 纯聊天，没有工具。 */
export const LEVELS = ['full', 'social', 'chat']

function isIdentityService(x) {
  return Boolean(x && (typeof x.isOwner === 'function' || typeof x.owner === 'function' || typeof x.lookup === 'function' || typeof x.accountOn === 'function'))
}

function matchAccount(identity, platform, account) {
  const plat = String(platform || '').trim()
  const acc = String(account ?? '').trim()
  if (!plat || !acc || !isIdentityService(identity)) return false
  if (typeof identity.lookup === 'function') {
    const person = identity.lookup(plat, acc)
    if (person) return Boolean(identity.isOwner?.(person))
  }
  const owner = typeof identity.owner === 'function' ? identity.owner() : null
  if (owner && typeof identity.accountOn === 'function') {
    return identity.accountOn(owner, plat) === acc
  }
  return false
}

/**
 * 只有主人能做的事（群管、点歌、写文件……）。
 * 支持传：(identity, msg/chat)、(identity, personId)、(identity, accountId, platform)、(null, InboundMessage)。
 * 严格按 (platform, account) 或 PersonId 判别，不做跨平台纯数字 ID 猜测。
 */
export function isOwner(ownerRef, subject, context) {
  if (subject == null || subject === '') return false
  const identity = isIdentityService(ownerRef) ? ownerRef : null
  if (typeof subject === 'object') {
    if (subject.sender && typeof subject.sender === 'object') {
      if (subject.sender.person) {
        return identity ? Boolean(identity.isOwner?.(subject.sender.person)) : Boolean(subject.sender.isOwner === true)
      }
      if (typeof subject.sender.isOwner === 'boolean') return subject.sender.isOwner
    }
    if (!identity) return false
    if (subject.person) return Boolean(identity.isOwner?.(subject.person))
    const parsed = subject.chatId ? parseChatId(subject.chatId) : null
    const ctxPlat = typeof context === 'string' ? context : context?.platform
    const plat = String(subject.platform || ctxPlat || parsed?.platform || '').trim()
    const account = String(subject.userId ?? subject.account ?? (parsed?.kind === 'private' ? parsed.id : '') ?? '').trim()
    if (plat && account) return matchAccount(identity, plat, account)
    return false
  }
  const s = String(subject).trim()
  if (!s || !identity) return false
  const ctxPlat = typeof context === 'string' ? context : (context?.platform || parseChatId(context?.chatId)?.platform || '')
  if (ctxPlat) return matchAccount(identity, ctxPlat, s)
  if (typeof identity.isValid === 'function' && !identity.isValid(s)) return false
  return Boolean(identity.isOwner?.(s))
}

/**
 * 判断某个会话 / chatId 是否为主人本人发起的私聊；传了 userId 时同时校验发送者账号一致。
 */
export function isOwnerPrivateChat(ownerRef, chatOrId, userId) {
  if (!chatOrId) return false
  const identity = isIdentityService(ownerRef) ? ownerRef : null
  if (typeof chatOrId === 'object') {
    if (chatOrId.kind && chatOrId.kind !== 'private') return false
    const parsed = chatOrId.chatId ? parseChatId(chatOrId.chatId) : null
    if (parsed && parsed.kind !== 'private') return false
    if (!chatOrId.kind && !parsed) return false
    if (!isOwner(identity, chatOrId)) return false
    if (userId !== undefined && userId !== null) {
      const uid = String(userId).trim()
      if (!uid) return false
      const targetId = String(chatOrId.userId ?? parsed?.id ?? '').trim()
      if (targetId && uid !== targetId) return false
      const plat = String(chatOrId.platform || parsed?.platform || '').trim()
      if (plat && identity && !matchAccount(identity, plat, uid)) return false
    }
    return true
  }
  const parsed = parseChatId(chatOrId)
  if (!parsed || parsed.kind !== 'private') return false
  if (!isOwner(identity, parsed.id, parsed.platform)) return false
  if (userId !== undefined && userId !== null) {
    const uid = String(userId).trim()
    if (!uid || uid !== parsed.id || !matchAccount(identity, parsed.platform, uid)) return false
  }
  return true
}

/** 解析安全确认目标私聊：仅当触发会话本身是主人私聊时返回规范化 chatId（群聊或陌生人私聊绝不回退打扰主人）；未传触发会话时才用 routeOwner 兜底。 */
export function resolveConfirmChat(ownerRef, triggeringChatId, routeOwner) {
  const norm = normalizeChatId(triggeringChatId) || String(triggeringChatId || '').trim()
  if (norm) return isOwnerPrivateChat(ownerRef, norm) ? norm : ''
  if (typeof routeOwner === 'function') {
    const routed = normalizeChatId(routeOwner(''))
    if (routed && isOwnerPrivateChat(ownerRef, routed)) return routed
  }
  return ''
}

/** 返回主人已绑定所有平台私聊的 chatId 列表（含 QQ 兼容简写 private:<acc>）。 */
export function ownerPrivateChatIds(identity) {
  if (!isIdentityService(identity)) return []
  const owner = typeof identity.owner === 'function' ? identity.owner() : null
  if (!owner) return []
  const ids = new Set()
  const accounts = typeof identity.accountsOf === 'function' ? (identity.accountsOf(owner) || []) : []
  for (const a of accounts) {
    if (!a?.platform || !a?.account) continue
    const canon = formatChatId({ instance: a.platform, kind: 'private', id: a.account })
    if (canon) ids.add(canon)
    const bare = `private:${a.account}`
    if (canon && normalizeChatId(bare) === canon) ids.add(bare)
  }
  return [...ids]
}

export function isOwnerChatMuted(identity, isMuted) {
  return typeof isMuted === 'function' && ownerPrivateChatIds(identity).some((cid) => Boolean(isMuted(cid)))
}

/**
 * @param {object} cfg 插件配置
 * @param {{kind:'private'|'group', userId?:string, groupId?:string, platform?:string, chatId?:string, sender?:object}} msg
 * @param {object|null} [ownerRef] identity 服务
 * @returns {{allowed: boolean, reason: string}}
 */
export function checkAllowed(cfg, msg, ownerRef = null) {
  if (msg.kind === 'private') {
    if (isOwner(ownerRef, msg)) return { allowed: true, reason: '主人' }
    const list = (cfg.allow?.private || []).map(String)
    return list.includes(String(msg.userId || ''))
      ? { allowed: true, reason: '私聊白名单' }
      : { allowed: false, reason: '不在私聊白名单' }
  }
  const groups = (cfg.allow?.groups || []).map(String)
  return groups.includes(String(msg.groupId || ''))
    ? { allowed: true, reason: '群白名单' }
    : { allowed: false, reason: '不在群白名单' }
}

/** 群聊里给不给本机工具：off = 不给；owner = 只有主人说话那一轮给。
 * 没有「谁问都给」这一档——群里任何人都能驱动本机读写，权限面太大，明确不做。 */
export const GROUP_OWNER_TOOLS = ['off', 'owner']

/**
 * 这个群当前该给哪一档。ownerToolsGroups 非空时只在列出的群里生效（留空 = 所有群）。
 * @returns {'off'|'owner'}
 */
export function groupOwnerTools(cfg, chat) {
  if (!chat || chat.kind !== 'group') return 'off'
  const mode = cfg?.group?.ownerTools
  if (mode !== 'owner') return 'off'
  const list = (cfg?.group?.ownerToolsGroups || []).map(String).filter(Boolean)
  if (list.length && !list.includes(String(chat.groupId || ''))) return 'off'
  return mode
}

/** 这个会话用哪一档权限。群聊默认不超过 social，除非主人给这个群开了本机工具。 */
export function levelFor(cfg, chat, ownerRef = null) {
  if (isOwnerPrivateChat(ownerRef, chat)) {
    return LEVELS.includes(cfg.ownerLevel) ? cfg.ownerLevel : 'full'
  }
  // group-full 不叫 full：插件自己的工具还要按 social 语义挂（模块里到处是 level === 'full' 判主人私聊），
  // 真正的开关由 hub 按这一轮说话的人做（tools.restrict 收走核心工具）。
  if (chat?.kind === 'group' && groupOwnerTools(cfg, chat) !== 'off') return 'group-full'
  return 'social'
}

/** 档位 → agent preset id。 */
export function presetFor(level, cfg) {
  if (level === 'group-full') return 'aurabot-group-owner'
  if (level !== 'full') return 'aurabot-social'
  return cfg && cfg.longTasks ? 'aurabot-private-long' : 'aurabot-private'
}

/** 授权名单只作用于已获准聊天的私聊对象。 */
export function privateCapabilityAllowed(cfg, chat, capability) {
  if (chat?.kind !== 'private') return false
  const userId = String(chat.userId || '')
  if (!userId || !(cfg.allow?.private || []).map(String).includes(userId)) return false
  return (cfg.capabilityAllow?.[capability] || []).map(String).includes(userId)
}

/** 改资料类操作（改昵称 / 签名 / 头像、改 B 站签名），以及处理好友申请、改白名单的三档权限。 */
export const PROFILE_PERM_LEVELS = ['off', 'owner', 'all']
export const DOUYIN_PERM_KEYS = ['douyinBrowse', 'douyinLike', 'douyinComment', 'douyinShareOwner', 'douyinDm']
/** 小黑盒：浏览（含热榜/搜索）、点赞、评论、发帖（含删自己的帖）。 */
export const HEYBOX_PERM_KEYS = ['heyboxBrowse', 'heyboxLike', 'heyboxComment', 'heyboxPost']
export const PROFILE_PERM_KEYS = ['qqNickname', 'qqSignature', 'qqAvatar', 'biliSign', 'biliAvatar', 'biliComment', 'qqFriendRequest', 'whitelist', ...DOUYIN_PERM_KEYS, ...HEYBOX_PERM_KEYS]
/** 没设过的档位：一律默认仅主人（含抖音浏览/互动/改资料项；用户要放开自己在面板开）。 */
export const profilePermDefault = (key) => 'owner'
export const permOf = (cfg, key) => {
  const p = cfg?.profilePerms?.[key]
  return PROFILE_PERM_LEVELS.includes(p) ? p : profilePermDefault(key)
}

/** 这一档在这个会话里要不要挂工具。owner = 只在主人私聊里挂；all = 哪都挂；off = 不挂。 */
export function profileToolVisible(cfg, key, chat, ownerRef = null) {
  const p = permOf(cfg, key)
  if (p === 'all') return chat?.kind === 'private' || chat?.kind === 'group'
  if (p === 'owner') return isOwnerPrivateChat(ownerRef, chat)
  return false
}

/** 执行时再查一遍（面板可能刚改过）。allOwner = 这一轮说话的人全是主人。 */
export function profilePermits(cfg, key, chat, allOwner, ownerRef = null) {
  const p = permOf(cfg, key)
  if (p === 'off') return { ok: false, message: '这个操作在面板里关掉了' }
  if (!profileToolVisible(cfg, key, chat, ownerRef)) return { ok: false, message: '这里不能做这个操作' }
  if (p === 'owner' && !allOwner) return { ok: false, message: '只有主人私聊让我改才行' }
  return { ok: true }
}
