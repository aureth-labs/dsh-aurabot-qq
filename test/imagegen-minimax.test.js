// MiniMax H3 Image provider：多图参考 / 一次多张 / 和语音共用 Key / 老配置兼容。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createImageGen, minimaxImageBody, minimaxBaseUrl, minimaxImageKey, MINIMAX_IMAGE_MODELS } from '../src/features/imagegen.js'
import { normalize } from '../src/core/config.js'
import imagegenModule from '../src/modules/imagegen/index.js'

const log = { info() {}, warn() {}, debug() {} }
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64, 1)])
const PNG2 = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64, 2)])
const GIF = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(20)])
const config = (extra = {}, voice = {}) => normalize({ imageGen: { enabled: true, provider: 'minimax', ...extra }, voice: { minimax: { apiKey: '', ...voice } } })
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

test('MiniMax 配置有默认值，老配置不受影响；模型名受校验', () => {
  const old = normalize({})
  assert.equal(old.imageGen.provider, 'openai')
  assert.equal(old.imageGen.minimax.model, 'MiniMax-H3-Image')
  assert.equal(old.imageGen.minimax.area, '2K')
  assert.equal(old.imageGen.minimax.n, 1)
  const cfg = normalize({ imageGen: { provider: 'minimax', minimax: { model: '乱写', n: 99, area: '8K', enhance: 'no' } } })
  assert.equal(cfg.imageGen.provider, 'minimax')
  assert.equal(cfg.imageGen.minimax.model, 'MiniMax-H3-Image')
  assert.equal(cfg.imageGen.minimax.n, 10)
  assert.equal(cfg.imageGen.minimax.area, '2K')
  assert.equal(cfg.imageGen.minimax.enhance, true)
  assert.deepEqual(MINIMAX_IMAGE_MODELS, ['MiniMax-H3-Image', 'MiniMax-H3-Image-Highspeed'])
})

test('Key 共用：生图自己的 Key 优先，留空回落到语音的 MiniMax Key', () => {
  assert.equal(minimaxImageKey({ imageGen: { minimax: { apiKey: 'sk-own' } }, voice: { minimax: { apiKey: 'sk-voice' } } }), 'sk-own')
  assert.equal(minimaxImageKey({ imageGen: { minimax: { apiKey: '' } }, voice: { minimax: { apiKey: 'sk-voice' } } }), 'sk-voice')
  assert.equal(minimaxImageKey({}), '')
})

test('minimaxImageBody：文生图默认用提示词增强 + aspect_ratio/area，多张 n 正确', () => {
  const cfg = config()
  const req = minimaxImageBody({ prompt: '一只鲸鱼', size: '1024x1536', count: 3, cfg })
  assert.equal(req.endpoint, 'generations')
  assert.equal(req.body.model, 'MiniMax-H3-Image')
  assert.equal(req.body.prompt, '一只鲸鱼')
  assert.equal(req.body.n, 3)
  assert.equal(req.body.size, 'auto')
  assert.equal(req.body.aspect_ratio, '2:3')
  assert.equal(req.body.area, '2K')
  assert.equal(req.body.response_format, 'b64_json')
  assert.equal(req.body.images, undefined)
  const big = minimaxImageBody({ prompt: 'x', count: 10, cfg: config({ minimax: { area: '4K' } }) })
  assert.equal(big.body.response_format, 'url', '4K 十张超过 b64 面积上限时改用 url')
})

test('minimaxImageBody：多图参考走 /v1/images/edits，每张转成 data URI；最多 16 张由上层校验', () => {
  const req = minimaxImageBody({ prompt: '把猫换成狗', size: '1024x1024', images: [PNG, PNG2], cfg: config() })
  assert.equal(req.endpoint, 'edits')
  assert.equal(req.body.images.length, 2)
  assert.match(req.body.images[0].image_url, /^data:image\/png;base64,/)
  assert.equal(Buffer.from(req.body.images[1].image_url.split(',')[1], 'base64').length, PNG2.length)
})

test('minimaxImageBody：关闭提示词增强时发精确 WxH（小图按比例抬到下限），不再带 aspect_ratio/area', () => {
  const req = minimaxImageBody({ prompt: '猫', size: '512x512', cfg: config({ minimax: { enhance: false } }) })
  assert.equal(req.body.size, '810x810')
  assert.equal(req.body.disable_prompt_enhanced, true)
  assert.equal(req.body.aspect_ratio, undefined)
  assert.equal(req.body.area, undefined)
})

test('createImageGen MiniMax：用语音 Key、请求 /v1/images/generations、解析 b64_json', async () => {
  const cfg = config({}, { apiKey: 'sk-voice-key' })
  const calls = []
  const gen = createImageGen({
    getConfig: () => cfg,
    log,
    local: null,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return json({ data: [{ b64_json: PNG.toString('base64') }] }) },
  })
  assert.equal(gen.enabled(), true)
  assert.equal(gen.notReadyReason(), '')
  const buf = await gen.generate('一只鲸鱼')
  assert.deepEqual(buf, PNG)
  assert.equal(calls[0].url, 'https://api.minimax.cn/v1/images/generations')
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-voice-key')
  assert.equal(JSON.parse(calls[0].init.body).n, 1)
})

test('minimaxImageBody：enhance=false 按实际 size 算 b64 面积（4096x4096 多张改用 url）', () => {
  const req = minimaxImageBody({ prompt: '大图', size: '4096x4096', count: 2, cfg: config({ minimax: { enhance: false } }) })
  assert.equal(req.body.size, '4096x4096')
  assert.equal(req.body.disable_prompt_enhanced, true)
  assert.equal(req.body.response_format, 'url', '2 × 4096² 超过保守的 b64 面积上限')
})

test('minimaxBaseUrl：去掉用户按 OpenAI 习惯填的尾部 /v1，且生成请求只拼一个 /v1', async () => {
  assert.equal(minimaxBaseUrl('https://api.minimax.cn/v1/'), 'https://api.minimax.cn')
  assert.equal(minimaxBaseUrl('https://api.minimax.cn'), 'https://api.minimax.cn')
  for (const base of ['https://api.minimax.cn', 'https://api.minimax.cn/v1']) {
    const cfg = normalize({ imageGen: { enabled: true, provider: 'minimax', minimax: { apiKey: 'sk-test', baseUrl: base } } })
    assert.equal(cfg.imageGen.minimax.baseUrl, 'https://api.minimax.cn')
    const calls = []
    const gen = createImageGen({ getConfig: () => cfg, log, local: null, fetchImpl: async (url) => { calls.push(url); return json({ data: [{ b64_json: PNG.toString('base64') }] }) } })
    await gen.generate('猫')
    assert.equal(calls[0], 'https://api.minimax.cn/v1/images/generations')
  }
})

test('createImageGen MiniMax：参考图是 GIF 时明确拒绝，不请求接口', async () => {
  let calls = 0
  const cfg = config({}, { apiKey: 'sk-test' })
  const gen = createImageGen({ getConfig: () => cfg, log, local: null, fetchImpl: async () => { calls++; return json({ data: [] }) } })
  await assert.rejects(gen.generate('把动图改成静态', { images: [GIF] }), /不支持 GIF.*静态图|GIF.*PNG/)
  assert.equal(calls, 0, 'GIF 参考图不能发到不支持它的接口')
})

test('createImageGen MiniMax：URL 响应会下载成 Buffer', async () => {
  let calls = 0
  const cfg = config({}, { apiKey: 'sk-test' })
  const gen = createImageGen({
    getConfig: () => cfg,
    log,
    local: null,
    fetchImpl: async (url) => {
      calls++
      if (String(url).includes('/images/generations')) return json({ data: [{ url: 'https://1.1.1.1/out.png' }] })
      return new Response(PNG, { headers: { 'content-length': String(PNG.length), 'content-type': 'image/png' } })
    },
  })
  const buf = await gen.generate('猫')
  assert.deepEqual(buf, PNG)
  assert.equal(calls, 2, '接口响应 + 图片下载各一次')
})

test('createImageGen MiniMax：401/429/400 错误带 HTTP 状态和接口说明；空 data 报没有图片', async () => {
  const cfg = config({}, { apiKey: 'sk-test' })
  for (const status of [400, 401, 429]) {
    const gen = createImageGen({ getConfig: () => cfg, log, local: null, fetchImpl: async () => json({ error: { message: 'bad-' + status } }, status) })
    await assert.rejects(gen.generate('猫'), (error) => {
      assert.match(error.message, new RegExp('HTTP ' + status))
      assert.match(error.message, new RegExp('bad-' + status))
      assert.equal(error.imageStatus, status)
      return true
    })
  }
  const empty = createImageGen({ getConfig: () => cfg, log, local: null, fetchImpl: async () => json({ data: [] }) })
  await assert.rejects(empty.generate('猫'), /没有返回图片/)
})

test('createImageGen MiniMax：一次多张返回每张 Buffer；参考图走 edits', async () => {
  const cfg = config({ minimax: { apiKey: 'sk-own', n: 2 } })
  const calls = []
  const gen = createImageGen({
    getConfig: () => cfg,
    log,
    local: null,
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return url.endsWith('/edits')
        ? json({ data: [{ b64_json: PNG.toString('base64') }, { error: { message: '敏感内容' } }] })
        : json({ data: [{ b64_json: PNG.toString('base64') }, { b64_json: PNG2.toString('base64') }] })
    },
  })
  const two = await gen.generate('两张图', { count: 2 })
  assert.ok(Array.isArray(two))
  assert.equal(two.length, 2)
  assert.deepEqual(two[1], PNG2)
  const edited = await gen.generate('换成狗', { images: [PNG, PNG2], count: 1 })
  assert.equal(calls[1].url, 'https://api.minimax.cn/v1/images/edits')
  const body = JSON.parse(calls[1].init.body)
  assert.equal(body.images.length, 2)
  assert.equal(body.images[0].image_url.startsWith('data:image/png;base64,'), true)
  assert.deepEqual(edited, PNG)
  // 不显式给 count 时用面板配置的 n
  assert.equal((await gen.generate('按配置来')).length, 2)
})

test('createImageGen MiniMax：没 Key 时 enabled=false 且提示复用语音 Key；其它接法不接一次多张', async () => {
  const cfg = config()
  const gen = createImageGen({ getConfig: () => cfg, log, local: null, fetchImpl: async () => json({}) })
  assert.equal(gen.enabled(), false)
  assert.match(gen.notReadyReason(), /MiniMax API Key|语音/)
  await assert.rejects(createImageGen({ getConfig: () => config({ provider: 'openai', baseUrl: 'https://x.test/v1', model: 'm' }), log, local: null, fetchImpl: async () => json({}) }).generate('猫', { count: 2 }), /只支持 MiniMax/)
})

test('qq_draw_image：count 多张时逐张发送、存盘、给编号', async (t) => {
  const old = process.env.AURABOT_DATA_DIR
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-minimax-'))
  process.env.AURABOT_DATA_DIR = dir
  t.after(() => { if (old == null) delete process.env.AURABOT_DATA_DIR; else process.env.AURABOT_DATA_DIR = old; rmSync(dir, { recursive: true, force: true }) })
  t.mock.method(globalThis, 'fetch', async () => json({ data: [{ b64_json: PNG.toString('base64') }, { b64_json: PNG2.toString('base64') }] }))
  let build
  const sent = []
  const cfg = config({ seeOwn: false }, { apiKey: 'sk-voice' })
  const hub = {
    turnSendersAllOwner: () => true,
    sendText: async () => ({ message_id: 1 }),
    sendSegments: async (...args) => { sent.push(args); return { message_id: 1 } },
    canSeeImages: async () => false,
    lastTextOf: () => '',
  }
  imagegenModule.setup({
    config: () => cfg,
    log,
    dsh: {},
    lazy: () => ({}),
    route() {},
    tool: (fn) => { build = fn },
    core: { hub, local: { active: () => false } },
  })
  const tool = build({ chat: { kind: 'private', chatId: 'private:10001', userId: '10001' }, sessionId: 'minimax-test' })
  assert.ok(tool.parameters.properties.count, '工具要暴露 count')
  assert.ok(tool.parameters.properties.images, '工具要暴露 images')
  const out = await tool.execute({ prompt: '画两张鲸鱼', notice: '好，画两张。', count: 2 })
  assert.equal(out.ok, true, out.message)
  assert.equal(out.count, 2)
  assert.equal(out.paths.length, 2)
  assert.equal(sent[0][1].length, 2, '两张图要一起发给 QQ')
  assert.match(out.message, /一共画了 2 张/)
  assert.match(out.message, /画作编号 #2、#1/)
})
