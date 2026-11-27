// A generic input rejection does not identify which message or attachment caused it.
// Report repeated failures without deleting history, retrying, or changing providers.
export function isInputRejection(event) {
  const reason = event?.data?.reason
  if (event?.type !== 'turn/end' || reason?.kind !== 'error') return false
  const error = reason.error || reason.failure
  return ['INVALID_REQUEST', 'PI_AI_ERROR'].includes(error?.code) &&
    /\bSensitiveContentDetected\b/.test(error.message || '')
}

export default {
  id: 'input-rejection-notice', name: '连续输入拒绝提醒', version: '1.0.0', api: 1,
  description: '聊天连续被网关拒绝时提醒主人，不删除历史或自动重试',
  setup(api) {
    const states = new WeakMap()
    let stopped = false, notified = 0
    const off = api.dsh.on('session/event', (session, event) => {
      if (stopped || event?.type !== 'turn/end') return
      const chatId = api.core.hub.chatOfSession(session.id)
      if (!/^(?:private|group):\d+$/.test(chatId || '')) return
      const old = states.get(session)
      if (old?.event === event || (old && event.seq != null && old.seq === event.seq)) return
      if (!isInputRejection(event)) { states.delete(session); return }
      const state = old || { count: 0, alerted: false }
      state.count++; state.event = event; state.seq = event.seq
      states.set(session, state)
      if (state.count < 2 || state.alerted) return
      state.alerted = true
      api.log.warn(`${chatId} 连续遭遇输入内容拒绝；旧历史可能影响后续请求，需要检查或重开对话。`)
      // Leave the session-event publication boundary before sending a notice.
      Promise.resolve().then(async () => {
        if (stopped || states.get(session) !== state || api.core.hub.chatOfSession(session.id) !== chatId) return
        const cfg = api.config()
        if (!cfg.enabled || !/^\d+$/.test(String(cfg.ownerQQ || ''))) return
        const label = chatId.startsWith('group:') ? '群 ' : '私聊 '
        await api.sendText(`private:${cfg.ownerQQ}`, `${label}${chatId.split(':')[1]} 连续两轮被网关拒绝（SensitiveContentDetected），后续消息也可能受旧历史影响。可在 Aurabot 中重开这个聊天，旧对话仍可查看；如果新对话也被拒，需要检查当前输入或网关规则。没有自动重试或删除消息。`)
        notified++
      }).catch(() => { if (!stopped) api.log.warn('连续输入拒绝提醒未送达，请在日志中检查故障聊天。') })
    })
    api.onDispose(() => { stopped = true; off() })
    return { status: () => ({ notified }) }
  },
}
