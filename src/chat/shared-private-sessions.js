import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { isSharedHostContext } from './shared-turn-guard.js'
import { parseChatId, sameChat } from '../gateway/address.js'

export const SHARED_MODES = Object.freeze(['live', 'debug'])

// 默认平台名从地址层取，避免在 chat 层硬编码平台名。
const DEFAULT_PLATFORM = parseChatId('private:0')?.platform || ''

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

function sourceChatId(chats, bindingChatId) {
  const addr = parseChatId(bindingChatId)
  // 迁移后的默认 QQ 会同时有旧裸键 private:<号> 和网关键 qq:private:<号>；
  // 旧裸键才是迁移前复用下来的原会话，优先它，别从后建的空会话分叉。
  const alias = addr?.platform === DEFAULT_PLATFORM && addr.instance === DEFAULT_PLATFORM ? `${addr.kind}:${addr.id}` : ''
  if (alias && Object.hasOwn(chats, alias)) return alias
  if (Object.hasOwn(chats, bindingChatId)) return bindingChatId
  return Object.keys(chats).find(key => sameChat(key, bindingChatId))
}

export function selectSharedBase(chats, scope) {
  const chatId = sourceChatId(chats, scope.binding.chatId)
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
  const checkpointRecoveries = new Set()
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
      let interrupted = false
      for (const key of SHARED_MODES) {
        if (checkpointRecoveries.has(key)) continue
        const branch = shared.sessions[key]
        const pending = shared.pendingOperations[key]
        if (branch.state === 'recovering') {
          branch.state = 'paused'
          interrupted = true
        }
        if (pending?.kind === 'checkpoint-recovery') {
          retireIdlePending(shared, key)
          interrupted = true
        }
      }
      const { ownerPersonId, ownerAuthorizationRevision, binding, enabled, mode, level, preset } = scope
      const changedOwner = shared.ownerPersonId !== ownerPersonId
        || shared.ownerAuthorizationRevision !== ownerAuthorizationRevision
        || !isDeepStrictEqual(shared.primaryBinding, binding)
      const changedPolicy = shared.level !== level || shared.preset !== preset
      // 迁移后可能出现「旧裸键 private:<号> + 网关键 qq:private:<号>」两份映射。
      // 如果当前分支是从后建的空会话分叉的，切回旧裸键并重新分叉，别把错的历史继续带下去。
      let rebased = false
      if (!changedOwner && !changedPolicy && enabled && binding && shared.sessions[mode]?.state === 'active') {
        const active = shared.sessions[mode]
        const preferred = active.baseSessionId && !active.checkpointRecovery ? selectSharedBase(read().chats, scope) : null
        if (preferred?.sessionId && preferred.sessionId !== active.baseSessionId) {
          retireMode(shared, mode, active.historyPolicy)
          retireIdlePending(shared, mode)
          rebased = true
        }
      }
      if (!changedOwner && !changedPolicy && !rebased && shared.enabled === enabled && shared.mode === mode) {
        return interrupted ? undefined : false
      }
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
    if (!pending || creating.has(mode) || checkpointRecoveries.has(mode)) return
    if (!pending.sessionId && pending.kind !== 'checkpoint-recovery') return
    if (pending.sessionId && (pending.kind !== 'checkpoint-recovery' || !sharedSessionExists(shared, pending.sessionId))) {
      retirePendingSession(shared, mode, pending)
    }
    delete shared.pendingOperations[mode]
  }

  function retirePendingSession(shared, mode, pending) {
    shared.retiredSessions[pending.sessionId] ??= {
      ownerPersonId: pending.ownerPersonId, mode, generation: pending.generation, archiveState: 'pending',
    }
  }

  function sharedSessionExists(shared, sessionId) {
    return Object.hasOwn(shared.retiredSessions, sessionId)
      || SHARED_MODES.some(mode => shared.sessions[mode].sessionId === sessionId)
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
    return sharedSessionExists(data, sessionId)
      || SHARED_MODES.some(mode => data.pendingOperations[mode]?.sessionId === sessionId)
  }

  async function ensureMode(scope, snapshot) {
    const { mode } = scope
    const branch = snapshot.sessions[mode]
    if (branch.state === 'recovering') return failing('candidate-unavailable')
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
      retirePendingSession(data, mode, operation)
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
    if (checkpointRecoveries.has(scope.mode)) return Promise.resolve(failing('candidate-unavailable'))
    const previous = creating.get(scope.mode)
    if (previous) return previous
    const promise = ensureMode(scope, snapshot).finally(() => {
      if (creating.get(scope.mode) === promise) creating.delete(scope.mode)
    })
    creating.set(scope.mode, promise)
    return promise
  }

  function recoveryScopeMatches(data, scope) {
    return data.ownerPersonId === scope.ownerPersonId
      && data.ownerAuthorizationRevision === scope.ownerAuthorizationRevision
      && isDeepStrictEqual(data.primaryBinding, scope.binding)
      && data.level === scope.level && data.preset === scope.preset
  }

  function recoveryStatus(scope, data = readShared()) {
    const { mode } = scope
    const branch = data.sessions[mode]
    const unavailable = reason => ({ recoverable: false, recoverCheckpoint: null, recoverReason: reason })
    if (!SHARED_MODES.includes(mode) || !branch || !data.enabled || !scope.enabled || !scope.binding || !scope.ownerPersonId
      || !scope.ownerAuthorizationRevision) return unavailable('unavailable')
    if (!recoveryScopeMatches(data, scope)) return unavailable('authorization-changed')
    if (branch.state === 'recovering' || creating.has(mode) || checkpointRecoveries.has(mode)
      || data.pendingOperations[mode]) return unavailable('busy')
    if (branch.state === 'deleted') return unavailable('session-deleted')
    if (branch.state !== 'paused') return unavailable('not-paused')
    if (branch.recoverReason) return unavailable(branch.recoverReason)
    if (typeof branch.sessionId !== 'string' || !branch.sessionId) return unavailable('session-unavailable')
    const checkpoint = branch.verifiedThroughSeq
    if (!Number.isSafeInteger(checkpoint) || checkpoint < 0) return unavailable('no-checkpoint')
    return { recoverable: true, recoverCheckpoint: checkpoint, recoverReason: '' }
  }

  async function recoverFromCheckpoint(scope, { forkAtCheckpoint, verifyRecovered, isCurrent = () => true }) {
    const snapshot = readShared()
    const status = recoveryStatus(scope, snapshot)
    if (!status.recoverable) return failing(status.recoverReason)
    if (!isCurrent()) return failing('obsolete')
    const { mode, ownerPersonId } = scope
    const branch = snapshot.sessions[mode]
    const checkpoint = status.recoverCheckpoint
    const operation = {
      kind: 'checkpoint-recovery', token: randomUUID(),
      generation: branch.generation + 1, ownerPersonId, baseSessionId: branch.sessionId,
    }
    const parentPending = data => {
      const currentBranch = data.sessions[mode]
      return currentBranch.state === 'recovering' && currentBranch.generation === branch.generation
        && currentBranch.sessionId === branch.sessionId && currentBranch.verifiedThroughSeq === checkpoint
    }
    const sameOperation = data => data.pendingOperations[mode]?.token === operation.token
    const current = data => isCurrent() && data.enabled && data.mode === snapshot.mode
      && data.routingRevision === snapshot.routingRevision && recoveryScopeMatches(data, scope)
      && parentPending(data) && sameOperation(data)
    const freshSessionId = sessionId => {
      if (typeof sessionId !== 'string' || !sessionId || owns(sessionId)) return ''
      // A controller must return a fresh child, never one of our ordinary sessions.
      return Object.values(read().chats || {}).some(entry => entry?.sessionId === sessionId
        || Object.values(entry?.sessions || {}).includes(sessionId)) ? '' : sessionId
    }

    let failureReason = 'recover-fork-unavailable'
    checkpointRecoveries.add(mode)
    try {
      update(data => {
        data.sessions[mode].state = 'recovering'
        data.pendingOperations[mode] = operation
      })

      const child = await forkAtCheckpoint(branch, checkpoint)
      const sessionId = freshSessionId(child?.sessionId)
      if (!sessionId) return failing(current(readShared()) ? 'candidate-unavailable' : 'obsolete')
      operation.sessionId = sessionId
      if (!current(readShared())) return failing('obsolete')
      // Persist ownership before inspecting the child so it cannot run unguarded during verification.
      update(data => { data.pendingOperations[mode] = operation })
      failureReason = 'candidate-unavailable'
      const verified = await verifyRecovered(child, branch, checkpoint)
      if (!current(readShared())) return failing('obsolete')
      if (!verified) return failing(failureReason)
      try {
        await rename(sessionId, mode)
      } catch (error) {
        log?.warn?.('核验点恢复分支改名失败', error?.message)
      }

      if (!current(readShared())) return failing('obsolete')
      const record = {
        ...branch, state: 'active', generation: operation.generation, sessionId, verifiedThroughSeq: checkpoint,
        baseSessionId: branch.sessionId, recoveredFrom: branch.sessionId, checkpointRecovery: true, forkedAt: Date.now(),
      }
      delete record.pauseReason
      delete record.emptyReason
      update(data => {
        retire(data, mode, branch.sessionId, branch.generation)
        data.sessions[mode] = record
        delete data.pendingOperations[mode]
        data.routingRevision++
      })
      return { ok: true, branch: record, sessionId, checkpoint }
    } catch (error) {
      if (error?.code === 'session/workspace-attach-failed') {
        operation.sessionId ||= freshSessionId((error.data || error.details)?.sessionId)
        failureReason = 'workspace-unavailable'
      } else if (error?.code === 'session/not-found') {
        failureReason = 'session-deleted'
      } else {
        const reason = error?.code?.startsWith?.('shared/') ? error.code.slice(7) : ''
        if (['checkpoint-invalid', 'session-unavailable', 'session-deleted', 'workspace-unavailable',
          'recover-fork-unavailable', 'candidate-unavailable'].includes(reason)) failureReason = reason
      }
      log?.warn?.('从共享会话核验点恢复失败', error?.message)
      return failing(current(readShared()) ? failureReason : 'obsolete')
    } finally {
      try {
        update(data => {
          const ownOperation = sameOperation(data)
          const retireChild = operation.sessionId && !sharedSessionExists(data, operation.sessionId)
          if (!ownOperation && !retireChild) return false
          if (retireChild) retirePendingSession(data, mode, operation)
          if (ownOperation) {
            if (parentPending(data)) {
              if (['session-deleted', 'checkpoint-invalid'].includes(failureReason) && current(data)) {
                data.sessions[mode].recoverReason = failureReason
              }
              data.sessions[mode].state = 'paused'
            }
            delete data.pendingOperations[mode]
          }
        })
      } finally {
        checkpointRecoveries.delete(mode)
      }
    }
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

  return {
    sync, ensure, reset, owns, checkpoint, recoveryStatus, recoverFromCheckpoint,
    isRecovering: mode => checkpointRecoveries.has(mode),
    removeRetired, markRetiredArchive, read: readShared,
  }
}
