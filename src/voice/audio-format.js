// 零第三方依赖音频格式与时长解析工具（AMR-NB / Ogg Opus）。
// 用于在无 ffprobe 环境下准确校验魔数并计算毫秒时长，避免依赖不可靠的文件名或默认 MIME。

const AMR_MAGIC = Buffer.from('#!AMR\n', 'ascii')
// RFC 4867 AMR-NB 各帧模式（FT=0..15）除 1 字节 ToC 头外的有效载荷字节数。
const AMR_NB_FRAME_SIZES = Object.freeze([12, 13, 15, 17, 19, 20, 26, 31, 5, 0, 0, 0, 0, 0, 0, 0])
const OGG_MAGIC = Buffer.from('OggS', 'ascii')
const OPUS_HEAD = Buffer.from('OpusHead', 'ascii')

function toBuffer(buf) {
  if (!buf) return null
  if (Buffer.isBuffer(buf)) return buf
  if (ArrayBuffer.isView(buf)) return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  if (buf instanceof ArrayBuffer) return Buffer.from(buf)
  return null
}

/**
 * 校验字节流是否为有效 AMR-NB 音频（魔数 `#!AMR\n` 且至少包含 1 字节帧数据）。
 * @param {Buffer|Uint8Array|ArrayBuffer} buf
 * @returns {boolean}
 */
export function isAmrBytes(buf) {
  const b = toBuffer(buf)
  if (!b || b.length <= AMR_MAGIC.length) return false
  return b.subarray(0, AMR_MAGIC.length).equals(AMR_MAGIC)
}

/**
 * 按 RFC 4867 逐帧遍历 AMR-NB 码流计算精确时长（毫秒，每帧固定 20ms）。
 * @param {Buffer|Uint8Array|ArrayBuffer} buf
 * @returns {number}
 */
export function estimateAmrDurationMs(buf) {
  if (!isAmrBytes(buf)) return 0
  const b = toBuffer(buf)
  let offset = AMR_MAGIC.length
  let frames = 0
  while (offset < b.length) {
    const ft = (b[offset] >> 3) & 0x0f
    if (ft > 8 && ft !== 15) break
    const frameBytes = 1 + AMR_NB_FRAME_SIZES[ft]
    if (offset + frameBytes > b.length) break
    frames++
    offset += frameBytes
  }
  return frames * 20
}

/**
 * 校验字节流是否为 Ogg Opus 音频。
 * @param {Buffer|Uint8Array|ArrayBuffer} buf
 * @returns {boolean}
 */
export function isOggOpusBytes(buf) {
  const b = toBuffer(buf)
  if (!b || b.length < 36) return false
  if (!b.subarray(0, 4).equals(OGG_MAGIC)) return false
  return b.subarray(0, Math.min(b.length, 128)).includes(OPUS_HEAD)
}

/**
 * 从末个有效 OggS 页读取 granule_position 计算 Opus 时长（固定 48kHz 计数，单位毫秒）。
 * @param {Buffer|Uint8Array|ArrayBuffer} buf
 * @returns {number}
 */
export function estimateOggOpusDurationMs(buf) {
  if (!isOggOpusBytes(buf)) return 0
  const b = toBuffer(buf)
  for (let pos = b.length - 27; pos >= 0; pos--) {
    if (
      b[pos] === 0x4f
      && b[pos + 1] === 0x67
      && b[pos + 2] === 0x67
      && b[pos + 3] === 0x53
      && b[pos + 4] === 0
    ) {
      const granulePos = b.readBigInt64LE(pos + 6)
      if (granulePos > 0n) {
        return Math.max(1, Math.round(Number(granulePos) / 48))
      }
    }
  }
  return 0
}

/**
 * 为降级为文件发送的非 AMR 语音生成安全的后缀名（避免仅因默认 MIME 保留误导性的 `.amr` 扩展名）。
 * @param {string} rawName
 * @param {string} inferredExt
 * @param {boolean} [isAmr=false]
 * @returns {{ fileName: string, ext: string }}
 */
export function fallbackVoiceName(rawName, inferredExt = '', isAmr = false) {
  const cleanName = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : ''
  const cleanExt = typeof inferredExt === 'string' ? inferredExt.trim().replace(/^\./, '').toLowerCase() : ''
  let fileName = cleanName || `voice.${cleanExt || 'bin'}`
  if (!isAmr && /\.amr$/i.test(fileName)) {
    fileName = `voice.${cleanExt || 'bin'}`
  }
  const dot = fileName.lastIndexOf('.')
  let ext = dot >= 0 && dot < fileName.length - 1 ? fileName.slice(dot + 1).toLowerCase() : ''
  if (!ext && cleanExt) {
    fileName = `${fileName}.${cleanExt}`
    ext = cleanExt
  }
  return { fileName, ext: ext || cleanExt || 'bin' }
}
