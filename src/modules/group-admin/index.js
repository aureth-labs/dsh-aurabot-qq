// 内置模块：群管。主人开口时禁言、解禁、踢人、改头衔、发公告；支持 QQ 直连与 QQ 官方机器人双后端。

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

function backendLabelOf(info, spec) {
  const b = info?.backend || spec?.backend
  const p = info?.platform || spec?.platform
  if (b === 'gateway-admin') return p === 'qqbot' ? 'QQ 官方机器人' : (p === 'qq' ? 'QQ 网关' : `${p || '平台'}网关`)
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
  platforms: ['qq', 'qqbot'],
  features: {
    optional: ['chat.member.list'],
  },
  toolAliases,
  description: '主人要求时做群管理：QQ 直连支持禁言/解禁/全体禁言/踢人/改头衔/发公告；QQ 官方机器人支持禁言/解禁/踢人（group_admin）',
  setup(api) {
    const { hub, onebot, groupRoles, gateway, http } = api.core
    const groupNameCache = new Map() // chatId -> { name, at }
    const GROUP_NAME_CACHE_TTL_MS = 10 * 60_000
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

    // 她在这个群的身份：没管理权限或无官方接口权限时直接如实说明
    api.context(({ chat }) => {
      if (chat.kind !== 'group') return ''
      const info = roleInfoSync(chat)
      const role = info?.role || ''
      if (!role) {
        if (info?.backend === 'gateway-admin' && info?.platform !== 'qq' && info.reason) {
          return `当前群的 QQ 官方机器人群管理暂不可用（${info.reason}）；主人让你禁言或踢人时，直接如实说明原因。`
        }
        return ''
      }
      if (!groupRoles.canManage(role)) {
        return '你在这个群只是普通成员，没有管理权限：禁言、踢人这些做不了，主人要求时直接说明。'
      }
      if (info?.backend === 'gateway-admin' && info?.platform !== 'qq') {
        return `你在这个群是${groupRoles.label(role)}。主人要求时可以用 group_admin 禁言、解禁或踢人（QQ 官方机器人不支持全体禁言、改专属头衔和发群公告；操作对象只能填群成员的 member_openid，不能填 QQ 号；不要写 /ban 等斜杠命令）。`
      }
      return `你在这个群是${groupRoles.label(role)}，主人要求时可以用 group_admin 做群管操作（不要写 /ban 等斜杠命令）。`
    })

    // 工具层校验：这一轮说话的人必须全是主人
    api.tool(({ chat, level, sessionId }) => {
      if (!(chat.kind === 'group' || level === 'full')) return []
      return defineTool({
        name: 'group_admin',
        description: '群管理：禁言（ban）/ 解禁（unban）/ 踢人（kick），QQ 直连群还支持全体禁言（whole_ban/whole_unban）/ 改头衔（title）/ 发公告（notice）。只有主人单独发话时才能用。',
        properties: {
          action: { type: 'string', enum: ['ban', 'unban', 'whole_ban', 'whole_unban', 'kick', 'title', 'notice'], description: 'ban 禁言，unban 解禁，whole_ban 全体禁言，whole_unban 解除全体禁言，kick 踢出，title 改专属头衔，notice 发公告' },
          group_id: str('群号或规范群地址（如 qqbot:group:xxx）；在群里用时可省略，默认当前群'),
          user_id: str('操作对象 ID：QQ 直连群填对方 QQ 号；QQ 官方机器人群只能填成员 member_openid（全体禁言和发公告不需要）'),
          member_openid: str('可选，QQ 官方机器人群目标成员的 member_openid'),
          minutes: int('禁言分钟数，默认 10；QQ 官方机器人最长 43200（30 天）'),
          text: str('头衔内容或公告内容（QQ 官方机器人不支持）'),
        },
        required: ['action'],
        execute: async ({ action, group_id, user_id, member_openid, minutes, text }) => {
          if (!hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '只有主人能让我做群管操作' }
          const cfg = api.config()
          const rawGroup = String(group_id || '').trim() || (chat.kind === 'group' ? String(chat.chatId || chat.groupId || '').trim() : '')
          if (!rawGroup) return { ok: false, message: '不知道是哪个群' }

          const spec = typeof groupRoles?.resolveBackend === 'function' ? groupRoles.resolveBackend(rawGroup) : null
          const parsedNorm = normalizeChatId(rawGroup)
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
              const uid = Number(targetUserRaw || 0)
              if (!whole && action !== 'notice' && !uid) return { ok: false, message: '要说清楚对谁（QQ 号）' }
              if (uid && isOwner(api.core.identity, String(uid), 'qq') && action !== 'unban' && action !== 'title') {
                return { ok: false, message: '不能对主人做这个' }
              }
              const ga = spec.groupAdmin || gateway?.groupAdmin?.(spec.instance)
              if (!ga) return { ok: false, message: 'QQ 网关未连接，无法执行群管' }
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

            if (UNSUPPORTED_QQBOT_ACTIONS[action]) {
              return { ok: false, message: `QQ 官方机器人当前不支持${UNSUPPORTED_QQBOT_ACTIONS[action]}` }
            }
            if (!['ban', 'unban', 'kick'].includes(action)) {
              return { ok: false, message: '不认识的操作' }
            }
            if (!targetUserRaw) {
              return { ok: false, message: '要说清楚对谁操作，请提供该成员的 member_openid（可在群里 @ 对方获得）' }
            }
            if (/^\d{5,15}$/.test(targetUserRaw)) {
              return { ok: false, message: 'QQ 官方机器人不能按 QQ 号操作，请提供该成员的 member_openid（可在群里 @ 对方或从成员列表选择）' }
            }
            if (isOwner(api.core.identity, targetUserRaw, targetPlat) && action !== 'unban') {
              return { ok: false, message: '不能对主人做这个' }
            }

            // 动作前实时重新查询身份，不能仅凭旧缓存执行
            const info = await inspectRole(rawGroup, { fresh: true })
            if (!info.role) return { ok: false, message: info.reason || '当前无法确认机器人在该群的管理身份' }
            if (!groupRoles.canManage(info.role)) return { ok: false, message: '我在这个群只是普通成员，没有管理权限' }
            if (cfg.dryRun) return { ok: true, message: `试运行：本来要通过 QQ 官方机器人对群 ${spec.openid} 成员 ${targetUserRaw} 做 ${action}` }

            const ga = spec.groupAdmin || gateway?.groupAdmin?.(spec.instance)
            if (!ga) return { ok: false, message: 'QQ 官方机器人未连接，无法执行群管' }

            try {
              if (action === 'ban') {
                const mins = Math.min(43200, Math.max(1, Number(minutes) || 10))
                await ga.muteMember(spec.openid, targetUserRaw, mins * 60_000)
              } else if (action === 'unban') {
                await ga.unmuteMember(spec.openid, targetUserRaw)
              } else if (action === 'kick') {
                await ga.kickMember(spec.openid, targetUserRaw)
              }
            } catch (error) {
              return { ok: false, message: error?.message || `群管操作失败（${action}）` }
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
            .filter((x) => x?.enabled && x.platform !== 'qq' && (x.platform === 'qqbot' || Boolean(gateway.groupAdmin?.(x.instance))))
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
