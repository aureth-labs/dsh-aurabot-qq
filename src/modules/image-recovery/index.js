// Recover the NEXT turn after an explicit image-input moderation rejection.
// Never retry the rejected request, delete attachments, or reset text history.
export function isImageRejection(event) {
  const reason = event?.data?.reason
  if (event?.type !== 'turn/end' || reason?.kind !== 'error') return false
  const error = reason.error || reason.failure
  if (error?.code !== 'PI_AI_ERROR') return false
  const message = error.message || ''
  // Match known input-image errors, never generic "blocked"/"sensitive":
  // those may describe text moderation or an account restriction instead.
  return /\bthe content of image_url\.url field is unsafe\b/i.test(message) ||
    (/\binput new_sensitive\b/i.test(message) &&
      /\bimage is sensitive\b/i.test(message) && /\(1026\)/.test(message))
}

export function lastImageRejection(events) {
  // A later start/completion means this is no longer an idle failed session.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'turn/start') return null
    if (e.type === 'turn/end') return isImageRejection(e) ? e : null
  }
  return null
}

export function imageTargets(session, events, cutoff) {
  const current = new Set(session.surface.nodes)
  const targets = []
  for (const event of events) {
    if (event.seq > cutoff || !current.has(event.seq) || !['user/message', 'tool/result'].includes(event.type)) continue
    // Read the CURRENT projection, not stale raw content: another recovery or
    // native image-budget compaction may already have offloaded occurrences.
    const message = session.surface.deriveEventMessage(event)
    const imageIndexes = []
    let imageIndex = 0
    for (const block of message?.content || []) {
      if (block.type !== 'image') continue
      if (block.offloaded !== true) imageIndexes.push(imageIndex)
      imageIndex++
    }
    if (imageIndexes.length) targets.push({ seq: event.seq, imageIndexes })
  }
  return targets
}

export default {
  id: 'image-recovery', name: '图片上下文恢复', version: '1.0.1', api: 1,
  description: '旧图片被上游拒绝后保留文字历史，避免后续聊天一直无回复',
  setup(api) {
    const query = api.dsh.get('sessionQuery')
    if (typeof query?.observeSession !== 'function') {
      api.log.warn('当前 DSH 缺少会话观察接口，图片上下文恢复未启用。')
      return {}
    }
    let stopped = false, recovered = 0, omitted = 0
    const pending = new Map()
    const owned = session => /^(?:private|group):/.test(api.core.hub.chatOfSession(session.id) || '')
    async function recover(session, job) {
      // observeSession yields beyond session/event's publication boundary;
      // appending directly from that callback would be rejected as reentrant.
      const lease = await query.observeSession(session.id, { projectionMode: 'none' })
      try {
        if (stopped || !owned(session) || api.dsh.sessions.get(session.id) !== session) return
        const failure = job.event || lastImageRejection(lease.events)
        if (!failure || !isImageRejection(failure)) return
        const targets = imageTargets(session, lease.events, failure.seq)
        if (!targets.length) return
        session.append('image/offload', { targets })
        const count = targets.reduce((n, t) => n + t.imageIndexes.length, 0)
        recovered++; omitted += count
        api.log.info(`图片输入被拒绝，已让 ${count} 张历史图片退出后续请求；文字与原图保留，本轮不重试。`)
        await api.dsh.sessions.flush(session)
      } finally { lease[Symbol.dispose]() }
    }
    function schedule(session, event) {
      if (stopped || !owned(session)) return
      const existing = pending.get(session.id)
      if (existing) { if (event) existing.event = event; return }
      const job = { event }
      pending.set(session.id, job)
      const run = async () => {
        let seen
        do {
          seen = job.event
          await recover(session, job)
        } while (!stopped && job.event !== seen)
      }
      run().catch(() => {
        if (!stopped) api.log.warn('历史图片恢复未完成；保留原会话，未重发请求。')
      }).finally(() => pending.delete(session.id))
    }
    const off = api.dsh.on('session/event', (session, event) => {
      if (isImageRejection(event)) schedule(session, event)
    })
    // Cold resumes have no new error event yet. Inspect once at attachment;
    // only the last finished image-rejected turn qualifies for recovery.
    const offCreated = api.dsh.on('session/created', session => schedule(session))
    api.onDispose(() => { stopped = true; off(); offCreated() })
    for (const [chatId, entry] of Object.entries(api.core.hub.sessions())) {
      if (!/^(?:private|group):/.test(chatId)) continue
      const session = api.dsh.sessions.get(entry.sessionId)
      if (session) schedule(session)
    }
    return { status: () => ({ recovered, omitted, pending: pending.size }) }
  },
}
