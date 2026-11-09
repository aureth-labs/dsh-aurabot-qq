import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMediaAccess } from '../src/core/media.js'
import { buildWav } from '../src/voice/wav.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
test('模块读取当前头像和当前表情库字节；不接受任意路径、不泄漏路径，模块切换即时生效', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-module-media-')), old = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = join(dir, 'data')
  t.after(() => { if (old === undefined) delete process.env.AURABOT_DATA_DIR; else process.env.AURABOT_DATA_DIR = old; rmSync(dir, { recursive: true, force: true }) })
  mkdirSync(join(dir, 'assets'), { recursive: true }); mkdirSync(join(dir, 'data', 'stickers'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'dafeiyu.jpg'), png)
  let running = { library: () => ({ items: [{ md5: 'a'.repeat(32), file: 'test.png' }] }) }
  const media = createMediaAccess({ root: dir, use: () => running, config: () => ({}) })
  assert.deepEqual(media.avatar(), { bytes: png, type: 'image/png' })
  writeFileSync(join(dir, 'data', 'avatar.img'), Buffer.from('not image'))
  assert.equal(media.avatar(), null)
  writeFileSync(join(dir, 'data', 'avatar.img'), png)
  assert.deepEqual(media.avatar(), { bytes: png, type: 'image/png' })
  assert.equal(media.sticker('a'.repeat(32)), null)
  writeFileSync(join(dir, 'data', 'stickers', 'test.png'), png)
  assert.deepEqual(media.sticker('a'.repeat(32)), { bytes: png, type: 'image/png' })
  assert.equal(media.sticker('../../avatar.img'), null)
  running = null; assert.equal(media.sticker('a'.repeat(32)), null)
  unlinkSync(join(dir, 'data', 'avatar.img')); unlinkSync(join(dir, 'assets', 'dafeiyu.jpg'))
  assert.equal(media.avatar(), null)
})

test('媒体辅助沿用文件头、PCM WAV 转换和现有 ffmpeg 配置', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-module-media-wav-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const executable = join(dir, 'configured-ffmpeg'); writeFileSync(executable, '')
  const media = createMediaAccess({ root: dir, use: () => null, config: () => ({ bili: { ffmpegPath: executable } }) })
  assert.equal(media.ffmpegPath(), executable); assert.equal(media.mimeOf(png), 'image/png')
  const input = buildWav(new Int16Array(800), 8000), converted = media.toMono16k(input), parsed = media.parseWav(converted)
  assert.equal(parsed.rate, 16000); assert.equal(parsed.channels, 1); assert.equal(parsed.data.length, 3200)
  assert.throws(() => media.parseWav(Buffer.from('invalid WAV')))
})
