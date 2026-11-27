// 确定性主人私聊入口；配置和自然语言工具共用规划器，不通过 LLM 执行。
import { randomInt } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { isOwner, GROUP_RESPONSE_LABELS } from './access.js'
import { DEFAULT_GROUP_POLICY } from './group-policy.js'
import { changePermissions } from './permission-policy.js'
import { planGroupSettings, readSettings } from '../modules/contacts/group-settings.js'

const HELP = [
  '群设置｜仅主人私聊，直接执行，不经过模型',
  '',
  '看设置',
  '/群设置 查看 全部',
  '/群设置 查看 123456789',
  '',
  '改一个群（没写的项不变）',
  '/群设置 修改 123456789 主动 关',
  '主动＝没人叫时插话；窗口＝聊起来后继续接话。',
  '可改：主动、窗口、旁听、白名单；后面填 开 或 关。',
  '/群设置 修改 123456789 模式 仅模块',
  '模式可填：不响应群消息、仅模块、允许AI聊天。仅模块时 @ 也不触发 AI。',
  '',
  '批量改（先预览，再确认）',
  '/群设置 修改 123456789,987654321 旁听 开',
  '群号也可填 全部；放弃用 /群设置 取消。',
  '',
  '/群设置 恢复 123456789：恢复该群全部接话默认，响应模式、白名单和旁听不变。',
  '旁听只额外记录非白名单群的新文字，整理可能产生费用，不删旧记忆。',
  '指令总开关：面板 → 聊天 → 主人私聊：群设置指令。',
].join('\n')
const FIELDS = { 主动: 'proactive', 窗口: 'engaged', 旁听: 'passive_memory', 白名单: 'whitelist', 模式: 'mode' }
const MAX_BATCH = 100, PAGE_SIZE = 10, TTL = 2 * 60_000
// 每个宿主只保留一份待确认操作；没有定时器，不写会话历史或持久化任务。
const sessions = new WeakMap()

export function parseGroupSettingsCommand(arg) {
  const words = String(arg || '').trim().replace(/\s*[,，、]\s*/g, ',').split(/\s+/).filter(Boolean)
  const [action, target, ...rest] = words
  if (!action || (['帮助', '用法', '查看用法'].includes(action) && words.length === 1)) return { action: 'help' }
  if (action === '取消' && words.length === 1) return { action: 'cancel' }
  if (action === '确认' && words.length === 2 && /^\d{6}$/.test(target)) return { action: 'confirm', code: target }
  if (!['查看', '修改', '恢复'].includes(action) || !target) return { error: '格式不对，未修改。发送 /群设置 可查看用法。' }
  if (target !== '全部' && !/^[1-9]\d{4,11}(,[1-9]\d{4,11})*$/.test(target)) return { error: '群号须为 5～12 位数字；多个用逗号隔开，或填 全部。未修改。' }
  const ids = target === '全部' ? null : [...new Set(target.split(','))]
  if (ids?.length > MAX_BATCH) return { error: '一次最多指定 100 个群，请分批。未修改。' }
  if (action === '查看') {
    if (rest.length > 1 || (rest.length && !/^[1-9]\d{0,5}$/.test(rest[0]))) return { error: '查看格式：/群设置 查看 全部，或 /群设置 查看 群号；翻页在末尾加页码。' }
    return { action: 'get', ids, target, page: Number(rest[0] || 1) }
  }
  if (action === '恢复') return rest.length ? { error: '恢复格式：/群设置 恢复 群号。不能同时修改其它项。' } : { action: 'reset', ids, target }
  if (!rest.length || rest.length % 2) return { error: '修改格式：/群设置 修改 群号 主动 关 窗口 开。每项都要明确填 开 或 关。未修改。' }
  const changes = {}
  for (let i = 0; i < rest.length; i += 2) {
    const key = Object.hasOwn(FIELDS, rest[i]) ? FIELDS[rest[i]] : null
    if (key === 'mode' && !Object.hasOwn(changes, key)) {
      const modes = { 不响应群消息: 'off', 仅模块: 'modules', 允许AI聊天: 'chat' }
      if (!Object.hasOwn(modes, rest[i + 1])) return { error: '模式请填 不响应群消息、仅模块 或 允许AI聊天。未修改。' }
      changes.mode = modes[rest[i + 1]]; continue
    }
    if (!key || Object.hasOwn(changes, key) || !['开', '关'].includes(rest[i + 1])) return { error: '支持 模式（不响应群消息/仅模块/允许AI聊天）；主动、窗口、旁听、白名单，每项只写一次，后面填 开 或 关。未修改。' }
    changes[key] = rest[i + 1] === '开'
  }
  if (Object.hasOwn(changes, 'mode') && Object.hasOwn(changes, 'whitelist')) return { error: '模式已包含白名单设置，请不要同时填写白名单。未修改。' }
  return { action: 'set', ids, target, changes }
}

function plan(cfg, request, ids) {
  let next = cfg
  for (const id of ids) {
    const { whitelist, ...toggles } = request.changes || {}
    if (request.action === 'reset' || Object.keys(toggles).length) {
      const r = planGroupSettings(next, { action: request.action, group_id: id, ...toggles })
      if (!r.ok) throw new Error(r.message)
      next = r.next
    }
    if (typeof whitelist === 'boolean') {
      const r = changePermissions(next, { id, kind: 'group', changes: { chat: whitelist } })
      if (!r.ok) throw new Error(r.message)
      next = r.config
    }
  }
  return { next, changed: !isDeepStrictEqual(cfg, next) }
}

// 只关心会影响这批操作的设置；别的群或模型设置变化不造成冲突，也不会被覆盖。
function baseline(cfg, ids) {
  const { overrides, moduleOnlyGroups, ...defaults } = cfg.group
  return structuredClone({ owner: cfg.ownerQQ, defaults, enabled: cfg.enabled, dryRun: cfg.dryRun, debug: cfg.debug,
    memoryEnabled: cfg.memory.enabled,
    groups: ids.map(id => ({ id, moduleOnly: (moduleOnlyGroups || []).includes(id), override: overrides[id], allowed: cfg.allow.groups.includes(id), passive: cfg.memory.passiveGroups.includes(id) })) })
}

function changeText(request) {
  return request.action === 'reset' ? '恢复全部接话默认（包括概率和次数等单独设置），白名单和旁听不变'
    : Object.entries(FIELDS).filter(([, key]) => Object.hasOwn(request.changes, key)).map(([label, key]) => `${label} ${key === 'mode' ? GROUP_RESPONSE_LABELS[request.changes[key]] : request.changes[key] ? '开' : '关'}`).join('\n') + '\n其余设置不变。'
}
function consequences(request, cfg, ids) {
  const lines = []
  if (request.changes?.proactive) {
    const count = ids.filter(id => readSettings(cfg, id).state.interject_chance === 0).length
    if (count) lines.push(`${count} 个群的主动概率为 0，将恢复为 ${Math.round((cfg.group.interjectChance || DEFAULT_GROUP_POLICY.interjectChance) * 100)}%；未指定的窗口开关保持原样。`)
  }
  if (request.changes?.mode) lines.push(request.changes.mode === 'off' ? '将移出白名单；若在旁听名单中，仍可记录新文字。' : '将加入白名单，记忆按白名单群规则；模块仍受自身开关和权限限制。')
  if (Object.hasOwn(request.changes || {}, 'passive_memory') || Object.hasOwn(request.changes || {}, 'whitelist')) lines.push('白名单群不受旁听名单控制；旁听只记录非白名单群新文字，记忆整理可能产生费用，不删除旧记忆。')
  lines.push('接话只在「允许 AI 聊天」时生效；总开关、暂停、静默和次数限制仍有效。')
  return lines.join('\n')
}
const on = value => value ? '开' : '关'
function memorySummary(s) {
  if (!s.memory_enabled) return '关（记忆总开关关闭）'
  return s.memory_scope === 'whitelist' ? '开（白名单群规则）' : s.memory_scope === 'passive' ? '开（旁听新文字）' : '总开关开，未开旁听'
}
function chatSummary(cfg, s) {
  const reasons = []
  if (!s.chat_whitelisted) reasons.push('不在白名单')
  else if (s.response_mode === 'modules') reasons.push('仅模块，AI 不接话')
  if (!cfg.enabled) reasons.push('总开关关闭')
  else if (cfg.debug) reasons.push('调试模式')
  else if (cfg.dryRun) reasons.push('试运行')
  if (s.reply_paused) reasons.push('已暂停')
  return reasons.length ? '暂不回复（' + reasons.join('、') + '）' : '按规则回复'
}
function groupReport(cfg, report, { name = '', brief = false } = {}) {
  const s = report.state
  const title = name ? `${name}（${s.group_id}）` : `群 ${s.group_id}`
  const chance = `基础 ${Math.round(s.interject_chance * 100)}%`
  const active = `${on(s.proactive)}（${chance}${s.proactive && s.proactive_max_per_hour === 0 ? '，次数上限为 0，暂不插话' : ''}）`
  const window = `${on(s.engaged)}${s.engaged && s.engaged_max === 0 ? '（次数上限为 0，暂不接话）' : ''}`
  const passive = s.passive_memory ? '已加入' : '未加入'
  if (brief) return [
    title,
    `模式：${GROUP_RESPONSE_LABELS[s.response_mode]}`,
    `白名单：${s.chat_whitelisted ? '在' : '不在'}；被叫到：${chatSummary(cfg, s)}`,
    `主动：${active}；窗口：${window}`,
    `记忆：${memorySummary(s)}；旁听名单：${passive}`,
    s.in_quiet_hours && s.chat_whitelisted && (s.proactive || s.engaged) ? '当前静默时段：不主动插话或窗口接话。' : '',
  ].filter(Boolean).join('\n')
  const quiet = s.quiet_hours[0] === s.quiet_hours[1] ? '未设置' : s.quiet_hours.map(h => String(h).padStart(2, '0') + ':00').join('–')
  // 只去掉已在白名单/记录范围中说明的重复文字；实际限制和恢复方式保留。
  const notices = s.notices.filter(n => !n.startsWith('不在聊天白名单') && !n.startsWith('白名单群的记忆') && !n.startsWith('没有额外旁听'))
  return [title, '',
    `群响应模式：${GROUP_RESPONSE_LABELS[s.response_mode]}`,
    `聊天白名单：${s.chat_whitelisted ? '在' : '不在'}`,
    `被叫到：${chatSummary(cfg, s)}`,
    `主动插话：${active}`,
    `窗口接话：${window}`,
    '',
    `记忆：${memorySummary(s)}`,
    `旁听名单：${passive}${s.chat_whitelisted ? '（对白名单群不生效）' : ''}`,
    '',
    `接话规则：${s.follows_defaults ? '跟随全局' : '此群单独设置'}`,
    `主动：每小时最多 ${s.proactive_max_per_hour} 次，间隔至少 ${s.proactive_cooldown_seconds} 秒`,
    `窗口：最近 3 分钟说过话时，最多连续 ${s.engaged_max} 次`,
    `静默时段：${quiet}${quiet === '未设置' ? '' : '（只限制主动和窗口）'}`,
    ...(!s.chat_whitelisted ? ['未加入白名单，以上接话设置暂不生效。'] : []),
    ...(notices.length ? ['', ...notices.map(n => '提醒：' + n)] : []),
  ].join('\n')
}
function groupIds(ids) {
  const rows = []
  for (let i = 0; i < ids.length; i += 5) rows.push(ids.slice(i, i + 5).join('、'))
  return rows.join('\n')
}

export async function runGroupSettingsCommand(arg, msg, deps) {
  const { getConfig, setConfig, onebot, mutes } = deps
  const allowed = () => msg?.kind === 'private' && isOwner(getConfig(), msg.userId) && (deps.ownerStillCurrent?.() ?? true)
  if (!allowed()) return '群设置指令只能由主人私聊使用。'
  let session = sessions.get(getConfig)
  if (!session) { session = { serial: 0, pending: null }; sessions.set(getConfig, session) }
  const serial = ++session.serial
  const enabled = () => getConfig().group?.privateCommandsEnabled !== false
  if (!enabled()) { session.pending = null; return '群设置指令已关闭。请在面板「聊天 → 主人私聊：群设置指令」打开；未修改设置。' }
  const request = parseGroupSettingsCommand(arg)
  if (request.error) return request.error
  if (request.action === 'help') return HELP
  if (request.action === 'cancel') { session.pending = null; return '已取消待确认的群设置修改。' }
  const stillCurrent = () => serial === session.serial && allowed() && enabled()
  const report = (cfg, id) => readSettings(cfg, id, mutes?.until?.('group:' + id))
  try {
    if (request.action === 'confirm') {
      const pending = session.pending
      if (!pending || pending.expires <= Date.now()) { session.pending = null; return '没有有效的待确认修改，或已超过 2 分钟。请重新发修改指令。' }
      if (pending.code !== request.code) return '确认码不匹配，未修改。请核对预览消息，或发 /群设置 取消。'
      session.pending = null // 一次性确认；失败也要先查设置，再重新发起，不能重放。
      const current = getConfig()
      if (!isDeepStrictEqual(pending.base, baseline(current, pending.ids))) return '预览后相关设置已变化，未执行旧操作。请重新发修改指令。'
      if (current.dryRun || current.debug) return '试运行或调试中，未保存。'
      const result = plan(current, pending.request, pending.ids)
      if (result.changed) setConfig(result.next)
      return `已${result.changed ? '保存' : '检查，设置没变'} ${pending.ids.length} 个群\n${groupIds(pending.ids)}\n\n${changeText(pending.request)}\n\n${consequences(pending.request, current, pending.ids)}\n可用 /群设置 查看 群号 核对。`
    }
    if (request.action !== 'get') session.pending = null
    const names = new Map()
    let ids = request.ids
    if (!ids) {
      let rows
      try { rows = await onebot.call('get_group_list', {}, { timeoutMs: 10000, retries: 0 }) }
      catch { return '暂时读不到所在群列表，本次未完成，未修改设置。稍后重试，或直接指定群号。' }
      if (!stillCurrent()) return '查询期间权限、开关或当前指令已变化，本次未继续。'
      if (!Array.isArray(rows) || rows.some(r => !r || !/^[1-9]\d{4,11}$/.test(String(r.group_id)))) return '群列表不完整，本次未完成，未修改设置。请稍后重试。'
      for (const row of rows) names.set(String(row.group_id), String(row.group_name || '').replace(/\s+/g, ' ').slice(0, 32))
      ids = [...new Set(rows.map(r => String(r.group_id)))].sort((a, b) => Number(a) - Number(b))
    }
    const cfg = getConfig()
    if (!ids.length) return '机器人当前没有加入任何群；未修改设置。'
    if (request.action === 'get') {
      const pages = Math.ceil(ids.length / PAGE_SIZE)
      if (request.page > pages) return `没有这一页，当前共 ${pages} 页。请重新查看。`
      if (ids.length === 1) return groupReport(cfg, report(cfg, ids[0]), { name: names.get(ids[0]) })
      const slice = ids.slice((request.page - 1) * PAGE_SIZE, request.page * PAGE_SIZE)
      return [`共 ${ids.length} 个群，第 ${request.page}/${pages} 页。`,
        ...slice.map(id => groupReport(cfg, report(cfg, id), { name: names.get(id), brief: true })),
        '非白名单群不接话；白名单群的记忆不受旁听名单控制。',
        !cfg.enabled ? '总开关关闭，不发消息也不新增旁听。' : cfg.debug ? '调试中，不发消息也不新增旁听。' : cfg.dryRun ? '试运行，不发消息但仍可能记录记忆。' : '',
        request.page < pages ? `下一页：/群设置 查看 ${request.target} ${request.page + 1}` : '已到末页。'].filter(Boolean).join('\n\n')
    }
    if (ids.length > MAX_BATCH) return '一次最多修改 100 个群，请用逗号分隔群号分批操作；本次未修改。'
    const result = plan(cfg, request, ids)
    if (!result.changed) return '设置没变。\n' + (ids.length === 1 ? groupReport(cfg, report(cfg, ids[0])) : changeText(request))
    const summary = `${ids.length} 个群\n${groupIds(ids)}\n\n${changeText(request)}\n\n${consequences(request, cfg, ids)}`
    if (cfg.dryRun || cfg.debug) return '试运行或调试：仅预览，未保存。\n' + summary
    if (ids.length > 1 || request.target === '全部') {
      const code = String(randomInt(100000, 1000000))
      session.pending = { code, ids, request, expires: Date.now() + TTL, base: baseline(cfg, ids) }
      return `待确认，尚未修改。\n${summary}\n仅修改以上群号，不包含之后新加入的群。\n2 分钟内发送 /群设置 确认 ${code}\n放弃请发 /群设置 取消；新的修改指令会替换这次预览。`
    }
    setConfig(result.next)
    return '已保存。\n\n' + groupReport(getConfig(), report(getConfig(), ids[0]))
  } catch (error) {
    deps.log?.warn?.('群设置指令未完成：', error?.message)
    return '群设置操作未完成，保存结果未确认。请先用 /群设置 查看 群号 核对后再重试。'
  }
}
