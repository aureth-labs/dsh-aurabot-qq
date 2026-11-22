// 旧版 QQ 迁移网关 QQ · 持久化事务、配置快照、有界缓冲与收件箱持久化回执（方案 v8）
// 涵盖：
//   1. <dataDir>/qq-migration-txn/<txnId>/（journal.json / config.raw.pre.json / config.target.json / buffer/）
//   2. <dataDir>/qq-recovery-guard.json & <dataDir>/qq-data-epoch.json & <dataDir>/backup-restore-journal.json
//   3. 原始 config 键存在性与凭据精确快照 / 恢复
//   4. 迁移期间 held 有界磁盘缓冲与崩溃恢复收敛
//   5. DSH sessionPersistence 只读句柄 + agent/inbox/spliced.inserted[].id 持久化证明

import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { QQ_SNAPSHOT_OBJECT_KEYS, QQ_SNAPSHOT_SCALAR_KEYS } from './config.js'
import { writeJsonAtomicFsync } from './store.js'

export { writeJsonAtomicFsync }

export const MIGRATION_TXN_DIR = 'qq-migration-txn'
export const RECOVERY_GUARD_FILE = 'qq-recovery-guard.json'
export const DATA_EPOCH_FILE = 'qq-data-epoch.json'
export const BACKUP_JOURNAL_FILE = 'backup-restore-journal.json'

/** 本机当前恢复与迁移状态路径：完整备份、配置备份、远程备份及备份导入校验统一排除。 */
export const LOCAL_RECOVERY_STATE_PATHS = Object.freeze([
  MIGRATION_TXN_DIR,
  RECOVERY_GUARD_FILE,
  DATA_EPOCH_FILE,
  BACKUP_JOURNAL_FILE,
])

export const MAX_HELD_BUFFER_ITEMS = 200
export const MAX_HELD_BUFFER_BYTES = 2 * 1024 * 1024

export const TERMINAL_TXN_PHASES = new Set(['active', 'rolled-back'])
export const PRE_COMMIT_TXN_PHASES = new Set(['locked', 'preparing', 'prepared', 'prepare-failed', 'aborting'])
export const POST_COMMIT_TXN_PHASES = new Set(['committed', 'finishing'])
export const KNOWN_SAFE_GUARD_PHASES = new Set(['idle', 'active', 'rolled-back'])
export const KNOWN_PAUSED_GUARD_PHASES = new Set([
  'migration-ambiguous',
  'buffer-overflow',
  'aborted-uncertain',
  'recovering',
  'preparing',
  'prepared',
  'committing',
  'committed',
  'finishing',
  'aborting',
  'prepare-failed',
  'backup-moving',
  'backup-not-started',
])

export function isKnownGuardPhase(phase) {
  return typeof phase === 'string' && (KNOWN_SAFE_GUARD_PHASES.has(phase) || KNOWN_PAUSED_GUARD_PHASES.has(phase))
}

export function readJsonSafe(filePath, fallback = null) {
  try {
    if (!existsSync(filePath)) return fallback
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

export function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value ?? null), 'utf8').digest('hex')
}

// ───────────────────────── 数据代际与恢复门 ─────────────────────────

export function dataEpochPath(root) {
  return join(root, DATA_EPOCH_FILE)
}

export function readDataEpoch(root) {
  const file = dataEpochPath(root)
  if (!existsSync(file)) {
    return { version: 1, epoch: 0, lastTxnId: '', updatedAt: 0, corrupt: false }
  }
  const raw = readJsonSafe(file, null)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Number.isInteger(raw.epoch) || raw.epoch < 0) {
    return { version: 1, epoch: 0, lastTxnId: '', updatedAt: 0, corrupt: true }
  }
  return {
    version: 1,
    epoch: raw.epoch,
    lastTxnId: typeof raw.lastTxnId === 'string' ? raw.lastTxnId : '',
    updatedAt: Number(raw.updatedAt) || 0,
    corrupt: false,
  }
}

/** 备份提交推进数据代际：同一 txnId 幂等，不因崩溃重放重复递增。 */
export function bumpDataEpoch(root, txnId = '') {
  const cur = readDataEpoch(root)
  const id = String(txnId || '')
  if (id && cur.lastTxnId === id) return cur
  const next = {
    version: 1,
    epoch: cur.epoch + 1,
    lastTxnId: id || cur.lastTxnId,
    updatedAt: Date.now(),
  }
  writeJsonAtomicFsync(dataEpochPath(root), next)
  return next
}

export function recoveryGuardPath(root) {
  return join(root, RECOVERY_GUARD_FILE)
}

export function readRecoveryGuard(root) {
  const file = recoveryGuardPath(root)
  if (!existsSync(file)) {
    return {
      version: 1,
      phase: 'idle',
      txnId: '',
      dataEpoch: readDataEpoch(root).epoch,
      reason: '',
      updatedAt: 0,
      corrupt: false,
      lastResolution: null,
      lastFailedResolution: null,
    }
  }
  const raw = readJsonSafe(file, null)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      version: 1,
      phase: 'corrupt-guard',
      txnId: '',
      dataEpoch: readDataEpoch(root).epoch,
      reason: '恢复门文件损坏',
      updatedAt: 0,
      corrupt: true,
      lastResolution: null,
      lastFailedResolution: null,
    }
  }
  const phase = typeof raw.phase === 'string' && raw.phase ? raw.phase : 'corrupt-guard'
  return {
    version: 1,
    phase,
    txnId: typeof raw.txnId === 'string' ? raw.txnId : '',
    dataEpoch: Number.isInteger(raw.dataEpoch) && raw.dataEpoch >= 0 ? raw.dataEpoch : readDataEpoch(root).epoch,
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    updatedAt: Number(raw.updatedAt) || 0,
    corrupt: !isKnownGuardPhase(phase),
    lastResolution: raw.lastResolution && typeof raw.lastResolution === 'object' && !Array.isArray(raw.lastResolution)
      ? raw.lastResolution
      : null,
    lastFailedResolution: raw.lastFailedResolution && typeof raw.lastFailedResolution === 'object' && !Array.isArray(raw.lastFailedResolution)
      ? raw.lastFailedResolution
      : null,
  }
}

export function writeRecoveryGuard(root, patch = {}) {
  const cur = readRecoveryGuard(root)
  const next = {
    version: 1,
    phase: patch.phase !== undefined ? String(patch.phase || 'idle') : cur.phase,
    txnId: patch.txnId !== undefined ? String(patch.txnId || '') : cur.txnId,
    dataEpoch: patch.dataEpoch !== undefined ? Number(patch.dataEpoch) || 0 : cur.dataEpoch,
    reason: patch.reason !== undefined ? String(patch.reason || '') : cur.reason,
    updatedAt: Date.now(),
    lastResolution: patch.lastResolution !== undefined ? patch.lastResolution : cur.lastResolution,
    lastFailedResolution: patch.lastFailedResolution !== undefined ? patch.lastFailedResolution : cur.lastFailedResolution,
  }
  writeJsonAtomicFsync(recoveryGuardPath(root), next)
  return next
}

export function clearRecoveryGuard(root, resolution = null) {
  const cur = readRecoveryGuard(root)
  const nextResolution = resolution && typeof resolution === 'object'
    ? {
        txnId: String(resolution.txnId || cur.txnId || ''),
        action: String(resolution.action || ''),
        operator: String(resolution.operator || 'panel-admin'),
        reason: String(resolution.reason || ''),
        discardedCount: Number(resolution.discardedCount) || 0,
        discardedMain: Number(resolution.discardedMain ?? resolution.discardedCount) || 0,
        discardedVerify: Number(resolution.discardedVerify) || 0,
        verifyAccepted: Number(resolution.verifyAccepted) || 0,
        verifyFiltered: Number(resolution.verifyFiltered) || 0,
        verifyDiscarded: Number(resolution.verifyDiscarded ?? resolution.discardedVerify) || 0,
        pendingCount: Number(resolution.pendingCount) || 0,
        uncertainCount: Number(resolution.uncertainCount) || 0,
        overflowDroppedCount: Number(resolution.overflowDroppedCount) || 0,
        corruptFiles: Array.isArray(resolution.corruptFiles) ? resolution.corruptFiles : [],
        at: Number(resolution.at) || Date.now(),
      }
    : cur.lastResolution
  const next = {
    version: 1,
    phase: 'idle',
    txnId: '',
    dataEpoch: readDataEpoch(root).epoch,
    reason: nextResolution?.reason ? String(nextResolution.reason) : '',
    updatedAt: Date.now(),
    lastResolution: nextResolution,
    lastFailedResolution: null,
  }
  writeJsonAtomicFsync(recoveryGuardPath(root), next)
  return next
}

// ───────────────────────── 原始配置键存在性快照 ─────────────────────────

/**
 * 捕获原配置文件（未经 normalize）中 QQ 托管相关字段与键存在性。
 * 保证 `platforms.qq` 原本不存在、`enabled:false` 草稿或独立 `httpToken`/`wsToken` 均可无损回滚。
 */
export function captureRawQqSnapshot(rawConfig) {
  const raw = rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig) ? rawConfig : {}
  const hasPlatforms = Object.hasOwn(raw, 'platforms')
  const rawPlatforms = hasPlatforms && raw.platforms && typeof raw.platforms === 'object' && !Array.isArray(raw.platforms)
    ? raw.platforms
    : null
  const hasPlatformsQq = Boolean(rawPlatforms && Object.hasOwn(rawPlatforms, 'qq'))
  const platformsQq = hasPlatformsQq ? structuredClone(rawPlatforms.qq) : undefined

  const hasLegacyQqEnabled = Object.hasOwn(raw, 'legacyQqEnabled')
  const legacyQqEnabled = hasLegacyQqEnabled ? raw.legacyQqEnabled : undefined

  const scalars = {}
  for (const k of QQ_SNAPSHOT_SCALAR_KEYS) {
    scalars[k] = Object.hasOwn(raw, k)
      ? { present: true, value: structuredClone(raw[k]) }
      : { present: false }
  }
  const objects = {}
  for (const k of QQ_SNAPSHOT_OBJECT_KEYS) {
    objects[k] = Object.hasOwn(raw, k)
      ? { present: true, value: structuredClone(raw[k]) }
      : { present: false }
  }

  const body = {
    version: 1,
    hasPlatforms,
    hasPlatformsQq,
    ...(hasPlatformsQq ? { platformsQq } : {}),
    hasLegacyQqEnabled,
    ...(hasLegacyQqEnabled ? { legacyQqEnabled } : {}),
    scalars,
    objects,
  }
  return { ...body, hash: sha256Json(body) }
}

export function verifyRawQqSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || snapshot.version !== 1 || typeof snapshot.hash !== 'string') {
    return false
  }
  const { hash, ...body } = snapshot
  return sha256Json(body) === hash
}

/** 按原键存在性精确恢复受影响的 QQ 字段，保留快照期间用户保存的无关字段。 */
export function applyRawQqSnapshot(currentRaw, snapshot) {
  if (!verifyRawQqSnapshot(snapshot)) {
    throw new Error('原配置快照校验失败')
  }
  const next = currentRaw && typeof currentRaw === 'object' && !Array.isArray(currentRaw)
    ? structuredClone(currentRaw)
    : {}

  if (snapshot.hasLegacyQqEnabled) next.legacyQqEnabled = snapshot.legacyQqEnabled
  else delete next.legacyQqEnabled

  for (const k of QQ_SNAPSHOT_SCALAR_KEYS) {
    const entry = snapshot.scalars?.[k]
    if (entry?.present) next[k] = structuredClone(entry.value)
    else delete next[k]
  }
  for (const k of QQ_SNAPSHOT_OBJECT_KEYS) {
    const entry = snapshot.objects?.[k]
    if (entry?.present) next[k] = structuredClone(entry.value)
    else delete next[k]
  }

  if (snapshot.hasPlatformsQq) {
    if (!next.platforms || typeof next.platforms !== 'object' || Array.isArray(next.platforms)) {
      next.platforms = {}
    }
    next.platforms.qq = structuredClone(snapshot.platformsQq)
  } else {
    if (next.platforms && typeof next.platforms === 'object' && !Array.isArray(next.platforms)) {
      delete next.platforms.qq
      if (!snapshot.hasPlatforms && Object.keys(next.platforms).length === 0) {
        delete next.platforms
      }
    }
  }
  return next
}

// ───────────────────────── 迁移事务目录与日志 ─────────────────────────

export const MIGRATION_TXN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function isValidMigrationTxnId(txnId) {
  if (typeof txnId !== 'string') return false
  if (!MIGRATION_TXN_ID_RE.test(txnId)) return false
  if (txnId.includes('..') || txnId.includes('/') || txnId.includes('\\')) return false
  return true
}

export function assertValidMigrationTxnId(txnId) {
  if (!isValidMigrationTxnId(txnId)) {
    throw Object.assign(new Error(`非法迁移事务 ID：${String(txnId ?? '')}`), { code: 'INVALID_TXN_ID' })
  }
  return txnId
}

export function migrationTxnDir(root, txnId) {
  assertValidMigrationTxnId(txnId)
  const base = resolve(String(root), MIGRATION_TXN_DIR)
  const target = resolve(base, txnId)
  const rel = relative(base, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.includes('/') || rel.includes('\\')) {
    throw Object.assign(new Error(`迁移事务目录越界：${String(txnId)}`), { code: 'INVALID_TXN_ID' })
  }
  return target
}

export function createMigrationTxn(root, {
  txnId,
  expectedRevision,
  fromLegacyQqEnabled,
  targetLegacyQqEnabled,
  targetPlatform,
  rawPreConfig,
  targetConfig,
}) {
  const dir = migrationTxnDir(root, txnId)
  const snapshot = captureRawQqSnapshot(rawPreConfig)
  const targetSnapshot = structuredClone(targetConfig || null)
  const epoch = readDataEpoch(root).epoch
  writeJsonAtomicFsync(join(dir, 'config.raw.pre.json'), snapshot)
  writeJsonAtomicFsync(join(dir, 'config.target.json'), {
    version: 1,
    txnId,
    legacyQqEnabled: Boolean(targetLegacyQqEnabled),
    platform: structuredClone(targetPlatform || null),
    targetHash: sha256Json(targetSnapshot),
    config: targetSnapshot,
  })
  const now = Date.now()
  const journal = {
    version: 1,
    txnId,
    phase: 'locked',
    committed: false,
    expectedRevision: Number(expectedRevision) || 0,
    fromLegacyQqEnabled: Boolean(fromLegacyQqEnabled),
    targetLegacyQqEnabled: Boolean(targetLegacyQqEnabled),
    targetPlatform: structuredClone(targetPlatform || null),
    preSnapshotHash: snapshot.hash,
    targetHash: sha256Json(targetSnapshot),
    dataEpoch: epoch,
    createdAt: now,
    updatedAt: now,
  }
  writeJsonAtomicFsync(join(dir, 'journal.json'), journal)
  return { dir, journal, snapshot }
}

export function readMigrationTxn(root, txnId) {
  const dir = migrationTxnDir(root, txnId)
  const journal = readJsonSafe(join(dir, 'journal.json'), null)
  if (!journal || typeof journal !== 'object') return null
  const preSnapshot = readJsonSafe(join(dir, 'config.raw.pre.json'), null)
  const targetRecord = readJsonSafe(join(dir, 'config.target.json'), null)
  return { dir, journal, preSnapshot, targetRecord }
}

export function updateMigrationTxn(root, txnId, patch = {}) {
  const dir = migrationTxnDir(root, txnId)
  const journalFile = join(dir, 'journal.json')
  const cur = readJsonSafe(journalFile, null)
  if (!cur) throw new Error(`迁移事务 ${txnId} 日志不存在`)
  const next = { ...cur, ...patch, updatedAt: Date.now() }
  writeJsonAtomicFsync(journalFile, next)
  return next
}

export function listMigrationTxns(root) {
  const base = join(root, MIGRATION_TXN_DIR)
  if (!existsSync(base)) return []
  const out = []
  let entries = []
  try { entries = readdirSync(base, { withFileTypes: true }) } catch { return [] }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!isValidMigrationTxnId(entry.name)) continue
    const loaded = readMigrationTxn(root, entry.name)
    if (loaded) out.push(loaded)
    else {
      out.push({
        dir: join(base, entry.name),
        journal: { version: 1, txnId: entry.name, phase: 'corrupt', committed: false, corrupt: true },
        preSnapshot: null,
        targetRecord: null,
      })
    }
  }
  return out.sort((a, b) => (Number(a.journal.createdAt) || 0) - (Number(b.journal.createdAt) || 0))
}

export function findActiveMigrationTxns(root) {
  return listMigrationTxns(root).filter((item) => !TERMINAL_TXN_PHASES.has(item.journal?.phase))
}

export function cleanupMigrationTxn(root, txnId) {
  const dir = migrationTxnDir(root, txnId)
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}

// ───────────────────────── held 期间有界磁盘缓冲 ─────────────────────────

function entryFileName(seq) {
  return `${String(seq).padStart(8, '0')}.json`
}

export function extractBufferPayloadText(payload) {
  if (!payload || typeof payload !== 'object') return ''
  if (typeof payload.text === 'string' && payload.text) return payload.text.slice(0, 500)
  if (Array.isArray(payload.parts)) {
    const joined = payload.parts
      .filter((p) => p && typeof p.text === 'string' && p.text)
      .map((p) => p.text)
      .join('\n')
    if (joined) return joined.slice(0, 500)
  }
  const raw = payload.raw
  if (raw && typeof raw === 'object') {
    if (typeof raw.raw_message === 'string' && raw.raw_message) return raw.raw_message.slice(0, 500)
    if (Array.isArray(raw.message)) {
      const segText = raw.message
        .filter((s) => s?.type === 'text' && s?.data?.text)
        .map((s) => String(s.data.text))
        .join('')
      if (segText) return segText.slice(0, 500)
    }
  }
  if (payload.type || payload.name) return String(payload.type || payload.name).slice(0, 500)
  return ''
}

export function createHeldBufferStore(root, txnId, {
  maxItems = MAX_HELD_BUFFER_ITEMS,
  maxBytes = MAX_HELD_BUFFER_BYTES,
  onOverflow = null,
  subDir = 'buffer',
} = {}) {
  const safeSubDir = subDir === 'buffer-verify' ? 'buffer-verify' : 'buffer'
  const dir = join(migrationTxnDir(root, txnId), safeSubDir)
  const overflowFile = join(dir, 'overflow.json')

  function inspectOverflow() {
    if (!existsSync(overflowFile)) return { overflow: null, corrupt: false }
    const raw = readJsonSafe(overflowFile, null)
    if (
      raw
      && typeof raw === 'object'
      && !Array.isArray(raw)
      && typeof raw.overflowed === 'boolean'
      && (raw.count === undefined || (Number.isInteger(raw.count) && raw.count >= 0))
      && (raw.droppedSamples === undefined || Array.isArray(raw.droppedSamples))
    ) {
      return { overflow: raw, corrupt: false }
    }
    return { overflow: null, corrupt: true }
  }

  function readOverflow() {
    return inspectOverflow().overflow
  }

  function inspectEntries() {
    if (!existsSync(dir)) return { entries: [], corruptFiles: [] }
    const files = readdirSync(dir)
      .filter((n) => /^\d+\.json$/.test(n))
      .sort()
    const entries = []
    const corruptFiles = []
    for (const file of files) {
      const parsed = readJsonSafe(join(dir, file), null)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Number.isInteger(parsed.seq) && parsed.seq > 0) {
        entries.push(parsed)
      } else {
        corruptFiles.push(file)
      }
    }
    if (inspectOverflow().corrupt) {
      corruptFiles.push('overflow.json')
    }
    return {
      entries: entries.sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0)),
      corruptFiles,
    }
  }

  function readEntries() {
    return inspectEntries().entries
  }

  function summarizeBufferSample(kind, instance, payload, at, reason = '') {
    const isEvt = kind === 'event'
    const chatKind = String(payload?.chat?.kind || '')
    const chatId = String(payload?.chat?.id || '')
    const senderAccount = String(payload?.sender?.account || '')
    const source = isEvt
      ? `事件 ${String(instance || 'qq')}`
      : chatKind === 'group'
        ? `群 ${chatId || '?'}`
        : `私聊 ${senderAccount || chatId || '?'}`
    return {
      kind: isEvt ? 'event' : 'inbound',
      instance: String(instance || 'qq'),
      messageId: String(payload?.messageId || ''),
      senderAccount,
      senderName: String(payload?.sender?.name || ''),
      chatKind,
      chatId,
      source,
      text: extractBufferPayloadText(payload),
      reason: String(reason || ''),
      at,
    }
  }

  let closed = false
  let existing = readEntries()
  let nextSeq = existing.reduce((m, e) => Math.max(m, Number(e.seq) || 0), 0) + 1
  let totalBytes = existing.reduce((sum, e) => sum + Buffer.byteLength(JSON.stringify(e), 'utf8'), 0)
  let writeGeneration = existing.length

  function recordOverflow(reason, kind, instance, payload) {
    const ov = inspectOverflow()
    if (ov.corrupt) return null
    const prev = ov.overflow
    const now = Date.now()
    const resolvedReason = String(prev?.reason || reason || 'buffer-overflow')
    const summary = summarizeBufferSample(kind, instance, payload, now, resolvedReason)
    const overflowInfo = {
      version: 1,
      overflowed: true,
      reason: resolvedReason,
      count: (Number(prev?.count) || 0) + 1,
      firstAt: Number(prev?.firstAt) || now,
      lastAt: now,
      maxItems,
      maxBytes,
      droppedSamples: [...(Array.isArray(prev?.droppedSamples) ? prev.droppedSamples : []), summary].slice(-20),
    }
    writeJsonAtomicFsync(overflowFile, overflowInfo)
    writeGeneration++
    try { onOverflow?.(overflowInfo) } catch {}
    return overflowInfo
  }

  function append({ kind, instance, payload }) {
    if (closed) {
      return { ok: false, reason: 'buffer-closed', closed: true }
    }
    const ov = inspectOverflow()
    if (ov.corrupt) {
      return { ok: false, reason: 'buffer-corrupt', corrupt: true }
    }
    const prevOverflow = ov.overflow
    if (prevOverflow?.overflowed) {
      const overflowInfo = recordOverflow(prevOverflow.reason, kind, instance, payload)
      return { ok: false, reason: overflowInfo.reason, overflowed: true, overflow: overflowInfo }
    }
    const seq = nextSeq
    const entry = {
      version: 1,
      seq,
      id: randomUUID(),
      kind: kind === 'event' ? 'event' : 'inbound',
      instance: String(instance || 'qq'),
      payload: structuredClone(payload),
      status: 'pending',
      messageId: '',
      sessionId: '',
      baselineSeq: 0,
      reason: '',
      at: Date.now(),
    }
    const size = Buffer.byteLength(JSON.stringify(entry), 'utf8')
    const currentList = readEntries()
    if (currentList.length >= maxItems) {
      const overflowInfo = recordOverflow('buffer-full-items', kind, instance, payload)
      return { ok: false, reason: 'buffer-full-items', overflowed: true, overflow: overflowInfo, maxItems }
    }
    if (totalBytes + size > maxBytes) {
      const overflowInfo = recordOverflow('buffer-full-bytes', kind, instance, payload)
      return { ok: false, reason: 'buffer-full-bytes', overflowed: true, overflow: overflowInfo, maxBytes }
    }
    nextSeq++
    totalBytes += size
    writeGeneration++
    writeJsonAtomicFsync(join(dir, entryFileName(seq)), entry)
    return { ok: true, seq, entry, writeGeneration }
  }

  function markStatus(seq, status, extra = {}) {
    if (closed) return null
    const file = join(dir, entryFileName(seq))
    const cur = readJsonSafe(file, null)
    if (!cur) return null
    const next = {
      ...cur,
      ...extra,
      status: String(status),
      updatedAt: Date.now(),
    }
    writeJsonAtomicFsync(file, next)
    return next
  }

  function canRelease({ expectedWriteGeneration } = {}) {
    if (closed) return { ok: false, reason: 'buffer-closed' }
    const ov = inspectOverflow()
    const { entries, corruptFiles } = inspectEntries()
    if (ov.corrupt || corruptFiles.length > 0) {
      return { ok: false, reason: 'buffer-corrupt', corruptFiles }
    }
    if (ov.overflow?.overflowed) return { ok: false, reason: 'buffer-overflow' }
    if (expectedWriteGeneration !== undefined && writeGeneration !== expectedWriteGeneration) {
      return { ok: false, reason: 'new-entries-arrived' }
    }
    if (entries.some((e) => e.status === 'pending' || e.status === 'dispatching')) {
      return { ok: false, reason: 'entries-not-drained' }
    }
    return { ok: true, writeGeneration }
  }

  function discardAll() {
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        try { rmSync(join(dir, name), { recursive: true, force: true }) } catch {}
      }
    }
    existing = []
    nextSeq = 1
    totalBytes = 0
    writeGeneration++
  }

  function markAllPendingUncertain(reason = 'aborted-uncertain') {
    const changed = []
    for (const item of readEntries()) {
      if (item.status === 'pending' || item.status === 'dispatching') {
        const updated = markStatus(item.seq, 'uncertain', { reason })
        if (updated) changed.push(updated)
      }
    }
    return changed
  }

  /**
   * 崩溃恢复对齐：任何停在 `dispatching` 状态的条目已无法确认是否投递成功，
   * 一律转标为 `uncertain`（永不自动重放）。
   */
  function reconcileAfterCrash() {
    const list = readEntries()
    const changed = []
    for (const item of list) {
      if (item.status === 'dispatching') {
        changed.push(markStatus(item.seq, 'uncertain', { reason: 'crashed-after-dispatching' }))
      }
    }
    return changed
  }

  return {
    dir,
    list: readEntries,
    append,
    markStatus,
    markAllPendingUncertain,
    reconcileAfterCrash,
    discardAll,
    isCorrupt: () => inspectOverflow().corrupt || inspectEntries().corruptFiles.length > 0,
    corruptFiles: () => inspectEntries().corruptFiles,
    isOverflowed: () => Boolean(readOverflow()?.overflowed),
    overflowState: readOverflow,
    getWriteGeneration: () => writeGeneration,
    canRelease,
    close: () => { closed = true },
    isClosed: () => closed,
    pushInbound: ({ instance, message }) => append({ kind: 'inbound', instance, payload: message }),
    pushEvent: ({ instance, event }) => append({ kind: 'event', instance, payload: event }),
  }
}

// ───────────────────────── DSH 持久化收件箱事件回执 ─────────────────────────

export function resolveSessionPersistence(dsh) {
  if (!dsh) return null
  if (typeof dsh.get === 'function') {
    try {
      const p = dsh.get('sessionPersistence')
      if (p) return p
    } catch {}
  }
  try {
    return dsh.sessionPersistence || dsh.services?.sessionPersistence || null
  } catch {
    return null
  }
}

/**
 * 迁移前置检查：必须具备真实 `sessions.flush` 与 `sessionPersistence.open(sessionId, 'read')` 能力。
 * 绝不用 `sessionQuery.observeSession` 或单纯 `flush()===true` 替代持久化只读句柄。
 */
export async function checkMigrationPersistencePreflight(dsh, { sessionId } = {}) {
  if (!dsh?.sessions || typeof dsh.sessions.flush !== 'function') {
    return { ok: false, reason: 'missing-session-flush' }
  }
  const persistence = resolveSessionPersistence(dsh)
  if (!persistence || typeof persistence.open !== 'function') {
    return { ok: false, reason: 'missing-session-persistence' }
  }
  if (sessionId) {
    let handle = null
    try {
      handle = await persistence.open(sessionId, 'read')
    } catch (error) {
      return { ok: false, reason: error?.message || 'persistence-open-failed' }
    } finally {
      if (handle && typeof handle.close === 'function') {
        try { await handle.close() } catch {}
      }
    }
  }
  return { ok: true }
}

/**
 * 打开目标会话持久化只读句柄，读取 `baselineSeq` 之后的事件并验证
 * `agent/inbox/spliced` 事件的 `inserted[].id` 包含本次 `messageId`。
 * 无论成功或异常都会关闭只读句柄。
 */
export async function verifyPersistedInboxMessage(dsh, { sessionId, baselineSeq = 0, messageId } = {}) {
  if (!sessionId || !messageId) {
    return { ok: false, reason: 'missing-session-or-message-id' }
  }
  const persistence = resolveSessionPersistence(dsh)
  if (!persistence || typeof persistence.open !== 'function') {
    return { ok: false, reason: 'missing-session-persistence' }
  }
  let handle = null
  try {
    handle = await persistence.open(sessionId, 'read')
    const startSeq = Number.isInteger(baselineSeq) && baselineSeq >= 0 ? baselineSeq : 0
    const res = await handle.read(startSeq)
    const events = Array.isArray(res?.events) ? res.events : []
    for (const ev of events) {
      if (ev?.type !== 'agent/inbox/spliced') continue
      const inserted = ev?.data?.inserted
      if (Array.isArray(inserted) && inserted.some((item) => item && item.id === messageId)) {
        return { ok: true, seq: ev.seq }
      }
    }
    return { ok: false, reason: 'inbox-event-not-persisted' }
  } catch (error) {
    return { ok: false, reason: error?.message || 'persistence-read-failed' }
  } finally {
    if (handle && typeof handle.close === 'function') {
      try { await handle.close() } catch {}
    }
  }
}
