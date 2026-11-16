// Archive completion is the commit point: never drop a QQ binding on a rejected archive.
const keyOf = (id) => String(id || '').replace(/^session-/, '')

export function archiveFailure(error) {
  const activity = error?.activity || []
  if (activity.some((a) => a.kind === 'schedule') || /active \(.*schedule/.test(String(error?.message || ''))) {
    return '仍有关联的定时任务，请先在 DSH 定时任务面板迁移或暂停任务；任务和会话绑定已保留'
  }
  if (activity.length || error?.name === 'WorkspaceActiveSessionError') return '会话仍有任务正在运行，请等任务结束；会话绑定已保留'
  return '归档未成功，会话绑定已保留；请查看本机日志'
}

export async function archiveSessions({ registry, entries, forget, assertActive = () => {}, log }) {
  const grouped = new Map()
  for (const entry of entries) {
    if (!entry.sessionId) continue
    const key = keyOf(entry.sessionId)
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key).push(entry)
  }
  const result = { archived: 0, alreadyArchived: 0, failed: [] }
  for (const refs of grouped.values()) {
    assertActive()
    const id = refs[0].sessionId
    try {
      if (typeof registry?.archiveSession !== 'function') throw new Error('宿主没有归档会话的能力')
      const already = (registry.archivedSessionIds || []).some((s) => keyOf(s) === keyOf(id))
      if (!already) {
        const r = await registry.archiveSession(id)
        if (r === false || r?.ok === false) throw new Error(r?.message || '归档被拒绝')
      }
      assertActive()
      // Re-read maps in forget(): an awaited archive must not overwrite newer bindings.
      for (const ref of refs) forget(ref)
      if (already) result.alreadyArchived++
      else result.archived++
    } catch (error) {
      assertActive()
      log?.warn?.(`归档会话 ${id} 失败：`, error?.message || error)
      result.failed.push({ sessionId: id, chatId: refs.find((r) => r.chatId)?.chatId || '', reason: archiveFailure(error) })
    }
  }
  if (result.failed.length) {
    const reasons = [...new Set(result.failed.map((f) => f.reason))].join('；')
    const error = new Error(`已归档 ${result.archived} 个会话，${result.failed.length} 个未重开：${reasons}。`)
    error.code = 'AURABOT_RESET_PARTIAL'
    error.result = result
    throw error
  }
  return result
}
