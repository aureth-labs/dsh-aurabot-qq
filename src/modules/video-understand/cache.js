// video-understand 结果缓存：磁盘 JSON，TTL + 容量上限（超出按 mtime 淘汰最旧）。
// 缓存的是 understand() 的结构化结果（不含帧图像二进制），命中即免重复付费。
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'

// 由「输入指纹 + 有影响的 options 子集」合成缓存 key
export function cacheKey(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)
}

export function createCache({ dir, log = () => {} }) {
  mkdirSync(dir, { recursive: true })
  const stats = { hits: 0, misses: 0 }

  const fileOf = (key) => join(dir, key + '.json')

  function get(key, ttlSec) {
    const file = fileOf(key)
    if (!existsSync(file)) { stats.misses++; return null }
    try {
      const rec = JSON.parse(readFileSync(file, 'utf8'))
      if (!rec || typeof rec !== 'object' || !rec.result) throw new Error('记录损坏')
      if (ttlSec > 0 && Date.now() - rec.savedAt > ttlSec * 1000) {
        unlinkSync(file)
        stats.misses++
        return null
      }
      stats.hits++
      return { ...rec.result, cachedAt: new Date(rec.savedAt).toISOString() }
    } catch (e) {
      // 损坏的缓存当未命中处理，顺手清掉
      try { unlinkSync(file) } catch {}
      log(`[video-understand] 缓存记录损坏已清除: ${e.message}`)
      stats.misses++
      return null
    }
  }

  function put(key, result) {
    try {
      writeFileSync(fileOf(key), JSON.stringify({ savedAt: Date.now(), result }), 'utf8')
    } catch (e) {
      log(`[video-understand] 缓存写入失败: ${e.message}`)
    }
  }

  function count() {
    try { return readdirSync(dir).filter((n) => n.endsWith('.json')).length } catch { return 0 }
  }

  function trim(maxEntries) {
    if (!(maxEntries > 0)) return
    let files
    try {
      files = readdirSync(dir)
        .filter((n) => n.endsWith('.json'))
        .map((n) => {
          const st = statSync(join(dir, n))
          return { n, m: st.mtimeMs }
        })
    } catch { return }
    if (files.length <= maxEntries) return
    files.sort((a, b) => a.m - b.m)
    for (const f of files.slice(0, files.length - maxEntries)) {
      try { unlinkSync(join(dir, f.n)) } catch {}
    }
  }

  function clear() {
    for (const n of readdirSync(dir)) {
      if (n.endsWith('.json')) { try { unlinkSync(join(dir, n)) } catch {} }
    }
    stats.hits = 0
    stats.misses = 0
  }

  return { get, put, trim, clear, count, stats }
}
