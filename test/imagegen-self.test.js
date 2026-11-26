// 自画像参考图与文字回退：全部使用假模型、假发送和临时文件。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize } from '../src/core/config.js'
import { createImageGen, customRequest, isUnsupportedReference } from '../src/features/imagegen.js'
import { createLocal } from '../src/local/local.js'
import imagegenModule from '../src/modules/imagegen/index.js'

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(64)])
const log = { info() {}, debug() {}, warn() {} }
const cfgOf = (imageGen = {}) => normalize({ imageGen: { enabled: true, baseUrl: 'https://image.example/v1', model: 'draw', seeOwn: false, stylePrompt: '水彩', ...imageGen } })
const response = () => new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
function sandbox(t) {
  const old = process.env.AURABOT_DATA_DIR
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-self-'))
  process.env.AURABOT_DATA_DIR = dir
  t.after(() => {
    if (old === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = old
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}
function setup(cfg, { look = { image: PNG, appearance: '蓝色短发' }, owner = true, local, send = true, external } = {}) {
  let build, reads = 0
  const sent = [], events = [], notices = [], lookSessions = []
  const gen = imagegenModule.setup({
    config: () => cfg, log, dsh: {}, route() {}, tool: (fn) => { build = fn },
    lazy: (id) => id === 'dsh-image' ? external : { addEvent: (e) => events.push(e) },
    core: { local, ask: async () => '', personas: { look: (sessionId) => { reads++; lookSessions.push(sessionId); return look } }, hub: {
      turnSendersAllOwner: () => owner, canSeeImages: async () => false,
      modelFor: () => null, lastTextOf: () => '',
      sendText: async (...args) => { notices.push(args); return send },
      referenceImage: () => { throw new Error('self 不应读取聊天图片') },
      sendSegments: async (...args) => { sent.push(args); return send },
    } },
  })
  const tool = build({ chat: { kind: 'private', chatId: 'private:10001', userId: '10001' }, sessionId: 'self-test' })
  return { tool, gen, sent, events, notices, lookSessions, reads: () => reads }
}

test('self 多图按顺序传入并附对应备注，单图服务仅用第一张，全部关闭不读旧 image', async (t) => {
  sandbox(t)
  const seen = []
  t.mock.method(globalThis, 'fetch', async (url, init) => { seen.push({ url, init }); return response() })
  const refs = [{ image: PNG, note: '工作服' }, { image: Buffer.concat([PNG, Buffer.from([1])]), note: 'Q版形象' }]
  const multi = setup(cfgOf(), { look: { references: refs, appearance: '蓝色短发' } })
  const out = await multi.tool.execute({ prompt: '上班', image: 'self' })
  assert.equal(out.ok, true, out.message)
  assert.equal(out.referenceCount, 2)
  const files = seen[0].init.body.getAll('image[]')
  assert.equal(files.length, 2)
  assert.deepEqual(Buffer.from(await files[1].arrayBuffer()), refs[1].image)
  assert.match(seen[0].init.body.get('prompt'), /参考图 1 备注："工作服"/)
  assert.match(seen[0].init.body.get('prompt'), /参考图 2 备注："Q版形象"/)
  const single = setup(cfgOf({ model: 'dall-e-2' }), { look: { references: refs } })
  const one = await single.tool.execute({ prompt: '上班', image: 'self' })
  assert.equal(one.referenceCount, 1)
  assert.match(one.message, /最多支持 1 张/)
  assert.doesNotMatch(seen[1].init.body.get('prompt'), /Q版/)
  const off = setup(cfgOf(), { look: { image: PNG, references: [], appearance: '蓝色短发' } })
  assert.equal((await off.tool.execute({ prompt: '散步', image: 'self' })).referenceCount, 0)
  assert.match(seen[2].url, /generations$/)
})

test('self 明确单图错误只重试第一张，移除未使用备注；普通错误不重复生成', async (t) => {
  sandbox(t)
  const seen = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen.push({ url, init })
    return seen.length === 1 ? new Response(JSON.stringify({ error: { message: 'Only one image is supported' } }), { status: 400 }) : response()
  })
  const s = setup(cfgOf(), { look: { references: [{ image: PNG, note: '常服' }, { image: PNG, note: '工作服' }] } })
  const out = await s.tool.execute({ prompt: '散步', image: 'self' })
  assert.equal(out.ok, true, out.message)
  assert.equal(seen.length, 2)
  assert.equal(out.referenceCount, 1)
  assert.match(out.message, /仅支持单张/)
  assert.doesNotMatch(seen[1].init.body.get('prompt'), /工作服/)
})

test('服务明确多图不支持或上限2张时按数量降级；未使用图片不读取', async (t) => {
  sandbox(t)
  for (const [message, count] of [['This endpoint does not support multiple images', 1], ['This endpoint supports at most 2 images', 2]]) {
    const seen = []
    const mock = t.mock.method(globalThis, 'fetch', async (_url, init) => { seen.push(init); return seen.length === 1 ? new Response(JSON.stringify({ message }), { status: 400 }) : response() })
    const s = setup(cfgOf(), { look: { references: [{ image: PNG }, { image: PNG }, { image: PNG }] } })
    const out = await s.tool.execute({ image: 'self', prompt: '散步' })
    assert.equal(out.ok, true, out.message)
    assert.equal(out.referenceCount, count)
    assert.equal(seen.length, 2)
    mock.mock.restore()
  }
  t.mock.method(globalThis, 'fetch', async () => response())
  const bad = { get image() { throw new Error('不应读取未使用图片') } }
  for (const cfg of [cfgOf({ img2img: false }), cfgOf({ model: 'dall-e-2' })]) {
    const refs = cfg.imageGen.img2img ? [{ image: PNG }, bad] : [bad]
    const s = setup(cfg, { look: { references: refs, appearance: '蓝发' } })
    assert.equal((await s.tool.execute({ image: 'self', prompt: '散步' })).ok, true)
  }
})

test('custom images 为 JSON 数组，单图旧参数保持兼容；本地声明数量限制', async () => {
  const cfg = cfgOf({ provider: 'custom', custom: { method: 'POST', url: 'https://image.example/edit', params: [{ key: 'refs', value: '{images}' }] } })
  const req = customRequest(cfg.imageGen, '散步', PNG, [PNG, PNG])
  assert.deepEqual(JSON.parse(req.body).refs, [PNG.toString('base64'), PNG.toString('base64')])
  assert.equal(await createImageGen({ getConfig: () => cfg, log }).referenceLimit(), 8)
  const local = { active: () => true, referenceLimit: async () => 3, call: async (_slot, args) => { assert.equal(args.images.length, 2); assert.equal(args.image, undefined); return PNG } }
  const gen = createImageGen({ getConfig: () => cfgOf(), log, local })
  assert.equal(await gen.referenceLimit(), 3)
  assert.deepEqual(await gen.generate('散步', { images: [PNG, PNG] }), PNG)
})

test('本地多图脚本按声明上限接收数组，单图也兼容数组入口', async (t) => {
  const dir = sandbox(t), cfg = cfgOf()
  cfg.local.image = true
  mkdirSync(join(dir, 'local'), { recursive: true })
  writeFileSync(join(dir, 'local', 'image.mjs'), `export const supportsImages = true; export const maxReferenceImages = 2; export default async ({images}) => { if (!Array.isArray(images) || images.length > 2) throw new Error('数组错误'); return {base64:images[0]} }`)
  const local = createLocal({ getConfig: () => cfg, log })
  assert.equal(await local.referenceLimit(), 2)
  const s = setup(cfg, { local, look: { references: [{ image: PNG }, { image: PNG }, { image: PNG }] } })
  const out = await s.tool.execute({ image: 'self', prompt: '散步' })
  assert.equal(out.ok, true, out.message)
  assert.equal(out.referenceCount, 2)
  assert.match(out.message, /最多支持 2 张/)
  assert.deepEqual(await s.gen.generate('散步', { image: PNG }), PNG)
})

test('self 别名：OpenAI edits 收到原图、外貌、构图；发送存图一次', async (t) => {
  sandbox(t)
  const seen = []
  t.mock.method(globalThis, 'fetch', async (url, init) => { seen.push({ url, init }); return response() })
  const s = setup(cfgOf())
  for (const image of ['self', ' SELF ', '自己', '人设图']) {
    const out = await s.tool.execute({ prompt: '海边散步', image, shape: 'portrait' })
    assert.equal(out.ok, true, out.message)
    assert.doesNotMatch(out.message, /形象一致性有限|已保存到本机/)
    assert.match(out.message, /画作编号/)
    const request = seen.at(-1)
    assert.match(request.url, /images\/edits$/)
    assert.deepEqual(Buffer.from(await request.init.body.get('image').arrayBuffer()), PNG)
    assert.equal(request.init.body.get('prompt'), '水彩，角色外貌：蓝色短发\n画面要求：海边散步')
    assert.equal(request.init.body.get('size'), '1024x1536')
  }
  assert.equal(seen.length, 4)
  assert.equal(s.sent.length, 4)
  assert.equal(s.events.length, 4)
  assert.match(s.events[0].text, /参考了一张图/)
})

test('能力矩阵与自画像文字回退：custom、Codex、img2img 关闭、本地旧脚本', async (t) => {
  const dir = sandbox(t)
  for (const custom of [
    { url: 'https://image.example/draw?text={prompt}' },
    { url: 'https://image.example/draw#{image}' },
    { method: 'POST', url: 'https://image.example/draw', params: [{ key: 'image', value: '{image}' }, { key: 'image', value: '' }] },
  ]) assert.equal(await createImageGen({ getConfig: () => cfgOf({ provider: 'custom', custom }), log }).supportsReference(), false)
  assert.equal(await createImageGen({ getConfig: () => cfgOf({ provider: 'custom', custom: { url: 'https://image.example/draw?image={image}' } }), log }).supportsReference(), true)
  const codex = createImageGen({ getConfig: () => cfgOf({ provider: 'codex' }), log })
  assert.equal(await codex.supportsReference(), false)
  const seen = []
  t.mock.method(globalThis, 'fetch', async (url, init) => { seen.push({ url, init }); return url.endsWith('/draw') ? new Response(PNG, { headers: { 'content-type': 'image/png' } }) : response() })
  for (const extra of [{ img2img: false }, { provider: 'custom', custom: { method: 'POST', url: 'https://image.example/draw', params: [{ key: 'prompt', value: '{prompt}' }] } }]) {
    const s = setup(cfgOf(extra))
    const out = await s.tool.execute({ prompt: '散步', image: 'self' })
    assert.equal(out.ok, true, out.message)
    assert.match(out.message, /仅按外貌文字生成，形象一致性有限/)
    assert.match(JSON.parse(seen.at(-1).init.body).prompt, /蓝色短发/)
    assert.equal(JSON.parse(seen.at(-1).init.body).image, undefined)
    assert.match(s.events[0].text, /按提示词画/)
  }
  const cfg = cfgOf()
  cfg.local.image = true
  mkdirSync(join(dir, 'local'), { recursive: true })
  writeFileSync(join(dir, 'local', 'image.mjs'), `export default async ({ image, prompt }) => { if (image || !prompt.includes('蓝色短发')) throw new Error('参数错误'); return Buffer.from('${PNG.toString('base64')}', 'base64') }`)
  const local = createLocal({ getConfig: () => cfg, log })
  const s = setup(cfg, { local })
  assert.equal(await s.gen.supportsReference(), false)
  const out = await s.tool.execute({ prompt: '散步', image: 'self' })
  assert.equal(out.ok, true, out.message)
  assert.match(out.message, /形象一致性有限/)
})

test('custom GET 的图片参数放在 fragment 之前，能力声明与实际请求一致', async () => {
  const cfg = cfgOf({ provider: 'custom', custom: { method: 'GET', url: 'https://image.example/draw#preview', params: [{ key: 'image', value: '{image}' }] } })
  assert.equal(await createImageGen({ getConfig: () => cfg, log }).supportsReference(), true)
  const request = customRequest(cfg.imageGen, '散步', PNG)
  assert.equal(new URL(request.url).searchParams.get('image'), PNG.toString('base64'))
  assert.equal(new URL(request.url).hash, '#preview')
})

test('Codex self 走文字生成，不向订阅接口传图', async (t) => {
  sandbox(t)
  // 使用假本地生图激活工具，再切换到 Codex；认证和请求均替换为测试实现。
  const cfg = cfgOf()
  const active = { value: true }
  const x = setup(cfg, { local: { active: () => active.value } })
  active.value = false
  cfg.imageGen.provider = 'codex'
  t.mock.method(x.gen.codexAuth, 'ensureAccess', async () => ({ access: 'test', accountId: 'test' }))
  t.mock.method(x.gen.codexAuth, 'status', () => ({ loggedIn: true }))
  const seen = []
  t.mock.method(globalThis, 'fetch', async (url, init) => { seen.push({ url, body: JSON.parse(init.body) }); return response() })
  const out = await x.tool.execute({ prompt: '散步', image: 'self' })
  assert.equal(out.ok, true, out.message)
  assert.equal(seen.length, 1)
  assert.match(seen[0].url, /codex\/images\/generations/)
  assert.match(seen[0].body.prompt, /蓝色短发/)
  assert.equal(seen[0].body.image, undefined)
  assert.match(out.message, /形象一致性有限/)
})

test('仅明确不支持参考图才文字重试；其他错误不重试', async (t) => {
  sandbox(t)
  for (const status of [404, 401, 429, 500]) {
    const seen = []
    const mock = t.mock.method(globalThis, 'fetch', async (url, init) => {
      seen.push({ url, init })
      return seen.length === 1 ? new Response(JSON.stringify({ error: { message: 'upstream error' } }), { status }) : response()
    })
    const s = setup(cfgOf())
    const out = await s.tool.execute({ prompt: '散步', image: 'self' })
    // 2026-11-22：没有配置 fallback 时，5xx 改为原地重试 2 次（见 imagegen.js viaOpenAI）。
    // mock 第二次就返回成功，所以 500 与 404 一样是 2 次请求；401/429 仍一次即止。
    assert.equal(out.ok, status === 404 || status === 500)
    assert.equal(seen.length, (status === 404 || status === 500) ? 2 : 1)
    if (status === 404) {
      assert.match(seen[1].url, /generations$/)
      assert.match(JSON.parse(seen[1].init.body).prompt, /蓝色短发/)
      assert.match(out.message, /形象一致性有限/)
      assert.equal(s.sent.length, 1)
      assert.match(s.events[0].text, /按提示词画/)
    } else assert.equal(s.sent.length, status === 500 ? 1 : 0)
    mock.mock.restore()
  }
  assert.equal(isUnsupportedReference(new Error('network error')), false)
})

test('缺少人设时行为不变；权限先于读图；只有文字也可画自己', async (t) => {
  sandbox(t)
  const requests = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => { requests.push(JSON.parse(init.body)); return response() })
  const noLook = setup(cfgOf({ img2img: false }), { look: {} })
  const out = await noLook.tool.execute({ prompt: '散步', image: 'self' })
  assert.equal(out.ok, true)
  assert.doesNotMatch(out.message, /形象一致性有限/)
  assert.equal(requests[0].prompt, '水彩，散步')
  const text = setup(cfgOf(), { look: { appearance: '红色裙子' } })
  assert.match((await text.tool.execute({ prompt: '散步', image: 'self' })).message, /形象一致性有限/)
  assert.match(requests[1].prompt, /红色裙子/)
  const denied = setup(cfgOf(), { owner: false })
  assert.equal((await denied.tool.execute({ prompt: '散步', image: 'self' })).ok, false)
  assert.equal(denied.reads(), 0)
  assert.equal(requests.length, 2)
  const onlyImage = setup(cfgOf({ img2img: false }), { look: { image: PNG } })
  assert.match((await onlyImage.tool.execute({ prompt: '散步', image: 'self' })).message, /未配置外貌描述/)
})

test('self 多图备用服务保留图片、显式尺寸、会话人格和进度通知', async (t) => {
  sandbox(t)
  const seen = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen.push({ url, init })
    return seen.length === 1 ? new Response(JSON.stringify({ message: 'unavailable' }), { status: 503 }) : response()
  })
  const cfg = cfgOf({ fallbackEnabled: true, fallbacks: [{ id: 'backup', provider: 'openai', baseUrl: 'https://backup.example/v1', model: 'backup' }] })
  const s = setup(cfg, { look: { references: [{ image: PNG }, { image: PNG }], appearance: '蓝发' } })
  const out = await s.tool.execute({ prompt: '散步', image: 'self', size: '2048x2048', notice: '我来画散步的样子。' })
  assert.equal(out.ok, true, out.message)
  assert.equal(out.referenceCount, 2)
  assert.deepEqual(s.lookSessions, ['self-test'])
  assert.equal(seen.length, 2)
  assert.match(seen[1].url, /backup\.example/)
  for (const { init } of seen) {
    assert.equal(init.body.getAll('image[]').length, 2)
    assert.equal(init.body.get('size'), '2048x2048')
    assert.match(init.body.get('prompt'), /蓝发/)
  }
  assert.equal(s.notices[0][1], '我来画散步的样子。')
  assert.match(s.notices[1][1], /换个模型/)
})

test('仅外部文生图就绪时 self 使用外貌文字，不读取无法发送的人设图', async (t) => {
  sandbox(t)
  const seen = []
  const external = { ready: () => true, generate: async (prompt, opts) => { seen.push({ prompt, opts }); return PNG } }
  const s = setup(cfgOf({ baseUrl: '', model: '' }), { external, look: {
    appearance: '蓝发', references: [{ get image() { throw new Error('不应读取参考图') } }],
  } })
  const out = await s.tool.execute({ prompt: '散步', image: 'self', size: '2048x2048' })
  assert.equal(out.ok, true, out.message)
  assert.equal(out.referenceCount, 0)
  assert.match(out.message, /仅按外貌文字/)
  assert.equal(seen.length, 1)
  assert.match(seen[0].prompt, /蓝发/)
  assert.equal(seen[0].opts.size, '2048x2048')
})
