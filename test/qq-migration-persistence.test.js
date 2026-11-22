// 旧版 QQ 迁移网关 QQ · 持久化收件箱回执、配置快照与崩溃恢复、held 有界缓冲专项测试（方案 v8）
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createHub } from '../src/chat/hub.js'
import { loadConfig, readRawConfig } from '../src/core/config.js'
import { createIdentity } from '../src/gateway/identity.js'
import { createGateway } from '../src/gateway/index.js'
import {
  applyRawQqSnapshot,
  captureRawQqSnapshot,
  checkMigrationPersistencePreflight,
  cleanupMigrationTxn,
  createHeldBufferStore,
  createMigrationTxn,
  migrationTxnDir,
  readDataEpoch,
  readMigrationTxn,
  readRecoveryGuard,
  updateMigrationTxn,
  verifyPersistedInboxMessage,
  writeRecoveryGuard,
} from '../src/core/qq-gateway-migration.js'
import { makeFakeAdapter } from './helpers/fake-adapter.js'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { startMockOneBot } from './helpers/mock-onebot.js'

async function waitFor(predicate, message) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(20)
  }
  assert.fail(message)
}

async function waitForLegacyLogin(fake) {
  await waitFor(async () => {
    const { onebot } = (await fake.call('/state')).json()
    return onebot.state === 'connected' && !onebot.problem
  }, '旧版直连应完成 QQ 登录核对')
}

function makeMemoryPersistenceHub(t, { mode = 'telemetry-only', closeLog = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-mig-receipt-'))
  const oldDir = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = root
  t.after(() => {
    if (oldDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = oldDir
    rmSync(root, { recursive: true, force: true })
  })

  const fake = createFakeDsh({
    brain: async () => (mode === 'pause-model-step' ? await pausedStep : 'ok'),
  })
  let releaseStep
  const pausedStep = new Promise((resolve) => { releaseStep = resolve })
  const memorySessions = new Map()
  const persistedSessions = new Map()

  fake.ctx.sessions = {
    async flush(session) {
      if (mode === 'flush-throws') throw new Error('disk full')
      // telemetry-only 或 no-writer 时 flush() 依然返回 true，绝不可直接等价于已持久化。
      return true
    },
  }
  fake.ctx.sessionQuery = {
    observeSession(id) {
      return memorySessions.get(id) || []
    },
  }

  let openCount = 0
  let closeCount = 0
  fake.ctx.services.sessionPersistence = {
    async open(sessionId, access) {
      assert.equal(access, 'read')
      openCount++
      const handle = {
        id: sessionId,
        async read(offset = 0) {
          if (mode === 'read-throws') throw new Error('corrupt-jsonl')
          const list = persistedSessions.get(sessionId) || []
          return { events: list.filter((ev) => (ev.seq ?? 0) >= offset) }
        },
        async close() {
          closeCount++
          closeLog.push(sessionId)
        },
      }
      return handle
    },
  }

  // 劫持 createSession 后为 session.append 同步写内存，仅在 mode='pause-model-step' 等有 writer 时落持久化 inbox 事件。
  const origCreate = fake.ctx.services.sessionController.create
  fake.ctx.services.sessionController.create = async (args) => {
    const res = await origCreate(args)
    const agent = fake.ctx.agents.get(res.sessionId)
    agent.session.seq = 0
    memorySessions.set(res.sessionId, [])
    persistedSessions.set(res.sessionId, [])
    const origFollowup = agent.followup
    agent.followup = (msg) => {
      const ev = { type: 'agent/inbox/spliced', seq: agent.session.seq++, data: { target: 'next-turn', start: 0, inserted: [msg] } }
      memorySessions.get(res.sessionId).push(ev)
      if (mode === 'pause-model-step' || mode === 'persisted') {
        persistedSessions.get(res.sessionId).push(ev)
      }
      return origFollowup(msg)
    }
    return res
  }

  const identity = createIdentity({ dataDir: join(root, 'gateway') })
  identity.claimOwner('qq', '10001')
  const hub = createHub({
    dsh: fake.ctx,
    getConfig: () => ({
      enabled: true,
      dryRun: false,
      model: { provider: '', model: '', reasoningEffort: '' },
      botQQ: '20002',
      ownerQQ: '10001',
      ownerPersonId: identity.owner(),
      allow: { private: ['10001'], groups: [] },
      merge: { enabled: false },
      voice: { asr: false },
      stickers: { collect: false },
      forward: { expandEarly: false },
      conversationContext: { enabled: false },
      group: {},
    }),
    log: { info() {}, warn() {}, debug() {}, error() {} },
    gateway: createGateway({ config: { platforms: {} }, dataDir: (...p) => join(root, ...p), identity }),
  })
  t.after(() => { hub.dispose(); identity.close?.() })

  return {
    hub,
    ctx: fake.ctx,
    releaseStep: () => releaseStep?.('done'),
    counts: () => ({ openCount, closeCount }),
  }
}

test('v8 §2.5：只有遥测监听或无 persistence writer 时 flush=true 仍判 uncertain；仅 inbox/spliced 落盘可判 accepted 且关闭句柄', async (t) => {
  // 1) 只有内存 observeSession + flush()=true，persistence 无事件 -> uncertain，绝不写 accepted
  {
    const h = makeMemoryPersistenceHub(t, { mode: 'telemetry-only' })
    const preflight = await checkMigrationPersistencePreflight(h.ctx)
    assert.equal(preflight.ok, true)
    const trace = []
    let result = null
    await h.hub.pushToSession({ chatId: 'qq:private:10001', kind: 'private', platform: 'qq', userId: '10001' }, [{ type: 'text', text: '仅内存' }], '10001', {
      migrationReceipt: {
        onBeforeDispatch: (info) => trace.push(['dispatching', info]),
        onVerified: (v) => { result = v },
      },
    })
    assert.equal(trace.length, 1)
    assert.equal(h.ctx.sessionQuery.observeSession(trace[0][1].sessionId).length, 1, '内存会话可见，但未持久化')
    assert.equal(result?.status, 'uncertain')
    assert.equal(result?.reason, 'inbox-event-not-persisted')
    assert.equal(h.counts().openCount, 1)
    assert.equal(h.counts().closeCount, 1, '只读句柄必须关闭')
  }

  // 2) 只读读取抛错 -> uncertain 且 finally 仍关闭句柄
  {
    const h = makeMemoryPersistenceHub(t, { mode: 'read-throws' })
    let result = null
    await h.hub.pushToSession({ chatId: 'qq:private:10001', kind: 'private', platform: 'qq', userId: '10001' }, [{ type: 'text', text: '读错' }], '10001', {
      migrationReceipt: {
        onBeforeDispatch: () => {},
        onVerified: (v) => { result = v },
      },
    })
    assert.equal(result?.status, 'uncertain')
    assert.equal(result?.reason, 'corrupt-jsonl')
    assert.equal(h.counts().closeCount, h.counts().openCount)
  }

  // 3) 暂停模型 step（无 user/message、只有 persistence 的 agent/inbox/spliced）-> 仍可直接验证 accepted
  {
    const h = makeMemoryPersistenceHub(t, { mode: 'pause-model-step' })
    let messageId = ''
    let sessionId = ''
    // 不 await 模型 step 完成（pushToSession 在 fake-dsh 中会等 followup 返回，改为直接调 followup + flush 验证 helper + flush）
    const created = await h.ctx.services.sessionController.create({ agentPreset: 'aurabot-private' })
    sessionId = created.sessionId
    const agent = h.ctx.agents.get(sessionId)
    messageId = 'msg-inbox-only-1'
    void agent.followup({ id: messageId, role: 'user', content: [{ type: 'text', text: 'paused step' }], source: { kind: 'aurabot' } })
    await h.ctx.sessions.flush(agent.session)
    const proof = await verifyPersistedInboxMessage(h.ctx, { sessionId, baselineSeq: 0, messageId })
    assert.equal(proof.ok, true)
    h.releaseStep()
  }

  // 4) 缺少 sessionPersistence -> preflight 失败，不能用 flush=true 兜底
  {
    const fakeNoPersist = { sessions: { async flush() { return true } }, sessionQuery: { observeSession: () => [{}] } }
    const pf = await checkMigrationPersistencePreflight(fakeNoPersist)
    assert.equal(pf.ok, false)
    assert.equal(pf.reason, 'missing-session-persistence')
  }
})

test('held 期间有界缓冲磁盘落盘、崩溃状态收敛（dispatching -> uncertain）与限额拦截', () => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-buf-'))
  try {
    createMigrationTxn(root, {
      txnId: 'txn-buf-1',
      expectedRevision: 0,
      fromLegacyQqEnabled: true,
      targetLegacyQqEnabled: false,
      targetPlatform: { enabled: true },
      rawPreConfig: { botQQ: '20002' },
      targetConfig: { legacyQqEnabled: false },
    })
    const store = createHeldBufferStore(root, 'txn-buf-1', { maxItems: 3, maxBytes: 4096 })
    const r1 = store.pushInbound({ instance: 'qq', message: { messageId: 'm1' } })
    const r2 = store.pushInbound({ instance: 'qq', message: { messageId: 'm2' } })
    const r3 = store.pushInbound({ instance: 'qq', message: { messageId: 'm3' } })
    const r4 = store.pushInbound({ instance: 'qq', message: { messageId: 'm4' } })
    assert.equal(r1.ok, true)
    assert.equal(r2.ok, true)
    assert.equal(r3.ok, true)
    assert.equal(r4.ok, false)
    assert.equal(r4.reason, 'buffer-full-items')

    store.markStatus(r1.seq, 'dispatching', { messageId: 'dsh-1', sessionId: 's1' })
    store.markStatus(r2.seq, 'accepted', { messageId: 'dsh-2', sessionId: 's1' })

    // 模拟崩溃重启恢复：dispatching 转 uncertain，accepted 保留，pending 保持 pending
    const reloaded = createHeldBufferStore(root, 'txn-buf-1', { maxItems: 3, maxBytes: 4096 })
    const changed = reloaded.reconcileAfterCrash()
    assert.equal(changed.length, 1)
    assert.equal(changed[0].seq, r1.seq)
    assert.equal(changed[0].status, 'uncertain')
    const list = reloaded.list()
    assert.deepEqual(list.map((e) => [e.seq, e.status]), [
      [1, 'uncertain'],
      [2, 'accepted'],
      [3, 'pending'],
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('原始配置键存在性精确恢复：无 platforms.qq / 显式 enabled:false / 独立 token / enabled，保留无关字段', () => {
  for (const pre of [
    { enabled: true, botQQ: '20002', ownerQQ: '10001' },
    { botQQ: '20002', ownerQQ: '10001' },
    { enabled: false, botQQ: '20002', ownerQQ: '10001', legacyQqEnabled: true, platforms: { qq: { enabled: false, backend: 'snowluma' }, feishu: { enabled: true } } },
    { enabled: true, botQQ: '20002', ownerQQ: '10001', snowluma: { httpUrl: 'http://127.0.0.1:13000', wsUrl: 'ws://127.0.0.1:13001', httpToken: 'sec-h', wsToken: 'sec-w' } },
  ]) {
    const snap = captureRawQqSnapshot(pre)
    const mutated = {
      ...structuredClone(pre),
      enabled: !pre.enabled,
      ownerName: '期间改的称呼',
      legacyQqEnabled: false,
      platforms: { ...(pre.platforms || {}), qq: { enabled: true, backend: 'onebot', selfId: '20002' } },
      snowluma: { httpUrl: 'http://127.0.0.1:1', wsUrl: 'ws://127.0.0.1:2', httpToken: 'other', wsToken: 'other' },
    }
    const restored = applyRawQqSnapshot(mutated, snap)
    assert.equal(restored.ownerName, '期间改的称呼')
    assert.equal(Object.hasOwn(restored, 'enabled'), Object.hasOwn(pre, 'enabled'))
    if (Object.hasOwn(pre, 'enabled')) assert.equal(restored.enabled, pre.enabled)
    if (!Object.hasOwn(pre, 'platforms')) {
      assert.equal(Object.hasOwn(restored, 'platforms'), false, '原文件无 platforms 时必须删回不存在')
    } else if (!Object.hasOwn(pre.platforms, 'qq')) {
      assert.equal(Object.hasOwn(restored.platforms, 'qq'), false)
    } else {
      assert.deepEqual(restored.platforms.qq, pre.platforms.qq)
    }
    assert.equal(Object.hasOwn(restored, 'legacyQqEnabled'), Object.hasOwn(pre, 'legacyQqEnabled'))
    if (pre.snowluma) assert.deepEqual(restored.snowluma, pre.snowluma)
  }
})

test('宿主持久化迁移恢复：prepare 前崩溃自动回滚原配置；commit 后崩溃以 held 启动、验号、排空缓冲后再放行', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aurabot-mig-crash-'))
  const oldDir = process.env.AURABOT_DATA_DIR
  const oldWs = process.env.AURABOT_WORKSPACE
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'workspace')

  const botQQ = '20000002'
  const ownerQQ = '10000001'
  const legacy = await startMockOneBot({ selfId: botQQ, token: 'orig-http-tok' })
  const managed = await startMockOneBot({ selfId: botQQ })
  const hosts = []
  t.after(async () => {
    for (const h of hosts) {
      h.fake.dispose()
      try { await h.host.gateway?.stopAll?.() } catch {}
    }
    await Promise.all([managed.close(), legacy.close()])
    if (oldDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = oldDir
    if (oldWs === undefined) delete process.env.AURABOT_WORKSPACE
    else process.env.AURABOT_WORKSPACE = oldWs
    rmSync(dataDir, { recursive: true, force: true })
  })

  // 原始 config.json 刻意不写 platforms 和 legacyQqEnabled
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    setupDone: true,
    dryRun: false,
    gateway: 'onebot',
    botQQ,
    ownerQQ,
    snowluma: {
      httpUrl: legacy.httpUrl,
      wsUrl: legacy.wsUrl,
      httpToken: legacy.token,
      wsToken: legacy.token,
    },
  }))

  const { apply } = await import('../src/host.js')
  const boot = async ({ withPersistence = false } = {}) => {
    const fake = createFakeDsh({ brain: async () => '已回复' })
    const persistedEvents = new Map()
    if (withPersistence) {
      fake.ctx.sessions = { async flush() { return true } }
      fake.ctx.services.sessionPersistence = {
        async open(sessionId) {
          return {
            id: sessionId,
            async read(offset = 0) {
              return { events: (persistedEvents.get(sessionId) || []).filter((e) => (e.seq ?? 0) >= offset) }
            },
            async close() {},
          }
        },
      }
      const origCreate = fake.ctx.services.sessionController.create
      fake.ctx.services.sessionController.create = async (args) => {
        const res = await origCreate(args)
        const a = fake.ctx.agents.get(res.sessionId)
        a.session.seq = 0
        persistedEvents.set(res.sessionId, [])
        const origFollow = a.followup
        a.followup = (msg) => {
          persistedEvents.get(res.sessionId).push({ type: 'agent/inbox/spliced', seq: a.session.seq++, data: { inserted: [msg] } })
          return origFollow(msg)
        }
        return res
      }
    }
    const host = apply(fake.ctx, { migrationTimeoutMs: 6000 })
    const rec = { fake, host, persistedEvents }
    hosts.push(rec)
    await host.ready
    return rec
  }

  // 1) prepare 完成但未 commit 时模拟进程崩溃 -> 重启后回滚未提交迁移并保留期间保存的无关字段 ownerName
  const platform = { enabled: true, backend: 'onebot', selfId: botQQ, httpUrl: managed.httpUrl, wsUrl: managed.wsUrl, token: managed.token }
  let r1 = await boot()
  // 连上旧版 OneBot 以便 begin()
  assert.equal((await r1.fake.call('/onebot/reconnect')).json().ok, true)
  const tx1 = r1.host.qqOwnership.begin({
    txnId: 'crash-pre-commit',
    expectedRevision: r1.host.qqOwnership.status().revision,
    legacyQqEnabled: false,
    platform,
  })
  await tx1.prepare()
  assert.ok(readMigrationTxn(dataDir, 'crash-pre-commit'))
  // 修改无关字段 ownerName，模拟期间保存
  await r1.fake.call('/save', { ownerName: '备份称呼' })
  // 直接丢弃并模拟重启（不调 commit/finish/abort）
  r1.fake.dispose()
  await r1.host.gateway?.stopAll?.()

  let r2 = await boot()
  assert.equal(readMigrationTxn(dataDir, 'crash-pre-commit'), null, '重启回滚后应清理未提交事务')
  assert.equal(r2.host.qqOwnership.recovery().phase, 'idle')
  assert.equal(r2.host.qqOwnership.status().legacyQqEnabled, true)
  const rawAfterPreCrash = readRawConfig()
  assert.equal(rawAfterPreCrash.ownerName, '备份称呼')
  assert.equal(rawAfterPreCrash.snowluma.httpToken, 'orig-http-tok')
  assert.notEqual(rawAfterPreCrash.platforms?.qq?.httpUrl, managed.httpUrl)

  // 2) commit 完成但在 finish 前崩溃，且 buffer 中存在 1 条 pending 与 1 条 dispatching（崩溃前已在途中）-> 重启以 held 启动、验号、dispatching 转 uncertain 不重放、pending 走持久化回执 accepted 后交还
  assert.equal((await r2.fake.call('/onebot/reconnect')).json().ok, true)
  const tx2 = r2.host.qqOwnership.begin({
    txnId: 'crash-post-commit',
    expectedRevision: r2.host.qqOwnership.status().revision,
    legacyQqEnabled: false,
    platform,
  })
  await tx2.prepare()
  tx2.commit({ txnId: 'crash-post-commit', expectedRevision: r2.host.qqOwnership.status().revision })
  // 人为往 disk buffer 写入 1 条 crashing dispatching 和 1 条 pending 消息
  const buf = createHeldBufferStore(dataDir, 'crash-post-commit')
  const bDispatching = buf.pushInbound({
    instance: 'qq',
    message: { messageId: 'm-dup', chat: { kind: 'private', id: ownerQQ }, sender: { account: ownerQQ, name: '主人' }, parts: [{ type: 'text', text: '崩溃前已在投递的旧消息' }], at: Date.now() },
  })
  buf.markStatus(bDispatching.seq, 'dispatching', { messageId: 'old-dsh-id', sessionId: 'old-s' })
  buf.pushInbound({
    instance: 'qq',
    message: { messageId: 'm-pending', chat: { kind: 'private', id: ownerQQ }, sender: { account: ownerQQ, name: '主人' }, parts: [{ type: 'text', text: '崩溃前暂存待投递的新消息' }], at: Date.now() },
  })

  r2.fake.dispose()
  await r2.host.gateway?.stopAll?.()

  const r3 = await boot({ withPersistence: true })
  await waitFor(() => r3.fake.turns.length >= 1, '重启恢复应只排空并执行 pending 消息')
  assert.equal(r3.fake.turns.length, 1, 'dispatching 消息绝不可重放')
  assert.match(r3.fake.turns[0].userText, /崩溃前暂存待投递的新消息/)
  assert.equal(r3.host.qqOwnership.status().legacyQqEnabled, false)
  assert.equal(r3.host.qqOwnership.status().paused, false)
  assert.equal(readMigrationTxn(dataDir, 'crash-post-commit'), null, '终态 active 后清理快照与缓冲')
  assert.equal(readRecoveryGuard(dataDir).phase, 'idle')
  assert.equal(legacy.connected(), 0)

  // 3) 损坏快照 hash 时，默认 QQ 暂停（migration-ambiguous），其他平台不受影响
  r3.fake.dispose()
  await r3.host.gateway?.stopAll?.()
  const rawNow = readRawConfig()
  createMigrationTxn(dataDir, {
    txnId: 'corrupt-txn',
    expectedRevision: 1,
    fromLegacyQqEnabled: false,
    targetLegacyQqEnabled: true,
    targetPlatform: { enabled: false },
    rawPreConfig: { ...rawNow, platforms: { ...(rawNow.platforms || {}), other: { enabled: true } } },
    targetConfig: { legacyQqEnabled: true },
  })
  writeFileSync(join(dataDir, 'qq-migration-txn', 'corrupt-txn', 'config.raw.pre.json'), '{"version":1,"hash":"tampered"}')

  const r4 = await boot()
  assert.equal(r4.host.qqOwnership.status().paused, true)
  assert.equal(r4.host.qqOwnership.recovery().phase, 'migration-ambiguous')
  const qqCard4 = (await r4.fake.call('/platforms')).json().instances.find((x) => x.instance === 'qq')
  assert.match(qqCard4?.detail || '', /等待恢复确认/)
  assert.equal((await r4.fake.call('/onebot/reconnect')).json().ok, false)
  assert.equal(r4.host.onebot, null)
})

async function setupMigrationHostHarness(t, { flushHook = null, hostOpts = {}, snowlumaAutoEndpoint = false } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aurabot-mig-p1-'))
  const oldDir = process.env.AURABOT_DATA_DIR
  const oldWs = process.env.AURABOT_WORKSPACE
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'workspace')

  const botQQ = '20000002'
  const ownerQQ = '10000001'
  const legacy = await startMockOneBot({ selfId: botQQ, token: 'tok-leg' })
  const managed = await startMockOneBot({ selfId: botQQ, token: 'tok-man' })
  const fake = createFakeDsh({ brain: async () => '已回复' })
  const persistedEvents = new Map()
  fake.ctx.sessions = {
    async flush(session) {
      if (flushHook) await flushHook(session)
      return true
    },
  }
  fake.ctx.services.sessionPersistence = {
    async open(sessionId) {
      return {
        id: sessionId,
        async read(offset = 0) {
          return { events: (persistedEvents.get(sessionId) || []).filter((e) => (e.seq ?? 0) >= offset) }
        },
        async close() {},
      }
    },
  }
  const origCreate = fake.ctx.services.sessionController.create
  fake.ctx.services.sessionController.create = async (args) => {
    const res = await origCreate(args)
    const a = fake.ctx.agents.get(res.sessionId)
    a.session.seq = 0
    persistedEvents.set(res.sessionId, [])
    const origFollow = a.followup
    a.followup = (msg) => {
      persistedEvents.get(res.sessionId).push({ type: 'agent/inbox/spliced', seq: a.session.seq++, data: { inserted: [msg] } })
      return origFollow(msg)
    }
    return res
  }

  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    setupDone: true,
    dryRun: false,
    merge: { enabled: false },
    voice: { enabled: false },
    stickers: { enabled: false },
    gateway: 'onebot',
    botQQ,
    ownerQQ,
    snowluma: {
      httpUrl: legacy.httpUrl,
      wsUrl: legacy.wsUrl,
      httpToken: legacy.token,
      wsToken: legacy.token,
    },
  }))

  if (snowlumaAutoEndpoint) {
    const snowlumaDir = join(dataDir, 'snowluma-auto')
    mkdirSync(join(snowlumaDir, 'config'), { recursive: true })
    const http = new URL(legacy.httpUrl)
    const ws = new URL(legacy.wsUrl)
    writeFileSync(join(snowlumaDir, 'config', `onebot_${botQQ}.json`), JSON.stringify({
      mode: 'snapshot',
      networks: {
        httpServers: [{ host: http.hostname, port: Number(http.port), path: http.pathname, accessToken: legacy.token }],
        wsServers: [{ host: ws.hostname, port: Number(ws.port), path: ws.pathname, accessToken: legacy.token }],
      },
    }))
    const raw = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'))
    raw.gateway = 'snowluma'
    raw.snowluma = {
      dir: snowlumaDir,
      autoStart: false,
      webuiPort: 15099,
      httpUrl: '',
      wsUrl: '',
      httpToken: '',
      wsToken: '',
    }
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify(raw))
  }

  const { apply } = await import('../src/host.js')
  const host = apply(fake.ctx, { migrationTimeoutMs: 5000, ...hostOpts })
  t.after(async () => {
    fake.dispose()
    try { await host.gateway?.stopAll?.() } catch {}
    await Promise.race([Promise.all([managed.close(), legacy.close()]), delay(400)])
    if (oldDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = oldDir
    if (oldWs === undefined) delete process.env.AURABOT_WORKSPACE
    else process.env.AURABOT_WORKSPACE = oldWs
    rmSync(dataDir, { recursive: true, force: true })
  })
  await host.ready
  assert.equal((await fake.call('/onebot/reconnect')).json().ok, true)
  return {
    dataDir,
    botQQ,
    ownerQQ,
    legacy,
    managed,
    fake,
    host,
    platform: { enabled: true, backend: 'onebot', selfId: botQQ, httpUrl: managed.httpUrl, wsUrl: managed.wsUrl, token: managed.token },
    pushManagedInbound(messageId, text) {
      managed.push({
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        self_id: Number(botQQ),
        user_id: Number(ownerQQ),
        message_id: messageId,
        sender: { user_id: Number(ownerQQ), nickname: '主人' },
        message: [{ type: 'text', data: { text } }],
      })
    },
  }
}

test('P1-1a：drain 期间新到消息及 release 前边界追加不丢失', async (t) => {
  // drain 处理第一条期间追加第二条 -> 第二条仍被闭合排空并交还
  let flushedCount = 0
  let s1
  s1 = await setupMigrationHostHarness(t, {
    flushHook: async () => {
      flushedCount++
      if (flushedCount === 1) {
        s1.pushManagedInbound(8002, 'drain期间追加的消息')
        await delay(40)
      }
    },
  })
  const tx = s1.host.qqOwnership.begin({
    txnId: 'p1-1-closed-drain',
    expectedRevision: s1.host.qqOwnership.status().revision,
    legacyQqEnabled: false,
    platform: s1.platform,
  })
  await tx.prepare()
  s1.pushManagedInbound(8001, '首批缓冲消息')
  await waitFor(() => s1.host.qqOwnership.bufferStatus('p1-1-closed-drain').entries.length === 1, '首条消息未进 held 缓冲')
  tx.commit({ txnId: 'p1-1-closed-drain', expectedRevision: s1.host.qqOwnership.status().revision })
  await tx.finish()
  await waitFor(() => s1.fake.turns.length >= 2, '两批消息应全部处理完成')
  assert.equal(s1.fake.turns.length, 2)
  assert.ok(s1.fake.turns.some((x) => /首批缓冲消息/.test(x.userText)))
  assert.ok(s1.fake.turns.some((x) => /drain期间追加的消息/.test(x.userText)))
  assert.equal(readMigrationTxn(s1.dataDir, 'p1-1-closed-drain'), null)
})

test('P1-1b：持续不断涌入新消息时达到 maxDrainRounds 上限后暂停放行且保留缓冲', async (t) => {
  let roundMsgId = 9001
  let s2
  s2 = await setupMigrationHostHarness(t, {
    hostOpts: { migrationMaxDrainRounds: 2 },
    flushHook: async () => {
      roundMsgId++
      s2.pushManagedInbound(roundMsgId, `持续涌入消息-${roundMsgId}`)
      await delay(20)
    },
  })
  const tx2 = s2.host.qqOwnership.begin({
    txnId: 'p1-1-bound',
    expectedRevision: s2.host.qqOwnership.status().revision,
    legacyQqEnabled: false,
    platform: s2.platform,
  })
  await tx2.prepare()
  s2.pushManagedInbound(9000, '初始消息')
  await waitFor(() => s2.host.qqOwnership.bufferStatus('p1-1-bound').entries.length === 1, '初始消息未入缓冲')
  tx2.commit({ txnId: 'p1-1-bound', expectedRevision: s2.host.qqOwnership.status().revision })
  await assert.rejects(tx2.finish(), (err) => err?.code === 'MIGRATION_DRAIN_BOUND_EXCEEDED')
  assert.equal(s2.host.qqOwnership.status().paused, true)
  assert.ok(s2.host.qqOwnership.bufferStatus('p1-1-bound').entries.length >= 3, '达到上限后仍保留缓冲消息供确认')
})

test('P1-2 & P2-1：held 缓冲满时进入 buffer-overflow 暂停且拒绝 release，保留已缓冲消息与溢出样本', async (t) => {
  const s = await setupMigrationHostHarness(t, { hostOpts: { migrationBufferMaxItems: 2, migrationPauseTimeoutMs: 100 } })
  const tx = s.host.qqOwnership.begin({
    txnId: 'p1-2-overflow',
    expectedRevision: s.host.qqOwnership.status().revision,
    legacyQqEnabled: false,
    platform: s.platform,
  })
  await tx.prepare()
  const originalPause = s.host.gateway.pauseInstance
  let firstSignal
  let pauseAttempts = 0
  let allowStop = false
  s.host.gateway.pauseInstance = async (...args) => {
    pauseAttempts++
    if (pauseAttempts === 1) {
      firstSignal = args[2].signal
      return new Promise(() => {})
    }
    if (!allowStop) {
      throw Object.assign(new Error('原停止任务尚未结束'), { code: 'INSTANCE_STOP_PENDING' })
    }
    const stopped = await originalPause(...args)
    if (stopped) {
      // 模拟已选中成功结果，但归并状态前又观察到信号中止。
      Object.defineProperty(args[2].signal, 'aborted', { value: true })
    }
    return stopped
  }
  t.after(() => { s.host.gateway.pauseInstance = originalPause })
  s.pushManagedInbound(7001, '缓冲1')
  s.pushManagedInbound(7002, '缓冲2')
  s.pushManagedInbound(7003, '第3条超限消息')
  await waitFor(() => readRecoveryGuard(s.dataDir).phase === 'buffer-overflow', '超限后必须进入 buffer-overflow 恢复门')
  const status = (await s.fake.call('/platforms/qq-migration')).json()
  assert.equal(status.paused, true)
  assert.equal(status.pausePending, true)
  assert.equal(status.recoveryWaitingForStop, true)
  assert.ok(status.pauseStartedAt > 0)
  assert.ok(status.pauseAttempts >= 1)
  assert.equal(status.platforms.instances.find((x) => x.instance === 'qq')?.migration?.pausePending, true)
  const platforms = (await s.fake.call('/platforms')).json()
  assert.equal(platforms.qqMigration.pausePending, true)
  const blocked = (await s.fake.call('/platforms/qq-migration/rollback', { txnId: 'p1-2-overflow' })).json()
  assert.equal(blocked.code, 'INSTANCE_STOP_PENDING')
  assert.equal(blocked.view.pausePending, true)
  assert.equal(blocked.view.recoveryWaitingForStop, true)
  await waitFor(() => firstSignal?.aborted === true, '第一次停止等待应超时并中止')
  assert.equal(s.managed.connected(), 1)
  assert.ok(readMigrationTxn(s.dataDir, 'p1-2-overflow'))

  await waitFor(async () => {
    const view = (await s.fake.call('/platforms/qq-migration')).json()
    return view.recoveryWaitingForStop && view.pauseReason.includes('原停止任务')
  }, '适配器仍在执行原任务时应继续阻止恢复动作')
  const stillBlocked = (await s.fake.call('/platforms/qq-migration/rollback', { txnId: 'p1-2-overflow', retryStopPending: true })).json()
  assert.equal(stillBlocked.code, 'INSTANCE_STOP_PENDING')
  assert.ok(readMigrationTxn(s.dataDir, 'p1-2-overflow'))
  allowStop = true

  // 只轮询无副作用的状态接口，确认停止失败会在后台自动重试。
  await waitFor(async () => {
    const view = (await s.fake.call('/platforms/qq-migration')).json()
    return s.managed.connected() === 0 && !view.pausePending
  }, '溢出后目标连接未关闭或未清除停止等待状态')
  assert.ok(pauseAttempts >= 3)
  const stopped = (await s.fake.call('/platforms/qq-migration')).json()
  assert.equal(stopped.paused, true)
  assert.equal(stopped.pausePending, false)
  assert.equal(stopped.recoveryWaitingForStop, false)
  assert.equal(stopped.pauseReason, '')
  assert.equal(stopped.pauseStartedAt, status.pauseStartedAt)
  assert.ok(stopped.pauseAttempts >= 3)
  assert.equal(s.host.qqOwnership.status().paused, true)
  assert.equal(s.host.qqOwnership.status().bufferOverflow?.overflowed, true)
  const bufState = s.host.qqOwnership.bufferStatus('p1-2-overflow')
  assert.equal(bufState.entries.length, 2)
  assert.equal(bufState.overflow?.droppedSamples?.length, 1)
  assert.equal(bufState.overflow?.droppedSamples?.[0]?.messageId, '7003')
  assert.equal(bufState.overflow?.droppedSamples?.[0]?.text, '第3条超限消息')

  const legacyCard = (await s.fake.call('/platforms')).json().instances.find((x) => x.legacy)
  assert.match(legacyCard?.detail || '', /等待恢复确认.*迁移缓冲已满/)
  assert.throws(() => tx.commit({ txnId: 'p1-2-overflow', expectedRevision: s.host.qqOwnership.status().revision }), (err) => err?.code === 'MIGRATION_BUFFER_OVERFLOW')
})

test('P1-3：drain 超时后关闭缓冲并清理事务目录，迟到的 accepted 回执只记日志不重建事务目录', async (t) => {
  const s = await setupMigrationHostHarness(t, {
    hostOpts: { migrationDrainEntryTimeoutMs: 70 },
    flushHook: async () => {
      await delay(300)
    },
  })
  const tx = s.host.qqOwnership.begin({
    txnId: 'p1-3-late-receipt',
    expectedRevision: s.host.qqOwnership.status().revision,
    legacyQqEnabled: false,
    platform: s.platform,
  })
  await tx.prepare()
  s.pushManagedInbound(6001, '超时后才慢落盘的消息')
  await waitFor(() => s.host.qqOwnership.bufferStatus('p1-3-late-receipt').entries.length === 1, '消息未写入 held 缓冲')
  tx.commit({ txnId: 'p1-3-late-receipt', expectedRevision: s.host.qqOwnership.status().revision })
  await tx.finish()
  const txnDir = join(s.dataDir, 'qq-migration-txn', 'p1-3-late-receipt')
  assert.equal(existsSync(txnDir), false, 'finish 后事务目录应已清理')

  // 等延迟的 flush 与 late onVerified 回调跑完，确认不会重新创建事务目录或 buffer 文件
  await delay(400)
  assert.equal(existsSync(txnDir), false, '超时后迟到的 accepted 回执绝不能重建已清理事务目录')
  assert.equal(readRecoveryGuard(s.dataDir).phase, 'idle')
})

test('阶段三 P1-1 & P2-5：prepare 后收到 held 消息再 abort 不静默删盘，保持暂停并在重启与人工确认后恢复', async (t) => {
  const s = await setupMigrationHostHarness(t)
  const tx = s.host.qqOwnership.begin({
    txnId: 's3-p1-1-abort-held',
    expectedRevision: s.host.qqOwnership.status().revision,
    legacyQqEnabled: false,
    platform: s.platform,
  })
  await tx.prepare()
  s.pushManagedInbound(5101, 'abort 前在 held 期间收到的消息')
  await waitFor(() => s.host.qqOwnership.bufferStatus('s3-p1-1-abort-held').entries.length === 1, 'held 消息未入缓冲')

  await tx.abort()
  assert.equal(s.host.qqOwnership.status().legacyQqEnabled, true)
  assert.equal(s.host.qqOwnership.status().paused, true)
  assert.equal(s.host.onebot, null)
  assert.equal(readRecoveryGuard(s.dataDir).phase, 'aborted-uncertain')

  const txnRecord = readMigrationTxn(s.dataDir, 's3-p1-1-abort-held')
  assert.ok(txnRecord, '存在未决缓冲时 abort 不得删除事务目录')
  assert.equal(txnRecord.journal.phase, 'aborted-uncertain')
  const entries = s.host.qqOwnership.bufferStatus('s3-p1-1-abort-held').entries
  assert.equal(entries.length, 1)
  assert.equal(entries[0].status, 'uncertain')
  assert.equal(entries[0].reason, 'aborted-uncertain')

  // 人工确认解除后恢复旧版 QQ 连接并清理事务目录
  const res = await s.host.qqOwnership.resolveRecovery({ txnId: 's3-p1-1-abort-held', action: 'acknowledge' })
  assert.equal(res.ok, true)
  assert.equal(res.status.paused, false)
  assert.equal(readRecoveryGuard(s.dataDir).phase, 'idle')
  assert.equal(readMigrationTxn(s.dataDir, 's3-p1-1-abort-held'), null)
  await waitFor(() => s.legacy.connected() === 1, '确认恢复后旧版 QQ 应重连成功')
})

test('阶段三 P1-2：buffer overflow 后 abort 保留 buffer-overflow 恢复门与 paused 一致，不假恢复', async (t) => {
  const s = await setupMigrationHostHarness(t, { hostOpts: { migrationBufferMaxItems: 2 } })
  const tx = s.host.qqOwnership.begin({
    txnId: 's3-p1-2-overflow-abort',
    expectedRevision: s.host.qqOwnership.status().revision,
    legacyQqEnabled: false,
    platform: s.platform,
  })
  await tx.prepare()
  s.pushManagedInbound(5201, '缓冲A')
  s.pushManagedInbound(5202, '缓冲B')
  s.pushManagedInbound(5203, '溢出消息C')
  await waitFor(() => readRecoveryGuard(s.dataDir).phase === 'buffer-overflow', '未进入 buffer-overflow')

  await tx.abort()
  assert.equal(s.host.qqOwnership.status().legacyQqEnabled, true)
  assert.equal(s.host.qqOwnership.status().paused, true, 'overflow 后 abort 仍应保持 paused=true')
  assert.equal(readRecoveryGuard(s.dataDir).phase, 'buffer-overflow', 'overflow 后 abort 不得清除恢复门')
  assert.equal(s.host.onebot, null)
  assert.equal(s.legacy.connected(), 0)

  const buf = s.host.qqOwnership.bufferStatus('s3-p1-2-overflow-abort')
  assert.equal(buf.entries.length, 2)
  assert.ok(buf.entries.every((e) => e.status === 'uncertain'))
  assert.equal(buf.overflow?.droppedSamples?.[0]?.text, '溢出消息C')

  await s.host.qqOwnership.resolveRecovery({ txnId: 's3-p1-2-overflow-abort', action: 'acknowledge' })
  assert.equal(s.host.qqOwnership.status().paused, false)
  await waitFor(() => s.legacy.connected() === 1, '人工确认后应恢复旧版 QQ 连接')
})

test('阶段三 P1-3：finish 的 resume 失败时保留事务与 migration-ambiguous 恢复门，重启后仍暂停', async (t) => {
  const s = await setupMigrationHostHarness(t)
  const tx = s.host.qqOwnership.begin({
    txnId: 's3-p1-3-resume-fail',
    expectedRevision: s.host.qqOwnership.status().revision,
    legacyQqEnabled: false,
    platform: s.platform,
  })
  await tx.prepare()
  tx.commit({ txnId: 's3-p1-3-resume-fail', expectedRevision: s.host.qqOwnership.status().revision })

  // 让 finish() 内部的 resume() -> gw.sync() 抛出故障
  const origSync = s.host.gateway.sync
  s.host.gateway.sync = async () => {
    throw new Error('simulated-resume-sync-failure')
  }
  await assert.rejects(tx.finish(), /simulated-resume-sync-failure/)
  s.host.gateway.sync = origSync

  assert.equal(s.host.qqOwnership.status().paused, true)
  assert.equal(readRecoveryGuard(s.dataDir).phase, 'migration-ambiguous')
  const txnOnDisk = readMigrationTxn(s.dataDir, 's3-p1-3-resume-fail')
  assert.ok(txnOnDisk, 'resume 失败时不得清理事务目录')
  assert.equal(txnOnDisk.journal.phase, 'migration-ambiguous')

  // 停掉旧宿主后重启新宿主：不得按无事务正常放行默认 QQ
  s.fake.dispose()
  await s.host.gateway?.stopAll?.()
  const fake2 = createFakeDsh({ brain: async () => 'ok' })
  const { apply } = await import('../src/host.js')
  const host2 = apply(fake2.ctx, { migrationTimeoutMs: 5000 })
  t.after(async () => {
    fake2.dispose()
    try { await host2.gateway?.stopAll?.() } catch {}
  })
  await host2.ready
  assert.equal(host2.qqOwnership.status().paused, true, '重启后仍须保持暂停状态')
  assert.equal(readRecoveryGuard(s.dataDir).phase, 'migration-ambiguous')
  assert.equal(host2.onebot, null)
})

test('阶段三 P2-3：buffer 损坏 fail-closed 拒绝 release 并标 migration-ambiguous', async (t) => {
  const s1 = await setupMigrationHostHarness(t)
  const tx1 = s1.host.qqOwnership.begin({
    txnId: 's3-p2-3-corrupt-buf',
    expectedRevision: s1.host.qqOwnership.status().revision,
    legacyQqEnabled: false,
    platform: s1.platform,
  })
  await tx1.prepare()
  s1.pushManagedInbound(5301, '正常消息1')
  await waitFor(() => s1.host.qqOwnership.bufferStatus('s3-p2-3-corrupt-buf').entries.length === 1, '消息未写入')
  // 破坏磁盘上的 buffer 文件为非法 JSON
  writeFileSync(join(s1.dataDir, 'qq-migration-txn', 's3-p2-3-corrupt-buf', 'buffer', '00000001.json'), '{corrupt json')

  const st = s1.host.qqOwnership.bufferStatus('s3-p2-3-corrupt-buf')
  assert.equal(st.corrupt, true)
  assert.deepEqual(st.corruptFiles, ['00000001.json'])
  assert.throws(() => tx1.commit({ txnId: 's3-p2-3-corrupt-buf', expectedRevision: s1.host.qqOwnership.status().revision }), (err) => err?.code === 'MIGRATION_BUFFER_CORRUPT')
  assert.equal(readRecoveryGuard(s1.dataDir).phase, 'migration-ambiguous')
  assert.equal(s1.host.qqOwnership.status().paused, true)
})

test('阶段三 P2-2：abort 阶段配置恢复写回失败不吞错，保留事务与 migration-ambiguous 恢复门', async (t) => {
  const s2 = await setupMigrationHostHarness(t)
  const tx2 = s2.host.qqOwnership.begin({
    txnId: 's3-p2-2-abort-cfg-fail',
    expectedRevision: s2.host.qqOwnership.status().revision,
    legacyQqEnabled: false,
    platform: s2.platform,
  })
  await tx2.prepare()
  // 将 config.json 替换为同名目录，触发 writeRawConfigAtomic renameSync 失败
  rmSync(join(s2.dataDir, 'config.json'), { force: true })
  mkdirSync(join(s2.dataDir, 'config.json'), { recursive: true })
  await assert.rejects(tx2.abort())
  assert.equal(s2.host.qqOwnership.status().paused, true)
  assert.equal(readRecoveryGuard(s2.dataDir).phase, 'migration-ambiguous')
  assert.ok(readMigrationTxn(s2.dataDir, 's3-p2-2-abort-cfg-fail'), '写回失败时必须保留事务与恢复门')
})

test('阶段四 P2-4：overflow.json 损坏归入 corrupt，阻塞 release 并标 migration-ambiguous', async (t) => {
  const s = await setupMigrationHostHarness(t)
  const tx = s.host.qqOwnership.begin({
    txnId: 's4-p2-4-corrupt-overflow',
    expectedRevision: s.host.qqOwnership.status().revision,
    legacyQqEnabled: false,
    platform: s.platform,
  })
  await tx.prepare()
  const bufDir = join(s.dataDir, 'qq-migration-txn', 's4-p2-4-corrupt-overflow', 'buffer')
  mkdirSync(bufDir, { recursive: true })
  writeFileSync(join(bufDir, 'overflow.json'), '{broken-overflow')

  const st = s.host.qqOwnership.bufferStatus('s4-p2-4-corrupt-overflow')
  assert.equal(st.corrupt, true)
  assert.deepEqual(st.corruptFiles, ['overflow.json'])
  assert.throws(() => tx.commit({ txnId: 's4-p2-4-corrupt-overflow', expectedRevision: s.host.qqOwnership.status().revision }), (err) => err?.code === 'MIGRATION_BUFFER_CORRUPT')
  assert.equal(readRecoveryGuard(s.dataDir).phase, 'migration-ambiguous')
  assert.equal(s.host.qqOwnership.status().paused, true)
})

test('阶段四 P2-2：finish 的 resume 失败时主动停掉网关 qq 实例且不显示 connected', async (t) => {
  const s = await setupMigrationHostHarness(t)
  const tx = s.host.qqOwnership.begin({
    txnId: 's4-p2-2-finish-stop',
    expectedRevision: s.host.qqOwnership.status().revision,
    legacyQqEnabled: false,
    platform: s.platform,
  })
  await tx.prepare()
  tx.commit({ txnId: 's4-p2-2-finish-stop', expectedRevision: s.host.qqOwnership.status().revision })
  s.host.gateway.sync = async () => { throw new Error('gw-sync-boom') }
  await assert.rejects(tx.finish(), /gw-sync-boom/)

  const qqCard = (await s.fake.call('/platforms')).json().instances.find((x) => x.instance === 'qq')
  assert.equal(qqCard?.state, 'stopped', 'resume 失败后网关 qq 实例必须主动停下而非仍显示 connected')
  assert.match(qqCard?.detail || '', /等待恢复确认/)
  assert.equal(s.host.qqOwnership.status().paused, true)
  assert.equal(readRecoveryGuard(s.dataDir).phase, 'migration-ambiguous')
})

test('阶段四 P2-3：abort 无未决时若 resume 失败也写 migration-ambiguous 恢复门并保持 paused', async (t) => {
  const s = await setupMigrationHostHarness(t)
  const tx = s.host.qqOwnership.begin({
    txnId: 's4-p2-3-abort-resume-fail',
    expectedRevision: s.host.qqOwnership.status().revision,
    legacyQqEnabled: false,
    platform: s.platform,
  })
  await tx.prepare()
  s.host.gateway.sync = async () => { throw new Error('abort-sync-boom') }
  await assert.rejects(tx.abort(), /abort-sync-boom/)

  assert.equal(s.host.qqOwnership.status().paused, true)
  assert.equal(readRecoveryGuard(s.dataDir).phase, 'migration-ambiguous')
  assert.ok(readMigrationTxn(s.dataDir, 's4-p2-3-abort-resume-fail'))
})

test('阶段四 P2-1 / P2-5 / P2-6：/platforms/qq-migration* 开放迁移/恢复接口、统一状态视图与前端契约', async (t) => {
  const s = await setupMigrationHostHarness(t)

  // 1) preflight + GET /platforms/qq-migration + /platforms 卡片 unified model
  const pre = (await s.fake.call('/platforms/qq-migration/preflight', {})).json()
  assert.equal(pre.ok, true)
  const v0 = (await s.fake.call('/platforms/qq-migration')).json()
  assert.equal(v0.ownerMode, 'legacy')
  assert.equal(v0.phase, 'idle')
  assert.deepEqual(v0.recommendedActions, ['start'])
  const p0 = (await s.fake.call('/platforms')).json()
  assert.equal(p0.qqMigration.ownerMode, 'legacy')
  assert.equal(p0.instances.find((x) => x.instance === 'qq')?.migration?.phase, 'idle')

  // 2) POST /platforms/qq-migration/start（旧版直连 -> 网关托管）
  const started = (await s.fake.call('/platforms/qq-migration/start', {
    targetLegacyQqEnabled: false,
    platform: s.platform,
  })).json()
  assert.equal(started.ok, true)
  assert.equal(started.view.ownerMode, 'gateway')
  assert.equal(started.view.phase, 'idle')
  assert.deepEqual(started.view.recommendedActions, ['rollback'])
  await waitFor(() => s.managed.connected() === 1 && s.legacy.connected() === 0, '迁移接口应切到网关 QQ 托管')

  // 3) POST /platforms/qq-migration/rollback（空闲网关模式切回旧版直连）
  const rolledBack = (await s.fake.call('/platforms/qq-migration/rollback', {})).json()
  assert.equal(rolledBack.ok, true)
  assert.equal(rolledBack.view.ownerMode, 'legacy')
  await waitFor(() => s.legacy.connected() === 1 && s.managed.connected() === 0, 'rollback 接口应安全切回旧版直连 QQ')
  await waitForLegacyLogin(s.fake)

  // 4) 制造 held 消息后 abort -> /platforms/qq-migration 暴露统一详情，再调 /discard-uncertain 恢复
  const tx = s.host.qqOwnership.begin({
    txnId: 's4-ui-abort-recover',
    expectedRevision: s.host.qqOwnership.status().revision,
    legacyQqEnabled: false,
    platform: s.platform,
  })
  await tx.prepare()
  s.pushManagedInbound(8801, '需要在恢复面板看到的正文')
  await waitFor(() => s.host.qqOwnership.bufferStatus('s4-ui-abort-recover').entries.length === 1, '消息未入缓冲')
  await tx.abort()

  const migView = (await s.fake.call('/platforms/qq-migration')).json()
  assert.equal(migView.phase, 'aborted-uncertain')
  assert.equal(migView.paused, true)
  assert.equal(migView.txnId, 's4-ui-abort-recover')
  assert.equal(migView.buffer.totalCount, 1)
  assert.equal(migView.buffer.uncertainCount, 1)
  assert.equal(migView.buffer.entries[0].text, '需要在恢复面板看到的正文')
  assert.match(migView.buffer.entries[0].source, /私聊/)
  assert.ok(migView.recommendedActions.includes('discard-uncertain'))

  const disc = (await s.fake.call('/platforms/qq-migration/discard-uncertain', {
    txnId: 's4-ui-abort-recover',
  })).json()
  assert.equal(disc.ok, true)
  assert.equal(disc.view.paused, false)
  assert.equal(disc.view.phase, 'idle')

  // 5) committed 但未 finish 的事务 -> 调 POST /platforms/qq-migration/retry 完成恢复
  assert.equal((await s.fake.call('/onebot/reconnect')).json().ok, true)
  const txRetry = s.host.qqOwnership.begin({
    txnId: 's4-ui-retry',
    expectedRevision: s.host.qqOwnership.status().revision,
    legacyQqEnabled: false,
    platform: s.platform,
  })
  await txRetry.prepare()
  txRetry.commit({ txnId: 's4-ui-retry', expectedRevision: s.host.qqOwnership.status().revision })
  const origSync = s.host.gateway.sync
  s.host.gateway.sync = async () => { throw new Error('temp-sync-err') }
  await assert.rejects(txRetry.finish(), /temp-sync-err/)
  s.host.gateway.sync = origSync

  const retryRes = (await s.fake.call('/platforms/qq-migration/retry', {
    txnId: 's4-ui-retry',
  })).json()
  assert.equal(retryRes.ok, true)
  assert.equal(retryRes.view.paused, false)
  assert.equal(retryRes.view.ownerMode, 'gateway')

  // 6) client/client.js 面板契约检查：已接入所有恢复接口与状态展示
  const clientSrc = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  for (const needle of [
    '/platforms/qq-migration',
    '/preflight',
    '/start',
    '/retry',
    '/discard-uncertain',
    '/rollback',
    'OneBot WS URL',
    'WS Token（留空=沿用）',
    '默认 QQ 托管与迁移恢复',
  ]) {
    assert.ok(clientSrc.includes(needle), `client/client.js 缺少迁移面板契约项：${needle}`)
  }
})

test('阶段五 P1-1 & P1-5：txnId 路径穿越拦截与迁移接口方法强制校验', async (t) => {
  const s = await setupMigrationHostHarness(t)
  const sentinelFile = join(s.dataDir, 'sentinel-do-not-delete.txt')
  writeFileSync(sentinelFile, 'keep-me')

  // 1) 非法 txnId（含 .. / 分隔符）在底层目录/清理与宿主 API 一律被拒，绝不越出 qq-migration-txn/
  for (const badId of ['..', '../x', '..\\x', 'a/b', 'a\\b', '']) {
    assert.throws(() => migrationTxnDir(s.dataDir, badId), (err) => err?.code === 'INVALID_TXN_ID')
    assert.throws(() => cleanupMigrationTxn(s.dataDir, badId), (err) => err?.code === 'INVALID_TXN_ID')
    assert.throws(() => s.host.qqOwnership.begin({
      txnId: badId,
      expectedRevision: s.host.qqOwnership.status().revision,
      legacyQqEnabled: false,
      platform: s.platform,
    }), (err) => err?.code === 'INVALID_TXN_ID')
  }
  await assert.rejects(
    () => s.host.qqOwnership.resolveRecovery({ txnId: '../x', action: 'rollback' }),
    (err) => err?.code === 'INVALID_TXN_ID',
  )
  assert.throws(() => s.host.qqOwnership.bufferStatus('..'), (err) => err?.code === 'INVALID_TXN_ID')

  // HTTP 路由同样拒绝路径穿越 txnId
  for (const routePath of [
    '/platforms/qq-migration/start',
    '/platforms/qq-migration/retry',
    '/platforms/qq-migration/discard-uncertain',
    '/platforms/qq-migration/rollback',
    '/platforms/qq-migration/buffer/action',
  ]) {
    const r = (await s.fake.call(routePath, {
      txnId: '../x',
      action: 'rollback',
      targetLegacyQqEnabled: false,
      platform: s.platform,
    })).json()
    assert.equal(r.ok, false)
    assert.equal(r.code, 'INVALID_TXN_ID', `${routePath} 应返回 INVALID_TXN_ID`)
  }
  assert.equal(existsSync(sentinelFile), true, '路径穿越请求绝不能删除 qq-migration-txn 之外的文件')

  // 2) 非 POST/GET 方法拒绝
  for (const writeRoute of [
    '/platforms/qq-migration/start',
    '/platforms/qq-migration/retry',
    '/platforms/qq-migration/discard-uncertain',
    '/platforms/qq-migration/rollback',
    '/platforms/qq-migration/buffer/action',
  ]) {
    const getRes = (await s.fake.call(writeRoute)).json()
    assert.equal(getRes.ok, false)
    assert.equal(getRes.code, 'METHOD_NOT_ALLOWED', `GET ${writeRoute} 必须拒绝`)
  }
  const putStart = (await s.fake.call('/platforms/qq-migration/start', {}, {}, undefined, 'PUT')).json()
  assert.equal(putStart.ok, false)
  assert.equal(putStart.code, 'METHOD_NOT_ALLOWED')
  const postState = (await s.fake.call('/platforms/qq-migration', {}, {}, undefined, 'POST')).json()
  assert.equal(postState.ok, false)
  assert.equal(postState.code, 'METHOD_NOT_ALLOWED')
  assert.equal(s.host.qqOwnership.status().legacyQqEnabled, true)
})

test('阶段五 P1-2 & P2-3 & P2-5：无预配目标网关配置、preflight 缺端点拦截、token 留空沿用及 revision/并发幂等', async (t) => {
  // 1) 无 platforms.qq 与无 endpoint 场景：preflight 拦下，传入前端目标字段后放行 + revision/并发校验
  const dataDir1 = mkdtempSync(join(tmpdir(), 'aurabot-mig-s5-noep-'))
  const oldDir1 = process.env.AURABOT_DATA_DIR
  const oldWs1 = process.env.AURABOT_WORKSPACE
  process.env.AURABOT_DATA_DIR = dataDir1
  process.env.AURABOT_WORKSPACE = join(dataDir1, 'ws')
  const botQQ = '20000012'
  const ownerQQ = '10000011'
  const legacy1 = await startMockOneBot({ selfId: botQQ, token: 'tok-leg1' })
  const managed1 = await startMockOneBot({ selfId: botQQ, token: 'tok-man1' })
  const fake1 = createFakeDsh({ brain: async () => 'ok' })
  fake1.ctx.sessions = { async flush() { return true } }
  fake1.ctx.services.sessionPersistence = { async open(id) { return { id, async read() { return { events: [] } }, async close() {} } } }
  writeFileSync(join(dataDir1, 'config.json'), JSON.stringify({
    enabled: true,
    setupDone: true,
    dryRun: false,
    merge: { enabled: false },
    voice: { enabled: false },
    stickers: { enabled: false },
    gateway: 'onebot',
    botQQ,
    ownerQQ,
    // 无 wsUrl/httpUrl（模拟首次迁移且无 platforms.qq）
  }))
  const { apply } = await import('../src/host.js')
  const host1 = apply(fake1.ctx, { migrationTimeoutMs: 5000 })
  t.after(async () => {
    fake1.dispose()
    try { await host1.gateway?.stopAll?.() } catch {}
    await Promise.race([Promise.all([legacy1.close(), managed1.close()]), delay(400)])
    if (oldDir1 === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = oldDir1
    if (oldWs1 === undefined) delete process.env.AURABOT_WORKSPACE
    else process.env.AURABOT_WORKSPACE = oldWs1
    rmSync(dataDir1, { recursive: true, force: true })
  })
  await host1.ready

  const missingPre = (await fake1.call('/platforms/qq-migration/preflight', {})).json()
  assert.equal(missingPre.ok, false)
  assert.equal(missingPre.reason, 'missing-target-endpoint')

  // 手动切换用传入的 platform（先让 legacy 在运行中配置上 legacy endpoint，测试无 platforms.qq 时通过面板传 target）
  const passedPre = (await fake1.call('/platforms/qq-migration/preflight', {
    platform: { backend: 'onebot', wsUrl: managed1.wsUrl, httpUrl: managed1.httpUrl, wsToken: managed1.token, httpToken: managed1.token },
  })).json()
  assert.equal(passedPre.ok, true)

  // 2) 使用 setupMigrationHostHarness 测 stale revision、并发 start 与 duplicate start、留空沿用已有 token
  const s = await setupMigrationHostHarness(t)
  const staleRes = (await s.fake.call('/platforms/qq-migration/start', {
    targetLegacyQqEnabled: false,
    expectedRevision: 9999,
    platform: s.platform,
  })).json()
  assert.equal(staleRes.ok, false)
  assert.equal(staleRes.code, 'REVISION_MISMATCH')

  const rev = s.host.qqOwnership.status().revision
  const platform = { ...s.platform, wsToken: s.platform.token, httpToken: s.platform.token }
  const [c1, c2] = await Promise.all([
    s.fake.call('/platforms/qq-migration/start', {
      txnId: 's5-conc-1',
      expectedRevision: rev,
      targetLegacyQqEnabled: false,
      platform,
    }),
    s.fake.call('/platforms/qq-migration/start', {
      txnId: 's5-conc-2',
      expectedRevision: rev,
      targetLegacyQqEnabled: false,
      platform,
    }),
  ])
  const r1 = c1.json()
  const r2 = c2.json()
  const okCount = [r1, r2].filter((x) => x.ok === true).length
  const errRes = [r1, r2].find((x) => x.ok === false)
  assert.equal(okCount, 1, '并发 start 只能有一个成功')
  assert.ok(['MIGRATION_BUSY', 'REVISION_MISMATCH', 'ALREADY_IN_TARGET_MODE', 'migration-busy'].includes(errRes.code || errRes.reason))

  const dupRes = (await s.fake.call('/platforms/qq-migration/start', {
    targetLegacyQqEnabled: false,
    platform: s.platform,
  })).json()
  assert.equal(dupRes.ok, false)
  assert.equal(dupRes.code, 'ALREADY_IN_TARGET_MODE')

  // 切回 legacy 后，此时 cfg.platforms.qq 已保存 s.platform；修改 wsUrl/httpUrl 但 token/wsToken/httpToken 留空 => 沿用原 token
  assert.equal((await s.fake.call('/platforms/qq-migration/rollback', {})).json().ok, true)
  await waitFor(() => s.legacy.connected() === 1 && s.managed.connected() === 0, '回切旧版直连失败')
  await waitForLegacyLogin(s.fake)
  const curStoredToken = s.host.getConfig().platforms?.qq?.token
  assert.equal(curStoredToken, s.platform.token)
  const keepTokenRes = (await s.fake.call('/platforms/qq-migration/start', {
    targetLegacyQqEnabled: false,
    platform: {
      backend: 'onebot',
      wsUrl: s.managed.wsUrl,
      httpUrl: s.managed.httpUrl,
      wsToken: '',
      httpToken: '',
      token: '',
    },
  })).json()
  assert.equal(keepTokenRes.ok, true, '只改 URL 且 token 留空时应沿用现有 token 完成迁移')
  const kept = s.host.getConfig().platforms.qq
  assert.equal(kept.token, s.platform.token)
  assert.equal(kept.wsToken, s.platform.token)
  assert.equal(kept.httpToken, s.platform.token)

  assert.equal((await s.fake.call('/platforms/qq-migration/rollback', {})).json().ok, true)
  await waitForLegacyLogin(s.fake)
  const cleared = (await s.fake.call('/platforms/qq-migration/start', {
    targetLegacyQqEnabled: false,
    token: '',
    platform: { wsToken: null },
  })).json()
  assert.equal(cleared.ok, true, cleared.message)
  const configured = s.host.getConfig().platforms.qq
  assert.equal(configured.token, s.platform.token, '顶层的显式空串应沿用统一令牌')
  assert.equal(configured.wsToken, '', 'null 清除 WS 独立覆盖，端点继续继承统一令牌')
  assert.equal(configured.httpToken, s.platform.token, '未发送的 HTTP 令牌应沿用')
  assert.equal((await s.fake.call('/platforms/qq-migration/rollback', {})).json().ok, true)
  await waitForLegacyLogin(s.fake)
  const clearedUnified = (await s.fake.call('/platforms/qq-migration/start', {
    targetLegacyQqEnabled: false,
    token: null,
    platform: { wsToken: s.platform.token },
  })).json()
  assert.equal(clearedUnified.ok, true, clearedUnified.message)
  assert.equal(s.host.getConfig().platforms.qq.token, '', '顶层 null 应清除统一令牌')
})

test('阶段五 P1-3 & P1-4 & P2-2：commit/finish 失败进程内恢复、gateway 目标 discard 强制验号与备份冲突拦截', async (t) => {
  // 1) commit() 因 buffer overflow 失败后，进程内不应卡死，/rollback 可立即回滚并恢复旧版 QQ
  const s1 = await setupMigrationHostHarness(t, { hostOpts: { migrationBufferMaxItems: 1 } })
  const txCommitFail = s1.host.qqOwnership.begin({
    txnId: 's5-commit-overflow',
    expectedRevision: s1.host.qqOwnership.status().revision,
    legacyQqEnabled: false,
    platform: s1.platform,
  })
  await txCommitFail.prepare()
  s1.pushManagedInbound(7101, '占位消息1')
  s1.pushManagedInbound(7102, '触发溢出的消息2')
  await waitFor(() => readRecoveryGuard(s1.dataDir).phase === 'buffer-overflow', '未触发 buffer-overflow')
  assert.throws(() => txCommitFail.commit({
    txnId: 's5-commit-overflow',
    expectedRevision: s1.host.qqOwnership.status().revision,
  }), (err) => err?.code === 'MIGRATION_BUFFER_OVERFLOW')

  const viewAfterCommitFail = (await s1.fake.call('/platforms/qq-migration')).json()
  assert.equal(viewAfterCommitFail.busy, false)
  assert.equal(viewAfterCommitFail.paused, true)
  assert.ok(viewAfterCommitFail.recommendedActions.includes('rollback'), 'commit 失败后进程内必须保留可恢复操作')

  const originalPause = s1.host.gateway.pauseInstance
  s1.host.gateway.pauseInstance = async (instance, reason, options) => options?.forceReleaseLease
    ? false : originalPause(instance, reason, options)
  try {
    const phaseBefore = s1.host.qqOwnership.status().phase
    const blocked = (await s1.fake.call('/platforms/qq-migration/rollback', { txnId: 's5-commit-overflow' })).json()
    assert.equal(blocked.code, 'INSTANCE_STOP_PENDING')
    assert.equal(s1.host.qqOwnership.status().phase, phaseBefore, '停机尚未确认时应保留活动迁移')
    assert.ok(readMigrationTxn(s1.dataDir, 's5-commit-overflow'))
    assert.equal(s1.host.qqOwnership.bufferStatus('s5-commit-overflow').entries.length, 1)
  } finally {
    s1.host.gateway.pauseInstance = originalPause
  }
  const request = { txnId: 's5-commit-overflow', retryStopPending: true }
  const rollbackRoute = '/platforms/qq-migration/rollback'
  let stopRequests = 0
  s1.host.gateway.pauseInstance = async (instance, reason, options) => {
    if (!options?.forceReleaseLease) return originalPause(instance, reason, options)
    stopRequests++
    writeRecoveryGuard(s1.dataDir, { reason: '等待停机期间恢复状态发生变化' })
    return false
  }
  try {
    const changed = (await s1.fake.call(rollbackRoute, request)).json()
    assert.equal(changed.code, 'RECOVERY_STATE_CHANGED')
    assert.equal(stopRequests, 1, '恢复状态变化后不得再次发起停机')
    assert.equal(readRecoveryGuard(s1.dataDir).reason, '等待停机期间恢复状态发生变化')
    assert.ok(readMigrationTxn(s1.dataDir, request.txnId))
  } finally {
    s1.host.gateway.pauseInstance = originalPause
  }

  stopRequests = 0
  s1.host.gateway.pauseInstance = async (instance, reason, options) => {
    if (options?.forceReleaseLease && ++stopRequests === 1) return false
    return originalPause(instance, reason, options)
  }
  let rbAfterCommitFail
  try {
    rbAfterCommitFail = (await s1.fake.call(rollbackRoute, request)).json()
    assert.equal(stopRequests, 2, '同一次回滚只应复查一次停机状态')
  } finally {
    s1.host.gateway.pauseInstance = originalPause
  }
  assert.equal(rbAfterCommitFail.ok, true)
  assert.equal(rbAfterCommitFail.view.paused, false)
  assert.equal(rbAfterCommitFail.view.ownerMode, 'legacy')
  await waitFor(() => s1.legacy.connected() === 1 && s1.managed.connected() === 0, 'commit 失败后进程内 /rollback 未恢复直连')

  // 2) finish() 因 drain bound 失败后，进程内可调 /retry 继续排空并完成迁移
  let roundCount = 0
  let s2
  s2 = await setupMigrationHostHarness(t, {
    hostOpts: { migrationMaxDrainRounds: 1 },
    flushHook: async () => {
      roundCount++
      if (roundCount === 1) {
        s2.pushManagedInbound(7202, 'finish 首轮期间到达的新消息')
        await delay(30)
      }
    },
  })
  const txFinishFail = s2.host.qqOwnership.begin({
    txnId: 's5-finish-drain-bound',
    expectedRevision: s2.host.qqOwnership.status().revision,
    legacyQqEnabled: false,
    platform: s2.platform,
  })
  await txFinishFail.prepare()
  s2.pushManagedInbound(7201, 'held 首批消息')
  await waitFor(() => s2.host.qqOwnership.bufferStatus('s5-finish-drain-bound').entries.length === 1, '首条消息未入缓冲')
  txFinishFail.commit({ txnId: 's5-finish-drain-bound', expectedRevision: s2.host.qqOwnership.status().revision })
  await assert.rejects(txFinishFail.finish(), (err) => err?.code === 'MIGRATION_DRAIN_BOUND_EXCEEDED')

  const viewAfterFinishFail = (await s2.fake.call('/platforms/qq-migration')).json()
  assert.equal(viewAfterFinishFail.busy, false)
  assert.equal(viewAfterFinishFail.paused, true)
  assert.equal(viewAfterFinishFail.pauseHeld, true)
  assert.equal(viewAfterFinishFail.pausePending, false)
  assert.equal(viewAfterFinishFail.recoveryWaitingForStop, false)
  assert.match(viewAfterFinishFail.pauseReason, /迁移租约/)
  assert.ok(viewAfterFinishFail.recommendedActions.includes('retry'))
  assert.ok(viewAfterFinishFail.recommendedActions.includes('rollback'))

  const retryFinish = (await s2.fake.call('/platforms/qq-migration/retry', {
    txnId: 's5-finish-drain-bound',
  })).json()
  assert.equal(retryFinish.ok, true)
  assert.equal(retryFinish.view.paused, false)
  assert.equal(retryFinish.view.ownerMode, 'gateway')
  await waitFor(() => s2.fake.turns.length >= 2 && s2.managed.connected() === 1, 'finish 失败后 /retry 应排空全部消息并放行')

  // 3) P1-4 + P2-2：gateway 目标下 acknowledge 被拒、discard-uncertain 必须经 held + whenReady 验号、pending backup 时阻塞恢复
  assert.equal((await s2.fake.call('/platforms/qq-migration/rollback', {})).json().ok, true)
  await waitFor(() => s2.legacy.connected() === 1, '切回旧版失败')
  assert.equal((await s2.fake.call('/onebot/reconnect')).json().ok, true)

  const txGw = s2.host.qqOwnership.begin({
    txnId: 's5-gw-discard-verify',
    expectedRevision: s2.host.qqOwnership.status().revision,
    legacyQqEnabled: false,
    platform: s2.platform,
  })
  await txGw.prepare()
  s2.pushManagedInbound(7301, '网关目标下触发恢复的消息')
  await waitFor(() => s2.host.qqOwnership.bufferStatus('s5-gw-discard-verify').entries.length === 1, '未写入 held')
  txGw.commit({ txnId: 's5-gw-discard-verify', expectedRevision: s2.host.qqOwnership.status().revision })

  const origSync = s2.host.gateway.sync
  s2.host.gateway.sync = async () => { throw new Error('gw-sync-pause') }
  await assert.rejects(txGw.finish(), /gw-sync-pause/)
  s2.host.gateway.sync = origSync

  // 制造 pending backup 冲突 -> P2-2 阻止恢复
  writeFileSync(join(s2.dataDir, '.restore-pending.json'), JSON.stringify({ file: 'dummy.tar.gz', at: Date.now() }))
  const blockedByBackup = (await s2.fake.call('/platforms/qq-migration/discard-uncertain', {
    txnId: 's5-gw-discard-verify',
  })).json()
  assert.equal(blockedByBackup.ok, false)
  assert.equal(blockedByBackup.code, 'BACKUP_RESTORE_PENDING')
  rmSync(join(s2.dataDir, '.restore-pending.json'), { force: true })

  // gateway 目标拒绝 acknowledge 直接跳过验号
  const ackRes = (await s2.fake.call('/platforms/qq-migration/buffer/action', {
    txnId: 's5-gw-discard-verify',
    action: 'acknowledge',
  })).json()
  assert.equal(ackRes.ok, false)
  assert.equal(ackRes.code, 'ACKNOWLEDGE_REQUIRES_LEGACY')

  // 包装 gateway.acquireLease 验证 discard-uncertain 先 fail-closed 验号失败后仍暂停，再次验号通过才放行
  let verifyAttempt = 0
  let heldStarted = false
  let whenReadyChecked = false
  const origAcquireLease = s2.host.gateway.acquireLease.bind(s2.host.gateway)
  s2.host.gateway.acquireLease = async (instance, leaseOpts) => {
    const lease = await origAcquireLease(instance, leaseOpts)
    return {
      ...lease,
      async startHeld() {
        heldStarted = true
        return await lease.startHeld()
      },
      async whenReady(waitOpts) {
        whenReadyChecked = true
        verifyAttempt++
        if (verifyAttempt === 1) throw new Error('模拟网关目标验号失败')
        return await lease.whenReady(waitOpts)
      },
    }
  }

  const discardFail = (await s2.fake.call('/platforms/qq-migration/discard-uncertain', {
    txnId: 's5-gw-discard-verify',
  })).json()
  assert.equal(discardFail.ok, false)
  assert.equal(heldStarted, true)
  assert.equal(whenReadyChecked, true)
  assert.equal(discardFail.view.paused, true, 'discard-uncertain 验号失败后必须保持 paused=true')

  heldStarted = false
  whenReadyChecked = false
  const discardOk = (await s2.fake.call('/platforms/qq-migration/discard-uncertain', {
    txnId: 's5-gw-discard-verify',
  })).json()
  assert.equal(discardOk.ok, true)
  assert.equal(heldStarted, true, 'gateway 目标 discard-uncertain 必须先 startHeld')
  assert.equal(whenReadyChecked, true, 'gateway 目标 discard-uncertain 必须先完成 whenReady 验号')
  assert.equal(discardOk.view.paused, false)
  assert.equal(discardOk.view.ownerMode, 'gateway')
  await waitFor(() => s2.managed.connected() === 1, 'discard-uncertain 验号放行后网关应处于 connected')
})

test('阶段六 P2-1 ~ P2-6：恢复失败统一落 guard、HTTP-only 预检拦截、非法 guard txnId 视图降级与显式丢弃审计', async (t) => {
  // 1) P2-3：HTTP-only 目标（无 wsUrl）不能通过 preflight 与 start
  const dataDirHttp = mkdtempSync(join(tmpdir(), 'aurabot-mig-s6-httponly-'))
  const oldDirH = process.env.AURABOT_DATA_DIR
  const oldWsH = process.env.AURABOT_WORKSPACE
  process.env.AURABOT_DATA_DIR = dataDirHttp
  process.env.AURABOT_WORKSPACE = join(dataDirHttp, 'ws')
  const botQQ = '20000022'
  const ownerQQ = '10000021'
  const legacyH = await startMockOneBot({ selfId: botQQ, token: 'tok-leg-h' })
  const managedH = await startMockOneBot({ selfId: botQQ, token: 'tok-man-h' })
  const fakeH = createFakeDsh({ brain: async () => 'ok' })
  fakeH.ctx.sessions = { async flush() { return true } }
  fakeH.ctx.services.sessionPersistence = { async open(id) { return { id, async read() { return { events: [] } }, async close() {} } } }
  writeFileSync(join(dataDirHttp, 'config.json'), JSON.stringify({
    enabled: true,
    setupDone: true,
    dryRun: false,
    merge: { enabled: false },
    voice: { enabled: false },
    stickers: { enabled: false },
    gateway: 'onebot',
    botQQ,
    ownerQQ,
    snowluma: {
      httpUrl: legacyH.httpUrl,
      wsUrl: '',
      httpToken: legacyH.token,
      wsToken: legacyH.token,
    },
  }))
  const { apply } = await import('../src/host.js')
  const hostH = apply(fakeH.ctx, { migrationTimeoutMs: 5000 })
  await hostH.ready
  const httpOnlyPre = (await fakeH.call('/platforms/qq-migration/preflight', {
    platform: { backend: 'onebot', wsUrl: '', httpUrl: managedH.httpUrl },
  })).json()
  assert.equal(httpOnlyPre.ok, false)
  assert.equal(httpOnlyPre.reason, 'missing-target-ws-url')
  const httpOnlyStart = (await fakeH.call('/platforms/qq-migration/start', {
    targetLegacyQqEnabled: false,
    platform: { backend: 'onebot', wsUrl: '', httpUrl: managedH.httpUrl },
  })).json()
  assert.equal(httpOnlyStart.ok, false)
  assert.equal(httpOnlyStart.reason, 'missing-target-ws-url')
  fakeH.dispose()
  try { await hostH.gateway?.stopAll?.() } catch {}
  await Promise.race([Promise.all([legacyH.close(), managedH.close()]), delay(400)])
  if (oldDirH === undefined) delete process.env.AURABOT_DATA_DIR
  else process.env.AURABOT_DATA_DIR = oldDirH
  if (oldWsH === undefined) delete process.env.AURABOT_WORKSPACE
  else process.env.AURABOT_WORKSPACE = oldWsH
  rmSync(dataDirHttp, { recursive: true, force: true })

  // 2) P2-4：qq-recovery-guard.json 含非法 txnId 时 /platforms 与 /platforms/qq-migration 不抛 500，降级标 guardInvalid
  const s = await setupMigrationHostHarness(t)
  writeFileSync(join(s.dataDir, 'qq-recovery-guard.json'), JSON.stringify({
    version: 1,
    phase: 'recovering',
    txnId: '../bad-guard-id',
    dataEpoch: 0,
    reason: '手工注入非法事务号',
    updatedAt: Date.now(),
  }))
  const badView = (await s.fake.call('/platforms/qq-migration')).json()
  assert.equal(badView.ok, true)
  assert.equal(badView.txnId, '')
  assert.equal(badView.guardInvalid, true)
  assert.equal(badView.buffer.corrupt, true)
  assert.ok(badView.buffer.corruptFiles.includes('guard-invalid'))
  const badPlats = (await s.fake.call('/platforms')).json()
  assert.equal(badPlats.ok, true)
  assert.equal(badPlats.qqMigration.guardInvalid, true)
  // 调用 rollback 可清理非法 guard 并写审计
  const cleanBadGuard = (await s.fake.call('/platforms/qq-migration/rollback', {
    operator: 'sec-admin',
    reason: '清理损坏 guard',
  })).json()
  assert.equal(cleanBadGuard.ok, true)
  assert.equal(cleanBadGuard.view.lastResolution?.action, 'rollback')
  assert.equal(cleanBadGuard.view.lastResolution?.operator, 'sec-admin')
  assert.equal((await s.fake.call('/onebot/reconnect')).json().ok, true)

  // 3) P2-2 + P2-1：rollback 快照校验失败（clearActiveTransfer 后抛出）仍统一保 paused + migration-ambiguous guard
  const txRb = s.host.qqOwnership.begin({
    txnId: 's6-rb-corrupt-snap',
    expectedRevision: s.host.qqOwnership.status().revision,
    legacyQqEnabled: false,
    platform: s.platform,
  })
  await txRb.prepare()
  s.pushManagedInbound(8201, '快照损坏前的 held 消息')
  await waitFor(() => s.host.qqOwnership.bufferStatus('s6-rb-corrupt-snap').entries.length === 1, 'held 消息未落盘')
  txRb.commit({ txnId: 's6-rb-corrupt-snap', expectedRevision: s.host.qqOwnership.status().revision })
  // 让 finish 进入可恢复暂停态，再篡改快照 hash
  const origSync = s.host.gateway.sync
  s.host.gateway.sync = async () => { throw new Error('pause-before-rb') }
  await assert.rejects(txRb.finish(), /pause-before-rb/)
  s.host.gateway.sync = origSync
  writeFileSync(join(s.dataDir, 'qq-migration-txn', 's6-rb-corrupt-snap', 'config.raw.pre.json'), JSON.stringify({ version: 1, hash: 'tampered-hash' }))

  const rbFail = (await s.fake.call('/platforms/qq-migration/rollback', { txnId: 's6-rb-corrupt-snap' })).json()
  assert.equal(rbFail.ok, false)
  assert.equal(s.host.qqOwnership.status().paused, true)
  assert.equal(readRecoveryGuard(s.dataDir).phase, 'migration-ambiguous')
  const cardRbFail = (await s.fake.call('/platforms')).json().instances.find((x) => x.instance === 'qq')
  assert.equal(cardRbFail?.state, 'stopped')

  // 4) P2-1 + P2-5：clearActiveTransfer 后 gateway 未就绪（acquireLease 抛错）仍保持 migration-ambiguous，随后显式丢弃并保留审计记录
  const origAcquire = s.host.gateway.acquireLease.bind(s.host.gateway)
  s.host.gateway.acquireLease = async () => { throw new Error('gateway-not-ready-after-clear') }
  const discGwFail = (await s.fake.call('/platforms/qq-migration/discard-uncertain', { txnId: 's6-rb-corrupt-snap' })).json()
  assert.equal(discGwFail.ok, false)
  assert.equal(s.host.qqOwnership.status().paused, true)
  assert.equal(readRecoveryGuard(s.dataDir).phase, 'migration-ambiguous')
  assert.equal(s.host.qqOwnership.bufferStatus('s6-rb-corrupt-snap').entries.length, 1, '验号前失败不得先删原始缓冲')
  assert.equal(readRecoveryGuard(s.dataDir).lastFailedResolution?.action, 'discard-uncertain')
  assert.equal(readRecoveryGuard(s.dataDir).lastResolution?.operator, 'sec-admin', '失败不得覆盖上一次成功恢复审计')

  s.host.gateway.acquireLease = origAcquire
  s.host.gateway.acquireLease = (instance, options) => {
    for (const [index, status] of ['accepted', 'filtered', 'uncertain'].entries()) {
      const entry = options.buffer.append({ kind: 'inbound', instance, payload: { messageId: String(8250 + index) } })
      options.buffer.markStatus(entry.seq, status)
    }
    return origAcquire(instance, options)
  }
  const discOk = (await s.fake.call('/platforms/qq-migration/discard-uncertain', {
    txnId: 's6-rb-corrupt-snap',
    operator: 'oncall-op',
    reason: '已核对历史无需重放，允许网关接管',
  })).json()
  s.host.gateway.acquireLease = origAcquire
  assert.equal(discOk.ok, true)
  assert.equal(discOk.view.paused, false)
  assert.equal(discOk.view.ownerMode, 'gateway')
  assert.equal(discOk.view.lastResolution?.action, 'discard-uncertain')
  assert.equal(discOk.view.lastResolution?.operator, 'oncall-op')
  assert.equal(discOk.view.lastResolution?.discardedMain, 0, '已经处理的主缓冲消息不计入丢弃')
  assert.equal(discOk.view.lastResolution?.discardedCount, 1)
  assert.equal(discOk.view.lastResolution?.verifyAccepted, 1)
  assert.equal(discOk.view.lastResolution?.verifyFiltered, 1)
  assert.equal(discOk.view.lastResolution?.verifyDiscarded, 1)
  assert.equal(discOk.view.lastResolution?.discardedVerify, 1)
  assert.equal(discOk.view.lastResolution?.reason, '已核对历史无需重放，允许网关接管')
  assert.equal(discOk.view.lastFailedResolution, null)
  const guardAfterClear = readRecoveryGuard(s.dataDir)
  assert.equal(guardAfterClear.phase, 'idle')
  assert.equal(guardAfterClear.lastResolution?.operator, 'oncall-op')

  // 5) P2-1：discard 时目标网关配置缺失或停用（clearActiveTransfer 后 targetCfg 校验失败）同样保 paused + migration-ambiguous guard
  const dataDirNoCfg = mkdtempSync(join(tmpdir(), 'aurabot-mig-s6-nocfg-'))
  const oldDirN = process.env.AURABOT_DATA_DIR
  const oldWsN = process.env.AURABOT_WORKSPACE
  process.env.AURABOT_DATA_DIR = dataDirNoCfg
  process.env.AURABOT_WORKSPACE = join(dataDirNoCfg, 'ws')
  writeFileSync(join(dataDirNoCfg, 'config.json'), JSON.stringify({
    enabled: true,
    setupDone: true,
    legacyQqEnabled: false,
    botQQ: '20000032',
    ownerQQ: '10000031',
    platforms: { qq: { enabled: false, backend: 'onebot' } },
  }))
  createMigrationTxn(dataDirNoCfg, {
    txnId: 's6-missing-target-cfg',
    expectedRevision: 1,
    fromLegacyQqEnabled: true,
    targetLegacyQqEnabled: false,
    targetPlatform: { enabled: true, backend: 'onebot', selfId: '20000032' },
    rawPreConfig: { enabled: true, legacyQqEnabled: true },
    targetConfig: { legacyQqEnabled: false },
  })
  updateMigrationTxn(dataDirNoCfg, 's6-missing-target-cfg', { phase: 'committed', committed: true })
  const fakeN = createFakeDsh({ brain: async () => 'ok' })
  const hostN = apply(fakeN.ctx, { migrationTimeoutMs: 3000 })
  await hostN.ready
  assert.equal(hostN.qqOwnership.status().paused, true)
  const missingCfgRes = (await fakeN.call('/platforms/qq-migration/discard-uncertain', {
    txnId: 's6-missing-target-cfg',
  })).json()
  assert.equal(missingCfgRes.ok, false)
  assert.match(missingCfgRes.message, /配置缺失|不一致/)
  assert.equal(hostN.qqOwnership.status().paused, true)
  assert.equal(readRecoveryGuard(dataDirNoCfg).phase, 'migration-ambiguous')
  fakeN.dispose()
  try { await hostN.gateway?.stopAll?.() } catch {}
  if (oldDirN === undefined) delete process.env.AURABOT_DATA_DIR
  else process.env.AURABOT_DATA_DIR = oldDirN
  if (oldWsN === undefined) delete process.env.AURABOT_WORKSPACE
  else process.env.AURABOT_WORKSPACE = oldWsN
  rmSync(dataDirNoCfg, { recursive: true, force: true })
})

test('阶段七 P1-1 & P2-1 ~ P2-5：启动与运行态 guardInvalid 真暂停（看门狗不拉起）、验号成功后再删缓冲与最近恢复动作展示', async (t) => {
  // 1) 启动前写入 phase=recovering + 非法 txnId（无 active txn）-> 看门狗与所有入口真实暂停，等待 3.2s 不连接，rollback 后恢复
  const dataDir = mkdtempSync(join(tmpdir(), 'aurabot-mig-s7-'))
  const oldDir = process.env.AURABOT_DATA_DIR
  const oldWs = process.env.AURABOT_WORKSPACE
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  const botQQ = '20000042'
  const ownerQQ = '10000041'
  const legacy = await startMockOneBot({ selfId: botQQ, token: 'tok-s7-leg' })
  const managed = await startMockOneBot({ selfId: botQQ, token: 'tok-s7-man' })
  const fake = createFakeDsh({ brain: async () => 'ok' })
  fake.ctx.sessions = { async flush() { return true } }
  fake.ctx.services.sessionPersistence = { async open(id) { return { id, async read() { return { events: [] } }, async close() {} } } }
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    setupDone: true,
    dryRun: false,
    merge: { enabled: false },
    voice: { enabled: false },
    stickers: { enabled: false },
    gateway: 'onebot',
    botQQ,
    ownerQQ,
    snowluma: {
      httpUrl: legacy.httpUrl,
      wsUrl: legacy.wsUrl,
      httpToken: legacy.token,
      wsToken: legacy.token,
    },
  }))
  writeFileSync(join(dataDir, 'qq-recovery-guard.json'), JSON.stringify({
    version: 1,
    phase: 'recovering',
    txnId: '../../invalid-startup-id',
    dataEpoch: 0,
    reason: '损坏事务 ID 阻断启动',
    updatedAt: Date.now(),
  }))

  const { apply } = await import('../src/host.js')
  const host = apply(fake.ctx, { migrationTimeoutMs: 5000 })
  t.after(async () => {
    fake.dispose()
    try { await host.gateway?.stopAll?.() } catch {}
    await Promise.race([Promise.all([managed.close(), legacy.close()]), delay(400)])
    if (oldDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = oldDir
    if (oldWs === undefined) delete process.env.AURABOT_WORKSPACE
    else process.env.AURABOT_WORKSPACE = oldWs
    rmSync(dataDir, { recursive: true, force: true })
  })
  await host.ready

  assert.equal(host.qqOwnership.status().paused, true)
  assert.equal(host.onebot, null)
  const viewBoot = (await fake.call('/platforms/qq-migration')).json()
  const platsBoot = (await fake.call('/platforms')).json()
  assert.equal(viewBoot.paused, true)
  assert.equal(viewBoot.guardInvalid, true)
  assert.equal(platsBoot.qqMigration.paused, true)

  // 看门狗周期 3 秒后再检查：绝不允许拉起旧版直连
  await delay(3200)
  assert.equal(legacy.connected(), 0, 'guardInvalid 启动态看门狗绝不可拉起旧版直连 QQ')
  assert.equal(host.onebot, null)
  assert.equal((await fake.call('/onebot/reconnect')).json().ok, false)

  // 通过 rollback 清理非法 guard 后恢复旧版直连
  const rb = (await fake.call('/platforms/qq-migration/rollback', {
    operator: 's7-admin',
    reason: '清理非法启动 guard',
  })).json()
  assert.equal(rb.ok, true)
  assert.equal(host.qqOwnership.status().paused, false)
  assert.equal(rb.view.paused, false)
  assert.equal(rb.view.lastResolution?.action, 'rollback')
  assert.equal((await fake.call('/onebot/reconnect')).json().ok, true)
  await waitFor(() => legacy.connected() === 1, '清理非法 guard 后应恢复旧版直连 QQ')

  // 2) P2-3 + P2-4：gateway 正在运行时触发恢复，discard-uncertain 先暂停旧运行态并先验号，验号失败时原始缓冲保留可读，验号成功才清理
  const platform = { enabled: true, backend: 'onebot', selfId: botQQ, httpUrl: managed.httpUrl, wsUrl: managed.wsUrl, token: managed.token }
  const started = (await fake.call('/platforms/qq-migration/start', {
    targetLegacyQqEnabled: false,
    platform,
  })).json()
  assert.equal(started.ok, true)
  await waitFor(() => managed.connected() === 1, '网关 QQ 未连接')

  // 构造一个已提交但在 finish.resume() 前保留了 1 条缓冲消息且 gateway 实例已在运行的场景
  const rollbackBack = (await fake.call('/platforms/qq-migration/rollback', {
    operator: 's7-admin',
    reason: '切换回 legacy 以构造 committed 故障',
  })).json()
  assert.equal(rollbackBack.ok, true)
  assert.equal((await fake.call('/onebot/reconnect')).json().ok, true)

  const tx = host.qqOwnership.begin({
    txnId: 's7-preserve-buf',
    expectedRevision: host.qqOwnership.status().revision,
    legacyQqEnabled: false,
    platform,
  })
  await tx.prepare()
  managed.push({
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    self_id: Number(botQQ),
    user_id: Number(ownerQQ),
    message_id: 9501,
    sender: { user_id: Number(ownerQQ), nickname: '主人' },
    message: [{ type: 'text', data: { text: '验号失败前绝不可删除的正文' } }],
  })
  await waitFor(() => host.qqOwnership.bufferStatus('s7-preserve-buf').entries.length === 1, '未入缓冲')
  tx.commit({ txnId: 's7-preserve-buf', expectedRevision: host.qqOwnership.status().revision })
  const origSync = host.gateway.sync
  host.gateway.sync = async () => { throw new Error('s7-sync-boom') }
  await assert.rejects(tx.finish(), /s7-sync-boom/)
  host.gateway.sync = origSync

  let failVerifyOnce = true
  const origAcquire = host.gateway.acquireLease.bind(host.gateway)
  host.gateway.acquireLease = async (inst, leaseOpts) => {
    const l = await origAcquire(inst, leaseOpts)
    return {
      ...l,
      async whenReady(wOpts) {
        if (failVerifyOnce) {
          failVerifyOnce = false
          throw new Error('s7-verify-failed')
        }
        return await l.whenReady(wOpts)
      },
    }
  }

  const firstDisc = (await fake.call('/platforms/qq-migration/discard-uncertain', {
    txnId: 's7-preserve-buf',
    operator: 's7-admin',
    reason: '首次尝试丢弃确认',
  })).json()
  assert.equal(firstDisc.ok, false)
  assert.equal(firstDisc.view.paused, true)
  assert.equal(firstDisc.view.buffer.entries.length, 1, 'P2-4：验号失败时原始缓冲绝不可提前删除')
  assert.equal(firstDisc.view.buffer.entries[0].text, '验号失败前绝不可删除的正文')
  assert.equal(firstDisc.view.lastFailedResolution?.action, 'discard-uncertain')
  assert.equal(firstDisc.view.lastResolution?.action, 'rollback', 'P2-1：失败恢复不得丢失上一次成功审计')

  const secondDisc = (await fake.call('/platforms/qq-migration/discard-uncertain', {
    txnId: 's7-preserve-buf',
    operator: 's7-admin',
    reason: '二次验号通过后正式丢弃',
  })).json()
  assert.equal(secondDisc.ok, true)
  assert.equal(secondDisc.view.paused, false)
  assert.equal(secondDisc.view.lastResolution?.action, 'discard-uncertain')
  assert.equal(secondDisc.view.lastResolution?.discardedCount, 1)
  assert.equal(secondDisc.view.lastFailedResolution, null)

  // 3) P2-2：面板源码已展示最近恢复动作
  const clientSrc = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.ok(clientSrc.includes('最近恢复动作：'), 'client/client.js 缺少最近恢复动作展示')
})

test('阶段八 P1-1 & P2-1 ~ P2-5：未知 guard phase 启动与运行中即时 fail-closed 暂停、verify 缓冲审计与 pauseInstance 幂等', async (t) => {
  // 1) P1-1 + P2-5：guard phase='restoring'（未知 phase）+ 合法 txnId -> 启动后看门狗 3.2s 内绝不拉起 QQ，status/UI 一致，rollback 清理恢复
  const dataDir = mkdtempSync(join(tmpdir(), 'aurabot-mig-s8-'))
  const oldDir = process.env.AURABOT_DATA_DIR
  const oldWs = process.env.AURABOT_WORKSPACE
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  const botQQ = '20000052'
  const ownerQQ = '10000051'
  const legacy = await startMockOneBot({ selfId: botQQ, token: 'tok-s8-leg' })
  const managed = await startMockOneBot({ selfId: botQQ, token: 'tok-s8-man' })
  const fake = createFakeDsh({ brain: async () => 'ok' })
  fake.ctx.sessions = { async flush() { return true } }
  fake.ctx.services.sessionPersistence = { async open(id) { return { id, async read() { return { events: [] } }, async close() {} } } }
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    setupDone: true,
    dryRun: false,
    merge: { enabled: false },
    voice: { enabled: false },
    stickers: { enabled: false },
    gateway: 'onebot',
    botQQ,
    ownerQQ,
    snowluma: {
      httpUrl: legacy.httpUrl,
      wsUrl: legacy.wsUrl,
      httpToken: legacy.token,
      wsToken: legacy.token,
    },
  }))
  writeFileSync(join(dataDir, 'qq-recovery-guard.json'), JSON.stringify({
    version: 1,
    phase: 'restoring',
    txnId: 'valid-txn-id',
    dataEpoch: 0,
    reason: '未知恢复阶段测试',
    updatedAt: Date.now(),
  }))

  const { apply } = await import('../src/host.js')
  const host = apply(fake.ctx, { migrationTimeoutMs: 5000 })
  t.after(async () => {
    fake.dispose()
    try { await host.gateway?.stopAll?.() } catch {}
    await Promise.race([Promise.all([managed.close(), legacy.close()]), delay(400)])
    if (oldDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = oldDir
    if (oldWs === undefined) delete process.env.AURABOT_WORKSPACE
    else process.env.AURABOT_WORKSPACE = oldWs
    rmSync(dataDir, { recursive: true, force: true })
  })
  await host.ready

  assert.equal(host.qqOwnership.status().paused, true)
  assert.equal(host.onebot, null)
  const vBoot = (await fake.call('/platforms/qq-migration')).json()
  const pBoot = (await fake.call('/platforms')).json()
  assert.equal(vBoot.paused, true)
  assert.equal(vBoot.guardInvalid, true)
  assert.deepEqual(vBoot.recommendedActions, ['rollback'])
  assert.ok(vBoot.buffer.corruptFiles.includes('guard-phase-invalid'))
  assert.equal(pBoot.qqMigration.paused, true)
  assert.equal(pBoot.qqMigration.guardInvalid, true)

  await delay(3200)
  assert.equal(legacy.connected(), 0, '未知 guard phase 下看门狗绝不可拉起旧版直连 QQ')
  assert.equal(host.onebot, null)

  const rbClean = (await fake.call('/platforms/qq-migration/rollback', {
    operator: 's8-admin',
    reason: '清理未知阶段 guard',
  })).json()
  assert.equal(rbClean.ok, true)
  assert.equal(rbClean.view.paused, false)
  assert.equal(rbClean.view.guardInvalid, false)
  assert.equal((await fake.call('/onebot/reconnect')).json().ok, true)
  await waitFor(() => legacy.connected() === 1, 'rollback 清理未知 phase 后应恢复旧版直连 QQ')

  // 2) P2-1：运行中外部篡改 guard 为未知 phase -> hub 立即阻断默认 QQ 出站，且 /platforms 同步停掉网关 qq 实例
  const platform = { enabled: true, backend: 'onebot', selfId: botQQ, httpUrl: managed.httpUrl, wsUrl: managed.wsUrl, token: managed.token }
  const started = (await fake.call('/platforms/qq-migration/start', {
    targetLegacyQqEnabled: false,
    platform,
  })).json()
  assert.equal(started.ok, true)
  await waitFor(() => managed.connected() === 1, '网关 QQ 未连接')

  writeFileSync(join(dataDir, 'qq-recovery-guard.json'), JSON.stringify({
    version: 1,
    phase: 'restoring',
    txnId: 'midrun-unknown',
    dataEpoch: 0,
    reason: '运行中篡改 guard',
    updatedAt: Date.now(),
  }))
  const blockedSend = await host.hub.sendText(`private:${ownerQQ}`, '未知 guard 期间绝不可发给外部网关')
  assert.equal(blockedSend, null, 'P2-1：运行中 guard 异常必须立即暂停 hub 出站')
  assert.equal(managed.sent('send_private_msg').length, 0)
  assert.equal(host.qqOwnership.status().paused, true)
  const midrunPlats = (await fake.call('/platforms')).json()
  assert.equal(midrunPlats.qqMigration.paused, true)
  assert.equal(midrunPlats.qqMigration.guardInvalid, true)
  assert.equal(midrunPlats.instances.find((x) => x.instance === 'qq')?.state, 'stopped')
  assert.deepEqual(midrunPlats.qqMigration.recommendedActions, ['rollback'])
  const invalidDiscard = (await fake.call('/platforms/qq-migration/discard-uncertain', {})).json()
  assert.equal(invalidDiscard.ok, false)
  assert.equal(invalidDiscard.code, 'RECOVERY_GUARD_INVALID')
  assert.equal(readRecoveryGuard(dataDir).phase, 'restoring')
  writeRecoveryGuard(dataDir, { phase: 'migration-ambiguous' })

  // 3) P2-4 + P2-2：pauseInstance 返回 false 时拒绝交还（INSTANCE_STOP_PENDING）并保持暂停；恢复 pauseInstance 后通过验号并记录 discardedMain/discardedVerify
  const origPauseInst = host.gateway.pauseInstance.bind(host.gateway)
  host.gateway.pauseInstance = async () => false
  const stopPendingRes = (await fake.call('/platforms/qq-migration/discard-uncertain', {
    operator: 's8-admin',
    reason: '旧实例停机尚未确认',
  })).json()
  assert.equal(stopPendingRes.ok, false)
  assert.equal(stopPendingRes.code, 'INSTANCE_STOP_PENDING')
  assert.equal(stopPendingRes.view.paused, true)

  host.gateway.pauseInstance = origPauseInst
  const discDone = (await fake.call('/platforms/qq-migration/discard-uncertain', {
    operator: 's8-admin',
    reason: '确认未知 guard 并恢复网关运行',
  })).json()
  assert.equal(discDone.ok, true)
  assert.equal(discDone.view.paused, false)
  assert.equal(discDone.view.ownerMode, 'gateway')
  assert.equal(discDone.view.lastResolution?.discardedMain, 0)
  assert.equal(discDone.view.lastResolution?.discardedVerify, 0)
  await waitFor(() => managed.connected() === 1, '恢复后网关应重新处于 connected')
})

test('阶段九 P2-1 ~ P2-6：rollback 的 pauseInstance 幂等保护、dataEpoch 与 backupJournal 损坏 fail-closed 及恢复门损坏文案', async (t) => {
  const backup = await import('../src/core/backup.js')
  const { apply } = await import('../src/host.js')

  // 1) P2-1 & P2-2：rollback 时若 pauseInstance=false -> 返回 INSTANCE_STOP_PENDING，不清理事务/guard 且不回改配置，恢复后再次 rollback 成功
  const dataDir = mkdtempSync(join(tmpdir(), 'aurabot-mig-s9-rb-'))
  const oldDir = process.env.AURABOT_DATA_DIR
  const oldWs = process.env.AURABOT_WORKSPACE
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  const botQQ = '20000062'
  const ownerQQ = '10000061'
  const legacy = await startMockOneBot({ selfId: botQQ, token: 'tok-s9-leg' })
  const managed = await startMockOneBot({ selfId: botQQ, token: 'tok-s9-man' })
  const fake = createFakeDsh({ brain: async () => 'ok' })
  fake.ctx.sessions = { async flush() { return true } }
  fake.ctx.services.sessionPersistence = { async open(id) { return { id, async read() { return { events: [] } }, async close() {} } } }
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    setupDone: true,
    dryRun: false,
    merge: { enabled: false },
    voice: { enabled: false },
    stickers: { enabled: false },
    gateway: 'onebot',
    botQQ,
    ownerQQ,
    snowluma: {
      httpUrl: legacy.httpUrl,
      wsUrl: legacy.wsUrl,
      httpToken: legacy.token,
      wsToken: legacy.token,
    },
  }))
  const host = apply(fake.ctx, { migrationTimeoutMs: 5000 })
  t.after(async () => {
    fake.dispose()
    try { await host.gateway?.stopAll?.() } catch {}
    await Promise.race([Promise.all([managed.close(), legacy.close()]), delay(400)])
    if (oldDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = oldDir
    if (oldWs === undefined) delete process.env.AURABOT_WORKSPACE
    else process.env.AURABOT_WORKSPACE = oldWs
    rmSync(dataDir, { recursive: true, force: true })
  })
  await host.ready
  assert.equal((await fake.call('/onebot/reconnect')).json().ok, true)
  await waitFor(() => legacy.connected() === 1, 's9 旧版 QQ 未连接')

  const rawPre = readRawConfig()
  const platform = { enabled: true, backend: 'onebot', selfId: botQQ, httpUrl: managed.httpUrl, wsUrl: managed.wsUrl, token: managed.token }
  const started = (await fake.call('/platforms/qq-migration/start', {
    targetLegacyQqEnabled: false,
    platform,
  })).json()
  assert.equal(started.ok, true, `start 失败：${JSON.stringify(started)}`)
  await waitFor(() => managed.connected() === 1, 's9 网关 QQ 未连接')

  // 构造带快照的未决迁移事务 + recovery guard，触发走 resolveRecovery({ action: 'rollback' })
  const curRaw = readRawConfig()
  createMigrationTxn(dataDir, {
    txnId: 's9-rb-txn',
    expectedRevision: host.qqOwnership.status().revision,
    fromLegacyQqEnabled: true,
    targetLegacyQqEnabled: false,
    targetPlatform: platform,
    rawPreConfig: rawPre,
    targetConfig: curRaw,
  })
  updateMigrationTxn(dataDir, 's9-rb-txn', { phase: 'committed', committed: true })
  writeFileSync(join(dataDir, 'qq-recovery-guard.json'), JSON.stringify({
    version: 1,
    phase: 'migration-ambiguous',
    txnId: 's9-rb-txn',
    dataEpoch: 0,
    reason: 's9 rollback stop-pending 测试',
    updatedAt: Date.now(),
  }))

  const origPause = host.gateway.pauseInstance.bind(host.gateway)
  host.gateway.pauseInstance = async () => false
  const rbPending = (await fake.call('/platforms/qq-migration/rollback', {
    txnId: 's9-rb-txn',
    operator: 's9-admin',
    reason: '停机未就绪时尝试回滚',
  })).json()
  assert.equal(rbPending.ok, false)
  assert.equal(rbPending.code, 'INSTANCE_STOP_PENDING')
  assert.equal(rbPending.view.paused, true)
  assert.equal(rbPending.view.legacyQqEnabled, false, 'pauseInstance=false 时绝不可提前回改配置为旧版直连')
  assert.ok(readMigrationTxn(dataDir, 's9-rb-txn'), 'pauseInstance=false 时绝不可清理迁移事务')
  assert.notEqual(readRecoveryGuard(dataDir).phase, 'idle', 'pauseInstance=false 时绝不可清除恢复门')

  // P2-5：损坏的 qq-recovery-guard.json / 未知 phase 在视图返回友好中文文案
  writeFileSync(join(dataDir, 'qq-recovery-guard.json'), JSON.stringify({
    version: 1,
    phase: 'unknown-stage-x',
    txnId: 's9-rb-txn',
    dataEpoch: 0,
    updatedAt: Date.now(),
  }))
  const vUnknown = (await fake.call('/platforms/qq-migration')).json()
  assert.ok(vUnknown.phaseLabel.includes('恢复门状态损坏'), `未知 phase 应展示损坏提示，实际=${vUnknown.phaseLabel}`)
  assert.ok(vUnknown.guardPhaseLabel.includes('恢复门状态损坏'))

  writeFileSync(join(dataDir, 'qq-recovery-guard.json'), '{corrupt-guard-json')
  const vCorruptGuard = host.qqOwnership.view()
  assert.ok(vCorruptGuard.phaseLabel.includes('恢复门状态损坏'))
  assert.ok(vCorruptGuard.guardPhaseLabel.includes('恢复门状态损坏'))

  // 恢复 pauseInstance 后重新回滚应成功清理恢复门与事务并切回旧版直连 QQ
  host.gateway.pauseInstance = origPause
  const rbSuccess = (await fake.call('/platforms/qq-migration/rollback', {
    txnId: 's9-rb-txn',
    operator: 's9-admin',
    reason: '停机恢复后再次回滚',
  })).json()
  assert.equal(rbSuccess.ok, true)
  assert.equal(rbSuccess.view.paused, false)
  assert.equal(rbSuccess.view.legacyQqEnabled, true)
  assert.equal(rbSuccess.view.ownerMode, 'legacy')
  assert.equal(readMigrationTxn(dataDir, 's9-rb-txn'), null)
  assert.equal(readRecoveryGuard(dataDir).phase, 'idle')
  assert.equal((await fake.call('/onebot/reconnect')).json().ok, true)
  await waitFor(() => legacy.connected() === 1, 's9 再次 rollback 成功后应恢复旧版直连 QQ')

  // 2) P2-3：qq-data-epoch.json 损坏 -> readDataEpoch().corrupt===true，启动时不误删活跃事务且进入暂停保护
  const dataDirEpoch = mkdtempSync(join(tmpdir(), 'aurabot-mig-s9-epoch-'))
  process.env.AURABOT_DATA_DIR = dataDirEpoch
  process.env.AURABOT_WORKSPACE = join(dataDirEpoch, 'ws')
  const legacyE = await startMockOneBot({ selfId: '20000072', token: 'tok-e' })
  const fakeE = createFakeDsh({ brain: async () => 'ok' })
  fakeE.ctx.sessions = { async flush() { return true } }
  fakeE.ctx.services.sessionPersistence = { async open(id) { return { id, async read() { return { events: [] } }, async close() {} } } }
  writeFileSync(join(dataDirEpoch, 'config.json'), JSON.stringify({
    enabled: true,
    setupDone: true,
    dryRun: false,
    merge: { enabled: false },
    voice: { enabled: false },
    stickers: { enabled: false },
    gateway: 'onebot',
    botQQ: '20000072',
    ownerQQ: '10000071',
    snowluma: { httpUrl: legacyE.httpUrl, wsUrl: legacyE.wsUrl, httpToken: legacyE.token, wsToken: legacyE.token },
  }))
  createMigrationTxn(dataDirEpoch, {
    txnId: 's9-epoch-txn',
    expectedRevision: 0,
    fromLegacyQqEnabled: true,
    targetLegacyQqEnabled: false,
    targetPlatform: { enabled: true, backend: 'onebot', selfId: '20000072', wsUrl: 'ws://127.0.0.1:9' },
    rawPreConfig: readRawConfig(),
    targetConfig: { legacyQqEnabled: false },
  })
  updateMigrationTxn(dataDirEpoch, 's9-epoch-txn', { phase: 'committed', committed: true })
  writeFileSync(join(dataDirEpoch, 'qq-data-epoch.json'), '{broken-epoch-json')
  assert.equal(readDataEpoch(dataDirEpoch).corrupt, true)

  const hostE = apply(fakeE.ctx, { migrationTimeoutMs: 3000 })
  t.after(async () => {
    fakeE.dispose()
    try { await hostE.gateway?.stopAll?.() } catch {}
    await Promise.race([legacyE.close(), delay(300)])
    rmSync(dataDirEpoch, { recursive: true, force: true })
  })
  await hostE.ready
  assert.equal(hostE.qqOwnership.status().paused, true)
  assert.equal(hostE.onebot, null)
  assert.equal(legacyE.connected(), 0)
  assert.ok(readMigrationTxn(dataDirEpoch, 's9-epoch-txn'), 'dataEpoch 损坏时绝不可按 stale-epoch 误清理活跃事务')
  const viewE = (await fakeE.call('/platforms/qq-migration')).json()
  assert.equal(viewE.phase, 'migration-ambiguous')
  assert.equal(viewE.guardInvalid, true)
  assert.ok(viewE.buffer.corruptFiles.includes('data-epoch-corrupt'))
  assert.ok(viewE.phaseLabel.includes('恢复门状态损坏'))
  assert.deepEqual(viewE.recommendedActions, ['rollback'])
  for (const action of ['discard-uncertain', 'acknowledge', 'retry']) {
    const denied = (await fakeE.call('/platforms/qq-migration/buffer/action', { action, txnId: 's9-epoch-txn' })).json()
    assert.equal(denied.ok, false)
    assert.equal(denied.code, 'DATA_EPOCH_CORRUPT')
    assert.equal(denied.view.paused, true)
  }
  assert.ok(readMigrationTxn(dataDirEpoch, 's9-epoch-txn'))
  assert.equal(readDataEpoch(dataDirEpoch).corrupt, true)

  const rbE = (await fakeE.call('/platforms/qq-migration/rollback', {
    operator: 's9-admin',
    reason: '修复损坏 dataEpoch 并回滚',
  })).json()
  assert.equal(rbE.ok, true)
  assert.equal(readDataEpoch(dataDirEpoch).corrupt, false)
  assert.equal(rbE.view.paused, false)

  // 3) P2-4：backup-restore-journal.json 损坏 -> backup-journal-corrupt，拒绝 applyPendingRestore 并启动暂停默认 QQ
  const dataDirBk = mkdtempSync(join(tmpdir(), 'aurabot-mig-s9-bk-'))
  process.env.AURABOT_DATA_DIR = dataDirBk
  process.env.AURABOT_WORKSPACE = join(dataDirBk, 'ws')
  const legacyB = await startMockOneBot({ selfId: '20000082', token: 'tok-b' })
  const fakeB = createFakeDsh({ brain: async () => 'ok' })
  fakeB.ctx.sessions = { async flush() { return true } }
  fakeB.ctx.services.sessionPersistence = { async open(id) { return { id, async read() { return { events: [] } }, async close() {} } } }
  writeFileSync(join(dataDirBk, 'config.json'), JSON.stringify({
    enabled: true,
    setupDone: true,
    dryRun: false,
    merge: { enabled: false },
    voice: { enabled: false },
    stickers: { enabled: false },
    gateway: 'onebot',
    botQQ: '20000082',
    ownerQQ: '10000081',
    snowluma: { httpUrl: legacyB.httpUrl, wsUrl: legacyB.wsUrl, httpToken: legacyB.token, wsToken: legacyB.token },
  }))
  writeFileSync(join(dataDirBk, 'backup-restore-journal.json'), '{corrupt-backup-journal')
  assert.equal(backup.readBackupRestoreJournal(dataDirBk).corrupt, true)
  assert.equal(backup.inspectBackupRestoreState(dataDirBk).state, 'backup-journal-corrupt')
  assert.throws(() => backup.applyPendingRestore(Date.now(), { root: dataDirBk }), (e) => e.code === 'BACKUP_JOURNAL_CORRUPT')

  const hostB = apply(fakeB.ctx, { migrationTimeoutMs: 3000 })
  t.after(async () => {
    fakeB.dispose()
    try { await hostB.gateway?.stopAll?.() } catch {}
    await Promise.race([legacyB.close(), delay(300)])
    rmSync(dataDirBk, { recursive: true, force: true })
  })
  await hostB.ready
  assert.equal(hostB.qqOwnership.status().paused, true)
  assert.equal(hostB.onebot, null)
  assert.equal(legacyB.connected(), 0)
  const viewB = (await fakeB.call('/platforms/qq-migration')).json()
  assert.equal(viewB.phase, 'migration-ambiguous')
  assert.equal(viewB.guardInvalid, true)
  assert.ok(viewB.buffer.corruptFiles.includes('backup-journal-corrupt'))
  assert.ok(viewB.phaseLabel.includes('恢复门状态损坏'))
  assert.deepEqual(viewB.recommendedActions, [])
  assert.deepEqual(viewB.backupRecovery, { journalPath: join(dataDirBk, 'backup-restore-journal.json'), canQuarantine: true })
  const recovery = (await fakeB.call('/backup/recovery')).json()
  assert.equal(recovery.ok, true)
  assert.deepEqual(recovery.backupState, { state: 'backup-journal-corrupt', corrupt: true, canQuarantine: true })
  const rbB = (await fakeB.call('/platforms/qq-migration/rollback', {})).json()
  assert.equal(rbB.code, 'BACKUP_JOURNAL_CORRUPT')
  const header = { 'x-aurabot-backup': '1' }
  const quarantineRoute = '/backup/recovery/quarantine'
  assert.equal((await fakeB.call(quarantineRoute, { confirmed: true })).json().ok, false)
  assert.equal((await fakeB.call(quarantineRoute, {}, header)).json().code, 'CONFIRMATION_REQUIRED')
  const stagedPath = join(dataDirBk, '.restore-pending.json')
  writeFileSync(stagedPath, '{}')
  assert.equal((await fakeB.call('/platforms/qq-migration')).json().backupRecovery.canQuarantine, false)
  assert.equal((await fakeB.call(quarantineRoute, { confirmed: true }, header)).json().code, 'BACKUP_RESTORE_FILES_PRESENT')
  assert.equal((await fakeB.call('/backup/cancel', {}, header)).json().ok, false)
  rmSync(stagedPath)
  const quarantined = (await fakeB.call(quarantineRoute, { confirmed: true }, header)).json()
  assert.equal(quarantined.ok, true, quarantined.message)
  assert.equal(backup.readBackupRestoreJournal(dataDirBk), null)
  assert.equal(readFileSync(join(dataDirBk, 'backups', quarantined.savedName), 'utf8'), '{corrupt-backup-journal')
  assert.equal(hostB.qqOwnership.status().paused, true)
  assert.equal((await fakeB.call('/platforms/qq-migration')).json().backupRecovery, null)
  assert.equal((await fakeB.call('/platforms/qq-migration/rollback', {})).json().ok, true)

  const clientSrc = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.ok(clientSrc.includes('qqMigration.phaseLabel || qqMigration.phase'))
  assert.ok(clientSrc.includes('恢复门状态损坏'))
  assert.ok(clientSrc.includes('/backup/recovery/quarantine'))
  assert.ok(clientSrc.includes("onClick: () => go('backup') }, '打开备份恢复页'"))
})

test('迁移目标默认从旧版直连 endpoint 带入地址与 token', async (t) => {
  const s = await setupMigrationHostHarness(t, { snowlumaAutoEndpoint: true })
  const view = s.host.qqOwnership.view()
  assert.equal(view.targetPlatform.source, 'legacy-direct')
  assert.equal(view.targetPlatform.wsUrl, s.legacy.wsUrl)
  assert.equal(view.targetPlatform.httpUrl, s.legacy.httpUrl)
  assert.equal(view.targetPlatform.wsTokenSet, true)
  assert.equal(view.targetPlatform.httpTokenSet, true)
  assert.equal(view.targetPlatform.inheritLegacyCredentials, true)

  const pre = (await s.fake.call('/platforms/qq-migration/preflight', {
    platform: { backend: 'onebot' },
  })).json()
  assert.equal(pre.ok, true, pre.message)
  const started = (await s.fake.call('/platforms/qq-migration/start', {
    targetLegacyQqEnabled: false,
    platform: { backend: 'onebot' },
  })).json()
  assert.equal(started.ok, true, started.message)
  assert.equal(s.host.getConfig().platforms.qq.wsUrl, s.legacy.wsUrl)
  assert.equal(s.host.getConfig().platforms.qq.httpUrl, s.legacy.httpUrl)
  assert.equal(s.host.getConfig().platforms.qq.wsToken, s.legacy.token)
  assert.equal(s.host.getConfig().platforms.qq.httpToken, s.legacy.token)
})
