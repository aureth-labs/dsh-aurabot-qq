import { resolveChatModel } from './chat-model.js'

const COMMAND_GRANTS = {
  help: '查看自己可用的命令',
  status: '查看机器人运行状态',
  mood: '查看机器人心情',
  reset: '归档自己的私聊会话，下一条消息开新会话',
  silent: '暂停自己的私聊回复',
  active: '恢复自己的私聊回复',
  model: '查看模型列表并切换自己的私聊模型，可能增加用量',
  sing: '在自己的私聊使用翻唱服务',
}

export const DELEGATED_COMMANDS = Object.keys(COMMAND_GRANTS)

export function delegatedCommandCatalog(extra = []) {
  return [
    ...DELEGATED_COMMANDS.map((key) => ({ key, label: `/${key}`, description: COMMAND_GRANTS[key], group: '命令' })),
    ...extra.flatMap((cmd) => {
      const key = delegatedCommandKey({ name: cmd.name, ext: cmd })
      return key ? [{ key, label: `/${cmd.name} · ${cmd.module}`, description: cmd.desc || '执行模块命令', group: '扩展命令' }] : []
    }),
  ]
}

export function delegatedCommandKey(cmd) {
  if (!cmd) return ''
  if (!cmd.ext) return DELEGATED_COMMANDS.includes(cmd.name) ? cmd.name : ''
  if (cmd.ext.delegatable !== true || cmd.ext.sensitive === true) return ''
  const moduleId = String(cmd.ext.module || '')
  const name = String(cmd.name || '')
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(moduleId) || !/^[A-Za-z0-9一-龥_-]+$/.test(name)) return ''
  return `ext:${moduleId}:${name}`
}

export function isDelegatedCommandKey(key) {
  return DELEGATED_COMMANDS.includes(key) || /^ext:[a-z][a-z0-9-]{1,39}:[A-Za-z0-9一-龥_-]+$/.test(key)
}

export function canUseDelegatedCommand(cfg, msg, key) {
  if (msg?.kind !== 'private' || !isDelegatedCommandKey(key)) return false
  const userId = String(msg.userId || '')
  return Boolean(userId && (cfg.allow?.private || []).map(String).includes(userId)
    && (cfg.commandAllow?.[key] || []).map(String).includes(userId))
}

export async function runPersonalModelCommand(cmd, msg, deps) {
  const list = await deps.listModels()
  const cfg = deps.getConfig()
  if (!canUseDelegatedCommand(cfg, msg, cmd.name)) return '这个命令的授权已撤销'
  const chat = { kind: 'private', userId: String(msg.userId) }
  const selected = resolveChatModel(cfg, chat, list)
  const effective = selected || deps.defaultModel()
  const label = (m) => m.name && m.name !== m.model ? `${m.name}（${m.model}）` : m.model
  if (!cmd.arg) {
    const head = `当前私聊模型：${effective?.model || '未配置'}`
    return head + (list.length ? '\n' + list.slice(0, 20).map((m, i) => `${i + 1}. ${label(m)}`).join('\n') : '\n（拿不到模型列表）') + '\n发 /model 序号 切换，/model 默认 恢复跟随'
  }

  const current = cfg
  const privates = { ...current.chatModels.privates }
  const userId = String(msg.userId)
  if (/^(默认|default|auto|跟随)$/i.test(cmd.arg)) {
    delete privates[userId]
    deps.setConfig({ ...current, chatModels: { ...current.chatModels, privates } })
    return '已恢复跟随默认模型和思考强度，下一句起生效'
  }
  const n = Number.parseInt(cmd.arg, 10)
  const q = cmd.arg.toLowerCase()
  const hit = String(n) === cmd.arg ? list[n - 1]
    : list.find((m) => m.model.toLowerCase() === q || String(m.name || '').toLowerCase() === q)
      || list.find((m) => m.model.toLowerCase().includes(q) || String(m.name || '').toLowerCase().includes(q))
  if (!hit) return `没找到「${cmd.arg}」这个模型，发 /model 看列表`
  privates[userId] = { provider: hit.provider, model: hit.model, reasoningEffort: privates[userId]?.reasoningEffort || '' }
  deps.setConfig({ ...current, chatModels: { ...current.chatModels, privates } })
  return `当前私聊已切换到 ${label(hit)}，下一句起生效`
}
