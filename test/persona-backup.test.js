// 非根目录人格的记忆库（persona-data/<id>/）和根目录一样：锁内取快照备份，恢复时整组替换。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStorage } from '../src/features/memory-store.js'
import { createBackup, stageRestore, applyPendingRestore } from '../src/core/backup.js'

let Database
try { ({ DatabaseSync: Database } = await import('node:sqlite')) } catch {}
const log = { info() {}, warn() {}, debug() {} }

test('persona-data 里的记忆库按 WAL 快照备份，SHM 不进包，恢复后内容完整', { skip: !Database }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-persona-backup-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = root
  t.after(() => {
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    rmSync(root, { recursive: true, force: true })
  })
  writeFileSync(join(root, 'config.json'), '{}')
  const dir = join(root, 'persona-data', 'xiaoxing')
  mkdirSync(dir, { recursive: true })
  const expected = { items: [{ id: 's1', text: '小星记得主人喜欢草莓', at: 1 }] }
  const store = createMemoryStorage({ directory: dir, log })
  t.after(() => store.close())
  store.save({ items: [{ id: 's1', text: '旧的', at: 1 }] })
  // 留着连接并关掉自动 checkpoint：新内容只在 WAL 里，逐个文件拷贝会拿到不一致的库
  const db = new Database(join(dir, 'memory.sqlite'))
  let closed = false
  t.after(() => { if (!closed) db.close() })
  db.exec('PRAGMA wal_autocheckpoint = 0')
  db.prepare('UPDATE items SET json = ? WHERE id = ?').run(JSON.stringify(expected.items[0]), 's1')
  assert.ok(existsSync(join(dir, 'memory.sqlite-wal')))

  const backup = await createBackup()
  assert.deepEqual(backup.skipped, [])
  await stageRestore(backup.file)
  const staged = join(root, '.restore', 'persona-data', 'xiaoxing')
  assert.ok(existsSync(join(staged, 'memory.sqlite')))
  assert.ok(existsSync(join(staged, 'memory.sqlite-wal')))
  assert.equal(existsSync(join(staged, 'memory.sqlite-shm')), false)

  db.close(); closed = true
  store.close()
  applyPendingRestore(995)
  const restored = createMemoryStorage({ directory: dir, log })
  t.after(() => restored.close())
  assert.deepEqual(restored.load().items, expected.items)
  assert.ok(existsSync(join(root, 'backups', 'pre-restore-995', 'persona-data', 'xiaoxing', 'memory.sqlite')), '恢复前的库留底')
})
