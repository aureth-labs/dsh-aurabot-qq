// 「获取模型」：按面板当前填的服务地址拉 OpenAI 兼容的 /models，并把错误说成人话。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchOpenAIModels } from '../src/features/imagegen.js'
import { normalize, mergeFromPanel } from '../src/core/config.js'
import imagegenModule from '../src/modules/imagegen/index.js'

const log = { info() {}, warn() {}, debug() {} }
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

test('fetchOpenAIModels：请求 {baseUrl}/models，带 Bearer Key，返回去重后的模型 id', async () => {
  const calls = []
  const models = await fetchOpenAIModels({
    baseUrl: 'https://api.example.com/v1/',
    apiKey: 'sk-test',
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return jsonResponse({ object: 'list', data: [{ id: 'Kwai-Kolors/Kolors' }, { id: 'flux-anime' }, { id: 'Kwai-Kolors/Kolors' }] })
    },
  })
  assert.deepEqual(models, ['Kwai-Kolors/Kolors', 'flux-anime'])
  assert.equal(calls[0].url, 'https://api.example.com/v1/models')
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test')
})

test('fetchOpenAIModels：没 Key 也能拉本地服务；支持数组 / models 两种返回形态', async () => {
  let auth
  const seen = []
  const run = async (body) => fetchOpenAIModels({
    baseUrl: 'http://127.0.0.1:1234/v1',
    fetchImpl: async (_url, init) => { auth = init.headers.authorization; seen.push(body); return jsonResponse(body) },
  })
  assert.deepEqual(await run([{ id: 'local-a' }, 'local-b']), ['local-a', 'local-b'])
  assert.equal(auth, undefined)
  assert.deepEqual(await run({ models: [{ model: 'm-1' }] }), ['m-1'])
})

test('fetchOpenAIModels：地址不对、没 Key、404、连不上、没模型都给出明确提示', async () => {
  await assert.rejects(fetchOpenAIModels({ baseUrl: '' }), /请先填服务地址/)
  await assert.rejects(fetchOpenAIModels({ baseUrl: 'api.example.com' }), /http:\/\/ 或 https:\/\//)
  await assert.rejects(fetchOpenAIModels({ baseUrl: 'https://x.test/v1', fetchImpl: async () => jsonResponse({ error: { message: 'bad key' } }, 401) }), /API Key 没填或不对/)
  await assert.rejects(fetchOpenAIModels({ baseUrl: 'https://x.test/v1', fetchImpl: async () => jsonResponse({}, 404) }), /没有 \/models 接口/)
  await assert.rejects(fetchOpenAIModels({ baseUrl: 'https://x.test/v1', fetchImpl: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }) } }), /连接不上服务地址：ENOTFOUND/)
  await assert.rejects(fetchOpenAIModels({ baseUrl: 'https://x.test/v1', fetchImpl: async () => jsonResponse({ data: [] }) }), /没有返回任何模型/)
  await assert.rejects(fetchOpenAIModels({ baseUrl: 'https://x.test/v1', fetchImpl: async () => new Response('not json', { status: 200 }) }), /不是模型列表/)
})

test('模块路由 /image/models：用草稿里的地址和已保存的 Key，不回传 Key', async (t) => {
  const cfg = normalize({ imageGen: { enabled: true, provider: 'openai', baseUrl: 'https://saved.example/v1', model: 'saved-model', apiKey: 'sk-saved-secret' } })
  const routes = new Map()
  imagegenModule.setup({
    config: () => cfg,
    log,
    dsh: {},
    lazy: () => ({}),
    route: (path, handler) => routes.set(path, handler),
    tool: () => {},
    core: { hub: {}, local: { active: () => false }, http: { body: async (req) => req.body } },
  })
  const handler = routes.get('/image/models')
  assert.ok(handler, '模块要注册 /image/models')
  let seenAuth = ''
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seenAuth = init.headers.authorization
    assert.equal(url, 'https://draft.example/v1/models')
    return jsonResponse({ data: [{ id: 'draft-model' }] })
  })
  const result = await handler({ method: 'POST', headers: { 'content-type': 'application/json' }, body: { imageGen: { baseUrl: 'https://draft.example/v1', apiKey: '' } } })
  assert.deepEqual(result, { ok: true, models: ['draft-model'] })
  assert.equal(seenAuth, 'Bearer sk-saved-secret', '面板没重填 Key 时用已保存的那份')
  assert.equal(JSON.stringify(result).includes('sk-saved-secret'), false)
})

test('模块路由 /image/models：自定义接口 / Codex 明确说不支持，错误会脱敏', async (t) => {
  const base = normalize({ imageGen: { enabled: true, provider: 'openai', baseUrl: 'https://api.example/v1', model: 'm', apiKey: 'sk-secret' } })
  const routes = new Map()
  imagegenModule.setup({
    config: () => base,
    log,
    dsh: {},
    lazy: () => ({}),
    route: (path, handler) => routes.set(path, handler),
    tool: () => {},
    core: { hub: {}, local: { active: () => false }, http: { body: async (req) => req.body } },
  })
  const handler = routes.get('/image/models')
  const custom = await handler({ method: 'POST', headers: { 'content-type': 'application/json' }, body: { imageGen: { provider: 'custom' } } })
  assert.equal(custom.ok, false)
  assert.match(custom.message, /自定义接口/)
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('boom sk-secret') })
  const failed = await handler({ method: 'POST', headers: { 'content-type': 'application/json' }, body: { imageGen: { baseUrl: 'https://bad.example/v1', apiKey: 'sk-secret' } } })
  assert.equal(failed.ok, false)
  assert.equal(failed.message.includes('sk-secret'), false)
})
