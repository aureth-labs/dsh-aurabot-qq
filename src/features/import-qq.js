// Aurabot 跨版导入与就地升级迁移（I4）：
//   1. importFromQQ({ source, dryRun }) —— 从旧版数据目录只读导入记忆、流水、向量、人物人设与安全配置，
//      并在隔离暂存区完成 4 项硬核对后再切换，任一步失败即清理暂存回退。
//   2. ensureUpgradedStorage({ root }) —— 同目录升级前的成组自动备份 + 结构迁移 + 身份补录。
// 注意：本模块处于中枢层（src/features/），不直接提及任何具体平台名词。

import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import {
  existsSync, mkdirSync, mkdtempSync,
  readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { dataDir, readJson, writeJson } from '../core/store.js'
import { isLegacyQQEnabled, pickPlatformNeutralConfig } from '../core/config.js'
import { createBackup, createPairedBackup, restorePairedBackup } from '../core/backup.js'
import { normalizeChatId } from '../gateway/address.js'
import { createIdentity } from '../gateway/identity.js'
import { IDENTITY_FILES } from '../gateway/identity-store.js'
import { enumeratePeopleFromState } from './memory.js'
import {
  createMemoryStorage, initializeMemoryDb, MEMORY_FILES,
  MEMORY_TABLES, readMemoryDatabase, rowsOfMemoryState,
} from './memory-store.js'

function copyBytesIfExists(src, dst) {
  if (!existsSync(src)) return false
  mkdirSync(dirname(dst), { recursive: true })
  writeFileSync(dst, readFileSync(src))
  return true
}

function listJsonlDays(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .map((name) => name.slice(0, 10))
    .sort()
}

function readChatlogEntries(dir, day) {
  const file = join(dir, `${day}.jsonl`)
  if (!existsSync(file)) return []
  const raw = readFileSync(file, 'utf8')
  const rows = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      rows.push({ raw: trimmed, row: JSON.parse(trimmed) })
    } catch {
      rows.push({ raw: trimmed, row: null })
    }
  }
  return rows
}

function chatlogRowKey(entry) {
  const row = entry?.row
  if (!row || typeof row !== 'object') return `raw:${entry?.raw || ''}`
  const chatId = normalizeChatId(row.chatId) || String(row.chatId || '')
  return [Number(row.t) || 0, chatId, String(row.who || ''), String(row.text || '')].join('\u0000')
}

function decodeBase64Vec(s) {
  if (typeof s !== 'string' || !s) return []
  const buf = Buffer.from(s, 'base64')
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)))
}

function encodeBase64Vec(vec) {
  const f32 = Float32Array.from(vec)
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64')
}

function cosineTopK(queryVec, vectorsMap, limit = 5, allowIds = null) {
  const normOf = (v) => Math.sqrt(v.reduce((sum, x) => sum + x * x, 0))
  const qNorm = normOf(queryVec)
  if (!qNorm) return []
  const hits = []
  for (const [id, vec] of vectorsMap) {
    if (allowIds && !allowIds.has(id)) continue
    if (!Array.isArray(vec) || vec.length !== queryVec.length) continue
    let dot = 0
    for (let i = 0; i < queryVec.length; i++) dot += queryVec[i] * vec[i]
    const vNorm = normOf(vec)
    if (!vNorm) continue
    const sim = dot / (qNorm * vNorm)
    if (Number.isFinite(sim)) hits.push({ id, sim })
  }
  return hits.sort((a, b) => b.sim - a.sim || a.id.localeCompare(b.id)).slice(0, limit)
}

function readVectorsFromDir(dir) {
  const remoteFile = join(dir, 'memory-vectors.json')
  const remoteMetaFile = join(dir, 'memory-vectors-meta.json')
  const localFile = join(dir, 'local-vectors.json')
  const remoteData = existsSync(remoteFile) ? readJson(remoteFile, null) : null
  const remoteMeta = existsSync(remoteMetaFile) ? readJson(remoteMetaFile, null) : null
  const localData = existsSync(localFile) ? readJson(localFile, null) : null

  const remoteMap = new Map()
  if (remoteData?.items && typeof remoteData.items === 'object') {
    for (const [id, vec] of Object.entries(remoteData.items)) {
      if (Array.isArray(vec) && vec.length) remoteMap.set(id, vec)
    }
  }

  const localMap = new Map()
  if (localData?.items && typeof localData.items === 'object') {
    for (const [id, b64] of Object.entries(localData.items)) {
      const vec = decodeBase64Vec(b64)
      if (vec.length) localMap.set(id, vec)
    }
  }

  return {
    remoteData,
    remoteMeta,
    localData,
    remoteMap,
    localMap,
    count: remoteMap.size + localMap.size,
  }
}

/**
 * 严格只读读取源目录或目标目录里的记忆库快照：
 * 绝不以可写方式打开源 SQLite，先把原始字节复制到临时目录后再回放 WAL 读表，保证源目录一字不改。
 */
function readMemorySnapshotReadOnly(root) {
  const sqliteFile = join(root, 'memory.sqlite')
  const jsonFile = join(root, 'memories.json')
  const hasFallbackJson = existsSync(join(root, 'memory-json-fallback.json'))

  if (existsSync(sqliteFile)) {
    const probe = mkdtempSync(join(tmpdir(), 'aurabot-mem-ro-'))
    try {
      copyBytesIfExists(sqliteFile, join(probe, 'memory.sqlite'))
      copyBytesIfExists(join(root, 'memory.sqlite-wal'), join(probe, 'memory.sqlite-wal'))
      const db = new DatabaseSync(join(probe, 'memory.sqlite'))
      try {
        const schema = db.prepare('PRAGMA user_version').get()?.user_version ?? null
        const tables = {}
        for (const table of MEMORY_TABLES) {
          tables[table] = db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count
        }
        const state = readMemoryDatabase(db)
        return { backend: 'sqlite', schema, tables, state, hasFallbackJson }
      } finally {
        try { db.close() } catch {}
      }
    } finally {
      rmSync(probe, { recursive: true, force: true })
    }
  }

  if (existsSync(jsonFile)) {
    const raw = JSON.parse(readFileSync(jsonFile, 'utf8'))
    const state = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { items: [] }
    const rows = rowsOfMemoryState(state)
    const tables = Object.fromEntries(MEMORY_TABLES.map((t) => [t, rows[t].size]))
    return { backend: 'json', schema: null, tables, state, hasFallbackJson }
  }

  return null
}

function itemModifiedAt(item) {
  return Math.max(Number(item?.at) || 0, Number(item?.mergedAt) || 0, Number(item?.saidAt) || 0)
}

function mergeByIdWithTime(targetList = [], sourceList = [], timeOf) {
  const order = []
  const byId = new Map()
  for (const item of targetList) {
    if (!item?.id) continue
    byId.set(item.id, structuredClone(item))
    order.push(item.id)
  }
  for (const item of sourceList) {
    if (!item?.id) continue
    const prev = byId.get(item.id)
    if (!prev) {
      byId.set(item.id, structuredClone(item))
      order.push(item.id)
      continue
    }
    if (!isDeepStrictEqual(prev, item) && timeOf(item) > timeOf(prev)) {
      byId.set(item.id, structuredClone(item))
    }
  }
  return order.map((id) => byId.get(id))
}

function mergeStringMapArrays(target = {}, source = {}, keyOf, cap = 0) {
  const out = structuredClone(target || {})
  for (const [k, list] of Object.entries(source || {})) {
    const existing = Array.isArray(out[k]) ? out[k] : []
    const seen = new Set(existing.map((x) => String(keyOf(x) || '')))
    const combined = [...existing]
    for (const entry of Array.isArray(list) ? list : []) {
      const id = String(keyOf(entry) || '')
      if (!id || seen.has(id)) continue
      seen.add(id)
      combined.push(structuredClone(entry))
      if (cap && combined.length >= cap) break
    }
    out[k] = combined
  }
  return out
}

/** 按 I4 规则把源记忆状态合并进目标记忆状态：按 id 补缺/新修改覆盖，保留目标独有条目。 */
function mergeMemoryStates(targetState, sourceState) {
  const out = structuredClone(targetState || { items: [] })
  out.items = mergeByIdWithTime(targetState?.items || [], sourceState?.items || [], itemModifiedAt)
  if ((targetState?.gists || []).length || (sourceState?.gists || []).length) {
    out.gists = mergeByIdWithTime(targetState?.gists || [], sourceState?.gists || [], itemModifiedAt)
  }

  out.profiles = structuredClone(targetState?.profiles || {})
  for (const [id, srcP] of Object.entries(sourceState?.profiles || {})) {
    const tgtP = out.profiles[id]
    if (!tgtP || (Number(srcP?.at) || 0) > (Number(tgtP?.at) || 0)) {
      const base = tgtP ? { ...tgtP, ...srcP } : structuredClone(srcP)
      if (tgtP?.tags || srcP?.tags) base.tags = [...new Set([...(tgtP?.tags || []), ...(srcP?.tags || [])])].slice(0, 8)
      out.profiles[id] = base
    }
  }

  out.shortTerm = structuredClone(targetState?.shortTerm || {})
  for (const [id, srcS] of Object.entries(sourceState?.shortTerm || {})) {
    const tgtS = out.shortTerm[id]
    if (!tgtS || Math.max(Number(srcS?.at) || 0, Number(srcS?.through) || 0) > Math.max(Number(tgtS?.at) || 0, Number(tgtS?.through) || 0)) {
      out.shortTerm[id] = structuredClone(srcS)
    }
  }

  if (targetState?.dirtyProfiles || sourceState?.dirtyProfiles) {
    out.dirtyProfiles = { ...(sourceState?.dirtyProfiles || {}), ...(targetState?.dirtyProfiles || {}) }
  }

  if (targetState?.insights || sourceState?.insights) {
    out.insights = mergeStringMapArrays(targetState?.insights, sourceState?.insights, (x) => typeof x === 'string' ? x : x?.text, 8)
  }
  if (targetState?.insightNames || sourceState?.insightNames) {
    out.insightNames = { ...(sourceState?.insightNames || {}), ...(targetState?.insightNames || {}) }
  }
  if (targetState?.styles || sourceState?.styles) {
    out.styles = mergeStringMapArrays(targetState?.styles, sourceState?.styles, (x) => x, 6)
  }
  if ((targetState?.relations || []).length || (sourceState?.relations || []).length) {
    out.relations = mergeByIdWithTime(targetState?.relations || [], sourceState?.relations || [], (r) => Number(r?.at) || 0)
  }
  if (targetState?.chats || sourceState?.chats) {
    out.chats = structuredClone(targetState?.chats || {})
    for (const [cid, sc] of Object.entries(sourceState?.chats || {})) {
      if (!out.chats[cid] || (Number(sc?.updatedAt) || 0) > (Number(out.chats[cid]?.updatedAt) || 0)) {
        out.chats[cid] = structuredClone(sc)
      }
    }
  }
  if (targetState?.reflectedAt || sourceState?.reflectedAt) {
    out.reflectedAt = { ...(sourceState?.reflectedAt || {}), ...(targetState?.reflectedAt || {}) }
    for (const [k, v] of Object.entries(targetState?.reflectedAt || {})) {
      if (Number(sourceState?.reflectedAt?.[k] || 0) > Number(v || 0)) out.reflectedAt[k] = sourceState.reflectedAt[k]
    }
  }
  if (targetState?.processed || sourceState?.processed) {
    out.processed = { ...(sourceState?.processed || {}), ...(targetState?.processed || {}) }
  }

  out.rev = Math.max(Number(targetState?.rev) || 0, Number(sourceState?.rev) || 0) + 1
  return out
}

function writeStateToSqlite(sqlitePath, state) {
  mkdirSync(dirname(sqlitePath), { recursive: true })
  const db = new DatabaseSync(sqlitePath)
  try {
    initializeMemoryDb(db)
    const rows = rowsOfMemoryState(state)
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const table of MEMORY_TABLES) {
        const key = table === 'kv' || table === 'meta' ? 'key' : 'id'
        db.exec(`DELETE FROM ${table}`)
        const stmt = db.prepare(`INSERT INTO ${table} (${key}, json) VALUES (?, ?)`)
        for (const [id, row] of rows[table]) stmt.run(id, row.json)
      }
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch {}
      throw error
    }
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    if (checkpoint.busy) throw new Error('暂存记忆库整理检查点被占用')
  } finally {
    try { db.close() } catch {}
  }
}

function copyTree(src, dst) {
  if (!existsSync(src)) return
  mkdirSync(dst, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const s = join(src, entry.name)
    const d = join(dst, entry.name)
    if (entry.isDirectory()) copyTree(s, d)
    else if (entry.isFile()) writeFileSync(d, readFileSync(s))
  }
}

function stageMergedVectors(sourceVec, targetVec, staging) {
  if (sourceVec.remoteData) {
    const base = targetVec.remoteData ? structuredClone(targetVec.remoteData) : { model: sourceVec.remoteData.model || '', dims: sourceVec.remoteData.dims || 0, items: {} }
    const baseMeta = targetVec.remoteMeta ? structuredClone(targetVec.remoteMeta) : { model: sourceVec.remoteMeta?.model || '', base: sourceVec.remoteMeta?.base || '', items: {} }
    base.items ||= {}
    baseMeta.items ||= {}
    for (const [id, vec] of sourceVec.remoteMap) {
      if (!base.items[id]) {
        base.items[id] = structuredClone(vec)
        if (!base.dims) base.dims = vec.length
        if (sourceVec.remoteMeta?.items?.[id]) baseMeta.items[id] = sourceVec.remoteMeta.items[id]
      }
    }
    writeJson(join(staging, 'memory-vectors.json'), base)
    if (sourceVec.remoteMeta || targetVec.remoteMeta) writeJson(join(staging, 'memory-vectors-meta.json'), baseMeta)
  }

  if (sourceVec.localData) {
    const base = targetVec.localData ? structuredClone(targetVec.localData) : { model: sourceVec.localData.model || '', dim: sourceVec.localData.dim || 0, items: {}, sigs: {} }
    base.items ||= {}
    base.sigs ||= {}
    for (const [id, vec] of sourceVec.localMap) {
      if (!base.items[id]) {
        base.items[id] = encodeBase64Vec(vec)
        if (!base.dim) base.dim = vec.length
        if (sourceVec.localData?.sigs?.[id]) base.sigs[id] = sourceVec.localData.sigs[id]
      }
    }
    writeJson(join(staging, 'local-vectors.json'), base)
  }
}

function listAllRelativeFiles(dir, prefix = '', out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) listAllRelativeFiles(join(dir, entry.name), rel, out)
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

function verifyVectorRecall(kind, sourceMap, stagedMap, restrictToSource = false) {
  if (restrictToSource) {
    if (stagedMap.size < sourceMap.size) throw new Error(`向量核对失败（${kind}）：导入后条数少于源库`)
  } else if (stagedMap.size !== sourceMap.size) {
    throw new Error(`向量核对失败（${kind}）：条数不一致（源 ${sourceMap.size}，目标 ${stagedMap.size}）`)
  }
  if (!sourceMap.size) return
  const keys = [...sourceMap.keys()]
  const picks = [...new Set([keys[0], keys[Math.floor(keys.length / 2)], keys[keys.length - 1]])]
  const allow = restrictToSource ? new Set(keys) : null
  for (const id of picks) {
    const q = sourceMap.get(id)
    const expected = cosineTopK(q, sourceMap, 5)
    const actual = cosineTopK(q, stagedMap, 5, allow)
    if (expected.length !== actual.length) throw new Error(`向量召回核对失败（${kind}）：返回条数不一致`)
    for (let i = 0; i < expected.length; i++) {
      if (expected[i].id !== actual[i].id || Math.abs(expected[i].sim - actual[i].sim) > 1e-5) {
        throw new Error(`向量召回核对失败（${kind}）：样本 ${id} 召回排序不一致`)
      }
    }
  }
}

function commitStagedFiles(staging, target, managedExtras = []) {
  const stagedRels = listAllRelativeFiles(staging)
  const removeOnCommit = [...new Set([...MEMORY_FILES, ...IDENTITY_FILES.map((n) => `gateway/${n}`), ...managedExtras])]
  const moveSet = [...new Set([...stagedRels, ...removeOnCommit])]
  const rollbackDir = join(target, `.import-rollback-${randomUUID().slice(0, 8)}`)
  mkdirSync(rollbackDir, { recursive: true })
  const backedUp = []
  const placed = []

  try {
    for (const rel of moveSet) {
      const dst = join(target, rel)
      if (!existsSync(dst)) continue
      const bak = join(rollbackDir, rel)
      mkdirSync(dirname(bak), { recursive: true })
      renameSync(dst, bak)
      backedUp.push(rel)
    }
    for (const rel of stagedRels) {
      const src = join(staging, rel)
      const dst = join(target, rel)
      mkdirSync(dirname(dst), { recursive: true })
      renameSync(src, dst)
      placed.push(rel)
    }
  } catch (error) {
    for (const rel of placed.reverse()) rmSync(join(target, rel), { force: true })
    for (const rel of backedUp.reverse()) {
      const bak = join(rollbackDir, rel)
      const dst = join(target, rel)
      mkdirSync(dirname(dst), { recursive: true })
      renameSync(bak, dst)
    }
    rmSync(rollbackDir, { recursive: true, force: true })
    throw error
  }
  rmSync(rollbackDir, { recursive: true, force: true })
}

/**
 * 从旧版 Aurabot 数据目录导入（对 source 绝对只读）。
 * @param {object} o
 * @param {string} o.source 旧版数据目录
 * @param {boolean} [o.dryRun=false] 仅预检统计，不写入任何目标文件
 * @param {string} [o.targetDir] 目标数据目录（默认当前 Aurabot dataDir）
 * @param {boolean} [o.qqPluginActive] 外部明确传入旧版插件是否启用；不传时按源 config 判定
 */
export async function importFromQQ({ source, dryRun = false, targetDir, qqPluginActive, hooks = null, log = console } = {}) {
  if (!source || !existsSync(source) || !statSync(source).isDirectory()) {
    throw new Error('源目录不存在或不是文件夹')
  }
  const target = targetDir || dataDir()
  if (resolve(source) === resolve(target)) {
    throw new Error('源目录和目标目录不能是同一个路径')
  }

  const srcMem = readMemorySnapshotReadOnly(source)
  if (!srcMem) throw new Error('源目录里没有找到记忆库（memory.sqlite 或 memories.json）')

  const srcPeople = enumeratePeopleFromState(srcMem.state)
  const chatlogDays = listJsonlDays(join(source, 'chatlog'))
  const srcVectors = readVectorsFromDir(source)
  const srcConfig = existsSync(join(source, 'config.json')) ? readJson(join(source, 'config.json'), null) : null
  const sourceActive = qqPluginActive !== undefined ? Boolean(qqPluginActive) : isLegacyQQEnabled(srcConfig)

  const targetMem = readMemorySnapshotReadOnly(target)
  const targetChatlogs = listJsonlDays(join(target, 'chatlog'))
  const targetHasData = Boolean(targetMem || targetChatlogs.length)
  const mode = targetHasData ? 'merge' : 'initial'

  const warnings = []
  if (srcMem.hasFallbackJson) {
    warnings.push('源目录存在 memory-json-fallback.json（记忆库处于 JSON 回退状态），建议先在旧版处理修复后再导入')
  }
  if (sourceActive) {
    warnings.push('检测到旧版仍处于启用状态，本次仅导入记忆等数据、跳过 sessions.json；停用旧版可避免两版同时向同一会话写消息')
  }

  const preflight = {
    ok: true,
    dryRun: Boolean(dryRun),
    source,
    targetDir: target,
    mode,
    items: srcMem.state.items.length,
    peopleCount: srcPeople.length,
    people: srcPeople,
    chatlogDays,
    chatlogDayCount: chatlogDays.length,
    vectorCount: srcVectors.count,
    memorySchema: srcMem.schema,
    memoryBackend: srcMem.backend,
    tables: srcMem.tables,
    hasFallbackJson: srcMem.hasFallbackJson,
    targetHasData,
    qqPluginActive: sourceActive,
    warnings,
    sessionsImported: false,
    identityAdded: 0,
    identityExisting: 0,
  }

  if (dryRun) return preflight

  mkdirSync(target, { recursive: true })
  const staging = join(target, `.import-staging-${randomUUID().slice(0, 8)}`)
  mkdirSync(staging, { recursive: true })

  try {
    await hooks?.onStep?.('copy', { staging, mode })

    // 1. 记忆暂存：首次导入保持逐条等同，重复导入按 id + 最新修改时间合并。
    let expectedState = srcMem.state
    if (mode === 'initial') {
      if (srcMem.backend === 'sqlite') {
        copyBytesIfExists(join(source, 'memory.sqlite'), join(staging, 'memory.sqlite'))
        copyBytesIfExists(join(source, 'memory.sqlite-wal'), join(staging, 'memory.sqlite-wal'))
        const db = new DatabaseSync(join(staging, 'memory.sqlite'))
        try {
          db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
        } finally {
          try { db.close() } catch {}
        }
        rmSync(join(staging, 'memory.sqlite-wal'), { force: true })
        rmSync(join(staging, 'memory.sqlite-shm'), { force: true })
      } else {
        copyBytesIfExists(join(source, 'memories.json'), join(staging, 'memories.json'))
        createMemoryStorage({ directory: () => staging, log }).load()
        for (const extra of readdirSync(staging)) {
          if (extra.startsWith('memories.migrated-')) rmSync(join(staging, extra), { force: true })
        }
      }
    } else {
      expectedState = mergeMemoryStates(targetMem?.state || { items: [] }, srcMem.state)
      writeStateToSqlite(join(staging, 'memory.sqlite'), expectedState)
    }

    // 2. 聊天流水（按日 .jsonl，合并模式按 (t, chatId, who, text) 去重追加）
    const expectedChatlogCounts = new Map()
    const targetChatlogDir = join(target, 'chatlog')
    for (const day of new Set([...chatlogDays, ...(mode === 'merge' ? targetChatlogs : [])])) {
      const srcRows = chatlogDays.includes(day) ? readChatlogEntries(join(source, 'chatlog'), day) : []
      if (mode === 'initial') {
        copyBytesIfExists(join(source, 'chatlog', `${day}.jsonl`), join(staging, 'chatlog', `${day}.jsonl`))
        expectedChatlogCounts.set(day, srcRows.length)
      } else {
        const tgtRows = targetChatlogs.includes(day) ? readChatlogEntries(targetChatlogDir, day) : []
        const seen = new Set(tgtRows.map(chatlogRowKey))
        const combined = tgtRows.map((entry) => entry.raw)
        for (const entry of srcRows) {
          const key = chatlogRowKey(entry)
          if (seen.has(key)) continue
          seen.add(key)
          combined.push(entry.raw)
        }
        mkdirSync(join(staging, 'chatlog'), { recursive: true })
        writeFileSync(join(staging, 'chatlog', `${day}.jsonl`), combined.length ? combined.join('\n') + '\n' : '', 'utf8')
        if (chatlogDays.includes(day)) expectedChatlogCounts.set(day, combined.length)
      }
    }

    // 3. 向量索引与人设（无敏感凭据）
    const targetVec = mode === 'merge' ? readVectorsFromDir(target) : { remoteData: null, remoteMeta: null, localData: null, remoteMap: new Map(), localMap: new Map(), count: 0 }
    if (mode === 'initial') {
      copyBytesIfExists(join(source, 'memory-vectors.json'), join(staging, 'memory-vectors.json'))
      copyBytesIfExists(join(source, 'memory-vectors-meta.json'), join(staging, 'memory-vectors-meta.json'))
      copyBytesIfExists(join(source, 'local-vectors.json'), join(staging, 'local-vectors.json'))
    } else {
      stageMergedVectors(srcVectors, targetVec, staging)
    }
    copyTree(join(source, 'personas'), join(staging, 'personas'))

    // 4. 配置（只拷贝平台无关字段 + ownerQQ；绝不带旧网关配置与密码令牌）
    if (srcConfig && typeof srcConfig === 'object' && !Array.isArray(srcConfig)) {
      const neutral = pickPlatformNeutralConfig(srcConfig)
      if (mode === 'initial' || !existsSync(join(target, 'config.json'))) {
        writeJson(join(staging, 'config.json'), neutral)
      } else {
        const currentCfg = readJson(join(target, 'config.json'), null)
        if (currentCfg && typeof currentCfg === 'object') {
          const mergedCfg = { ...neutral, ...currentCfg }
          writeJson(join(staging, 'config.json'), mergedCfg)
        }
      }
    }

    // 5. 会话映射（若旧版仍在启用，跳过 sessions.json 避免并发撞同一会话）
    let sessionsImported = false
    if (!sourceActive && existsSync(join(source, 'sessions.json'))) {
      const srcSessions = readJson(join(source, 'sessions.json'), null)
      if (srcSessions && typeof srcSessions === 'object') {
        if (mode === 'initial' || !existsSync(join(target, 'sessions.json'))) {
          writeJson(join(staging, 'sessions.json'), srcSessions)
        } else {
          const tgtSessions = readJson(join(target, 'sessions.json'), { chats: {} })
          const mergedSessions = {
            ...srcSessions,
            ...tgtSessions,
            chats: { ...(srcSessions.chats || {}), ...(tgtSessions.chats || {}) },
            memoryCutoffs: { ...(srcSessions.memoryCutoffs || {}), ...(tgtSessions.memoryCutoffs || {}) },
          }
          writeJson(join(staging, 'sessions.json'), mergedSessions)
        }
        sessionsImported = true
      }
    }

    // 6. 身份库：如合并模式下目标已有身份库，先拷到暂存再幂等补录
    await hooks?.onStep?.('identity', { staging })
    const stagedGateway = join(staging, 'gateway')
    if (mode === 'merge') {
      for (const rel of IDENTITY_FILES) copyBytesIfExists(join(target, 'gateway', rel), join(stagedGateway, rel))
    }
    const stagedPeople = enumeratePeopleFromState(expectedState).filter((id) => /^\d+$/.test(id))
    const stagedIdentity = createIdentity({ dataDir: stagedGateway, log })
    const idStats = stagedIdentity.importLegacyQQ(stagedPeople)

    // 7. 核对一：记忆四表条数与内容逐条一致
    await hooks?.onStep?.('verify-memory', { staging })
    const stagedRows = rowsOfMemoryState(expectedState)
    const stagedDb = new DatabaseSync(join(staging, 'memory.sqlite'))
    try {
      for (const table of MEMORY_TABLES) {
        const count = stagedDb.prepare(`SELECT count(*) AS count FROM ${table}`).get().count
        if (count !== stagedRows[table].size) {
          throw new Error(`记忆表 ${table} 条数核对失败（期望 ${stagedRows[table].size}，实际 ${count}）`)
        }
        if (mode === 'initial' && srcMem.backend === 'sqlite' && count !== srcMem.tables[table]) {
          throw new Error(`记忆表 ${table} 与源库条数不一致（源 ${srcMem.tables[table]}，实际 ${count}）`)
        }
      }
      const stagedState = readMemoryDatabase(stagedDb)
      if (!isDeepStrictEqual(stagedState, expectedState)) {
        throw new Error('记忆核对失败：四张表解码内容与期望不一致')
      }
    } finally {
      try { stagedDb.close() } catch {}
    }

    // 8. 核对二：记忆里出现过的每个人都在身份表里
    await hooks?.onStep?.('verify-identity', { staging })
    for (const id of stagedPeople) {
      if (!stagedIdentity.isValid(id)) throw new Error(`身份核对失败：记忆人物 ${id} 未出现在身份库`)
    }

    // 9. 核对三：向量条数一致 + 抽样召回排序与源库相同
    await hooks?.onStep?.('verify-vectors', { staging })
    const stagedVec = readVectorsFromDir(staging)
    verifyVectorRecall('remote', srcVectors.remoteMap, stagedVec.remoteMap, mode === 'merge')
    verifyVectorRecall('local', srcVectors.localMap, stagedVec.localMap, mode === 'merge')

    // 10. 核对四：聊天流水每天行数准确
    await hooks?.onStep?.('verify-chatlog', { staging })
    for (const [day, expectedCount] of expectedChatlogCounts) {
      const actualCount = readChatlogEntries(join(staging, 'chatlog'), day).length
      if (actualCount !== expectedCount) {
        throw new Error(`流水核对失败（${day}）：期望 ${expectedCount} 行，实际 ${actualCount} 行`)
      }
    }

    await hooks?.onStep?.('pre-commit', { staging })

    // 11. 重复导入（目标已有数据时）正式切换前自动备份
    let backup = null
    if (mode === 'merge') {
      backup = createPairedBackup({ root: target, tag: 'pre-import' })
      if (existsSync(join(target, 'config.json'))) {
        await createBackup({ version: 'pre-import', root: target })
      }
    }

    // 12. 原子切换并校验回滚能力
    await hooks?.onStep?.('commit', { staging })
    commitStagedFiles(staging, target)

    return {
      ...preflight,
      dryRun: false,
      sessionsImported,
      identityAdded: idStats.added,
      identityExisting: idStats.existing,
      backup,
    }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/**
 * 同目录就地升级保障（对应进度决策）：升级前自动成组备份记忆与身份库，完成 JSON→SQLite 迁移与老人物身份补录。
 * 任一步失败从刚做的成组快照原地回退。
 */
export function ensureUpgradedStorage({ root = dataDir(), onClaimOwner = null, log = console } = {}) {
  const hasSqlite = existsSync(join(root, 'memory.sqlite'))
  const hasJson = existsSync(join(root, 'memories.json'))
  if (!hasSqlite && !hasJson) {
    return { upgraded: false, backup: null, migratedMemory: false, identityAdded: 0 }
  }

  const snap = readMemorySnapshotReadOnly(root)
  const people = snap ? enumeratePeopleFromState(snap.state).filter((id) => /^\d+$/.test(id)) : []
  const needMemoryMigrate = hasJson && !hasSqlite
  const gatewayDir = join(root, 'gateway')
  const hasIdentityDb = existsSync(join(gatewayDir, 'identity.sqlite'))
  let missingPeople = people
  if (hasIdentityDb && people.length) {
    const existing = createIdentity({ dataDir: gatewayDir, log })
    missingPeople = people.filter((id) => !existing.isValid(id))
  }
  const needIdentityMigrate = !hasIdentityDb || missingPeople.length > 0

  if (!needMemoryMigrate && !needIdentityMigrate) {
    return { upgraded: false, backup: null, migratedMemory: false, identityAdded: 0 }
  }

  const backup = createPairedBackup({ root, tag: 'pre-upgrade' })
  try {
    let migratedMemory = false
    if (needMemoryMigrate) {
      createMemoryStorage({ directory: () => root, log }).load()
      migratedMemory = existsSync(join(root, 'memory.sqlite'))
    }
    const idStore = createIdentity({ dataDir: gatewayDir, log })
    const res = idStore.importLegacyQQ(people)
    if (typeof onClaimOwner === 'function') onClaimOwner(idStore)
    return { upgraded: true, backup, migratedMemory, identityAdded: res.added }
  } catch (error) {
    try { restorePairedBackup(backup, { root }) } catch {}
    throw error
  }
}
