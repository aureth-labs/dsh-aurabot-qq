// 内置模块：群管。主人开口时按后端能力执行群管理（QQ 直连 / QQ 官方机器人 / 飞书）。

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'

const _lib = globalThis.aurabot?.lib
const { defineTool, str, int } = _lib ? _lib('tools/tools.js') : await import('../../tools/tools.js')
const { allowMatches, isOwner } = _lib ? _lib('chat/access.js') : await import('../../chat/access.js')
const { normalizeChatId, parseChatId } = _lib ? _lib('gateway/address.js') : await import('../../gateway/address.js')

const UNSUPPORTED_QQBOT_ACTIONS = Object.freeze({
  whole_ban: '全体禁言',
  whole_unban: '解除全体禁言',
  title: '改专属头衔',
  notice: '发群公告',
})

const MENTION_TTL_MS = 3 * 60_000
const MAX_OBSERVED_PER_GROUP = 200
const MAX_OBSERVED_GROUPS = 200
const OBSERVED_TTL_MS = 30 * 24 * 60 * 60_000
const OBSERVED_TOUCH_SAVE_MS = 5 * 60_000

const unwrapMentionToken = (s) => {
  const m = /^<@!?([0-9A-Za-z_-]+)>$/.exec(String(s || '').trim())
  return m ? m[1] : String(s || '').trim()
}

const isStrictOpenid = (s) => /^[0-9A-Fa-f]{24,64}$/.test(s)
const isFeishuOpenid = (s) => /^ou_[0-9A-Za-z_-]{2,128}$/.test(s)
const looksLikeOpenid = (s) => /^[0-9A-Za-z_-]{8,}$/.test(s) && (/[0-9_-]/.test(s) || /^[0-9A-F]{16,}$/i.test(s))

function matchMemberCandidates(list, rawQuery) {
  const query = String(rawQuery || '').trim()
  if (!query || !Array.isArray(list) || !list.length) return null
  const exactId = list.find((m) => m?.openid === query)
  if (exactId) return { openid: exactId.openid, nick: exactId.nick || '' }
  const qLower = query.toLowerCase()
  const exactNicks = list.filter((m) => String(m?.nick || '').trim().toLowerCase() === qLower)
  if (exactNicks.length === 1) return { openid: exactNicks[0].openid, nick: exactNicks[0].nick || '' }
  if (exactNicks.length > 1) return { ambiguous: exactNicks }
  const partialNicks = list.filter((m) => String(m?.nick || '').trim().toLowerCase().includes(qLower))
  if (partialNicks.length === 1) return { openid: partialNicks[0].openid, nick: partialNicks[0].nick || '' }
  if (partialNicks.length > 1) return { ambiguous: partialNicks }
  return null
}

function backendLabelOf(info, spec) {
  const b = info?.backend || spec?.backend
  const p = info?.platform || spec?.platform
  if (b === 'gateway-admin') {
    if (p === 'qqbot') return 'QQ 官方机器人'
    if (p === 'feishu') return '飞书群管'
    if (p === 'qq') return 'QQ 网关'
    return `${p || '平台'}网关`
  }
  if (info?.unbound || spec?.unbound) return '未绑定 QQ 官方群'
  if (b === 'none') return '不可用'
  return 'QQ 直连'
}

export const toolAliases = Object.freeze({
  qq_group_admin: 'group_admin',
})

export default {
  id: 'group-admin',
  name: '群管',
  version: '1.1.0',
  api: 3,
  platforms: ['qq', 'qqbot', 'feishu'],
  features: {
    optional: ['chat.member.list'],
  },
  toolAliases,
  description: '主人要求时做群管理：QQ 直连支持禁言/解禁/全体禁言/踢人/改头衔/发公告；QQ 官方机器人支持禁言/解禁/踢人/查成员；飞书支持踢人/查成员（不支持禁言/全体禁言/头衔/公告）（group_admin）',
  setup(api) {
    const { hub, onebot, groupRoles, gateway, http } = api.core
    const groupNameCache = new Map() // chatId -> { name, at }
    const GROUP_NAME_CACHE_TTL_MS = 10 * 60_000
    const observedMembers = new Map() // normChatId -> Map<openid, { openid, nick, at }>
    const lastOwnerMentions = new Map() // normChatId -> { at, mentions: Array<{ openid, nick }> }

    const normChatKey = (cid) => normalizeChatId(String(cid || '')) || String(cid || '')
    const observedFile = () => (typeof api.dataDir === 'function' ? api.dataDir('observed-members.json') : '')

    const pruneObserved = (now = Date.now()) => {
      for (const [chatKey, map] of observedMembers.entries()) {
        for (const [uid, rec] of map.entries()) {
          if (!rec || !rec.openid || !Number.isFinite(rec.at) || now - rec.at > OBSERVED_TTL_MS) {
            map.delete(uid)
          }
        }
        while (map.size > MAX_OBSERVED_PER_GROUP) {
          const oldest = map.keys().next().value
          if (oldest === undefined) break
          map.delete(oldest)
        }
        if (map.size === 0) observedMembers.delete(chatKey)
      }
      while (observedMembers.size > MAX_OBSERVED_GROUPS) {
        const oldestChat = observedMembers.keys().next().value
        if (oldestChat === undefined) break
        observedMembers.delete(oldestChat)
      }
    }

    const saveObservedMembers = () => {
      const f = observedFile()
      if (!f) return
      try {
        pruneObserved()
        const groups = {}
        for (const [chatKey, map] of observedMembers.entries()) {
          groups[chatKey] = [...map.values()].map((m) => ({
            openid: m.openid,
            nick: m.nick || '',
            at: m.at,
          }))
        }
        const payload = JSON.stringify({ version: 1, groups })
        const tmp = `${f}.tmp`
        try {
          writeFileSync(tmp, payload, 'utf8')
          renameSync(tmp, f)
        } catch {
          writeFileSync(f, payload, 'utf8')
        }
      } catch (error) {
        api.log?.warn?.('保存 QQ 官方群成员观察缓存失败：', error?.message || error)
      }
    }

    const loadObservedMembers = () => {
      const f = observedFile()
      if (!f || !existsSync(f)) return
      try {
        const parsed = JSON.parse(readFileSync(f, 'utf8'))
        const rawGroups = parsed?.groups
        if (!rawGroups || typeof rawGroups !== 'object') return
        const now = Date.now()
        for (const [rawChatKey, items] of Object.entries(rawGroups)) {
          const key = normChatKey(rawChatKey)
          if (!key || !Array.isArray(items)) continue
          const map = new Map()
          for (const item of items) {
            const uid = String(item?.openid || '').trim()
            const nick = String(item?.nick || '').trim()
            const at = Number(item?.at)
            if (!uid || !Number.isFinite(at) || now - at > OBSERVED_TTL_MS) continue
            if (map.has(uid)) map.delete(uid)
            map.set(uid, { openid: uid, nick, at })
          }
          if (map.size) observedMembers.set(key, map)
        }
        pruneObserved(now)
      } catch (error) {
        api.log?.warn?.('读取 QQ 官方群成员观察缓存失败：', error?.message || error)
      }
    }
    loadObservedMembers()

    const recordObservedMember = (chatId, openid, nick = '', { save = true } = {}) => {
      const key = normChatKey(chatId)
      const uid = String(openid || '').trim()
      if (!key || !uid || uid === 'all') return false
      const now = Date.now()
      let map = observedMembers.get(key)
      if (!map) {
        map = new Map()
      } else {
        observedMembers.delete(key)
      }
      observedMembers.set(key, map)
      while (observedMembers.size > MAX_OBSERVED_GROUPS) {
        const oldestChat = observedMembers.keys().next().value
        if (oldestChat === undefined) break
        observedMembers.delete(oldestChat)
      }
      const prev = map.get(uid)
      const cleanNick = String(nick || '').trim() || prev?.nick || ''
      if (prev) map.delete(uid)
      map.set(uid, { openid: uid, nick: cleanNick, at: now })
      while (map.size > MAX_OBSERVED_PER_GROUP) {
        const oldest = map.keys().next().value
        if (oldest === undefined) break
        map.delete(oldest)
      }
      const dirty = !prev || cleanNick !== (prev.nick || '') || now - (prev.at || 0) >= OBSERVED_TOUCH_SAVE_MS
      if (save && dirty) saveObservedMembers()
      return dirty
    }

    const extractMentionsFromMessage = (msg) => {
      const out = []
      const seen = new Set()
      const pushMention = (acc, name = '') => {
        const openid = unwrapMentionToken(String(acc || '').trim())
        if (!openid || openid === 'all' || seen.has(openid)) return
        seen.add(openid)
        out.push({ openid, nick: String(name || '').trim() })
      }
      const parts = Array.isArray(msg?.parts) && msg.parts.length
        ? msg.parts
        : (Array.isArray(msg?.raw?.__gateway?.parts) ? msg.raw.__gateway.parts : [])
      for (const p of parts) {
        if (p?.type === 'mention') pushMention(p.account, p.name)
      }
      for (const seg of Array.isArray(msg?.raw?.message) ? msg.raw.message : []) {
        if (seg?.type === 'at' && seg.data) pushMention(seg.data.qq, seg.data.name)
      }
      return out
    }

    const ownerMentionState = (chatId) => {
      const key = normChatKey(chatId)
      const entry = key ? lastOwnerMentions.get(key) : null
      if (!entry || !entry.mentions?.length) return { mentions: [], expired: false }
      if (Date.now() - entry.at > MENTION_TTL_MS) return { mentions: [], expired: true }
      return { mentions: entry.mentions, expired: false }
    }
    const freshOwnerMentions = (chatId) => ownerMentionState(chatId).mentions

    api.on?.('message', (msg) => {
      if (!msg || msg.kind !== 'group' || !msg.chatId) return false
      const key = normChatKey(msg.chatId)
      const plat = String(msg.platform || parseChatId(key)?.platform || 'qq')
      if (plat === 'qq') return false
      if (msg.userId) recordObservedMember(key, msg.userId, msg.nickname || '')
      const mentions = extractMentionsFromMessage(msg)
      for (const m of mentions) recordObservedMember(key, m.openid, m.nick)
      const fromOwner = Boolean(msg.sender?.isOwner || isOwner(api.core.identity, msg.userId, plat))
      if (fromOwner && mentions.length) {
        lastOwnerMentions.set(key, { at: Date.now(), mentions })
      }
      return false
    })
    const qqCall = (action, params, opts) => (typeof api.native === 'function' ? api.native('qq', action, params, opts) : onebot.call(action, params, opts))
    const readReqBody = async (req) => {
      if (typeof http?.body === 'function') return (await http.body(req)) || {}
      let b = req?.body
      if (typeof b === 'string') { try { b = JSON.parse(b) } catch { b = {} } }
      return b && typeof b === 'object' ? b : {}
    }
    const readReqQuery = (req) => (typeof http?.query === 'function' ? http.query(req) : (req?.query || {}))

    const roleInfoSync = (chat) => {
      const key = chat?.chatId || chat?.groupId
      if (typeof groupRoles?.peekInfo === 'function') {
        const info = groupRoles.peekInfo(key)
        if (info) return info
      }
      const legacy = groupRoles?.peek?.(chat?.groupId) || ''
      return legacy ? { role: legacy, backend: 'onebot', platform: 'qq' } : null
    }

    const inspectRole = async (key, { fresh = true } = {}) => {
      if (typeof groupRoles?.inspect === 'function') return groupRoles.inspect(key, { fresh })
      const role = await groupRoles?.get?.(key, { fresh })
      return {
        role: role || '',
        label: role ? groupRoles.label(role) : '查不到（她在群里吗？）',
        canManage: Boolean(role && groupRoles.canManage(role)),
        supported: true,
        reason: '',
        backend: 'onebot',
        platform: 'qq',
      }
    }

    async function fetchGatewayMembers(ga, groupOpenid, chatId, { platform = '' } = {}) {
      const merged = new Map()
      let observedDirty = false
      const upsert = (item, persist = false) => {
        const openid = String(item?.openid || item?.member_openid || '').trim()
        if (!openid) return
        const prev = merged.get(openid) || {}
        const nick = String(item?.nick || item?.username || '').trim() || prev.nick || ''
        const role = String(item?.role || item?.member_role || '').trim() || prev.role || ''
        merged.set(openid, { openid, nick, role })
        if (persist && nick && recordObservedMember(chatId, openid, nick, { save: false })) {
          observedDirty = true
        }
      }

      let apiError = ''
      let apiFetched = false
      let truncated = false
      if (ga && typeof ga.listMembers === 'function' && groupOpenid) {
        if (platform === 'feishu') {
          try {
            const batch = await ga.listMembers(groupOpenid, { startIndex: 0, limit: 5000 })
            apiFetched = true
            truncated = Boolean(batch?.truncated)
            if (Array.isArray(batch)) {
              for (const m of batch) upsert(m, true)
            }
          } catch (error) {
            apiError = error?.message || '查询群成员列表失败'
          }
        } else {
          let startIndex = 0
          for (let page = 0; page < 3; page++) {
            let batch
            try {
              batch = await ga.listMembers(groupOpenid, { startIndex, limit: 100 })
              apiFetched = true
            } catch (error) {
              apiError = error?.message || '查询群成员列表失败'
              break
            }
            if (!Array.isArray(batch) || !batch.length) break
            const beforeSize = merged.size
            for (const m of batch) upsert(m, true)
            if (batch.length < 100 || merged.size === beforeSize) break
            startIndex += batch.length
          }
        }
      } else {
        apiError = '当前网关不支持查询群成员列表'
      }
      if (observedDirty) saveObservedMembers()

      const obs = observedMembers.get(normChatKey(chatId))
      if (obs) {
        // 先拷快照再合并，绝不在遍历 obs 的同时修改 obs 造成死循环
        for (const m of [...obs.values()]) upsert(m, false)
      }
      return { members: [...merged.values()], fromApi: apiFetched && !apiError, error: apiError, truncated }
    }

    async function resolveGatewayTarget({ rawUserId, rawMemberOpenid, chatId, groupOpenid, ga, identity, platform, action }) {
      const formatCandidates = (list) => list.slice(0, 6).map((m) => (m.nick ? `${m.nick}(${m.openid})` : m.openid)).join('、')
      const isFeishu = platform === 'feishu'
      const idLabel = isFeishu ? 'open_id' : 'member_openid'
      const noNumericMsg = isFeishu
        ? '飞书不能按 QQ 号操作，请在群里 @ 对方、填群成员昵称，或先用 list_members 查出飞书 open_id（ou_ 开头）'
        : 'QQ 官方机器人不能按 QQ 号操作，请在群里 @ 对方、填群成员昵称，或先用 list_members 查出 member_openid'

      if (String(rawMemberOpenid || '').trim()) {
        const explicit = unwrapMentionToken(rawMemberOpenid)
        if (/^\d{5,15}$/.test(explicit)) {
          return { error: noNumericMsg }
        }
        if (isFeishu) {
          if (!isFeishuOpenid(explicit)) {
            return { error: '飞书 open_id 格式不对（应以 ou_ 开头），请在群里 @ 对方、填群成员昵称，或先用 list_members 查出 open_id' }
          }
        } else if (!/^[0-9A-Za-z_-]{4,128}$/.test(explicit)) {
          return { error: 'member_openid 格式不对，请在群里 @ 对方、填群成员昵称，或先用 list_members 查出 member_openid' }
        }
        return { openid: explicit, nick: '', via: 'explicit' }
      }

      const raw = unwrapMentionToken(rawUserId)
      const mentionState = ownerMentionState(chatId)
      const mentions = mentionState.mentions
      if (!raw) {
        let candidates = mentions
        if (candidates.length > 1 && (action === 'ban' || action === 'kick')) {
          const nonOwner = candidates.filter((m) => !isOwner(identity, m.openid, platform))
          if (nonOwner.length >= 1) candidates = nonOwner
        }
        if (candidates.length === 1) return { openid: candidates[0].openid, nick: candidates[0].nick, via: 'mention' }
        if (candidates.length > 1) {
          return { error: `这一轮 @ 了多位成员，请明确指定要操作谁：${formatCandidates(candidates)}` }
        }
        if (mentionState.expired) {
          return { error: `上一次 @ 已超过 3 分钟，请重新 @ 对方、提供群昵称，或先用 list_members 查出 ${idLabel}` }
        }
        return { error: `要说清楚对谁操作：可在群里 @ 对方、填对方群昵称，或先用 list_members 查出 ${idLabel}` }
      }

      const cleaned = unwrapMentionToken(raw.replace(/^@+/, '').trim())
      if (/^\d{5,15}$/.test(cleaned)) {
        return { error: noNumericMsg }
      }

      const mentionHit = matchMemberCandidates(mentions, cleaned)
      if (mentionHit?.ambiguous) {
        return { error: `这一轮 @ 的成员中有重名，请改用 ${idLabel} 指定：${formatCandidates(mentionHit.ambiguous)}` }
      }
      if (mentionHit) return { ...mentionHit, via: 'mention' }

      const obsMap = observedMembers.get(normChatKey(chatId))
      const obsExact = obsMap?.get(cleaned)
      if (obsExact) return { openid: obsExact.openid, nick: obsExact.nick, via: 'observed' }
      if (isOwner(identity, cleaned, platform)) return { openid: cleaned, nick: '', via: 'explicit' }

      if (isFeishu ? isFeishuOpenid(cleaned) : isStrictOpenid(cleaned)) {
        return { openid: cleaned, nick: obsExact?.nick || '', via: 'explicit' }
      }

      const { members, fromApi, error } = await fetchGatewayMembers(ga, groupOpenid, chatId)
      const hit = matchMemberCandidates(members, cleaned)
      if (hit?.ambiguous) {
        return { error: `匹配到多位群成员，请改用 ${idLabel} 指定：${formatCandidates(hit.ambiguous)}` }
      }
      if (hit) return { ...hit, via: fromApi ? 'members' : 'observed' }

      if (!isFeishu && looksLikeOpenid(cleaned)) {
        return { openid: cleaned, nick: '', via: 'explicit' }
      }

      if (error) {
        return { error: `按「${cleaned}」找不到对应的 ${idLabel}（${error}）；请在群里 @ 对方或直接提供 ${idLabel}` }
      }
      return { error: `群成员列表里没找到「${cleaned}」，请确认昵称或在群里 @ 对方 / 用 list_members 查看 ${idLabel}` }
    }

    const platformEntries = (prefix) => Object.entries(api.config?.()?.platforms || {})
      .filter(([id, val]) => val && val.enabled === true && (id === prefix || id.startsWith(`${prefix}#`)))

    const hasQqDirectEnabled = () => platformEntries('qq').length > 0 || Boolean(onebot?.connected?.())
    const hasQqbotEnabled = () => platformEntries('qqbot').length > 0
    const hasFeishuEnabled = () => platformEntries('feishu').length > 0

    const resolveToolMode = (chat) => {
      const info = chat?.kind === 'group' ? roleInfoSync(chat) : null
      const chatPlat = String(chat?.platform || parseChatId(normChatKey(chat?.chatId))?.platform || '')
      if (chat?.kind === 'group') {
        const effPlat = info?.backend === 'gateway-admin' && info?.platform ? info.platform : chatPlat
        if (effPlat === 'feishu') return 'feishu'
        if (effPlat === 'qqbot' || (info?.backend === 'gateway-admin' && info?.platform && info.platform !== 'qq')) return 'qqbot'
        return 'qq'
      }
      if (chatPlat === 'feishu') return 'feishu'
      if (chatPlat === 'qqbot') return 'qqbot'
      if (chatPlat === 'qq') return 'qq'
      if (!hasQqDirectEnabled()) {
        if (hasFeishuEnabled() && !hasQqbotEnabled()) return 'feishu'
        if (hasQqbotEnabled()) return 'qqbot'
      }
      return 'qq'
    }

    // 她在这个群的身份：没管理权限或无官方接口权限时直接如实说明
    api.context(({ chat }) => {
      if (chat.kind !== 'group') return ''
      const info = roleInfoSync(chat)
      const role = info?.role || ''
      const mode = resolveToolMode(chat)
      const mentions = mode === 'qqbot' || mode === 'feishu' ? freshOwnerMentions(chat.chatId) : []
      const idLabel = mode === 'feishu' ? 'open_id' : 'member_openid'
      const mentionHint = mentions.length
        ? `\n本轮主人刚刚 @ 的群成员：${mentions.map((m) => (m.nick ? `${m.nick}（${idLabel}=${m.openid}）` : `${idLabel}=${m.openid}`)).join('、')}。`
        : ''
      if (mode === 'feishu') {
        if (!role) {
          if (info?.backend === 'gateway-admin' && info.reason) {
            return `当前飞书群管理暂不可用（${info.reason}）；主人让你查询成员或踢人时，直接如实说明原因。`
          }
          return `当前为飞书群，可用 group_admin 查询群成员（list_members）并在机器人是群管理员/群主时踢出成员（kick），接受对方昵称/@昵称或飞书 open_id（ou_ 开头）。飞书当前不支持按成员单人禁言、限时禁言、全体禁言、改专属头衔或发群公告；也不要把“群发言权限”说成单人禁言。${mentionHint}`
        }
        if (role === 'member') {
          return `你在这个飞书群只是普通成员，没有管理权限：踢人做不了（仍可用 group_admin 的 list_members 查成员）；不支持单人禁言、全体禁言、改头衔或发公告。${mentionHint}`
        }
        const canKickNow = info?.actions?.kick !== false
        const roleNote = role === 'unknown'
          ? '你在当前飞书群的管理身份待确认（飞书未返回管理员列表）'
          : `你在这个飞书群是${groupRoles.label(role)}`
        return `${roleNote}。主人要求时可以用 group_admin ${canKickNow ? '查成员（list_members）或踢出成员（kick）；可直接填对方昵称/@昵称或飞书 open_id（ou_ 开头），若主人刚在消息里 @ 了对方也可以直接调工具自动识别' : '查成员（list_members，当前移出成员能力不可用）'}。飞书当前不支持按成员单人禁言（ban）、限时禁言、全体禁言（whole_ban）、改专属头衔或发群公告；不要把“群发言权限”说成单人禁言，也不要写斜杠命令。${mentionHint}`
      }
      if (!role) {
        if (info?.backend === 'gateway-admin' && info?.platform !== 'qq' && info.reason) {
          return `当前群的 QQ 官方机器人群管理暂不可用（${info.reason}）；主人让你禁言或踢人时，直接如实说明原因。`
        }
        if (mode === 'qqbot') {
          return `QQ 官方机器人群可用 group_admin 执行单人禁言（ban）/ 解禁（unban）/ 踢人（kick）/ 查成员（list_members），接受对方昵称/@昵称或 member_openid（不能填 QQ 号）。QQ 官方机器人只支持单人禁言；用户说「群禁言」时先问清是全体禁言还是禁言某个人，全体禁言做不了。${mentionHint}`
        }
        return ''
      }
      if (!groupRoles.canManage(role)) {
        return '你在这个群只是普通成员，没有管理权限：禁言、踢人这些做不了，主人要求时直接说明。'
      }
      if (info?.backend === 'gateway-admin' && info?.platform !== 'qq') {
        return `你在这个群是${groupRoles.label(role)}。主人要求时可以用 group_admin 做单人禁言（ban）、解禁（unban）、踢人（kick）或查成员（list_members）；可直接填对方昵称/@昵称或 member_openid，若主人刚在消息里 @ 了对方也可以直接调工具自动识别（不支持全体禁言 whole_ban、改专属头衔和发群公告；不能填 QQ 号；不要写 /ban 等斜杠命令）。QQ 官方机器人只支持单人禁言；用户说「群禁言」时先问清是全体禁言还是禁言某个人，全体禁言做不了。${mentionHint}`
      }
      return `你在这个群是${groupRoles.label(role)}，主人要求时可以用 group_admin 做群管操作（不要写 /ban 等斜杠命令）。`
    })

    // 工具层校验：这一轮说话的人必须全是主人
    api.tool(({ chat, level, sessionId }) => {
      if (!(chat.kind === 'group' || level === 'full')) return []
      const mode = resolveToolMode(chat)
      const info = chat?.kind === 'group' ? roleInfoSync(chat) : null
      const parsedChat = parseChatId(normChatKey(chat?.chatId || ''))
      const instForGa = info?.instance || parsedChat?.instance || (mode === 'feishu' ? (platformEntries('feishu')[0]?.[0] || 'feishu') : '')
      const gaTool = instForGa ? gateway?.groupAdmin?.(instForGa) : null
      const feishuCanKick = info?.canManage !== false && info?.actions?.kick !== false && gaTool?.supportedActions?.kick !== false
      const properties = mode === 'feishu'
        ? {
            action: {
              type: 'string',
              enum: feishuCanKick ? ['kick', 'list_members'] : ['list_members'],
              description: feishuCanKick
                ? 'kick 移出群成员（需机器人为群管理员），list_members 列出群成员及 open_id（飞书不支持禁言/全体禁言/改头衔/发公告）'
                : 'list_members 列出群成员及 open_id（当前飞书实例不支持踢出成员及禁言/头衔/公告）',
            },
            group_id: str('飞书群 chat_id（如 oc_xxx 或 feishu:group:oc_xxx）；在群里用时可省略，默认当前群'),
            user_id: str('操作对象：填对方群昵称 / @昵称 / 飞书 open_id（ou_ 开头），若主人刚 @ 了对方也可省略自动匹配'),
            member_openid: str('可选，明确指定飞书群目标成员的 open_id（ou_ 开头，不能跨群复用）'),
            query: str('可选，action=list_members 时按昵称或 open_id 筛选成员'),
          }
        : {
            action: mode === 'qqbot'
              ? {
                  type: 'string',
                  enum: ['ban', 'unban', 'kick', 'list_members'],
                  description: 'ban 单人禁言，unban 解禁，kick 踢出，list_members 列出群成员及 member_openid（QQ 官方机器人不支持全体禁言/改头衔/发公告）',
                }
              : {
                  type: 'string',
                  enum: ['ban', 'unban', 'whole_ban', 'whole_unban', 'kick', 'title', 'notice', 'list_members'],
                  description: 'ban 单人禁言，unban 解禁，whole_ban 全体禁言（仅 QQ 直连），whole_unban 解除全体禁言（仅 QQ 直连），kick 踢出，title 改专属头衔（仅 QQ 直连），notice 发公告（仅 QQ 直连），list_members 列出群成员及 member_openid',
                },
            group_id: mode === 'qqbot'
              ? str('规范群地址（如 qqbot:group:xxx）或已绑定群号；在群里用时可省略，默认当前群')
              : str('群号或规范群地址（如 qqbot:group:xxx）；在群里用时可省略，默认当前群'),
            user_id: mode === 'qqbot'
              ? str('操作对象：填对方群昵称 / @昵称 / member_openid，若主人刚 @ 了对方也可省略自动匹配（不可填纯数字 QQ 号）')
              : str('操作对象：QQ 直连群填对方 QQ 号；QQ 官方机器人群可填对方群昵称 / @昵称 / member_openid，若主人刚 @ 了对方也可省略自动匹配（不可填纯数字 QQ 号）'),
            member_openid: str('可选，明确指定 QQ 官方机器人群目标成员的 member_openid'),
            query: str('可选，action=list_members 时按昵称或 ID 筛选成员'),
            minutes: int('禁言分钟数，默认 10；QQ 官方机器人最长 43200（30 天）'),
          }
      if (mode === 'qq') {
        properties.text = str('头衔内容或公告内容（QQ 官方机器人不支持）')
      }
      return defineTool({
        name: 'group_admin',
        description: mode === 'feishu'
          ? (feishuCanKick
              ? '飞书群管理：支持移出群成员（kick）/ 查成员（list_members）；不支持单人禁言、定时禁言、全体禁言、改头衔或发公告。可直接填群昵称/@昵称、填 open_id（ou_ 开头），或在主人 @ 对方后省略目标自动识别。只有主人单独发话时才能用。'
              : '飞书群管理（只读）：仅支持列出群成员（list_members）；不支持踢人及禁言/全体禁言/改头衔/发公告。只有主人单独发话时才能用。')
          : (mode === 'qqbot'
              ? 'QQ 官方机器人群管理：仅支持单人禁言（ban）/ 解禁（unban）/ 踢人（kick）/ 查成员（list_members），不支持全体禁言。可直接填群昵称/@昵称、填 member_openid，或在主人 @ 对方后省略目标自动识别。只有主人单独发话时才能用。'
              : '群管理：单人禁言（ban）/ 解禁（unban）/ 踢人（kick）/ 查成员（list_members）；QQ 直连群还支持全体禁言（whole_ban/whole_unban）/ 改头衔（title）/ 发公告（notice）。QQ 官方机器人群可直接填群昵称/@昵称、填 member_openid，或在主人 @ 对方后省略目标自动识别。只有主人单独发话时才能用。'),
        properties,
        required: ['action'],
        execute: async ({ action, group_id, user_id, member_openid, query, minutes, text }) => {
          if (!hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '只有主人能让我做群管操作' }
          const cfg = api.config()
          const rawGroupInput = String(group_id || '').trim() || (chat.kind === 'group' ? String(chat.chatId || chat.groupId || '').trim() : '')
          if (!rawGroupInput) return { ok: false, message: '不知道是哪个群' }

          const chatAddr = parseChatId(normChatKey(chat?.chatId || ''))
          let rawGroup = rawGroupInput
          if (/^oc_[0-9A-Za-z_-]+$/.test(rawGroupInput) && chatAddr?.platform === 'feishu' && chatAddr?.instance) {
            const allowMatchedFs = (cfg.allow?.groups || [])
              .map((g) => normalizeChatId(String(g || '').trim()))
              .filter(Boolean)
              .find((k) => {
                const p = parseChatId(k)
                return p?.platform === 'feishu' && p.kind === 'group' && p.id === rawGroupInput
              })
            if (!allowMatchedFs) rawGroup = `${chatAddr.instance}:group:${rawGroupInput}`
          }

          const spec = typeof groupRoles?.resolveBackend === 'function' ? groupRoles.resolveBackend(rawGroup) : null
          const parsedNorm = normalizeChatId(spec?.chatId || rawGroup)
          const parsedAddr = parsedNorm ? parseChatId(parsedNorm) : null
          const targetPlat = spec?.platform || parsedAddr?.platform || chat.platform || 'qq'
          const targetChatId = spec?.chatId || parsedNorm || `group:${rawGroup}`
          const rawIdForAllow = spec?.openid || spec?.gid || parsedAddr?.id || rawGroup

          const allowed = allowMatches(cfg.allow?.groups || [], { platform: targetPlat, chatId: targetChatId, groupId: rawIdForAllow }, 'group')
            || (spec?.alias && allowMatches(cfg.allow?.groups || [], { platform: targetPlat, chatId: targetChatId, groupId: spec.alias }, 'group'))
          if (!allowed) return { ok: false, message: '这个群不在白名单里' }

          const whole = action === 'whole_ban' || action === 'whole_unban'
          const targetUserRaw = String(member_openid || user_id || '').trim()

          // ── 分支 A：网关群管（QQBot 官方机器人 或 OneBot 网关实例 qq / qq#2）──
          if (spec?.backend === 'gateway-admin') {
            if (spec.platform === 'qq') {
              const gid = Number(spec?.gid || spec?.openid || parsedAddr?.id || rawGroup)
              if (!gid) return { ok: false, message: '不知道是哪个群' }
              const ga = spec.groupAdmin || gateway?.groupAdmin?.(spec.instance)
              if (!ga) return { ok: false, message: 'QQ 网关未连接，无法执行群管' }
              if (action === 'list_members') {
                if (typeof ga.listMembers !== 'function') {
                  return { ok: false, message: '当前 QQ 网关不支持查询群成员列表' }
                }
                const list = await ga.listMembers(String(gid), { limit: 100 }).catch(() => [])
                const q = String(query || text || '').trim().toLowerCase()
                const filtered = q ? list.filter((m) => String(m.nick || '').toLowerCase().includes(q) || String(m.openid || '').toLowerCase().includes(q)) : list
                const shown = filtered.slice(0, 50)
                return {
                  ok: true,
                  count: filtered.length,
                  members: shown,
                  message: shown.length
                    ? `共 ${filtered.length} 位成员：${shown.map((m) => (m.nick ? `${m.nick}(${m.openid})` : m.openid)).join('、')}`
                    : '没有匹配的群成员',
                }
              }
              const uid = Number(targetUserRaw || 0)
              if (!whole && action !== 'notice' && !uid) return { ok: false, message: '要说清楚对谁（QQ 号）' }
              if (uid && isOwner(api.core.identity, String(uid), 'qq') && action !== 'unban' && action !== 'title') {
                return { ok: false, message: '不能对主人做这个' }
              }
              const sa = ga.supportedActions || {}
              const capBlocked = (action === 'ban' && sa.ban === false)
                || (action === 'unban' && sa.unban === false)
                || (action === 'kick' && sa.kick === false)
                || (whole && sa.wholeBan === false)
                || (action === 'title' && sa.title === false)
                || (action === 'notice' && sa.notice === false)
              if (capBlocked) return { ok: false, message: `当前 QQ 网关不支持群管操作（${action}）` }

              const info = await inspectRole(rawGroup, { fresh: true })
              const role = info.role
              if (role && !groupRoles.canManage(role)) return { ok: false, message: '我在这个群只是普通成员，没有管理权限' }
              if (role === 'admin' && action === 'title') return { ok: false, message: '改专属头衔要群主才行，我只是管理员' }
              if (cfg.dryRun) return { ok: true, message: `试运行：本来要通过 QQ 网关（${spec.instance}）对群 ${gid} 做 ${action}` }

              try {
                if (action === 'ban') {
                  await ga.muteMember(String(gid), String(uid), Math.max(1, Number(minutes) || 10) * 60_000)
                } else if (action === 'unban') {
                  await ga.unmuteMember(String(gid), String(uid))
                } else if (action === 'kick') {
                  await ga.kickMember(String(gid), String(uid), { addBlackList: false })
                } else if (whole || action === 'title' || action === 'notice') {
                  if (typeof gateway?.native !== 'function') {
                    return { ok: false, message: `当前 QQ 网关不支持群管操作（${action}）` }
                  }
                  if (action === 'whole_ban' || action === 'whole_unban') {
                    await gateway.native(spec.instance, 'set_group_whole_ban', { group_id: gid, enable: action === 'whole_ban' })
                  } else if (action === 'title') {
                    await gateway.native(spec.instance, 'set_group_special_title', { group_id: gid, user_id: uid, special_title: String(text || '') })
                  } else if (action === 'notice') {
                    await gateway.native(spec.instance, '_send_group_notice', { group_id: gid, content: String(text || '') })
                  }
                } else {
                  return { ok: false, message: '不认识的操作' }
                }
              } catch (error) {
                if (error?.code === 'unsupported-action' || error?.code === 'group-admin-unsupported') {
                  return { ok: false, message: `当前 QQ 网关不支持群管操作（${action}）` }
                }
                return { ok: false, message: error?.message || `群管操作失败（${action}）` }
              }
              return { ok: true, message: '做好了' }
            }

            const ga = spec.groupAdmin || gateway?.groupAdmin?.(spec.instance)
            const isFeishu = spec.platform === 'feishu'
            const platLabel = isFeishu ? '飞书' : 'QQ 官方机器人'
            const idLabel = isFeishu ? 'open_id' : 'member_openid'
            if (action === 'list_members') {
              if (!ga) return { ok: false, message: `${platLabel}未连接，无法查询群成员` }
              const { members, error, truncated } = await fetchGatewayMembers(ga, spec.openid, targetChatId, { platform: spec.platform })
              const q = String(query || text || '').trim().toLowerCase()
              const filtered = q
                ? members.filter((m) => String(m.nick || '').toLowerCase().includes(q) || String(m.openid || '').toLowerCase().includes(q))
                : members
              if (!filtered.length && error) {
                return { ok: false, message: `${error}；也可以直接在群里 @ 对方让助手识别 ${idLabel}` }
              }
              const shown = filtered.slice(0, 50)
              const lines = shown.map((m) => {
                const label = m.nick ? `${m.nick}（${m.openid}）` : m.openid
                return m.role ? `${label}[${m.role}]` : label
              })
              const truncNote = truncated
                ? `（群成员超过拉取上限，当前仅展示前 ${members.length} 位；未找到时可在群里 @ 对方或直接提供 ${idLabel}）`
                : ''
              const note = error
                ? (isFeishu
                    ? `（飞书成员列表接口受限：${error}；以下为近期群内 @/发言缓存）`
                    : `（官方成员列表接口受限：${error}；以下为近期群内 @/发言缓存）`)
                : truncNote
              return {
                ok: true,
                count: filtered.length,
                members: shown,
                ...(truncated ? { truncated: true } : {}),
                message: shown.length ? `${note}共 ${filtered.length} 位成员：${lines.join('、')}` : '没有找到匹配的群成员',
              }
            }

            if (isFeishu) {
              if (action === 'ban' || action === 'unban') {
                return { ok: false, message: '飞书当前不支持按成员禁言/解禁（飞书开放平台无单人禁言接口）' }
              }
              if (action === 'whole_ban' || action === 'whole_unban') {
                return { ok: false, message: '飞书当前不支持全体禁言（群发言权限不等同于禁言）' }
              }
              if (action === 'title') {
                return { ok: false, message: '飞书当前不支持改专属头衔' }
              }
              if (action === 'notice') {
                return { ok: false, message: '飞书当前不支持发群公告' }
              }
              if (action !== 'kick') {
                return { ok: false, message: '不认识的操作' }
              }
              if (ga?.supportedActions?.kick === false || (ga && typeof ga.kickMember !== 'function')) {
                return { ok: false, message: '当前飞书实例不支持移出群成员' }
              }
            } else {
              if (UNSUPPORTED_QQBOT_ACTIONS[action]) {
                return { ok: false, message: `QQ 官方机器人当前不支持${UNSUPPORTED_QQBOT_ACTIONS[action]}` }
              }
              if (!['ban', 'unban', 'kick'].includes(action)) {
                return { ok: false, message: '不认识的操作' }
              }
            }

            const resolved = await resolveGatewayTarget({
              rawUserId: user_id,
              rawMemberOpenid: member_openid,
              chatId: targetChatId,
              groupOpenid: spec.openid,
              ga,
              identity: api.core.identity,
              platform: targetPlat,
              action,
            })
            if (resolved.error) {
              return { ok: false, message: resolved.error }
            }
            const resolvedOpenid = resolved.openid
            if (isOwner(api.core.identity, resolvedOpenid, targetPlat) && action !== 'unban') {
              return { ok: false, message: '不能对主人做这个' }
            }

            // 动作前实时重新查询身份，不能仅凭旧缓存执行
            const info = await inspectRole(rawGroup, { fresh: true })
            if (!info.role) return { ok: false, message: info.reason || '当前无法确认机器人在该群的管理身份' }
            if (info.role !== 'unknown' && !groupRoles.canManage(info.role)) return { ok: false, message: '我在这个群只是普通成员，没有管理权限' }

            const botSelfId = String(
              info?.memberOpenid
              || gateway?.instances?.()?.find((x) => x.instance === spec.instance)?.self?.account
              || '',
            ).trim()
            if (botSelfId && resolvedOpenid === botSelfId && action !== 'unban') {
              return { ok: false, message: '不能对我自己做这个操作' }
            }

            // 飞书禁止跨群使用 open_id：显式或历史缓存命中时，若成员列表接口可用且未截断则先校验目标属于当前群
            if (isFeishu && action === 'kick' && (resolved.via === 'explicit' || resolved.via === 'observed') && ga && typeof ga.listMembers === 'function') {
              let liveMembers = null
              try {
                liveMembers = await ga.listMembers(spec.openid, { startIndex: 0, limit: 5000 })
              } catch {}
              if (Array.isArray(liveMembers) && !liveMembers.truncated && !liveMembers.some((m) => m.openid === resolvedOpenid)) {
                return { ok: false, message: '该 open_id 不在当前飞书群的成员列表里（请用 list_members 核对，不能跨群复用 open_id）' }
              }
            }

            if (cfg.dryRun) {
              return {
                ok: true,
                message: isFeishu
                  ? `试运行：本来要通过飞书对群 ${spec.openid} 成员 ${resolvedOpenid} 做 ${action}`
                  : `试运行：本来要通过 QQ 官方机器人对群 ${spec.openid} 成员 ${resolvedOpenid} 做 ${action}`,
              }
            }

            if (!ga) return { ok: false, message: `${platLabel}未连接，无法执行群管` }

            try {
              if (action === 'ban') {
                const mins = Math.min(43200, Math.max(1, Number(minutes) || 10))
                await ga.muteMember(spec.openid, resolvedOpenid, mins * 60_000)
              } else if (action === 'unban') {
                await ga.unmuteMember(spec.openid, resolvedOpenid)
              } else if (action === 'kick') {
                await ga.kickMember(spec.openid, resolvedOpenid)
              }
            } catch (error) {
              const base = error?.message || `群管操作失败（${action}）`
              if (error?.code === 'group-admin-not-member' || error?.code === 'group-admin-not-in-chat') {
                return { ok: false, message: base }
              }
              const knownStatusError = [
                'group-admin-forbidden',
                'group-admin-not-admin',
                'group-admin-rate-limited',
                'group-admin-unsupported',
                'group-admin-not-member',
                'group-admin-not-in-chat',
              ].includes(error?.code)
              if (resolved.via === 'explicit' && !knownStatusError) {
                return {
                  ok: false,
                  message: isFeishu
                    ? `${base}（该 open_id 可能无效或不在本群，可用 list_members 核对）`
                    : `${base}（该 member_openid 可能无效或不在本群，可用 list_members 核对）`,
                }
              }
              return { ok: false, message: base }
            }
            if (resolved.via === 'mention' || resolved.via === 'members' || resolved.via === 'observed') {
              return { ok: true, message: `做好了（对象：${resolved.nick ? `${resolved.nick} / ${resolvedOpenid}` : resolvedOpenid}）` }
            }
            return { ok: true, message: '做好了' }
          }

          if (spec?.backend === 'none') {
            return { ok: false, message: spec.reason || '这个群还没有可用的群管通道，请先在权限页绑定或启用对应平台' }
          }
          if (!spec && parsedAddr && parsedAddr.instance && parsedAddr.instance !== 'qq') {
            return { ok: false, message: `平台实例 ${parsedAddr.instance} 暂不支持群管理（不会回落默认 QQ）` }
          }

          // ── 分支 B：传统 QQ OneBot ──
          const gid = Number(spec?.gid || parsedAddr?.id || rawGroup)
          if (!gid) return { ok: false, message: '不知道是哪个群' }
          if (action === 'list_members') {
            const list = await qqCall('get_group_member_list', { group_id: gid }).catch(() => [])
            const arr = Array.isArray(list) ? list : []
            const q = String(query || text || '').trim().toLowerCase()
            const mapped = arr.map((m) => ({
              openid: String(m?.user_id || ''),
              nick: String(m?.card || m?.nickname || ''),
              role: String(m?.role || ''),
            })).filter((m) => m.openid)
            const filtered = q ? mapped.filter((m) => m.nick.toLowerCase().includes(q) || m.openid.includes(q)) : mapped
            const shown = filtered.slice(0, 50)
            return {
              ok: true,
              count: filtered.length,
              members: shown,
              message: shown.length ? `共 ${filtered.length} 位成员：${shown.map((m) => (m.nick ? `${m.nick}(${m.openid})` : m.openid)).join('、')}` : '没有匹配的群成员',
            }
          }
          const uid = Number(targetUserRaw || 0)
          if (!whole && action !== 'notice' && !uid) return { ok: false, message: '要说清楚对谁（QQ 号）' }
          if (uid && isOwner(api.core.identity, String(uid), 'qq') && action !== 'unban' && action !== 'title') return { ok: false, message: '不能对主人做这个' }
          const info = await inspectRole(rawGroup, { fresh: true })
          const role = info.role
          if (role && !groupRoles.canManage(role)) return { ok: false, message: '我在这个群只是普通成员，没有管理权限' }
          if (role === 'admin' && action === 'title') return { ok: false, message: '改专属头衔要群主才行，我只是管理员' }
          if (cfg.dryRun) return { ok: true, message: `试运行：本来要对群 ${gid} 做 ${action}` }
          try {
            switch (action) {
              case 'ban': await qqCall('set_group_ban', { group_id: gid, user_id: uid, duration: Math.max(1, Number(minutes) || 10) * 60 }); break
              case 'unban': await qqCall('set_group_ban', { group_id: gid, user_id: uid, duration: 0 }); break
              // 全体禁言：整个群禁言 / 解除（OneBot v11 的 set_group_whole_ban）
              case 'whole_ban': await qqCall('set_group_whole_ban', { group_id: gid, enable: true }); break
              case 'whole_unban': await qqCall('set_group_whole_ban', { group_id: gid, enable: false }); break
              case 'kick': await qqCall('set_group_kick', { group_id: gid, user_id: uid, reject_add_request: false }); break
              case 'title': await qqCall('set_group_special_title', { group_id: gid, user_id: uid, special_title: String(text || '') }); break
              case 'notice': await qqCall('_send_group_notice', { group_id: gid, content: String(text || '') }); break
              default: return { ok: false, message: '不认识的操作' }
            }
          } catch (error) {
            if (error?.code === 'unsupported-action') return { ok: false, message: `当前 QQ 网关不支持群管操作（${action}）` }
            throw error
          }
          return { ok: true, message: '做好了' }
        },
      })
    })

    // ── 面板接口：群管权限表、QQBot 群绑定 / 解绑 / 成员列表 ──

    api.route('/groups/roles', async () => {
      const cfg = api.config()
      const activeBindings = typeof groupRoles?.bindings === 'function' ? groupRoles.bindings({ activeOnly: true }) : []
      const keys = []
      const seenResolved = new Set()

      for (const rawKey of cfg.allow?.groups || []) {
        const s = String(rawKey || '').trim()
        if (!s) continue
        const spec = typeof groupRoles?.resolveBackend === 'function' ? groupRoles.resolveBackend(s) : null
        const dedup = spec?.cacheKey || s
        if (seenResolved.has(dedup)) continue
        seenResolved.add(dedup)
        keys.push(s)
      }
      for (const b of activeBindings) {
        const spec = typeof groupRoles?.resolveBackend === 'function' ? groupRoles.resolveBackend(b.chatId) : null
        const dedup = spec?.cacheKey || b.chatId
        if (seenResolved.has(dedup)) continue
        seenResolved.add(dedup)
        keys.push(b.chatId)
      }

      const list = await Promise.all(keys.map(async (gid) => {
        const spec = typeof groupRoles?.resolveBackend === 'function' ? groupRoles.resolveBackend(gid) : null
        const info = await inspectRole(gid, { fresh: true })
        const role = info.role || ''
        let name = info.name || spec?.name || ''
        if ((!name || name === spec?.openid || name === String(gid)) && spec?.backend === 'gateway-admin' && spec.groupAdmin?.getGroupInfo) {
          const cachedName = spec.chatId ? groupNameCache.get(spec.chatId) : null
          if (cachedName && Date.now() - cachedName.at < GROUP_NAME_CACHE_TTL_MS && cachedName.name) {
            name = cachedName.name
          } else {
            try {
              const gInfo = await spec.groupAdmin.getGroupInfo(spec.openid)
              if (gInfo?.name) {
                name = gInfo.name
                if (spec.chatId) {
                  groupNameCache.set(spec.chatId, { name: gInfo.name, at: Date.now() })
                  groupRoles?.touchBindingName?.(spec.chatId, gInfo.name)
                }
              }
            } catch {}
          }
        }
        if (!name) name = await hub.groupName(String(gid)).catch(() => String(gid))
        const displayId = info.alias ? `${info.alias} · ${info.groupOpenid}` : String(gid)
        return {
          groupId: String(gid),
          displayId,
          name: String(name || gid),
          platform: info.platform || spec?.platform || '',
          instance: info.instance || spec?.instance || '',
          backend: info.backend || spec?.backend || 'onebot',
          backendLabel: backendLabelOf(info, spec),
          groupOpenid: info.groupOpenid || spec?.openid || '',
          alias: info.alias || spec?.alias || '',
          role,
          label: info.label || (role ? groupRoles.label(role) : '查不到'),
          reason: info.reason || '',
          canManage: Boolean(info.canManage),
          actions: info.actions || {},
        }
      }))

      const qqbotInstances = typeof gateway?.instances === 'function'
        ? gateway.instances()
            .filter((x) => x?.enabled && x.platform === 'qqbot')
            .map((x) => ({ instance: x.instance, platform: x.platform, name: x.name, state: x.state }))
        : []

      const rawCandidates = typeof groupRoles?.candidates === 'function' ? groupRoles.candidates() : []
      const candidates = await Promise.all(rawCandidates.map(async (c) => {
        if (c.name) return c
        const cached = groupNameCache.get(c.chatId)
        if (cached && Date.now() - cached.at < GROUP_NAME_CACHE_TTL_MS) {
          return cached.name ? { ...c, name: cached.name } : c
        }
        const ga = gateway?.groupAdmin?.(c.instance)
        if (!ga || typeof ga.getGroupInfo !== 'function') return c
        try {
          const gInfo = await ga.getGroupInfo(c.openid)
          const gName = String(gInfo?.name || '').trim()
          groupNameCache.set(c.chatId, { name: gName, at: Date.now() })
          if (gName) {
            if (c.bound) groupRoles?.touchBindingName?.(c.chatId, gName)
            return { ...c, name: gName }
          }
        } catch {
          groupNameCache.set(c.chatId, { name: '', at: Date.now() })
        }
        return c
      }))

      return {
        ok: true,
        list,
        bindings: typeof groupRoles?.bindings === 'function' ? groupRoles.bindings() : [],
        candidates,
        qqbotInstances,
      }
    })

    api.route('/groups/qqbot/bind', async (req) => {
      if (!groupRoles?.saveBinding) return { ok: false, message: '当前环境不支持群绑定' }
      const body = await readReqBody(req)
      const gwList = typeof gateway?.instances === 'function' ? gateway.instances() : []
      const defaultInst = gwList.find((x) => x?.enabled && x.platform !== 'qq' && (x.platform === 'qqbot' || gateway.groupAdmin?.(x.instance)))?.instance || 'qqbot'
      const instance = String(body.instance || defaultInst).trim()
      const openid = String(body.openid || body.groupOpenid || '').trim()
      const alias = String(body.alias || '').trim()
      let name = String(body.name || '').trim()
      if (!openid) return { ok: false, message: '请填 group_openid' }
      try {
        if (!name && gateway?.groupAdmin?.(instance)?.getGroupInfo) {
          const gInfo = await gateway.groupAdmin(instance).getGroupInfo(openid).catch(() => null)
          if (gInfo?.name) name = gInfo.name
        }
        const entry = groupRoles.saveBinding({ instance, openid, alias, name })
        return { ok: true, binding: entry, bindings: groupRoles.bindings(), message: '已保存 QQ 官方群绑定' }
      } catch (error) {
        return { ok: false, message: error?.message || '保存绑定失败' }
      }
    })

    api.route('/groups/qqbot/unbind', async (req) => {
      if (!groupRoles?.removeBinding) return { ok: false, message: '当前环境不支持群解绑' }
      const body = await readReqBody(req)
      const key = String(body.chatId || body.openid || body.alias || '').trim()
      if (!key) return { ok: false, message: '请指定要解绑的群' }
      const removed = groupRoles.removeBinding(key)
      return removed
        ? { ok: true, bindings: groupRoles.bindings(), message: '已解除 QQ 官方群绑定' }
        : { ok: false, message: '没找到这条绑定记录' }
    })

    api.route('/groups/qqbot/members', async (req) => {
      const q = readReqQuery(req)
      const openid = String(q.openid || q.groupOpenid || '').trim()
      const instance = String(q.instance || 'qqbot').trim()
      const ga = gateway?.groupAdmin?.(instance)
      if (!ga || typeof ga.listMembers !== 'function') {
        return { ok: false, message: 'QQ 官方机器人未连接或不支持成员列表查询' }
      }
      if (!openid) return { ok: false, message: '缺少 groupOpenid' }
      try {
        const list = await ga.listMembers(openid, { startIndex: Number(q.startIndex) || 0, limit: Number(q.limit) || 50 })
        return { ok: true, list }
      } catch (error) {
        return { ok: false, code: error?.code || '', message: error?.message || '查询群成员失败' }
      }
    })

    return {}
  },
}
