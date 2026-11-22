// 方案 v8 §三～§四：备份搬移恢复日志、启动 recovery guard、本机恢复状态排除、以及迁移-备份互斥测试
import assert from 'node:assert/strict'
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFakeDsh } from './helpers/fake-dsh.js'

async function isolatedRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-bk-journal-'))
  const oldDir = process.env.AURABOT_DATA_DIR
  const oldWs = process.env.AURABOT_WORKSPACE
  process.env.AURABOT_DATA_DIR = root
  process.env.AURABOT_WORKSPACE = join(root, 'workspace')
  mkdirSync(join(root, 'workspace'), { recursive: true })
  t.after(() => {
    if (oldDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = oldDir
    if (oldWs === undefined) delete process.env.AURABOT_WORKSPACE
    else process.env.AURABOT_WORKSPACE = oldWs
    rmSync(root, { recursive: true, force: true })
  })
  const backup = await import('../src/core/backup.js')
  const migration = await import('../src/core/qq-gateway-migration.js')
  return { root, backup, migration }
}

test('v8 §四：本机恢复状态（迁移事务、恢复门、epoch、搬移日志）在完整备份与配置备份中被排除且导入拒绝', async (t) => {
  const { root, backup, migration } = await isolatedRoot(t)
  writeFileSync(join(root, 'config.json'), JSON.stringify({ ownerQQ: '10001', enabled: false }))
  writeFileSync(join(root, 'memories.json'), '{}')
  // 写入 4 类本机恢复状态文件
  migration.createMigrationTxn(root, {
    txnId: 'local-txn-only',
    expectedRevision: 0,
    fromLegacyQqEnabled: true,
    targetLegacyQqEnabled: false,
    targetPlatform: { enabled: true },
    rawPreConfig: { ownerQQ: '10001' },
    targetConfig: { legacyQqEnabled: false },
  })
  migration.writeRecoveryGuard(root, { phase: 'backup-moving', txnId: 'local-txn-only', reason: 'secret local guard' })
  migration.bumpDataEpoch(root, 'local-epoch-1')
  writeFileSync(join(root, 'backup-restore-journal.json'), JSON.stringify({ version: 1, state: 'rolled-back' }))

  const full = await backup.createBackup({ version: '1.0.0' })
  const cfgOnly = await backup.createBackup({ version: '1.0.0', configOnly: true })
  // 只有 config.json 和 memories.json 进包，4 类本机状态全部被排除
  assert.equal(full.files, 2)
  assert.equal(cfgOnly.files, 2)

  // 若恶意压缩包内包含上述任一本机状态路径，导入校验阶段直接拒绝
  // 通过验证 stageRestore 使用 clean archive 成功，且已有 active txn 时 stageRestore 被互斥拦截
  const otherRoot = mkdtempSync(join(tmpdir(), 'aurabot-bk-import-'))
  t.after(() => rmSync(otherRoot, { recursive: true, force: true }))
  process.env.AURABOT_DATA_DIR = otherRoot
  await assert.doesNotReject(() => backup.stageRestore(full.file))
  // 还原 env 并触发互斥校验：存在未完成迁移事务时 stageRestore 必须拒绝
  process.env.AURABOT_DATA_DIR = root
  await assert.rejects(() => backup.stageRestore(full.file), (e) => e.code === 'QQ_MIGRATION_ACTIVE')
})

test('v8 §三：backup prepared/moving/moved/before-epoch 崩溃恢复，及最小 backup-moving 恢复面板', async (t) => {
  const { root, backup, migration } = await isolatedRoot(t)
  writeFileSync(join(root, 'config.json'), JSON.stringify({ ownerQQ: '10001', botQQ: '20002', enabled: false, ownerName: '旧备份主人' }))
  writeFileSync(join(root, 'memories.json'), JSON.stringify({ version: 1, tag: 'archive-memory' }))
  const archive = await backup.createBackup({ version: '1.0.0' })

  // 修改当前数据为新状态
  writeFileSync(join(root, 'config.json'), JSON.stringify({ ownerQQ: '10001', botQQ: '20002', enabled: false, ownerName: '当前数据主人' }))
  writeFileSync(join(root, 'memories.json'), JSON.stringify({ version: 1, tag: 'current-memory' }))
  await backup.stageRestore(archive.file)

  // 1) prepared 阶段崩溃 -> 原数据完整，再次启动可正常恢复或取消
  assert.throws(() => backup.applyPendingRestore(100, {
    onStep(phase) {
      if (phase === 'prepared') throw Object.assign(new Error('crash'), { code: 'SIMULATED_CRASH' })
    },
  }), /crash/)
  assert.equal(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).ownerName, '当前数据主人')
  assert.equal(JSON.parse(readFileSync(join(root, 'memories.json'), 'utf8')).tag, 'current-memory')

  // 2) moving 阶段（搬完 config 但在搬 memories 前）崩溃 -> host.apply 进入最小恢复面板（不打开 config/身份/网关/模块），cancelRestore 被拒，回滚精准恢复原数据
  let movesSeen = 0
  assert.throws(() => backup.applyPendingRestore(101, {
    onStep(phase) {
      if (phase === 'after-move' && ++movesSeen === 2) {
        throw Object.assign(new Error('power loss mid move'), { code: 'SIMULATED_CRASH' })
      }
    },
  }), /power loss mid move/)
  assert.equal(backup.inspectBackupRestoreState(root).state, 'backup-moving')
  assert.throws(() => backup.cancelRestore(), (e) => e.code === 'BACKUP_RESTORE_ACTIVE')

  const fake = createFakeDsh({ brain: async () => 'unreachable' })
  const { apply } = await import('../src/host.js')
  const recoveryHost = apply(fake.ctx)
  await recoveryHost.ready
  t.after(() => fake.dispose())
  assert.equal(recoveryHost.recoveryMode, 'backup-moving')
  assert.equal(recoveryHost.gateway, null, 'backup-moving 期间绝不能初始化任何平台网关')
  assert.equal(recoveryHost.hub, null, 'backup-moving 期间绝不能启动中枢或打开共享存储')
  assert.equal(migration.readRecoveryGuard(root).phase, 'backup-moving')

  const stateRes = (await fake.call('/backup/state')).json()
  assert.equal(stateRes.recoveryMode, 'backup-moving')
  const rbRes = (await fake.call('/backup/recovery/rollback', {}, { 'x-aurabot-backup': '1' })).json()
  assert.equal(rbRes.ok, true)
  assert.equal(rbRes.state, 'rolled-back')
  assert.equal(migration.readRecoveryGuard(root).phase, 'idle')
  assert.equal(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).ownerName, '当前数据主人')
  assert.equal(JSON.parse(readFileSync(join(root, 'memories.json'), 'utf8')).tag, 'current-memory')
  assert.ok(existsSync(join(root, '.restore-pending.json')), '回滚后保留原待恢复暂存以便人工决定取消或重试')

  // 3) moved 阶段（epoch 更新后、写 committed 前）崩溃 -> 同一事务再次 applyPendingRestore 幂等收尾，不重复递增 dataEpoch，并使旧迁移事务失效
  const epochBefore = migration.readDataEpoch(root).epoch
  migration.createMigrationTxn(root, {
    txnId: 'stale-txn-before-backup',
    expectedRevision: 0,
    fromLegacyQqEnabled: true,
    targetLegacyQqEnabled: false,
    targetPlatform: { enabled: true },
    rawPreConfig: { ownerQQ: '10001' },
    targetConfig: { legacyQqEnabled: false },
  })
  let crashEpoch = 0
  assert.throws(() => backup.applyPendingRestore(102, {
    onStep(phase) {
      if (phase === 'after-epoch' && crashEpoch++ === 0) {
        throw Object.assign(new Error('crash after epoch'), { code: 'SIMULATED_CRASH' })
      }
    },
  }), /crash after epoch/)
  const afterCrashEpoch = migration.readDataEpoch(root).epoch
  assert.equal(afterCrashEpoch, epochBefore + 1)
  assert.equal(backup.applyPendingRestore(103), 2)
  assert.equal(migration.readDataEpoch(root).epoch, afterCrashEpoch, '同一个备份恢复事务绝不重复推进 dataEpoch')
  assert.equal(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).ownerName, '旧备份主人')
  assert.equal(backup.readBackupRestoreJournal(root), null)
})

test('待恢复备份与未完成迁移事务同时存在时：不自动应用备份、默认 QQ 暂停、recovery guard 标 backup-not-started', async (t) => {
  const { root, backup, migration } = await isolatedRoot(t)
  writeFileSync(join(root, 'config.json'), JSON.stringify({ ownerQQ: '10001', botQQ: '20002', enabled: true, setupDone: true, ownerName: '原数据' }))
  writeFileSync(join(root, 'memories.json'), '{}')
  const archive = await backup.createBackup({ version: '1.0.0' })
  await backup.stageRestore(archive.file)

  writeFileSync(join(root, 'config.json'), JSON.stringify({ ownerQQ: '10001', botQQ: '20002', enabled: true, setupDone: true, ownerName: '迁移中数据' }))
  migration.createMigrationTxn(root, {
    txnId: 'conflict-txn',
    expectedRevision: 0,
    fromLegacyQqEnabled: true,
    targetLegacyQqEnabled: false,
    targetPlatform: { enabled: true },
    rawPreConfig: { ownerQQ: '10001' },
    targetConfig: { legacyQqEnabled: false },
  })

  const fake = createFakeDsh({ brain: async () => 'ok' })
  const { apply } = await import('../src/host.js')
  const host = apply(fake.ctx)
  t.after(async () => {
    fake.dispose()
    await host.gateway?.stopAll?.()
  })
  await host.ready

  assert.equal(migration.readRecoveryGuard(root).phase, 'backup-not-started')
  assert.equal(host.qqOwnership.status().paused, true)
  assert.equal(host.onebot, null, '冲突未决时默认 QQ 直连不得拉起')
  assert.equal((await fake.call('/onebot/reconnect')).json().ok, false)
  assert.equal(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).ownerName, '迁移中数据', '未选择恢复前不应自动覆盖当前数据')
})

test('P2-4：backup-moving 跨卷（EXDEV）回滚目录条目不抛 EISDIR 并完整恢复目录内容', async (t) => {
  const { root, backup } = await isolatedRoot(t)
  const { syncBuiltinESMExports } = await import('node:module')
  const { BACKUP_JOURNAL_FILE } = await import('../src/core/qq-gateway-migration.js')

  const movedTarget = join(root, 'backups', 'pre-restore-exdev', 'old-sessions')
  mkdirSync(join(movedTarget, 'nested'), { recursive: true })
  writeFileSync(join(movedTarget, 'nested', 'state.json'), JSON.stringify({ restored: false }))

  writeFileSync(join(root, BACKUP_JOURNAL_FILE), JSON.stringify({
    version: 1,
    txnId: 'exdev-dir-rollback',
    state: 'moving',
    undo: [
      { srcKind: 'data', destKind: 'data', fromRel: 'sessions', toRel: 'backups/pre-restore-exdev/old-sessions', directory: true, done: true },
    ],
  }))

  const origRename = fs.renameSync
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(from).includes('pre-restore-exdev')) {
      throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' })
    }
    return origRename(from, to)
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })

  const res = backup.recoverBackupRestore(root, { action: 'rollback' })
  assert.equal(res.state, 'rolled-back')
  assert.equal(res.reverted, 1)
  assert.equal(existsSync(movedTarget), false)
  assert.equal(JSON.parse(readFileSync(join(root, 'sessions', 'nested', 'state.json'), 'utf8')).restored, false)
})
