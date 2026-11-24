// 独立第三方 jsQR 解码基准脚本（按需运行：npm run test:qr-decode）。
// 独立于 src/core/qr.js 验证 V1–V16 矩阵与实际渲染给前端的 SVG Data URI 均可被第三方扫码库完整还原原文。

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join } from 'node:path'
import { encodeQrMatrix, encodeQrSvgDataUri } from '../../src/core/qr.js'

function loadJsQr() {
  const localReq = createRequire(import.meta.url)
  try {
    return localReq('jsqr')
  } catch {}
  for (const binDir of String(process.env.PATH || '').split(delimiter)) {
    if (!binDir.includes('_npx')) continue
    // npm-cache/_npx/<hash>/node_modules/.bin -> ../jsqr
    const cand1 = join(binDir, '..', 'jsqr')
    const cand2 = join(dirname(binDir), 'node_modules', 'jsqr')
    for (const dir of [cand1, cand2]) {
      if (existsSync(dir)) {
        return createRequire(join(dir, 'package.json'))(dir)
      }
    }
  }
  throw new Error('找不到 jsqr，请通过 `npm run test:qr-decode` 或 `npx -y -p jsqr node test/scripts/verify-qr-jsqr.mjs` 运行')
}

function paintMatrixToRgba(modules, { margin = 4, scale = 4 } = {}) {
  const size = modules.length
  const dim = (size + margin * 2) * scale
  const rgba = new Uint8ClampedArray(dim * dim * 4).fill(255)
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!modules[r][c]) continue
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const py = (r + margin) * scale + dy
          const px = (c + margin) * scale + dx
          const idx = (py * dim + px) * 4
          rgba[idx] = 0
          rgba[idx + 1] = 0
          rgba[idx + 2] = 0
        }
      }
    }
  }
  return { rgba, dim }
}

function paintSvgDataUriToRgba(dataUri, scale = 4) {
  const prefix = 'data:image/svg+xml;base64,'
  assert.ok(dataUri.startsWith(prefix), 'SVG Data URI 前缀无效')
  const svg = Buffer.from(dataUri.slice(prefix.length), 'base64').toString('utf8')
  const vbMatch = svg.match(/viewBox="0 0 (\d+) (\d+)"/)
  assert.ok(vbMatch && vbMatch[1] === vbMatch[2], 'SVG viewBox 必须是正方形')
  const gridDim = Number(vbMatch[1])
  const imgDim = gridDim * scale
  const rgba = new Uint8ClampedArray(imgDim * imgDim * 4).fill(255)
  const pathMatch = svg.match(/<path d="([^"]+)"/)
  assert.ok(pathMatch, 'SVG 缺少二维码 path')
  const cmdRe = /M(\d+),(\d+)h(\d+)v(\d+)h-\d+z/g
  let m
  let rectCount = 0
  while ((m = cmdRe.exec(pathMatch[1])) !== null) {
    rectCount++
    const x0 = Number(m[1])
    const y0 = Number(m[2])
    const w = Number(m[3])
    const h = Number(m[4])
    for (let ry = y0; ry < y0 + h; ry++) {
      for (let rx = x0; rx < x0 + w; rx++) {
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const py = ry * scale + dy
            const px = rx * scale + dx
            const idx = (py * imgDim + px) * 4
            rgba[idx] = 0
            rgba[idx + 1] = 0
            rgba[idx + 2] = 0
          }
        }
      }
    }
  }
  assert.ok(rectCount > 0, 'SVG path 未解析出任何暗块')
  return { rgba, dim: imgDim }
}

const jsQR = loadJsQr()

const vectors = [
  { label: 'V1', expectedVersion: 1, text: 'hello' },
  { label: 'V4', expectedVersion: 4, text: 'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=abc123def456' },
  { label: 'V7', expectedVersion: 7, text: 'https://ilinkai.weixin.qq.com/qr/' + 'x'.repeat(80) },
  { label: 'V10', expectedVersion: 10, text: 'https://open.example.com/v10?' + 'a'.repeat(175) },
  { label: 'V11', expectedVersion: 11, text: 'https://open.feishu.cn/qr/' + 'x'.repeat(210) },
  { label: 'V12', expectedVersion: 12, text: 'https://open.feishu.cn/qr/' + 'b'.repeat(250) },
  { label: 'V13', expectedVersion: 13, text: 'https://open.feishu.cn/qr/' + 'c'.repeat(290) },
  { label: 'V14', expectedVersion: 14, text: 'https://accounts.example.com/oauth/device?user_code=ABCD-EFGH&redirect=' + 'y'.repeat(280) },
  { label: 'V15', expectedVersion: 15, text: 'https://open.example.com/v15?' + 'd'.repeat(370) },
  { label: 'V16', expectedVersion: 16, text: 'https://open.example.com/auth?' + 'z'.repeat(415) },
  { label: 'UTF8', expectedVersion: 5, text: 'https://aurabot.example.com/扫码登录?msg=你好世界&tag=v11' },
]

for (const v of vectors) {
  const encoded = encodeQrMatrix(v.text)
  assert.equal(encoded.version, v.expectedVersion, `${v.label} 版本不匹配`)

  const matImg = paintMatrixToRgba(encoded.modules)
  const matDecoded = jsQR(matImg.rgba, matImg.dim, matImg.dim)
  assert.equal(matDecoded?.data, v.text, `${v.label} 矩阵经 jsQR 解码不一致`)

  const dataUri = encodeQrSvgDataUri(v.text)
  const svgImg = paintSvgDataUriToRgba(dataUri)
  const svgDecoded = jsQR(svgImg.rgba, svgImg.dim, svgImg.dim)
  assert.equal(svgDecoded?.data, v.text, `${v.label} SVG Data URI 经 jsQR 解码不一致`)

  console.log(`✔ ${v.label} (V${encoded.version}) matrix + SVG Data URI -> jsQR decoded ${Buffer.byteLength(v.text, 'utf8')}B exact match`)
}
console.log(`全部 ${vectors.length} 组 QR 向量通过第三方 jsQR 独立解码校验`)
