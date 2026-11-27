// MiniMax 语音：面板里只填 API Key + Voice ID，模型 / 请求体 / 音频解码都由插件凑好。
// 起一个本地假服务，看它到底发了什么、hex 音频能不能还原成文件。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 生成的音频别落到主人真实的语音缓存里
const dataDir = mkdtempSync(join(tmpdir(), 'aurabot-minimax-'))
process.env.AURABOT_DATA_DIR = dataDir

const hits = []
let respond = () => {}
const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    hits.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
    respond(res)
  })
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const base = `http://127.0.0.1:${server.address().port}`

const { minimaxSynth, textToSpeech } = await import('../src/voice/tts.js')
const { normalize, publicConfig, mergeFromPanel, DEFAULTS } = await import('../src/core/config.js')

const mp3 = Buffer.alloc(900, 0x55)
mp3.write('ID3', 0, 'ascii')
const hex = mp3.toString('hex')
const okBody = (base = {}) => JSON.stringify({
  data: { audio: hex, status: 2 },
  extra_info: { usage_characters: 4, audio_length: 1200 },
  base_resp: { status_code: 0, status_msg: 'success', ...base },
})
const conf = (extra = {}) => ({ apiKey: 'sk-api-test', baseUrl: base, voiceId: 'Chinese (Mandarin)_Soft_Girl', ...extra })
const json = (res, body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body) }

after(() => {
  server.close()
  rmSync(dataDir, { recursive: true, force: true })
})

test('正常合成：Bearer 鉴权，hex 还原成 mp3，落在插件的数据目录里', async () => {
  hits.length = 0
  respond = (res) => json(res, okBody())

  const file = await minimaxSynth('你好呀', conf())
  assert.equal(readFileSync(file).length, mp3.length, 'hex 要还原成完整文件')
  assert.ok(file.startsWith(dataDir), '音频要落在插件的数据目录里，不能写到外面')

  const h = hits[0]
  assert.equal(h.method, 'POST')
  assert.equal(h.url, '/v1/t2a_v2')
  assert.equal(h.headers.authorization, 'Bearer sk-api-test')
  const body = JSON.parse(h.body)
  assert.equal(body.model, 'speech-2.8-turbo')
  assert.equal(body.text, '你好呀')
  assert.equal(body.voice_setting.voice_id, 'Chinese (Mandarin)_Soft_Girl')
  assert.equal(body.output_format, 'hex', '要 hex，插件自己解码')
  assert.equal(body.audio_setting.format, 'mp3')
})

test('情绪：auto 不传字段，显式指定才发（某些音色不认 emotion）', async () => {
  hits.length = 0
  respond = (res) => json(res, okBody())

  await minimaxSynth('开心', conf({ emotion: 'auto' }))
  assert.equal(JSON.parse(hits[0].body).voice_setting.emotion, undefined)

  await minimaxSynth('开心', conf({ emotion: 'happy' }))
  assert.equal(JSON.parse(hits[1].body).voice_setting.emotion, 'happy')
})

test('语速 / 语调 / 模型都按配置发', async () => {
  hits.length = 0
  respond = (res) => json(res, okBody())
  await minimaxSynth('慢一点', conf({ speed: 1.1, pitch: 2, model: 'speech-2.8-hd' }))
  const body = JSON.parse(hits[0].body)
  assert.equal(body.voice_setting.speed, 1.1)
  assert.equal(body.voice_setting.pitch, 2)
  assert.equal(body.model, 'speech-2.8-hd')
})

test('textToSpeech 接得上：engine=minimax 时走这个引擎，不退回 Windows 语音', async () => {
  hits.length = 0
  respond = (res) => json(res, okBody())
  const r = await textToSpeech('接线测试', { engine: 'minimax', minimax: conf() })
  assert.equal(r.engine, 'minimax')
  assert.equal(hits.length, 1, '应该正好发一次请求')
})

test('没填 API Key 在本地就拦下来，不发请求', async () => {
  hits.length = 0
  await assert.rejects(() => minimaxSynth('嗨', { apiKey: '  ' }), /API Key/)
  assert.equal(hits.length, 0)
})

test('Key 不对：报错说人话，不是甩一串 code', async () => {
  respond = (res) => json(res, JSON.stringify({ base_resp: { status_code: 1004, status_msg: 'login fail: Please carry the API secret key' } }))
  await assert.rejects(() => minimaxSynth('嗨', conf()), /API Key 没被认出来/)
})

test('余额不足：直接说去充值', async () => {
  respond = (res) => json(res, JSON.stringify({ base_resp: { status_code: 1008, status_msg: 'insufficient balance' } }))
  await assert.rejects(() => minimaxSynth('嗨', conf()), /余额不足/)
})

test('音色 / 情绪不对：点出来是 Voice ID 的问题', async () => {
  respond = (res) => json(res, JSON.stringify({ base_resp: { status_code: 2013, status_msg: 'invalid params' } }))
  await assert.rejects(() => minimaxSynth('嗨', conf()), /Voice ID/)
})

test('不可见字符太多（1042）：提示把符号去掉', async () => {
  respond = (res) => json(res, JSON.stringify({ base_resp: { status_code: 1042, status_msg: 'invalid characters' } }))
  await assert.rejects(() => minimaxSynth('嗨', conf()), /不可见字符/)
})

test('网关挂了回的不是 JSON：带上状态码和原文', async () => {
  respond = (res) => { res.writeHead(502, { 'content-type': 'text/html' }); res.end('<html>bad gateway</html>') }
  await assert.rejects(() => minimaxSynth('嗨', conf()), /MiniMax HTTP 502/)
})

test('回了 base_resp 但音频不是 hex：不落坏文件', async () => {
  respond = (res) => json(res, JSON.stringify({ data: { audio: 'bm90LWhleA==' }, base_resp: { status_code: 0, status_msg: 'success' } }))
  await assert.rejects(() => minimaxSynth('嗨', conf()), /没返回音频/)
})

test('配置归一化：engine 认 minimax，脏值落回安全的一侧', () => {
  const c = normalize({
    voice: { engine: 'minimax', minimax: { apiKey: '  sk-abc  ', voiceId: '', model: 'nope', emotion: 'weird', speed: 9, pitch: -99 } },
  })
  assert.equal(c.voice.engine, 'minimax')
  assert.equal(c.voice.minimax.apiKey, 'sk-abc')
  assert.equal(c.voice.minimax.voiceId, DEFAULTS.voice.minimax.voiceId)
  assert.equal(c.voice.minimax.model, DEFAULTS.voice.minimax.model)
  assert.equal(c.voice.minimax.emotion, 'auto')
  assert.equal(c.voice.minimax.speed, 2)
  assert.equal(c.voice.minimax.pitch, -12)
})

test('voice.minimax 被写成字符串也不炸', () => {
  const c = normalize({ voice: { minimax: 'oops' } })
  assert.equal(c.voice.minimax.voiceId, DEFAULTS.voice.minimax.voiceId)
})

test('面板不回传 API Key 原文，只说存没存', () => {
  const p = publicConfig(normalize({ voice: { minimax: { apiKey: 'sk-secret-123' } } }))
  assert.equal(p.voice.minimax.apiKey, '')
  assert.equal(p.voice.minimax.apiKeySet, true)
})

test('面板没动密码框（传空串）时保留原来的 Key', () => {
  const cur = normalize({ voice: { engine: 'minimax', minimax: { apiKey: 'sk-keep-me' } } })
  const next = mergeFromPanel(cur, { voice: { minimax: { apiKey: '' } } })
  assert.equal(next.voice.minimax.apiKey, 'sk-keep-me')
})
