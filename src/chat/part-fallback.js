// 跨模块共用的 Part ↔ 平台消息段回退转换（仅供无网关或默认回退路径使用）。
// 覆盖契约全部 12 种 Part，同时向下兼容历史模块直接传入的 url / file / base64 / userId / all / reply 形态。

import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

function pickMediaSource(part) {
  const m = part?.media && typeof part.media === 'object' ? part.media : null
  if (m?.bytes instanceof Uint8Array && m.bytes.length) {
    return `base64://${Buffer.from(m.bytes).toString('base64')}`
  }
  if (typeof m?.bytes === 'string' && m.bytes) {
    return m.bytes.startsWith('base64://') ? m.bytes : `base64://${m.bytes}`
  }
  const url = m?.url ?? part?.url
  if (url) return String(url)
  const file = m?.path ?? part?.file
  if (file) {
    const raw = String(file)
    return isAbsolute(raw) ? pathToFileURL(raw).href : raw
  }
  if (part?.base64) {
    const b64 = String(part.base64)
    return b64.startsWith('base64://') ? b64 : `base64://${b64}`
  }
  if (m?.id) return String(m.id)
  return ''
}

function formatFaceText(name, value) {
  const label = String(name || '表情')
  if (value !== undefined && value !== null && String(value) !== '') {
    return `[${label}：${String(value)}]`
  }
  return `[${label}]`
}

function formatCardText(part) {
  const head = String(part.text || part.title || '').trim()
  const summary = part.summary && !head.includes(String(part.summary)) ? String(part.summary).trim() : ''
  const url = part.url && !head.includes(String(part.url)) ? String(part.url).trim() : ''
  return [head, summary, url].filter(Boolean).join(' ')
}

/** 将契约 Part[]（或兼容旧模块简写 Part[]）转换为平台消息段数组。 */
export function partsToSegmentsFallback(parts = [], { faceIdOf } = {}) {
  if (!Array.isArray(parts)) return []
  const out = []
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue
    switch (p.type) {
      case 'text': {
        if (p.text) out.push({ type: 'text', data: { text: String(p.text) } })
        break
      }
      case 'mention': {
        const qq = p.all || p.account === 'all' ? 'all' : String(p.account ?? p.userId ?? '')
        if (qq) out.push({ type: 'at', data: { qq } })
        break
      }
      case 'reply': {
        if (p.messageId != null) out.push({ type: 'reply', data: { id: String(p.messageId) } })
        break
      }
      case 'image':
      case 'voice':
      case 'video':
      case 'file': {
        const file = pickMediaSource(p)
        if (!file) break
        const segType = p.type === 'voice' ? 'record' : p.type
        const name = p.media?.name ?? p.name
        out.push({ type: segType, data: p.type === 'file' && name ? { file, name: String(name) } : { file } })
        break
      }
      case 'sticker': {
        if (p.native && typeof p.native === 'object' && p.native.type) {
          out.push(p.native)
          break
        }
        const file = pickMediaSource(p) || (p.id != null ? String(p.id) : '')
        if (file) {
          const summary = p.label ?? p.name
          out.push({ type: 'image', data: { file, sub_type: 1, ...(summary ? { summary: String(summary) } : {}) } })
        } else if (p.label || p.name) {
          out.push({ type: 'text', data: { text: String(p.label || `[${p.name}]`) } })
        }
        break
      }
      case 'face': {
        if (p.id != null) {
          out.push({ type: 'face', data: { id: String(p.id), ...(p.value != null ? { resultId: String(p.value) } : {}) } })
          break
        }
        const resolvedId = typeof faceIdOf === 'function' && p.name ? faceIdOf(String(p.name)) : null
        if (resolvedId !== undefined && resolvedId !== null && resolvedId !== '') {
          out.push({ type: 'face', data: { id: String(resolvedId), ...(p.value != null ? { resultId: String(p.value) } : {}) } })
        } else if (p.name) {
          out.push({ type: 'text', data: { text: formatFaceText(p.name, p.value) } })
        }
        break
      }
      case 'card': {
        const text = formatCardText(p)
        if (text) out.push({ type: 'text', data: { text } })
        break
      }
      case 'forward': {
        out.push({ type: 'text', data: { text: p.id ? `[合并转发 #${p.id}]` : '[合并转发]' } })
        break
      }
      case 'poke': {
        out.push({ type: 'poke', data: {} })
        break
      }
      case 'other': {
        if (p.native && typeof p.native === 'object' && p.native.type) {
          out.push(p.native)
        } else if (p.text) {
          out.push({ type: 'text', data: { text: String(p.text) } })
        }
        break
      }
      default:
        break
    }
  }
  return out
}

function mediaFromSegFallback(d = {}) {
  const raw = String(d.url || d.file || '').trim()
  const media = {}
  if (raw.startsWith('base64://')) media.bytes = Buffer.from(raw.slice('base64://'.length), 'base64')
  else if (/^https?:\/\//i.test(raw)) media.url = raw
  else if (raw) media.path = raw
  if (d.name) media.name = String(d.name)
  return media
}

/** 将平台消息段数组还原为标准化 Part[]（缺少平台 adapter.toParts 时的兜底）。 */
export function segmentsToPartsFallback(segs = []) {
  if (!Array.isArray(segs)) return []
  const out = []
  for (const s of segs) {
    if (!s || typeof s !== 'object') continue
    const d = s.data || {}
    if (s.type === 'text') {
      if (d.text !== undefined) out.push({ type: 'text', text: String(d.text) })
    } else if (s.type === 'at') {
      if (d.qq != null) out.push({ type: 'mention', account: String(d.qq) })
    } else if (s.type === 'face') {
      if (d.id != null) {
        out.push({
          type: 'face',
          name: String(d.id),
          ...(d.resultId != null ? { value: String(d.resultId) } : {}),
          id: String(d.id),
        })
      }
    } else if (s.type === 'reply') {
      if (d.id != null) out.push({ type: 'reply', messageId: String(d.id) })
    } else if (s.type === 'poke') {
      out.push({ type: 'poke' })
    } else if (s.type === 'forward' && d.id != null) {
      out.push({ type: 'forward', id: String(d.id) })
    } else if (s.type === 'image' || s.type === 'mface' || s.type === 'record' || s.type === 'voice' || s.type === 'video' || s.type === 'file') {
      const type = s.type === 'record' ? 'voice' : (s.type === 'mface' || (s.type === 'image' && d.sub_type === 1)) ? 'sticker' : s.type
      const media = mediaFromSegFallback(d)
      if (!media.url && !media.path && !media.bytes) continue
      out.push({
        type,
        media,
        ...(type === 'sticker' && d.summary ? { label: String(d.summary) } : {}),
      })
    }
  }
  return out
}
