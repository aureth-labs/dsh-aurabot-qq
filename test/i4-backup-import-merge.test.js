// I4 验收测试：成组备份恢复 / 从 QQ 版只读导入与核对回退 / 就地升级 / 合并人与冲突撤销。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { normalize } from '../src/core/config.js'
import { applyPendingRestore, createBackup, createPairedBackup, lastRestoreResult, restorePairedBackup, stageRestore } from '../src/core/backup.js'
import { createIdentity } from '../src/gateway/identity.js'
import { IDENTITY_FILE } from '../src/gateway/identity-store.js'
import { createMemoryStore, enumeratePeopleFromState, ownedByFromState } from '../src/features/memory.js'
import { createMemoryStorage, readMemoryDatabase } from '../src/features/memory-store.js'
import { ensureUpgradedStorage, importFromQQ } from '../src/features/import-qq.js'
import { MERGE_UNDO_WARNING, mergePerson, undoMergePerson } from '../src/features/merge-person.js'
import { createHub } from '../src/chat/hub.js'

const log = { info() {}, warn() {}, debug() {}, error() {} }

function makeSandbox(t, prefix = 'aurabot-i4-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const prev = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  t.after(() => {
    if (prev === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

function hashTree(dir, base = dir, out = {}) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    const rel = relative(base, full).replace(/\\/g, '/')
    const entries = readdirSync
    try {
      const files = entries(full)
      if (Array.isArray(files)) {
        hashTree(full, base, out)
        continue
      }
    } catch {}
    out[rel] = createHash('sha256').update(readFileSync(full)).digest('hex')
  }
  return out
}

function readAllMemory(dir) {
  const db = new DatabaseSync(join(dir, 'memory.sqlite'))
  try {
    return readMemoryDatabase(db)
  } finally {
    db.close()
  }
}

function seedMemorySqlite(dir, state) {
  const storage = createMemoryStorage({ directory: () => dir, log })
  const current = storage.load()
  storage.save({ ...current, ...state })
  return storage
}

test('I4-1：记忆库与身份库成组备份再恢复，两库与 router.json 内容逐条一致', async (t) => {
  const dir = makeSandbox(t)
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ ownerQQ: '10001' }))
  seedMemorySqlite(dir, {
    items: [
      { id: 'm1', text: '主人喜欢冰美式', about: 'p-owner', chatId: 'qq:private:10001', at: 1000, saidAt: 1000, hits: 1 },
      { id: 'm2', text: '小李养了蓝猫', about: '10002', chatId: 'qq:private:10002', at: 2000, saidAt: 2000, hits: 0 },
    ],
    profiles: { '10002': { text: '性格温和', name: '小李', tags: ['喜欢'], at: 2000 } },
    shortTerm: { '10002': { text: '刚聊到猫砂', at: 2100, through: 2100 } },
    insights: { 'qq:10002': [{ text: '说话慢热', at: 2200 }] },
    styles: { 'qq:10002': ['习惯句尾加波浪号'] },
    relations: [{ id: 'r1', subj: '主人', subjQq: 'p-owner', pred: '同事', obj: '小李', objQq: '10002', chatId: 'qq:private:10001', speaker: 'p-owner', at: 2000 }],
  })

  const idStore = createIdentity({ dataDir: join(dir, 'gateway'), log })
  const ownerId = idStore.claimOwner('qq', '10001')
  idStore.link('feishu', 'ou_owner_fs', ownerId, 'owner')
  idStore.importLegacyQQ(['10002'])
  writeFileSync(join(dir, 'gateway', 'router.json'), JSON.stringify({ fixed: { [ownerId]: 'feishu' }, seen: {}, kinds: {} }))

  const beforeMem = readAllMemory(dir)
  const beforeAccountsOwner = idStore.accountsOf(ownerId)
  const beforeAccountsLegacy = idStore.accountsOf('10002')

  const archive = await createBackup({ version: '2.0.0', root: dir })

  // 备份后原地篡改两库和路由记录
  seedMemorySqlite(dir, { items: [{ id: 'tampered', text: '脏数据', about: '999', at: 9999 }], profiles: {}, shortTerm: {} })
  const tamperedId = createIdentity({ dataDir: join(dir, 'gateway'), log })
  tamperedId.importLegacyQQ(['999'])
  writeFileSync(join(dir, 'gateway', 'router.json'), JSON.stringify({ fixed: { bad: 'qq' }, seen: {}, kinds: {} }))

  const staged = await stageRestore(archive.file)
  assert.equal(staged.ok, true)
  assert.equal(staged.identityMissing, false)

  applyPendingRestore(5001, { root: dir })

  assert.deepEqual(readAllMemory(dir), beforeMem)
  const afterId = createIdentity({ dataDir: join(dir, 'gateway'), log })
  assert.equal(afterId.owner(), ownerId)
  assert.deepEqual(afterId.accountsOf(ownerId), beforeAccountsOwner)
  assert.deepEqual(afterId.accountsOf('10002'), beforeAccountsLegacy)
  assert.equal(afterId.lookup('qq', '999'), null)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'gateway', 'router.json'), 'utf8')), { fixed: { [ownerId]: 'feishu' }, seen: {}, kinds: {} })
  assert.equal(lastRestoreResult(dir)?.identityRebuilt, false)
})

test('I4-2：旧备份包（无身份库）恢复后重建身份表，老用户全在且带重建提示', async (t) => {
  const dir = makeSandbox(t)
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ ownerQQ: '10001' }))
  seedMemorySqlite(dir, {
    items: [
      { id: 'm1', text: '主人爱吃草莓', about: '10001', chatId: 'private:10001', at: 1000, saidAt: 1000 },
      { id: 'm2', text: '朋友阿明在做游戏', about: '20002', chatId: 'private:20002', at: 2000, saidAt: 2000 },
    ],
    profiles: { '30003': { text: '摄影师', name: '小周', at: 2500 } },
    insights: { 'qq:40004': [{ text: '很严谨', at: 2600 }] },
  })
  const beforeMem = readAllMemory(dir)
  // 此时还没有 gateway/identity.sqlite，打一个旧式备份包
  const legacyArchive = await createBackup({ version: '1.2.0', root: dir })

  // 新环境下之前有旧的非 QQ 绑定与错乱记忆
  seedMemorySqlite(dir, { items: [{ id: 'other', text: '另一份', about: '999', at: 3000 }], profiles: {} })
  const preId = createIdentity({ dataDir: join(dir, 'gateway'), log })
  const pStale = preId.claimOwner('feishu', 'ou_stale')
  assert.ok(pStale)

  const staged = await stageRestore(legacyArchive.file)
  assert.equal(staged.identityMissing, true)
  applyPendingRestore(5002, { root: dir })

  assert.deepEqual(readAllMemory(dir), beforeMem)
  const rebuilt = createIdentity({ dataDir: join(dir, 'gateway'), log })
  for (const num of ['10001', '20002', '30003', '40004']) {
    assert.equal(rebuilt.lookup('qq', num), num, `老用户 ${num} 应出现在重建的身份表里`)
    assert.equal(rebuilt.isValid(num), true)
  }
  assert.equal(rebuilt.lookup('feishu', 'ou_stale'), null, '旧身份库里的非 QQ 绑定应已移入留底并清空')
  assert.equal(existsSync(join(dir, 'backups', 'pre-restore-5002', 'gateway', IDENTITY_FILE)), true)

  const report = lastRestoreResult(dir)
  assert.equal(report?.identityRebuilt, true)
  assert.match(report?.notice || '', /身份表是重建的.*非 QQ 平台的绑定需要重新做/)
})

test('I4-3：缺少记忆库只有身份库的备份包拒绝暂存与恢复', async (t) => {
  const dir = makeSandbox(t)
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ ownerQQ: '10001' }))
  const idStore = createIdentity({ dataDir: join(dir, 'gateway'), log })
  idStore.claimOwner('qq', '10001')

  const badArchive = await createBackup({ version: '2.0.0', root: dir })
  await assert.rejects(stageRestore(badArchive.file), /只有身份库没有记忆库/)
})

test('I4-4：从 QQ 版导入预检 + 首次全量导入，源目录哈希一字不差，安全配置过滤到位', async (t) => {
  const sandbox = makeSandbox(t)
  const source = join(sandbox, 'qq-legacy')
  const target = join(sandbox, 'aurabot-new')
  mkdirSync(source, { recursive: true })
  mkdirSync(target, { recursive: true })

  // 构建真实 QQ 版目录（含 SQLite 记忆、chatlog、远程与本地向量、人设、config、sessions、logs）
  seedMemorySqlite(source, {
    items: [
      { id: 'v1', text: '主人养了一只三花猫', about: '10001', chatId: 'private:10001', at: 1000, saidAt: 1000 },
      { id: 'v2', text: '三花猫叫橘子', about: '10001', chatId: 'private:10001', at: 1500, saidAt: 1500 },
      { id: 'v3', text: '同事小陈爱喝乌龙茶', about: '10002', chatId: 'private:10002', at: 2000, saidAt: 2000 },
    ],
    profiles: {
      '10001': { text: '我的主人', name: '主人', at: 1500 },
      '10002': { text: '爱喝茶', name: '小陈', at: 2000 },
    },
    relations: [{ id: 'r1', subj: '主人', subjQq: '10001', pred: '同事', obj: '小陈', objQq: '10002', chatId: 'private:10001', speaker: '10001', at: 2000 }],
  })
  mkdirSync(join(source, 'chatlog'), { recursive: true })
  writeFileSync(join(source, 'chatlog', '2026-11-10.jsonl'), [
    JSON.stringify({ t: 1000, chatId: 'private:10001', who: '主人', text: '我家有三花猫' }),
    JSON.stringify({ t: 1100, chatId: 'private:10001', who: 'bot', text: '真可爱呀' }),
  ].join('\n') + '\n')
  writeFileSync(join(source, 'memory-vectors.json'), JSON.stringify({
    model: 'text-embedding-3-small',
    dims: 3,
    items: { v1: [1, 0, 0], v2: [0.9, 0.4, 0], v3: [0, 1, 0] },
  }))
  writeFileSync(join(source, 'memory-vectors-meta.json'), JSON.stringify({
    model: 'text-embedding-3-small',
    base: 'abc',
    items: { v1: 'h1', v2: 'h2', v3: 'h3' },
  }))
  mkdirSync(join(source, 'personas'), { recursive: true })
  writeFileSync(join(source, 'personas', 'dafeiyu.md'), '# 大肥鱼人设')
  writeFileSync(join(source, 'sessions.json'), JSON.stringify({ chats: { 'private:10001': { sessionId: 'sess-old' } }, memoryCutoffs: { '10001': 900 } }))
  writeFileSync(join(source, 'memory-json-fallback.json'), JSON.stringify({ at: 500 }))
  mkdirSync(join(source, 'logs'), { recursive: true })
  writeFileSync(join(source, 'logs', 'app.log'), 'should not copy')
  writeFileSync(join(source, 'config.json'), JSON.stringify({
    enabled: true,
    ownerQQ: '10001',
    botQQ: '20001',
    gateway: 'snowluma',
    snowluma: { webuiPassword: 'secret-pw', httpToken: 'tok-http', wsToken: 'tok-ws', httpUrl: 'http://127.0.0.1:5099' },
    persona: { current: 'dafeiyu' },
    model: { provider: 'deepseek', model: 'deepseek-chat' },
    memory: { enabled: true },
  }))

  const beforeHashes = hashTree(source)

  // 先预检（dryRun: true），并顺带验证 source 未改、target 仍空
  const preview = await importFromQQ({ source, targetDir: target, dryRun: true })
  assert.equal(preview.mode, 'initial')
  assert.equal(preview.items, 3)
  assert.deepEqual(preview.people, ['10001', '10002'])
  assert.equal(preview.chatlogDayCount, 1)
  assert.equal(preview.vectorCount, 3)
  assert.equal(preview.hasFallbackJson, true)
  assert.equal(preview.qqPluginActive, true)
  assert.ok(preview.warnings.some((w) => w.includes('memory-json-fallback.json')))
  assert.ok(preview.warnings.some((w) => w.includes('sessions.json')))
  assert.deepEqual(readdirSync(target), [])
  assert.deepEqual(hashTree(source), beforeHashes)

  // 当旧版仍在启用着执行导入：跳过 sessions.json 并提示
  const resActive = await importFromQQ({ source, targetDir: target })
  assert.equal(resActive.dryRun, false)
  assert.equal(resActive.sessionsImported, false)
  assert.equal(existsSync(join(target, 'sessions.json')), false)
  assert.equal(existsSync(join(target, 'logs', 'app.log')), false)
  assert.deepEqual(hashTree(source), beforeHashes, '导入前后源目录哈希必须一字不差')

  // 停用旧版（qqPluginActive: false）再首次导入到全新目标，验证 sessions.json 和安全配置过滤
  const targetClean = join(sandbox, 'aurabot-clean')
  mkdirSync(targetClean, { recursive: true })
  const resClean = await importFromQQ({ source, targetDir: targetClean, qqPluginActive: false })
  assert.equal(resClean.sessionsImported, true)
  assert.equal(JSON.parse(readFileSync(join(targetClean, 'sessions.json'), 'utf8')).chats['private:10001'].sessionId, 'sess-old')
  const importedCfg = JSON.parse(readFileSync(join(targetClean, 'config.json'), 'utf8'))
  assert.equal(importedCfg.ownerQQ, '10001')
  assert.deepEqual(importedCfg.persona, { current: 'dafeiyu' })
  assert.equal('snowluma' in importedCfg, false)
  assert.equal('gateway' in importedCfg, false)
  assert.equal('botQQ' in importedCfg, false)
  assert.equal(existsSync(join(targetClean, 'personas', 'dafeiyu.md')), true)
  assert.deepEqual(readAllMemory(targetClean), readAllMemory(source))
  const importedId = createIdentity({ dataDir: join(targetClean, 'gateway'), log })
  assert.equal(importedId.lookup('qq', '10001'), '10001')
  assert.equal(importedId.lookup('qq', '10002'), '10002')
  assert.deepEqual(hashTree(source), beforeHashes)
})

test('I4-5：导入核对的每一步人为制造失败，目标目录都精确回到导入前状态', async (t) => {
  const sandbox = makeSandbox(t)
  const source = join(sandbox, 'src')
  const target = join(sandbox, 'dst')
  mkdirSync(source, { recursive: true })
  mkdirSync(target, { recursive: true })

  seedMemorySqlite(source, {
    items: [{ id: 's1', text: '源条目一', about: '10001', chatId: 'private:10001', at: 5000 }],
    profiles: { '10001': { text: '源档案', at: 5000 } },
  })
  mkdirSync(join(source, 'chatlog'), { recursive: true })
  writeFileSync(join(source, 'chatlog', '2026-11-11.jsonl'), JSON.stringify({ t: 5000, chatId: 'private:10001', who: '主人', text: '在源库里说的话' }) + '\n')

  // 目标目录提前有完整现有数据，用于验证失败后毫发无损
  seedMemorySqlite(target, {
    items: [{ id: 't1', text: '目标原条目', about: '90001', chatId: 'private:90001', at: 1000 }],
    profiles: { '90001': { text: '原档案', at: 1000 } },
  })
  const tgtId = createIdentity({ dataDir: join(target, 'gateway'), log })
  tgtId.importLegacyQQ(['90001'])
  writeFileSync(join(target, 'config.json'), JSON.stringify({ ownerQQ: '90001' }))

  const targetBeforeHashes = hashTree(target)

  for (const failStep of ['copy', 'identity', 'verify-memory', 'verify-identity', 'verify-vectors', 'verify-chatlog', 'pre-commit']) {
    await assert.rejects(
      importFromQQ({
        source,
        targetDir: target,
        hooks: {
          onStep(step) {
            if (step === failStep) throw new Error(`模拟故障@${failStep}`)
          },
        },
      }),
      new RegExp(`模拟故障@${failStep}`),
    )
    assert.deepEqual(hashTree(target), targetBeforeHashes, `步骤 ${failStep} 失败后目标目录必须毫发无损`)
  }
})

test('I4-6：重复导入合并规则 —— 新增互留、同 id 取较新修改时间、流水去重追加、导入前自动备份', async (t) => {
  const sandbox = makeSandbox(t)
  const source = join(sandbox, 'src')
  const target = join(sandbox, 'dst')
  mkdirSync(source, { recursive: true })
  mkdirSync(target, { recursive: true })

  // 源：shared-newer(源更新 at=5000), shared-older(源较旧 at=1000), only-source
  seedMemorySqlite(source, {
    items: [
      { id: 'shared-newer', text: '源改过的新文本', about: '10001', at: 5000, saidAt: 1000 },
      { id: 'shared-older', text: '源旧文本不应覆盖目标', about: '10001', at: 1000, saidAt: 1000 },
      { id: 'only-source', text: '只有源有的记忆', about: '10003', at: 3000, saidAt: 3000 },
    ],
  })
  // 目标：shared-newer(目标旧 at=2000), shared-older(目标新 at=4000), only-target
  seedMemorySqlite(target, {
    items: [
      { id: 'shared-newer', text: '目标旧文本', about: '10001', at: 2000, saidAt: 1000 },
      { id: 'shared-older', text: '目标改过的新文本', about: '10001', at: 4000, saidAt: 1000 },
      { id: 'only-target', text: '只有目标有的记忆', about: '10002', at: 2500, saidAt: 2500 },
    ],
  })
  writeFileSync(join(target, 'config.json'), JSON.stringify({ ownerQQ: '10001' }))

  mkdirSync(join(source, 'chatlog'), { recursive: true })
  mkdirSync(join(target, 'chatlog'), { recursive: true })
  const dupLine = JSON.stringify({ t: 1000, chatId: 'private:10001', who: '主人', text: '早安' })
  const tgtLine = JSON.stringify({ t: 2000, chatId: 'private:10001', who: '主人', text: '目标特有的话' })
  const srcLine = JSON.stringify({ t: 3000, chatId: 'private:10001', who: '主人', text: '源新说的话' })
  writeFileSync(join(target, 'chatlog', '2026-11-12.jsonl'), [dupLine, tgtLine].join('\n') + '\n')
  writeFileSync(join(source, 'chatlog', '2026-11-12.jsonl'), [dupLine, srcLine].join('\n') + '\n')

  const result = await importFromQQ({ source, targetDir: target })
  assert.equal(result.mode, 'merge')
  assert.ok(result.backup, '重复导入前必须自动生成备份')
  assert.ok(readdirSync(join(target, 'backups')).some((n) => n.endsWith('.zip')), 'backups/ 里应保留完整备份包')

  const merged = readAllMemory(target)
  const byId = new Map(merged.items.map((m) => [m.id, m]))
  assert.equal(byId.size, 4)
  assert.equal(byId.get('shared-newer').text, '源改过的新文本')
  assert.equal(byId.get('shared-older').text, '目标改过的新文本')
  assert.equal(byId.get('only-source').text, '只有源有的记忆')
  assert.equal(byId.get('only-target').text, '只有目标有的记忆')

  const lines = readFileSync(join(target, 'chatlog', '2026-11-12.jsonl'), 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l))
  assert.equal(lines.length, 3, '重复流水行不能重复追加')
  assert.deepEqual(lines.map((r) => r.text), ['早安', '目标特有的话', '源新说的话'])

  const idStore = createIdentity({ dataDir: join(target, 'gateway'), log })
  for (const id of ['10001', '10002', '10003']) assert.equal(idStore.lookup('qq', id), id)
})

test('I4-7：同目录升级迁移（JSON→SQLite + 身份表）先备份，失败原地回退', async (t) => {
  const dir = makeSandbox(t)
  writeFileSync(join(dir, 'memories.json'), JSON.stringify({
    items: [{ id: 'old1', text: '旧记忆', about: '70001', chatId: 'private:70001', at: 100 }],
    profiles: { '70002': { text: '老友', at: 200 } },
  }))
  const up = ensureUpgradedStorage({ root: dir, log })
  assert.equal(up.upgraded, true)
  assert.equal(up.migratedMemory, true)
  assert.ok(up.backup)
  assert.equal(existsSync(join(dir, 'memory.sqlite')), true)
  const idStore = createIdentity({ dataDir: join(dir, 'gateway'), log })
  assert.equal(idStore.lookup('qq', '70001'), '70001')
  assert.equal(idStore.lookup('qq', '70002'), '70002')
  // 幂等再跑一次不应重复迁移
  assert.equal(ensureUpgradedStorage({ root: dir, log }).upgraded, false)

  // 若升级途中抛错（如认领主人失败），两库原地回退到升级前
  const failDir = makeSandbox(t, 'aurabot-i4-upfail-')
  const rawLegacy = JSON.stringify({ items: [{ id: 'f1', text: '回退项', about: '70009', at: 100 }] })
  writeFileSync(join(failDir, 'memories.json'), rawLegacy)
  const beforeFailHashes = hashTree(failDir)
  assert.throws(
    () => ensureUpgradedStorage({
      root: failDir,
      log,
      onClaimOwner() { throw new Error('模拟认主失败') },
    }),
    /模拟认主失败/,
  )
  assert.equal(existsSync(join(failDir, 'memory.sqlite')), false, '升级失败后不得残留新库')
  assert.equal(existsSync(join(failDir, 'gateway', IDENTITY_FILE)), false, '升级失败后不得残留身份库')
  assert.equal(readFileSync(join(failDir, 'memories.json'), 'utf8'), rawLegacy)
  assert.equal(hashTree(failDir)['memories.json'], beforeFailHashes['memories.json'])
})

test('I4-9：未检查点 WAL 源库 + 本地向量导入核对全过，source 哈希零改动；ownedBy 覆盖全字段', async (t) => {
  const sandbox = makeSandbox(t)
  const source = join(sandbox, 'src-wal')
  const target = join(sandbox, 'dst-wal')
  mkdirSync(source, { recursive: true })
  mkdirSync(target, { recursive: true })

  // 先正常建表，再用不关库 + wal_autocheckpoint=0 拷贝出「含未写回 WAL」的真实快照目录
  const live = join(sandbox, 'live-src')
  mkdirSync(live, { recursive: true })
  seedMemorySqlite(live, { items: [{ id: 'base', text: '基础条目', about: '11111', at: 100 }] })
  const db = new DatabaseSync(join(live, 'memory.sqlite'))
  db.exec('PRAGMA wal_autocheckpoint=0;')
  db.prepare('INSERT INTO items (id, json) VALUES (?, ?)').run(
    'wal1',
    JSON.stringify({ id: 'wal1', text: '仅在 WAL 里的记忆', about: '22222', chatId: 'private:22222', at: 200 }),
  )
  writeFileSync(join(source, 'memory.sqlite'), readFileSync(join(live, 'memory.sqlite')))
  writeFileSync(join(source, 'memory.sqlite-wal'), readFileSync(join(live, 'memory.sqlite-wal')))
  db.close()

  const b64 = (arr) => {
    const f = Float32Array.from(arr)
    return Buffer.from(f.buffer).toString('base64')
  }
  writeFileSync(join(source, 'local-vectors.json'), JSON.stringify({
    model: 'bge-small-zh-v1.5-int8',
    dim: 2,
    items: { base: b64([1, 0]), wal1: b64([0, 1]) },
    sigs: { base: 's1', wal1: 's2' },
  }))

  const beforeHashes = hashTree(source)
  const res = await importFromQQ({ source, targetDir: target })
  assert.equal(res.items, 2)
  assert.equal(res.vectorCount, 2)
  assert.deepEqual(hashTree(source), beforeHashes, '含未写回 WAL 的源目录在导入前后哈希必须一字不差')

  const importedMem = readAllMemory(target)
  assert.deepEqual(enumeratePeopleFromState(importedMem), ['11111', '22222'])
  assert.equal(ownedByFromState(importedMem, '22222').itemCount, 1)
  assert.equal(ownedByFromState(importedMem, '22222').items[0].text, '仅在 WAL 里的记忆')
})

test('I4-8：合并人 —— 正常合并 + 定向只去重 into + 平台账号冲突保留 + 第 2/3/4 步失败整组回退 + 撤销', async (t) => {
  const dir = makeSandbox(t)
  const cfg = normalize({ ownerQQ: '10001', ownerName: '主人', memory: { enabled: true, mergeGroups: true }, model: { provider: 'p', model: 'm' } })
  const llmPrompts = []
  const fakeDsh = {
    get: () => null,
    llm: {
      async *stream({ messages }) {
        const text = messages[0].content[0].text
        llmPrompts.push(text)
        // 把目标人物名下 4 条低权重重复条目里头两条并成一条
        const ids = [...text.matchAll(/#(i\d+)/g)].map((m) => m[1])
        const reply = ids.length >= 2 ? JSON.stringify({ merges: [{ ids: ids.slice(0, 2), text: '目标爱喝拿铁' }] }) : '{"merges":[]}'
        yield { type: 'text-delta', text: reply }
        yield { type: 'finish', reason: { kind: 'completed' } }
      },
    },
  }
  const idStore = createIdentity({ dataDir: join(dir, 'gateway'), log })
  const pInto = idStore.claimOwner('qq', '10001')
  idStore.link('feishu', 'ou_into_fs', pInto, 'owner')
  const pFrom = idStore.resolve('feishu', 'ou_from_fs') // 与 into 同平台（feishu）冲突
  idStore.link('bridge', 'br_from_user', pFrom, 'manual') // 独有平台应搬到 into
  const pBystander = idStore.resolve('qq', '88888')

  const hub = createHub({ dsh: fakeDsh, getConfig: () => cfg, log, onebot: {}, stickers: {}, tts: {} })
  t.after(() => hub.dispose())
  const memory = createMemoryStore({ dsh: fakeDsh, getConfig: () => cfg, hub, log, identity: idStore })

  // 准备两边记忆：from 2 条、into 2 条（合并成 4 条触发 mergeGroups），旁观者 pBystander 4 条（绝不能被 step 5 去重扫到）
  seedMemorySqlite(dir, {
    items: [
      { id: 'i1', text: '喜欢喝冰拿铁', about: pFrom, chatId: `feishu:private:ou_from_fs`, at: 100, saidAt: 100, importance: 0.4 },
      { id: 'i2', text: '冬天去哈尔滨滑雪', about: pFrom, chatId: `feishu:private:ou_from_fs`, at: 120, saidAt: 120, importance: 0.4 },
      { id: 'i3', text: '平时喜欢喝热拿铁', about: pInto, chatId: `feishu:private:ou_from_fs`, at: 140, saidAt: 140, importance: 0.4 },
      { id: 'i4', text: '周末想打羽毛球', about: pInto, chatId: `feishu:private:ou_from_fs`, at: 160, saidAt: 160, importance: 0.4 },
      // 旁观者 4 条同聊天的：验证步骤 5 只针对 into
      { id: 'b1', text: '旁观1', about: pBystander, chatId: `qq:private:88888`, at: 100, saidAt: 100, importance: 0.3 },
      { id: 'b2', text: '旁观2', about: pBystander, chatId: `qq:private:88888`, at: 110, saidAt: 110, importance: 0.3 },
      { id: 'b3', text: '旁观3', about: pBystander, chatId: `qq:private:88888`, at: 120, saidAt: 120, importance: 0.3 },
      { id: 'b4', text: '旁观4', about: pBystander, chatId: `qq:private:88888`, at: 130, saidAt: 130, importance: 0.3 },
    ],
    profiles: {
      [pFrom]: { text: '小号印象', name: '小号', tags: ['话多'], at: 100 },
      [pInto]: { text: '本尊印象', name: '主人', tags: ['喜欢'], at: 150 },
    },
    shortTerm: {
      [pFrom]: { text: '刚才问了快递', at: Date.now(), through: Date.now() },
      [pInto]: { text: '刚才谈了方案', at: Date.now(), through: Date.now() },
    },
    insights: {
      [`qq:${pFrom}`]: [{ text: '打字很快', at: 100 }],
      [`qq:${pInto}`]: [{ text: '直截了当', at: 150 }],
    },
  })
  memory.invalidateCache()

  const preMemSnapshot = readAllMemory(dir)
  const preFromAccounts = idStore.accountsOf(pFrom)
  const preIntoAccounts = idStore.accountsOf(pInto)

  // 先预检 dryRun，不改任何库
  const preview = await mergePerson({ from: pFrom, into: pInto, dryRun: true, memory, identity: idStore, dataDir: dir })
  assert.equal(preview.conflicts.length, 1)
  assert.equal(preview.conflicts[0].account, 'ou_from_fs')
  assert.deepEqual(readAllMemory(dir), preMemSnapshot)
  assert.deepEqual(idStore.accountsOf(pFrom), preFromAccounts)

  // 第 2、3、4 步各注入一次失败，每次两个库都完整回退到合并前
  for (const step of ['step2-after', 'step3-verify', 'step4-after']) {
    await assert.rejects(
      mergePerson({
        from: pFrom,
        into: pInto,
        memory,
        identity: idStore,
        dataDir: dir,
        hooks: {
          onStep(name) {
            if (name === step) throw new Error(`故障@${step}`)
          },
        },
      }),
      new RegExp(`故障@${step}`),
    )
    assert.deepEqual(readAllMemory(dir), preMemSnapshot, `${step} 失败后记忆库应完全回到合并前`)
    assert.deepEqual(idStore.accountsOf(pFrom), preFromAccounts, `${step} 失败后 from 账号应完全回到合并前`)
    assert.deepEqual(idStore.accountsOf(pInto), preIntoAccounts, `${step} 失败后 into 账号应完全回到合并前`)
    assert.equal(memory.ownedBy(pFrom).itemCount, 2)
  }

  // 正常合并执行
  llmPrompts.length = 0
  const merged = await mergePerson({ from: pFrom, into: pInto, memory, identity: idStore, dataDir: dir })
  assert.equal(merged.movedItems, 2)
  assert.equal(merged.totalItemsAfter, 4)
  assert.equal(merged.undoWarning, MERGE_UNDO_WARNING)

  // ownedBy(from) 为空，into 接收档案+短期状态且标脏，去重只扫描了 into，不碰 bystander
  assert.equal(memory.ownedBy(pFrom).total, 0)
  const afterInto = memory.ownedBy(pInto)
  assert.equal(afterInto.itemCount, 4, '去重保留原条目并标记被并条目 invalidAt')
  assert.equal(afterInto.dirty, true, '档案和短期状态合并后应标脏待整理')
  assert.match(afterInto.profile.text, /本尊印象.*小号印象/)
  assert.match(afterInto.shortTerm.text, /方案.*快递/)
  assert.equal(afterInto.insights.length, 2)
  assert.equal(merged.dedup.merged, 1)
  assert.equal(llmPrompts.length, 1, '去重只针对 into，绝不扫描 bystander')
  assert.equal(llmPrompts[0].includes('旁观'), false)

  // 冲突保留：bridge 被搬走，feishu 两边冲突不动、不丢账号
  assert.equal(idStore.accountOn(pInto, 'bridge'), 'br_from_user')
  assert.equal(idStore.accountOn(pInto, 'feishu'), 'ou_into_fs')
  assert.equal(idStore.accountOn(pFrom, 'feishu'), 'ou_from_fs')
  assert.equal(merged.conflicts.length, 1)
  assert.equal(merged.conflicts[0].platform, 'feishu')
  assert.equal(merged.conflicts[0].account, 'ou_from_fs')

  // 撤销合并：恢复到第 1 步备份，合并后的变化全回退，明确提示会丢失合并后新产生的记忆
  const undone = undoMergePerson({ backup: merged.backup, dataDir: dir, memory })
  assert.equal(undone.ok, true)
  assert.match(undone.notice, /新产生的记忆/)
  assert.deepEqual(readAllMemory(dir), preMemSnapshot)
  assert.deepEqual(idStore.accountsOf(pFrom), preFromAccounts)
  assert.deepEqual(idStore.accountsOf(pInto), preIntoAccounts)
})
