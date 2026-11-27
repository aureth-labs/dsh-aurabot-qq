// RVC 接入后，模块重载、只读列表、原声回退和现有人格应继续可用。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import voiceModule from '../src/modules/voice/index.js'
import { voiceConverters } from '../src/voice/tts.js'
import { buildWav } from '../src/voice/wav.js'
import { normalize } from '../src/core/config.js'
import { seedPersonas } from '../src/persona/personas.js'

function fixture(t, config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-voice-rvc-compat-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const cfg = normalize(config), routes = new Map(), disposers = [], warnings = []
  let song = null
  const api = {
    config: () => cfg, use: () => song, dataDir: (sub) => join(dir, sub),
    core: { hub: {}, onebot: {}, local: { active: () => false }, http: {} },
    route: (path, fn) => routes.set(path, fn), onDispose: (fn) => disposers.push(fn),
    // 模块现在还会注册一个「每小时领 Breeze 额度」的定时任务：这里给个不真起 Timer 的空实现，
    // 免得打乱下面「每个 setup 只有一个 disposer」的断言
    every: () => () => {},
    log: { info() {}, debug() {}, warn: (...args) => warnings.push(args.join(' ')) },
  }
  t.after(() => {
    for (const dispose of disposers) dispose()
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
  })
  return { dir, cfg, api, routes, disposers, warnings, setSong: (value) => { song = value } }
}

test('语音模块反复加载卸载只保留当前转换器，重复旧清理不撤销新实例', (t) => {
  const s = fixture(t), before = [...voiceConverters]
  voiceModule.setup(s.api)
  assert.equal(voiceConverters.length, before.length + 1)
  const oldDispose = s.disposers[0]
  oldDispose()
  assert.deepEqual(voiceConverters, before)
  voiceModule.setup(s.api)
  const current = voiceConverters.at(-1)
  oldDispose()
  assert.equal(voiceConverters.length, before.length + 1)
  assert.equal(voiceConverters.at(-1), current)
  s.disposers[1]()
  assert.deepEqual(voiceConverters, before)
})

test('翻唱音色列表是只读操作，无模块可解释，列出音色不会调用变声', async (t) => {
  const s = fixture(t), before = JSON.stringify(s.cfg)
  voiceModule.setup(s.api)
  const list = s.routes.get('/voice/song-voices')
  const absent = await list()
  assert.equal(absent.available, false)
  assert.deepEqual(absent.voices, [])
  let converted = 0
  s.setSong({ status: () => ({ ready: true, voices: [{ id: 'fixture', hasIndex: true }] }),
    convertSpeech: async () => { converted++; throw new Error('不应调用') } })
  const ready = await list()
  assert.equal(ready.available, true)
  assert.equal(ready.voices[0].id, 'fixture')
  assert.equal(converted, 0)
  assert.equal(JSON.stringify(s.cfg), before)
})

test('RVC 返回空结果或转换失败时，真实 TTS 后处理链仍返回原声文件', async (t) => {
  const s = fixture(t, { voice: { engine: 'http', http: { urlTemplate: 'https://fixture.invalid/tts?text={text}' }, songVoice: 'fixture' } })
  const bytes = buildWav(new Int16Array(800), 16000)
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(bytes, { headers: { 'content-type': 'audio/wav' } })
  t.after(() => { globalThis.fetch = previousFetch })
  const voice = voiceModule.setup(s.api)
  for (const failure of ['empty', 'throw']) {
    s.setSong({ convertSpeech: async () => { if (failure === 'throw') throw new Error('模拟缺少 RVC 环境'); return '' } })
    const result = await voice.speak('本地测试')
    assert.equal(result.engine, 'http')
    assert.deepEqual(readFileSync(result.file), bytes)
  }
  assert.ok(s.warnings.some((line) => line.includes('模拟缺少 RVC 环境')))
})

test('默认人格模板升级不覆盖已存在的自定义人格', (t) => {
  const s = fixture(t)
  const dir = join(s.dir, 'personas'), file = join(dir, 'dafeiyu.md')
  mkdirSync(dir, { recursive: true })
  const custom = Buffer.from('---\nname: 自定义\n---\n保留「已有措辞」及主人自己的设定。\n')
  writeFileSync(file, custom)
  seedPersonas()
  assert.deepEqual(readFileSync(file), custom)
})
