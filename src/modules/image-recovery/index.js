import { randomUUID } from 'node:crypto'

// Recover the NEXT turn after explicit input moderation rejection.
// Never retry the rejected request or delete the original transcript/attachments.
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

// Generic input rejection: withdraw only unanswered input from that failed turn.
// Surface replacement preserves the append-only transcript and attachments.
export function isInputRejection(event) {
  const reason = event?.data?.reason
  const error = reason?.error || reason?.failure
  return event?.type === 'turn/end' && reason?.kind === 'error' &&
    ['INVALID_REQUEST', 'PI_AI_ERROR'].includes(error?.code) &&
    /\bSensitiveContentDetected\b/.test(error.message || '')
}

export function rejectedInputPlan(session, events, failure) {
  if (!isInputRejection(failure)) return null
  const start = events.findLast(e => e.seq < failure.seq && e.type === 'turn/start' && e.data?.turn === failure.data?.turn)
  if (!start) return null
  const turn = events.filter(e => e.seq > start.seq && e.seq <= failure.seq)
  // Once an answer/tool action exists, removing only its inputs would misrepresent
  // what happened. The existing owner notice handles those failures instead.
  if (turn.some(e => ['assistant/message', 'tool/result'].includes(e.type))) return null
  if (turn.some(e => e.type === 'assistant/attempt' && (e.data?.stream || []).some(item => {
    const c = item.chunk || item
    return ['text-delta', 'reasoning-delta', 'tool-call-start', 'tool-call-delta', 'block-start', 'block-end'].includes(c.type)
  }))) return null
  const current = new Set(session.surface.nodes)
  const inputs = turn.filter(e => e.type === 'user/message' && current.has(e.seq))
  if (!inputs.some(e => ['aurabot', 'user'].includes(e.data?.source?.kind))) return null
  const wanted = new Set(inputs.map(e => e.seq)), ranges = []
  let range
  for (const seq of session.surface.nodes) {
    if (!wanted.has(seq)) { range = null; continue }
    if (!range) { range = []; ranges.push(range) }
    range.push(seq)
  }
  return { inputs, ranges }
}

export async function withdrawRejectedInput(api, session, events, failure) {
  const plan = rejectedInputPlan(session, events, failure)
  if (!plan) return 0
  // No await between planning and atomic append: a newly admitted message cannot
  // slip into the replacement range. No system prompt or later input is shadowed.
  session.append(plan.ranges.map(seqs => ['user/message', {
    id: randomUUID(), role: 'user', source: { kind: 'aurabot-input-recovery' },
    content: [{ type: 'text', text: '（之前一轮输入被服务端拒绝，已退出后续上下文；该轮没有回复。）' }],
  }, { surfaceOp: { op: 'replace', startSeq: seqs[0], endSeq: seqs.at(-1) }, sourceEventSeqs: seqs }]))
  api.core.hub.discardRejectedInputs?.(session.id, plan.inputs)
  await api.dsh.sessions.flush(session)
  api.log.info('被拒的本轮输入已退出后续上下文；原始记录保留，本轮不重试。')
  return plan.inputs.length
}

function inputRecovery(api, query) {
  let stopped = false, withdrawn = 0
  const pending = new Map(), checked = new WeakSet()
  const owned = session => /^(?:private|group):/.test(api.core.hub.chatOfSession(session.id) || '')
  function schedule(session, failure) {
    if (stopped || !owned(session)) return Promise.resolve()
    if (!failure && checked.has(session)) return pending.get(session.id) || Promise.resolve()
    checked.add(session)
    const previous = pending.get(session.id) || Promise.resolve()
    const run = previous.then(async () => {
      if (stopped || !owned(session)) return
      const lease = await query.observeSession(session.id, { projectionMode: 'none' })
      try {
        if (stopped || !owned(session) || api.dsh.sessions.get(session.id) !== session) return
        const failures = failure ? [failure] : []
        // Cold resume: process the trailing uninterrupted rejection streak only.
        // Successful or unrelated failed turns form a firm boundary.
        if (!failure) for (let i = lease.events.length - 1; i >= 0; i--) {
          const e = lease.events[i]
          if (e.type !== 'turn/end') continue
          if (!isInputRejection(e)) break
          failures.unshift(e)
        }
        for (const e of failures) withdrawn += await withdrawRejectedInput(api, session, lease.events, e)
      } finally { lease[Symbol.dispose]() }
    }).catch(() => { if (!stopped) api.log.warn('被拒输入未能退出上下文；请检查会话，未自动重试。') })
    pending.set(session.id, run)
    run.finally(() => { if (pending.get(session.id) === run) pending.delete(session.id) })
    return run
  }
  // Await recovery before the failed turn releases QQ's queued messages.
  const offRequest = api.dsh.on('agent/request-error', async (info, next) => {
    const action = await next()
    const session = info.agent?.session
    if (session && action?.kind !== 'retry') {
      const failure = { type: 'turn/end', seq: session.seq, data: { turn: info.turn, reason: { kind: 'error', error: info.failure } } }
      if (isInputRejection(failure)) await schedule(session, failure)
    }
    return action
  }, { global: true })
  const offEvent = api.dsh.on('session/event',(session, event) => {
    if (isInputRejection(event)) schedule(session, event)
  })
  // Includes cold resumes and pending work from a live error. Runs before the
  // next request is assembled, even if a user types directly in DSH.
  const offPrepare = api.dsh.on('agent/pre-step',async (info, next) => {
    if (info.agent?.session) await schedule(info.agent.session)
    return next()
  }, { global: true })
  api.onDispose(() => { stopped = true; offRequest(); offEvent(); offPrepare() })
  for (const entry of Object.values(api.core.hub.sessions())) {
    const session = api.dsh.sessions.get(entry.sessionId)
    if (session) schedule(session)
  }
  return { status: () => ({ withdrawn, pending: pending.size }), recover: schedule }
}

export default {
  id: 'image-recovery', name: '图片上下文恢复', version: '1.1.0', api: 1,
  description: '图片被拒时保留文字；整轮输入被拒时保留原记录，让新消息继续对话',
  setup(api) {
    const query = api.dsh.get('sessionQuery')
    if (typeof query?.observeSession !== 'function') {
      api.log.warn('当前 DSH 缺少会话观察接口，图片上下文恢复未启用。')
      return {}
    }
    const inputs = inputRecovery(api, query)
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
    return { status: () => ({ recovered, omitted, pending: pending.size, withdrawn: inputs.status().withdrawn }), recoverInput: inputs.recover }
  },
}
