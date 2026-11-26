import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createImageGen, resolveDrawImages } from '../src/features/imagegen.js'
import { normalize } from '../src/core/config.js'
import imagegenModule from '../src/modules/imagegen/index.js'

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64, 1)])
const FACE = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64, 2)])
const log = { info() {}, warn() {}, debug() {} }
const config = extra => normalize({ imageGen: { enabled: true, baseUrl: 'https://image.example/v1', model: 'image-test', seeOwn: false, ...extra } })
const result = () => new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
const chat = { kind: 'group', chatId: 'group:123', groupId: '123' }
function setup(t, extra = {}, { owner = true, missing = false } = {}) {
  const old = process.env.AURABOT_DATA_DIR
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-explicit-refs-'))
  process.env.AURABOT_DATA_DIR = dir
  t.after(() => { if (old === undefined) delete process.env.AURABOT_DATA_DIR; else process.env.AURABOT_DATA_DIR = old; rmSync(dir, { recursive: true, force: true }) })
  const reads = [], requests = [], sent = [], events = []
  const cfg = config(extra)
  let build
  t.mock.method(globalThis, 'fetch', async (url, init) => { requests.push({ url, init }); return result() })
  const hub = {
    turnSendersAllOwner: () => owner, modelFor: () => null, lastTextOf: () => '',
    canSeeImages: async () => false, sendText: async () => true,
    referenceImage: async (actualChat, source) => {
      assert.equal(actualChat, chat); reads.push(source)
      if (missing && source === 'msg:102:1') throw new Error('指定图片已过期')
      return source === 'msg:102:1' ? FACE : PNG
    },
    sendSegments: async (...args) => { sent.push(args); return true },
  }
  const gen = imagegenModule.setup({ config: () => cfg, log, dsh: {}, route() {}, tool: fn => { build = fn }, onDispose() {},
    lazy: id => id === 'memory' ? { addEvent: event => events.push(event) } : null,
    core: { hub, ask: async () => '', local: { active: () => false } },
  })
  t.mock.method(gen.codexAuth, 'status', () => ({ loggedIn: true }))
  t.after(() => gen.dispose())
  return { tool: build({ chat, sessionId: 'explicit-refs-test' }), reads, requests, sent, events }
}

test('explicit references preserve exact order; no implicit last/quote lookup', async () => {
  const reads = []
  const context = { chat, hub: { referenceImage: async (_chat, ref) => { reads.push(ref); return ref === 'msg:102:1' ? FACE : PNG } } }
  assert.deepEqual(await resolveDrawImages({}, context), [])
  assert.deepEqual(await resolveDrawImages({ images: [] }, context), [])
  assert.deepEqual(reads, [])
  assert.deepEqual(await resolveDrawImages({ image: 'msg:101:1', images: ['msg:102:1'] }, context), [PNG, FACE])
  assert.deepEqual(reads, ['msg:101:1', 'msg:102:1'])
})

test('invalid arrays and empty entries never shift reference numbering or trigger reads', async () => {
  const context = { chat, hub: { referenceImage: () => { throw new Error('unexpected read') } } }
  for (const images of ['last', {}, [null], [''], [' '], ['quote', undefined], Array(17).fill('quote')]) {
    await assert.rejects(resolveDrawImages({ images }, context), /数组|留空|16 张/)
  }
})

test('multi-image multipart is ordered; single and no-reference requests keep their original shape', async () => {
  const seen = [], gen = createImageGen({ getConfig: () => config(), log, fetchImpl: async (url, init) => { seen.push({ url, init }); return result() } })
  await gen.generate('图1海报换成图2人脸', { images: [PNG, FACE], shape: 'landscape' })
  const req = seen[0]
  assert.match(req.url, /images\/edits$/)
  assert.equal(req.init.body.get('image'), null)
  const files = req.init.body.getAll('image[]')
  assert.equal(files.length, 2)
  assert.deepEqual(Buffer.from(await files[0].arrayBuffer()), PNG)
  assert.deepEqual(Buffer.from(await files[1].arrayBuffer()), FACE)
  assert.equal(req.init.body.get('size'), '1536x1024')
  await gen.generate('单图', { image: FACE })
  assert.equal(seen[1].init.body.getAll('image[]').length, 0)
  assert.deepEqual(Buffer.from(await seen[1].init.body.get('image').arrayBuffer()), FACE)
  await gen.generate('新画')
  assert.match(seen[2].url, /images\/generations$/)
  assert.equal(JSON.parse(seen[2].init.body).images, undefined)
})

test('unknown service rejection and network failure never retry with fewer or zero references', async () => {
  for (const failure of ['Only one image is supported', 'unsupported image[]', 'bad size', 'network']) {
    let calls = 0
    const gen = createImageGen({ getConfig: () => config(), log, fetchImpl: async (_url, init) => {
      calls++; assert.equal(init.body.getAll('image[]').length, 2)
      if (failure === 'network') throw new Error('network')
      return new Response(JSON.stringify({ message: failure }), { status: 400 })
    } })
    await assert.rejects(gen.generate('换脸', { images: [PNG, FACE] }))
    assert.equal(calls, 1)
  }
})

test('tool sends both explicit images, records both; following plain draw does not inherit them', async t => {
  const s = setup(t)
  const out = await s.tool.execute({ prompt: '保留图1海报，换上图2人脸', images: ['msg:101:1', 'msg:102:1'] })
  assert.equal(out.ok, true, out.message)
  assert.equal(out.referenceCount, 2)
  assert.deepEqual(s.reads, ['msg:101:1', 'msg:102:1'])
  assert.equal(s.requests[0].init.body.getAll('image[]').length, 2)
  assert.equal(s.sent.length, 1)
  assert.match(s.events[0].text, /参考了2 张图/)
  assert.equal((await s.tool.execute({ prompt: '新画一辆红车' })).ok, true)
  assert.deepEqual(s.reads, ['msg:101:1', 'msg:102:1'])
  assert.match(s.requests[1].url, /generations$/)
})

test('tool keeps legacy image plus images order instead of omitting or deduplicating a reference', async t => {
  const s = setup(t)
  const out = await s.tool.execute({ prompt: '两图合成', image: 'msg:101:1', images: ['msg:102:1'] })
  assert.equal(out.ok, true, out.message)
  const files = s.requests[0].init.body.getAll('image[]')
  assert.deepEqual(Buffer.from(await files[0].arrayBuffer()), PNG)
  assert.deepEqual(Buffer.from(await files[1].arrayBuffer()), FACE)
})

for (const provider of ['codex', 'custom']) test(`explicit multi-reference ${provider} unsupported: no generation/send/success memory`, async t => {
  const s = setup(t, { provider, custom: { method: 'POST', url: 'https://image.example/edit', params: [{ key: 'image', value: '{image}' }] } })
  const out = await s.tool.execute({ prompt: '换脸', images: ['msg:101:1', 'msg:102:1'] })
  assert.equal(out.ok, false)
  assert.equal(s.requests.length + s.sent.length + s.events.length, 0)
})

test('missing second reference aborts instead of using the first or newest image', async t => {
  const s = setup(t, {}, { missing: true })
  const out = await s.tool.execute({ prompt: '换脸', images: ['msg:101:1', 'msg:102:1'] })
  assert.equal(out.ok, false)
  assert.match(out.message, /过期/)
  assert.equal(s.requests.length + s.sent.length + s.events.length, 0)
})

for (const reason of ['owner', 'img2img']) test(`${reason} gate applies to arrays before reading references`, async t => {
  const s = setup(t, reason === 'img2img' ? { img2img: false } : {}, { owner: reason !== 'owner' })
  const out = await s.tool.execute({ prompt: '换脸', images: ['msg:101:1', 'msg:102:1'] })
  assert.equal(out.ok, false)
  assert.equal(s.reads.length + s.requests.length + s.sent.length + s.events.length, 0)
})

test('known single-image or no-image service stops multi-reference edits before generating', async t => {
  const s = setup(t, { model: 'dall-e-2' })
  const out = await s.tool.execute({ prompt: '换脸', images: ['msg:101:1', 'msg:102:1'] })
  assert.equal(out.ok, false)
  assert.match(out.message, /最多支持 1 张/)
  assert.equal(s.requests.length + s.sent.length + s.events.length, 0)
})

test('invalid tool arrays do not turn an edit into text-to-image', async t => {
  const s = setup(t)
  for (const images of ['quote', [null], ['', 'msg:102:1'], Array(17).fill('quote')]) {
    assert.equal((await s.tool.execute({ prompt: '换脸', images })).ok, false)
  }
  assert.equal(s.reads.length + s.requests.length + s.sent.length + s.events.length, 0)
})

test('self cannot swallow explicitly supplied extra references', async t => {
  const s = setup(t)
  const out = await s.tool.execute({ prompt: '人物合影', image: 'self', images: ['msg:102:1'] })
  assert.equal(out.ok, false)
  assert.match(out.message, /不能同时指定 images/)
  assert.equal(s.reads.length + s.requests.length + s.sent.length + s.events.length, 0)
})
