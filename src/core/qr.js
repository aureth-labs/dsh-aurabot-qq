// 零依赖纯 JS ISO/IEC 18004 二维码编码与 SVG 渲染（Byte 模式 · 纠错等级 M · Version 1–16）。
// 用途：把各平台返回的扫码授权链接在本地渲染成 SVG Data URI，不向任何第三方在线制码服务泄漏 URL。

const VERSIONS_M = Object.freeze([
  null,
  { version: 1, size: 21, maxBytes: 14, ecPerBlock: 10, blocks: [[1, 16]], align: [] },
  { version: 2, size: 25, maxBytes: 26, ecPerBlock: 16, blocks: [[1, 28]], align: [6, 18] },
  { version: 3, size: 29, maxBytes: 42, ecPerBlock: 26, blocks: [[1, 44]], align: [6, 22] },
  { version: 4, size: 33, maxBytes: 62, ecPerBlock: 18, blocks: [[2, 32]], align: [6, 26] },
  { version: 5, size: 37, maxBytes: 84, ecPerBlock: 24, blocks: [[2, 43]], align: [6, 30] },
  { version: 6, size: 41, maxBytes: 106, ecPerBlock: 16, blocks: [[4, 27]], align: [6, 34] },
  { version: 7, size: 45, maxBytes: 122, ecPerBlock: 18, blocks: [[4, 31]], align: [6, 22, 38] },
  { version: 8, size: 49, maxBytes: 152, ecPerBlock: 22, blocks: [[2, 38], [2, 39]], align: [6, 24, 42] },
  { version: 9, size: 53, maxBytes: 180, ecPerBlock: 22, blocks: [[3, 36], [2, 37]], align: [6, 26, 46] },
  { version: 10, size: 57, maxBytes: 213, ecPerBlock: 26, blocks: [[4, 43], [1, 44]], align: [6, 28, 50] },
  { version: 11, size: 61, maxBytes: 251, ecPerBlock: 30, blocks: [[1, 50], [4, 51]], align: [6, 30, 54] },
  { version: 12, size: 65, maxBytes: 287, ecPerBlock: 22, blocks: [[6, 36], [2, 37]], align: [6, 32, 58] },
  { version: 13, size: 69, maxBytes: 331, ecPerBlock: 22, blocks: [[8, 37], [1, 38]], align: [6, 34, 62] },
  { version: 14, size: 73, maxBytes: 362, ecPerBlock: 24, blocks: [[4, 40], [5, 41]], align: [6, 26, 46, 66] },
  { version: 15, size: 77, maxBytes: 412, ecPerBlock: 24, blocks: [[5, 41], [5, 42]], align: [6, 26, 48, 70] },
  { version: 16, size: 81, maxBytes: 450, ecPerBlock: 28, blocks: [[7, 45], [3, 46]], align: [6, 26, 50, 74] },
])

export const MAX_QR_UTF8_BYTES = VERSIONS_M[VERSIONS_M.length - 1].maxBytes

const SAFE_IMAGE_DATA_URI_RE = /^data:image\/(?:png|svg\+xml|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i
const UNSAFE_URI_SCHEME_RE = /^(?:javascript|vbscript|data):/i

// GF(256) with primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11d)
const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x
    GF_EXP[i + 255] = x
    GF_LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
}

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0
  return GF_EXP[GF_LOG[a] + GF_LOG[b]]
}

function rsGeneratorPoly(degree) {
  let poly = new Uint8Array([1])
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1)
    const factor = GF_EXP[i]
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]
      next[j + 1] ^= gfMul(poly[j], factor)
    }
    poly = next
  }
  return poly
}

function rsRemainder(data, ecLen) {
  const gen = rsGeneratorPoly(ecLen)
  const buf = new Uint8Array(data.length + ecLen)
  buf.set(data, 0)
  for (let i = 0; i < data.length; i++) {
    const coef = buf[i]
    if (coef === 0) continue
    for (let j = 1; j < gen.length; j++) {
      buf[i + j] ^= gfMul(coef, gen[j])
    }
  }
  return buf.slice(data.length)
}

function bchRemainder(val, dataBits, genPoly, totalBits) {
  const ecBits = totalBits - dataBits
  let rem = val << ecBits
  for (let bit = totalBits - 1; bit >= ecBits; bit--) {
    if ((rem >>> bit) & 1) {
      rem ^= genPoly << (bit - ecBits)
    }
  }
  return (val << ecBits) | rem
}

function pushBits(bits, val, count) {
  for (let i = count - 1; i >= 0; i--) {
    bits.push((val >>> i) & 1)
  }
}

function buildCodewords(payloadBytes, spec) {
  const totalDataCodewords = spec.blocks.reduce((sum, [cnt, len]) => sum + cnt * len, 0)
  const totalDataBits = totalDataCodewords * 8
  const bits = []
  // Byte mode (0100) + character count (8 bits for V1-9, 16 bits for V10-26)
  pushBits(bits, 0b0100, 4)
  pushBits(bits, payloadBytes.length, spec.version >= 10 ? 16 : 8)
  for (const b of payloadBytes) pushBits(bits, b, 8)

  const termBits = Math.min(4, totalDataBits - bits.length)
  for (let i = 0; i < termBits; i++) bits.push(0)
  while (bits.length % 8 !== 0) bits.push(0)

  const dataBytes = []
  for (let i = 0; i < bits.length; i += 8) {
    let byteVal = 0
    for (let b = 0; b < 8; b++) byteVal = (byteVal << 1) | bits[i + b]
    dataBytes.push(byteVal)
  }
  const padBytes = [0xec, 0x11]
  for (let idx = 0; dataBytes.length < totalDataCodewords; idx++) {
    dataBytes.push(padBytes[idx % 2])
  }

  const dataBlocks = []
  const ecBlocks = []
  let offset = 0
  for (const [count, dataLen] of spec.blocks) {
    for (let b = 0; b < count; b++) {
      const slice = Uint8Array.from(dataBytes.slice(offset, offset + dataLen))
      offset += dataLen
      dataBlocks.push(slice)
      ecBlocks.push(rsRemainder(slice, spec.ecPerBlock))
    }
  }

  const interleaved = []
  const maxDataLen = Math.max(...dataBlocks.map((b) => b.length))
  for (let i = 0; i < maxDataLen; i++) {
    for (const blk of dataBlocks) {
      if (i < blk.length) interleaved.push(blk[i])
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const blk of ecBlocks) {
      if (i < blk.length) interleaved.push(blk[i])
    }
  }
  return Uint8Array.from(interleaved)
}

function makeGrid(size, fill = 0) {
  return Array.from({ length: size }, () => new Int8Array(size).fill(fill))
}

function drawFinder(modules, isFunc, top, left, size) {
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const r = top + dr
      const c = left + dc
      if (r < 0 || r >= size || c < 0 || c >= size) continue
      const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6
      const onOuterBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6
      const inInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4
      modules[r][c] = inOuter && (onOuterBorder || inInner) ? 1 : 0
      isFunc[r][c] = 1
    }
  }
}

function drawAlignment(modules, isFunc, centerR, centerC) {
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      const r = centerR + dr
      const c = centerC + dc
      const dark = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0)
      modules[r][c] = dark ? 1 : 0
      isFunc[r][c] = 1
    }
  }
}

function drawFormatBits(modules, mask) {
  const size = modules.length
  // EC Level M = 0b00, generator 0x537, XOR mask 0x5412
  const format5 = (0b00 << 3) | mask
  const format15 = bchRemainder(format5, 5, 0x537, 15) ^ 0x5412
  for (let i = 0; i < 15; i++) {
    const bit = (format15 >>> i) & 1
    if (i < 6) modules[i][8] = bit
    else if (i < 8) modules[i + 1][8] = bit
    else if (i === 8) modules[8][7] = bit
    else modules[8][14 - i] = bit
    if (i < 8) modules[8][size - 1 - i] = bit
    else modules[size - 15 + i][8] = bit
  }
  modules[size - 8][8] = 1
}

function drawVersionBits(modules, version, isFunc) {
  if (version < 7) return
  const size = modules.length
  const ver18 = bchRemainder(version, 6, 0x1f25, 18)
  for (let i = 0; i < 18; i++) {
    const bit = (ver18 >>> i) & 1
    const a = size - 11 + (i % 3)
    const b = Math.floor(i / 3)
    modules[a][b] = bit
    modules[b][a] = bit
    isFunc[a][b] = 1
    isFunc[b][a] = 1
  }
}

function drawFunctionPatterns(spec) {
  const { version, size, align } = spec
  const modules = makeGrid(size, 0)
  const isFunc = makeGrid(size, 0)

  drawFinder(modules, isFunc, 0, 0, size)
  drawFinder(modules, isFunc, 0, size - 7, size)
  drawFinder(modules, isFunc, size - 7, 0, size)

  const k = align.length
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === k - 1) || (i === k - 1 && j === 0)) continue
      drawAlignment(modules, isFunc, align[i], align[j])
    }
  }

  for (let i = 8; i < size - 8; i++) {
    if (!isFunc[6][i]) {
      modules[6][i] = i % 2 === 0 ? 1 : 0
      isFunc[6][i] = 1
    }
    if (!isFunc[i][6]) {
      modules[i][6] = i % 2 === 0 ? 1 : 0
      isFunc[i][6] = 1
    }
  }

  // Reserve format info strips so data placement skips them
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      isFunc[8][i] = 1
      isFunc[i][8] = 1
    }
  }
  for (let i = 0; i < 8; i++) {
    isFunc[8][size - 1 - i] = 1
    if (i < 7) isFunc[size - 1 - i][8] = 1
  }
  modules[size - 8][8] = 1
  isFunc[size - 8][8] = 1

  drawVersionBits(modules, version, isFunc)
  return { modules, isFunc }
}

function placeCodewords(modules, isFunc, codewords) {
  const size = modules.length
  let bitIdx = 0
  const totalBits = codewords.length * 8
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    const upward = ((right + 1) & 2) === 0
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step
      for (let dx = 0; dx < 2; dx++) {
        const c = right - dx
        if (isFunc[r][c]) continue
        let bit = 0
        if (bitIdx < totalBits) {
          bit = (codewords[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1
        }
        modules[r][c] = bit
        bitIdx++
      }
    }
  }
}

function maskCond(mask, r, c) {
  switch (mask) {
    case 0: return ((r + c) & 1) === 0
    case 1: return (r & 1) === 0
    case 2: return c % 3 === 0
    case 3: return (r + c) % 3 === 0
    case 4: return ((Math.floor(r / 2) + Math.floor(c / 3)) & 1) === 0
    case 5: return ((r * c) % 2 + (r * c) % 3) === 0
    case 6: return (((r * c) % 2 + (r * c) % 3) & 1) === 0
    case 7: return (((r + c) % 2 + (r * c) % 3) & 1) === 0
    default: return false
  }
}

function applyMask(base, isFunc, mask) {
  const size = base.length
  const out = base.map((row) => Int8Array.from(row))
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!isFunc[r][c] && maskCond(mask, r, c)) {
        out[r][c] ^= 1
      }
    }
  }
  drawFormatBits(out, mask)
  return out
}

function penaltyLine(line) {
  let score = 0
  let runColor = -1
  let runLen = 0
  for (let i = 0; i < line.length; i++) {
    const v = line[i]
    if (v === runColor) {
      runLen++
    } else {
      if (runLen >= 5) score += 3 + (runLen - 5)
      runColor = v
      runLen = 1
    }
  }
  if (runLen >= 5) score += 3 + (runLen - 5)

  for (let i = 0; i <= line.length - 11; i++) {
    const a = line[i] === 1 && line[i + 1] === 0 && line[i + 2] === 1 && line[i + 3] === 1 && line[i + 4] === 1
      && line[i + 5] === 0 && line[i + 6] === 1 && line[i + 7] === 0 && line[i + 8] === 0 && line[i + 9] === 0 && line[i + 10] === 0
    const b = line[i] === 0 && line[i + 1] === 0 && line[i + 2] === 0 && line[i + 3] === 0 && line[i + 4] === 1
      && line[i + 5] === 0 && line[i + 6] === 1 && line[i + 7] === 1 && line[i + 8] === 1 && line[i + 9] === 0 && line[i + 10] === 1
    if (a || b) score += 40
  }
  return score
}

function penaltyScore(grid) {
  const size = grid.length
  let score = 0
  const colBuf = new Int8Array(size)
  let dark = 0
  for (let r = 0; r < size; r++) {
    score += penaltyLine(grid[r])
    for (let c = 0; c < size; c++) {
      if (grid[r][c]) dark++
      if (r + 1 < size && c + 1 < size) {
        const v = grid[r][c]
        if (grid[r][c + 1] === v && grid[r + 1][c] === v && grid[r + 1][c + 1] === v) score += 3
      }
    }
  }
  for (let c = 0; c < size; c++) {
    for (let r = 0; r < size; r++) colBuf[r] = grid[r][c]
    score += penaltyLine(colBuf)
  }
  const total = size * size
  const k = Math.floor(Math.abs(dark * 20 - total) / total)
  return score + k * 10
}

/**
 * 把字符串编码为二维码布尔矩阵（Byte 模式 · EC M · Version 1–16）。
 * @param {string} text
 * @returns {{ version: number, size: number, modules: Uint8Array[] }}
 */
export function encodeQrMatrix(text) {
  const s = String(text ?? '')
  if (!s) throw new Error('二维码内容不能为空')
  const payloadBytes = Buffer.from(s, 'utf8')
  const spec = VERSIONS_M.slice(1).find((v) => payloadBytes.length <= v.maxBytes)
  if (!spec) {
    throw new Error(`二维码内容过长（${payloadBytes.length} 字节，本地编码器上限 ${MAX_QR_UTF8_BYTES} 字节）`)
  }
  const codewords = buildCodewords(payloadBytes, spec)
  const { modules: base, isFunc } = drawFunctionPatterns(spec)
  placeCodewords(base, isFunc, codewords)

  let bestGrid = null
  let bestScore = Infinity
  for (let mask = 0; mask < 8; mask++) {
    const candidate = applyMask(base, isFunc, mask)
    const score = penaltyScore(candidate)
    if (score < bestScore) {
      bestScore = score
      bestGrid = candidate
    }
  }

  return {
    version: spec.version,
    size: spec.size,
    modules: bestGrid.map((row) => Uint8Array.from(row)),
  }
}

/**
 * 把文本直接编码为清晰可扫的 SVG 字符串。
 * @param {string} text
 * @param {{ margin?: number, moduleSize?: number, dark?: string, light?: string }} [opts]
 */
export function encodeQrSvg(text, { margin = 4, moduleSize = 6, dark = '#111111', light = '#ffffff' } = {}) {
  const { size, modules } = encodeQrMatrix(text)
  const m = Math.max(1, Number(margin) || 4)
  const scale = Math.max(1, Number(moduleSize) || 6)
  const dim = (size + m * 2) * scale
  const paths = []
  for (let r = 0; r < size; r++) {
    let runStart = -1
    for (let c = 0; c <= size; c++) {
      const darkCell = c < size && modules[r][c] === 1
      if (darkCell && runStart < 0) {
        runStart = c
      } else if (!darkCell && runStart >= 0) {
        const w = c - runStart
        paths.push(`M${runStart + m},${r + m}h${w}v1h-${w}z`)
        runStart = -1
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size + m * 2} ${size + m * 2}" width="${dim}" height="${dim}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="${light}"/><path d="${paths.join('')}" fill="${dark}"/></svg>`
}

/**
 * 编码为可直接放进 <img src="..."> 的 SVG Data URI。
 */
export function encodeQrSvgDataUri(text, opts = {}) {
  const svg = encodeQrSvg(text, opts)
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}

/**
 * 判断输入是否已经是安全的 base64 图片 Data URI。
 */
export function isSafeQrImageDataUri(value) {
  return SAFE_IMAGE_DATA_URI_RE.test(String(value || '').trim())
}

/**
 * 统一将二维码载荷或已编码的安全图片 Data URI 规范化为可直接渲染的 Data URI。
 * 拒绝非图片 data: / javascript: / vbscript: 载荷。
 */
export function renderQrDataUri(content, opts = {}) {
  const s = String(content ?? '').trim()
  if (!s) throw new Error('二维码内容不能为空')
  if (isSafeQrImageDataUri(s)) return s.replace(/\s+/g, '')
  if (UNSAFE_URI_SCHEME_RE.test(s)) {
    throw new Error('不支持的二维码 URI 格式')
  }
  return encodeQrSvgDataUri(s, opts)
}
