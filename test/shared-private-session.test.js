import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { mergeFromPanel, normalize } from '../src/core/config.js'
import { createHub } from '../src/chat/hub.js'
import { createConversationArchive } from '../src/chat/conversation-context.js'
import { createGateway } from '../src/gateway/index.js'
import { createIdentity } from '../src/gateway/identity.js'
import { createSharedPrivateSessions, selectSharedBase, sharedQuietHistory, sharedRetiredAuditPage } from '../src/chat/shared-private-sessions.js'
import { createMemoryStore } from '../src/features/memory.js'
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

async function setupSharedProactiveHarness(t, {
  primary = { platform: 'qq', instance: 'qq', account: '10001' },
  fallbackOrder = [{ platform: 'feishu', instance: 'feishu', account: 'ou_owner' }],
  fallback = true,
  qqWhoamiFn,
  feishuWhoamiFn,
  onCreateAgent,
  onGenerate,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-shared-proactive-'))
  const prevDir = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const log = { info() {}, debug() {}, warn() {}, error() {}, child() { return this } }
  const id = createIdentity({ dataDir: join(dir, 'identity'), log })
  const ownerId = id.claimOwner('qq', '10001')
  id.link('feishu', 'ou_owner', ownerId, 'owner')

  const cfg = normalize({
    enabled: true,
    dryRun: false,
    ownerLevel: 'social',
    ownerPersonId: ownerId,
    ownerQQ: '10001',
    ownerAuthorization: { owner: ownerId, revision: '11111111-2222-4333-8444-555555555555' },
    multiPlatformPrivateSession: true,
    ownerPrimary: { mode: 'fixed', ...primary, fallback, fallbackOrder },
    platforms: { qq: { enabled: true }, feishu: { enabled: true } },
    voice: { enabled: false },
    stickers: { enabled: false },
    merge: { enabled: false },
    chat: { thinkingGuard: { enabled: false } },
  })
  const gateway = createGateway({ config: cfg, dataDir: (...p) => join(dir, ...p), identity: id, log })
  const qq = makeFakeAdapter({ id: 'qq', self: { account: '20001' }, caps: { proactive: 'free' } })
  const feishu = makeFakeAdapter({ id: 'feishu', self: { account: 'fs_bot_1' }, caps: { text: true, voice: 'file', image: true, proactive: 'free' } })
  if (qqWhoamiFn) qq.whoami = qqWhoamiFn(qq.whoami.bind(qq))
  if (feishuWhoamiFn) feishu.whoami = feishuWhoamiFn(feishu.whoami.bind(feishu))
  gateway.register(() => qq)
  gateway.register(() => feishu)
  await gateway.sync()

  const listeners = new Map()
  const emit = (name, ...args) => { for (const fn of listeners.get(name) || []) fn(...args) }
  const agents = new Map()
  let seqCounter = 0
  let createCount = 0
  let flushCount = 0
  let lastTurnEndSeq = null

  function makeAgent(sessionId) {
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
      inbox: { nextTurn: [], nextStep: [], remove() {} },
      cancel() {},
      ctx: {
        tools: { register: () => () => {}, restrict: () => () => {} },
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
          if (onGenerate) await onGenerate({ agent, session, msg, myTurn })
          const endSeq = seqCounter++
          lastTurnEndSeq = endSeq
          session.seq = endSeq + 1
          session.events[endSeq] = { type: 'turn/end', seq: endSeq, data: { turn: myTurn, reason: { kind: 'completed' } } }
          emit('session/event', session, { type: 'assistant/message', data: { turn: myTurn, message: { content: [{ type: 'text', text: `主动搭话-${myTurn}` }] } } })
          emit('session/event', session, session.events[endSeq])
        })
        return idleChain
      },
    }
    agents.set(sessionId, agent)
    return agent
  }

  const wsObj = { id: 'workspace', path: dir, title: 'Aurabot · QQ', sessionIds: [], async attachSession() {} }
  const dsh = {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(fn)
      return () => listeners.get(name).delete(fn)
    },
    get: (name) => dsh.services?.[name],
    agents: { get: (idKey) => agents.get(idKey) },
    sessions: { flush: async () => { flushCount++; return true } },
    attachments: { admitPromptContent: async (c) => c },
    workspaceRegistry: { list: () => [wsObj], get: (idKey) => (idKey === wsObj.id ? wsObj : null), create: async () => wsObj, archiveSession: async () => {}, archivedSessionIds: [], unarchiveSession: async () => {} },
    services: {
      sessionProjections: {},
      sessionController: {
        create: async () => {
          if (onCreateAgent) await onCreateAgent()
          const sid = `s-shared-pro-${++createCount}`
          makeAgent(sid)
          return { sessionId: sid }
        },
        resolveAgent: async (idKey) => ({ agent: agents.get(idKey) || makeAgent(idKey) }),
        fork: async () => ({ sessionId: `s-fork-${++createCount}` }),
        rename: async () => {},
      },
    },
  }

  const resolveRoute = ({ sharedBinding } = {}) => {
    const candidates = sharedBinding
      ? [
          { platform: sharedBinding.platform, instance: sharedBinding.instance, account: sharedBinding.account },
          ...(cfg.ownerPrimary?.fallback ? (cfg.ownerPrimary.fallbackOrder || []) : []),
        ]
      : [{ ...primary }]
    for (const c of candidates) {
      const inst = gateway.instances().find((x) => x.instance === c.instance && x.platform === c.platform)
      if (inst && inst.enabled && inst.state === 'connected' && inst.caps?.proactive !== 'none') {
        return {
          chatId: `${c.instance}:private:${c.account}`,
          target: c,
          blocked: false,
          reason: c.platform === sharedBinding?.platform && c.account === sharedBinding?.account ? 'ok' : 'fallback-used',
          fallbackUsed: !(c.platform === sharedBinding?.platform && c.account === sharedBinding?.account),
        }
      }
    }
    return { chatId: '', blocked: true, reason: 'primary-offline', target: primary, fallbackUsed: false }
  }

  const hub = createHub({
    dsh,
    getConfig: () => cfg,
    log,
    gateway,
    identity: id,
    resolveOwnerRoute: resolveRoute,
    resolveSharedPrimary: () => fixedSharedPrimary({ cfg, identity: id, instances: gateway.instances() }),
  })
  const offSession = dsh.on('session/event', hub.onSessionEvent)
  const stopGw = gateway.onMessage((m) => { hub.onGatewayMessage(m) })
  const readSessionsJson = () => JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8'))

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

  return {
    dir, cfg, gateway, qq, feishu, hub, id, readSessionsJson,
    stats: () => ({ createCount, flushCount, lastTurnEndSeq }),
  }
}

test('共享主动回退 P2 #1：目标 connected 但 whoami 未完成时拒绝选择与投递，重连验号期间同样暂缓', async (t) => {
  let feishuGate = Promise.withResolvers()
  t.after(() => feishuGate.resolve())
  const { gateway, qq, feishu, hub, stats } = await setupSharedProactiveHarness(t, {
    feishuWhoamiFn: (orig) => async () => {
      await feishuGate.promise
      return orig()
    },
  })

  qq.disconnect()
  const inst = () => gateway.instances().find((x) => x.instance === 'feishu')
  assert.equal(inst()?.state, 'connected')
  assert.equal(inst()?.self, null, '初连 whoami 未完成前 self 必须为 null')

  // 即使 resolveOwnerRoute 只检查 state=connected，hub.canProactiveTarget 也必须以 self.account 为空拒绝投递
  const previewPending = hub.resolveSharedProactiveRoute({ record: false })
  assert.equal(previewPending?.deferred, true)
  assert.equal(previewPending?.chatId, '')
  const pushPending = await hub.pushProactiveToSession(null, [{ type: 'text', text: '测试搭话' }], '', {
    route: { chatId: 'feishu:private:ou_owner', fallbackUsed: true },
  })
  assert.equal(pushPending.ok, false)
  assert.equal(pushPending.deferred, true)
  assert.equal(feishu.sent.length, 0)
  assert.equal(stats().createCount, 0, 'whoami 未完成时不得创建共享会话或生成内容')

  // 放行首次 whoami -> 允许回退投递到 feishu
  feishuGate.resolve()
  for (let i = 0; i < 50 && !inst()?.self?.account; i++) await new Promise((r) => setTimeout(r, 10))
  assert.equal(inst()?.self?.account, 'fs_bot_1')
  const previewReady = hub.resolveSharedProactiveRoute({ record: false })
  assert.equal(previewReady?.chatId, 'feishu:private:ou_owner')
  assert.equal(previewReady?.fallbackUsed, true)
  const pushOk = await hub.pushProactiveToSession(null, [{ type: 'text', text: '验号后搭话' }], '', { route: previewReady })
  assert.equal(pushOk.ok, true)
  assert.equal(pushOk.delivered, true)
  assert.equal(feishu.sent.length, 1)

  // 重连后 self 重新清空，在新一轮 whoami 完成前再次拒绝
  feishuGate = Promise.withResolvers()
  feishu.disconnect()
  feishu.reconnect()
  assert.equal(inst()?.state, 'connected')
  assert.equal(inst()?.self, null)
  assert.equal(hub.resolveSharedProactiveRoute({ record: false })?.deferred, true)
  const pushReconnectPending = await hub.pushProactiveToSession(null, [{ type: 'text', text: '重连验号中' }], '', {
    route: { chatId: 'feishu:private:ou_owner', fallbackUsed: true },
  })
  assert.equal(pushReconnectPending.deferred, true)
  assert.equal(feishu.sent.length, 1)

  feishuGate.resolve()
  for (let i = 0; i < 50 && !inst()?.self?.account; i++) await new Promise((r) => setTimeout(r, 10))
  assert.equal(hub.resolveSharedProactiveRoute({ record: false })?.chatId, 'feishu:private:ou_owner')
})

test('共享主动回退 P2 #2：投递前已完成 DSH flush 但 checkpoint 在投递完成后推进，生成中目标断开不误记送达', async (t) => {
  let genGate = null
  let genEntered = null
  const { gateway, qq, feishu, hub, readSessionsJson, stats } = await setupSharedProactiveHarness(t, {
    onGenerate: async () => {
      genEntered?.resolve()
      if (genGate) await genGate.promise
    },
  })

  qq.disconnect()
  const route = hub.resolveSharedProactiveRoute({ record: false })
  assert.equal(route?.chatId, 'feishu:private:ou_owner')

  // 1) 挂起 gateway.send，检查投递未完成前已 flush 但 sessions.json verifiedThroughSeq 尚未推进
  const sendStarted = Promise.withResolvers()
  const releaseSend = Promise.withResolvers()
  t.after(() => { releaseSend.resolve(); genGate?.resolve() })
  const origSend = gateway.send.bind(gateway)
  gateway.send = async (...args) => {
    sendStarted.resolve()
    await releaseSend.promise
    return origSend(...args)
  }
  let deliveredCount = 0
  const pendingPush = hub.pushProactiveToSession(null, [{ type: 'text', text: '先生成再投递' }], '', {
    route,
    onDelivered: () => { deliveredCount++ },
  })
  await sendStarted.promise
  assert.equal(stats().flushCount >= 1, true, '投递前应已持久化/flush DSH 会话')
  assert.equal(
    readSessionsJson().multiPrivate.sessions.live.verifiedThroughSeq ?? null,
    null,
    '投递结果确定前不得提前推进 verifiedThroughSeq',
  )
  releaseSend.resolve()
  gateway.send = origSend
  const okRes = await pendingPush
  assert.equal(okRes.ok, true)
  assert.equal(okRes.delivered, true)
  assert.equal(deliveredCount, 1)
  const afterDeliveredMap = readSessionsJson().multiPrivate
  assert.equal(afterDeliveredMap.primaryBinding.platform, 'qq')
  assert.equal(afterDeliveredMap.sessions.live.verifiedThroughSeq, stats().lastTurnEndSeq)
  const firstDelivery = hub.sharedStatus().lastProactiveDelivery
  assert.equal(firstDelivery?.platform, 'feishu')
  assert.equal(firstDelivery?.fallbackUsed, true)

  // 2) 生成阶段目标断开 -> 返回 deferred，不调 onDelivered、不覆盖 lastProactiveDelivery，已核验历史同步进 checkpoint
  genGate = Promise.withResolvers()
  genEntered = Promise.withResolvers()
  const prevOnGen = stats().lastTurnEndSeq
  const pendingDrop = hub.pushProactiveToSession(null, [{ type: 'text', text: '生成途中断线' }], '', {
    route,
    onDelivered: () => { deliveredCount++ },
  })
  const entered = await Promise.race([
    genEntered.promise.then(() => ({ entered: true })),
    pendingDrop.then((res) => ({ entered: false, res })),
  ])
  assert.equal(entered.entered, true, `unexpected early return before onGenerate: ${JSON.stringify(entered)}`)
  feishu.disconnect()
  genGate.resolve()
  genGate = null
  genEntered = null
  const dropRes = await pendingDrop
  assert.equal(dropRes.ok, false)
  assert.equal(dropRes.deferred, true)
  assert.equal(deliveredCount, 1)
  assert.equal(feishu.sent.length, 1)
  assert.deepEqual(hub.sharedStatus().lastProactiveDelivery, firstDelivery)
  assert.ok(readSessionsJson().multiPrivate.sessions.live.verifiedThroughSeq > prevOnGen)
})

test('共享主动回退 P2 #3：withDefaultQqWork 在准备/生成/投递全程护航 QQ 迁移，且迁移暂停时拒绝回退', async (t) => {
  // 场景 A：共享主账号为默认 qq，回退飞书 -> 在 ensure / generate / send 全程持有 defaultQqWork
  const createGate = Promise.withResolvers()
  const genGate = Promise.withResolvers()
  const createReached = Promise.withResolvers()
  const genReached = Promise.withResolvers()
  t.after(() => { createGate.resolve(); genGate.resolve() })
  const hA = await setupSharedProactiveHarness(t, {
    primary: { platform: 'qq', instance: 'qq', account: '10001' },
    fallbackOrder: [{ platform: 'feishu', instance: 'feishu', account: 'ou_owner' }],
    onCreateAgent: async () => { createReached.resolve(); await createGate.promise },
    onGenerate: async () => { genReached.resolve(); await genGate.promise },
  })
  hA.qq.disconnect()
  const sendReached = Promise.withResolvers()
  const sendGate = Promise.withResolvers()
  t.after(() => sendGate.resolve())
  const origSendA = hA.gateway.send.bind(hA.gateway)
  hA.gateway.send = async (...args) => { sendReached.resolve(); await sendGate.promise; return origSendA(...args) }

  assert.equal(hA.hub.isDefaultQqTransportIdle(), true)
  const routeA = hA.hub.resolveSharedProactiveRoute({ record: false })
  const pushA = hA.hub.pushProactiveToSession(null, [{ type: 'text', text: '场景A' }], '', { route: routeA })
  await createReached.promise
  assert.equal(hA.hub.isDefaultQqTransportIdle(), false, 'ensure 创建会话阶段必须持有 defaultQqWork')
  createGate.resolve()
  await genReached.promise
  assert.equal(hA.hub.isDefaultQqTransportIdle(), false, '模型生成阶段必须持有 defaultQqWork')
  genGate.resolve()
  await sendReached.promise
  assert.equal(hA.hub.isDefaultQqTransportIdle(), false, '即使实际向 feishu 投递也必须持续持有 defaultQqWork')
  sendGate.resolve()
  assert.equal((await pushA).delivered, true)
  assert.equal(hA.hub.isDefaultQqTransportIdle(), true)

  // 场景 C：QQ 迁移暂停托管期间（即使 feishu 在线且可回退），预览与触发都必须返回 qq-ownership-paused
  hA.hub.setDefaultQqTransportPaused(true)
  const pausedPreview = hA.hub.resolveSharedProactiveRoute({ record: false })
  assert.equal(pausedPreview?.deferred, true)
  assert.equal(pausedPreview?.reason, 'qq-ownership-paused')
  const pausedPush = await hA.hub.pushProactiveToSession(null, [{ type: 'text', text: '迁移暂停期' }], '', {
    route: { chatId: 'feishu:private:ou_owner', fallbackUsed: true },
  })
  assert.equal(pausedPush.deferred, true)
  assert.equal(pausedPush.reason, 'qq-ownership-paused')
  assert.equal(hA.feishu.sent.length, 1, '迁移暂停期间不得经共享主动链路发消息')

  // 场景 B：共享主账号为 feishu，回退到默认 qq -> 同样在生成和投递阶段持有 defaultQqWork
  const genGateB = Promise.withResolvers()
  const genReachedB = Promise.withResolvers()
  t.after(() => genGateB.resolve())
  const hB = await setupSharedProactiveHarness(t, {
    primary: { platform: 'feishu', instance: 'feishu', account: 'ou_owner' },
    fallbackOrder: [{ platform: 'qq', instance: 'qq', account: '10001' }],
    onGenerate: async () => { genReachedB.resolve(); await genGateB.promise },
  })
  hB.feishu.disconnect()
  const sendReachedB = Promise.withResolvers()
  const sendGateB = Promise.withResolvers()
  t.after(() => sendGateB.resolve())
  const origSendB = hB.gateway.send.bind(hB.gateway)
  hB.gateway.send = async (...args) => { sendReachedB.resolve(); await sendGateB.promise; return origSendB(...args) }

  const routeB = hB.hub.resolveSharedProactiveRoute({ record: false })
  assert.equal(routeB?.chatId, 'qq:private:10001')
  const pushB = hB.hub.pushProactiveToSession(null, [{ type: 'text', text: '场景B' }], '', { route: routeB })
  await genReachedB.promise
  assert.equal(hB.hub.isDefaultQqTransportIdle(), false, '回退投递目标为默认 qq 时生成阶段必须持有 defaultQqWork')
  genGateB.resolve()
  await sendReachedB.promise
  assert.equal(hB.hub.isDefaultQqTransportIdle(), false, '回退向默认 qq 投递阶段必须持有 defaultQqWork')
  sendGateB.resolve()
  assert.equal((await pushB).delivered, true)
  assert.equal(hB.hub.isDefaultQqTransportIdle(), true)
})

async function setupSharedMemoryHarness(t, {
  primary = { platform: 'qq', instance: 'qq', account: '10001' },
  primaryIsDefault = true,
  cfgPatch = {},
  sessionsSeed = null,
  qqHistory = [],
  feishuHistory = [],
  onBeforeEnd = null,
  turnFailNext = () => false,
  steerRejectNext = () => false,
  preStepRejectNext = () => false,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-shared-mem-'))
  const prevDir = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const log = { info() {}, debug() {}, warn() {}, error() {}, child() { return this } }
  const id = createIdentity({ dataDir: join(dir, 'identity'), log })
  const ownerId = id.claimOwner(primary.platform, primary.account)
  if (primary.platform !== 'feishu') id.link('feishu', 'ou_owner', ownerId, 'owner')
  if (primary.platform !== 'qq' && primaryIsDefault) id.link('qq', '10001', ownerId, 'owner')

  if (sessionsSeed) {
    writeFileSync(join(dir, 'sessions.json'), JSON.stringify(sessionsSeed(ownerId), null, 2))
  }

  let cfg = normalize({
    enabled: true,
    dryRun: false,
    setupDone: true,
    ownerLevel: 'social',
    ownerPersonId: ownerId,
    ownerQQ: primary.platform === 'qq' ? primary.account : '',
    ownerAuthorization: { owner: ownerId, revision: '22222222-3333-4444-8555-666666666666' },
    multiPlatformPrivateSession: true,
    ownerPrimary: primary,
    platforms: { qq: { enabled: true }, feishu: { enabled: true } },
    voice: { enabled: false, autoChance: 0 },
    stickers: { enabled: false, autoChance: 0 },
    merge: { enabled: false },
    chat: { thinkingGuard: { enabled: false }, ...(cfgPatch.chat || {}) },
    ...cfgPatch,
  })

  const gateway = createGateway({ config: cfg, dataDir: (...p) => join(dir, ...p), identity: id, log })
  const historyCalls = []
  const qq = makeFakeAdapter({
    id: 'qq',
    self: { account: '20001' },
    caps: { history: true, proactive: 'free', features: { 'message.history.read': true } },
  })
  qq.fetch = async (req) => {
    if (req.kind === 'history') {
      historyCalls.push({ platform: 'qq', req })
      return { messages: qqHistory, hasMore: false }
    }
    return null
  }
  const feishu = makeFakeAdapter({
    id: 'feishu',
    self: { account: 'ou_bot_feishu' },
    caps: { history: true, proactive: 'free', features: { 'message.history.read': true } },
  })
  feishu.fetch = async (req) => {
    if (req.kind === 'history') {
      historyCalls.push({ platform: 'feishu', req })
      return { messages: feishuHistory, hasMore: false }
    }
    return null
  }
  gateway.register(() => qq)
  gateway.register(() => feishu)
  await gateway.sync()

  const listeners = new Map()
  const emit = (name, ...args) => { for (const fn of listeners.get(name) || []) fn(...args) }
  const agents = new Map()
  let createSeq = 0
  let forkSeq = 0
  const capturedFollowups = []
  const capturedSteers = []

  function makeAgent(sessionId) {
    let dshTurn = 0
    let seqCounter = 0
    let idleChain = Promise.resolve()
    const pendingSteers = []
    const session = {
      id: sessionId,
      seq: 0,
      inheritedEventCount: 0,
      events: [],
      isOwnSeq: () => true,
      eventAt: (i) => session.events[i],
      snapshotEvents: () => session.events,
    }
    const agent = {
      id: sessionId,
      session,
      inbox: { nextTurn: [], nextStep: [], remove: () => false },
      cancel() {},
      ctx: {
        tools: { register: () => () => {}, restrict: () => () => {} },
        systemPrompt: { context: () => () => {} },
      },
      whenIdle: () => idleChain,
      steer(msg) {
        capturedSteers.push({ sessionId, msg })
        if (steerRejectNext()) throw new Error('steer rejected')
        pendingSteers.push(msg)
      },
      followup(msg) {
        capturedFollowups.push({ sessionId, msg })
        idleChain = idleChain.then(async () => {
          dshTurn++
          const myTurn = dshTurn
          let step = 1
          let emittedSteps = 0
          const emitAssistant = (text, stepNum) => {
            const s = Number.isFinite(stepNum) ? stepNum : Math.max(step, ++emittedSteps)
            emittedSteps = Math.max(emittedSteps, s)
            emit('session/event', session, {
              type: 'assistant/message',
              data: { turn: myTurn, step: s, message: { content: [{ type: 'text', text }] } },
            })
          }
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
          let turnCtrl = null
          if (onBeforeEnd) turnCtrl = await onBeforeEnd({ agent, session, myTurn, msg, emitAssistant })
          let blockedByPreStep = false
          while (pendingSteers.length) {
            const sm = pendingSteers.shift()
            step++
            emit('agent/inbox/claimed', { agent, message: sm, turn: myTurn })
            for (const fn of listeners.get('agent/pre-step') || []) {
              const res = await fn(
                { agent, messages: [sm], turn: myTurn, step, signal: new AbortController().signal },
                async () => (preStepRejectNext({ step, turn: myTurn, message: sm })
                  ? { kind: 'reject' }
                  : { kind: 'allow', messages: [sm] }),
              )
              if (res?.kind === 'reject') blockedByPreStep = true
            }
          }
          const shouldFail = turnFailNext()
          const endReason = blockedByPreStep ? 'blocked' : (shouldFail ? 'failed' : 'completed')
          const endSeq = seqCounter++
          session.seq = endSeq + 1
          session.events[endSeq] = { type: 'turn/end', seq: endSeq, data: { turn: myTurn, reason: { kind: endReason } } }
          if (!shouldFail && !blockedByPreStep && !turnCtrl?.skipFinalAssistant) {
            emitAssistant(turnCtrl?.finalText ?? `回复第${myTurn}轮`, Math.max(step, emittedSteps + 1))
          }
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
    title: 'Aurabot · Shared',
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
    workspaceRegistry: { list: () => [wsObj], get: (idKey) => (idKey === wsObj.id ? wsObj : null), create: async () => wsObj, archiveSession: async () => {}, archivedSessionIds: [], unarchiveSession: async () => {} },
    llm: {
      async *stream() {
        yield { type: 'text-delta', text: '[]' }
        yield { type: 'finish', reason: { kind: 'completed' } }
      },
    },
    services: {
      sessionProjections: {},
      sessionController: {
        create: async () => {
          const sid = `s-shared-new-${++createSeq}`
          makeAgent(sid)
          return { sessionId: sid }
        },
        resolveAgent: async (idKey) => ({ agent: agents.get(idKey) || makeAgent(idKey) }),
        fork: async (baseSid) => {
          const sid = `s-shared-fork-${++forkSeq}-${baseSid}`
          makeAgent(sid)
          return { sessionId: sid }
        },
        rename: async () => {},
      },
    },
  }

  let promptHook = null
  const createRuntime = (customPromptHook = null) => {
    promptHook = customPromptHook
    const hub = createHub({
      dsh,
      getConfig: () => cfg,
      log,
      gateway,
      identity: id,
      resolveSharedPrimary: () => fixedSharedPrimary({ cfg, identity: id, instances: gateway.instances() }),
      hooks: { prompt: (content, info) => (promptHook ? promptHook(content, info) : content) },
    })
    const offSession = dsh.on('session/event', hub.onSessionEvent)
    const submitted = []
    const offGw = gateway.onMessage((m) => { submitted.push(hub.onGatewayMessage(m)) })
    return {
      hub,
      submitted,
      setPromptHook: (fn) => { promptHook = fn },
      stopRuntime: () => { offGw(); offSession(); hub.dispose() },
    }
  }

  let runtime = createRuntime()
  t.after(async () => {
    runtime.stopRuntime()
    await gateway.stopAll()
    id.close?.()
    if (prevDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prevDir
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })

  const deliverInbound = async (adapter, { chatId, account, text, msgId }) => {
    const idx = runtime.submitted.length
    adapter.pushInbound({
      messageId: msgId,
      chat: { kind: 'private', id: chatId },
      sender: { account, name: '主人' },
      parts: [{ type: 'text', text }],
    })
    for (let i = 0; i < 100 && runtime.submitted.length <= idx; i++) await new Promise((r) => setTimeout(r, 10))
    assert.ok(runtime.submitted[idx], `gateway 未投递 ${msgId}`)
    await runtime.submitted[idx]
  }

  return {
    dir,
    id,
    ownerId,
    cfg,
    dsh,
    qq,
    feishu,
    log,
    historyCalls,
    capturedFollowups,
    capturedSteers,
    get runtime() { return runtime },
    restartRuntime: () => {
      runtime.stopRuntime()
      runtime = createRuntime(promptHook)
      return runtime
    },
    deliverInbound,
  }
}

test('共享会话补齐 hooks.prompt 参数（queryText/prevText/speakers/recentMessages）并触发真实 memory 召回', async (t) => {
  const h = await setupSharedMemoryHarness(t, {
    cfgPatch: {
      conversationContext: { enabled: false },
      memory: { enabled: true },
    },
  })
  const memory = createMemoryStore({ dsh: h.dsh, getConfig: () => h.cfg, hub: h.runtime.hub, log: h.log, identity: h.id })
  memory.add({ text: '主人喝手冲咖啡固定用八十八度水温', about: h.ownerId, chatId: 'qq:private:10001' })

  const hookInfos = []
  h.runtime.setPromptHook(async (content, info) => {
    hookInfos.push({
      queryText: info.queryText,
      prevText: info.prevText,
      speakers: info.speakers,
      sessionId: info.sessionId,
      recentMessages: info.recentMessages,
    })
    const hint = await memory.recallHintAsync(info.chat, info.queryText || '', info.prevText || '', info.sessionId, info.speakers || [], [])
    return hint ? [{ type: 'text', text: hint }, ...content] : content
  })

  await h.deliverInbound(h.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '今天想聊下手冲咖啡的参数', msgId: 'mem_t1' })
  assert.equal(h.runtime.hub.sharedStatus().state, 'active')
  assert.equal(existsSync(join(h.dir, 'conversation-context')), false)
  assert.equal(hookInfos.length, 1)
  assert.match(hookInfos[0].queryText, /手冲咖啡/)
  assert.equal(hookInfos[0].prevText, '')
  assert.deepEqual(hookInfos[0].speakers, ['ou_owner'])
  assert.deepEqual(hookInfos[0].recentMessages, [])
  assert.match(hookInfos[0].sessionId, /^s-shared-/)
  const prompt1 = h.capturedFollowups[0].msg.content.map((b) => b.text).join('\n')
  assert.match(prompt1, /八十八度水温/, '共享会话第 1 轮应注入按消息召回的 memory hint')

  // 第 2 轮来自 QQ，上一轮通过 sharedPrevText 保留了上一句供短句召回使用
  await h.deliverInbound(h.qq, { chatId: '10001', account: '10001', text: '那用几号滤杯', msgId: 'mem_t2' })
  assert.equal(hookInfos.length, 2)
  assert.match(hookInfos[1].prevText, /手冲咖啡/, '跨共享轮次必须保留 prevText')
  assert.match(hookInfos[1].queryText, /滤杯/)
  assert.deepEqual(hookInfos[1].speakers, ['10001'])
})

test('共享会话 conversationContext 注入近期/召回片段并双端写回同一档案，失败轮次与跨平台隔离成立', async (t) => {
  let failTurn = false
  const h = await setupSharedMemoryHarness(t, {
    cfgPatch: { conversationContext: { enabled: true } },
    turnFailNext: () => failTurn,
  })
  const hookInfos = []
  h.runtime.setPromptHook((content, info) => {
    hookInfos.push({ recentMessages: info.recentMessages, queryText: info.queryText })
    return content
  })

  // Turn 1: 飞书说话 -> 写回 qq 主账号对应的共享档案（user + assistant）
  await h.deliverInbound(h.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '手冲水温约定用八十八度', msgId: 'ctx_1' })
  assert.equal(h.runtime.hub.sharedStatus().state, 'active')
  assert.equal(existsSync(join(h.dir, 'conversation-context')), true)
  const recAfter1 = h.runtime.hub.recentMessagesOf('qq:private:10001')
  assert.equal(recAfter1.length, 2)
  assert.equal(recAfter1[0].role, 'user')
  assert.match(recAfter1[0].text, /八十八度/)
  assert.equal(recAfter1[0].speakerId, 'ou_owner')
  assert.equal(recAfter1[1].role, 'assistant')
  assert.match(recAfter1[1].text, /回复第1轮/)

  // Turn 2: QQ 继续说话 -> hook.recentMessages 收到飞书第 1 轮档案；再写回超过 12 条压入旧片段后跨重启可召回
  await h.deliverInbound(h.qq, { chatId: '10001', account: '10001', text: '那明天试试看', msgId: 'ctx_2' })
  assert.ok(hookInfos[1].recentMessages.some((m) => /八十八度/.test(m.text)))

  for (let i = 0; i < 18; i++) {
    await h.deliverInbound(i % 2 === 0 ? h.feishu : h.qq, {
      chatId: i % 2 === 0 ? 'ou_owner' : '10001',
      account: i % 2 === 0 ? 'ou_owner' : '10001',
      text: `日常闲聊盆栽浇水第${i}轮`,
      msgId: `ctx_fill_${i}`,
    })
  }
  const reopened = h.restartRuntime()
  await h.deliverInbound(h.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '手冲水温约定是多少', msgId: 'ctx_recall_q' })
  const recallPrompt = h.capturedFollowups.at(-1).msg.content.map((b) => b.text).join('\n')
  assert.match(recallPrompt, /【同一人格、同一聊天的对话资料/, '共享会话应注入 conversationArchive 检索结果')
  assert.match(recallPrompt, /八十八度/)
  assert.match(recallPrompt, /"source":"new_conversation"/)

  // 失败轮次绝不能写入档案
  failTurn = true
  const countBeforeFail = reopened.hub.recentMessagesOf('qq:private:10001', 256).length
  await h.deliverInbound(h.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '这句失败不应进档案', msgId: 'ctx_fail' })
  failTurn = false
  assert.equal(reopened.hub.recentMessagesOf('qq:private:10001', 256).length, countBeforeFail)

  // 非默认主账号（例如飞书为主账号）同样能使用规范 ChatId 写入并召回档案
  const hNonDefault = await setupSharedMemoryHarness(t, {
    primary: { platform: 'feishu', instance: 'feishu', account: 'ou_owner' },
    primaryIsDefault: false,
    cfgPatch: { conversationContext: { enabled: true } },
  })
  await hNonDefault.deliverInbound(hNonDefault.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '非默认主账号飞书档案测试', msgId: 'nd_1' })
  assert.equal(hNonDefault.runtime.hub.sharedStatus().state, 'active')
  const ndRecent = hNonDefault.runtime.hub.recentMessagesOf('feishu:private:ou_owner')
  assert.equal(ndRecent.length, 2)
  assert.match(ndRecent[0].text, /非默认主账号飞书档案测试/)
})

test('共享会话 seedHistoryOnce 边界：fork 分支不重复补历史；空分支仅首次补且重启不重复', async (t) => {
  // 1) inherit + baseSessionId（fork 普通会话历史） -> 不应调 gateway history
  const hFork = await setupSharedMemoryHarness(t, {
    cfgPatch: { chat: { seedHistory: true, seedHistoryCount: 5, thinkingGuard: { enabled: false } } },
    qqHistory: [{ messageId: 'qq_h1', sender: { account: '10001', name: '主人' }, at: 1700000000000, parts: [{ type: 'text', text: '普通会话已有历史' }] }],
    sessionsSeed: (ownerId) => ({
      chats: {
        'private:10001': {
          sessionId: 'base-qq-live',
          mode: 'live',
          level: 'social',
          preset: 'aurabot-social',
          sessions: { live: 'base-qq-live' },
          sessionOwners: {
            live: {
              sessionId: 'base-qq-live',
              ownerPersonId: ownerId,
              ownerAuthorizationRevision: '22222222-3333-4444-8555-666666666666',
              level: 'social',
              preset: 'aurabot-social',
            },
          },
        },
      },
    }),
  })
  await hFork.deliverInbound(hFork.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: 'fork 后的第一句', msgId: 'seed_fork_1' })
  assert.equal(hFork.runtime.hub.sharedStatus().state, 'active')
  assert.equal(hFork.historyCalls.length, 0, '已继承主账号历史的 fork 分支不得重复 seedHistory')
  assert.doesNotMatch(hFork.capturedFollowups[0].msg.content.map((b) => b.text).join('\n'), /你刚上线，先补看最近/)

  // 2) 空新分支（无 baseSessionId，verifiedThroughSeq === null） -> Turn 1 补历史；Turn 2 与重启后均不重复补
  const hEmpty = await setupSharedMemoryHarness(t, {
    cfgPatch: { chat: { seedHistory: true, seedHistoryCount: 5, thinkingGuard: { enabled: false } } },
    qqHistory: [{ messageId: 'qq_h_empty_1', sender: { account: '10001', name: '主人' }, at: 1700000000000, parts: [{ type: 'text', text: '冷启动补历史条目' }] }],
  })
  await hEmpty.deliverInbound(hEmpty.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '新空分支第一句', msgId: 'seed_empty_1' })
  assert.equal(hEmpty.runtime.hub.sharedStatus().state, 'active')
  assert.equal(hEmpty.historyCalls.length, 1, '空新建分支首次应调用一次 history 补看')
  const seededPrompt = hEmpty.capturedFollowups[0].msg.content.map((b) => b.text).join('\n')
  assert.match(seededPrompt, /你刚上线，先补看最近 1 条私聊记录/)
  assert.match(seededPrompt, /冷启动补历史条目/)

  await hEmpty.deliverInbound(hEmpty.qq, { chatId: '10001', account: '10001', text: '同进程第二句', msgId: 'seed_empty_2' })
  assert.equal(hEmpty.historyCalls.length, 1, '同进程第二轮不得重复补看')

  // 重启后恢复（branch.verifiedThroughSeq >= 0）同样不得重新补看
  hEmpty.restartRuntime()
  await hEmpty.deliverInbound(hEmpty.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '重启恢复后第一句', msgId: 'seed_empty_3' })
  assert.equal(hEmpty.historyCalls.length, 1, '恢复已有核验检查点的分支不得重复 seedHistory')

  // 3) 显式重置为 historyPolicy='empty' -> 即使开启 seedHistory 也不得把旧历史再补回来
  hEmpty.runtime.hub.resetSessions()
  const afterResetSessions = JSON.parse(readFileSync(join(hEmpty.dir, 'sessions.json'), 'utf8'))
  assert.equal(afterResetSessions.multiPrivate.sessions.live.historyPolicy, 'empty')
  await hEmpty.deliverInbound(hEmpty.qq, { chatId: '10001', account: '10001', text: '重置后的第一句', msgId: 'seed_empty_after_reset' })
  assert.equal(hEmpty.runtime.hub.sharedStatus().state, 'active')
  assert.equal(hEmpty.historyCalls.length, 1, 'historyPolicy=empty 的重置分支不得调用 seedHistory')
  const postResetPrompt = hEmpty.capturedFollowups.at(-1).msg.content.map((b) => b.text).join('\n')
  assert.doesNotMatch(postResetPrompt, /你刚上线，先补看最近/)
  assert.doesNotMatch(postResetPrompt, /冷启动补历史条目/)
})

test('共享会话同源 steer 透传当前 prevText/queryText 并写入 conversationArchive', async (t) => {
  const turnGate = Promise.withResolvers()
  const enteredGate = Promise.withResolvers()
  let holdFirst = true
  t.after(() => turnGate.resolve())

  const h = await setupSharedMemoryHarness(t, {
    cfgPatch: { conversationContext: { enabled: true } },
    onBeforeEnd: async () => {
      if (holdFirst) {
        holdFirst = false
        enteredGate.resolve()
        await turnGate.promise
      }
    },
  })

  const hookInfos = []
  h.runtime.setPromptHook((content, info) => {
    hookInfos.push({ queryText: info.queryText, prevText: info.prevText, speakers: info.speakers })
    return content
  })

  const p1 = h.deliverInbound(h.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '第一句主需求', msgId: 'st_1' })
  await enteredGate.promise
  const p2 = h.deliverInbound(h.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '补充第二句条件', msgId: 'st_2' })
  for (let i = 0; i < 100 && h.capturedSteers.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
  assert.equal(h.runtime.hub.sharedStatus().state, 'active')
  assert.equal(h.capturedSteers.length, 1, '同源第二句应通过 steer 插入活跃共享轮次')
  assert.equal(hookInfos.length, 2)
  assert.match(hookInfos[1].queryText, /补充第二句条件/)
  assert.match(hookInfos[1].prevText, /第一句主需求/)

  turnGate.resolve()
  await Promise.all([p1, p2])

  const saved = h.runtime.hub.recentMessagesOf('qq:private:10001')
  assert.ok(saved.some((m) => m.role === 'user' && /第一句主需求/.test(m.text)))
  assert.ok(saved.some((m) => m.role === 'user' && /补充第二句条件/.test(m.text)))
  assert.ok(saved.some((m) => m.role === 'assistant' && /回复第1轮/.test(m.text)))
})

test('共享会话升级兼容：旧版默认 QQ 裸键 private:<id> 档案可被多平台共享会话无缝读取、召回与续写', async (t) => {
  const h = await setupSharedMemoryHarness(t, {
    cfgPatch: { conversationContext: { enabled: true } },
  })
  const legacyArchive = createConversationArchive({
    directory: join(h.dir, 'conversation-context'),
    namespace: h.cfg.persona?.current || 'default',
  })
  const baseAt = Date.now() - 120_000
  legacyArchive.append('private:10001', {
    role: 'user',
    text: '升级前旧档案约定每周五吃火锅',
    id: 'legacy_u1',
    speakerId: '10001',
    at: baseAt,
  })
  legacyArchive.append('private:10001', {
    role: 'assistant',
    text: '好呀，记着每周五一起吃火锅。',
    id: 'legacy_a1',
    speakerId: '20001',
    at: baseAt + 10_000,
  })

  const hookInfos = []
  const reopened = h.restartRuntime()
  reopened.setPromptHook((content, info) => {
    hookInfos.push({ recentMessages: info.recentMessages, queryText: info.queryText })
    return content
  })

  await h.deliverInbound(h.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '明天周五吃什么呀', msgId: 'upg_1' })
  assert.equal(reopened.hub.sharedStatus().state, 'active')
  assert.ok(hookInfos[0].recentMessages.some((m) => m.id === 'legacy_u1' && /每周五吃火锅/.test(m.text)))

  const promptText = h.capturedFollowups[0].msg.content.map((b) => b.text).join('\n')
  assert.match(promptText, /【同一人格、同一聊天的对话资料/)
  assert.match(promptText, /每周五吃火锅/)

  const byCanonical = reopened.hub.recentMessagesOf('qq:private:10001')
  const byLegacy = reopened.hub.recentMessagesOf('private:10001')
  assert.deepEqual(byCanonical, byLegacy)
  assert.ok(byCanonical.some((m) => m.id === 'legacy_u1' && /每周五吃火锅/.test(m.text)))
  assert.ok(byCanonical.some((m) => m.role === 'user' && m.speakerId === 'ou_owner' && /周五吃什么/.test(m.text)))
  assert.ok(byCanonical.some((m) => m.role === 'assistant' && /回复第1轮/.test(m.text)))
})

test('共享会话升级兼容：旧键 qq:private:<id> 档案回退读取、召回与续写', async (t) => {
  const h = await setupSharedMemoryHarness(t, {
    cfgPatch: { conversationContext: { enabled: true } },
  })
  const prefixedWriter = createConversationArchive({
    directory: join(h.dir, 'conversation-context'),
    namespace: h.cfg.persona?.current || 'default',
  })
  const baseAt = Date.now() - 120_000
  prefixedWriter.append('qq:private:10001', {
    role: 'user',
    text: '旧版qq前缀档案约定周六去看展',
    id: 'prefixed_u1',
    speakerId: '10001',
    at: baseAt,
  })
  prefixedWriter.append('qq:private:10001', {
    role: 'assistant',
    text: '好呀，周六一起去看展。',
    id: 'prefixed_a1',
    speakerId: '20001',
    at: baseAt + 10_000,
  })

  const hookInfos = []
  const reopened = h.restartRuntime()
  reopened.setPromptHook((content, info) => {
    hookInfos.push({ recentMessages: info.recentMessages, queryText: info.queryText })
    return content
  })

  await h.deliverInbound(h.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '周六去干嘛呀', msgId: 'pfx_upg_1' })
  assert.equal(reopened.hub.sharedStatus().state, 'active')
  assert.ok(hookInfos[0].recentMessages.some((m) => m.id === 'prefixed_u1' && /周六去看展/.test(m.text)))

  const promptText = h.capturedFollowups[0].msg.content.map((b) => b.text).join('\n')
  assert.match(promptText, /【同一人格、同一聊天的对话资料/)
  assert.match(promptText, /周六去看展/)

  const byCanonical = reopened.hub.recentMessagesOf('qq:private:10001')
  const byLegacy = reopened.hub.recentMessagesOf('private:10001')
  assert.deepEqual(byCanonical, byLegacy)
  assert.ok(byCanonical.some((m) => m.id === 'prefixed_u1' && /周六去看展/.test(m.text)))
  assert.ok(byCanonical.some((m) => m.role === 'user' && m.speakerId === 'ou_owner' && /周六去干嘛/.test(m.text)))
  assert.ok(byCanonical.some((m) => m.role === 'assistant' && /回复第1轮/.test(m.text)))

  // 重启后新写入的 private:10001 与只读回退的 qq:private:10001 仍完整合并
  const restartedAgain = h.restartRuntime()
  const persisted = restartedAgain.hub.recentMessagesOf('qq:private:10001')
  assert.ok(persisted.some((m) => m.id === 'prefixed_u1' && /周六去看展/.test(m.text)))
  assert.ok(persisted.some((m) => m.role === 'user' && m.speakerId === 'ou_owner' && /周六去干嘛/.test(m.text)))
  assert.ok(persisted.some((m) => m.role === 'assistant' && /回复第1轮/.test(m.text)))
})

test('sharedReplyOnSteer：默认关闭与无插入只发最终回复；开启且插入时补发已生成中间段（含失败隔离/多段去重/everyStep/普通会话隔离）', async (t) => {
  // 1) sharedReplyOnSteer=false + steer -> 只发最终回复
  {
    const turnGate = Promise.withResolvers()
    const enteredGate = Promise.withResolvers()
    let holdFirst = true
    t.after(() => turnGate.resolve())
    const h = await setupSharedMemoryHarness(t, {
      cfgPatch: { sharedReplyOnSteer: false },
      onBeforeEnd: async ({ emitAssistant }) => {
        if (holdFirst) {
          holdFirst = false
          emitAssistant('插话前已生成的过程回复', 1)
          enteredGate.resolve()
          await turnGate.promise
        }
        return { finalText: '只发这一条最终回复' }
      },
    })
    assert.equal(h.runtime.hub.sharedStatus().replyOnSteer, false)
    const p1 = h.deliverInbound(h.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '第一条', msgId: 'ros_off_1' })
    await enteredGate.promise
    const p2 = h.deliverInbound(h.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '补一句', msgId: 'ros_off_2' })
    for (let i = 0; i < 100 && h.capturedSteers.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(h.capturedSteers.length, 1)
    assert.equal(h.feishu.sent.length, 0)
    turnGate.resolve()
    await Promise.all([p1, p2])
    assert.equal(h.feishu.sent.length, 1)
    assert.equal(h.feishu.sent[0].payload.parts[0].text, '只发这一条最终回复')
  }

  // 2) sharedReplyOnSteer=true + steer -> 先发已生成中间段再发最终回复（顺序与 inResponseTo 正确），且中间段失败不阻断最终回复
  {
    const turnGate = Promise.withResolvers()
    const enteredGate = Promise.withResolvers()
    let holdFirst = true
    t.after(() => turnGate.resolve())
    const h = await setupSharedMemoryHarness(t, {
      cfgPatch: { sharedReplyOnSteer: true },
      onBeforeEnd: async ({ emitAssistant, myTurn }) => {
        if (myTurn === 1 && holdFirst) {
          holdFirst = false
          emitAssistant('先帮你看一眼进展', 1)
          enteredGate.resolve()
          await turnGate.promise
          return { finalText: '这是结合补充后的最终回复' }
        }
        if (myTurn === 2) {
          emitAssistant('第二轮先说一句', 1)
          await new Promise((r) => setTimeout(r, 30))
          return { finalText: '第二轮最终答复' }
        }
        return null
      },
    })
    assert.equal(h.runtime.hub.sharedStatus().replyOnSteer, true)
    assert.equal(h.runtime.hub.sharedStatus().replyOnSteerMode, 'all')
    const p1 = h.deliverInbound(h.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '查一下进度', msgId: 'ros_on_1' })
    await enteredGate.promise
    const p2 = h.deliverInbound(h.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '顺便看昨天记录', msgId: 'ros_on_2' })
    for (let i = 0; i < 100 && h.capturedSteers.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    // 严格在 shared-turn-guard onAccepted 后才补发，steer 提交阶段尚未发出
    assert.equal(h.feishu.sent.length, 0)
    turnGate.resolve()
    await Promise.all([p1, p2])
    assert.equal(h.feishu.sent.length, 2)
    assert.deepEqual(
      h.feishu.sent.map((x) => ({ text: x.payload.parts[0].text, inResponseTo: x.payload.inResponseTo })),
      [
        { text: '先帮你看一眼进展', inResponseTo: 'ros_on_1' },
        { text: '这是结合补充后的最终回复', inResponseTo: 'ros_on_1' },
      ],
    )

    // 2b) sharedReplyOnSteerMode='first' 只补发本轮第一条未发回复，同轮后续不再补发过程话
    const firstModeGate = Promise.withResolvers()
    const firstModeEntered = Promise.withResolvers()
    const hFirst = await setupSharedMemoryHarness(t, {
      cfgPatch: { sharedReplyOnSteer: true, sharedReplyOnSteerMode: 'first' },
      onBeforeEnd: async ({ emitAssistant }) => {
        emitAssistant('首条模式第一段回复', 1)
        emitAssistant('首条模式过程补充话', 2)
        firstModeEntered.resolve()
        await firstModeGate.promise
        return { finalText: '首条模式最终回复' }
      },
    })
    t.after(() => firstModeGate.resolve())
    assert.equal(hFirst.runtime.hub.sharedStatus().replyOnSteerMode, 'first')
    const fm1 = hFirst.deliverInbound(hFirst.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '问一句', msgId: 'ros_fm_1' })
    await firstModeEntered.promise
    const fm2 = hFirst.deliverInbound(hFirst.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '插话1', msgId: 'ros_fm_2' })
    const fm3 = hFirst.deliverInbound(hFirst.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '插话2', msgId: 'ros_fm_3' })
    for (let i = 0; i < 100 && hFirst.capturedSteers.length < 2; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(hFirst.feishu.sent.length, 0)
    firstModeGate.resolve()
    await Promise.all([fm1, fm2, fm3])
    assert.deepEqual(
      hFirst.feishu.sent.map((x) => ({ text: x.payload.parts[0].text, inResponseTo: x.payload.inResponseTo })),
      [
        { text: '首条模式第一段回复', inResponseTo: 'ros_fm_1' },
        { text: '首条模式最终回复', inResponseTo: 'ros_fm_1' },
      ],
    )

    // 中间段发送失败时记 lastDeliveryFailure，但不阻断最终回复
    const turn2Gate = Promise.withResolvers()
    const entered2Gate = Promise.withResolvers()
    const hFail = await setupSharedMemoryHarness(t, {
      cfgPatch: { sharedReplyOnSteer: true },
      onBeforeEnd: async ({ emitAssistant }) => {
        emitAssistant('这条补发会被平台限流拒绝', 1)
        entered2Gate.resolve()
        await turn2Gate.promise
        return { finalText: '最终回复依然发出' }
      },
    })
    t.after(() => turn2Gate.resolve())
    hFail.feishu.failNext('not-sent', 'reply-limit')
    const f1 = hFail.deliverInbound(hFail.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '首条', msgId: 'ros_part_1' })
    await entered2Gate.promise
    const f2 = hFail.deliverInbound(hFail.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '第二条', msgId: 'ros_part_2' })
    for (let i = 0; i < 100 && hFail.capturedSteers.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    turn2Gate.resolve()
    await Promise.all([f1, f2])
    assert.equal(hFail.feishu.sent.length, 1)
    assert.equal(hFail.feishu.sent[0].payload.parts[0].text, '最终回复依然发出')
    assert.equal(hFail.runtime.hub.sharedStatus().lastDeliveryFailure?.kind, 'reply')
    assert.equal(hFail.runtime.hub.sharedStatus().lastDeliveryFailure?.reason, 'reply-limit')
  }

  // 3) sharedReplyOnSteer=true 但无 steer -> 即使多段 assistant 也只发最终回复
  {
    const h = await setupSharedMemoryHarness(t, {
      cfgPatch: { sharedReplyOnSteer: true },
      onBeforeEnd: async ({ emitAssistant }) => {
        emitAssistant('过程段不应该发出去', 1)
        return { finalText: '无插入时唯一最终回复' }
      },
    })
    await h.deliverInbound(h.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '单句问候', msgId: 'ros_nosteer_1' })
    assert.equal(h.capturedSteers.length, 0)
    assert.equal(h.feishu.sent.length, 1)
    assert.equal(h.feishu.sent[0].payload.parts[0].text, '无插入时唯一最终回复')
  }

  // 4) steer 被拒绝 / 后续 guard pre-step 拒绝 / 超过上限 / prompt hook 拦截 / 跨 lane 到达 -> 都不补发
  {
    // 4a) steer 被拒绝
    const gate = Promise.withResolvers()
    const entered = Promise.withResolvers()
    let rejectSteer = true
    t.after(() => gate.resolve())
    const hRej = await setupSharedMemoryHarness(t, {
      cfgPatch: { sharedReplyOnSteer: true },
      steerRejectNext: () => rejectSteer,
      onBeforeEnd: async ({ emitAssistant, myTurn }) => {
        if (myTurn === 1) {
          emitAssistant('拒绝插话时不得提前发这段', 1)
          entered.resolve()
          await gate.promise
          return { finalText: '第1轮最终回复' }
        }
        return { finalText: '第2轮排队回复' }
      },
    })
    const p1 = hRej.deliverInbound(hRej.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '消息1', msgId: 'ros_rej_1' })
    await entered.promise
    const p2 = hRej.deliverInbound(hRej.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '消息2', msgId: 'ros_rej_2' })
    for (let i = 0; i < 100 && hRej.capturedSteers.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    await new Promise((r) => setTimeout(r, 40))
    assert.equal(hRej.feishu.sent.length, 0, 'steer 被拒绝时不得提前补发中间段')
    rejectSteer = false
    gate.resolve()
    await Promise.all([p1, p2])
    assert.deepEqual(
      hRej.feishu.sent.map((x) => x.payload.parts[0].text),
      ['第1轮最终回复', '第2轮排队回复'],
    )

    // 4e) steer 提交成功，但后续 agent/pre-step 被 guard 拒绝 -> 不得补发中间段，只发失败回执
    const guardGate = Promise.withResolvers()
    const guardEntered = Promise.withResolvers()
    t.after(() => guardGate.resolve())
    const hGuard = await setupSharedMemoryHarness(t, {
      cfgPatch: { sharedReplyOnSteer: true },
      preStepRejectNext: ({ step }) => step === 2,
      onBeforeEnd: async ({ emitAssistant }) => {
        emitAssistant('提交后被守卫拦截不得补发的草稿', 1)
        guardEntered.resolve()
        await guardGate.promise
        return { finalText: '被拦截不应到达' }
      },
    })
    const gP1 = hGuard.deliverInbound(hGuard.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '主需求', msgId: 'ros_g_1' })
    await guardEntered.promise
    const gP2 = hGuard.deliverInbound(hGuard.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '被后续guard拒绝的插话', msgId: 'ros_g_2' })
    for (let i = 0; i < 100 && hGuard.capturedSteers.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(hGuard.feishu.sent.length, 0)
    guardGate.resolve()
    await Promise.all([gP1, gP2])
    assert.equal(hGuard.feishu.sent.length, 1)
    assert.match(hGuard.feishu.sent[0].payload.parts[0].text, /请重新发送/)

    // 4b) 超上限 sharedSteerMaxPerTurn=1：第1条插入触发补发，第2条排队且不再额外触发补发；
    // 4c) prompt hook 返回 null：过滤拦截不触发补发；4d) 跨 lane 消息不触发补发
    const limGate = Promise.withResolvers()
    const limEntered = Promise.withResolvers()
    t.after(() => limGate.resolve())
    const hLim = await setupSharedMemoryHarness(t, {
      cfgPatch: { sharedReplyOnSteer: true, sharedSteerMaxPerTurn: 1 },
      onBeforeEnd: async ({ emitAssistant, myTurn }) => {
        if (myTurn === 1) {
          emitAssistant('第1次steer前段', 1)
          limEntered.resolve()
          await limGate.promise
          return { finalText: '限流第1轮最终' }
        }
        return { finalText: `排队后续${myTurn}` }
      },
    })
    let allowHook = true
    hLim.runtime.setPromptHook((content, info) => (allowHook || !/过滤掉的插话/.test(info.queryText || '') ? content : null))
    const l1 = hLim.deliverInbound(hLim.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '主句', msgId: 'ros_lim_1' })
    await limEntered.promise
    allowHook = false
    const lFiltered = hLim.deliverInbound(hLim.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '过滤掉的插话', msgId: 'ros_lim_filt' })
    await lFiltered
    assert.equal(hLim.feishu.sent.length, 0, 'prompt hook 返回 null 时不得补发')
    allowHook = true
    const l2 = hLim.deliverInbound(hLim.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '有效第1条steer', msgId: 'ros_lim_2' })
    for (let i = 0; i < 100 && hLim.capturedSteers.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    // 超出 maxPerTurn=1 的同源消息和跨 lane QQ 消息到达时都不再额外 steer，也不在 onAccepted 前发
    const l3 = hLim.deliverInbound(hLim.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '超限第2条steer', msgId: 'ros_lim_3' })
    const lCross = hLim.deliverInbound(hLim.qq, { chatId: '10001', account: '10001', text: '跨平台QQ消息', msgId: 'ros_lim_qq' })
    await new Promise((r) => setTimeout(r, 40))
    assert.equal(hLim.capturedSteers.length, 1)
    assert.equal(hLim.feishu.sent.length, 0)
    limGate.resolve()
    await Promise.all([l1, l2, l3, lCross])
    assert.deepEqual(
      hLim.feishu.sent.map((x) => x.payload.parts[0].text),
      ['第1次steer前段', '限流第1轮最终', '排队后续2'],
    )
    assert.deepEqual(hLim.qq.sent.map((x) => x.payload.parts[0].text), ['排队后续3'])
  }

  // 5) 多段 assistant 顺序补发（过滤空/[沉默]/连续重复）与 finalText 去重
  {
    const g1 = Promise.withResolvers()
    const e1 = Promise.withResolvers()
    t.after(() => g1.resolve())
    const hMulti = await setupSharedMemoryHarness(t, {
      cfgPatch: { sharedReplyOnSteer: true },
      onBeforeEnd: async ({ emitAssistant }) => {
        emitAssistant('', 1)
        emitAssistant('[沉默]', 2)
        emitAssistant('第一段回复', 3)
        emitAssistant('第一段回复', 4)
        emitAssistant('第二段回复', 5)
        e1.resolve()
        await g1.promise
        return { finalText: '第二段回复' }
      },
    })
    const m1 = hMulti.deliverInbound(hMulti.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '说说看', msgId: 'ros_m_1' })
    await e1.promise
    const m2 = hMulti.deliverInbound(hMulti.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '补充一下', msgId: 'ros_m_2' })
    for (let i = 0; i < 100 && hMulti.capturedSteers.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(hMulti.feishu.sent.length, 0)
    g1.resolve()
    await Promise.all([m1, m2])
    assert.deepEqual(
      hMulti.feishu.sent.map((x) => x.payload.parts[0].text),
      ['第一段回复', '第二段回复'],
      '多段应按顺序补发，且与 finalText 重复时不再二发',
    )
  }

  // 6) chat.everyStep=true 时不与 sharedReplyOnSteer 重复补发
  {
    const gate = Promise.withResolvers()
    const entered = Promise.withResolvers()
    t.after(() => gate.resolve())
    const hEvery = await setupSharedMemoryHarness(t, {
      cfgPatch: { sharedReplyOnSteer: true, chat: { everyStep: true, thinkingGuard: { enabled: false } } },
      onBeforeEnd: async ({ emitAssistant }) => {
        emitAssistant('分步第一段', 1)
        emitAssistant('分步第二段', 2)
        entered.resolve()
        await gate.promise
        return { finalText: '分步最终第三段' }
      },
    })
    const e1 = hEvery.deliverInbound(hEvery.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '开分步', msgId: 'ros_ev_1' })
    await entered.promise
    const e2 = hEvery.deliverInbound(hEvery.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '插话测试', msgId: 'ros_ev_2' })
    for (let i = 0; i < 100 && hEvery.capturedSteers.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    gate.resolve()
    await Promise.all([e1, e2])
    assert.deepEqual(
      hEvery.feishu.sent.map((x) => x.payload.parts[0].text),
      ['分步第一段', '分步第二段', '分步最终第三段'],
    )
  }

  // 7) 普通非共享私聊开启 sharedReplyOnSteer 不受影响（everyStep=false 只发最终回复）
  {
    const gate = Promise.withResolvers()
    const entered = Promise.withResolvers()
    let hold = true
    t.after(() => gate.resolve())
    const hOrd = await setupSharedMemoryHarness(t, {
      cfgPatch: {
        multiPlatformPrivateSession: false,
        sharedReplyOnSteer: true,
        chat: { everyStep: false, thinkingGuard: { enabled: false } },
      },
      onBeforeEnd: async ({ emitAssistant }) => {
        if (hold) {
          hold = false
          emitAssistant('普通会话中间过程话', 1)
          entered.resolve()
          await gate.promise
        }
        return { finalText: '普通会话最终回复' }
      },
    })
    const o1 = hOrd.deliverInbound(hOrd.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '普通1', msgId: 'ros_ord_1' })
    await entered.promise
    const o2 = hOrd.deliverInbound(hOrd.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '普通2', msgId: 'ros_ord_2' })
    await new Promise((r) => setTimeout(r, 40))
    assert.equal(hOrd.feishu.sent.length, 0, '普通会话不应受 sharedReplyOnSteer 影响而提前发中间段')
    gate.resolve()
    await Promise.all([o1, o2])
    for (let i = 0; i < 100 && hOrd.feishu.sent.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(hOrd.feishu.sent.length, 1)
    assert.equal(hOrd.feishu.sent[0].payload.parts[0].text, '普通会话最终回复')
  }
})

async function setupParentSessionCompatHarness(t, initialForkParentMode = 'omit') {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-parent-session-'))
  const prevDir = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const log = { info() {}, debug() {}, warn() {}, error() {}, child() { return this } }
  const id = createIdentity({ dataDir: join(dir, 'identity'), log })
  const ownerId = id.claimOwner('qq', '10001')
  id.link('feishu', 'ou_owner', ownerId, 'owner')

  const legacySid = 'ordinary-legacy-qq'
  writeFileSync(join(dir, 'sessions.json'), JSON.stringify({
    chats: {
      'private:10001': { sessionId: legacySid, level: 'social', preset: 'aurabot-social', title: '旧主人私聊' },
    },
  }))

  const cfg = normalize({
    enabled: true,
    dryRun: false,
    setupDone: true,
    ownerLevel: 'social',
    ownerPersonId: ownerId,
    ownerQQ: '10001',
    ownerAuthorization: { owner: ownerId, revision: '22222222-3333-4444-8555-666666666666' },
    multiPlatformPrivateSession: true,
    ownerPrimary: { mode: 'fixed', platform: 'qq', instance: 'qq', account: '10001' },
    platforms: { qq: { enabled: true }, feishu: { enabled: true } },
    workspaceDir: dir,
    voice: { enabled: false, autoChance: 0 },
    stickers: { enabled: false, autoChance: 0 },
    merge: { enabled: false },
    conversationContext: { enabled: false },
    chat: { thinkingGuard: { enabled: false } },
  })

  const gateway = createGateway({ config: cfg, dataDir: (...p) => join(dir, ...p), identity: id, log })
  const qq = makeFakeAdapter({ id: 'qq', self: { account: '20001' }, caps: { proactive: 'free' } })
  const feishu = makeFakeAdapter({ id: 'feishu', self: { account: 'ou_bot_feishu' }, caps: { proactive: 'free' } })
  gateway.register(() => qq)
  gateway.register(() => feishu)
  await gateway.sync()

  const listeners = new Map()
  const emit = (name, ...args) => { for (const fn of listeners.get(name) || []) fn(...args) }
  const agents = new Map()
  const sessions = new Map()
  let createSeq = 0
  let forkSeq = 0
  let forkParentMode = initialForkParentMode

  function buildAgent(sessionId, { header, inheritedEventCount = 0, events = [] }) {
    let dshTurn = 0
    let idleChain = Promise.resolve()
    const clonedEvents = structuredClone(events)
    const session = {
      id: sessionId,
      header: { ...header },
      seq: clonedEvents.length,
      inheritedEventCount,
      events: clonedEvents,
      isOwnSeq: (s) => s >= inheritedEventCount,
      eventAt: (i) => session.events[i],
      snapshotEvents: () => [...session.events],
    }
    sessions.set(sessionId, session)
    const agent = {
      id: sessionId,
      session,
      inbox: { nextTurn: [], nextStep: [], remove: () => false },
      cancel() {},
      ctx: {
        tools: { register: () => () => {}, restrict: () => () => {} },
        systemPrompt: { context: () => () => {} },
      },
      whenIdle: () => idleChain,
      followup(msg) {
        idleChain = idleChain.then(async () => {
          dshTurn++
          const myTurn = dshTurn
          emit('agent/inbox/claimed', { agent, message: msg, turn: myTurn })
          const splicedSeq = session.seq++
          session.events[splicedSeq] = { type: 'agent/inbox/spliced', seq: splicedSeq, data: { inserted: [{ id: msg.id }] } }
          emit('session/event', session, session.events[splicedSeq])
          for (const fn of listeners.get('agent/pre-step') || []) {
            await fn(
              { agent, messages: [msg], turn: myTurn, step: 1, signal: new AbortController().signal },
              async () => ({ kind: 'allow', messages: [msg] }),
            )
          }
          const endSeq = session.seq++
          session.events[endSeq] = { type: 'turn/end', seq: endSeq, data: { turn: myTurn, reason: { kind: 'completed' } } }
          emit('session/event', session, {
            type: 'assistant/message',
            data: { turn: myTurn, step: 1, message: { content: [{ type: 'text', text: `回复第${myTurn}轮` }] } },
          })
          emit('session/event', session, session.events[endSeq])
        })
        return idleChain
      },
    }
    agents.set(sessionId, agent)
    return agent
  }

  buildAgent(legacySid, {
    header: { id: legacySid, cwd: dir, agentPreset: 'aurabot-social', delegationDepth: 0 },
    inheritedEventCount: 0,
    events: [
      { type: 'user/message', seq: 0, time: 1000, data: { content: [{ type: 'text', text: '旧主人历史消息' }] } },
      { type: 'turn/end', seq: 1, time: 2000, data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  })

  const wsObj = {
    id: 'workspace',
    path: dir,
    title: 'Aurabot · Shared',
    sessionIds: [legacySid],
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
      list: () => [wsObj],
      get: (idKey) => (idKey === wsObj.id ? wsObj : null),
      create: async () => wsObj,
      archivedSessionIds: [],
      async archiveSession(sid) {
        if (!this.archivedSessionIds.includes(sid)) this.archivedSessionIds.push(sid)
      },
      async unarchiveSession(sid) {
        const idx = this.archivedSessionIds.indexOf(sid)
        if (idx >= 0) this.archivedSessionIds.splice(idx, 1)
      },
    },
    services: {
      sessionProjections: {},
      sessionQuery: {
        async observeSession(sid) {
          const s = sessions.get(sid)
          if (!s) throw Object.assign(new Error('session not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
          return {
            header: { ...s.header },
            events: structuredClone(s.events),
            persistedEventCount: s.events.length,
            [Symbol.dispose]() {},
          }
        },
      },
      sessionController: {
        create: async () => {
          const sid = `s-shared-new-${++createSeq}`
          buildAgent(sid, { header: { id: sid, cwd: dir, agentPreset: 'aurabot-social' } })
          return { sessionId: sid }
        },
        resolveAgent: async (idKey) => {
          const existing = agents.get(idKey)
          if (existing) return { agent: existing }
          const stored = sessions.get(idKey)
          if (!stored) return { error: { code: 'session/not-found', message: 'not found' } }
          return { agent: buildAgent(idKey, stored) }
        },
        fork: async ({ sessionId, atSeq }) => {
          const source = sessions.get(sessionId)
          if (!source) throw new Error('missing source session')
          const boundary = atSeq ?? (source.events.length - 1)
          const count = boundary + 1
          const childId = `s-shared-fork-${++forkSeq}`
          const forkedEvents = [
            ...structuredClone(source.events.slice(0, count)),
            { type: 'session/end-seed', seq: count, time: Date.now(), data: { inherited: true } },
          ]
          const parentHeader = forkParentMode === 'match'
            ? { parentSession: sessionId }
            : forkParentMode === 'mismatch'
              ? { parentSession: 'wrong-parent' }
              : {}
          buildAgent(childId, {
            header: {
              id: childId,
              cwd: source.header.cwd,
              agentPreset: source.header.agentPreset,
              ...parentHeader,
            },
            inheritedEventCount: count,
            events: forkedEvents,
          })
          await wsObj.attachSession(childId)
          return { sessionId: childId }
        },
        rename: async () => {},
      },
    },
  }

  const createRuntime = () => {
    const hub = createHub({
      dsh,
      getConfig: () => cfg,
      log,
      gateway,
      identity: id,
      resolveSharedPrimary: () => fixedSharedPrimary({ cfg, identity: id, instances: gateway.instances() }),
    })
    const offSession = dsh.on('session/event', hub.onSessionEvent)
    const submitted = []
    const offGw = gateway.onMessage((m) => { submitted.push(hub.onGatewayMessage(m)) })
    return {
      hub,
      submitted,
      stopRuntime: () => { offGw(); offSession(); hub.dispose() },
    }
  }

  let runtime = createRuntime()
  t.after(async () => {
    runtime.stopRuntime()
    await gateway.stopAll()
    id.close?.()
    if (prevDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prevDir
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })

  const readSessionsJson = () => JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8'))
  const deliverInbound = async (adapter, { chatId, account, text, msgId }) => {
    const idx = runtime.submitted.length
    adapter.pushInbound({
      messageId: msgId,
      chat: { kind: 'private', id: chatId },
      sender: { account, name: '主人' },
      parts: [{ type: 'text', text }],
    })
    for (let i = 0; i < 100 && runtime.submitted.length <= idx; i++) await new Promise((r) => setTimeout(r, 10))
    assert.ok(runtime.submitted[idx], `gateway 未投递 ${msgId}`)
    await runtime.submitted[idx]
  }

  return {
    legacySid,
    qq,
    feishu,
    sessions,
    agents,
    setForkParentMode: (mode) => { forkParentMode = mode },
    get runtime() { return runtime },
    restartRuntime: () => {
      runtime.stopRuntime()
      runtime = createRuntime()
      return runtime
    },
    readSessionsJson,
    deliverInbound,
  }
}

test('DSH 0.2.2 parentSession 兼容：verifyCandidate 与 verifyRecovered 允许缺失 parentSession，存在时仍校验一致', async (t) => {
  // 1) parentSession 缺失（0.2.2 independent fork）与匹配（0.2.1）均应通过 candidate 校验与 checkpoint 恢复
  for (const mode of ['omit', 'match']) {
    const h = await setupParentSessionCompatHarness(t, mode)
    const review = await h.runtime.hub.prepareLegacyHistory('live')
    assert.equal(review.ok, true, `${mode}: prepareLegacyHistory 失败`)
    const confirmed = await h.runtime.hub.confirmLegacyHistory('live', review.token)
    assert.equal(confirmed.ok, true, `${mode}: confirmLegacyHistory 失败`)

    await h.deliverInbound(h.qq, { chatId: '10001', account: '10001', text: '首次共享消息', msgId: `ps_${mode}_1` })
    assert.equal(h.runtime.hub.sharedStatus().state, 'active', `${mode}: verifyCandidate 应通过`)
    const mapAfterFirst = h.readSessionsJson()
    const childId = mapAfterFirst.multiPrivate.sessions.live.sessionId
    const checkpoint = mapAfterFirst.multiPrivate.sessions.live.verifiedThroughSeq
    assert.equal(mapAfterFirst.multiPrivate.sessions.live.baseSessionId, h.legacySid)
    assert.ok(Number.isSafeInteger(checkpoint) && checkpoint > review.atSeq)

    // 注入未核验事件并模拟冷重启，触发 restored-history-unverified 暂停
    const childSession = h.sessions.get(childId)
    childSession.events.push({
      type: 'assistant/message',
      seq: childSession.seq++,
      time: Date.now(),
      data: { message: { content: [{ type: 'text', text: '崩溃前未落盘核验点' }] } },
    })
    h.agents.delete(childId)
    h.restartRuntime()

    await h.deliverInbound(h.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '重启后消息', msgId: `ps_${mode}_2` })
    assert.deepEqual(
      {
        state: h.runtime.hub.sharedStatus().state,
        pauseReason: h.runtime.hub.sharedStatus().pauseReason,
        recoverable: h.runtime.hub.sharedStatus().recoverable,
        recoverCheckpoint: h.runtime.hub.sharedStatus().recoverCheckpoint,
      },
      {
        state: 'paused',
        pauseReason: 'restored-history-unverified',
        recoverable: true,
        recoverCheckpoint: checkpoint,
      },
      `${mode}: 重启检测到未核验事件后应进入可恢复暂停状态`,
    )

    const recovered = await h.runtime.hub.recoverSharedFromCheckpoint('live')
    assert.equal(recovered.ok, true, `${mode}: recoverSharedFromCheckpoint 失败: ${JSON.stringify(recovered)}`)
    assert.notEqual(recovered.sessionId, childId)
    assert.equal(h.runtime.hub.sharedStatus().state, 'active')
    assert.equal(h.readSessionsJson().multiPrivate.sessions.live.recoveredFrom, childId)
  }

  // 2) parentSession 存在但不一致时，verifyCandidate 与 verifyRecovered 均必须拒绝
  {
    const hCand = await setupParentSessionCompatHarness(t, 'mismatch')
    const review = await hCand.runtime.hub.prepareLegacyHistory('live')
    assert.equal(review.ok, true)
    assert.equal((await hCand.runtime.hub.confirmLegacyHistory('live', review.token)).ok, true)
    await hCand.deliverInbound(hCand.qq, { chatId: '10001', account: '10001', text: '触发错误 parentSession candidate', msgId: 'ps_mismatch_cand' })
    const status = hCand.runtime.hub.sharedStatus()
    assert.equal(status.state, 'paused')
    assert.equal(status.pauseReason, 'candidate-history-unverified')
    assert.equal(hCand.readSessionsJson().multiPrivate.sessions.live.sessionId, undefined)
    assert.ok(hCand.readSessionsJson().multiPrivate.retiredSessions['s-shared-fork-1'])
  }

  {
    const hRec = await setupParentSessionCompatHarness(t, 'omit')
    const review = await hRec.runtime.hub.prepareLegacyHistory('live')
    assert.equal(review.ok, true)
    assert.equal((await hRec.runtime.hub.confirmLegacyHistory('live', review.token)).ok, true)
    await hRec.deliverInbound(hRec.qq, { chatId: '10001', account: '10001', text: '正常分叉第一轮', msgId: 'ps_mismatch_rec_1' })
    const childId = hRec.readSessionsJson().multiPrivate.sessions.live.sessionId
    const childSession = hRec.sessions.get(childId)
    childSession.events.push({
      type: 'assistant/message',
      seq: childSession.seq++,
      time: Date.now(),
      data: { message: { content: [{ type: 'text', text: '崩溃前未核验回复' }] } },
    })
    hRec.agents.delete(childId)
    hRec.restartRuntime()
    await hRec.deliverInbound(hRec.feishu, { chatId: 'ou_owner', account: 'ou_owner', text: '触发暂停', msgId: 'ps_mismatch_rec_2' })
    assert.equal(hRec.runtime.hub.sharedStatus().recoverable, true)

    hRec.setForkParentMode('mismatch')
    const badRecover = await hRec.runtime.hub.recoverSharedFromCheckpoint('live')
    assert.equal(badRecover.ok, false)
    assert.equal(badRecover.reason, 'candidate-unavailable')
    assert.equal(hRec.runtime.hub.sharedStatus().state, 'paused')
    assert.equal(hRec.readSessionsJson().multiPrivate.sessions.live.sessionId, childId)
    assert.ok(hRec.readSessionsJson().multiPrivate.retiredSessions['s-shared-fork-2'])
  }
})
