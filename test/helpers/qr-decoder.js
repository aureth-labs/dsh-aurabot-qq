// 独立 ISO/IEC 18004（Version 1–16 · EC 等级 M · Byte 模式）二维码矩阵解码与 RS 伴随式校验工具（测试专用，无第三方依赖）。
// 用于对 src/core/qr.js 生成的二维码矩阵做端到端独立还原与 ECC 数学验证，避免“只查定位符”遗漏数据/交错/版本号错误。

const EC_M_TABLE = Object.freeze({
  1: { size: 21, ecPerBlock: 10, blocks: [[1, 16]], align: [] },
  2: { size: 25, ecPerBlock: 16, blocks: [[1, 28]], align: [6, 18] },
  3: { size: 29, ecPerBlock: 26, blocks: [[1, 44]], align: [6, 22] },
  4: { size: 33, ecPerBlock: 18, blocks: [[2, 32]], align: [6, 26] },
  5: { size: 37, ecPerBlock: 24, blocks: [[2, 43]], align: [6, 30] },
  6: { size: 41, ecPerBlock: 16, blocks: [[4, 27]], align: [6, 34] },
  7: { size: 45, ecPerBlock: 18, blocks: [[4, 31]], align: [6, 22, 38] },
  8: { size: 49, ecPerBlock: 22, blocks: [[2, 38], [2, 39]], align: [6, 24, 42] },
  9: { size: 53, ecPerBlock: 22, blocks: [[3, 36], [2, 37]], align: [6, 26, 46] },
  10: { size: 57, ecPerBlock: 26, blocks: [[4, 43], [1, 44]], align: [6, 28, 50] },
  11: { size: 61, ecPerBlock: 30, blocks: [[1, 50], [4, 51]], align: [6, 30, 54] },
  12: { size: 65, ecPerBlock: 22, blocks: [[6, 36], [2, 37]], align: [6, 32, 58] },
  13: { size: 69, ecPerBlock: 22, blocks: [[8, 37], [1, 38]], align: [6, 34, 62] },
  14: { size: 73, ecPerBlock: 24, blocks: [[4, 40], [5, 41]], align: [6, 26, 46, 66] },
  15: { size: 77, ecPerBlock: 24, blocks: [[5, 41], [5, 42]], align: [6, 26, 48, 70] },
  16: { size: 81, ecPerBlock: 28, blocks: [[7, 45], [3, 46]], align: [6, 26, 50, 74] },
})

// GF(256) 对数/指数表（本原多项式 x^8 + x^4 + x^3 + x^2 + 1 = 0x11d）
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    EXP[i + 255] = x
    LOG[x] = i
    x = x & 0x80 ? ((x << 1) ^ 0x11d) & 0xff : (x << 1)
  }
}

function gfMul(a, b) {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]
}

function evalPolyGF256(coeffs, x) {
  let y = 0
  for (let i = 0; i < coeffs.length; i++) {
    y = gfMul(y, x) ^ coeffs[i]
  }
  return y
}

function polyMod2Remainder(value, degreeGenerator, degreeSize) {
  let v = value
  for (let bit = 31; bit >= degreeSize; bit--) {
    if ((v >>> bit) & 1) v ^= degreeGenerator << (bit - degreeSize)
  }
  return v
}

function decodeFormatBits(modules) {
  const size = modules.length
  let fmt1 = 0
  for (let i = 0; i < 15; i++) {
    const bit = i < 6 ? modules[i][8] : i < 8 ? modules[i + 1][8] : i === 8 ? modules[8][7] : modules[8][14 - i]
    fmt1 |= (bit & 1) << i
  }
  let fmt2 = 0
  for (let i = 0; i < 15; i++) {
    const bit = i < 8 ? modules[8][size - 1 - i] : modules[size - 15 + i][8]
    fmt2 |= (bit & 1) << i
  }
  if (fmt1 !== fmt2) {
    throw new Error(`QR 格式信息两份拷贝不一致：fmt1=${fmt1.toString(2)} fmt2=${fmt2.toString(2)}`)
  }
  const unmasked = fmt1 ^ 0x5412
  if (polyMod2Remainder(unmasked, 0x537, 10) !== 0) {
    throw new Error(`QR 格式信息 BCH(15,5) 校验失败：${unmasked.toString(2)}`)
  }
  const ecLevelBits = (unmasked >>> 13) & 0b11
  const mask = (unmasked >>> 10) & 0b111
  if (ecLevelBits !== 0b00) {
    throw new Error(`非预期纠错等级位：${ecLevelBits.toString(2)}`)
  }
  return { ecLevel: 'M', mask }
}

function decodeAndVerifyVersion(modules, expectedVersion) {
  if (expectedVersion < 7) return
  const size = modules.length
  let v1 = 0
  let v2 = 0
  for (let i = 0; i < 18; i++) {
    const a = size - 11 + (i % 3)
    const b = Math.floor(i / 3)
    v1 |= (modules[a][b] & 1) << i
    v2 |= (modules[b][a] & 1) << i
  }
  if (v1 !== v2) {
    throw new Error(`V${expectedVersion} 版本信息两份拷贝不一致`)
  }
  if (polyMod2Remainder(v1, 0x1f25, 12) !== 0) {
    throw new Error(`V${expectedVersion} 版本信息 BCH(18,6) 校验失败`)
  }
  const decodedVer = (v1 >>> 12) & 0x3f
  if (decodedVer !== expectedVersion) {
    throw new Error(`解码版本号 V${decodedVer} 与矩阵尺寸对应版本号 V${expectedVersion} 不符`)
  }
}

function buildFunctionMask(version, spec) {
  const { size, align } = spec
  const mask = Array.from({ length: size }, () => new Uint8Array(size))
  const markRect = (r0, c0, h, w) => {
    for (let dr = 0; dr < h; dr++) {
      for (let dc = 0; dc < w; dc++) {
        const r = r0 + dr
        const c = c0 + dc
        if (r >= 0 && r < size && c >= 0 && c < size) mask[r][c] = 1
      }
    }
  }
  // 3 Finder + 分隔符 + Format 保护带
  markRect(0, 0, 9, 9)
  markRect(0, size - 8, 9, 8)
  markRect(size - 8, 0, 8, 9)
  // Alignment patterns
  const k = align.length
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === k - 1) || (i === k - 1 && j === 0)) continue
      markRect(align[i] - 2, align[j] - 2, 5, 5)
    }
  }
  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    mask[6][i] = 1
    mask[i][6] = 1
  }
  // Version blocks (V >= 7)
  if (version >= 7) {
    markRect(0, size - 11, 6, 3)
    markRect(size - 11, 0, 3, 6)
  }
  return mask
}

function unmaskedBitAt(modules, mask, r, c) {
  let flip = false
  switch (mask) {
    case 0: flip = ((r + c) & 1) === 0; break
    case 1: flip = (r & 1) === 0; break
    case 2: flip = c % 3 === 0; break
    case 3: flip = (r + c) % 3 === 0; break
    case 4: flip = ((Math.floor(r / 2) + Math.floor(c / 3)) & 1) === 0; break
    case 5: flip = ((r * c) % 2 + (r * c) % 3) === 0; break
    case 6: flip = (((r * c) % 2 + (r * c) % 3) & 1) === 0; break
    case 7: flip = (((r + c) % 2 + (r * c) % 3) & 1) === 0; break
  }
  return (modules[r][c] & 1) ^ (flip ? 1 : 0)
}

/**
 * 独立解码 ISO/IEC 18004 二维码矩阵并校验格式区、版本区、全部 RS 纠错块与 UTF-8 原文。
 */
export function decodeQrMatrixIso(modules) {
  if (!Array.isArray(modules) || !modules.length) {
    throw new Error('无效二维码矩阵')
  }
  const size = modules.length
  const version = Math.floor((size - 17) / 4)
  const spec = EC_M_TABLE[version]
  if (!spec || spec.size !== size) {
    throw new Error(`不支持或无效矩阵尺寸：${size}`)
  }

  decodeAndVerifyVersion(modules, version)
  const { mask } = decodeFormatBits(modules)
  const funcMask = buildFunctionMask(version, spec)

  // 之字形读取未掩码比特
  const bits = []
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    const upward = ((right + 1) & 2) === 0
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step
      for (let dx = 0; dx < 2; dx++) {
        const c = right - dx
        if (!funcMask[r][c]) {
          bits.push(unmaskedBitAt(modules, mask, r, c))
        }
      }
    }
  }

  const totalCodewords = spec.blocks.reduce((sum, [cnt, d]) => sum + cnt * (d + spec.ecPerBlock), 0)
  if (bits.length < totalCodewords * 8) {
    throw new Error(`可用比特数 ${bits.length} 小于码字要求 ${totalCodewords * 8}`)
  }

  const rawCodewords = new Uint8Array(totalCodewords)
  for (let i = 0; i < totalCodewords; i++) {
    let b = 0
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i * 8 + j]
    rawCodewords[i] = b
  }

  // 反交错分块并逐块校验 RS 伴随式
  const blocks = []
  for (const [count, dataLen] of spec.blocks) {
    for (let i = 0; i < count; i++) {
      blocks.push({ data: new Uint8Array(dataLen), ec: new Uint8Array(spec.ecPerBlock) })
    }
  }
  const maxDataLen = Math.max(...blocks.map((b) => b.data.length))
  let pos = 0
  for (let i = 0; i < maxDataLen; i++) {
    for (const blk of blocks) {
      if (i < blk.data.length) blk.data[i] = rawCodewords[pos++]
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const blk of blocks) {
      blk.ec[i] = rawCodewords[pos++]
    }
  }

  for (let idx = 0; idx < blocks.length; idx++) {
    const blk = blocks[idx]
    const codeword = new Uint8Array(blk.data.length + blk.ec.length)
    codeword.set(blk.data, 0)
    codeword.set(blk.ec, blk.data.length)
    for (let j = 0; j < spec.ecPerBlock; j++) {
      if (evalPolyGF256(codeword, EXP[j]) !== 0) {
        throw new Error(`V${version} 第 ${idx} 块 Reed-Solomon 伴随式 S_${j} 非零`)
      }
    }
  }

  // 解析 Byte 模式载荷
  const dataBytes = []
  for (const blk of blocks) dataBytes.push(...blk.data)
  const dataBits = []
  for (const b of dataBytes) {
    for (let i = 7; i >= 0; i--) dataBits.push((b >>> i) & 1)
  }
  const readBits = (offset, len) => {
    let v = 0
    for (let i = 0; i < len; i++) v = (v << 1) | dataBits[offset + i]
    return v
  }
  const mode = readBits(0, 4)
  if (mode !== 0b0100) {
    throw new Error(`非 Byte 模式指示符：${mode.toString(2)}`)
  }
  const countBits = version >= 10 ? 16 : 8
  const byteCount = readBits(4, countBits)
  const payload = Buffer.alloc(byteCount)
  let bitPos = 4 + countBits
  for (let i = 0; i < byteCount; i++) {
    payload[i] = readBits(bitPos, 8)
    bitPos += 8
  }
  return { version, ecLevel: 'M', mask, text: payload.toString('utf8') }
}
