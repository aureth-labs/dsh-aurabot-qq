// Aurabot 合并同一个人（I4）：跨记忆库和身份库的两个重复人物合二为一。
// 固定顺序（缺一步都可能破坏跨库一致性）：
//   1. 先做记忆库 + 身份库的成组备份
//   2. 记忆侧：把 from 名下全部记忆、档案、短期状态、印象、说话习惯、关系改挂到 into
//   3. 核对：ownedBy(from) 为空，into 条目数 === 合并前两人之和
//   4. 身份侧：identity.repoint(from, into)，冲突账号保留不动并上报
//   5. 只针对 into 跑一次现有整理去重
//   6. 第 2~4 步任意失败：用第 1 步快照整组恢复两库
// 注意：本模块处于中枢层（src/features/），不直接提及任何具体平台名词。

import { join } from 'node:path'
import { dataDir } from '../core/store.js'
import { createPairedBackup, restorePairedBackup } from '../core/backup.js'
import { createIdentity } from '../gateway/identity.js'
import { ownedByFromState, reassignPersonInState } from './memory.js'
import { createMemoryStorage } from './memory-store.js'

export const MERGE_UNDO_WARNING = '撤销合并会恢复合并前快照；合并之后新产生的记忆和绑定改动将会丢失'

function createStorageMemoryAdapter(root, log) {
  const storage = createMemoryStorage({ directory: () => root, log })
  return {
    ownedBy: (person) => ownedByFromState(storage.load(), person),
    reassignPerson: (from, into) => {
      const state = storage.load()
      reassignPersonInState(state, from, into)
      storage.save(state)
      return ownedByFromState(state, into)
    },
    mergeGroups: null,
    invalidateCache: () => {},
  }
}

/**
 * 合并两个重复人物（跨记忆库和身份库）。
 * @param {object} o
 * @param {string} o.from 被并掉的人物 PersonId
 * @param {string} o.into 保留并接收全部记忆与账号的目标人物 PersonId
 * @param {boolean} [o.dryRun=false] 仅预检双方记忆/账号及冲突，不写任何库
 */
export async function mergePerson({ from, into, dryRun = false, memory = null, identity = null, dataDir: customRoot = '', hooks = null, log = console } = {}) {
  const src = String(from || '').trim()
  const dst = String(into || '').trim()
  if (!src || !dst) throw new Error('必须同时指定要合并的源人物（from）和目标人物（into）')
  if (src === dst) throw new Error('不能把同一个人合并给自己')

  const root = customRoot || dataDir()
  const idStore = identity || createIdentity({ dataDir: join(root, 'gateway'), log })
  if (idStore.owner?.() === src) {
    throw new Error('不能把主人身份合并进其他人名下，请把另一个身份合并到主人名下')
  }

  const mem = memory || createStorageMemoryAdapter(root, log)
  const fromOwned = mem.ownedBy(src)
  const intoOwned = mem.ownedBy(dst)
  const fromAccounts = idStore.accountsOf(src)
  const intoAccounts = idStore.accountsOf(dst)
  const intoPlatforms = new Set(intoAccounts.map((a) => a.platform))
  const potentialConflicts = fromAccounts.filter((a) => intoPlatforms.has(a.platform))

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      from: src,
      into: dst,
      fromOwned,
      intoOwned,
      fromAccounts,
      intoAccounts,
      conflicts: potentialConflicts,
      undoWarning: MERGE_UNDO_WARNING,
    }
  }

  if (fromOwned.total === 0 && fromAccounts.length === 0) {
    throw new Error(`找不到人物 ${src} 的记忆或账号记录`)
  }

  // 1. 先背出记忆库 + 身份库成组快照
  const backup = createPairedBackup({ root, tag: 'merge' })

  let repointResult = { moved: [], conflicts: [] }
  const expectedItems = fromOwned.itemCount + intoOwned.itemCount

  try {
    // 2. 记忆侧改挂：个人条目、档案、短期状态、相处经验、说话习惯、关系全迁到 into
    await hooks?.onStep?.('step2-memory', { from: src, into: dst, backup })
    mem.reassignPerson(src, dst)
    await hooks?.onStep?.('step2-after', { from: src, into: dst, backup })

    // 3. 核对：源人物名下已空，且目标人物条目数精确等于合并前两人之和
    await hooks?.onStep?.('step3-verify', { from: src, into: dst, backup })
    const fromAfter = mem.ownedBy(src)
    const intoAfter = mem.ownedBy(dst)
    if (fromAfter.total !== 0) {
      throw new Error(`合并核对失败：人物 ${src} 名下仍有残留数据（total=${fromAfter.total}）`)
    }
    if (intoAfter.itemCount !== expectedItems) {
      throw new Error(`合并核对失败：目标人物 ${dst} 条目数 ${intoAfter.itemCount} 不等于合并前两人之和 ${expectedItems}`)
    }

    // 4. 身份侧改挂：冲突账号保留原归属，通过 conflicts 报回给面板处理
    await hooks?.onStep?.('step4-identity', { from: src, into: dst, backup })
    repointResult = idStore.repoint(src, dst)
    await hooks?.onStep?.('step4-after', { from: src, into: dst, backup, repointResult })
  } catch (error) {
    // 6. 第 2~4 步任一步失败，立即整组回退记忆库 + 身份库
    restorePairedBackup(backup, { root, memory: mem })
    throw error
  }

  // 5. 只针对 into 跑一次现有的整理去重
  await hooks?.onStep?.('step5-dedup', { from: src, into: dst, backup })
  const dedup = typeof mem.mergeGroups === 'function'
    ? await mem.mergeGroups({ person: dst })
    : { groups: 0, calls: 0, merged: 0 }

  return {
    ok: true,
    dryRun: false,
    from: src,
    into: dst,
    backup,
    movedItems: fromOwned.itemCount,
    totalItemsAfter: expectedItems,
    movedAccounts: repointResult.moved,
    conflicts: repointResult.conflicts,
    dedup,
    undoWarning: MERGE_UNDO_WARNING,
  }
}

/** 撤销合并：从步骤 1 保存的成组快照完整恢复记忆库与身份库。 */
export function undoMergePerson({ backup, dataDir: customRoot = '', memory = null } = {}) {
  const root = customRoot || dataDir()
  const res = restorePairedBackup(backup, { root, memory })
  return {
    ...res,
    notice: '已撤销合并并恢复合并前快照；合并之后新产生的记忆和绑定改动未保留',
  }
}
