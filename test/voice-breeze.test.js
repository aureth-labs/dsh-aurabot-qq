// Breeze 语音（BreezeBlue）：面板里只填地址 / Key / 音色 id，请求头、路径、body 由插件凑好。
// 起一个本地假服务，看它到底发了什么、音频能不能落盘，顺带验证配置的脱敏与保留。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'aurabot-breeze-'))
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

const { breezeSynth, textToSpeech } = await import('../src/voice/tts.js')
const { breezeBalance, breezeLogin, breezeClaim, breezeSession, shouldAutoClaim, clearBreezeSession, breezeVoices } = await import('../src/voice/breeze.js')
const { DEFAULTS, normalize, publicConfig, mergeFromPanel } = await import('../src/core/config.js')

after(() => {
  server.close()
  delete process.env.AURABOT_DATA_DIR
  try { rmSync(dataDir, { recursive: true, force: true }) } catch (error) {}
})

const mp3 = Buffer.alloc(1200, 0x55)
mp3.write('ID3', 0, 'ascii')

const cfg = (extra = {}) => ({
  url: base,
  key: 'brz_testkey',
  voiceId: 'voc_8yud7hz7c9q2',
  model: 'breeze-tts-2',
  languageCode: 'zh',
  instructions: '',
  outputFormat: 'mp3_24000_128',
  guidanceScale: 0,
  timeoutMs: 5000,
  ...extra,
})

test('Breeze：路径 / 头 / body 都按官方接口来', async () => {
  hits.length = 0
  respond = (res) => { res.writeHead(200, { 'content-type': 'audio/mpeg' }); res.end(mp3) }
  const file = await breezeSynth('晚安啦', cfg({ instructions: '清亮一点', guidanceScale: 4 }))
  assert.ok(file, '要返回落盘后的文件路径')
  assert.ok(readFileSync(file).length > 1000, '音频要真的写出来了')
  assert.equal(hits.length, 1)
  const h = hits[0]
  assert.equal(h.method, 'POST')
  assert.equal(h.url, '/v1/text-to-speech/voc_8yud7hz7c9q2?output_format=mp3_24000_128&delivery=sync')
  assert.equal(h.headers['xi-api-key'], 'brz_testkey')
  const body = JSON.parse(h.body)
  assert.equal(body.text, '晚安啦')
  assert.equal(body.model_id, 'breeze-tts-2')
  assert.equal(body.language_code, 'zh')
  // 云端只用硬音色 id：描述和 strength 都不发（发了音色会往描述漂）
  assert.equal(body.instructions, undefined, '云端不发语气描述')
  assert.equal(body.voice_settings, undefined, '云端不发 guidance / boost')
})

test('Breeze：强度留 0 时不传 voice_settings，语气说明也不传', async () => {
  hits.length = 0
  respond = (res) => { res.writeHead(200, { 'content-type': 'audio/mpeg' }); res.end(mp3) }
  await breezeSynth('嗯', cfg())
  const body = JSON.parse(hits[0].body)
  assert.equal(body.voice_settings, undefined)
  assert.equal(body.instructions, undefined)
})

test('Breeze：引擎选 breeze 时走它，而不是退回 Windows 语音', async () => {
  hits.length = 0
  respond = (res) => { res.writeHead(200, { 'content-type': 'audio/mpeg' }); res.end(mp3) }
  const r = await textToSpeech('今天也辛苦啦', { engine: 'breeze', breeze: cfg() })
  assert.equal(r.engine, 'breeze')
  assert.ok(r.file)
  assert.equal(hits.length, 1)
})

test('Breeze：没填 Key / 音色 id 直接报清楚；401 和「没返回音频」各有提示', async () => {
  await assert.rejects(() => breezeSynth('x', cfg({ key: '' })), /没填 API Key/)
  await assert.rejects(() => breezeSynth('x', cfg({ voiceId: '' })), /没填音色 id/)
  respond = (res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"detail":"invalid api key"}') }
  await assert.rejects(() => breezeSynth('x', cfg()), /Breeze HTTP 401：Key 不对/)
  respond = (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"detail":"quota"}') }
  await assert.rejects(() => breezeSynth('x', cfg()), /没返回音频/)
  // 连不上也要有话说
  await assert.rejects(() => breezeSynth('x', cfg({ url: 'http://127.0.0.1:1' })), /Breeze 连不上/)
})

test('配置：engine 认 breeze，Key 不回显但保存时不会被空值冲掉', () => {
  const cfg1 = normalize({ voice: { engine: 'breeze', breeze: { key: 'brz_abc123', voiceId: 'voc_1' } } })
  assert.equal(cfg1.voice.engine, 'breeze')
  assert.equal(cfg1.voice.breeze.voiceId, 'voc_1')
  assert.equal(cfg1.voice.breeze.url, DEFAULTS.voice.breeze.url, '地址没填就用默认云端')
  // 面板拿到的配置里 Key 被抹掉，只留 keySet
  const shown = publicConfig(cfg1).voice.breeze
  assert.equal(shown.key, '')
  assert.equal(shown.keySet, true)
  // 面板保存时 Key 留空 = 保留原值
  const merged = mergeFromPanel(cfg1, { voice: { breeze: { key: '', voiceId: 'voc_2' } } })
  assert.equal(merged.voice.breeze.key, 'brz_abc123')
  assert.equal(merged.voice.breeze.voiceId, 'voc_2')
})

test('Breeze 本地模式：multipart 表单打到 /v1/audio/speech', async () => {
  hits.length = 0
  respond = (res) => { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(mp3) }
  const file = await breezeSynth('本地念一句', { mode: 'local', url: base, instructions: '温柔一点', guidanceScale: 3, timeoutMs: 5000 })
  assert.ok(file)
  const h = hits[0]
  assert.equal(h.method, 'POST')
  assert.equal(h.url, '/v1/audio/speech')
  assert.match(h.headers['content-type'] || '', /multipart\/form-data/)
  const body = h.body
  assert.match(body, /name="text"/)
  assert.match(body, /本地念一句/)
  assert.match(body, /name="instruction"/)
  assert.match(body, /温柔一点/)
  assert.match(body, /name="cfg_scale"/)
  // 本地模式不需要 Key / 音色 id
  assert.equal(body.includes('xi-api-key'), false)
})

test('Breeze 本地模式：撞上「正在合成」时给清楚提示', async () => {
  respond = (res) => { res.writeHead(409, { 'content-type': 'application/json' }); res.end('{"detail":"already running"}') }
  await assert.rejects(
    () => breezeSynth('x', { mode: 'local', url: base, timeoutMs: 5000 }),
    /本地正在合成上一句/,
  )
})

// ── 云端额度：查余额 / 登录 / 每日领取 ────────────────────────────────
const acct = (extra = {}) => ({ mode: 'cloud', autoClaim: true, url: base, siteUrl: base, key: 'brz_testkey', email: 'me@example.com', password: 'pw', timeoutMs: 5000, ...extra })

test('Breeze 额度：余额能读到，Key 不对和没填 Key 各有说法', async () => {
  respond = (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"balance":1362}') }
  const ok = await breezeBalance(acct())
  assert.equal(ok.ok, true)
  assert.equal(ok.balance, 1362)
  respond = (res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{}') }
  const bad = await breezeBalance(acct())
  assert.equal(bad.ok, false)
  assert.match(bad.note, /Key 不对/)
  const none = await breezeBalance({ url: base, key: '' })
  assert.equal(none.hasKey, false)
  assert.match(none.note, /没填 API Key/)
})

test('Breeze 额度：登录拿 Cookie 存盘，领取用 discord 档', async () => {
  clearBreezeSession()
  hits.length = 0
  respond = (res) => {
    const u = hits.at(-1).url
    if (u.startsWith('/api/auth/email/continue')) {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'breeze_sess=abc123; Path=/; HttpOnly' })
      res.end('{"ok":true}')
      return
    }
    if (u.startsWith('/api/credits/daily-claim')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true,"reward":400,"message":"领到 400"}')
      return
    }
    res.writeHead(404); res.end('{}')
  }
  const cookie = await breezeLogin(acct())
  assert.match(cookie, /breeze_sess=abc123/)
  assert.equal(breezeSession().cookie, cookie, '会话要存到盘上')
  const r = await breezeClaim(acct())
  assert.equal(r.ok, true)
  assert.equal(r.tier, 'discord')
  assert.equal(r.reward, 400)
  const claimHit = hits.filter((x) => x.url.startsWith('/api/credits/daily-claim')).at(-1)
  assert.equal(JSON.parse(claimHit.body).reward_tier, 'discord')
  assert.match(claimHit.headers.cookie || '', /breeze_sess=abc123/, '领取要带上登录 Cookie')
})

test('Breeze 额度：Cookie 过期自动重登一次；discord 档被拒降级 standard', async () => {
  clearBreezeSession()
  hits.length = 0
  let claimTimes = 0
  respond = (res) => {
    const u = hits.at(-1).url
    if (u.startsWith('/api/auth/email/continue')) {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'breeze_sess=new; Path=/' })
      res.end('{"ok":true}')
      return
    }
    if (u.startsWith('/api/credits/daily-claim')) {
      claimTimes++
      const body = JSON.parse(hits.at(-1).body)
      if (claimTimes === 1) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"unauthorized"}'); return }
      if (body.reward_tier === 'discord') { res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"error":"tier not allowed"}'); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true,"reward":100}')
      return
    }
    res.writeHead(404); res.end('{}')
  }
  const r = await breezeClaim(acct())
  assert.equal(r.ok, true)
  assert.equal(r.tier, 'standard', 'discord 被拒就降级 standard')
  assert.equal(r.reward, 100)
  assert.equal(hits.filter((x) => x.url.startsWith('/api/auth/email/continue')).length, 2, '401 之后要重登一次')
})

test('Breeze 额度：自动领取有门槛（选中的引擎 / 云端模式 / 开关 / 账号 / 一天一次）', async () => {
  clearBreezeSession()
  const cfg = (voice) => ({ voice })
  const b = acct()
  assert.equal(shouldAutoClaim(cfg({ engine: 'breeze', breeze: b })), true)
  assert.equal(shouldAutoClaim(cfg({ engine: 'edge', breeze: b })), false, '没选 Breeze 就不领')
  assert.equal(shouldAutoClaim(cfg({ engine: 'breeze', breeze: { ...b, mode: 'local' } })), false, '本地自建不领')
  assert.equal(shouldAutoClaim(cfg({ engine: 'breeze', breeze: { ...b, autoClaim: false } })), false, '开关关了不领')
  assert.equal(shouldAutoClaim(cfg({ engine: 'breeze', breeze: { ...b, email: '' } })), false, '没账号不领')
  // 刚领过就不再领
  respond = (res) => {
    const u = hits.at(-1).url
    if (u.startsWith('/api/auth/email/continue')) {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'breeze_sess=abc; Path=/' })
      res.end('{"ok":true}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true,"reward":400}')
  }
  await breezeClaim(b)
  assert.equal(shouldAutoClaim(cfg({ engine: 'breeze', breeze: b })), false, '刚领过当天不再领')
})

test('Breeze 云端只认硬音色 id：配了描述和强度也不发出去（换了描述音色才会漂）', async () => {
  hits.length = 0
  respond = (res) => { res.writeHead(200, { 'content-type': 'audio/mpeg' }); res.end(mp3) }
  await breezeSynth('嗯', cfg({ instructions: '雄厚的男声', guidanceScale: 6 }))
  const body = JSON.parse(hits.at(-1).body)
  assert.equal(body.instructions, undefined)
  assert.equal(body.voice_settings, undefined)
  assert.equal(hits[0].url.includes('voc_8yud7hz7c9q2'), true, '音色只由 URL 里的 id 决定')
})

test('Breeze 音色列表：把 /v1/voices 映射成面板能用的 id/名字', async () => {
  respond = (res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      voices: [
        { voice_id: 'voc_aaa', name: '大肥鱼（迷糊版）', origin: 'cloned', description: '明亮的少女音', preview_url: 'https://x/1.mp3' },
        { voiceId: 'voc_bbb', title: '哈基米娘', voice_type: 'default' },
        { name: '没有 id 的要被过滤掉' },
      ],
    }))
  }
  const r = await breezeVoices({ url: base, key: 'brz_k', timeoutMs: 5000 })
  assert.equal(r.ok, true)
  assert.equal(r.voices.length, 2, '没有 id 的丢掉')
  assert.deepEqual(r.voices[0], { id: 'voc_aaa', name: '大肥鱼（迷糊版）', origin: 'cloned', desc: '明亮的少女音', preview: 'https://x/1.mp3' })
  assert.equal(r.voices[1].id, 'voc_bbb')
  // 没 Key / Key 不对各有说法
  assert.match((await breezeVoices({ url: base, key: '' })).message, /没填 API Key/)
  respond = (res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{}') }
  assert.match((await breezeVoices({ url: base, key: 'brz_k', timeoutMs: 5000 })).message, /Key 不对/)
})