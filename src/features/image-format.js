// GIF 是按次选择的新能力；静态调用不增加参数，也不改变旧路由。
import { pickShape } from './image-shape.js'

export function drawFormat(format) {
  if (format == null || format === '' || format === 'static') return 'static'
  if (format === 'gif') return 'gif'
  throw gifError('图片格式只支持 static（静态）或 gif（动图）')
}
export const gifError = (message) => Object.assign(new Error(message), { gifRequestError: true })
export function gifSizeFor(shape, config) {
  return ({ square: '512x512', portrait: '384x576', landscape: '576x384', wide: '768x432' })[pickShape(shape, config)] || '512x512'
}
export const GIF_FIELDS = { output_format: 'gif', frame_count: 8, frame_duration_ms: 200 }

// 沿 GIF 块结构跳过压缩数据；不靠在任意字节里搜索帧标记，也不解码整张图。
export function gifFrameCount(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 14 || !/^GIF8[79]a$/.test(buf.toString('ascii', 0, 6)) || !buf.readUInt16LE(6) || !buf.readUInt16LE(8)) return 0
  let p = 13 + ((buf[10] & 128) ? 3 * (1 << ((buf[10] & 7) + 1)) : 0), frames = 0
  const skipBlocks = () => {
    while (p < buf.length) {
      const n = buf[p++]
      if (!n) return true
      p += n
      if (p > buf.length) return false
    }
    return false
  }
  while (p < buf.length) {
    const tag = buf[p++]
    if (tag === 0x3b) return frames
    if (tag === 0x21) { if (p >= buf.length) return 0; p++; if (!skipBlocks()) return 0 }
    else if (tag === 0x2c) {
      if (p + 9 > buf.length || !buf.readUInt16LE(p + 4) || !buf.readUInt16LE(p + 6)) return 0
      const packed = buf[p + 8]; p += 9
      if (packed & 128) p += 3 * (1 << ((packed & 7) + 1))
      if (p >= buf.length || buf[p] < 2 || buf[p] > 8) return 0
      p++
      if (!buf[p] || !skipBlocks()) return 0
      frames++
    } else return 0
  }
  return 0
}
