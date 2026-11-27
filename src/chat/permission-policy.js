import { delegatedCommandCatalog, isDelegatedCommandKey } from './delegated-commands.js'

const CAPABILITIES = {
  image: { label: '生图', description: '允许通过聊天请求画图，可能消耗生图额度' },
  song: { label: '点歌', description: '允许通过聊天请求翻唱' },
  video: { label: '视频', description: '允许通过聊天请求生成视频' },
}

export function privatePermissionCatalog(commands) {
  return [
    { key: 'chat', label: '允许私聊', description: '关闭后，下面的授权会暂停，重新开启即可恢复' },
    ...Object.entries(CAPABILITIES).map(([key, item]) => ({ ...item, key, group: '功能' })),
    ...delegatedCommandCatalog(commands),
  ]
}

function permissionLocation(key, kind) {
  if (key === 'chat') return ['allow', kind === 'group' ? 'groups' : 'private']
  if (kind !== 'private') return null
  if (Object.hasOwn(CAPABILITIES, key)) return ['capabilityAllow', key]
  return isDelegatedCommandKey(key) ? ['commandAllow', key] : null
}

/** 只更新指定对象、指定权限，保留同时来自 QQ 或设置页的其他改动。 */
export function changePermissions(cfg, { id, kind = 'private', changes } = {}, commands) {
  if (!['private', 'group'].includes(kind) || typeof id !== 'string' || !/^\d{5,}$/.test(id)) {
    return { ok: false, message: '请输入完整的 QQ 号或群号' }
  }
  if (kind === 'private' && String(cfg.ownerQQ) === id) return { ok: false, message: '主人权限请在主人设置中管理' }
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) {
    return { ok: false, message: '请选择要修改的权限' }
  }
  const allowed = new Set(privatePermissionCatalog(commands).map(({ key }) => key))
  const next = { ...cfg }
  for (const [key, enabled] of Object.entries(changes)) {
    const location = permissionLocation(key, kind)
    if (!location || typeof enabled !== 'boolean' || (enabled && !allowed.has(key))) {
      return { ok: false, message: `无法${enabled ? '授予' : '修改'}权限 ${key}。发送 /权限 命令 查看可授权命令。` }
    }
    const [section, listKey] = location
    const list = (next[section]?.[listKey] || []).map(String)
    next[section] = { ...next[section], [listKey]: enabled ? [...new Set([...list, id])] : list.filter((value) => value !== id) }
  }
  return { ok: true, config: next }
}

/** 批量加入私聊白名单，不改动已有的功能和命令授权。 */
export function changePrivateWhitelist(cfg, { ids } = {}) {
  if (!Array.isArray(ids) || !ids.length) return { ok: false, message: '请先输入 QQ 号' }
  if (ids.length > 500) return { ok: false, message: '一次最多处理 500 个 QQ 号，请分批粘贴' }

  const values = ids.map((value) => String(value ?? '').trim())
  if (values.some((id) => !/^\d{5,12}$/.test(id))) return { ok: false, message: 'QQ 号格式不对：每个都要是 5～12 位数字' }

  const unique = [...new Set(values)]
  const owner = String(cfg.ownerQQ || '')
  const requested = unique.filter((id) => id !== owner)
  const current = (cfg.allow?.private || []).map(String)
  const nextList = [...new Set([...current, ...requested])]
  const changed = nextList.length - current.length
  const next = changed ? { ...cfg, allow: { ...cfg.allow, private: nextList } } : null

  return {
    ok: true,
    ...(next ? { config: next } : {}),
    changed,
    skipped: unique.length - changed,
    ownerSkipped: unique.includes(owner) ? 1 : 0,
  }
}
