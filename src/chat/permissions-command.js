import { isOwner, PROFILE_PERM_KEYS, PROFILE_PERM_LEVELS, permOf } from './access.js'
import { changePermissions, privatePermissionCatalog } from './permission-policy.js'

const HELP = [
  '权限管理（仅主人私聊）',
  '/权限 QQ号  查看这个人的授权',
  '/权限 授权 QQ号 私聊 生图 reset  一次授予多项权限',
  '/权限 撤销 QQ号 reset model  一次撤销多项权限',
  '/权限 命令  查看可授权命令',
  '/权限 列表 私聊|群|生图|点歌|视频  查看名单',
  '/权限 添加|移除 群 群号  管理群白名单',
  '/权限 档位  查看资料和社交操作的全局档位',
  '关闭私聊会暂停其余授权，重新开启即可恢复。',
].join('\n')

const NAMES = new Map(Object.entries({
  私聊: 'chat', private: 'chat', 生图: 'image', 点歌: 'song', 视频: 'video',
  重开: 'reset', 模型: 'model', 思考: 'effort',
}))

const keyOf = (name) => NAMES.get(name) || name?.replace(/^[/／]/, '')
const hasId = (list, id) => (list || []).map(String).includes(id)

export function runPermissionsCommand(arg, msg, { getConfig, setConfig, extraCommands = [] }) {
  const cfg = getConfig()
  if (msg?.kind !== 'private' || !isOwner(cfg, msg.userId)) return '权限管理只能由主人私聊使用。'
  const catalog = privatePermissionCatalog(extraCommands)
  const labels = new Map(catalog.map(({ key, label }) => [key, label]))
  const labelOf = (key) => labels.get(key) || '/' + key
  const parts = String(arg || '').trim().split(/\s+/).filter(Boolean)
  const [action, type, third, fourth] = parts
  if (!action || /^(帮助|help)$/.test(action)) return HELP
  if (/^(命令|commands)$/.test(action) && parts.length === 1) {
    return '可授权的命令\n' + catalog.filter((item) => item.group?.includes('命令')).map(({ key, label }) => key.startsWith('ext:') ? `${label}（${key}）` : label).join('、')
  }
  if (/^(档位|level)$/.test(action)) {
    if (parts.length === 1) return '全局权限档位（off 关闭、owner 仅主人、all 所有会话）\n' + PROFILE_PERM_KEYS.map((key) => `${key} ${permOf(cfg, key)}`).join('\n')
    if (parts.length !== 3 || !PROFILE_PERM_KEYS.includes(type) || !PROFILE_PERM_LEVELS.includes(third)) return '用法 /权限 档位 项目 off|owner|all。先发 /权限 档位 查看项目。'
    setConfig({ ...cfg, profilePerms: { ...cfg.profilePerms, [type]: third } })
    if (permOf(getConfig(), type) !== third) return `${type} 的档位未变更。`
    return `已将 ${type} 的全局档位设为 ${third}。`
  }
  const subject = parts.length === 1 ? action : /^(用户|user)$/.test(action) && parts.length === 2 ? type : ''
  if (/^\d{5,}$/.test(subject)) {
    if (String(cfg.ownerQQ) === subject) return `${subject} 是主人账号。`
    const allowed = hasId(cfg.allow?.private, subject)
    const grants = [...Object.entries(cfg.capabilityAllow || {}), ...Object.entries(cfg.commandAllow || {})]
      .filter(([, list]) => hasId(list, subject)).map(([key]) => labels.has(key) ? labelOf(key) : `${labelOf(key)}（当前不可用）`)
    return `${subject}\n私聊 ${allowed ? '允许' : '未允许'}\n授权 ${grants.join('、') || '无'}${!allowed && grants.length ? '（已暂停）' : ''}`
  }
  if (/^(列表|list)$/.test(action)) {
    const key = keyOf(type)
    const list = parts.length === 2
      ? type === '群' || type === 'group' ? cfg.allow?.groups : key === 'chat' ? cfg.allow?.private : cfg.capabilityAllow?.[key]
      : parts.length === 3 && /^(命令|command)$/.test(type) ? cfg.commandAllow?.[keyOf(third)] : undefined
    return list ? `${third || type}名单\n${list.join('、') || '空'}` : HELP
  }
  const add = /^(添加|授权|add)$/.test(action)
  if (!add && !/^(移除|撤销|删除|del|remove)$/.test(action)) return HELP
  let kind = 'private'
  let id
  let keys
  if (/^\d{5,}$/.test(type) && parts.length > 2) {
    id = type
    keys = parts.slice(2).flatMap((part) => part.split(/[,，、]+/)).filter(Boolean).map(keyOf)
  } else if (/^(命令|command)$/.test(type) && parts.length === 4) {
    id = fourth
    keys = [keyOf(third)]
  } else if (parts.length === 3) {
    id = third
    if (/^(群|group)$/.test(type)) kind = 'group'
    keys = [kind === 'group' ? 'chat' : keyOf(type)]
  } else return HELP
  const changes = Object.fromEntries(keys.map((key) => [key, add]))
  const result = changePermissions(cfg, { id, kind, changes }, extraCommands)
  if (!result.ok) return result.message
  setConfig(result.config)
  const names = kind === 'group' ? '群白名单' : [...new Set(keys)].map(labelOf).join('、')
  const paused = kind === 'private' && !hasId(result.config.allow?.private, id)
  return `${id} 已${add ? '添加' : '移除'} ${names}。${paused ? '\n该用户未获准私聊，其余授权暂不生效。' : ''}`
}
