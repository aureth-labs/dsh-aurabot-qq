const effortId = (value) => typeof value === 'string' && /^[^\s\p{C}]{1,80}$/u.test(value)

const chatKey = /^(private|group):\d+$/
const modelKey = ({ provider, model }) => JSON.stringify([provider, model])

export function chatEffortFor(cfg, chatId, model) {
  return model ? cfg.chatEfforts?.[chatId]?.[modelKey(model)] : undefined
}

export function normalizeChatEfforts(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const chats = {}
  for (const [chatId, models] of Object.entries(raw)) {
    if (!chatKey.test(chatId) || !models || typeof models !== 'object' || Array.isArray(models)) continue
    const entries = Object.entries(models).filter(([key, value]) => key.startsWith('["') && effortId(value))
    if (entries.length) chats[chatId] = Object.fromEntries(entries)
  }
  return chats
}

function saveEffort(cfg, chatId, model, effort, setConfig) {
  const chatEfforts = { ...cfg.chatEfforts }
  const models = { ...chatEfforts[chatId] }
  const key = modelKey(model)
  if (effort) models[key] = effort
  else delete models[key]
  if (Object.keys(models).length) chatEfforts[chatId] = models
  else delete chatEfforts[chatId]
  setConfig({ ...cfg, chatEfforts })
}

export async function runEffortCommand(arg, msg, { getConfig, setConfig, hub, reasoningFor, canChange = () => true }) {
  const chatId = msg.chatId
  if (!chatKey.test(chatId || '')) return '请在 QQ 私聊或群聊中使用 /effort。'
  const input = arg.trim()
  const target = hub.modelFor(msg)
  if (!target) return '当前聊天没有可用模型，请先在 DSH 选择模型。'
  if (/^(默认|跟随|follow)$/i.test(input)) {
    const cfg = getConfig()
    if (!canChange(cfg)) return '这个命令的授权已撤销。'
    saveEffort(cfg, chatId, target, '', setConfig)
    return `本聊天的 ${target.model} 已恢复跟随面板，发 /effort 查看当前档位。`
  }
  const { provider, model } = target
  const metadata = await reasoningFor(provider, model)
  const cfg = getConfig()
  if (!canChange(cfg)) return '这个命令的授权已撤销。'
  const current = hub.modelFor(msg)
  if (current?.provider !== provider || current?.model !== model) return '当前模型刚刚切换，请重新发送 /effort 查看可选档位。'
  const choices = [...new Set((metadata?.efforts || []).filter(effortId))]
  if (!choices.length) return `当前模型 ${model} 在 DSH 中没有可选的思考档位。`

  if (!input) {
    const effective = choices.includes(current.reasoningEffort) ? current.reasoningEffort : metadata.default
    const saved = chatEffortFor(cfg, chatId, current)
    const mode = !saved ? '跟随面板' : choices.includes(saved) ? '本聊天设置' : '已保存的档位不适用于当前模型'
    const applied = choices.includes(effective) ? effective : '模型默认'
    const options = choices.map((choice, i) => `${i + 1}. ${choice}${choice === effective ? ' ← 当前' : ''}`)
    return [`当前模型 ${model}`, `思考强度 ${applied}（${mode}）`, ...options, '发 /effort 序号 或 /effort 档位名切换，发 /effort 默认恢复跟随。'].join('\n')
  }

  const choice = choices.find((value) => value.toLowerCase() === input.toLowerCase())
    || (/^[1-9]\d*$/.test(input) ? choices[Number(input) - 1] : undefined)
  if (!choice) return `当前模型 ${model} 可选 ${choices.join('、')}。发 /effort 查看序号。`
  saveEffort(cfg, chatId, current, choice, setConfig)
  return `本聊天的 ${model} 已设为 ${choice}，下一句生效。`
}
