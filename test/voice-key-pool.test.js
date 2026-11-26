import test from 'node:test'
import assert from 'node:assert/strict'
import { createKeyRouter, retryDelay } from '../src/voice/key-pool.mjs'
import { normalize, mergeFromPanel, publicConfig } from '../src/core/config.js'
import { textToSpeech } from '../src/voice/tts.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const pool = (strategy, ...keys) => ({ strategy, accounts: keys.map((apiKey,i) => ({ id: 'row-' + i, apiKey })) })
const fail = (status, retryAfter, extra) => Object.assign(new Error('rejected'), { status, retryAfter, ...extra })

test('balanced spreads simultaneous work, ordered prefers primary, service state is isolated', async () => {
  const run = createKeyRouter(), used = [], release = []
  const work = k => { used.push(k); return new Promise(r => release.push(r)) }
  const p = pool('balanced', 'B', 'C', 'A')
  const jobs = [0,1,2].map(() => run('fish-free','A',p,work))
  assert.deepEqual(used,['A','B','C']); release[1]()
  await jobs[1]; assert.equal(await run('fish-free','A',p,async k=>k),'B')
  release.forEach(r=>r()); await Promise.all(jobs)
  for (let i=0;i<3;i++) assert.equal(await run('breeze','A',pool('ordered','B'),async k=>k),'A')
})

test('each 429 expires independently; repeated keys do not get extra attempts and changing a key works immediately', async () => {
  let time=100000, calls=[];const run=createKeyRouter(()=>time), p=pool('ordered','B','A','C')
  const work=async k=>{ calls.push(k); if (k==='A') throw fail(429,'3'); if(k==='B') throw fail(429,new Date(105000).toUTCString()); return k }
  assert.equal(await run('fish-free','A',p,work),'C');assert.deepEqual(calls,['A','B','C']);calls=[]
  await run('fish-free','A',p,work); assert.deepEqual(calls,['C']); time+=3000;calls=[]
  await run('fish-free','A',p,work);assert.deepEqual(calls,['A','C']);time+=2000;calls=[]
  await run('fish-free','A',p,work);assert.deepEqual(calls,['B','C']);calls=[]
  assert.equal(await run('fish-free','NEW',p,work),'NEW');assert.deepEqual(calls,['NEW']);assert.equal(retryDelay('invalid',time),null)
})

test('only explicit account failures rotate; global cooldown blocks all keys, preview cannot clear it',async()=>{
  for(const code of [401,402,429,400,403,500,503,undefined]){
    const run=createKeyRouter(), seen=[];const p=run('breeze','A',pool('ordered','B'),async k=>{seen.push(k);if(k==='A') throw fail(code);return k})
    if([401,402,429].includes(code)){assert.equal(await p,'B');assert.deepEqual(seen,['A','B'])}else{await assert.rejects(p);assert.deepEqual(seen,['A'])}
  }
  let now=0;const run=createKeyRouter(()=>now), p=pool('balanced','B');await assert.rejects(run('fish-free','A',p,async()=>{throw fail(429,'4',{shared:true})}));
  await assert.rejects(run('fish-free','A',undefined,()=>assert.fail('shared limit')));now=4000;assert.ok(await run('fish-free','A',p,async k=>k))
})

test('masked saves retain keys by row and service, not index; deleting rows and replacing keys never mutate the public draft',()=>{
  const original=normalize({voice:{keyPools:{breeze:pool('ordered','breeze-one','breeze-two'), 'fish-free':pool('balanced','fish-one')}}})
  const shown=publicConfig(original); assert.ok(!JSON.stringify(shown).includes('breeze-one'));assert.ok(!JSON.stringify(shown).includes('fish-one'))
  const rows=shown.voice.keyPools.breeze.accounts;rows.reverse();rows.pop();rows.push({id:'fresh',name:'Work',apiKey:'new-secret'})
  const saved=mergeFromPanel(original,{voice:{keyPools:{breeze:{accounts:rows}}}}); assert.deepEqual(saved.voice.keyPools.breeze.accounts.map(x=>x.apiKey),['breeze-two','new-secret']);assert.equal(saved.voice.keyPools.breeze.strategy,'ordered');assert.equal(saved.voice.keyPools['fish-free'].accounts[0].apiKey,'fish-one');assert.equal(rows[0].apiKey,'');
  assert.deepEqual(mergeFromPanel(saved,{voice:{keyPools:{breeze:{accounts:[]}}}}).voice.keyPools.breeze.accounts,[])
})

test('MiniMax business-level 429 and explicit HTTP header pool use the next key; changed custom origin cannot receive existing keys', async t=>{
  const dir=mkdtempSync(join(tmpdir(),'voice-pool-'));const old=process.env.AURABOT_DATA_DIR;process.env.AURABOT_DATA_DIR=dir;t.after(()=>{if(old===undefined)delete process.env.AURABOT_DATA_DIR;else process.env.AURABOT_DATA_DIR=old;rmSync(dir,{recursive:true,force:true})});const calls=[]
  t.mock.method(globalThis,'fetch',async (url,opts)=>{const key=opts.headers.authorization;calls.push(key);assert.equal(opts.redirect,'error');if(key==='Bearer first')return Response.json({base_resp:{status_code:1002}});if(key==='Bearer second')return Response.json({base_resp:{status_code:0},data:{audio:'00'.repeat(410)}});assert.match(url,/^https:\/\/custom.test\//);return new Response(Buffer.alloc(410),{headers:{'content-type':'audio/mpeg'}})})
  const r=await textToSpeech('hello',{engine:'minimax',minimax:{apiKey:'first'},keyPools:{minimax:pool('ordered','second')}});assert.equal(r.engine,'minimax');assert.deepEqual(calls,['Bearer first','Bearer second']);
  const http={engine:'http',http:{urlTemplate:'https://custom.test/?q={text}',headers:'authorization: Bearer {apiKey}',fallback:'text'},keyPools:{http:{accounts:[{id:'custom',apiKey:'custom-key',origin:'https://custom.test'}]}}};assert.equal((await textToSpeech('hello',http)).engine,'http');assert.equal(calls[2],'Bearer custom-key');http.http.urlTemplate='https://other.test/?q={text}';await assert.rejects(textToSpeech('x',http),/HTTPS/);assert.equal(calls.length,3)
})

test('one utterance has a bounded retry budget; the next utterance can start with untried accounts', async()=>{
  const run=createKeyRouter(),cfg=pool('ordered','2','3','4','5','6'),used=[]
  const work=async k=>{used.push(k);if(k!=='5')throw fail(429,'40');return k}
  await assert.rejects(run('fish-free','1',cfg,work));assert.deepEqual(used,['1','2','3','4']);assert.equal(await run('fish-free','1',cfg,work),'5')
})
