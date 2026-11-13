import test from 'node:test'
import assert from 'node:assert/strict'
import { createImageGen } from '../src/features/imagegen.js'
import { normalize, publicConfig, mergeFromPanel } from '../src/core/config.js'
const log = { info() {}, debug() {}, warn() {} }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aS0AAAAASUVORK5CYII=', 'base64')
const config = () => normalize({ imageGen: { enabled: true, baseUrl: 'https://one.invalid/v1', model: 'one', fallbackEnabled: true, fallbacks: [{id:'a',baseUrl:'https://two.invalid/v1',model:'two',apiKey:'sample-secret'}, {id:'b',baseUrl:'https://three.invalid/v1',model:'three'}] } })
test('failed image requests retry configured models in priority order', async () => {
  const c = config(), calls = [], reasons = []
  const fetchImpl = async (url) => { calls.push(url); if (calls.length === 1) return {ok:false,status:400,json:async()=>({message:'bad request'})}; if (calls.length === 2) throw new TypeError('fetch failed'); return {ok:true,json:async()=>({data:[{b64_json:png.toString('base64')}]})} }
  const gen = createImageGen({getConfig:()=>c,log,fetchImpl,codexAuth:{}})
  assert.deepEqual(await gen.generate('test', {onRetry: ({error}) => reasons.push(error.imageStatus || error.imageNetworkFailure)}), png)
  assert.deepEqual(calls.map(x=>new URL(x).hostname), ['one.invalid','two.invalid','three.invalid'])
  assert.deepEqual(reasons, [400,true])
})
test('panel hides fallback secrets and retains them after reordering', () => {
 const c=config(), pub=publicConfig(c); assert.equal(pub.imageGen.fallbacks[0].apiKey,''); pub.imageGen.fallbacks.reverse(); assert.equal(mergeFromPanel(c,pub).imageGen.fallbacks[1].apiKey,'sample-secret')
})

test('fallback preserves reference image and explicit size', async () => {
  const c = config(), calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: options.body })
    if (calls.length === 1) return { ok: false, status: 500, json: async () => ({ message: 'failed' }) }
    return { ok: true, json: async () => ({ data: [{ b64_json: png.toString('base64') }] }) }
  }
  const gen = createImageGen({ getConfig: () => c, log, fetchImpl, codexAuth: {} })
  assert.deepEqual(await gen.generate('test', { image: png, shape: 'portrait', size: '2048x2048' }), png)
  assert.deepEqual(calls.map(c => new URL(c.url).pathname), ['/v1/images/edits', '/v1/images/edits'])
  for (const { body } of calls) {
    assert.equal(body.get('size'), '2048x2048')
    assert.deepEqual(Buffer.from(await body.get('image').arrayBuffer()), png)
  }
})
