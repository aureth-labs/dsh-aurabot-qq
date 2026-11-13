import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { loadConfig, ownerAuthorizationRevision, saveConfig } from '../src/core/config.js'

let api
const root = mkdtempSync(join(tmpdir(), 'aurabot-backup-'))
const put = (rel, text) => {
  const file = join(root, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}
const read = (rel) => readFileSync(join(root, rel), 'utf8')

before(async () => {
  process.env.AURABOT_DATA_DIR = root
  api = await import('../src/core/backup.js')
})

test('备份、暂存、启动时换上：内容一致，旧文件留底，排除项不进备份', async () => {
  put('config.json', JSON.stringify({ ownerQQ: '1', song: { root: join(root, 'songs') } }))
  put('memories.json', '记忆🤔')
  put('personas/鱼.md', '人设')
  put('stickers/a.png', Buffer.alloc(5000, 7))
  put('modules/pet/module.json', '{}')
  put('logs/a.log', 'x')
  put('sessions.json', '{}')
  put('douyin/edge-profile/Cookies', 'x')
  put('douyin/im/db', 'keep')
  put('modules-data/pet/app/node_modules/electron/a', 'x')

  const b = await api.createBackup({ version: '1.2.0-beta.1' })
  assert.equal(b.files, 7)
  assert.deepEqual(b.skipped, [])
  assert.deepEqual(api.listBackups().map((x) => x.name), [b.name])

  // 模拟换了电脑：数据目录里是别的东西
  put('memories.json', '新电脑的')
  put('config.json', '{"ownerQQ":"2"}')
  put('only-here.json', '留着')

  const r = await api.stageRestore(b.file)
  assert.equal(r.ok, true)
  assert.equal(read('memories.json'), '新电脑的', '运行中不替换')
  assert.equal(api.pendingRestore().files, 7)

  // 备份来自别的路径：配置里的旧路径要换成这台电脑的
  const pending = join(root, '.restore-pending.json')
  const oldRoot = join(tmpdir(), 'old', 'aurabot')
  const stageConfig = join(root, '.restore', 'config.json')
  writeFileSync(stageConfig, JSON.stringify({
    ownerQQ: '1', dir: join(oldRoot, 'songs'), ownerAuthorization: { owner: '1', revision: 'previous' },
  }))
  writeFileSync(pending, JSON.stringify({ ...JSON.parse(readFileSync(pending, 'utf8')), dataDir: oldRoot }))

  assert.equal(api.applyPendingRestore(123), 7)
  assert.equal(read('memories.json'), '记忆🤔')
  assert.equal(read('personas/鱼.md'), '人设')
  assert.equal(readFileSync(join(root, 'stickers/a.png')).length, 5000)
  assert.equal(JSON.parse(read('config.json')).dir, join(root, 'songs'))
  assert.equal(JSON.parse(read('config.json')).ownerAuthorization, undefined)
  assert.equal(read('only-here.json'), '留着')
  assert.equal(read('backups/pre-restore-123/memories.json'), '新电脑的', '旧文件留底')
  assert.equal(api.pendingRestore(), null)
  assert.equal(existsSync(join(root, '.restore')), false)
  assert.equal(api.applyPendingRestore(), 0, '没有待恢复时什么都不做')
})

test('坏文件和别的 zip 都拒绝，且不留待恢复', async () => {
  const bad = join(root, 'bad.zip')
  writeFileSync(bad, 'not a zip at all, sorry about that friend')
  await assert.rejects(api.stageRestore(bad), /不是有效的备份/)
  assert.equal(api.pendingRestore(), null)
})

test('恢复整机备份后，同一主人的旧模块授权代次失效', async (t) => {
  isolatedBackup(t)
  const cfg = saveConfig({ ownerQQ: '10000001' })
  const revision = ownerAuthorizationRevision(cfg)
  assert.ok(revision)
  saveConfig({ ...cfg, ext: { 'life-advance': { weatherOwnerRevision: revision, newsOwnerRevision: revision } } }, cfg)
  const backup = await api.createBackup()
  await api.stageRestore(backup.file)
  api.applyPendingRestore(124)

  const restored = loadConfig()
  assert.equal(restored.ownerQQ, cfg.ownerQQ)
  assert.equal(ownerAuthorizationRevision(restored), '')
  const renewed = ownerAuthorizationRevision(saveConfig(restored, restored))
  assert.ok(renewed)
  assert.notEqual(restored.ext['life-advance'].weatherOwnerRevision, renewed)
  assert.notEqual(restored.ext['life-advance'].newsOwnerRevision, renewed)
})

test('内容被改动过的备份过不了校验', async () => {
  const b = await api.createBackup({ version: 'x', now: new Date(Date.now() + 60000) })
  const buf = readFileSync(b.file)
  const at = buf.indexOf(Buffer.from('data/config.json')) + 16
  buf[at + 2] ^= 0xff
  const broken = join(root, 'broken.zip')
  writeFileSync(broken, buf)
  await assert.rejects(api.stageRestore(broken))
  assert.equal(api.pendingRestore(), null)
})

test('取消恢复清掉暂存', async () => {
  const b = api.listBackups()[0]
  await api.stageRestore(join(root, 'backups', b.name))
  assert.ok(api.pendingRestore())
  api.cancelRestore()
  assert.equal(api.pendingRestore(), null)
  assert.ok(readdirSync(root).every((n) => n !== '.restore'))
})

test('会话目录名和 DSH 的规则一致', () => {
  assert.equal(api.sessionDirName('C:\\Aurabot\\qq-chats'), '--C-Aurabot-qq-chats--')
  assert.equal(api.sessionDirName('C:\\Users\\17018\\.dsh\\profiles\\desktop'), '--C-Users-17018-.dsh-profiles-desktop--')
  assert.equal(api.sessionDirName('D:\\dsh插件开发'), '--D-dsh~63D2~4EF6~5F00~53D1--')
  assert.equal(api.sessionDirName('D:\\knorvia studio开发'), '--D-knorvia~0020studio~5F00~53D1--')
})

test('市场模块只记名字，会话带上并放回工作区目录，已有的不覆盖', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aurabot-home-'))
  process.env.DSH_HOME = home
  const ws = join(home, 'qq-chats')
  const sess = join(home, 'sessions', api.sessionDirName(ws))
  mkdirSync(join(sess, 'session-a'), { recursive: true })
  mkdirSync(join(sess, 'session-b'), { recursive: true })
  writeFileSync(join(sess, 'session-a', 'session.v4.jsonl.zstd'), 'A')
  writeFileSync(join(sess, 'session-b', 'session.v4.jsonl.zstd'), 'B')
  put('modules/heybox/.aurabot-source.json', '{}')
  put('modules/heybox/index.mjs', 'x')
  put('modules/mine/index.mjs', 'mine')

  const b = await api.createBackup({ version: 'x', workspaceDir: ws, now: new Date(Date.now() + 120000) })
  assert.deepEqual(b.market, ['heybox'])
  assert.equal(b.sessions, 2)

  // 新电脑：市场模块没装，自己写的模块被清空，有一个同名会话
  rmSync(join(root, 'modules'), { recursive: true, force: true })
  rmSync(join(sess, 'session-a'), { recursive: true, force: true })
  writeFileSync(join(sess, 'session-b', 'session.v4.jsonl.zstd'), '这台电脑的')
  const r = await api.stageRestore(b.file)
  assert.deepEqual(r.market, ['heybox'])
  api.applyPendingRestore(456)

  assert.equal(read('modules/mine/index.mjs'), 'mine')
  assert.equal(existsSync(join(root, 'modules/heybox')), false, '市场模块不打包')
  assert.deepEqual(api.pendingModules(), ['heybox'])
  assert.equal(readFileSync(join(sess, 'session-a', 'session.v4.jsonl.zstd'), 'utf8'), 'A')
  assert.equal(readFileSync(join(sess, 'session-b', 'session.v4.jsonl.zstd'), 'utf8'), '这台电脑的')
  assert.equal(JSON.parse(read('config.json')).workspaceDir, ws)
  api.setPendingModules([])
  assert.deepEqual(api.pendingModules(), [])
  delete process.env.DSH_HOME
})

test('仅配置备份：只带配置/人格，排除画作、表情、截图、聊天流水', async () => {
  const prev = process.env.AURABOT_DATA_DIR
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-config-only-'))
  try {
    process.env.AURABOT_DATA_DIR = dir
    const w = (rel, text) => { const f = join(dir, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text) }
    w('config.json', '{"ownerQQ":"1"}')
    w('personas/鱼.md', '人设')
    w('imagegen/a.png', 'p')
    w('stickers/a.png', 'p')
    w('bili-shots/a.jpg', 'p')
    w('chatlog/2026-11-07.jsonl', 'p')
    const b = await api.createBackup({ version: 'x', configOnly: true })
    assert.match(b.name, /^aurabot-config-\d{8}-\d{4}\.zip$/)
    assert.equal(b.configOnly, true)
    assert.equal(b.files, 3, '只打包 config、人格和轻量聊天流水')
  } finally {
    process.env.AURABOT_DATA_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test('整机和配置备份仅排除已知的生活推进旧暂存，保留正式状态及备份', async () => {
  const previous = process.env.AURABOT_DATA_DIR
  const base = realpathSync(tmpdir())
  const dir = mkdtempSync(join(base, 'aurabot-life-backup-'))
  process.env.AURABOT_DATA_DIR = dir
  const id = 'ffffffff-ffff-4fff-bfff-ffffffffffff'
  const old = 'modules-data/life-advance/state-v2.json'
  const oldBackup = old + '.before-restore.1700000000000-' + id + '.bak'
  const stage = 'life-advance.state-v2.stage.' + id + '.' + 'a'.repeat(64) + '.' + 'b'.repeat(64)
  const excluded = [
    old + '.tmp-' + id,
    oldBackup + '.tmp-' + id,
    old + '.before-restore.seq-1-' + id + '.bak.tmp-' + id,
    stage,
    'life-advance.state-v2.aborted',
    'life-advance.state-v2.aborted.tmp',
    'life-advance.state-v2.import.tmp',
  ]
  const kept = [
    'config.json',
    'life-advance.state-v2.json',
    old,
    oldBackup,
    'life-advance.state-v2.before-restore.seq-2-' + id + '.bak',
    'life-advance.state-v2.before-restore.seq-3-' + id + '.pending-' + 'a'.repeat(64),
    'modules-data/other/state-v2.json.tmp-' + id,
    old + '.tmp-not-a-uuid',
  ]
  try {
    for (const rel of [...excluded, ...kept]) {
      const file = join(dir, rel)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, rel)
    }
    for (const configOnly of [false, true]) {
      const archive = await api.createBackup({ configOnly })
      assert.equal(archive.files, kept.length)
      assert.equal((await api.stageRestore(archive.file)).ok, true)
      for (const rel of excluded) assert.equal(existsSync(join(dir, '.restore', rel)), false, rel)
      for (const rel of kept) assert.equal(readFileSync(join(dir, '.restore', rel), 'utf8'), rel)
    }
  } finally {
    process.env.AURABOT_DATA_DIR = previous
    const resolved = realpathSync(dir)
    if (dirname(resolved) === base) rmSync(resolved, { recursive: true, force: true })
  }
})

function isolatedBackup(t) {
  const previous = process.env.AURABOT_DATA_DIR
  const base = realpathSync(tmpdir())
  const sandbox = mkdtempSync(join(base, 'aurabot-backup-paths-'))
  const dir = join(sandbox, 'data')
  mkdirSync(dir)
  process.env.AURABOT_DATA_DIR = dir
  t.after(() => {
    process.env.AURABOT_DATA_DIR = previous
    const resolved = realpathSync(sandbox)
    if (dirname(resolved) === base) rmSync(resolved, { recursive: true, force: true })
  })
  const write = (rel, value) => {
    const path = join(dir, rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, value)
  }
  write('config.json', '{"ownerQQ":"1"}')
  return { dir, sandbox, write }
}

test('LA-17 恢复前预检整批目标及留底路径，拒绝目录链接并保留暂存供重试', async (t) => {
  const { dir, sandbox, write } = isolatedBackup(t)
  const rel = 'modules-data/life-advance/state-v2.json'
  const parent = dirname(join(dir, rel))
  const outside = join(sandbox, 'fixture')
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  mkdirSync(outside)
  writeFileSync(join(outside, 'sentinel'), '保留')
  write(rel, '归档状态')
  const archive = await api.createBackup()
  write('config.json', '{"ownerQQ":"2"}')
  write(rel, '当前状态')
  await api.stageRestore(archive.file)
  const saved = join(sandbox, 'saved')
  renameSync(parent, saved)
  symlinkSync(outside, parent, linkType)
  try {
    assert.throws(() => api.applyPendingRestore(789), /不安全或已变化的备份路径/)
    assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), '{"ownerQQ":"2"}')
    assert.equal(readFileSync(join(saved, 'state-v2.json'), 'utf8'), '当前状态')
    assert.deepEqual(readdirSync(outside), ['sentinel'])
    assert.ok(api.pendingRestore())
  } finally {
    unlinkSync(parent)
    renameSync(saved, parent)
  }
  const keep = join(dir, 'backups', 'pre-restore-789')
  symlinkSync(outside, keep, linkType)
  try {
    assert.throws(() => api.applyPendingRestore(789), /不安全或已变化的备份路径/)
    assert.equal(readFileSync(join(dir, rel), 'utf8'), '当前状态')
    assert.deepEqual(readdirSync(outside), ['sentinel'])
  } finally { unlinkSync(keep) }
  assert.equal(api.applyPendingRestore(789), 2)
  assert.equal(readFileSync(join(dir, rel), 'utf8'), '归档状态')
  assert.equal(readFileSync(join(keep, rel), 'utf8'), '当前状态')
})

test('LA-18 导出跳过枚举后身份改变的普通文件，并保留其余归档条目', async (t) => {
  const { dir, sandbox, write } = isolatedBackup(t)
  const rel = 'modules-data/life-advance/state-v2.json'
  write(rel, '原文件')
  const archive = await api.createBackup({
    onProgress({ done }) {
      if (done !== 1) return
      renameSync(join(dir, rel), join(sandbox, 'saved'))
      write(rel, '另一个文件')
    },
  })
  assert.deepEqual(archive.skipped, [rel])
  assert.equal(archive.files, 1)
  await api.stageRestore(archive.file)
  assert.equal(existsSync(join(dir, '.restore', rel)), false)
  assert.equal(readFileSync(join(dir, '.restore', 'config.json'), 'utf8'), '{"ownerQQ":"1"}')
  assert.equal(readFileSync(join(dir, rel), 'utf8'), '另一个文件')
})

test('恢复中途移动失败时回退已完成的移动，保留原文件和归档暂存', async (t) => {
  const { dir, write } = isolatedBackup(t)
  write('state.json', '归档状态')
  const archive = await api.createBackup()
  await api.stageRestore(archive.file)
  write('config.json', '{"ownerQQ":"2"}')
  write('state.json', '当前状态')
  const rename = fs.renameSync
  const from = join(dir, '.restore', 'state.json')
  const to = join(dir, 'state.json')
  const fault = t.mock.method(fs, 'renameSync', (source, destination) => {
    if (source === from && destination === to) throw Object.assign(new Error('模拟写入拒绝'), { code: 'EACCES' })
    return rename(source, destination)
  })
  syncBuiltinESMExports()
  try {
    assert.throws(() => api.applyPendingRestore(456), /模拟写入拒绝/)
  } finally {
    fault.mock.restore()
    syncBuiltinESMExports()
  }
  assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), '{"ownerQQ":"2"}')
  assert.equal(readFileSync(to, 'utf8'), '当前状态')
  assert.equal(readFileSync(from, 'utf8'), '归档状态')
  assert.ok(api.pendingRestore())
  assert.equal(api.applyPendingRestore(456), 2)
  assert.equal(readFileSync(to, 'utf8'), '归档状态')
})

test('LA-19 上传和命名下载拒绝链接，正常归档仍可缓存和暂存', async (t) => {
  const { dir, sandbox } = isolatedBackup(t)
  const archive = await api.createBackup()
  const bytes = readFileSync(archive.file)
  const backups = join(dir, 'backups')
  const saved = join(sandbox, 'saved-backups')
  const fixture = join(sandbox, 'fixture')
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  mkdirSync(fixture)
  writeFileSync(join(fixture, 'sentinel'), '原内容')
  renameSync(backups, saved)
  symlinkSync(fixture, backups, linkType)
  try {
    for (const name of [undefined, archive.name]) {
      await assert.rejects(api.stageReceivedBackup(bytes, name), /不安全或已变化的备份路径/)
    }
    assert.deepEqual(readdirSync(fixture), ['sentinel'])
    assert.equal(readFileSync(join(fixture, 'sentinel'), 'utf8'), '原内容')
    assert.equal(api.pendingRestore(), null)
  } finally {
    unlinkSync(backups)
    renameSync(saved, backups)
  }
  const incoming = join(backups, 'incoming.zip')
  const sentinel = join(fixture, 'sentinel')
  symlinkSync(process.platform === 'win32' ? fixture : sentinel, incoming, linkType === 'junction' ? linkType : 'file')
  try {
    await assert.rejects(api.stageReceivedBackup(bytes), /不安全或已变化的备份路径/)
    assert.equal(readFileSync(sentinel, 'utf8'), '原内容')
  } finally { unlinkSync(incoming) }
  assert.equal((await api.stageReceivedBackup(bytes)).ok, true)
  assert.deepEqual(readFileSync(incoming), bytes)
  assert.equal((await api.stageReceivedBackup(bytes, archive.name)).ok, true)
  assert.deepEqual(readFileSync(archive.file), bytes)
  assert.equal(api.pendingRestore().files, 1)
})

test('LA-20 截断归档保留上次暂存，完整的存储条目可分块恢复', async (t) => {
  const { dir, write } = isolatedBackup(t)
  const media = Buffer.alloc(2 * 1024 ** 2 + 17, 0x42)
  write('stickers/example.png', media)
  const archive = await api.createBackup()
  assert.equal((await api.stageRestore(archive.file)).ok, true)
  const pending = api.pendingRestore()
  const broken = join(dir, 'partial-download.zip')
  writeFileSync(broken, readFileSync(archive.file).subarray(0, -8))
  await assert.rejects(api.stageRestore(broken), /不是有效的备份文件/)
  assert.deepEqual(api.pendingRestore(), pending)
  assert.deepEqual(readFileSync(join(dir, '.restore', 'stickers', 'example.png')), media)
  assert.equal(api.applyPendingRestore(457), 2)
  assert.deepEqual(readFileSync(join(dir, 'stickers', 'example.png')), media)
})

test('LA-21 提交标记移动失败时回退配置、模块登记和数据，再次恢复可提交', async (t) => {
  const { dir, sandbox, write } = isolatedBackup(t)
  const oldDir = join(sandbox, 'previous-data-location')
  const config = JSON.stringify({ ownerQQ: '1', media: join(oldDir, 'media') })
  const currentConfig = '{"ownerQQ":"2"}'
  write('config.json', config)
  write('state.json', '归档状态')
  write('modules/sample/.aurabot-source.json', '{}')
  const archive = await api.createBackup()
  await api.stageRestore(archive.file)
  const pending = { ...api.pendingRestore(), dataDir: oldDir }
  write('.restore-pending.json', JSON.stringify(pending))
  write('.restore-modules.json', '["previous"]')
  write('config.json', currentConfig)
  write('state.json', '当前状态')
  const rename = fs.renameSync
  const fault = t.mock.method(fs, 'renameSync', (source, destination) => {
    if (source === join(dir, '.restore-pending.json') && destination.endsWith('committed.json')) {
      throw Object.assign(new Error('模拟提交拒绝'), { code: 'EACCES' })
    }
    return rename(source, destination)
  })
  syncBuiltinESMExports()
  try {
    assert.throws(() => api.applyPendingRestore(458), /模拟提交拒绝/)
  } finally {
    fault.mock.restore()
    syncBuiltinESMExports()
  }
  assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), currentConfig)
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), '当前状态')
  assert.equal(readFileSync(join(dir, '.restore', 'config.json'), 'utf8'), config)
  assert.deepEqual(api.pendingModules(), ['previous'])
  assert.deepEqual(api.pendingRestore(), pending)
  assert.equal(api.applyPendingRestore(458), 2)
  assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).media, join(dir, 'media'))
  assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), '归档状态')
  assert.deepEqual(api.pendingModules(), ['sample'])
  assert.equal(api.pendingRestore(), null)
})
