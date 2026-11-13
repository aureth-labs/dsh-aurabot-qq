// I1 身份库的存储层：网关数据目录下的 identity.sqlite。
// 来源：Aurabot多平台实施拆分/包-I1-身份库.md 第 1 条（建表 SQL 以任务书为准）。
// 契约：src/gateway/contracts.d.ts §2（PersonId / Account / Identity）、docs/CONTRACTS.md §四。
// 写法范式照抄 src/features/memory-store.js：node:sqlite、WAL、句柄不跨操作持有、
// user_version 管版本、库版本比代码新时拒绝打开并保留原库、坏库报清楚的错且不新建空库盖原文件。
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

let DatabaseSync
let sqliteError
try { ({ DatabaseSync } = await import('node:sqlite')) } catch (error) { sqliteError = error }

// 库结构版本。改表结构时在这里 +1，并在 initialize 里补迁移分支。
export const IDENTITY_SCHEMA = 1
// 库文件名与伴随文件。I4 把这组名字加进备份组时直接引用 IDENTITY_FILES。
export const IDENTITY_FILE = 'identity.sqlite'
export const IDENTITY_FILES = [IDENTITY_FILE, `${IDENTITY_FILE}-wal`, `${IDENTITY_FILE}-shm`]

// 任务书给定的建表 SQL。meta 存主人（key='owner'）和待兑换口令（key='code:<口令>'）。
const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS identities (
      platform   TEXT NOT NULL,
      account    TEXT NOT NULL,
      person_id  TEXT NOT NULL,
      alt        TEXT,
      linked_at  INTEGER NOT NULL,
      linked_by  TEXT NOT NULL,
      PRIMARY KEY (platform, account)
    );
    CREATE INDEX IF NOT EXISTS identities_person ON identities(person_id);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, json TEXT NOT NULL);
  `

/**
 * 打开身份库，返回 { transact, file }。
 * transact(fn)：开库 → 传给 fn(db) → 关库。句柄只在一次操作里活着，不跨操作持有
 * （避免插件重载、Windows 搬目录时占着文件）。fn 里自己用事务保证原子性。
 * 打开时的保证：
 *  - 库文件已存在且损坏 → 抛「身份库损坏」的错，绝不新建空库盖掉原文件；
 *  - 库的 user_version 比代码新 → 抛「版本比代码新」的错，保留原库；
 *  - 新文件 / 旧版本 → 按 SCHEMA_SQL 建表并把 user_version 升到 IDENTITY_SCHEMA。
 */
export function openIdentityStore({ dataDir, log = console } = {}) {
  if (!DatabaseSync) {
    throw new Error(`身份库需要 node:sqlite，当前运行环境不可用：${sqliteError?.message || '导入失败'}`)
  }
  if (!dataDir || typeof dataDir !== 'string') throw new Error('身份库缺少数据目录 dataDir')
  const file = join(dataDir, IDENTITY_FILE)

  function initialize(db) {
    db.exec('PRAGMA busy_timeout = 1000')
    const version = db.prepare('PRAGMA user_version').get().user_version
    if (version > IDENTITY_SCHEMA) {
      // 代码比库旧（比如回滚到老版本插件）：拒绝打开，保留原库等新版本来处理。
      throw new Error(`身份库版本 ${version} 比代码新（当前代码要求 ≤ ${IDENTITY_SCHEMA}），已保留原库拒绝打开：${file}`)
    }
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL')
    if (version === IDENTITY_SCHEMA) return
    db.exec(`BEGIN IMMEDIATE;${SCHEMA_SQL}PRAGMA user_version = ${IDENTITY_SCHEMA};COMMIT;`)
  }

  function transact(fn) {
    // 先确保目录在；mkdir 对已存在的目录是安全的。
    mkdirSync(dataDir, { recursive: true })
    const existed = existsSync(file)
    // 只对「打开/初始化阶段」的失败做坏库包装；fn 里的业务错误（如 IdentityConflict）必须原样抛出。
    let db
    try {
      db = new DatabaseSync(file)
      initialize(db)
    } catch (error) {
      try { db?.close() } catch { /* 尽力关掉 */ }
      if (existed && !(error instanceof Error && error.message.includes('身份库版本'))) {
        // 只对「已存在的文件」报损坏：全新文件打不开是别的问题（权限、磁盘），照原样抛。
        throw new Error(`身份库损坏，无法打开 ${file}：${error.message}。原文件已保留未改动，请先备份该文件再处理`)
      }
      throw error
    }
    try {
      return fn(db)
    } finally {
      try { db.close() } catch { /* 关不掉就算了，别掩盖真正的错误 */ }
    }
  }

  return { transact, file }
}
