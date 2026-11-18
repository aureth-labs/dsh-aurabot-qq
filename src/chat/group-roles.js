// 她在每个群里的身份（群主 / 管理员 / 普通成员）：决定能不能做群管。查一次缓存 10 分钟。
// 支持双后端：传统 OneBot（get_group_member_info）与网关群管能力（如 QQ 官方机器人 bot_state + group_openid 绑定表）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { normalizeChatId, parseChatId } from '../gateway/address.js'

const TTL = 10 * 60_000
export const ROLE_LABEL = { owner: '群主', admin: '管理员', member: '普通成员' }

const ONE_BOT_ACTIONS = Object.freeze({ ban: true, unban: true, kick: true, wholeBan: true, title: true, notice: true })
const NO_ACTIONS = Object.freeze({ ban: false, unban: false, kick: false, wholeBan: false, title: false, notice: false })

function readBindingsFile(file) {
  if (!file || !existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const raw = parsed && typeof parsed.groups === 'object' && parsed.groups && !Array.isArray(parsed.groups) ? parsed.groups : {}
    const out = {}
    for (const [k, v] of Object.entries(raw)) {
      if (!v || typeof v !== 'object') continue
      const openid = String(v.openid || '').trim()
      const instance = String(v.instance || '').trim()
      if (!openid || !instance) continue
      const addr = parseChatId(`${instance}:private:0`)
      const platform = String(v.platform || addr?.platform || instance).trim()
      const chatId = String(v.chatId || `${instance}:group:${openid}`).trim()
      out[chatId] = {
        chatId,
        instance,
        platform,
        openid,
        alias: String(v.alias || '').trim(),
        name: String(v.name || '').trim(),
        boundAt: Number(v.boundAt) || 0,
      }
    }
    return out
  } catch {
    return {}
  }
}

export function createGroupRoles({ onebot = null, gateway = null, getGateway = null, getConfig, dataDir = null, log = null } = {}) {
  const cache = new Map() // backendCacheKey -> { at, info }
  const inflight = new Map()
  const defPlat = parseChatId('private:0')?.platform || ''
  let bindingsCache = null

  const gwOf = () => (typeof getGateway === 'function' ? getGateway() : gateway) || null
  const cfgOf = () => (typeof getConfig === 'function' ? getConfig() : {}) || {}
  const bindingsPath = () => (typeof dataDir === 'function' ? String(dataDir('qqbot-groups.json') || '') : '')

  function loadBindings() {
    if (bindingsCache) return bindingsCache
    bindingsCache = readBindingsFile(bindingsPath())
    return bindingsCache
  }

  function persistBindings() {
    const file = bindingsPath()
    if (!file) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ groups: loadBindings() }, null, 2), 'utf8')
    } catch (error) {
      log?.warn?.('保存群绑定配置失败：', error?.message || error)
    }
  }

  function isInstanceActive(instanceName) {
    const inst = String(instanceName || '').trim()
    if (!inst) return false
    const cfg = cfgOf()
    if (cfg?.platforms?.[inst]?.enabled !== true) return false
    const gw = gwOf()
    if (!gw) return true
    const list = typeof gw.instances === 'function' ? gw.instances() : []
    if (!list.length) return true
    const row = list.find((x) => x?.instance === inst)
    return Boolean(row && row.enabled)
  }

  function activeAdminInstances() {
    const gw = gwOf()
    if (!gw || typeof gw.groupAdmin !== 'function') return []
    const list = typeof gw.instances === 'function' ? gw.instances() : []
    return list.filter((x) => x?.enabled && x?.platform !== defPlat && gw.groupAdmin(x.instance))
  }

  function listBindings({ activeOnly = false } = {}) {
    const all = Object.values(loadBindings()).map((b) => ({
      ...b,
      active: isInstanceActive(b.instance),
    }))
    return activeOnly ? all.filter((b) => b.active) : all
  }

  function saveBinding({ instance, openid, alias = '', name = '' }) {
    const inst = String(instance || '').trim()
    const gid = String(openid || '').trim()
    if (!inst || !gid) throw new Error('缺少实例名或 group_openid')
    if (!isInstanceActive(inst)) throw new Error(`实例 ${inst} 未启用或已移除`)
    const addr = parseChatId(`${inst}:private:0`)
    const platform = addr?.platform || inst
    const chatId = `${inst}:group:${gid}`
    const map = loadBindings()
    const entry = {
      chatId,
      instance: inst,
      platform,
      openid: gid,
      alias: String(alias || '').trim(),
      name: String(name || '').trim(),
      boundAt: Date.now(),
    }
    map[chatId] = entry
    persistBindings()
    invalidateCache(chatId)
    invalidateCache(gid)
    if (entry.alias) invalidateCache(entry.alias)
    return { ...entry, active: true }
  }

  function removeBinding(chatIdOrOpenid) {
    const key = String(chatIdOrOpenid || '').trim()
    if (!key) return false
    const map = loadBindings()
    let deleted = null
    if (map[key]) {
      deleted = map[key]
      delete map[key]
    } else {
      for (const [k, v] of Object.entries(map)) {
        if (v.openid === key || v.alias === key) {
          deleted = v
          delete map[k]
          break
        }
      }
    }
    if (!deleted) return false
    persistBindings()
    invalidateCache(deleted.chatId)
    invalidateCache(deleted.openid)
    if (deleted.alias) invalidateCache(deleted.alias)
    return true
  }

  function touchBindingName(chatIdOrOpenid, name) {
    const key = String(chatIdOrOpenid || '').trim()
    const clean = String(name || '').trim()
    if (!key || !clean) return false
    const map = loadBindings()
    let target = map[key] || Object.values(map).find((v) => v.openid === key || v.alias === key)
    if (!target || target.name === clean) return false
    target.name = clean
    persistBindings()
    return true
  }

  function invalidateCache(groupKey) {
    const needle = String(groupKey || '').trim()
    if (!needle) return
    for (const k of cache.keys()) {
      if (k.endsWith(`:${needle}`)) cache.delete(k)
    }
  }

  function candidates() {
    const gw = gwOf()
    if (!gw || typeof gw.groupAdmin !== 'function') return []
    const bound = loadBindings()
    const out = []
    for (const instRow of typeof gw.instances === 'function' ? gw.instances() : []) {
      if (!instRow?.enabled || instRow?.state !== 'connected') continue
      const ga = gw.groupAdmin(instRow.instance)
      const list = typeof ga?.observedGroups === 'function' ? ga.observedGroups() : []
      for (const item of list) {
        const openid = String(item?.openid || '').trim()
        if (!openid) continue
        const chatId = `${instRow.instance}:group:${openid}`
        const b = bound[chatId]
        out.push({
          instance: instRow.instance,
          platform: instRow.platform,
          chatId,
          openid,
          at: Number(item.at) || 0,
          preview: String(item.preview || ''),
          bound: Boolean(b),
          alias: b?.alias || '',
          name: b?.name || '',
        })
      }
    }
    return out.sort((a, b) => b.at - a.at)
  }

  function resolveBackend(groupKey) {
    const raw = String(groupKey ?? '').trim()
    const gw = gwOf()
    const cfg = cfgOf()
    const allBindings = loadBindings()
    const norm = raw ? normalizeChatId(raw) : null
    const parsed = raw.includes(':') && norm ? parseChatId(norm) : null
    const isDefaultInstance = parsed ? (!parsed.instance || parsed.instance === defPlat) : true

    const gwDefInst = gw && typeof gw.instances === 'function' ? gw.instances().find((x) => x.instance === defPlat) : null
    const gwDefGa = gw?.groupAdmin?.(defPlat) || null
    const hasOnebotFn = Boolean(onebot && typeof onebot.call === 'function')
    const onebotConnected = hasOnebotFn && (onebot.state === undefined || onebot.state === 'connected')
    const defaultQqUnavailableReason = () => {
      if (gwDefInst?.enabled && !onebotConnected) {
        return '当前默认 QQ 网关未提供群管理能力，且未连接旧版直连 OneBot'
      }
      if (!hasOnebotFn || (!cfg?.enabled && !onebotConnected)) {
        return '旧版直连 QQ 未启用或未连接，当前群无可用群管后端'
      }
      return ''
    }

    // 非默认实例（含 qq#2）及非默认平台（qqbot / feishu 等）严禁落回默认 OneBot
    if (parsed && (!isDefaultInstance || parsed.platform !== defPlat)) {
      const chatId = `${parsed.instance}:group:${parsed.id}`
      const b = allBindings[chatId]
      const active = isInstanceActive(parsed.instance)
      if (!active) {
        return {
          backend: 'none',
          platform: parsed.platform,
          instance: parsed.instance,
          openid: parsed.id,
          chatId,
          alias: b?.alias || '',
          name: b?.name || '',
          cacheKey: `none:${chatId}`,
          reason: `平台实例 ${parsed.instance} 未启用或已移除`,
        }
      }
      const ga = gw?.groupAdmin?.(parsed.instance) || null
      const instRow = gw?.instances?.().find((x) => x.instance === parsed.instance)
      if (!ga && (parsed.platform === defPlat || (instRow && instRow.state === 'connected'))) {
        return {
          backend: 'none',
          platform: parsed.platform,
          instance: parsed.instance,
          openid: parsed.id,
          chatId,
          alias: b?.alias || '',
          name: b?.name || '',
          cacheKey: `none:${chatId}`,
          reason: parsed.platform === defPlat
            ? `平台实例 ${parsed.instance} 暂不支持群管理（不会回落默认 QQ）`
            : '当前平台不支持群管理能力',
        }
      }
      const reason = ga ? '' : 'QQ 官方机器人未连接'
      return {
        backend: 'gateway-admin',
        platform: parsed.platform,
        instance: parsed.instance,
        openid: parsed.id,
        chatId,
        groupAdmin: ga,
        alias: b?.alias || '',
        name: b?.name || '',
        cacheKey: `gw:${parsed.instance}:${parsed.id}`,
        ...(reason ? { reason } : {}),
      }
    }

    if (parsed && parsed.platform === defPlat && isDefaultInstance) {
      const b = allBindings[norm]
      if (gwDefGa) {
        return {
          backend: 'gateway-admin',
          platform: defPlat,
          instance: parsed.instance || defPlat,
          openid: parsed.id,
          chatId: norm,
          groupAdmin: gwDefGa,
          alias: b?.alias || '',
          name: b?.name || '',
          cacheKey: `gw:${parsed.instance || defPlat}:${parsed.id}`,
        }
      }
      const unavail = defaultQqUnavailableReason()
      if (unavail) {
        return {
          backend: 'none',
          platform: defPlat,
          instance: parsed.instance || defPlat,
          gid: parsed.id,
          chatId: norm,
          cacheKey: `none:${norm}`,
          reason: unavail,
        }
      }
      return {
        backend: 'onebot',
        platform: defPlat,
        instance: parsed.instance || defPlat,
        gid: parsed.id,
        chatId: norm,
        cacheKey: `ob:${parsed.instance || defPlat}:${parsed.id}`,
      }
    }

    // 裸群号或 group_openid：先查处于激活状态的绑定表，未绑定且无可用默认 QQ 通道时明确提示先去绑定
    const boundMatch = Object.values(allBindings).find((b) => isInstanceActive(b.instance) && (b.alias === raw || b.openid === raw))
    if (boundMatch) {
      const ga = gw?.groupAdmin?.(boundMatch.instance) || null
      const instRow = gw?.instances?.().find((x) => x.instance === boundMatch.instance)
      const reason = ga ? '' : (!gw || !instRow || instRow.state !== 'connected' ? 'QQ 官方机器人未连接' : '当前平台不支持群管理能力')
      return {
        backend: 'gateway-admin',
        platform: boundMatch.platform,
        instance: boundMatch.instance,
        openid: boundMatch.openid,
        chatId: boundMatch.chatId,
        groupAdmin: ga,
        alias: boundMatch.alias,
        name: boundMatch.name,
        cacheKey: `gw:${boundMatch.instance}:${boundMatch.openid}`,
        ...(reason ? { reason } : {}),
      }
    }

    const plats = cfg?.platforms
    const hasPlatMap = Boolean(plats && typeof plats === 'object')
    const defPlatCfg = hasPlatMap ? plats[defPlat] : null
    const hasOtherPlatCfg = Boolean(hasPlatMap && Object.entries(plats).some(([k, v]) => k !== defPlat && v && v.enabled !== false))
    const hasOtherActiveGw = activeAdminInstances().length > 0
      || Boolean(gw && typeof gw.instances === 'function' && gw.instances().some((x) => x.enabled && x.platform !== defPlat))
    const defPlatEnabledInCfg = defPlatCfg && typeof defPlatCfg === 'object'
      ? defPlatCfg.enabled !== false
      : (gwDefInst
          ? Boolean(gwDefInst.enabled)
          : Boolean(!hasOtherActiveGw && !hasOtherPlatCfg && (cfg.enabled === true || (cfg.enabled === undefined && (!plats || Object.keys(plats).length === 0)))))
    const onebotReady = !hasOtherActiveGw || (
      onebotConnected
      && (!gwDefInst || (gwDefInst.enabled && gwDefInst.state === 'connected'))
    )
    const bareUnavailReason = defaultQqUnavailableReason()
    const isOnebotActive = Boolean(onebot && defPlatEnabledInCfg && onebotReady && !bareUnavailReason)

    if (isOnebotActive) {
      const obKey = defPlat ? `${defPlat}:group:${raw}` : raw
      return {
        backend: 'onebot',
        platform: defPlat,
        instance: defPlat,
        gid: raw,
        chatId: obKey,
        cacheKey: `ob:${defPlat}:${raw}`,
      }
    }

    const hasGwAdminCap = hasOtherActiveGw || hasOtherPlatCfg || Object.keys(allBindings).length > 0
    if (!hasGwAdminCap && defPlatEnabledInCfg && bareUnavailReason) {
      const obKey = defPlat ? `${defPlat}:group:${raw}` : raw
      return {
        backend: 'none',
        platform: defPlat,
        instance: defPlat,
        gid: raw,
        chatId: obKey,
        cacheKey: `none:${obKey || raw}`,
        reason: bareUnavailReason,
      }
    }
    return {
      backend: 'none',
      unbound: true,
      platform: '',
      instance: '',
      gid: raw,
      cacheKey: `unbound:${raw}`,
      reason: hasGwAdminCap ? '先去绑定群' : 'QQ 未启用且未绑定官方群',
    }
  }

  const canManage = (role) => role === 'owner' || role === 'admin'
  const label = (role) => ROLE_LABEL[role] || '不清楚'

  function mapGatewayRoleError(error) {
    const code = String(error?.code || '')
    if (code === 'group-admin-forbidden') return '未获得 QQ 官方群管理接口权限（11253）'
    if (code === 'group-admin-not-admin') return '机器人不是管理员'
    if (code === 'group-admin-unsupported') return '当前 QQ 官方机器人不支持该接口'
    if (code === 'group-admin-rate-limited') return '查询触发平台频率限制，请稍后再试'
    return error?.message || '查询失败'
  }

  async function fetchRoleInfo(spec) {
    if (spec.backend === 'none') {
      return {
        role: '',
        label: spec.unbound ? '查不到' : '不可用',
        canManage: false,
        supported: false,
        unbound: Boolean(spec.unbound),
        reason: spec.reason || '先去绑定群',
        actions: NO_ACTIONS,
        backend: 'none',
        platform: spec.platform || '',
        instance: spec.instance || '',
        groupOpenid: spec.openid || '',
        alias: spec.alias || '',
        name: spec.name || '',
      }
    }

    if (spec.backend === 'gateway-admin') {
      if (!spec.groupAdmin || typeof spec.groupAdmin.getBotState !== 'function') {
        return {
          role: '',
          label: '查不到',
          canManage: false,
          supported: false,
          reason: spec.reason || 'QQ 官方机器人未连接',
          actions: NO_ACTIONS,
          backend: 'gateway-admin',
          platform: spec.platform,
          instance: spec.instance,
          groupOpenid: spec.openid,
          alias: spec.alias || '',
          name: spec.name || '',
        }
      }
      try {
        const st = await spec.groupAdmin.getBotState(spec.openid)
        const role = ['owner', 'admin', 'member'].includes(st?.role) ? st.role : 'member'
        const manageable = canManage(role)
        const info = {
          role,
          label: ROLE_LABEL[role] || '不清楚',
          canManage: manageable,
          supported: true,
          reason: manageable ? '' : '机器人不是管理员',
          actions: spec.groupAdmin.supportedActions || { ban: true, unban: true, kick: true, wholeBan: false, title: false, notice: false },
          backend: 'gateway-admin',
          platform: spec.platform,
          instance: spec.instance,
          groupOpenid: spec.openid,
          memberOpenid: st?.memberOpenid || '',
          alias: spec.alias || '',
          name: spec.name || '',
        }
        cache.set(spec.cacheKey, { at: Date.now(), info })
        return info
      } catch (error) {
        const reason = mapGatewayRoleError(error)
        return {
          role: '',
          label: '查不到',
          canManage: false,
          supported: false,
          reason,
          actions: NO_ACTIONS,
          backend: 'gateway-admin',
          platform: spec.platform,
          instance: spec.instance,
          groupOpenid: spec.openid,
          alias: spec.alias || '',
          name: spec.name || '',
        }
      }
    }

    // 默认传统 QQ OneBot
    if (!onebot || typeof onebot.call !== 'function' || !/^\d+$/.test(String(spec.gid || ''))) {
      return {
        role: '',
        label: '查不到（她在群里吗？）',
        canManage: false,
        supported: false,
        reason: '查不到（她在群里吗？）',
        actions: NO_ACTIONS,
        backend: 'onebot',
        platform: defPlat,
        instance: spec.instance || defPlat,
        gid: spec.gid || '',
      }
    }
    try {
      const r = await onebot.call('get_group_member_info', { group_id: Number(spec.gid), user_id: Number(cfgOf().botQQ), no_cache: true }, { timeoutMs: 8000 })
      const role = ['owner', 'admin', 'member'].includes(r && r.role) ? r.role : 'member'
      const info = {
        role,
        label: ROLE_LABEL[role] || '不清楚',
        canManage: canManage(role),
        supported: true,
        reason: canManage(role) ? '' : '机器人不是管理员',
        actions: ONE_BOT_ACTIONS,
        backend: 'onebot',
        platform: defPlat,
        instance: spec.instance || defPlat,
        gid: spec.gid,
      }
      cache.set(spec.cacheKey, { at: Date.now(), info })
      return info
    } catch (error) {
      log?.debug?.(`查群 ${spec.gid} 里的身份失败：`, error.message)
      return {
        role: '',
        label: '查不到（她在群里吗？）',
        canManage: false,
        supported: true,
        reason: '查不到（她在群里吗？）',
        actions: ONE_BOT_ACTIONS,
        backend: 'onebot',
        platform: defPlat,
        instance: spec.instance || defPlat,
        gid: spec.gid,
      }
    }
  }

  /** 返回完整群身份与能力解析结构（含 platform / backend / reason / actions）。 */
  async function inspect(gid, { fresh = false } = {}) {
    const spec = resolveBackend(gid)
    const c = cache.get(spec.cacheKey)
    if (!fresh && c && Date.now() - c.at < TTL) return c.info
    if (!inflight.has(spec.cacheKey)) {
      inflight.set(spec.cacheKey, fetchRoleInfo(spec).then((info) => {
        if (!fresh && !info.role && info.supported && c) return { ...info, role: c.info.role }
        return info
      }).finally(() => inflight.delete(spec.cacheKey)))
    }
    return inflight.get(spec.cacheKey)
  }

  /** 查身份字符串（兼容旧接口：'owner' | 'admin' | 'member' | ''）。 */
  async function get(gid, { fresh = false } = {}) {
    const info = await inspect(gid, { fresh })
    return info?.role || ''
  }

  /** 同步拿缓存详情（给每轮上下文用），过期就顺手在后台刷新。 */
  function peekInfo(gid) {
    const spec = resolveBackend(gid)
    const c = cache.get(spec.cacheKey)
    if (!c || Date.now() - c.at >= TTL) inspect(gid).catch(() => {})
    return c ? c.info : null
  }

  /** 同步拿角色字符串（兼容旧接口）。 */
  function peek(gid) {
    return peekInfo(gid)?.role || ''
  }

  return {
    get,
    inspect,
    peek,
    peekInfo,
    canManage,
    label,
    resolveBackend,
    bindings: listBindings,
    saveBinding,
    removeBinding,
    touchBindingName,
    candidates,
    activeAdminInstances,
  }
}
