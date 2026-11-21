import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize, publicConfig, mergeFromPanel } from '../src/core/config.js'
import voiceModule from '../src/modules/voice/index.js'
import { fishSpeech } from '../src/voice/fish.js'

test('Fish：面板不回传 Key，保存空框不覆盖；试听、发语音和旧凭据都用同一免费型号', async t => {
  const dir=mkdtempSync(join(tmpdir(),'fish-voice-')); process.env.AURABOT_DATA_DIR=dir
  let cfg=normalize({voice:{engine:'fish-free', fishApiKey:'panel-fixture', fishReferenceId:'a'.repeat(32)}})
  const shown=publicConfig(cfg); assert.equal(shown.voice.fishApiKeySet,true); assert.equal(JSON.stringify(shown).includes('panel-fixture'),false)
  cfg=mergeFromPanel(cfg,shown); assert.equal(cfg.voice.fishApiKey,'panel-fixture')
  const routes={}, disposals=[], keys=[]; let resolves=0
  const api={config:()=>cfg,core:{local:{active:()=>false},http:{body:async r=>r}}, dsh:{get:()=>({resolve:async ()=>{resolves++;return {value:'legacy-fixture'}}})},route:(k,fn)=>routes[k]=fn,onDispose:fn=>disposals.push(fn),every(){},log:{},use:()=>null,dataDir:()=>dir}
  const {speak}=voiceModule.setup(api)
  t.after(()=>{for(const fn of disposals.reverse())fn(); delete process.env.AURABOT_DATA_DIR; rmSync(dir,{force:true,recursive:true})})
  t.mock.method(globalThis,'fetch',async (url,r)=>{assert.equal(url,'https://api.fish.audio/v1/tts'); assert.equal(r.redirect,'error'); assert.equal(r.headers.model,'s2.1-pro-free'); assert.equal(JSON.parse(r.body).reference_id,'a'.repeat(32)); keys.push(r.headers.Authorization); return new Response(Buffer.from('ID3fixture'))})
  assert.equal((await speak('test')).engine,'fish-free'); assert.equal((await routes['/voice/test']({voice:{fishApiKey:'draft-fixture'}})).engine,'fish-free')
  assert.equal(resolves,0); cfg=mergeFromPanel(cfg,{voice:{fishApiKey:null}}); await speak('legacy'); assert.equal(resolves,1)
  assert.deepEqual(keys,['Bearer panel-fixture','Bearer draft-fixture','Bearer legacy-fixture'])
})
test('Fish：无 Key 或音色无效时不出网，失败不重投收费型号，不回显服务返回的内容',async()=>{
  const no=()=>assert.fail('unexpected request')
  await assert.rejects(fishSpeech('test','',no),/扩展服务 → Fish Audio/)
  await assert.rejects(fishSpeech('test','fixture',no,'invalid'),/音色 ID/)
  await assert.rejects(fishSpeech('test','fixture',async()=>new Response('sensitive',{status:429,headers:{'Retry-After':'3'}})),e=>e.status===429 && e.retryAfter==='3' && !e.message.includes('sensitive'))
  await assert.rejects(fishSpeech('test','fixture',async()=>new Response('not audio')),/MP3/)
})

test('余额只读已保存的账号：保留零值、分开处理套餐和 API、错误不回显凭据', async t => {
  const { fishBalances } = await import('../src/voice/fish.js')
  const voice = { keyPools: { 'fish-free': { accounts: [{ apiKey: 'first' }, { name: '备用', apiKey: 'second' }] } } }
  const calls = []
  const result = await fishBalances(voice, () => ({ resolve: async () => ({ value: 'first' }) }), async (url, options) => {
    const u = new URL(url); assert.equal(u.origin, 'https://api.fish.audio'); assert.equal(options.redirect, 'error'); assert.ok(!options.body)
    const k = options.headers.Authorization; calls.push(k)
    if (u.pathname.endsWith('/package')) return Response.json({ balance: 8000, total: 8000, extra_balance: 0, user_id: 'private-id' })
    assert.equal(u.pathname,'/wallet/self/api-credit')
    return k === 'Bearer first' ? Response.json({ credit:'0.0' }) : new Response('second',{ status:403 })
  })
  assert.deepEqual(calls.sort(), ['Bearer first','Bearer first','Bearer second','Bearer second'])
  assert.deepEqual(result.rows.map(r => [r.name,r.wallet,r.pack.remaining]), [['主账号',{ usd:'0.0' },8000],['备用',{ error:'查询失败（HTTP 403）' },8000]])
  assert.doesNotMatch(JSON.stringify(result), /private-id|first|second/)
  assert.deepEqual((await fishBalances({}, () => null, () => assert.fail('unexpected network'))).rows, [])
})
