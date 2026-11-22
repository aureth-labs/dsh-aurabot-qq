import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createGateway } from '../../src/gateway/index.js'
import { makeFakeAdapter } from '../helpers/fake-adapter.js'
import { makeIdentity, makeTempRoot } from './helpers.js'

function setup(platforms, { isExternalInstance, stopOther, verifyQq, identityCurrent = () => true } = {}) {
  const config = { platforms }
  const root = makeTempRoot()
  const identity = makeIdentity()
  const gateway = createGateway({ config, dataDir: (...parts) => join(root, ...parts), identity, isExternalInstance })
  const started = new Map()
  const business = []

  for (const id of ['qq', 'other']) {
    gateway.register(() => {
      const adapter = makeFakeAdapter({ id })
      const { start, stop } = adapter
      let stopped = true
      Object.assign(adapter, {
        async start(ctx) {
          started.set(ctx.instance, { adapter, ctx })
          stopped = false
          await start(ctx)
        },
        async stop() {
          if (id === 'other') await stopOther?.()
          await stop()
          stopped = true
        },
        async fetch(req) { business.push(['fetch', req]); return [] },
        async native(action) { business.push(['native', action]); return {} },
        groupAdmin: {
          async getGroupInfo(group) { business.push(['groupAdmin', group]); return { groupOpenid: group } },
        },
      })
      if (id === 'qq') {
        adapter.stopAndWait = () => adapter.stop()
        adapter.confirmStopped = () => stopped
        adapter.verifyMigrationIdentity = verifyQq || (() => adapter.whoami())
        adapter.isMigrationIdentityCurrent = identityCurrent
      }
      return adapter
    })
  }
  return { gateway, config, identity, started, business, outboxPath: join(root, 'gateway', 'outbox.json') }
}

const target = { enabled: true, selfId: 'fake-bot', wsUrl: 'ws://target.invalid' }
const text = [{ type: 'text', text: 'test' }]
const held = { certainty: 'not-sent', code: 'migration-held', instance: 'qq' }

test('缺少停机确认的适配器仍可常规启停，但不能作为迁移来源或目标', async (t) => {
  const { gateway, config, started } = setup({ custom: { enabled: true, adapter: 'other' } })
  t.after(() => gateway.stopAll())
  const unsupported = { code: 'MIGRATION_STOP_UNSUPPORTED' }
  await assert.rejects(gateway.acquireLease('other', { config: { enabled: true } }), unsupported)
  assert.equal(started.has('other'), false)

  await gateway.sync()
  const source = started.get('custom')
  await assert.rejects(gateway.acquireLease('custom', { config: { enabled: true, adapter: 'qq' } }), unsupported)
  assert.equal(started.get('custom'), source)
  assert.equal(gateway.instances().find(({ instance }) => instance === 'custom')?.state, 'connected')

  config.platforms.custom.enabled = false
  await gateway.sync()
  assert.equal(gateway.instances().find(({ instance }) => instance === 'custom')?.state, 'stopped')
})

test('迁移租约保留启动快照，普通同步及旧连接托管不会替换挂起实例', async (t) => {
  let external = true
  let releaseOtherStop
  let markOtherStopStarted
  const otherStopStarted = new Promise((resolve) => { markOtherStopStarted = resolve })
  const otherCanStop = new Promise((resolve) => { releaseOtherStop = resolve })
  const { gateway, config, started } = setup({ qq: { enabled: true }, other: { enabled: true } }, {
    isExternalInstance: (instance) => instance === 'qq' && external,
    stopOther: () => {
      markOtherStopStarted()
      return otherCanStop
    },
  })
  t.after(async () => {
    releaseOtherStop()
    await gateway.stopAll()
  })
  await gateway.sync()
  assert.equal(started.has('qq'), false)

  const draft = { ...target }
  const lease = await gateway.acquireLease('qq', { config: draft })
  await assert.rejects(gateway.acquireLease('qq', { config: target }), /已有迁移租约/)
  draft.wsUrl = 'ws://changed.invalid'
  await lease.startHeld()
  const runtime = started.get('qq')
  assert.equal(runtime.ctx.config().wsUrl, target.wsUrl)
  assert.equal(runtime.ctx.migrationHeld, true)
  assert.equal(gateway.instances().find(({ instance }) => instance === 'qq').state, 'connecting')
  await assert.rejects(lease.release(), /未满足交还条件/)
  assert.equal((await lease.whenReady()).self.account, target.selfId)

  config.platforms = { qq: { enabled: false }, other: { enabled: false } }
  const staleSync = gateway.sync()
  await otherStopStarted
  const queuedStop = new AbortController()
  const stalePause = gateway.pauseInstance('qq', '过期停止请求', { heldLease: lease, signal: queuedStop.signal })
  queuedStop.abort()
  config.platforms.qq = { wsUrl: target.wsUrl, enabled: true, selfId: target.selfId }
  external = false
  const released = lease.release()
  await assert.rejects(gateway.send({ chatId: 'qq:private:1', parts: text }), held)
  releaseOtherStop()
  await Promise.all([staleSync, assert.rejects(stalePause, { name: 'AbortError' }), released, gateway.sync()])

  assert.equal(started.get('qq'), runtime)
  assert.equal(gateway.instances().find(({ instance }) => instance === 'qq').state, 'connected')
  assert.equal(gateway.instances().find(({ instance }) => instance === 'other').state, 'stopped')
  await assert.rejects(lease.startHeld(), /迁移租约已释放/)
})

test('挂起实例拒绝业务且跳过补发，其他平台可正常收发', async (t) => {
  const { gateway, config, identity, started, business, outboxPath } = setup({ other: { enabled: true } })
  t.after(() => gateway.stopAll())
  const at = Date.now()
  mkdirSync(dirname(outboxPath), { recursive: true })
  writeFileSync(outboxPath, JSON.stringify(['qq', 'other'].map((instance) => ({
    id: instance,
    instance,
    createdAt: at,
    expiresAt: at + 60000,
    attempts: 0,
    nextAt: at,
    message: { chatId: `${instance}:private:1`, parts: text },
  }))))

  const messages = []
  const events = []
  const flushed = []
  gateway.onMessage(({ messageId }) => messages.push(messageId))
  gateway.onEvent(({ type }) => events.push(type))
  gateway.onFlushed(({ chatId }) => flushed.push(chatId))
  const lease = await gateway.acquireLease('qq', { config: target })
  await lease.startHeld()
  await gateway.sync()
  const qq = started.get('qq')
  const other = started.get('other')
  qq.adapter.pushInbound({ messageId: 'duplicate-later' })
  qq.ctx.emitEvent({ type: 'recall' })
  const blockedCallback = { statusCode: null, end() {} }
  assert.equal(gateway.handleHttp({ url: '/platform/qq/callback' }, blockedCallback), true)
  assert.equal(blockedCallback.statusCode, 503)
  other.adapter.pushInbound({ messageId: 'other' })
  other.ctx.emitEvent({ type: 'poke' })
  assert.deepEqual(messages, ['other'])
  assert.deepEqual(events, ['poke'])
  assert.equal(identity.lookup('qq', '10001'), null)
  await assert.rejects(gateway.send({ chatId: 'qq:private:1', parts: text }), held)
  await assert.rejects(gateway.fetch('qq', { kind: 'chats' }), held)
  await assert.rejects(gateway.native('qq', 'get_status'), held)
  assert.equal(gateway.groupAdmin('qq'), null)
  assert.deepEqual(business, [])

  await gateway.outbox.flush()
  assert.deepEqual(flushed, ['other:private:1'])
  assert.equal(gateway.outbox.status('other').count, 0)
  assert.equal(gateway.outbox.status('qq').count, 1)
  assert.equal(other.adapter.sent.length, 1)
  assert.equal(qq.adapter.sent.length, 0)
  const [queued] = JSON.parse(readFileSync(outboxPath, 'utf8'))
  assert.equal(queued.instance, 'qq')
  assert.equal(queued.attempts, 0)

  config.platforms.qq = target
  await lease.whenReady()
  await lease.release()
  qq.adapter.pushInbound({ messageId: 'duplicate-later' })
  await gateway.outbox.flush()
  assert.deepEqual(flushed, ['other:private:1', 'qq:private:1'])
  assert.deepEqual(messages, ['other', 'duplicate-later'])
})

test('回滚等待实例停止，交还后旧实例事件失效且新租约独立', async (t) => {
  const { gateway, config, started } = setup({ qq: target })
  const allowStop = Promise.withResolvers()
  t.after(async () => {
    allowStop.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    await gateway.stopAll()
  })
  await gateway.sync()
  const { adapter, ctx } = started.get('qq')
  const groupAdmin = gateway.groupAdmin('qq')
  const lease = await gateway.acquireLease('qq', { config: target })
  const stopping = Promise.withResolvers()
  let stopCount = 0
  adapter.stopAndWait = async () => {
    stopCount++
    if (stopCount === 1) throw new Error('关闭尚未确认')
    stopping.resolve()
    await allowStop.promise
    await adapter.stop()
  }
  await assert.rejects(groupAdmin.getGroupInfo('1'), held)
  await assert.rejects(lease.stop(), /关闭尚未确认/)
  const abort = new AbortController()
  const closing = gateway.pauseInstance('qq', '等待回滚停止', { forceReleaseLease: true, signal: abort.signal })
  await stopping.promise
  abort.abort()
  await assert.rejects(closing, { name: 'AbortError' })
  await assert.rejects(lease.stop(), { code: 'INSTANCE_STOP_PENDING' })
  await assert.rejects(gateway.pauseInstance('qq', '再次确认停止', { heldLease: lease }), { code: 'INSTANCE_STOP_PENDING' })
  assert.equal(stopCount, 2, '底层任务未结束时不应再次调用适配器')
  await assert.rejects(lease.release(), /未满足交还条件/)
  allowStop.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  await lease.stop()
  assert.equal(stopCount, 2, '迟到的停止确认可以由下次检查采用')
  config.platforms.qq = { enabled: false }
  await lease.release()
  const newLease = await gateway.acquireLease('qq', { config: target })
  await assert.rejects(lease.stop(), /迁移租约已释放/)
  await newLease.startHeld()
  config.platforms.qq = target
  await newLease.whenReady()
  await newLease.release()
  const events = []
  gateway.onEvent((event) => events.push(event.type))
  ctx.emitEvent({ type: 'old' })
  started.get('qq').ctx.emitEvent({ type: 'new' })
  assert.deepEqual(events, ['new'])
})

test('独立关闭确认可完成已超时的停止，迟到任务不影响接任实例', async (t) => {
  const { gateway, started } = setup({ qq: target })
  const entered = Promise.withResolvers()
  const oldWaiter = Promise.withResolvers()
  t.after(async () => {
    oldWaiter.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    await gateway.stopAll()
  })
  await gateway.sync()
  const { adapter } = started.get('qq')
  const lease = await gateway.acquireLease('qq', { config: target })
  let stopCalls = 0
  let transportClosed = false
  adapter.stopAndWait = () => {
    stopCalls++
    entered.resolve()
    return oldWaiter.promise
  }
  adapter.confirmStopped = () => transportClosed

  const controller = new AbortController()
  const pendingPause = gateway.pauseInstance('qq', '停止旧连接', { heldLease: lease, signal: controller.signal })
  await entered.promise
  const since = gateway.stopAttemptSince('qq')
  assert.ok(since > 0)
  controller.abort()
  await assert.rejects(pendingPause, { name: 'AbortError' })
  await assert.rejects(lease.stop(), { code: 'INSTANCE_STOP_PENDING' })
  assert.equal(gateway.stopAttemptSince('qq'), since)

  await adapter.stop()
  transportClosed = true
  await lease.stop()
  await lease.release()
  assert.equal(stopCalls, 1)
  assert.equal(gateway.stopAttemptSince('qq'), null)
  await gateway.sync()
  assert.notEqual(started.get('qq').adapter, adapter)
  oldWaiter.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(gateway.instances().find(({ instance }) => instance === 'qq')?.state, 'connected')
  assert.equal(gateway.stopAttemptSince('qq'), null)
})

test('挂起实例须先验号，失败或未完成验号均不能交还', async (t) => {
  let finishVerification
  let startVerification
  const verifying = new Promise((resolve) => { startVerification = resolve })
  const result = new Promise((resolve) => { finishVerification = resolve })
  const { gateway, started } = setup({ qq: target }, {
    verifyQq(expectedAccount) {
      assert.equal(expectedAccount, target.selfId)
      startVerification()
      return result
    },
  })
  t.after(() => gateway.stopAll())
  const lease = await gateway.acquireLease('qq', { config: target })
  await lease.startHeld()
  const checking = lease.whenReady()
  await verifying
  assert.equal(lease.isReady(), false)
  await assert.rejects(lease.release(), /未完成当前连接验号/)
  await assert.rejects(gateway.send({ chatId: 'qq:private:1', parts: text }), held)
  assert.equal(started.get('qq').adapter.sent.length, 0)

  finishVerification({ account: 'someone-else', name: '别的账号' })
  await assert.rejects(checking, /登录账号与目标不一致/)
  await assert.rejects(lease.release(), /未完成当前连接验号/)
  assert.equal(gateway.instances().find(({ instance }) => instance === 'qq').state, 'connecting')
})

test('旧连接的验号结果及已变化的端点均不能解除挂起', async (t) => {
  let result
  let startVerification
  const verifying = new Promise((resolve) => { startVerification = resolve })
  let current = true
  const { gateway, started } = setup({ qq: target }, {
    verifyQq() {
      startVerification()
      return result
    },
    identityCurrent: () => current,
  })
  t.after(() => gateway.stopAll())
  const lease = await gateway.acquireLease('qq', { config: target })
  await lease.startHeld()
  const { ctx } = started.get('qq')
  let finishPrevious
  result = new Promise((resolve) => { finishPrevious = resolve })
  const checking = lease.whenReady()
  await verifying
  ctx.state('disconnected')
  ctx.state('connected')
  const self = { account: target.selfId, name: '机器人' }
  finishPrevious(self)
  await assert.rejects(checking, /验号后连接已变化/)
  await assert.rejects(lease.release(), /未完成当前连接验号/)

  result = Promise.resolve(self)
  assert.deepEqual((await lease.whenReady()).self, self)
  assert.equal(lease.isReady(), true)
  current = false
  assert.equal(lease.isReady(), false)
  await assert.rejects(lease.release(), /未完成当前连接验号/)
  await assert.rejects(gateway.send({ chatId: 'qq:private:1', parts: text }), held)
  current = true
  await lease.whenReady()
  await lease.release()
  assert.equal(lease.isReady(), false)
  assert.equal(gateway.instances().find(({ instance }) => instance === 'qq').state, 'connected')
})

test('等待连接超时仍保留挂起，后续可在连接建立后重新验号', async (t) => {
  let verified = 0
  const { gateway, started } = setup({ qq: target }, {
    async verifyQq() { verified++; return { account: target.selfId, name: '机器人' } },
  })
  t.after(() => gateway.stopAll())
  const lease = await gateway.acquireLease('qq', { config: target })
  await lease.startHeld()
  const { ctx } = started.get('qq')
  ctx.state('connecting')
  await assert.rejects(lease.whenReady({ timeoutMs: 10 }), /验号等待超时/)
  assert.equal(lease.isReady(), false)
  assert.equal(verified, 0)

  const checking = lease.whenReady()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(verified, 0)
  ctx.state('connected')
  assert.equal((await checking).self.account, target.selfId)
  assert.equal(lease.isReady(), true)
})
