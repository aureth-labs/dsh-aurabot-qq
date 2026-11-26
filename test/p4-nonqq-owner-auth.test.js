// P4 验收回归：ownerPersonId 同步、ownerAuthorization 三分支（平滑升级保留 / 换主轮换 / 备份恢复作废）、纯非 QQ 认主向导与敏感命令授权全链路、前端纯非 QQ 状态展示。
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Script } from 'node:vm'

const tempDirs = []
const prevDataDir = process.env.AURABOT_DATA_DIR
function freshDataDir(prefix = 'aurabot-p4-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  process.env.AURABOT_DATA_DIR = dir
  return dir
}

after(() => {
  if (prevDataDir === undefined) delete process.env.AURABOT_DATA_DIR
  else process.env.AURABOT_DATA_DIR = prevDataDir
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

const deferred = () => {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

const noopLog = { debug() {}, info() {}, warn() {}, error() {} }

let configMod
let backupMod
let hostMod
let hubMod
let identityMod
let gatewayMod
let memoryMod
let memoryStoreMod
let fakeDshMod
let fakeAdapterMod

before(async () => {
  freshDataDir('aurabot-p4-boot-')
  configMod = await import('../src/core/config.js')
  backupMod = await import('../src/core/backup.js')
  hostMod = await import('../src/host.js')
  hubMod = await import('../src/chat/hub.js')
  identityMod = await import('../src/gateway/identity.js')
  gatewayMod = await import('../src/gateway/index.js')
  memoryMod = await import('../src/features/memory.js')
  memoryStoreMod = await import('../src/features/memory-store.js')
  fakeDshMod = await import('./helpers/fake-dsh.js')
  fakeAdapterMod = await import('./helpers/fake-adapter.js')
})

beforeEach(() => {
  freshDataDir('aurabot-p4-case-')
})

test('共享核验点状态先预检，恢复校验模式和当前候选', async (t) => {
  const fake = fakeDshMod.createFakeDsh({ brain: async () => '' })
  const { hub } = hostMod.apply(fake.ctx)
  t.after(() => fake.dispose())
  const statusPath = '/platforms/multi-private'
  const path = statusPath + '/recover'
  const modes = []
  let recoverable = false
  let state = 'paused'
  hub.sharedStatus = (mode = 'debug') => ({
    mode, state, recoverable,
    recoverReason: recoverable ? '' : 'no-checkpoint',
    recoverKey: recoverable ? 'current-candidate' : '',
  })
  let preflightCalls = 0
  hub.preflightSharedRecovery = async () => {
    preflightCalls++
    return { ...hub.sharedStatus(), recoverable: false, recoverReason: 'checkpoint-invalid' }
  }
  hub.recoverSharedFromCheckpoint = async (mode) => {
    modes.push(mode)
    state = 'active'
    recoverable = false
    return { ok: true, sessionId: 'recovered-session', checkpoint: 12 }
  }

  assert.equal((await fake.call(path)).json().ok, false)
  assert.equal((await fake.call(path, { mode: 'invalid' })).json().ok, false)
  const unavailable = (await fake.call(path, { mode: 'debug' })).json()
  assert.equal(unavailable.ok, false)
  assert.equal(unavailable.recoverReason, 'no-checkpoint')
  assert.deepEqual(modes, [])

  recoverable = true
  const platforms = (await fake.call('/platforms')).json()
  assert.equal(platforms.multiPrivate.recoverKey, 'current-candidate')
  assert.equal(preflightCalls, 0)
  const preflight = (await fake.call(statusPath)).json()
  assert.equal(preflight.recoverKey, 'current-candidate')
  assert.equal(preflight.recoverable, false)
  assert.equal(preflight.recoverReason, 'checkpoint-invalid')
  assert.equal(preflightCalls, 1)
  const stale = (await fake.call(path, { mode: 'debug', recoverKey: 'old-candidate' })).json()
  assert.equal(stale.ok, false)
  assert.equal(stale.recoverReason, 'obsolete')
  assert.deepEqual(modes, [])

  const result = (await fake.call(path, { mode: 'debug', recoverKey: 'current-candidate' })).json()
  assert.deepEqual(modes, ['debug'])
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'debug')
  assert.equal(result.state, 'active')
  assert.equal(result.sessionId, 'recovered-session')
  assert.equal(result.checkpoint, 12)
})

test('共享私聊插入设置默认开启，专用接口校验并持久化', async (t) => {
  const { normalize, mergeFromPanel } = configMod
  assert.equal(normalize({}).sharedSteerEnabled, true)
  assert.equal(normalize({}).sharedSteerMaxPerTurn, 0)
  assert.equal(normalize({}).sharedReplyOnSteer, false)
  assert.equal(normalize({ sharedReplyOnSteer: true }).sharedReplyOnSteer, true)
  assert.equal(normalize({ sharedReplyOnSteer: 'true' }).sharedReplyOnSteer, false)
  assert.equal(normalize({}).sharedReplyOnSteerMode, 'all')
  assert.equal(normalize({ sharedReplyOnSteerMode: 'first' }).sharedReplyOnSteerMode, 'first')
  assert.equal(normalize({ sharedReplyOnSteerMode: 'invalid' }).sharedReplyOnSteerMode, 'all')
  assert.equal(normalize({ sharedSteerEnabled: false }).sharedSteerEnabled, false)
  for (const [value, expected] of [['3', 3], [100, 100], [-1, 0], [101, 0], ['NaN', 0]]) {
    assert.equal(normalize({ sharedSteerMaxPerTurn: value }).sharedSteerMaxPerTurn, expected)
  }
  const fake = fakeDshMod.createFakeDsh({ brain: async () => '' })
  const { getConfig } = hostMod.apply(fake.ctx)
  t.after(() => fake.dispose())
  const path = '/platforms/multi-private/settings'
  for (const steerMaxPerTurn of [-1, 101, 1.5, '3', null]) {
    assert.equal((await fake.call(path, { steerEnabled: false, steerMaxPerTurn })).json().ok, false)
  }
  assert.equal((await fake.call(path, { steerEnabled: 'false', steerMaxPerTurn: 3 })).json().ok, false)
  assert.equal((await fake.call(path, { steerEnabled: true, steerMaxPerTurn: 0, replyOnSteer: 'true' })).json().ok, false)
  assert.equal((await fake.call(path, { steerEnabled: true, steerMaxPerTurn: 0, replyOnSteerMode: 'last' })).json().ok, false)
  assert.equal(getConfig().sharedSteerEnabled, true)
  assert.equal(getConfig().sharedSteerMaxPerTurn, 0)
  assert.equal(getConfig().sharedReplyOnSteer, false)
  assert.equal(getConfig().sharedReplyOnSteerMode, 'all')

  assert.equal((await fake.call(path, { steerEnabled: false, steerMaxPerTurn: 3, replyOnSteer: true, replyOnSteerMode: 'first' })).json().ok, true)
  assert.equal(getConfig().sharedSteerEnabled, false)
  assert.equal(getConfig().sharedSteerMaxPerTurn, 3)
  assert.equal(getConfig().sharedReplyOnSteer, true)
  assert.equal(getConfig().sharedReplyOnSteerMode, 'first')
  const status = (await fake.call('/platforms/multi-private')).json()
  assert.equal(status.steerEnabled, false)
  assert.equal(status.steerMaxPerTurn, 3)
  assert.equal(status.replyOnSteer, true)
  assert.equal(status.replyOnSteerMode, 'first')
  assert.equal(mergeFromPanel(getConfig(), { sharedSteerEnabled: true, sharedSteerMaxPerTurn: 99, sharedReplyOnSteer: false, sharedReplyOnSteerMode: 'all' }).sharedSteerMaxPerTurn, 3)
  assert.equal(mergeFromPanel(getConfig(), { sharedSteerEnabled: true, sharedSteerMaxPerTurn: 99, sharedReplyOnSteer: false, sharedReplyOnSteerMode: 'all' }).sharedReplyOnSteer, true)
  assert.equal(mergeFromPanel(getConfig(), { sharedSteerEnabled: true, sharedSteerMaxPerTurn: 99, sharedReplyOnSteer: false, sharedReplyOnSteerMode: 'all' }).sharedReplyOnSteerMode, 'first')
  // 省略 replyOnSteer / replyOnSteerMode 时保留原配置值
  assert.equal((await fake.call(path, { steerEnabled: true, steerMaxPerTurn: 0 })).json().ok, true)
  assert.equal(getConfig().sharedSteerEnabled, true)
  assert.equal(getConfig().sharedSteerMaxPerTurn, 0)
  assert.equal(getConfig().sharedReplyOnSteer, true)
  assert.equal(getConfig().sharedReplyOnSteerMode, 'first')
  assert.equal((await fake.call(path, { steerEnabled: true, steerMaxPerTurn: 0, replyOnSteer: false, replyOnSteerMode: 'all' })).json().ok, true)
  assert.equal(getConfig().sharedReplyOnSteer, false)
  assert.equal(getConfig().sharedReplyOnSteerMode, 'all')
})

test('P4-1: config.js 三分支 ownerAuthorization 规则与 mergeFromPanel 防篡改', () => {
  const {
    DEFAULTS,
    normalize,
    authOwnerKey,
    ownerAuthorizationRevision,
    saveConfig,
    mergeFromPanel,
  } = configMod

  assert.equal(DEFAULTS.ownerPersonId, '')
  assert.equal(normalize({ ownerPersonId: '  p-trim123  ' }).ownerPersonId, 'p-trim123')
  assert.equal(normalize({ ownerPersonId: { bad: true } }).ownerPersonId, '')

  assert.equal(authOwnerKey({ ownerPersonId: 'p-1', ownerQQ: '10001' }), 'p-1')
  assert.equal(authOwnerKey({ ownerPersonId: '', ownerQQ: '10001' }), '10001')
  assert.equal(authOwnerKey({ ownerPersonId: 'p-feishu', ownerQQ: '' }), 'p-feishu')
  assert.equal(authOwnerKey({ ownerPersonId: '', ownerQQ: '' }), '')

  // 场景 A：旧 ownerQQ 平滑首次升级写入 ownerPersonId 时，未经过核验的直接 saveConfig 不得继承旧 revision；
  // 只有显式传 verifiedOwnerUpgrade: true（宿主核验 identity 归属同主人）才保留原 revision
  const c0 = saveConfig({ ownerQQ: '10001' }, {})
  const r0 = ownerAuthorizationRevision(c0)
  assert.ok(r0)
  assert.deepEqual(c0.ownerAuthorization, { owner: '10001', revision: r0 })

  const cUnverified = saveConfig({ ...c0, ownerPersonId: 'p-other-person' }, c0)
  const rUnverified = ownerAuthorizationRevision(cUnverified)
  assert.ok(rUnverified)
  assert.notEqual(rUnverified, r0, '未核验归属时 saveConfig 不得将旧 QQ 主人 revision 转给其他 PersonId')

  const cUpgrade = saveConfig({ ...c0, ownerPersonId: 'p-owner-a' }, c0, { verifiedOwnerUpgrade: true })
  assert.equal(cUpgrade.ownerPersonId, 'p-owner-a')
  assert.equal(ownerAuthorizationRevision(cUpgrade), r0, '同主人核验平滑升级保留原 revision')
  assert.deepEqual(cUpgrade.ownerAuthorization, { owner: 'p-owner-a', revision: r0 })

  // 后续普通保存维持原 revision
  const cNormal = saveConfig({ ...cUpgrade, ownerName: '大肥鱼主人' }, cUpgrade)
  assert.equal(ownerAuthorizationRevision(cNormal), r0)

  // 面板保存传入伪造 ownerPersonId 必须被 mergeFromPanel 忽略，保持原值
  const merged = mergeFromPanel(cNormal, { ownerPersonId: 'p-spoofed', ownerName: '面板昵称' })
  assert.equal(merged.ownerPersonId, 'p-owner-a')
  assert.equal(merged.ownerName, '面板昵称')

  // 场景 B：已有 ownerPersonId 后更换 ownerPersonId 或变更 ownerQQ，一律轮换全新 UUID
  const cRotated = saveConfig({ ...cNormal, ownerPersonId: 'p-owner-b' }, cNormal)
  const rRotated = ownerAuthorizationRevision(cRotated)
  assert.ok(rRotated)
  assert.notEqual(rRotated, r0, '换主后旧授权代次必须立即作废')

  // 切回原 ownerPersonId 同样产生全新 revision（绝不回退到旧代次）
  const cRotatedBack = saveConfig({ ...cRotated, ownerPersonId: 'p-owner-a' }, cRotated)
  const rBack = ownerAuthorizationRevision(cRotatedBack)
  assert.ok(rBack)
  assert.notEqual(rBack, r0)
  assert.notEqual(rBack, rRotated)

  // 已进入多平台阶段后再改动 ownerQQ（非首次升级）也必须轮换
  const cQqChanged = saveConfig({ ...cRotatedBack, ownerQQ: '20002' }, cRotatedBack)
  const rQqChanged = ownerAuthorizationRevision(cQqChanged)
  assert.ok(rQqChanged)
  assert.notEqual(rQqChanged, rBack)

  // 纯非 QQ 主人初始化及延续
  const nonQqDir = freshDataDir('aurabot-p4-nonqq-cfg-')
  const p1 = saveConfig({ ownerQQ: '', ownerPersonId: 'p-feishu-only' }, {})
  const rNonQq = ownerAuthorizationRevision(p1)
  assert.ok(rNonQq)
  assert.deepEqual(p1.ownerAuthorization, { owner: 'p-feishu-only', revision: rNonQq })
  const p2 = saveConfig({ ...p1, ownerName: '飞书主人' }, p1)
  assert.equal(ownerAuthorizationRevision(p2), rNonQq)
  assert.ok(nonQqDir)

  // 无主清理：ownerPersonId 与 ownerQQ 皆空时删除 ownerAuthorization
  const cleared = saveConfig({ ...p2, ownerQQ: '', ownerPersonId: '' }, p2)
  assert.equal(cleared.ownerAuthorization, undefined)
  assert.equal(ownerAuthorizationRevision(cleared), '')
})

test('P4-2: 备份恢复（场景 C）使纯非 QQ 主人旧授权作废并同步/清理 ownerPersonId 后重启重签新代次', async (t) => {
  const { loadConfig, saveConfig, ownerAuthorizationRevision } = configMod
  const { createBackup, stageRestore, applyPendingRestore } = backupMod
  const { createIdentity } = identityMod
  const { createMemoryStorage } = memoryStoreMod
  const { createFakeDsh } = fakeDshMod

  const dir = freshDataDir('aurabot-p4-backup-')
  mkdirSync(join(dir, 'gateway'), { recursive: true })
  const storage = createMemoryStorage({ directory: () => dir, log: noopLog })
  storage.save({
    ...storage.load(),
    items: [{ id: 'm-nonqq', text: '主人常驻飞书', about: 'p-feishu', chatId: 'feishu:private:ou_1', at: 1000, saidAt: 1000 }],
  })
  const idStore = createIdentity({ dataDir: join(dir, 'gateway'), log: noopLog })
  const ownerId = idStore.claimOwner('feishu', 'ou_owner_feishu')

  // 故意先写出匹配主人的带授权配置并打包备份
  const initial = saveConfig({ enabled: false, dryRun: false, setupDone: true, ownerQQ: '', ownerPersonId: ownerId, snowluma: { autoStart: false } }, {})
  const rBefore = ownerAuthorizationRevision(initial)
  assert.ok(rBefore)

  const archive = await createBackup({ version: '2.0.0', root: dir })

  // 备份之后污染当前数据并执行恢复
  saveConfig({ ...initial, ownerName: '污染后' }, initial)
  const staged = await stageRestore(archive.file)
  assert.equal(staged.identityMissing, false)
  applyPendingRestore(Date.now(), { root: dir })

  const restoredRaw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
  assert.equal(restoredRaw.ownerAuthorization, undefined, '恢复后 config.json 必须删除旧 ownerAuthorization')
  assert.equal(restoredRaw.ownerPersonId, ownerId, '恢复后 ownerPersonId 应与恢复出的身份库一致')

  const restored = loadConfig()
  assert.equal(ownerAuthorizationRevision(restored), '', '恢复后旧授权代次必须立即失效')
  assert.equal(restored.ownerPersonId, ownerId)

  // 通过宿主启动完成重签（模拟恢复后重启进程），纯非 QQ 主人应自动重签全新 UUID 代次
  const fake = createFakeDsh({ brain: async () => '好的' })
  const restarted = hostMod.apply(fake.ctx)
  t.after(async () => {
    try { await restarted.gateway?.stopAll?.() } catch {}
    try { restarted.modules?.dispose?.() } catch {}
    try { restarted.onebot?.disconnect?.() } catch {}
    try { fake.dispose() } catch {}
  })
  await restarted.ready
  const rAfter = ownerAuthorizationRevision(restarted.getConfig())
  assert.ok(rAfter, '恢复后重启宿主应为纯非 QQ 主人重签有效授权代次')
  assert.notEqual(rAfter, rBefore, '恢复重签必须生成全新授权代次')
  assert.deepEqual(restarted.getConfig().ownerAuthorization, { owner: ownerId, revision: rAfter })

  // 额外验证：不含身份库（如手动删除 identity）且配置含陈旧 ownerPersonId 的恢复，恢复后清空陈旧 ownerPersonId
  const staleDir = freshDataDir('aurabot-p4-stale-')
  writeFileSync(join(staleDir, 'config.json'), JSON.stringify({
    ownerQQ: '',
    ownerPersonId: 'p-stale-other-env',
    ownerAuthorization: { owner: 'p-stale-other-env', revision: rAfter },
  }))
  const staleArchive = await createBackup({ version: '2.0.0', root: staleDir })
  const stagedStale = await stageRestore(staleArchive.file)
  assert.equal(stagedStale.ok, true)
  applyPendingRestore(Date.now() + 1, { root: staleDir })
  const afterStaleRaw = JSON.parse(readFileSync(join(staleDir, 'config.json'), 'utf8'))
  assert.equal(afterStaleRaw.ownerAuthorization, undefined)
  assert.equal(afterStaleRaw.ownerPersonId, undefined, '无身份库时陈旧 ownerPersonId 应被清空')
})

test('P4-3: 宿主启动平滑升级、无 ownerQQ 纯非 QQ 认主向导完成与敏感命令授权隔离全链路', async (t) => {
  const { loadConfig, saveConfig, ownerAuthorizationRevision } = configMod
  const { createHub } = hubMod
  const { createIdentity } = identityMod
  const { createGateway } = gatewayMod
  const { createFakeDsh } = fakeDshMod
  const { makeFakeAdapter } = fakeAdapterMod

  // ── 子情景 A：旧 ownerQQ 配置在宿主启动时平滑升级到 ownerPersonId 且保留原 revision ──
  {
    const upDir = freshDataDir('aurabot-p4-host-upgrade-')
    const pre = saveConfig({ enabled: false, setupDone: true, ownerQQ: '10001', botQQ: '20002', snowluma: { autoStart: false } }, {})
    const preRev = ownerAuthorizationRevision(pre)
    assert.ok(preRev)
    assert.equal(pre.ownerPersonId, '')

    const fake = createFakeDsh({ brain: async () => '好的' })
    const applied = hostMod.apply(fake.ctx)
    t.after(async () => {
      try { await applied.gateway?.stopAll?.() } catch {}
      try { applied.modules?.dispose?.() } catch {}
      try { applied.onebot?.disconnect?.() } catch {}
      try { fake.dispose() } catch {}
    })
    await applied.ready

    const idStore = createIdentity({ dataDir: join(upDir, 'gateway'), log: noopLog })
    const claimedOwner = idStore.owner()
    assert.ok(claimedOwner)
    const afterCfg = applied.getConfig()
    assert.equal(afterCfg.ownerPersonId, claimedOwner)
    assert.equal(ownerAuthorizationRevision(afterCfg), preRev, '宿主首次同步 ownerPersonId 时必须保留旧 revision')
    assert.deepEqual(afterCfg.ownerAuthorization, { owner: claimedOwner, revision: preRev })
  }

  // ── 子情景 A2（高风险安全边界）：identity.owner()=p-other 与配置旧 ownerQQ=10001 不匹配时，绝不能继承旧 revision ──
  {
    const mismatchDir = freshDataDir('aurabot-p4-host-mismatch-')
    const pre = saveConfig({ enabled: false, setupDone: true, ownerQQ: '10001', botQQ: '20002', snowluma: { autoStart: false } }, {})
    const staleRev = ownerAuthorizationRevision(pre)
    assert.ok(staleRev)
    const idStore = createIdentity({ dataDir: join(mismatchDir, 'gateway'), log: noopLog })
    const pOther = idStore.claimOwner('feishu', 'ou_new_owner')

    const fake = createFakeDsh({ brain: async () => '好的' })
    const applied = hostMod.apply(fake.ctx)
    t.after(async () => {
      try { await applied.gateway?.stopAll?.() } catch {}
      try { applied.modules?.dispose?.() } catch {}
      try { applied.onebot?.disconnect?.() } catch {}
      try { fake.dispose() } catch {}
    })
    await applied.ready

    const afterCfg = applied.getConfig()
    assert.equal(afterCfg.ownerPersonId, pOther)
    assert.equal(afterCfg.ownerQQ, '', '陈旧不匹配的 ownerQQ 应被清空')
    const newRev = ownerAuthorizationRevision(afterCfg)
    assert.ok(newRev)
    assert.notEqual(newRev, staleRev, '不同 PersonId 绝对不得继承旧 QQ 主人的 authorization revision')
    assert.equal(afterCfg.ownerAuthorization?.owner, pOther)
  }

  // ── 子情景 A3（复审边界 #1）：配置已落盘为错误的 { ownerPersonId: p-other, ownerQQ: 10001, ownerAuthorization: { owner: p-other, revision: leakedRev } } 时，启动仍必须校验并轮换 ──
  {
    const persistedMismatchDir = freshDataDir('aurabot-p4-host-persisted-mismatch-')
    const idStore = createIdentity({ dataDir: join(persistedMismatchDir, 'gateway'), log: noopLog })
    const pOther = idStore.claimOwner('feishu', 'ou_real_owner')
    const leaked = saveConfig({
      enabled: false,
      setupDone: true,
      ownerQQ: '10001',
      ownerPersonId: pOther,
      botQQ: '20002',
      snowluma: { autoStart: false },
    }, {}, { verifiedOwnerUpgrade: true })
    const leakedRev = ownerAuthorizationRevision(leaked)
    assert.ok(leakedRev)

    const fake = createFakeDsh({ brain: async () => '好的' })
    const applied = hostMod.apply(fake.ctx)
    t.after(async () => {
      try { await applied.gateway?.stopAll?.() } catch {}
      try { applied.modules?.dispose?.() } catch {}
      try { applied.onebot?.disconnect?.() } catch {}
      try { fake.dispose() } catch {}
    })
    await applied.ready

    const afterCfg = applied.getConfig()
    assert.equal(afterCfg.ownerPersonId, pOther)
    assert.equal(afterCfg.ownerQQ, '', '已落盘的陈旧 ownerQQ 在启动校验时也必须被清空')
    const rotatedRev = ownerAuthorizationRevision(afterCfg)
    assert.ok(rotatedRev)
    assert.notEqual(rotatedRev, leakedRev, '已落盘但 ownerQQ 与身份库不匹配时必须重置授权代次')
    assert.equal(afterCfg.ownerAuthorization?.owner, pOther)
  }

  // ── 子情景 B：纯非 QQ 从零安装 -> 添加平台 -> 认主(/platforms/claim) -> 向导完成(/setup/done) -> 面板保存防篡改 -> /permissions 触发授权 ──
  {
    const cleanDir = freshDataDir('aurabot-p4-host-nonqq-')
    writeFileSync(join(cleanDir, 'config.json'), JSON.stringify({
      enabled: true,
      dryRun: false,
      setupDone: false,
      ownerQQ: '',
      botQQ: '',
      snowluma: { autoStart: false },
      merge: { enabled: false },
      allow: { private: [], groups: [] },
    }))

    const fake = createFakeDsh({ brain: async () => '好的' })
    const applied = hostMod.apply(fake.ctx)
    t.after(async () => {
      try { await applied.gateway?.stopAll?.() } catch {}
      try { applied.modules?.dispose?.() } catch {}
      try { applied.onebot?.disconnect?.() } catch {}
      try { fake.dispose() } catch {}
    })
    await applied.ready

    // 确保此前纯空配置时还没认主，也未签发授权
    assert.equal(applied.getConfig().ownerPersonId, '')
    assert.equal(ownerAuthorizationRevision(applied.getConfig()), '')

    // 先触发添加平台，并在 gateway 上挂入 fake bridge adapter
    const added = (await fake.call('/platforms/add', { platform: 'bridge', enabled: false })).json()
    assert.equal(added.ok, true)
    assert.ok(applied.gateway)
    let bridgeAdapter
    applied.gateway.register(() => {
      bridgeAdapter = makeFakeAdapter({ id: 'bridge', name: 'Bridge' })
      return bridgeAdapter
    })
    const toggled = (await fake.call('/platforms/toggle', { instance: 'bridge', enabled: true })).json()
    assert.equal(toggled.ok, true)

    // 推送一条非 QQ 私聊消息产生候选人，并显式通过 /platforms/claim 认主
    bridgeAdapter.pushInbound({
      chat: { kind: 'private', id: 'b_nonqq_owner' },
      sender: { account: 'b_nonqq_owner', name: '纯Bridge主人' },
      parts: [{ type: 'text', text: '我是纯非 QQ 主人' }],
    })
    await new Promise((r) => setTimeout(r, 30))

    const claimed = (await fake.call('/platforms/claim', { platform: 'bridge', account: 'b_nonqq_owner' })).json()
    assert.equal(claimed.ok, true)
    assert.ok(claimed.person)
    assert.equal(applied.getConfig().ownerPersonId, claimed.person, 'claim 后宿主必须立即同步 ownerPersonId')
    const claimedRev = ownerAuthorizationRevision(applied.getConfig())
    assert.ok(claimedRev, '纯非 QQ 认主后必须立即签发有效 UUID ownerAuthorization')

    // 无 ownerQQ 也能完成非 QQ 向导
    const doneRes = (await fake.call('/setup/done', { platformOnly: true })).json()
    assert.equal(doneRes.ok, true, doneRes.message)
    assert.equal(doneRes.config.setupDone, true)
    assert.equal(doneRes.config.ownerQQ, '')
    assert.equal(doneRes.config.ownerPersonId, claimed.person)

    // 通过 /save 保存正常设置时尝试篡改 ownerPersonId，必须被拒之门外且保留原 revision
    const saveRes = (await fake.call('/save', { ownerName: '飞书小主人', ownerPersonId: 'p-hacker' })).json()
    assert.equal(saveRes.ok, true)
    assert.equal(applied.getConfig().ownerName, '飞书小主人')
    assert.equal(applied.getConfig().ownerPersonId, claimed.person)
    assert.equal(ownerAuthorizationRevision(applied.getConfig()), claimedRev)

    // 同一进程内（未重启，依赖 hub.setGateway）纯非 QQ 主人发保留敏感命令 /permissions 应直接通过并在原平台收到回执
    const beforeCount = bridgeAdapter.sent.length
    bridgeAdapter.pushInbound({
      chat: { kind: 'private', id: 'b_nonqq_owner' },
      sender: { account: 'b_nonqq_owner', name: '纯Bridge主人' },
      parts: [{ type: 'text', text: '/permissions' }],
    })
    const deadline = Date.now() + 2000
    while (bridgeAdapter.sent.length === beforeCount && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20))
    }
    const permReply = bridgeAdapter.sent.slice(beforeCount).find((x) => JSON.stringify(x.payload?.parts || []).includes('权限'))
    assert.ok(permReply, '纯非 QQ 主人无需 ownerQQ 也应在原平台正常执行 /permissions 敏感命令')

    // 测试 /platforms/people/merge 与 /platforms/people/unlink 后保持主人 ownerPersonId 同步一致
    const idStore = createIdentity({ dataDir: join(cleanDir, 'gateway'), log: noopLog })
    const guestId = idStore.resolve('feishu', 'ou_merge_guest')
    const mergePreview = (await fake.call('/platforms/people/merge', { from: guestId, into: claimed.person, dryRun: true })).json()
    assert.equal(mergePreview.ok, true)
    const mergeDone = (await fake.call('/platforms/people/merge', { from: guestId, into: claimed.person, dryRun: false })).json()
    assert.equal(mergeDone.ok, true)
    assert.equal(applied.getConfig().ownerPersonId, claimed.person)
    assert.equal(ownerAuthorizationRevision(applied.getConfig()), claimedRev)

    const guest2 = idStore.resolve('bridge', 'b_guest')
    const unlinkRes = (await fake.call('/platforms/people/unlink', { platform: 'bridge', account: 'b_guest' })).json()
    assert.equal(unlinkRes.ok, true)
    assert.equal(applied.getConfig().ownerPersonId, claimed.person)
    assert.ok(guest2)
  }

  // ── 子情景 C：纯非 QQ 主人在敏感命令执行中途发生换主/恢复重签，敏感回执必须被拦截 ──
  for (const [label, mutation, shouldSend] of [
    ['同主人保存普通配置保留 revision', (cfg) => saveConfig({ ...cfg, ownerName: '普通保存' }, cfg), true],
    ['换主轮换 ownerPersonId 作废旧授权', (cfg) => saveConfig({ ...cfg, ownerPersonId: 'p-other-owner' }, cfg), false],
    ['模拟备份恢复删除并重签新 revision 拦截旧授权', (cfg) => {
      const stripped = { ...cfg }
      delete stripped.ownerAuthorization
      return saveConfig(stripped, stripped)
    }, false],
  ]) {
    await t.test(`纯非 QQ 敏感命令代次拦截：${label}`, async (st) => {
      const dir = freshDataDir('aurabot-p4-cmd-rev-')
      const gwIdentity = createIdentity({ dataDir: join(dir, 'gateway'), log: noopLog })
      const ownerId = gwIdentity.claimOwner('feishu', 'ou_only_feishu')
      let cfg = saveConfig({
        enabled: true,
        dryRun: false,
        setupDone: true,
        botQQ: '',
        ownerQQ: '',
        ownerPersonId: ownerId,
        voice: { enabled: false },
        merge: { enabled: false },
        stickers: { enabled: false, collect: false },
        platforms: { feishu: { enabled: true } },
        allow: { private: [], groups: [] },
      }, {})
      assert.ok(ownerAuthorizationRevision(cfg))

      const gw = createGateway({ config: cfg, dataDir: (...p) => join(dir, 'gateway', ...p), identity: gwIdentity, log: noopLog })
      const adapter = makeFakeAdapter({ id: 'feishu', name: '飞书' })
      gw.register(() => adapter)
      await gw.sync()

      const entered = deferred()
      const resume = deferred()
      st.after(async () => {
        resume.resolve()
        await gw.stopAll()
      })

      const fake = createFakeDsh({ brain: async () => '好的' })
      st.after(() => fake.dispose())

      const hub = createHub({
        dsh: fake.ctx,
        getConfig: () => loadConfig(),
        log: noopLog,
        gateway: gw,
        identity: gwIdentity,
        hooks: {
          send: async (message) => {
            entered.resolve()
            await resume.promise
            return message
          },
        },
        onCommand: async (_msg, markSensitive) => {
          assert.equal(markSensitive('permissions'), true)
          return '纯飞书主人敏感回执'
        },
      })
      st.after(() => hub.dispose())

      const work = hub.onGatewayMessage({
        instance: 'feishu',
        platform: 'feishu',
        messageId: 'm_1',
        kind: 'private',
        chatId: 'feishu:private:ou_only_feishu',
        chat: { kind: 'private', id: 'ou_only_feishu' },
        sender: { account: 'ou_only_feishu', name: '飞书主人', person: ownerId, isOwner: true },
        text: '/permissions',
        parts: [{ type: 'text', text: '/permissions' }],
        at: Date.now(),
      })

      await entered.promise
      cfg = mutation(cfg)
      resume.resolve()
      await work

      const delivered = adapter.sent.some((r) => JSON.stringify(r.payload?.parts || []).includes('纯飞书主人敏感回执'))
      assert.equal(delivered, shouldSend)
    })
  }
})

test('P4-4: 前端 client.js 对纯非 QQ 主人的 GlobalAccess 展示、向导与状态栏支持', async () => {
  const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const marker = '    exports.apply = apply'
  // 状态栏场景从已完成 bootstrap 的一帧开始。夹具不运行 useEffect。
  const readyMarker = 'const [ready, setReady] = useState(false)'
  assert.ok(source.includes(marker) && source.includes(readyMarker))

  const instrumented = source.replace(readyMarker, 'const [ready, setReady] = useState(true)').replace(
    marker,
    '    exports.p4Test = { GlobalAccess, AurabotPage, Overview }\n' + marker,
  )

  const script = new Script(instrumented, { filename: 'client/client.js' })
  const storage = new Map()
  const localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) }
  let loader
  script.runInNewContext({
    fetch: async () => ({ json: async () => ({ ok: true }) }),
    localStorage,
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    window: {
      __ModuleLoader__: { load: (v) => { loader = v } },
      addEventListener() {},
      removeEventListener() {},
    },
  })

  let hook = 0
  let state = []
  const React = {
    Component: class {},
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (initial) => {
      const i = hook++
      if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial
      return [state[i], (val) => { state[i] = typeof val === 'function' ? val(state[i]) : val }]
    },
    useEffect() {},
    useRef: (init = null) => ({ current: init }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
  const vmExport = (() => {
    const exportsObj = loader.factory(() => React)
    return { ...loader, ...exportsObj }
  })()

  const collectNodes = (node, pred, out = []) => {
    if (!node || typeof node !== 'object') return out
    if (Array.isArray(node)) { for (const x of node) collectNodes(x, pred, out); return out }
    if (pred(node)) out.push(node)
    if (node.children) collectNodes(node.children, pred, out)
    return out
  }
  const textOf = (node) => {
    if (node == null || node === false) return ''
    if (typeof node !== 'object') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join('')
    return [node.props?.label, node.props?.hint, textOf(node.children)].filter(Boolean).join(' ')
  }

  // 1) GlobalAccess：纯非 QQ 主人展示当前认主身份并标注 QQ 号可选
  const nonQqCfg = {
    enabled: true,
    dryRun: false,
    debug: false,
    setupDone: true,
    botQQ: '',
    ownerQQ: '',
    ownerPersonId: 'p-feishu-owner',
    ownerName: '飞书主人',
    ownerLevel: 'full',
    ownerPrimary: { mode: 'fixed', platform: 'feishu', instance: 'feishu', account: 'ou_feishu', fallback: false, noticeFallback: true },
    notice: { enabled: true, approval: true, question: true },
    qqApi: { enabled: true },
    approvalViaQQ: true,
    longTasks: true,
    subagentBackground: false,
    profilePerms: {},
    persona: { current: 'default' },
    diary: { enabled: false },
    allow: { private: [], groups: [] },
    platforms: { feishu: { enabled: true } },
  }

  hook = 0
  state = [
    {
      ok: true,
      owner: 'p-feishu-owner',
      list: [{ person: 'p-feishu-owner', owner: true, accounts: [{ platform: 'feishu', account: 'ou_feishu' }] }],
      ownerAccountOptions: [
        { key: 'feishu:feishu:ou_feishu', platform: 'feishu', instance: 'feishu', account: 'ou_feishu', state: 'connected', enabled: true, canProactive: true, multiInstance: false },
      ],
      resolvedProactiveRoute: { chatId: 'feishu:private:ou_feishu', blocked: false, reason: 'ok', target: { platform: 'feishu', instance: 'feishu', account: 'ou_feishu' }, fallbackUsed: false },
      resolvedNoticeRoute: { chatId: 'feishu:private:ou_feishu', blocked: false, reason: 'ok', target: { platform: 'feishu', instance: 'feishu', account: 'ou_feishu' }, fallbackUsed: false },
      lastBlockedRoute: null,
    },
    false,
    null,
  ]

  const gaTree = vmExport.p4Test.GlobalAccess({
    st: { config: nonQqCfg, modules: [], onebot: { state: 'unconfigured' } },
    draft: JSON.parse(JSON.stringify(nonQqCfg)),
    setDraft() {},
    toast() {},
  })
  const gaText = textOf(gaTree)
  assert.match(gaText, /当前认主身份/)
  assert.match(gaText, /p-feishu-owner/)
  assert.match(gaText, /飞书 · ou_feishu/)
  assert.match(gaText, /主人 QQ 号（可选）/)
  assert.match(gaText, /可留空/)

  // 2) AurabotPage + Overview：纯非 QQ 离线（启用但 disconnected）必须按主平台报错与警告；已连接才显示在线
  const offlineSt = {
    ok: true,
    version: '1.5.0',
    startedAt: Date.now(),
    config: nonQqCfg,
    platforms: [{ instance: 'feishu', platform: 'feishu', name: 'feishu', enabled: true, legacy: false, state: 'disconnected' }],
    onebot: { state: 'unconfigured', login: null, endpoint: {}, problem: '' },
    snowluma: { installed: false, running: false },
    mood: { value: 80, label: '开心' },
    personas: [{ id: 'default', name: '大肥鱼默认' }],
    stickers: { count: 0 },
    diary: { next: 0, last: null },
    stats: { received: 0, sent: 0, voice: 0, stickers: 0 },
    sessions: {},
    modules: [],
  }
  hook = 0
  state = [offlineSt, '', JSON.parse(JSON.stringify(nonQqCfg)), 'overview']
  const offlinePageText = textOf(vmExport.p4Test.AurabotPage())
  assert.doesNotMatch(offlinePageText, /在线（多平台）/, '纯非 QQ 平台未连接时不得误报在线')
  assert.match(offlinePageText, /没连上/)

  hook = 0
  state = [null, false, '7']
  const offlineOvText = textOf(vmExport.p4Test.Overview({ st: offlineSt, toast() {}, go() {} }))
  assert.match(offlineOvText, /还没有已连接的通讯平台/)

  const onlineSt = {
    ...offlineSt,
    platforms: [{ instance: 'feishu', platform: 'feishu', name: 'feishu', enabled: true, legacy: false, state: 'connected' }],
  }
  hook = 0
  state = [onlineSt, '', JSON.parse(JSON.stringify(nonQqCfg)), 'overview']
  const pageTree = vmExport.p4Test.AurabotPage()
  const pageText = textOf(pageTree)
  assert.doesNotMatch(pageText, /QQ 没连上/, '纯非 QQ 启用且已连接时状态栏不得误报「QQ 没连上」')
  assert.match(pageText, /在线/)
  const subNode = collectNodes(pageTree, (n) => n.props?.className === 'ab-sub')[0]
  assert.ok(subNode)
  assert.doesNotMatch(textOf(subNode), /^QQ\s/, '无 botQQ 时副标题不应显示空 QQ 前缀')
  assert.doesNotMatch(pageText, /SnowLuma/, 'QQ 未启用时顶部不应显示 SnowLuma 标签')

  const qqGwCfg = JSON.parse(JSON.stringify(nonQqCfg))
  qqGwCfg.legacyQqEnabled = false
  qqGwCfg.platforms = { qq: { enabled: true, backend: 'snowluma' } }
  const qqGwSt = {
    ...offlineSt,
    config: qqGwCfg,
    platforms: [{ instance: 'qq', platform: 'qq', name: 'qq', enabled: true, legacy: false, state: 'connected' }],
    onebot: { state: 'stopped', login: null, endpoint: {}, problem: '' },
    snowluma: { installed: true, running: true },
  }
  hook = 0
  state = [qqGwSt, '', JSON.parse(JSON.stringify(qqGwCfg)), 'overview']
  const qqGwText = textOf(vmExport.p4Test.AurabotPage())
  assert.match(qqGwText, /在线/, '网关 qq 已连接时顶部应在线')
  assert.doesNotMatch(qqGwText, /QQ 没连上/, '网关 qq 已连接时不得误报 QQ 没连上')
  assert.match(qqGwText, /SnowLuma 运行中/, 'SnowLuma 后端应显示 SL 状态')

  qqGwCfg.platforms.qq.backend = 'onebot'
  qqGwSt.config = qqGwCfg
  hook = 0
  state = [qqGwSt, '', JSON.parse(JSON.stringify(qqGwCfg)), 'overview']
  const qqOnebotText = textOf(vmExport.p4Test.AurabotPage())
  assert.match(qqOnebotText, /OneBot 已连接/, 'OneBot 后端应显示 OneBot 状态')
  assert.doesNotMatch(qqOnebotText, /SnowLuma/, 'OneBot 后端不应显示 SnowLuma 标签')

  hook = 0
  state = [null, false, '7']
  const onlineOvText = textOf(vmExport.p4Test.Overview({ st: onlineSt, toast() {}, go() {} }))
  assert.doesNotMatch(onlineOvText, /还没连上 QQ 网关|还没有已连接的通讯平台/)

  // 3) 非 QQ 向导分支不得强校验 ownerQQ（仅 qqOk 属于 QQ 模式）
  const wizQqOkLine = source.split(/\r?\n/).find((l) => l.includes('const qqOk ='))
  const wizCanNextLine = source.split(/\r?\n/).find((l) => l.includes('const canNext ='))
  assert.ok(wizQqOkLine && wizCanNextLine)
  assert.match(wizCanNextLine, /(?:isQqMode|mode === 'qq') \? qqCanNext\[step\] : externalCanNext\[step\]/)
})
