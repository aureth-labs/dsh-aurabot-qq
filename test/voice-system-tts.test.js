// #255：系统自带语音兜底按平台选，自检不再写死 Windows 语音，拿到的非 WAV 也能转成识别用的 PCM16 WAV。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { systemVoiceEngine, edgeAllowed } from '../src/voice/tts.js'
import { asPcmWav } from '../src/modules/voice/index.js'
import { buildWav } from '../src/voice/wav.js'

test('系统语音兜底：Windows 用系统语音、macOS 用 say、其它平台没有', () => {
  assert.equal(systemVoiceEngine('win32'), 'windows')
  assert.equal(systemVoiceEngine('darwin'), 'say')
  assert.equal(systemVoiceEngine('linux'), '')
})

test('明确要系统语音时不再先试 edge（否则 macOS 会被 edge 截走）', () => {
  assert.equal(edgeAllowed('say'), false)
  assert.equal(edgeAllowed('windows'), false)
  assert.equal(edgeAllowed(''), true)
  assert.equal(edgeAllowed('volcano'), true)
})

test('自检：有系统语音就先用系统语音，不再写死 windows', () => {
  const src = readFileSync(new URL('../src/modules/voice/index.js', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /textToSpeech\(text, \{ engine: 'windows' \}\)/)
  assert.match(src, /const system = systemVoiceEngine\(\)/)
  assert.match(src, /textToSpeech\(text, system \? \{ engine: system \} : \{\}\)/)
  assert.match(src, /toMono16k\(asPcmWav\(file, readFileSync\(file\)/)
})

test('PCM16 WAV 直接放行，不再调 ffmpeg', () => {
  const wav = buildWav(new Int16Array([0, 1, -1, 2]), 16000)
  assert.equal(asPcmWav('x.wav', wav), wav)
})

test('非 WAV（比如 edge 的 mp3）没有 ffmpeg 时给人话错误，不抛「不是 WAV」', () => {
  const mp3 = Buffer.from('ID3xxxx', 'ascii')
  const noFfmpeg = { findFfmpegFn: () => '' }
  assert.throws(() => asPcmWav('x.mp3', mp3, '', { ...noFfmpeg, platform: 'linux' }), /不是 PCM16 WAV.*ffmpeg/)
  assert.throws(() => asPcmWav('x.mp3', mp3, '', { ...noFfmpeg, platform: 'darwin' }), /不是 PCM16 WAV.*ffmpeg/)
})

test('非 WAV 有 ffmpeg 时真走转换：读回转换结果并清掉临时文件', async () => {
  const { mkdtempSync, writeFileSync, existsSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-asr-conv-'))
  const input = join(dir, 'in.mp3')
  writeFileSync(input, 'ID3xxxx')
  const wav = buildWav(new Int16Array([0, 1, -1, 2]), 16000)
  const runFn = (bin, args) => { writeFileSync(args.at(-1), wav); return { status: 0, stderr: '' } }
  try {
    const out = asPcmWav(input, Buffer.from('ID3xxxx'), '', { findFfmpegFn: () => '/fake/ffmpeg', runFn })
    assert.deepEqual(out, wav)
    assert.equal(existsSync(join(dir, 'in.16k.wav')), false, '转换后的临时文件要清掉')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('转换失败时报清楚原因，不留下临时文件', async () => {
  const { mkdtempSync, writeFileSync, existsSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-asr-conv-'))
  const input = join(dir, 'in.mp3')
  writeFileSync(input, 'ID3xxxx')
  const runFn = () => ({ status: 1, stderr: 'Invalid data found when processing input' })
  try {
    assert.throws(() => asPcmWav(input, Buffer.from('ID3xxxx'), '', { findFfmpegFn: () => '/fake/ffmpeg', runFn }), /音频转 WAV 失败.*Invalid data/)
    assert.equal(existsSync(join(dir, 'in.16k.wav')), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('macOS say 调用把文本放在 -- 之后，避免正文被当成选项', () => {
  const src = readFileSync(new URL('../src/voice/tts.js', import.meta.url), 'utf8')
  assert.match(src, /'--data-format=LEI16@16000'[\s\S]{0,80}'--', text\]/)
})
