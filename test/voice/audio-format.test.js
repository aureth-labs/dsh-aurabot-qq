import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isAmrBytes,
  estimateAmrDurationMs,
  isOggOpusBytes,
  estimateOggOpusDurationMs,
} from '../../src/voice/audio-format.js'

function makeSyntheticAmrNb(frameCount, mode = 7) {
  // mode 7 => 1 字节 ToC + 31 字节载荷 = 32 字节/帧；ToC = (ft << 3) | 0x04
  const frameSizes = [12, 13, 15, 17, 19, 20, 26, 31, 5]
  const payloadSize = frameSizes[mode]
  const toc = ((mode & 0x0f) << 3) | 0x04
  const frame = Buffer.alloc(1 + payloadSize, 0xaa)
  frame[0] = toc
  const parts = [Buffer.from('#!AMR\n', 'ascii')]
  for (let i = 0; i < frameCount; i++) parts.push(frame)
  return Buffer.concat(parts)
}

function makeSyntheticOggOpus(granulePos) {
  const page = Buffer.alloc(64, 0)
  Buffer.from('OggS', 'ascii').copy(page, 0)
  page[4] = 0 // version = 0
  page.writeBigInt64LE(BigInt(granulePos), 6)
  Buffer.from('OpusHead', 'ascii').copy(page, 28)
  return page
}

test('isAmrBytes 与 estimateAmrDurationMs 精确识别并计算 AMR-NB 时长', () => {
  assert.equal(isAmrBytes(Buffer.alloc(0)), false)
  assert.equal(isAmrBytes(Buffer.from('#!AMR\n', 'ascii')), false)
  assert.equal(isAmrBytes(Buffer.from('ID3\x04\x00\x00\x00\x00')), false)

  const amr100ms = makeSyntheticAmrNb(5, 7)
  assert.equal(isAmrBytes(amr100ms), true)
  assert.equal(estimateAmrDurationMs(amr100ms), 100)

  const amr1000ms = makeSyntheticAmrNb(50, 0)
  assert.equal(isAmrBytes(amr1000ms), true)
  assert.equal(estimateAmrDurationMs(amr1000ms), 1000)

  // 非法帧模式立即终止统计，不越界
  const corrupted = Buffer.concat([makeSyntheticAmrNb(2, 7), Buffer.from([0x0b << 3, 0x01, 0x02])])
  assert.equal(estimateAmrDurationMs(corrupted), 40)
})

test('isOggOpusBytes 与 estimateOggOpusDurationMs 正确解析 Opus 页时长', () => {
  assert.equal(isOggOpusBytes(Buffer.from('ID3\x04\x00\x00')), false)
  const ogg3s = makeSyntheticOggOpus(48_000 * 3)
  assert.equal(isOggOpusBytes(ogg3s), true)
  assert.equal(estimateOggOpusDurationMs(ogg3s), 3000)

  // 前一页正 granulePos，尾页 granulePos=-1（未完结页）时回退取有效页
  const pageValid = makeSyntheticOggOpus(48_000 * 2)
  const pageTrailing = Buffer.alloc(27, 0)
  Buffer.from('OggS', 'ascii').copy(pageTrailing, 0)
  pageTrailing[4] = 0
  pageTrailing.writeBigInt64LE(-1n, 6)
  assert.equal(estimateOggOpusDurationMs(Buffer.concat([pageValid, pageTrailing])), 2000)
})
