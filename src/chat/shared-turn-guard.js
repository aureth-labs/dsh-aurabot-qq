import { isDeepStrictEqual } from 'node:util'

export function isSharedHostContext(message) {
  const source = message?.source
  if (message?.role !== 'user' || !source || !Array.isArray(message.content)) return false
  if (!message.content.length || !message.content.every(block => block?.type === 'text')) return false
  switch (source.kind) {
    case 'agent-instructions':
      return source.form === 'instructions' && Array.isArray(source.changes)
    case 'skill-catalog':
      return source.form === 'catalog' && Array.isArray(source.entries)
    case 'runtime-context':
      return source.form === undefined || (source.form === 'snapshot' && Array.isArray(source.sections))
    case 'time-context':
    case 'tmux-context':
      return source.form === 'snapshot' && Array.isArray(source.sections)
    default:
      return false
  }
}

function matchesStep(messages, turn, first) {
  if (!Array.isArray(messages)) return false
  const direct = messages.filter(message => !isSharedHostContext(message))
  if (!first) return direct.length === 0
  const [message] = direct
  return direct.length === 1 && message?.role === 'user' && message.id === turn.message.id
    && isDeepStrictEqual(message.source, turn.message.source)
    && isDeepStrictEqual(message.content, turn.message.content)
}

// lookup returns undefined for ordinary sessions, null for idle managed sessions,
// or the registered platform turn for a managed session.
export function registerSharedTurnGuard(ctx, { lookup, isAuthorized, onAccepted, onRejected }) {
  return ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next) => {
    const active = lookup(agent)
    if (active === undefined) return next()
    const first = step === 1
    const belongs = active && active.dshTurn === turn
    const valid = () => belongs && !signal.aborted && lookup(agent) === active && isAuthorized(active)
    const reject = () => {
      if (belongs) onRejected(active)
      return { kind: 'reject' }
    }
    if (!valid() || !matchesStep(messages, active, first)) return reject()

    const decision = await next()
    if (decision.kind === 'reject') {
      onRejected(active)
      return decision
    }
    if (!valid() || !matchesStep(decision.messages, active, first)) return reject()
    onAccepted(active)
    return decision
  }, { prepend: true })
}
