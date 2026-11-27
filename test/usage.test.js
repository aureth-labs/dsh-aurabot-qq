import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
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

const provider = 'billing-provider'
const model = 'priced-model'
const dayMs = 86_400_000
const atToday = Date.parse(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(now) + 'T12:00:00+08:00')
const tariff = { provider, in: 1, out: 4, cached: 0.02 }

test('同一渠道显式配置两种模型时使用各自费率，未登记模型单列为未知', () => {
  u.initUsage({ models: { [model]: tariff, 'priced-pro': { ...tariff, out: 15 } } })
  const input = { provider, in: 20, out: 1_000, cached: 80 }
  assert.equal(u.costOf({ ...input, model }).unpriced, false)
  assert.ok(u.costOf({ ...input, model: 'priced-pro' }).cost > u.costOf({ ...input, model }).cost * 3)
  const unknown = u.costOf({ ...input, model: 'some-local-llm' })
  assert.equal(unknown.unpriced, true)
  assert.equal(unknown.cost, 0)
})

test('汇总：今日、昨日、7 天、30 天分别计算并按模块、聊天和模型分组', () => {
  u.initUsage({ models: { [model]: tariff } })
  const record = (module, chat, usage, at = atToday) => u.recordUsage({ module, chat, provider, model, usage, at })
  record('聊天', 'group:1', { inputTokens: 3000, outputTokens: 500 })
  record('聊天', 'group:1', { inputTokens: 2000, outputTokens: 200, cacheReadTokens: 1000 })
  record('记忆', '', { inputTokens: 1000, outputTokens: 100 })
  record('聊天', 'private:2', { inputTokens: 4000, outputTokens: 400 }, atToday - dayMs)
  record('日记', '', { inputTokens: 700, outputTokens: 70 }, atToday - 8 * dayMs)

  const report = u.usageReport({ now: atToday, range: '7' })
  assert.equal(report.ranges.today.runs, 3)
  assert.equal(report.ranges.today.totalTokens, 7800)
  assert.equal(report.ranges.today.cachedTokens, 1000)
  assert.equal(report.ranges.today.promptTokens, 7000, '总输入 = 未命中 + 命中')
  assert.equal(report.ranges.today.cacheHitRate, 1 / 7)
  assert.equal(report.ranges.yesterday.runs, 1)
  assert.equal(report.ranges.last7.runs, 4, '近 7 天包含今天和昨天，不包含 8 天前')
  assert.equal(report.ranges.last30.runs, 5)
  assert.deepEqual(report.current.byModule.map((entry) => entry.key), ['聊天', '记忆'])
  assert.equal(report.current.byModule[0].runs, 3)
  assert.ok(report.current.byChat.some((entry) => entry.key === 'group:1'))
  assert.deepEqual(report.current.byModel.map((entry) => entry.key), [provider + ' / ' + model])
  assert.ok(report.current.cost > 0)
})

test('已记用量但未配置费率的模型在分项显示次数与未定价状态', () => {
  u.recordUsage({ module: '聊天', model: 'weird-model-x', provider, usage: { inputTokens: 5000, outputTokens: 500 }, at: atToday })
  const result = u.usageReport({ now: atToday }).current
  assert.equal(result.unpricedCalls, 1)
  const unknown = result.byModel.find((entry) => entry.key === provider + ' / weird-model-x')
  assert.equal(unknown.runs, 1)
  assert.equal(unknown.totalTokens, 5500)
  assert.equal(unknown.cost, null)
})

test('只保存用量元数据，包含原文的额外字段不会落盘，空用量跳过', () => {
  assert.equal(u.recordUsage({ module: '聊天', usage: null, at: atToday }), null)
  assert.equal(u.recordUsage({ module: '聊天', usage: { inputTokens: 0, outputTokens: 0 }, at: atToday }), null)
  u.recordUsage({ module: '聊天', text: '测试时附带的聊天原文', usage: { inputTokens: 1, prompt: '测试提示全文' }, at: atToday })
  u.flushUsage()
  assert.equal(u.usageReport({ now: atToday }).current.runs, 1)
  assert.doesNotMatch(readFileSync(join(dir, 'usage.json'), 'utf8'), /测试时附带的聊天原文|测试提示全文/)
})

test('配置可为明确渠道提供零费率，清空价目表后回到未定价', () => {
  u.initUsage({ models: { [model]: { provider, in: 0, out: 0, cached: 0 } } })
  const row = { provider, model, in: 10, out: 1 }
  assert.equal(u.costOf(row).unpriced, false)
  assert.equal(u.costOf(row).cost, 0)
  u.initUsage()
  assert.equal(u.costOf(row).unpriced, true)
})

test('渠道成本仅认显式精确费率，旧厂商名称猜价、峰谷和正则规则不作渠道估价', () => {
  u.initUsage({ models: {
    [model]: tariff,
    'old-prefix': { ...tariff, match: 'old-' },
    'old-peak': { ...tariff, peak: true },
  } })
  assert.equal(u.priceOf(model, atToday, undefined, provider).in, tariff.in)
  assert.equal(u.priceOf('old-prefix', atToday, undefined, provider), null)
  assert.equal(u.priceOf('old-peak', atToday, undefined, provider), null)
  for (const name of ['deepseek-v4.1-flash', 'gpt-4o-mini', 'claude-sonnet-4-5', 'gemini-2.5-flash', '']) {
    assert.equal(u.priceOf(name, atToday, undefined, provider), null)
  }
  assert.equal(u.priceOf(model, atToday, undefined, 'different-provider'), null)
})

test('后台任务按功能分，聊天和工具用量用原有模块名归属', () => {
  assert.equal(u.moduleLabel('group:602656027'), '聊天')
  assert.equal(u.moduleLabel('private:1316149505'), '聊天')
  assert.equal(u.moduleLabel('system:diary'), '空间日记（后台）')
  assert.equal(u.moduleLabel('system:ext-heybox'), '刷小黑盒（后台）')
  assert.equal(u.moduleLabel('system:bili'), '刷 B 站（后台）')
  assert.equal(u.moduleLabel('memory'), '记忆')
  assert.equal(u.moduleLabel('mood'), '心情')
  assert.equal(u.moduleLabel('未知模块'), '未知模块')
  assert.equal(u.moduleLabel(''), '其他后台任务')

  for (const label of ['system:diary', 'system:purpose', 'memory']) {
    u.recordUsage({ module: u.moduleLabel(label), model, usage: { inputTokens: 1000, outputTokens: 100 }, at: atToday })
  }
  const names = u.usageReport({ now: atToday, range: 'today' }).current.byModule.map((entry) => entry.key)
  assert.deepEqual(new Set(names), new Set(['空间日记（后台）', '目的引擎（后台）', '记忆']))
})

test('旧后台标签统一归置，带模型名也不猜测属于记忆任务', () => {
  assert.equal(u.moduleOf({ module: '后台任务', model: 'deepseek-v4.1-flash' }), '其他后台任务')
  assert.equal(u.moduleOf({ module: '后台任务', model: '' }), '其他后台任务')
  assert.equal(u.moduleOf({ module: '后台会话', model: '' }), '其他后台任务')
  assert.equal(u.moduleOf({ module: '聊天', model }), '聊天')
  assert.equal(u.moduleOf({ module: '记忆', model }), '记忆')
  assert.equal(u.moduleOf({ module: '', model: '' }), '其他后台任务')
  assert.equal(u.moduleOf({ module: '其它后台', model: 'x' }), '其他后台任务')
})

test('没有模型标识的旧用量保留 Token，价格仍标为未知', () => {
  const old = { provider, in: 3096, cached: 4992, out: 331, model: '' }
  assert.equal(u.costOf({ ...old, at: atToday }).unpriced, true)
  assert.equal(u.costOf({ ...old, model: 'mystery-llm', at: atToday }).unpriced, true)
  u.recordUsage({ module: '其他后台任务', model: '', usage: { inputTokens: 1000, outputTokens: 100 }, at: atToday })
  const result = u.usageReport({ now: atToday, range: 'today' }).current
  assert.equal(result.totalTokens, 1100)
  assert.equal(result.unpricedCalls, 1)
  assert.equal(result.cost, null)
  assert.equal(result.byModel[0].key, '未记录模型')
})

test('总输入为未命中与命中缓存之和，明确费率下各项分别计价', () => {
  u.initUsage({ models: { [model]: tariff } })
  u.recordUsage({ module: '聊天', provider, model, usage: { inputTokens: 1000, cacheReadTokens: 9000, outputTokens: 500 }, at: atToday })
  const totals = u.usageReport({ now: atToday, range: 'today' }).current
  assert.equal(totals.promptTokens, 10_000)
  assert.equal(totals.cachedTokens, 9000)
  assert.equal(totals.completionTokens, 500)
  assert.equal(totals.totalTokens, 10_500)
  assert.equal(totals.cacheHitRate, 0.9)
  const expected = (1000 * tariff.in + 9000 * tariff.cached + 500 * tariff.out) / 1_000_000
  assert.ok(Math.abs(totals.cost - expected) < 1e-9)
})

test('工具记账分类兼容现用工具和旧别名，普通聊天工具保持聊天归属', () => {
  const toolNames = {
    '刷 B 站': ['bili_watch', 'bili_comment', 'bili_danmaku', 'bili_send_shot', 'bili_list_shots', 'qq_send_shot', 'qq_list_shots'],
    '生图': ['draw_image', 'qq_draw_image'],
    '表情包': ['list_stickers', 'send_sticker', 'qq_import_stickers', 'qq_list_stickers', 'qq_send_sticker'],
    '': ['chat_history', 'search_chatlog', 'send_message', 'send_file', 'qq_send_message', 'qq_chat_history', 'home_where', '', null],
  }
  for (const [label, names] of Object.entries(toolNames)) {
    for (const name of names) assert.equal(u.moduleOfTool(name), label, String(name))
  }
})

test('按聊天只列群聊和私聊，后台归入独立的模块和后台小计', () => {
  const tokens = { inputTokens: 100, outputTokens: 10 }
  for (const [module, chat] of [['聊天', 'group:777'], ['聊天', 'private:888'], ['刷 B 站（后台）', 'system:bili'], ['其他后台任务', '']]) {
    u.recordUsage({ module, chat, model, usage: tokens, at: atToday })
  }
  const result = u.usageReport({ now: atToday, range: 'today' }).current
  assert.deepEqual(result.byChat.map((entry) => entry.key).sort(), ['group:777', 'private:888'])
  assert.equal(result.background.totalTokens, 220)
  const modules = result.byModule.map((entry) => entry.key)
  assert.ok(modules.includes('刷 B 站（后台）'))
  assert.ok(modules.includes('其他后台任务'))
})

test('异步用量汇总让出执行权并复用同一范围的在途快照', async () => {
  const stamp = Date.now() - 100
  for (let n = 0; n < 600; n++) u.recordUsage({ at: stamp, chat: 'private:1', usage: { inputTokens: 1 } })
  let yielded = false
  setImmediate(() => { yielded = true })
  const job = u.usageReportAsync({ range: 'all' })
  assert.equal(u.usageReportAsync({ range: 'all' }), job)
  u.recordUsage({ at: stamp, chat: 'private:1', usage: { inputTokens: 9 } })
  const snapshot = await job
  assert.equal(yielded, true)
  assert.equal(snapshot.current.totalTokens, 600)
  assert.equal((await u.usageReportAsync({ range: 'all' })).current.totalTokens, 609)
})

// 只手动触发用量的写盘定时器，异步迭代、磁盘写入和原子改名仍走真实路径。
function controlUsageWrite(t) {
  u.closeUsage()
  const nativeSetTimeout = globalThis.setTimeout
  const nativeClearTimeout = globalThis.clearTimeout
  let pending = null
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (delay !== 1500 && delay !== 5000) return nativeSetTimeout(callback, delay, ...args)
    assert.equal(pending, null, '同一时间只应安排一次用量写盘')
    pending = { callback, delay, unref() {} }
    return pending
  })
  t.mock.method(globalThis, 'clearTimeout', handle => {
    if (handle === pending) pending = null
    else nativeClearTimeout(handle)
  })
  u.initUsage()
  return {
    fire(delay) {
      assert.equal(pending?.delay, delay)
      const { callback } = pending
      pending = null
      return callback()
    },
    hasPending: () => Boolean(pending),
    read: () => JSON.parse(readFileSync(join(dir, 'usage.json'), 'utf8')),
  }
}

function afterUsageTempWrite(t, callback) {
  const prefix = join(dir, 'usage.json.tmp-')
  const writeFile = fsPromises.writeFile
  const mock = t.mock.method(fsPromises, 'writeFile', async (file, ...args) => {
    await writeFile(file, ...args)
    if (String(file).startsWith(prefix)) await callback(file)
  })
  syncBuiltinESMExports()
  return () => {
    mock.mock.restore()
    syncBuiltinESMExports()
  }
}

const persistedRows = state => Object.values(state.days).flat()

test('用量的 1.5 秒后台写盘保留所有批次和会话游标', async t => {
  const timer = controlUsageWrite(t)
  for (let n = 0; n < 270; n++) u.recordUsage({ at: now, usage: { inputTokens: n + 1 } })
  u.recordSessionUsage('s', 'private:1', { seq: 4, type: 'model/selection', time: now, data: { provider, model } })
  assert.deepEqual(persistedRows(timer.read()), [])
  await timer.fire(1500)
  const snapshot = timer.read()
  assert.equal(snapshot.version, 2)
  assert.deepEqual(persistedRows(snapshot).map(row => row.in), Array.from({ length: 270 }, (_, n) => n + 1))
  assert.equal(snapshot.sessions.s.seq, 4)
  assert.equal(snapshot.sessions.s.model, model)
  assert.equal(report().writeFailed, false)
  assert.equal(timer.hasPending(), false)
})

test('用量后台写盘失败后保留旧文件及待写数据，无需新事件即可重试成功', async t => {
  const timer = controlUsageWrite(t)
  let failedFile
  const restore = afterUsageTempWrite(t, file => {
    if (failedFile) return
    failedFile = file
    throw Object.assign(new Error('模拟临时文件写入失败'), { code: 'EIO' })
  })
  try {
    u.recordUsage({ at: now, usage: { inputTokens: 17 } })
    await timer.fire(1500)
    assert.equal(report().writeFailed, true)
    assert.deepEqual(persistedRows(timer.read()), [])
    assert.equal(existsSync(failedFile), false)
    await timer.fire(5000)
    assert.equal(report().writeFailed, false)
    assert.deepEqual(persistedRows(timer.read()).map(row => row.in), [17])
    assert.equal(timer.hasPending(), false)
  } finally {
    restore()
  }
})

for (const [label, flush] of [['手动刷新', u.flushUsage], ['关闭', u.closeUsage]]) {
  test(`用量${label}保留最后一批，旧后台写盘不能覆盖同步提交`, { timeout: 10000 }, async t => {
    const timer = controlUsageWrite(t)
    const staged = Promise.withResolvers()
    const release = Promise.withResolvers()
    const restore = afterUsageTempWrite(t, async file => {
      staged.resolve(file)
      await release.promise
    })
    u.recordUsage({ at: now, usage: { inputTokens: 12 } })
    const background = timer.fire(1500)
    try {
      const temp = await Promise.race([
        staged.promise,
        background.then(() => { throw new Error('后台写盘未生成临时快照') }),
      ])
      assert.deepEqual(persistedRows(JSON.parse(readFileSync(temp, 'utf8'))).map(row => row.in), [12])
      u.recordUsage({ at: now, usage: { inputTokens: 99 } })
      flush()
      assert.deepEqual(persistedRows(timer.read()).map(row => row.in), [12, 99])
      release.resolve()
      await background
      assert.equal(existsSync(temp), false)
      assert.deepEqual(persistedRows(timer.read()).map(row => row.in), [12, 99])
      assert.equal(timer.hasPending(), false)
    } finally {
      release.resolve()
      try { await background }
      finally { restore() }
    }
  })
}
