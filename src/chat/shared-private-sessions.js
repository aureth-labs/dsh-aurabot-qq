import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { isSharedHostContext } from './shared-turn-guard.js'
import { sameChat } from '../gateway/address.js'

export const SHARED_MODES = Object.freeze(['live', 'debug'])

const newMode = (historyPolicy = 'inherit', generation = 1) => ({
  generation, historyPolicy, state: 'uninitialized',
})

function initialShared() {
  return {
    ownerPersonId: '',
    ownerAuthorizationRevision: '',
    primaryBinding: null,
    enabled: false,
    mode: 'live',
    routingRevision: 0,
    sessions: { live: newMode(), debug: newMode() },
    retiredSessions: {},
    pendingOperations: {},
  }
}

function retire(shared, mode, sessionId, generation) {
  if (!sessionId) return
  shared.retiredSessions[sessionId] ??= {
    ownerPersonId: shared.ownerPersonId, mode, generation, archiveState: 'pending',
  }
}

function retireMode(shared, mode, historyPolicy) {
  const branch = shared.sessions[mode]
  retire(shared, mode, branch.sessionId, branch.generation)
  shared.sessions[mode] = newMode(historyPolicy, branch.generation + 1)
}

export function selectSharedBase(chats, scope) {
  const chatId = Object.hasOwn(chats, scope.binding.chatId) ? scope.binding.chatId
    : Object.keys(chats).find(key => sameChat(key, scope.binding.chatId))
  const entry = chatId && chats[chatId]
  if (!entry) return { reason: 'source-missing' }
  const sessionId = entry.sessions?.[scope.mode] ?? ((entry.mode || 'live') === scope.mode ? entry.sessionId : '')
  if (!sessionId) return { reason: 'source-missing' }
  const legacy = { sessionId, chatId, title: entry.title }
  const proof = entry.sessionOwners?.[scope.mode]
  if (!proof && entry.level === scope.level && entry.preset === scope.preset) {
    return { reason: 'source-unverified', legacy }
  }
  if (proof?.sessionId === sessionId && (proof.unverified || proof.ownerPersonId !== scope.ownerPersonId
    || proof.ownerAuthorizationRevision !== scope.ownerAuthorizationRevision)) return { reason: 'source-authorization-changed' }
  if (proof?.sessionId !== sessionId || proof.ownerPersonId !== scope.ownerPersonId
    || proof.ownerAuthorizationRevision !== scope.ownerAuthorizationRevision
    || entry.level !== scope.level || entry.preset !== scope.preset) return { reason: 'source-unverified' }
  return proof.legacyPrefix ? { sessionId, legacyPrefix: proof.legacyPrefix, legacy } : { sessionId }
}

export function sharedRetiredAuditPage(retired, cursor, recentlyRetired) {
  const priority = [...recentlyRetired].slice(0, 8)
  const priorityIds = new Set(priority)
  const capacity = 16 - priority.length
  const batch = Object.keys(retired).sort().filter(id => id > cursor && !priorityIds.has(id)).slice(0, capacity)
  return { ids: [...priority, ...batch], nextCursor: batch.length === capacity ? batch.at(-1) : '' }
}

// The checkpoint covers child-owned events. On restore, an unverified model
// step or history mutation requires explicit recovery instead of reuse.
export function sharedQuietHistory(session, afterSeq = null) {
  const end = Number(session?.seq)
  if (!Number.isSafeInteger(end) || end < 0 || typeof session.isOwnSeq !== 'function'
    || typeof session.eventAt !== 'function') return null
  if (afterSeq !== null && (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || afterSeq >= end)) return null
  const first = afterSeq === null ? Number(session.inheritedEventCount) : afterSeq + 1
  if (!Number.isSafeInteger(first) || first < 0 || first > end) return null
  let openTurn = false
  for (let seq = first; seq < end; seq++) {
    if (!session.isOwnSeq(seq)) return null
    const event = session.eventAt(seq)
    switch (event?.type) {
      case 'session/end-seed':
      case 'session/title':
      case 'model/selection':
      case 'agent/inbox/spliced':
        break
      case 'user/message':
        if (!isSharedHostContext(event.data)) return null
        break
      case 'turn/start':
        if (openTurn) return null
        openTurn = true
        break
      case 'turn/end':
        // Completion alone does not attest to platform ingress after a restart.
        if (!openTurn || event.data?.reason?.kind !== 'blocked') return null
        openTurn = false
        break
      default:
        return null
    }
  }
  return openTurn ? null : { seq: end ? end - 1 : null }
}

// read and write must use the same synchronous persistence as the ordinary session map.
export function createSharedPrivateSessions({ read, write, fork, create, restore, recover, verifyCandidate, rename, onRetired, log }) {
  const creating = new Map()
  const failing = reason => ({ ok: false, reason })
  const readShared = () => read().multiPrivate || initialShared()
  const update = change => {
    const map = read()
    const shared = map.multiPrivate || initialShared()
    const previous = shared.retiredSessions
    // Clone only the index so new retirements can be dispatched after the map is saved.
    shared.retiredSessions = { ...previous }
    if (change(shared) !== false) {
      write({ ...map, multiPrivate: shared })
      if (onRetired) {
        for (const sid of Object.keys(shared.retiredSessions)) {
          if (!Object.hasOwn(previous, sid)) onRetired(sid)
        }
      }
    }
    return shared
  }

  function sync(scope) {
    return update(shared => {
      const { ownerPersonId, ownerAuthorizationRevision, binding, enabled, mode, level, preset } = scope
      const changedOwner = shared.ownerPersonId !== ownerPersonId
        || shared.ownerAuthorizationRevision !== ownerAuthorizationRevision
        || !isDeepStrictEqual(shared.primaryBinding, binding)
      const changedPolicy = shared.level !== level || shared.preset !== preset
      if (!changedOwner && !changedPolicy && shared.enabled === enabled && shared.mode === mode) return false
      if (changedOwner || changedPolicy) {
        for (const key of SHARED_MODES) {
          retireMode(shared, key, shared.sessions[key].historyPolicy)
        }
      }
      Object.assign(shared, { ownerPersonId, ownerAuthorizationRevision, primaryBinding: binding, enabled, mode, level, preset })
      shared.routingRevision++
      for (const key of SHARED_MODES) retireIdlePending(shared, key)
    })
  }

  function retireIdlePending(shared, mode) {
    const pending = shared.pendingOperations[mode]
    if (!pending?.sessionId || creating.has(mode)) return
    shared.retiredSessions[pending.sessionId] ??= {
      ownerPersonId: pending.ownerPersonId, mode, generation: pending.generation, archiveState: 'pending',
    }
    delete shared.pendingOperations[mode]
  }

  function reset(modes, policy = 'empty') {
    return update(shared => {
      for (const mode of modes) {
        retireMode(shared, mode, policy)
        retireIdlePending(shared, mode)
      }
      shared.routingRevision++
    })
  }

  function owns(sessionId) {
    if (!sessionId) return false
    const data = readShared()
    return Object.hasOwn(data.retiredSessions, sessionId)
      || SHARED_MODES.some(mode => data.sessions[mode].sessionId === sessionId
        || data.pendingOperations[mode]?.sessionId === sessionId)
  }

  async function ensureMode(scope, snapshot) {
    const { mode } = scope
    const branch = snapshot.sessions[mode]
    const current = data => data.enabled && data.mode === mode && data.routingRevision === snapshot.routingRevision
      && data.sessions[mode].generation === branch.generation
    const pending = snapshot.pendingOperations[mode]
    if (pending) {
      if (!pending.sessionId) return failing('pending-operation')
      if (pending.generation !== branch.generation || pending.routingRevision !== snapshot.routingRevision) {
        retireCandidate(mode, pending)
        return failing('obsolete')
      }
      if (pending.workspaceId) {
        if (!recover) return failing('pending-operation')
        try {
          await recover(pending.sessionId, pending.workspaceId)
        } catch (error) {
          log?.warn?.('共享会话挂载恢复失败', error?.message)
          if (!current(readShared())) {
            retireCandidate(mode, pending)
            return failing('obsolete')
          }
          return failing('pending-operation')
        }
      }
      return publish(scope, branch, pending, current)
    }
    if (branch.state === 'deleted') return failing('session-deleted')
    if (branch.state === 'paused') return failing('candidate-unavailable')
    if (branch.sessionId) {
      try {
        const agent = await restore(branch)
        if (!current(readShared())) return failing('obsolete')
        if (branch.state !== 'active') {
          update(data => { data.sessions[mode].state = 'active' })
          branch.state = 'active'
        }
        return { ok: true, agent, branch }
      } catch (error) {
        if (!current(readShared())) return failing('obsolete')
        if (error?.code === 'shared/session-deleted') {
          update(data => { data.sessions[mode].state = 'deleted' })
          return failing('session-deleted')
        }
        if (error?.code === 'shared/history-unverified') {
          update(data => { Object.assign(data.sessions[mode], { state: 'paused', pauseReason: 'restored-history-unverified' }) })
          return failing('candidate-unavailable')
        }
        update(data => { data.sessions[mode].state = 'restore-unavailable' })
        return failing('restore-unavailable')
      }
    }

    const token = randomUUID()
    const base = branch.historyPolicy === 'empty' ? { reason: 'reset' } : selectSharedBase(read().chats, scope)
    const operation = {
      token, routingRevision: snapshot.routingRevision, generation: branch.generation,
      ownerPersonId: scope.ownerPersonId, baseSessionId: base.sessionId, emptyReason: base.reason,
      legacyPrefix: base.legacyPrefix,
    }
    update(data => {
      data.pendingOperations[mode] = operation
    })
    let child
    try {
      if (base.sessionId) {
        try {
          child = await fork(base.sessionId, base.legacyPrefix)
        } catch (error) {
          if (!['session/not-found', 'session/fork-unavailable', 'shared/legacy-prefix-changed'].includes(error?.code)) throw error
          operation.emptyReason = {
            'session/not-found': 'source-missing',
            'session/fork-unavailable': 'source-no-completed-turn',
            'shared/legacy-prefix-changed': 'legacy-prefix-changed',
          }[error.code]
          delete operation.baseSessionId
          delete operation.legacyPrefix
          update(data => { data.pendingOperations[mode] = operation })
        }
      }
      if (!child && current(readShared())) child = await create(scope.preset)
    } catch (error) {
      const details = error?.data || error?.details
      if (error?.code === 'shared/source-unavailable') {
        update(data => { delete data.pendingOperations[mode] })
        return failing('source-unavailable')
      }
      if (!current(readShared()) && error?.code === 'session/workspace-attach-failed' && details?.sessionId) {
        retireCandidate(mode, { ...operation, sessionId: details.sessionId })
        return failing('obsolete')
      }
      update(data => {
        operation.reason = error?.code || 'result-unknown'
        if (error?.code === 'session/workspace-attach-failed') {
          operation.sessionId = details?.sessionId
          operation.workspaceId = details?.workspaceId
        }
        data.pendingOperations[mode] = operation
      })
      return failing('pending-operation')
    }

    if (!child?.sessionId) {
      if (current(readShared())) return failing('pending-operation')
      update(data => { delete data.pendingOperations[mode] })
      return failing('obsolete')
    }
    operation.sessionId = String(child.sessionId)
    update(data => { data.pendingOperations[mode] = operation })
    return publish(scope, branch, operation, current)
  }

  function retireCandidate(mode, operation, pause = false) {
    update(data => {
      if (pause) Object.assign(data.sessions[mode], { state: 'paused', pauseReason: 'candidate-history-unverified' })
      data.retiredSessions[operation.sessionId] ??= {
        ownerPersonId: operation.ownerPersonId, mode, generation: operation.generation, archiveState: 'pending',
      }
      if (data.pendingOperations[mode]?.token === operation.token) delete data.pendingOperations[mode]
    })
  }

  async function publish(scope, branch, operation, current) {
    const { mode } = scope
    const { sessionId, emptyReason, baseSessionId } = operation
    const abandon = reason => {
      retireCandidate(mode, operation)
      return failing(reason)
    }

    if (!current(readShared())) return abandon('obsolete')
    let verified
    try {
      verified = await verifyCandidate(sessionId, operation)
    } catch (error) {
      log?.warn?.('共享分支核验失败', error?.message)
      return current(readShared()) ? failing('pending-operation') : abandon('obsolete')
    }
    if (!verified) {
      retireCandidate(mode, operation, current(readShared()))
      return failing('candidate-unavailable')
    }
    if (!current(readShared())) return abandon('obsolete')
    try {
      await rename(sessionId, mode)
    } catch (error) {
      log?.warn?.('共享会话改名失败', error?.message)
    }
    if (!current(readShared())) return abandon('obsolete')
    const record = {
      ...branch, sessionId, state: 'active', level: scope.level, preset: scope.preset,
      verifiedThroughSeq: verified.seq,
      ...(emptyReason ? { emptyReason } : { baseSessionId, forkedAt: Date.now() }),
    }
    update(data => {
      data.sessions[mode] = record
      delete data.pendingOperations[mode]
    })
    return { ok: true, agent: verified.agent, branch: record }
  }

  function ensure(scope) {
    const snapshot = sync(scope)
    if (!scope.enabled || !scope.binding || !scope.ownerPersonId || !scope.ownerAuthorizationRevision) {
      return Promise.resolve(failing('unavailable'))
    }
    const previous = creating.get(scope.mode)
    if (previous) return previous
    const promise = ensureMode(scope, snapshot).finally(() => {
      if (creating.get(scope.mode) === promise) creating.delete(scope.mode)
    })
    creating.set(scope.mode, promise)
    return promise
  }

  function checkpoint(mode, sessionId, generation, seq) {
    update(data => {
      const branch = data.sessions[mode]
      if (branch.state !== 'active' || branch.generation !== generation || branch.sessionId !== sessionId) return false
      if (!Number.isSafeInteger(seq) || seq < 0 || seq <= branch.verifiedThroughSeq) return false
      branch.verifiedThroughSeq = seq
    })
  }

  function removeRetired(sessionId) {
    update(data => {
      if (!Object.hasOwn(data.retiredSessions, sessionId)) return false
      delete data.retiredSessions[sessionId]
    })
  }

  function markRetiredArchive(sessionId, archiveState) {
    update(data => {
      const record = data.retiredSessions[sessionId]
      if (!record || record.archiveState === archiveState) return false
      data.retiredSessions[sessionId] = { ...record, archiveState }
    })
  }

  return { sync, ensure, reset, owns, checkpoint, removeRetired, markRetiredArchive, read: readShared }
}
