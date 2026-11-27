// #10 翻唱自动定变调：估原唱中位音高、按她的声线定整八度变调；缓存清理不把记变调的旁注当成品。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { medianF0, autoShift, voiceKind, pcm16ToFloat } from '../src/song/pitch.js'
import { pruneCache } from '../src/song/studio.js'
import { normalize } from '../src/core/config.js'

const rate = 8000
function voice (f, sec = 6) {
  const a = new Float32Array(rate * sec)
  let ph = 0
  for (let i = 0; i < a.length; i++) {
    const t = i / rate
    ph += 2 * Math.PI * f * (1 + 0.02 * Math.sin(2 * Math.PI * 5 * t)) / rate
    // 每 1.5 秒换一次气：静音帧要被跳过
    a[i] = (t % 1.5) < 1.2 ? 0.3 * Math.sin(ph) + 0.15 * Math.sin(2 * ph) + 0.08 * Math.sin(3 * ph) : 0
  }
  return a
}

test('估中位音高：男声、女声都在几赫兹以内；静音返回 null', () => {
  for (const f of [110, 140, 220, 330]) assert.ok(Math.abs(medianF0(voice(f), rate) - f) < f * 0.03, String(f))
  assert.equal(medianF0(new Float32Array(rate * 3), rate), null)
})

test('自动变调只升降整八度：女声唱男声歌 +12，男声唱女声歌 -12，同类 0，测不出来 null', () => {
  assert.equal(voiceKind(120), 'male')
  assert.equal(voiceKind(240), 'female')
  assert.equal(autoShift(120, 'female'), 12)
  assert.equal(autoShift(240, 'female'), 0)
  assert.equal(autoShift(240, 'male'), -12)
  assert.equal(autoShift(120, 'male'), 0)
  assert.equal(autoShift(null, 'female'), null)
})

test('16 位 PCM 转浮点', () => {
  const b = Buffer.alloc(4); b.writeInt16LE(16384, 0); b.writeInt16LE(-32768, 2)
  assert.deepEqual([...pcm16ToFloat(b)], [0.5, -1])
})

test('缓存清理只按成品计数，旁注跟着成品一起删', () => {
  const dir = mkdtempSync(join(tmpdir(), 'song-cache-'))
  for (let i = 0; i < 4; i++) {
    writeFileSync(join(dir, `s${i}.mp3`), 'x'); writeFileSync(join(dir, `s${i}.mp3.json`), '{"pitch":12}')
    const t = new Date(Date.now() - (10 - i) * 60_000)
    utimesSync(join(dir, `s${i}.mp3`), t, t)
  }
  assert.equal(pruneCache(dir, 2), 2)
  assert.deepEqual(readdirSync(dir).sort(), ['s2.mp3', 's2.mp3.json', 's3.mp3', 's3.mp3.json'])
})

test('配置：自动定变调默认开，声线默认女声，乱填回默认', () => {
  const c = normalize({})
  assert.equal(c.song.autoPitch, true)
  assert.equal(c.song.selfVoice, 'female')
  assert.equal(normalize({ song: { selfVoice: 'robot' } }).song.selfVoice, 'female')
  assert.equal(normalize({ song: { selfVoice: 'male', autoPitch: false } }).song.autoPitch, false)
})
