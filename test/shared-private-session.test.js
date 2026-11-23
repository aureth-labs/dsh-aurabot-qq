import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeFromPanel, normalize } from '../src/core/config.js'
import { createSharedPrivateSessions, selectSharedBase, sharedQuietHistory, sharedRetiredAuditPage } from '../src/chat/shared-private-sessions.js'
import { fixedSharedPrimary, sessionRouteFor } from '../src/gateway/shared-private-route.js'

const binding = { platform: 'qq', instance: 'qq', account: '12345', chatId: 'qq:private:12345' }
const owner = 'owner-person'
const scope = {
  mode: 'live', enabled: true, ownerPersonId: owner, ownerAuthorizationRevision: 'owner-revision',
  binding, level: 'social', preset: 'aurabot-social',
}
const ordinary = {
  'private:12345': {
    ...scope, sessionId: 'base-live', sessions: { live: 'base-live', debug: 'base-debug' },
    sessionOwners: {
      live: { ...scope, sessionId: 'base-live' },
      debug: { ...scope, sessionId: 'base-debug' },
    },
  },
}
const identity = {
  owner: () => owner,
  accountsOf: () => [{ platform: 'qq', account: '12345' }, { platform: 'feishu', account: 'ou_owner' }],
  lookup: (platform, account) => ({ qq: '12345', feishu: 'ou_owner' })[platform] === account ? owner : null,
}

function fixture({ chats = ordinary, initialData = { chats }, ...overrides } = {}) {
  let data = structuredClone(initialData)
  const calls = []
  const service = createSharedPrivateSessions({
    read: () => structuredClone(data),
    write: next => { data = structuredClone(next) },
    fork: async id => { calls.push(['fork', id]); return { sessionId: 'child-' + id } },
    create: async preset => { calls.push(['create', preset]); return { sessionId: 'empty' } },
    verifyCandidate: async id => ({ seq: 3, agent: { id } }),
    rename: async () => {},
    restore: async branch => ({ id: branch.sessionId }),
    ...overrides,
  })
  return { service, calls, data: () => data }
}

async function pausedFixture(overrides) {
  const f = fixture({
    restore: async branch => {
      if (branch.sessionId === 'child-base-live') {
        throw Object.assign(new Error('history beyond checkpoint'), { code: 'shared/history-unverified' })
      }
      return { id: branch.sessionId }
    },
    ...overrides,
  })
  const parent = (await f.service.ensure(scope)).branch
  assert.equal((await f.service.ensure(scope)).reason, 'candidate-unavailable')
  return { ...f, parent }
}

test('shared mode must be a boolean and is not writable via generic panel settings', () => {
  assert.equal(normalize({}).multiPlatformPrivateSession, false)
  assert.equal(normalize({ multiPlatformPrivateSession: 'true' }).multiPlatformPrivateSession, false)
  const cfg = normalize({ multiPlatformPrivateSession: true })
  assert.equal(mergeFromPanel(cfg, { multiPlatformPrivateSession: false }).multiPlatformPrivateSession, true)
})

test('default QQ legacy bare chat is preferred over a later canonical duplicate', () => {
  const canonical = {
    ...scope, sessionId: 'newer-live', sessions: { live: 'newer-live' },
    sessionOwners: { live: { ...scope, sessionId: 'newer-live' } },
  }
  const chats = { ...ordinary, 'qq:private:12345': canonical }
  assert.equal(selectSharedBase(chats, scope).sessionId, 'base-live')
})

test('primary binding uses the fixed instance and account even when disconnected', () => {
  const cfg = normalize({ ownerPrimary: { ...binding, fallback: true } })
  const instances = [{ ...binding, state: 'disconnected' }, { platform: 'qq', instance: 'qq#2', state: 'connected' }]
  const input = { cfg, identity, instances, instancesForAccount: () => ['qq'] }
  assert.deepEqual(fixedSharedPrimary(input), { ok: true, ownerPersonId: owner, binding })
  assert.deepEqual(fixedSharedPrimary({ ...input, instancesForAccount: () => ['qq#2'] }), { ok: false, reason: 'missing-primary' })
  const partial = normalize({ ownerPrimary: { platform: 'qq' } })
  assert.deepEqual(fixedSharedPrimary({ ...input, cfg: partial, instancesForAccount: () => ['qq', 'qq#2'] }), {
    ok: false, reason: 'ambiguous-primary',
  })
})

test('a fixed direct QQ primary is unavailable even alongside a managed gateway instance', () => {
  const direct = { ...binding, legacy: true }
  const managed = { ...binding, instance: 'qq#2', chatId: 'qq#2:private:12345' }
  const instances = [direct, managed]
  const input = {
    identity, instances,
    instancesForAccount: () => ['qq#2'],
  }
  assert.deepEqual(fixedSharedPrimary({ ...input, cfg: normalize({ ownerPrimary: binding }) }), {
    ok: false, reason: 'gateway-required',
  })
  assert.deepEqual(fixedSharedPrimary({ ...input, cfg: normalize({ ownerPrimary: managed }) }), {
    ok: true, ownerPersonId: owner, binding: managed,
  })
})

test('only admitted platform owner private messages qualify for sharing', () => {
  const cfg = normalize({ multiPlatformPrivateSession: true })
  const primary = { ok: true, ownerPersonId: owner, binding }
  const chat = { chatId: 'feishu:private:ou_owner' }
  const ingress = { ...chat, instance: 'feishu', platform: 'feishu', account: 'ou_owner', messageId: 'inbound-id' }
  const input = { cfg, primary, identity, ingress }
  assert.deepEqual(sessionRouteFor(chat, input), { kind: 'multi-private', key: 'multi:owner-private', mode: 'live' })
  assert.equal(sessionRouteFor(chat, { ...input, ingress: null }).kind, 'chat')
  assert.equal(sessionRouteFor({ chatId: 'feishu:group:ou_owner' }, input).kind, 'chat')
  assert.equal(sessionRouteFor(chat, { ...input, cfg: normalize({}) }).kind, 'chat')
})

test('only an owned and policy-matching base can be inherited', () => {
  assert.equal(selectSharedBase(ordinary, scope).sessionId, 'base-live')
  assert.equal(selectSharedBase(ordinary, { ...scope, mode: 'debug' }).sessionId, 'base-debug')
  assert.deepEqual(selectSharedBase(ordinary, { ...scope, ownerAuthorizationRevision: 'changed' }), {
    reason: 'source-authorization-changed',
  })
})

test('an old mapping is reviewable only when it lacks conflicting or revoked ownership', () => {
  const { sessionOwners, ...legacy } = ordinary['private:12345']
  const chats = { 'private:12345': legacy }
  assert.deepEqual(selectSharedBase(chats, scope), {
    reason: 'source-unverified', legacy: { sessionId: 'base-live', chatId: 'private:12345', title: undefined },
  })
  assert.equal(selectSharedBase(chats, { ...scope, preset: 'other' }).legacy, undefined)
  for (const proof of [{ sessionId: 'base-live', unverified: true }, { ...sessionOwners.live, ownerPersonId: 'previous-owner' }]) {
    assert.deepEqual(selectSharedBase({ 'private:12345': { ...legacy, sessionOwners: { live: proof } } }, scope), {
      reason: 'source-authorization-changed',
    })
  }
})

test('retired audit checks additions behind the cursor and continues its previous sweep', () => {
  const retired = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [
    'b' + String(index).padStart(2, '0'), {},
  ]))
  const first = sharedRetiredAuditPage(retired, '', new Set())
  assert.equal(first.nextCursor, 'b15')
  retired.a00 = {}
  const second = sharedRetiredAuditPage(retired, first.nextCursor, new Set(['a00']))
  assert.equal(second.ids[0], 'a00')
  assert.equal(second.ids[1], 'b16')
  assert.equal(second.ids.length, 16)
  assert.equal(second.nextCursor, 'b30')
})

test('first messages share a fork and close/reopen reuses its mapping', async () => {
  const { service, calls, data } = fixture()
  const [first, second] = await Promise.all([service.ensure(scope), service.ensure(scope)])
  assert.equal(first.branch.sessionId, second.branch.sessionId)
  assert.deepEqual(calls, [['fork', 'base-live']])
  service.sync({ ...scope, enabled: false })
  assert.equal((await service.ensure(scope)).branch.sessionId, first.branch.sessionId)
  assert.deepEqual(data().chats, ordinary)
})

test('an active branch from the canonical duplicate is rebased to the legacy bare chat', async () => {
  const canonical = {
    ...scope, sessionId: 'canonical-live', sessions: { live: 'canonical-live' },
    sessionOwners: { live: { ...scope, sessionId: 'canonical-live' } },
  }
  const { service, calls, data } = fixture({ chats: { 'qq:private:12345': canonical } })
  const first = await service.ensure(scope)
  assert.equal(first.branch.baseSessionId, 'canonical-live')
  data().chats['private:12345'] = ordinary['private:12345']
  service.sync(scope)
  assert.equal(service.read().sessions.live.state, 'uninitialized')
  assert.equal(service.owns(first.branch.sessionId), true)
  const second = await service.ensure(scope)
  assert.equal(second.branch.baseSessionId, 'base-live')
  assert.deepEqual(calls, [['fork', 'canonical-live'], ['fork', 'base-live']])
})

test('reset persists empty-history policy and ownership of the retired branch', async () => {
  const { service, calls } = fixture()
  const first = await service.ensure(scope)
  service.reset(['live'])
  assert.equal(service.owns(first.branch.sessionId), true)
  assert.equal(service.read().sessions.debug.historyPolicy, 'inherit')
  const next = await service.ensure(scope)
  assert.equal(next.branch.emptyReason, 'reset')
  assert.deepEqual(calls, [['fork', 'base-live'], ['create', 'aurabot-social']])
})

test('a fork from before the switch was toggled cannot become active', async () => {
  const deferred = Promise.withResolvers()
  const { service } = fixture({ fork: () => deferred.promise })
  const first = service.ensure(scope)
  service.sync({ ...scope, enabled: false })
  service.sync(scope)
  deferred.resolve({ sessionId: 'obsolete-child' })
  assert.deepEqual(await first, { ok: false, reason: 'obsolete' })
  assert.equal(service.owns('obsolete-child'), true)
  assert.equal(service.read().sessions.live.sessionId, undefined)
})

test('restart verification ignores blocked inbox events but pauses on new conversation history', () => {
  const events = [
    { type: 'user/message' }, { type: 'assistant/message' },
    { type: 'session/end-seed' }, { type: 'session/title' },
    { type: 'agent/inbox/spliced' }, { type: 'turn/start' },
    { type: 'turn/end', data: { reason: { kind: 'blocked' } } },
  ]
  const session = {
    get seq() { return events.length },
    inheritedEventCount: 2,
    isOwnSeq: seq => seq >= 2 && seq < events.length,
    eventAt: seq => events[seq],
  }
  assert.deepEqual(sharedQuietHistory(session), { seq: 6 })
  assert.deepEqual(sharedQuietHistory(session, 3), { seq: 6 })
  events.push({ type: 'turn/start' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(sharedQuietHistory(session, 6), null)
  assert.deepEqual(sharedQuietHistory(session, 8), { seq: 8 })
})

test('a restored branch with history past the verified checkpoint remains paused', async () => {
  let restores = 0
  const { service } = fixture({
    restore: async () => {
      restores++
      throw Object.assign(new Error('history beyond checkpoint'), { code: 'shared/history-unverified' })
    },
  })
  const active = await service.ensure(scope)
  const blocked = { ok: false, reason: 'candidate-unavailable' }
  assert.deepEqual(await service.ensure(scope), blocked)
  assert.deepEqual(await service.ensure(scope), blocked)
  assert.equal(restores, 1)
  assert.equal(service.read().sessions.live.sessionId, active.branch.sessionId)
  assert.equal(service.read().sessions.live.pauseReason, 'restored-history-unverified')
})

test('checkpoint recovery publishes one verified child and prevents ordinary alias rebase', async () => {
  const retired = []
  const { service, parent } = await pausedFixture({ onRetired: id => retired.push(id) })
  const before = service.read()
  const checkpoint = parent.verifiedThroughSeq
  assert.deepEqual(service.recoveryStatus(scope), { recoverable: true, recoverCheckpoint: checkpoint, recoverReason: '' })
  const result = await service.recoverFromCheckpoint(scope, {
    async forkAtCheckpoint(branch, atSeq) {
      assert.equal(branch.sessionId, parent.sessionId)
      assert.equal(atSeq, checkpoint)
      assert.equal(service.read().sessions.live.state, 'recovering')
      assert.equal((await service.ensure(scope)).reason, 'candidate-unavailable')
      return { sessionId: 'recovered-child' }
    },
    async verifyRecovered(child, branch, atSeq) {
      assert.equal(branch.sessionId, parent.sessionId)
      assert.equal(atSeq, checkpoint)
      assert.equal(service.owns(child.sessionId), true)
      assert.deepEqual(retired, [])
      return true
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.sessionId, 'recovered-child')
  assert.equal(result.checkpoint, checkpoint)
  assert.equal(result.branch.level, scope.level)
  assert.equal(result.branch.preset, scope.preset)
  assert.equal(result.branch.verifiedThroughSeq, checkpoint)
  assert.equal(result.branch.generation, parent.generation + 1)
  assert.equal(result.branch.baseSessionId, parent.sessionId)
  assert.equal(result.branch.recoveredFrom, parent.sessionId)
  assert.equal(result.branch.checkpointRecovery, true)
  assert.equal(result.branch.pauseReason, undefined)
  assert.deepEqual(retired, [parent.sessionId])
  assert.equal(service.read().routingRevision, before.routingRevision + 1)
  assert.deepEqual(service.read().pendingOperations, {})
  assert.equal(service.sync(scope).sessions.live.sessionId, result.sessionId)
  assert.equal((await service.ensure(scope)).branch.sessionId, result.sessionId)
})

test('failed checkpoint recovery leaves the original paused, retires only a known failed child, and retries', async () => {
  const retired = []
  const { service, parent } = await pausedFixture({ onRetired: id => retired.push(id) })
  const retry = {
    forkAtCheckpoint: async () => ({ sessionId: 'eventual-child' }),
    verifyRecovered: async () => true,
  }
  const original = service.read().sessions.live
  assert.equal((await service.recoverFromCheckpoint(scope, {
    ...retry, forkAtCheckpoint: async () => { throw new Error('fork failed') },
  })).reason, 'recover-fork-unavailable')
  assert.deepEqual(service.read().sessions.live, original)
  assert.deepEqual(retired, [])
  assert.equal((await service.recoverFromCheckpoint(scope, {
    forkAtCheckpoint: async () => ({ sessionId: 'invalid-prefix' }),
    verifyRecovered: async () => false,
  })).reason, 'candidate-unavailable')
  assert.equal((await service.recoverFromCheckpoint(scope, {
    ...retry,
    forkAtCheckpoint: async () => {
      throw Object.assign(new Error('cannot attach'), {
        code: 'session/workspace-attach-failed', details: { sessionId: 'unattached-recovery-child' },
      })
    },
  })).reason, 'workspace-unavailable')
  for (const sessionId of [parent.sessionId, ordinary['private:12345'].sessionId]) {
    assert.equal((await service.recoverFromCheckpoint(scope, {
      ...retry, forkAtCheckpoint: async () => ({ sessionId }),
    })).reason, 'candidate-unavailable')
  }
  assert.deepEqual(service.read().sessions.live, original)
  assert.deepEqual(service.read().pendingOperations, {})
  assert.deepEqual(retired, ['invalid-prefix', 'unattached-recovery-child'])
  assert.equal((await service.recoverFromCheckpoint(scope, retry)).sessionId, 'eventual-child')
  assert.deepEqual(retired, ['invalid-prefix', 'unattached-recovery-child', parent.sessionId])
})

test('checkpoint recovery rejects missing checkpoints, changed authorization and deleted parents', async () => {
  const { service, data } = await pausedFixture()
  const callbacks = {
    forkAtCheckpoint: async () => {
      throw Object.assign(new Error('deleted'), { code: 'shared/session-deleted' })
    },
    verifyRecovered: async () => { throw new Error('fork should have failed') },
  }
  const branch = data().multiPrivate.sessions.live
  const checkpoint = branch.verifiedThroughSeq
  delete branch.verifiedThroughSeq
  assert.deepEqual(service.recoveryStatus(scope), { recoverable: false, recoverCheckpoint: null, recoverReason: 'no-checkpoint' })
  assert.equal((await service.recoverFromCheckpoint(scope, callbacks)).reason, 'no-checkpoint')
  branch.verifiedThroughSeq = checkpoint
  const revoked = { ...scope, ownerAuthorizationRevision: 'new-authorization' }
  assert.equal((await service.recoverFromCheckpoint(revoked, callbacks)).reason, 'authorization-changed')
  assert.equal((await service.recoverFromCheckpoint(scope, callbacks)).reason, 'session-deleted')
  assert.equal(service.read().sessions.live.state, 'paused')
  assert.equal(service.recoveryStatus(scope).recoverReason, 'session-deleted')
  assert.deepEqual(service.read().retiredSessions, {})
})

test('switch, reset or authorization changes invalidate a pending checkpoint fork', async () => {
  const changes = [
    { change: service => { service.sync({ ...scope, enabled: false }); service.sync(scope) }, state: 'paused' },
    { change: service => service.sync({ ...scope, mode: 'debug' }), state: 'paused' },
    { change: service => service.reset(['live']), state: 'uninitialized' },
    { change: service => service.sync({ ...scope, ownerAuthorizationRevision: 'new-authorization' }), state: 'uninitialized' },
  ]
  for (const { change, state } of changes) {
    const { service, parent } = await pausedFixture()
    const deferred = Promise.withResolvers()
    let verifications = 0
    const callbacks = {
      forkAtCheckpoint: () => deferred.promise,
      verifyRecovered: async () => { verifications++; return true },
    }
    const pending = service.recoverFromCheckpoint(scope, callbacks)
    assert.equal(service.recoveryStatus(scope).recoverReason, 'busy')
    assert.equal((await service.recoverFromCheckpoint(scope, callbacks)).reason, 'busy')
    change(service)
    deferred.resolve({ sessionId: 'obsolete-recovery-child' })
    assert.deepEqual(await pending, { ok: false, reason: 'obsolete' })
    assert.equal(verifications, 0)
    assert.equal(service.read().sessions.live.state, state)
    assert.deepEqual(service.read().pendingOperations, {})
    assert.equal(service.read().retiredSessions['obsolete-recovery-child'].archiveState, 'pending')
    assert.equal(Boolean(service.read().retiredSessions[parent.sessionId]), state === 'uninitialized')
  }
})

test('recovery may target an inactive mode and rolls back if the host revokes it during verification', async () => {
  const { service, parent } = await pausedFixture()
  service.sync({ ...scope, mode: 'debug' })
  const verifying = Promise.withResolvers()
  const deferred = Promise.withResolvers()
  let current = true
  assert.equal(service.recoveryStatus(scope).recoverable, true)
  const pending = service.recoverFromCheckpoint(scope, {
    isCurrent: () => current,
    forkAtCheckpoint: async () => ({ sessionId: 'inactive-mode-child' }),
    verifyRecovered: () => { verifying.resolve(); return deferred.promise },
  })
  await verifying.promise
  assert.equal(service.isRecovering('live'), true)
  assert.equal(service.read().mode, 'debug')
  assert.equal(service.owns('inactive-mode-child'), true)
  current = false
  deferred.resolve(true)
  assert.deepEqual(await pending, { ok: false, reason: 'obsolete' })
  assert.equal(service.isRecovering('live'), false)
  assert.equal(service.read().sessions.live.sessionId, parent.sessionId)
  assert.equal(service.read().sessions.live.state, 'paused')
  assert.equal(service.read().retiredSessions[parent.sessionId], undefined)
  assert.equal(service.read().retiredSessions['inactive-mode-child'].archiveState, 'pending')
})

test('a restart interrupts a pending checkpoint recovery and retires only the recorded child', async () => {
  const { service, data, parent } = await pausedFixture()
  const verifying = Promise.withResolvers()
  const deferred = Promise.withResolvers()
  const pending = service.recoverFromCheckpoint(scope, {
    forkAtCheckpoint: async () => ({ sessionId: 'interrupted-recovery-child' }),
    verifyRecovered: () => { verifying.resolve(); return deferred.promise },
  })
  await verifying.promise
  const restarted = fixture({ initialData: data() }).service
  assert.equal(restarted.read().sessions.live.state, 'recovering')
  restarted.sync(scope)
  assert.equal(restarted.read().sessions.live.state, 'paused')
  assert.equal(restarted.read().sessions.live.sessionId, parent.sessionId)
  assert.equal(restarted.read().sessions.live.pauseReason, 'restored-history-unverified')
  assert.equal(restarted.recoveryStatus(scope).recoverable, true)
  assert.equal(restarted.read().retiredSessions[parent.sessionId], undefined)
  assert.equal(restarted.read().retiredSessions['interrupted-recovery-child'].archiveState, 'pending')
  assert.deepEqual(restarted.read().pendingOperations, {})
  deferred.resolve(false)
  await pending
})

test('missing source creates empty, transient restore keeps the branch, and attachment failure is remembered', async () => {
  const noSource = Object.assign(new Error('no completed turn'), { code: 'session/fork-unavailable' })
  const { service } = fixture({
    fork: async () => { throw noSource },
    restore: async () => { throw new Error('offline') },
  })
  const result = await service.ensure(scope)
  assert.equal(result.branch.emptyReason, 'source-no-completed-turn')
  assert.equal((await service.ensure(scope)).reason, 'restore-unavailable')
  assert.equal(service.read().sessions.live.sessionId, result.branch.sessionId)
  assert.equal(service.read().sessions.live.state, 'restore-unavailable')

  const attachError = Object.assign(new Error('attach failed'), {
    code: 'session/workspace-attach-failed', data: { sessionId: 'half-created', workspaceId: 'workspace' },
  })
  const failed = fixture({ fork: async () => { throw attachError } }).service
  assert.equal((await failed.ensure(scope)).reason, 'pending-operation')
  assert.equal(failed.owns('half-created'), true)
  assert.equal((await failed.ensure(scope)).reason, 'pending-operation')
})

test('a recoverable attachment failure publishes the same child without re-forking', async () => {
  let attempts = 0
  const recovered = []
  const error = Object.assign(new Error('attach failed'), {
    code: 'session/workspace-attach-failed', data: { sessionId: 'existing-child', workspaceId: 'workspace' },
  })
  const { service } = fixture({
    fork: async () => { attempts++; throw error },
    recover: async (...ids) => recovered.push(ids),
  })
  assert.equal((await service.ensure(scope)).reason, 'pending-operation')
  const result = await service.ensure(scope)
  assert.equal(result.branch.sessionId, 'existing-child')
  assert.equal(result.branch.baseSessionId, 'base-live')
  assert.equal(attempts, 1)
  assert.deepEqual(recovered, [['existing-child', 'workspace']])
})

test('a known pending child is retained and queued for archive when reset or disabled', async () => {
  for (const retire of [service => service.reset(['live']), service => service.sync({ ...scope, enabled: false })]) {
    const notified = []
    const error = Object.assign(new Error('attach failed'), {
      code: 'session/workspace-attach-failed', data: { sessionId: 'unattached-child', workspaceId: 'workspace' },
    })
    const { service, data } = fixture({
      fork: async () => { throw error },
      onRetired: id => notified.push(data().multiPrivate.retiredSessions[id].archiveState),
    })
    assert.equal((await service.ensure(scope)).reason, 'pending-operation')
    retire(service)
    assert.deepEqual(notified, ['pending'])
    assert.equal(service.read().pendingOperations.live, undefined)
    assert.equal(service.owns('unattached-child'), true)
    service.markRetiredArchive('unattached-child', 'failed')
    service.markRetiredArchive('unattached-child', 'archived')
    assert.equal(service.read().retiredSessions['unattached-child'].archiveState, 'archived')
  }
})

test('a read failure retries the same candidate, while unsafe history pauses and queues archive', async () => {
  const retired = []
  let attempts = 0
  const { service, calls } = fixture({
    verifyCandidate: async () => {
      if (attempts++ === 0) throw new Error('temporary session read failure')
      return null
    },
    onRetired: id => retired.push(id),
  })
  assert.equal((await service.ensure(scope)).reason, 'pending-operation')
  assert.equal(service.read().pendingOperations.live.sessionId, 'child-base-live')
  assert.deepEqual(retired, [])
  assert.equal((await service.ensure(scope)).reason, 'candidate-unavailable')
  assert.equal(service.read().sessions.live.pauseReason, 'candidate-history-unverified')
  assert.equal(service.read().pendingOperations.live, undefined)
  assert.deepEqual(retired, ['child-base-live'])
  assert.equal((await service.ensure(scope)).reason, 'candidate-unavailable')
  assert.deepEqual(calls, [['fork', 'base-live']])
})
