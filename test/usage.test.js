import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as u from '../src/core/usage.js'
let dir
const now = Date.now()
const sample = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 800, cacheWriteTokens: 100 }
const report = () => u.usageReport({ range: 'all', now: now + 10000 })
beforeEach(() => { dir=mkdtempSync(join(tmpdir(),'aurabot-usage-')); process.env.AURABOT_DATA_DIR=dir; u.initUsage() })
afterEach(() => { u.closeUsage(); delete process.env.AURABOT_DATA_DIR; rmSync(dir,{recursive:true,force:true}) })
test('四类 Token 不重叠相加；命中率按输入总量加权，不平均每轮百分比', () => {
 u.recordUsage({chat:'group:1', usage:sample,at:now})
 u.recordUsage({chat:'group:1',usage:{inputTokens:1000,outputTokens:20},at:now})
 const r=report().current
 assert.equal(r.totalTokens,2030);assert.equal(r.cacheHitRate,0.4);assert.equal(r.cacheWriteTokens,100)
 assert.equal(r.byChat[0].totalTokens,2030);assert.equal(r.cost,null)
})
test('纯缓存用量不丢失；错误数值不会污染统计', () => {
 u.recordUsage({usage:{cacheReadTokens:80},at:now})
 u.recordUsage({usage:{cacheWriteTokens:20},at:now})
 u.recordUsage({usage:{inputTokens:-1,outputTokens:Infinity},at:now})
 assert.equal(report().current.totalTokens,100);assert.equal(report().current.runs,2)
 assert.equal(report().current.cacheHitRate,0.8)
})
test('unknown / 中转同名 / 没记模型均不猜价；不完整总价隐藏', () => {
 for(const model of ['', 'deepseek-v4.1-flash','MiniMax-M3.1-Flash']) assert.equal(u.costOf({model,in:100,out:10,provider:'gateway'}).unpriced,true)
 u.initUsage({currency:'元',models:{'gateway::exact':{provider:'gateway',in:1,out:4,cached:0.1,cacheWrite:2}}})
 assert.equal(u.costOf({model:'exact',provider:'other',in:100}).unpriced,true)
 u.recordUsage({model:'exact',provider:'gateway',chat:'group:1',usage:sample,at:now})
 assert.ok(Math.abs(report().current.cost-0.00042)<1e-10)
 u.recordUsage({model:'unknown',provider:'gateway',chat:'private:2',usage:sample,at:now})
 assert.equal(report().current.cost,null)
 assert.equal(typeof report().current.byChat.find(x=>x.key==='group:1').cost,'number')
 assert.equal(report().current.byChat.find(x=>x.key==='private:2').cost,null)
})
test('缓存写入未定价 / 无效费率 / 生效日前记录不显示估价', () => {
 u.initUsage({models:{exact:{provider:'p',in:1,out:2,cached:0}}})
 assert.equal(u.costOf({model:'exact',provider:'p',written:10}).unpriced,true)
 u.initUsage({models:{exact:{provider:'p',in:-1,out:2,cached:0}}})
 assert.equal(u.priceOf('exact',now,undefined,'p'),null)
 u.initUsage({models:{exact:{provider:'p',in:0,out:0,cached:0,from:new Date(now+10000).toISOString()}}})
 assert.equal(u.costOf({model:'exact',provider:'p',in:1,at:now}).unpriced,true)
})
test('全部对话展示，不再截断前12；后台未归属量不丢失', () => {
 for(let i=0;i<25;i++)u.recordUsage({chat:'group:'+i,usage:sample,at:now})
 u.recordUsage({module:'记忆',usage:sample,at:now})
 const r=report().current;assert.equal(r.byChat.length,25)
 assert.equal(r.byChat.reduce((n,x)=>n+x.totalTokens,0)+r.background.totalTokens,r.totalTokens)
})
test('settlement替换、重试累计、失败流用量、压缩和重复事件；重启后仍去重', () => {
 const e=(seq,type,data)=>u.recordSessionUsage('s','group:1',{seq,type,time:now+seq,data})
 e(0,'model/selection',{model:'m',provider:'p'})
 e(1,'assistant/attempt',{turn:1,step:0,stream:{chunks:[{type:'usage',usage:{inputTokens:3}},{type:'usage',usage:sample}]}})
 e(2,'assistant/message',{turn:1,step:0,usage:{inputTokens:20}})
 assert.equal(report().current.totalTokens,20);assert.equal(report().current.runs,1)
 e(3,'llm/retry-started',{turn:1,step:0})
 e(4,'assistant/message',{turn:1,step:0,usage:sample})
 e(5,'compaction/summary',{usage:{inputTokens:30},model:'c',provider:'p'})
 e(5,'compaction/summary',{usage:{inputTokens:30}})
 assert.equal(report().current.totalTokens,1060);assert.equal(report().current.runs,3)
 u.closeUsage();u.initUsage()
 e(4,'assistant/message',{turn:1,step:0,usage:sample})
 assert.equal(report().current.totalTokens,1060)
 e(6,'assistant/message',{turn:1,step:0,usage:{inputTokens:40}})
 assert.equal(report().current.totalTokens,90)
 assert.ok(report().current.byModel.some(x=>x.key==='p / m'))
})
test('旧累计数据保留总量和调用数，不把平均数当总量', () => {
 u.closeUsage()
 const day=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(now)
 writeFileSync(join(dir,'usage.json'),JSON.stringify({days:{[day]:{聊天:{in:1000,out:200,hit:800,calls:10}}}}))
 u.initUsage();const r=report().current
 assert.equal(r.runs,10);assert.equal(r.totalTokens,2000);assert.equal(r.cost,null)
})
test('北京时间跨天范围与90天保留；空结果不冒充零费用', () => {
 const start=Date.parse(new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(now)+'T00:00:00+08:00')
 u.recordUsage({usage:sample,at:start-1});u.recordUsage({usage:sample,at:start})
 u.recordUsage({usage:sample,at:now-91*86400000})
 const r=report();assert.equal(r.ranges.today.runs,1);assert.equal(r.ranges.yesterday.runs,1);assert.equal(r.ranges.all.runs,2)
 assert.equal(u.usageReport({range:'invalid'}).range,'7')
})

test('同一次调用的最终零值可以更正先前的正值', () => {
 const event=(seq,usage)=>({seq,time:now,type:'assistant/message',data:{turn:1,step:0,usage}})
 u.recordSessionUsage('s','private:1',event(1,sample))
 u.recordSessionUsage('s','private:1',event(2,{inputTokens:0,outputTokens:0}))
 assert.equal(report().current.totalTokens,0)
 assert.equal(report().current.runs,1)
 assert.equal(report().current.cacheHitRate,null)
})

test('官方参考和渠道小计独立，未知不是免费，也不跨币种相加', () => {
 u.initUsage({currency:'元', models:{'p::gateway/MiniMax-M3.1-Flash':{provider:'p',in:2,out:3,cached:0.1}}})
 u.recordUsage({provider:'p',model:'gateway/MiniMax-M3.1-Flash',usage:{inputTokens:1e6,cacheReadTokens:1e6,outputTokens:1e6}})
 u.recordUsage({provider:'p',model:'other',usage:{inputTokens:5}})
 const r=report().current
 assert.equal(r.cost,null); assert.equal(r.unpricedCalls,1); assert.equal(r.pricedCost,5.1)
 assert.ok(Math.abs(r.officialUSD-0.765)<1e-10); assert.equal(r.officialMissing,1)
 assert.equal(r.byModel.find(x=>x.key==='p / other').officialUSD,null)
})
test('记忆明细是合计的子集，不从旧的后台记录猜任务名', () => {
 u.recordUsage({module:'其他后台任务',usage:{inputTokens:100}})
 u.recordUsage({module:'记忆',usage:{inputTokens:30}})
 u.recordRetrievalUsage('生成记忆向量','embed',{prompt_tokens:20,total_tokens:20})
 for(const receipt of [null,{}, {prompt_tokens:-2}, {total_tokens:'20'}]) u.recordRetrievalUsage('生成记忆向量','embed',receipt)
 u.closeUsage(); u.initUsage(); const r=report().current
 assert.deepEqual(r.byMemoryTask.map(x=>[x.key,x.totalTokens]),[['未细分',30],['生成记忆向量',20]])
 assert.equal(r.totalTokens,150); assert.equal(r.runs,3)
})
