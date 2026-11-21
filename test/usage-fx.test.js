import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUsageFx } from '../src/core/usage-fx.js'

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'usage-fx-')); t.after(() => rmSync(dir, {recursive:true,force:true}))
  const file = join(dir, 'fx.json'), now = () => Date.UTC(2026, 10, 25)
  return { file, make: request => createUsageFx({file, now, request}) }
}
const feed = (rates,date) => `<Cube time='${date}'>` + Object.entries(rates).filter(([code])=>code!=='EUR').map(([code,rate])=>`<Cube currency='${code}' rate='${rate}'/>`).join('') + '</Cube>'
test('打开概览先用离线值；并发刷新只请求一次，更新后重启仍可离线使用', async t => {
  const {make}=setup(t); let xml,calls=0
  const fx=make(async (url,opts)=>{calls++; assert.equal(new URL(url).hostname,'www.ecb.europa.eu');assert.equal(opts.redirect,'error'); return new Response(xml)})
  const initial=await fx(); assert.equal(calls,0);assert.equal(initial.rates.EUR,1)
  xml=feed({...initial.rates,CNY:7.2},'2026-11-24'); const [a,b]=await Promise.all([fx(true), fx(true)])
  assert.equal(a.rates.CNY,7.2); assert.deepEqual(a,b);assert.deepEqual(await fx(true),a);assert.equal(calls,1)
  assert.deepEqual(await make(()=>assert.fail('offline'))(),a)
})
test('断网、缺币种、无效日期、旧汇率不覆盖有效值，失败后不连续请求', async t => {
  const {file,make}=setup(t); writeFileSync(file,'{"date":"broken","rates":{}}'); const initial=await make(()=>{})()
  for (const body of [null,'not XML', feed({USD:2},'2026-11-24'),feed(initial.rates,'2026-11-19'),feed(initial.rates,'2026-11-31'),feed({...initial.rates,CNY:0},'2026-11-24')]) {
    let calls=0;const fx=make(async()=>{calls++; if(body===null)throw Error('offline');return new Response(body)})
    assert.deepEqual(await fx(true),initial);assert.deepEqual(await fx(true),initial);assert.equal(calls,1)
  }
})
