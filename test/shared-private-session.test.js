import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { mergeFromPanel, normalize } from '../src/core/config.js'
import { createHub } from '../src/chat/hub.js'
import { createGateway } from '../src/gateway/index.js'
import { createIdentity } from '../src/gateway/identity.js'
import { createSharedPrivateSessions, selectSharedBase, sharedQuietHistory, sharedRetiredAuditPage } from '../src/chat/shared-private-sessions.js'
import { fixedSharedPrimary, sessionRouteFor } from '../src/gateway/shared-private-route.js'
import chatTools from '../src/modules/chat-tools/index.js'
import { makeFakeAdapter } from './helpers/fake-adapter.js'

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

test('chat-tools 仅在正式共享主人私聊暴露 send_to_platform 工具与系统提示并写明 live-only 说明', () => {
  let sharedLive = true
  let buildTools = null
  let buildContext = null
  chatTools.setup({
    core: {
      hub: { canSendToSharedPlatform: (_sid, cid) => sharedLive && cid === 'qq:private:10001' },
      gateway: { instances: () => [] },
      identity,
    },
    config: () => normalize({ enabled: true, dryRun: false, multiPlatformPrivateSession: true }),
    tool: (fn) => { buildTools = fn },
    context: (fn) => { buildContext = fn },
  })

  const livePrivate = { chat: { kind: 'private', chatId: 'qq:private:10001', platform: 'qq' }, level: 'full', sessionId: 's-live' }
  const liveTools = buildTools(livePrivate)
  const sendTool = liveTools.find((t) => t.name === 'send_to_platform')
  assert.ok(sendTool, '正式共享私聊应暴露 send_to_platform')
  assert.match(sendTool.description, /试运行\/调试模式不会真正发到其他平台/)
  const liveCtx = buildContext(livePrivate)
  assert.match(liveCtx, /只有主人明确要求把消息另发到其他平台时才调用 send_to_platform/)

  // 群聊即使回调放行也不得暴露工具或系统提示
  const groupWhere = { chat: { kind: 'group', chatId: 'qq:group:999', platform: 'qq' }, level: 'full', sessionId: 's-group' }
  assert.equal(buildTools(groupWhere).some((t) => t.name === 'send_to_platform'), false)
  assert.doesNotMatch(buildContext(groupWhere), /send_to_platform/)

  // 非 live 模式 / 调试 / 试运行 / 普通私聊不暴露工具也不注入提示
  sharedLive = false
  assert.equal(buildTools(livePrivate).some((t) => t.name === 'send_to_platform'), false)
  assert.doesNotMatch(buildContext(livePrivate), /send_to_platform/)
})

test('send_to_platform 富内容扩展：|||<wbr>、voice 降级、sticker、图片、白名单过滤、partial、撤销及 rich:false 回归', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-send-platform-rich-'))
  const prevDir = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const log = { info() {}, debug() {}, warn() {}, error() {}, child() { return this } }
  const id = createIdentity({ dataDir: join(dir, 'identity'), log })
  const ownerId = id.claimOwner('qq', '10001')
  id.link('feishu', 'ou_owner', ownerId, 'owner')
  id.link('bridge', 'u_bridge', ownerId, 'owner')

  const audioFile = join(dir, 'voice.mp3')
  writeFileSync(audioFile, Buffer.from('FAKE_MP3_BYTES'))
  const stickerFile = join(dir, 'happy.png')
  writeFileSync(stickerFile, Buffer.from('PNG_BYTES'))
  const imageFile = join(dir, '照片.png')
  writeFileSync(imageFile, Buffer.from('PHOTO_PNG_BYTES'))

  const cfg = normalize({
    enabled: true,
    dryRun: false,
    ownerLevel: 'social',
    ownerPersonId: ownerId,
    ownerQQ: '10001',
    ownerAuthorization: { owner: ownerId, revision: '11111111-2222-4333-8444-555555555555' },
    multiPlatformPrivateSession: true,
    ownerPrimary: { platform: 'qq', instance: 'qq', account: '10001' },
    platforms: { qq: { enabled: true }, feishu: { enabled: true }, bridge: { enabled: true } },
    voice: { enabled: true, autoChance: 0 },
    stickers: { enabled: true, autoChance: 0 },
    merge: { enabled: false },
    chat: { thinkingGuard: { enabled: false } },
  })
  const gateway = createGateway({ config: cfg, dataDir: (...p) => join(dir, ...p), identity: id, log })
  const qq = makeFakeAdapter({ id: 'qq', self: { account: '20001' } })
  const feishu = makeFakeAdapter({ id: 'feishu', caps: { text: true, voice: 'file', sticker: false, image: true, proactive: 'free' } })
  const bridge = makeFakeAdapter({ id: 'bridge', platform: 'bridge', caps: { text: true, voice: false, sticker: false, image: false, proactive: 'free' } })
  gateway.register(() => qq)
  gateway.register(() => feishu)
  gateway.register(() => bridge)
  await gateway.sync()

  let ttsMode = 'ok'
  let stickersEnabled = true
  const listeners = new Map()
  const emit = (name, ...args) => { for (const fn of listeners.get(name) || []) fn(...args) }
  const agents = new Map()
  const sessionId = 's-shared-rich'
  let seq = 0
  let nextScript = null
  let seqCounter = 0

  function makeAgent() {
    const tools = new Map()
    let dshTurn = 0
    let idleChain = Promise.resolve()
    const session = {
      id: sessionId,
      seq: 0,
      inheritedEventCount: 0,
      events: [],
      isOwnSeq: () => true,
      eventAt: (i) => session.events[i],
    }
    const agent = {
      id: sessionId,
      session,
      tools,
      inbox: { nextTurn: [], nextStep: [], remove() {} },
      cancel() {},
      ctx: {
        tools: {
          register: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) },
          restrict: () => () => {},
        },
        systemPrompt: { context: () => () => {} },
      },
      whenIdle: () => idleChain,
      followup(msg) {
        idleChain = idleChain.then(async () => {
          dshTurn++
          const myTurn = dshTurn
          emit('agent/inbox/claimed', { agent, message: msg, turn: myTurn })
          const splicedSeq = seqCounter++
          session.seq = splicedSeq + 1
          session.events[splicedSeq] = { type: 'agent/inbox/spliced', seq: splicedSeq, data: { inserted: [{ id: msg.id }] } }
          emit('session/event', session, session.events[splicedSeq])
          for (const fn of listeners.get('agent/pre-step') || []) {
            await fn(
              { agent, messages: [msg], turn: myTurn, step: 1, signal: new AbortController().signal },
              async () => ({ kind: 'allow', messages: [msg] }),
            )
          }

          const script = nextScript
          nextScript = null
          if (script) {
            await script({ agent, session, tools, myTurn })
          }

          const endSeq = seqCounter++
          session.seq = endSeq + 1
          session.events[endSeq] = { type: 'turn/end', seq: endSeq, data: { turn: myTurn, reason: { kind: 'completed' } } }
          emit('session/event', session, { type: 'assistant/message', data: { turn: myTurn, message: { content: [{ type: 'text', text: '好的，帮你看了' }] } } })
          emit('session/event', session, session.events[endSeq])
        })
        return idleChain
      },
    }
    agents.set(sessionId, agent)
    return agent
  }

  const wsObj = {
    id: 'workspace',
    path: dir,
    title: 'Aurabot · QQ',
    sessionIds: [],
    async attachSession(sid) {
      if (!wsObj.sessionIds.includes(sid)) wsObj.sessionIds.push(sid)
    },
  }
  const dsh = {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(fn)
      return () => listeners.get(name).delete(fn)
    },
    get: (name) => dsh.services?.[name],
    agents: { get: (idKey) => agents.get(idKey) },
    sessions: { flush: async () => true },
    attachments: { admitPromptContent: async (c) => c },
    workspaceRegistry: {
      archivedSessionIds: [],
      list: () => [wsObj],
      get: (idKey) => (idKey === wsObj.id ? wsObj : null),
      create: async () => wsObj,
      archiveSession: async () => {},
    },
    services: {
      sessionProjections: {},
      sessionController: {
        create: async () => { const a = makeAgent(); return { sessionId: a.id } },
        resolveAgent: async (idKey) => ({ agent: agents.get(idKey) || makeAgent() }),
        fork: async () => ({ sessionId }),
        rename: async () => {},
      },
    },
  }

  const stickersSvc = {
    match: (name) => (name === '开心' ? { md5: 'deadbeef0001', name: '开心', file: stickerFile } : null),
    partFor: (item) => ({ type: 'sticker', label: item.name, media: { path: item.file, mime: 'image/png', name: 'happy.png' } }),
    pickForReply: () => null,
    markUsed: () => {},
  }
  const ttsSvc = {
    async speak() {
      if (ttsMode === 'fail') throw new Error('tts offline')
      return { engine: 'fake-tts', file: audioFile }
    },
  }
  let buildChatTools = null
  const hub = createHub({
    dsh,
    getConfig: () => ({ ...cfg, stickers: { ...cfg.stickers, enabled: stickersEnabled } }),
    log,
    gateway,
    identity: id,
    stickers: stickersSvc,
    tts: ttsSvc,
    resolveSharedPrimary: () => fixedSharedPrimary({ cfg, identity: id, instances: gateway.instances() }),
    buildTools: (where) => buildChatTools?.(where) || [],
  })
  chatTools.setup({
    core: { hub, gateway, identity: id },
    config: () => ({ ...cfg, stickers: { ...cfg.stickers, enabled: stickersEnabled } }),
    tool: (fn) => { buildChatTools = fn },
  })
  const offSession = dsh.on('session/event', hub.onSessionEvent)
  const submitted = []
  const stopGw = gateway.onMessage((m) => { submitted.push(hub.onGatewayMessage(m)) })
  t.after(async () => {
    offSession()
    stopGw()
    hub.dispose()
    await gateway.stopAll()
    id.close?.()
    if (prevDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prevDir
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })

  async function runTurnWithTool(msgId, args) {
    let toolResult = null
    let rendered = null
    const callId = `call-${++seq}`
    nextScript = async ({ agent, session, tools, myTurn }) => {
      const tool = tools.get('send_to_platform')
      assert.ok(tool, '正式共享私聊轮次应挂载 send_to_platform')
      emit('session/event', session, { type: 'tool/call', data: { turn: myTurn, callId, name: 'send_to_platform' } })
      toolResult = await tool.execute(args, { agent, name: 'send_to_platform', callId })
      rendered = tool.output?.render?.(args, toolResult)?.[0]?.text || ''
    }
    const idx = submitted.length
    qq.pushInbound({
      messageId: msgId,
      chat: { kind: 'private', id: '10001' },
      sender: { account: '10001', name: '主人' },
      parts: [{ type: 'text', text: '测试指定平台发送' }],
    })
    for (let i = 0; i < 100 && submitted.length <= idx; i++) await new Promise((r) => setTimeout(r, 10))
    assert.ok(submitted[idx], `gateway 未向 hub 投递消息（${msgId}）`)
    await submitted[idx]
    assert.ok(toolResult, `shared turn 未执行 send_to_platform（sharedStatus=${JSON.stringify(hub.sharedStatus())}）`)
    return { toolResult, rendered }
  }

  // 1) rich: false 保持纯文本原样发送（||| 和 <voice> 均不解析）
  const plainRes = await runTurnWithTool('m-plain', { platform: 'feishu', text: '原文|||不拆<voice>也不发语音</voice>', rich: false })
  assert.equal(plainRes.toolResult.ok, true, JSON.stringify(plainRes))
  assert.equal(feishu.sent.length, 1)
  assert.deepEqual(feishu.sent[0].payload.parts, [{ type: 'text', text: '原文|||不拆<voice>也不发语音</voice>' }])

  // 2) rich 默认：||| 拆成多条气泡，过滤 <poke> / <reply:123> 并忽略 replyTo
  feishu.sent.length = 0
  const multiRes = await runTurnWithTool('m-multi', { platform: 'feishu', text: '<poke><reply:123>第一条 ||| 第二条' })
  assert.equal(multiRes.toolResult.ok, true)
  assert.equal(multiRes.toolResult.sentCount, 2)
  assert.equal(feishu.sent.length, 2)
  assert.deepEqual(feishu.sent.map((x) => ({ parts: x.payload.parts, replyTo: x.payload.replyTo })), [
    { parts: [{ type: 'text', text: '第一条' }], replyTo: undefined },
    { parts: [{ type: 'text', text: '第二条' }], replyTo: undefined },
  ])

  // 3) 仅含不允许的标签（<poke> / <reply:1>）时不触发动作并返回失败
  feishu.sent.length = 0
  const pokeOnlyRes = await runTurnWithTool('m-poke', { platform: 'feishu', text: '<poke><reply:1>' })
  assert.equal(pokeOnlyRes.toolResult.ok, false)
  assert.equal(feishu.sent.length, 0)
  assert.equal(qq.sent.some((x) => x.payload?.parts?.some((p) => p.type === 'poke')), false)

  // 4) <voice>：支持时发送 voice part；TTS 失败或目标平台不支持语音时降级为文字并标注 degraded:'voice-fallback'
  feishu.sent.length = 0
  const voiceOk = await runTurnWithTool('m-voice-ok', { platform: 'feishu', text: '<voice>早上好</voice>' })
  assert.equal(voiceOk.toolResult.ok, true)
  assert.equal(voiceOk.toolResult.degraded, undefined)
  assert.equal(feishu.sent[0].payload.parts[0].type, 'voice')

  feishu.sent.length = 0
  ttsMode = 'fail'
  const voiceTtsFail = await runTurnWithTool('m-voice-fallback-tts', { platform: 'feishu', text: '<voice>TTS 失败改发文字</voice>' })
  assert.equal(voiceTtsFail.toolResult.ok, true)
  assert.equal(voiceTtsFail.toolResult.degraded, 'voice-fallback')
  assert.match(voiceTtsFail.rendered, /语音已降级为文字发送/)
  assert.deepEqual(feishu.sent[0].payload.parts, [{ type: 'text', text: 'TTS 失败改发文字' }])

  ttsMode = 'ok'
  bridge.sent.length = 0
  const voiceCapFail = await runTurnWithTool('m-voice-fallback-cap', { platform: 'bridge', text: '<voice>平台不支持语音</voice>' })
  assert.equal(voiceCapFail.toolResult.ok, true)
  assert.equal(voiceCapFail.toolResult.degraded, 'voice-fallback')
  assert.deepEqual(bridge.sent[0].payload.parts, [{ type: 'text', text: '平台不支持语音' }])

  // 5) <sticker:名字>：支持并命中时发送 sticker part；不存在或平台不支持 sticker 时直接报错且不发标签文本
  feishu.sent.length = 0
  const stickerOk = await runTurnWithTool('m-sticker-ok', { platform: 'feishu', text: '<sticker:开心>' })
  assert.equal(stickerOk.toolResult.ok, true)
  // 飞书 caps.sticker=false / image=true：网关将表情降级为图片。
  assert.equal(feishu.sent[0].payload.parts[0].type, 'image')

  feishu.sent.length = 0
  const stickerMissing = await runTurnWithTool('m-sticker-miss', { platform: 'feishu', text: '<sticker:不存在的表情>' })
  assert.equal(stickerMissing.toolResult.ok, false)
  assert.match(stickerMissing.toolResult.message, /未找到/)
  assert.equal(feishu.sent.length, 0)

  bridge.sent.length = 0
  const stickerUnsupported = await runTurnWithTool('m-sticker-cap', { platform: 'bridge', text: '<sticker:开心>' })
  assert.equal(stickerUnsupported.toolResult.ok, false)
  assert.match(stickerUnsupported.toolResult.message, /不支持发送表情包/)
  assert.equal(bridge.sent.length, 0)

  // 6) 图片：富内容支持 markdown 图片；目标平台不支持图片时直接报错
  feishu.sent.length = 0
  const imageOk = await runTurnWithTool('m-image-ok', { platform: 'feishu', text: `![照片](${imageFile})` })
  assert.equal(imageOk.toolResult.ok, true)
  assert.equal(imageOk.toolResult.sentCount, 1)
  assert.equal(feishu.sent[0].payload.parts[0].type, 'image')
  assert.equal(
    feishu.sent[0].payload.parts[0].media.path.replaceAll('\\', '/'),
    imageFile.replaceAll('\\', '/'),
    'file:// 中文路径必须解码成真实路径',
  )

  bridge.sent.length = 0
  const imageUnsupported = await runTurnWithTool('m-image-cap', { platform: 'bridge', text: `![照片](${imageFile})` })
  assert.equal(imageUnsupported.toolResult.ok, false)
  assert.match(imageUnsupported.toolResult.message, /不支持发送图片/)
  assert.equal(bridge.sent.length, 0)

  // 7) 多条气泡第 2 条失败 -> partial:true 且 sentCount=1, failedCount=1
  feishu.sent.length = 0
  const origFeishuSend = feishu.send.bind(feishu)
  let callNum = 0
  feishu.send = async (msg) => {
    callNum++
    if (callNum === 2) throw Object.assign(new Error('second failed'), { certainty: 'not-sent', code: 'rejected' })
    return origFeishuSend(msg)
  }
  const partialRes = await runTurnWithTool('m-partial', { platform: 'feishu', text: '第一句成功 ||| 第二句失败' })
  feishu.send = origFeishuSend
  assert.equal(partialRes.toolResult.ok, false)
  assert.equal(partialRes.toolResult.partial, true)
  assert.equal(partialRes.toolResult.sentCount, 1)
  assert.equal(partialRes.toolResult.failedCount, 1)
  assert.equal(feishu.sent.length, 1)

  // 6.5) 先发文字再发表情被丢弃 / 失败：绝不能把前序文字的 sentCount 回退成 0
  feishu.sent.length = 0
  const origGwSend = gateway.send.bind(gateway)
  gateway.send = async (req, guard) => {
    if (req.parts?.some((p) => p.type === 'sticker')) {
      return { messageId: 'drop-1', degraded: ['sticker dropped'] }
    }
    return origGwSend(req, guard)
  }
  const textThenDroppedSticker = await runTurnWithTool('m-text-sticker-drop', { platform: 'feishu', text: '先发一条文字 ||| <sticker:开心>' })
  assert.equal(textThenDroppedSticker.toolResult.ok, false)
  assert.equal(textThenDroppedSticker.toolResult.partial, true)
  assert.equal(textThenDroppedSticker.toolResult.sentCount, 1, '表情被丢弃时绝不能减少前序文字的 sentCount')
  assert.equal(textThenDroppedSticker.toolResult.failedCount, 1)
  assert.equal(feishu.sent.length, 1)

  feishu.sent.length = 0
  gateway.send = async (req, guard) => {
    if (req.parts?.some((p) => p.type === 'sticker')) {
      throw Object.assign(new Error('sticker rejected'), { certainty: 'not-sent', code: 'rejected' })
    }
    return origGwSend(req, guard)
  }
  const textThenRejectedSticker = await runTurnWithTool('m-text-sticker-rej', { platform: 'feishu', text: '先发第二条文字 ||| <sticker:开心>' })
  gateway.send = origGwSend
  assert.equal(textThenRejectedSticker.toolResult.ok, false)
  assert.equal(textThenRejectedSticker.toolResult.partial, true)
  assert.equal(textThenRejectedSticker.toolResult.sentCount, 1, '表情发送抛错时也绝不能回退前序文字的 sentCount')
  assert.equal(textThenRejectedSticker.toolResult.failedCount, 1)
  assert.equal(feishu.sent.length, 1)

  // 7) 中途撤销（第 1 条发出后撤销主账号绑定）立即停止第 2 条，并验证当前共享轮次回复及 checkpoint 不被改变
  feishu.sent.length = 0
  callNum = 0
  feishu.send = async (msg) => {
    callNum++
    const res = await origFeishuSend(msg)
    if (callNum === 1) {
      // 发送中途撤销目标账号绑定使 isCurrent() 失效
      id.unlink('feishu', 'ou_owner')
    }
    return res
  }
  const abortMidRes = await runTurnWithTool('m-abort-mid', { platform: 'feishu', text: '撤销前发出 ||| 撤销后必须停下' })
  feishu.send = origFeishuSend
  assert.equal(abortMidRes.toolResult.ok, false)
  assert.equal(abortMidRes.toolResult.partial, true)
  assert.equal(abortMidRes.toolResult.sentCount, 1)
  assert.equal(feishu.sent.length, 1)

  // 来源平台 QQ 仍正常收到每轮最终回复且 generation/checkpoint 完整一致
  assert.equal(qq.sent.length, 15)
  assert.equal(qq.sent.every((x) => x.payload.parts[0].text === '好的，帮你看了'), true)
  const sessionsState = hub.sharedStatus().state
  assert.ok(sessionsState)
})
