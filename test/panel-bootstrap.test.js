// 面板首屏提速：三条轻量 GET（/panel/bootstrap|pulse|config）+ /save 保存回执 回归测试
//
// 被测改动（feat/panel-firstscreen）：
//   · src/core/config.js：configRevision() / commitConfig(cfg, previous)（值不变不递增）
//   · src/core/modules.js：summarizeModules()（纯内存摘要）与 navigationRevision()（启停/失败递增）
//   · src/host.js：bootId、三条轻量 GET（未就绪 503 BOOTSTRAPPING、connections 只读缓存无探测）、
//     /save 回执新增 bootId / configRevision / committedPaths / unchangedPaths（RFC6901 路径）
//
// 启动方式对齐 test/panel-access-gate.test.js：AURABOT_DATA_DIR 隔离 + createFakeDsh。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'

const OWNER = '10000001'
const BOT = '20000002'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

let fake
let api
let dataDir

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'aurabot-panel-firstscreen-'))
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mkdirSync(join(dataDir, 'ws'), { recursive: true })
  // 预置密钥字段（测 /panel/config 脱敏）；网关全部关死（autoStart/autoAttach=false、无地址），
  // 保证「轻量 GET 无探测」的断言干净——有探测也打不出去，但配合 fetch 计数一起验。
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    dryRun: true,
    setupDone: true,
    botQQ: BOT,
    ownerQQ: OWNER,
    ownerName: '主人',
    allow: { private: [OWNER], groups: [] },
    snowluma: { autoStart: false, autoAttach: false, dir: join(dataDir, 'no-snowluma'), webuiPassword: 'pw-secret-12345', httpToken: 'tok-secret-6789' },
    imageGen: { enabled: false, apiKey: 'img-key-98765' },
    voice: { engine: 'windows', autoChance: 0 },
    stickers: { autoChance: 0 },
  }))
  // 一个 setup 必炸的用户模块：导航摘要里应出现 availability=error
  const broken = join(dataDir, 'modules', 'broken-mod')
  mkdirSync(broken, { recursive: true })
  writeFileSync(join(broken, 'index.mjs'), "export default { id: 'broken-mod', name: '坏模块', setup() { throw new Error('boom-测试炸') } }\n")
  fake = createFakeDsh({ brain: async () => '嗯' })
  fake.ctx.webServer.port = 5123
  const host = await import('../src/host.js')
  api = host.apply(fake.ctx)
  await api.ready.catch(() => {})
})

after(async () => {
  try { fake.dispose() } catch (e) {}
  try { await api?.dispose?.() } catch (e) {}
})

// ---- 小工具：自带 header 捕获的原始调用（fake.call 的 res 不记 header，测 no-store 用它） ----
async function callRaw(path, { method, headers = {}, body } = {}) {
  const full = '/aurabot/api' + path.split('?')[0]
  const r = fake.routes.get(full)
  assert.ok(r, `路由没注册：${path}`)
  let out = ''
  let status = 200
  const resHeaders = {}
  const req = {
    url: '/aurabot/api' + path,
    headers: { host: '127.0.0.1:5123', ...headers },
    method: method || (body != null ? 'POST' : 'GET'),
    async *[Symbol.asyncIterator]() { if (body) yield JSON.stringify(body) },
  }
  const res = {
    set statusCode(v) { status = v },
    get statusCode() { return status },
    setHeader(k, v) { resHeaders[k.toLowerCase()] = v },
    end(s) { out = s },
  }
  await r.handler(req, res)
  let json = null
  try { json = JSON.parse(out) } catch (e) {}
  return { status, headers: resHeaders, json, raw: () => out }
}

const get = (path) => fake.call(path)
const jsonOf = async (path) => (await fake.call(path)).json()

const hostSource = () => readFileSync(new URL('../src/host.js', import.meta.url), 'utf8')

// ================= 1. 三接口契约 =================

test('bootstrap：字段齐全，bootId 是 UUID，三条 GET 同一 bootId', async () => {
  const b = await jsonOf('/panel/bootstrap')
  for (const k of ['ok', 'bootId', 'configRevision', 'version', 'setupDone', 'controls', 'connections', 'modulesReady', 'navigationRevision', 'modules']) {
    assert.ok(Object.hasOwn(b, k), `bootstrap 缺字段 ${k}`)
  }
  assert.equal(b.ok, true)
  assert.match(b.bootId, UUID_RE, 'bootId 应是 UUID')
  assert.equal(b.setupDone, true)
  assert.equal(b.modulesReady, true, 'boot 完成后 modulesReady 应为 true')

  const p = await jsonOf('/panel/pulse')
  for (const k of ['ok', 'bootId', 'configRevision', 'navigationRevision', 'setupDone', 'controls', 'connections']) {
    assert.ok(Object.hasOwn(p, k), `pulse 缺字段 ${k}`)
  }
  const c = await jsonOf('/panel/config')
  for (const k of ['ok', 'bootId', 'configRevision', 'config']) assert.ok(Object.hasOwn(c, k), `config 缺字段 ${k}`)

  assert.equal(p.bootId, b.bootId, '同一实例三条 GET 的 bootId 一致')
  assert.equal(c.bootId, b.bootId)
  assert.equal(p.configRevision, b.configRevision)
  assert.equal(p.navigationRevision, b.navigationRevision)
})

test('bootstrap：controls 是四个开关的显示值（试运行口径：debug 开时 dryRun 显示为关）', async () => {
  const { controls } = await jsonOf('/panel/bootstrap')
  assert.deepEqual(controls, { enabled: true, dryRun: true, debug: false, safeMode: false })
})

test('connections：只读快照，网关没配时 stage=unconfigured，不连接', async () => {
  const { connections } = await jsonOf('/panel/pulse')
  assert.ok(Array.isArray(connections) && connections.length >= 1, 'connections 要是数组')
  const qq = connections.find((c) => c.platform === 'qq')
  assert.ok(qq, '要有 qq 连接项')
  for (const k of ['platform', 'instanceId', 'enabled', 'stage', 'verified', 'reason', 'login', 'warmupSeconds']) {
    assert.ok(Object.hasOwn(qq, k), `connections.qq 缺字段 ${k}`)
  }
  // 没配网关时：SnowLuma 未装是 disconnected / 完全没配是 unconfigured（两者都算「没连上」）
  assert.ok(['unconfigured', 'disconnected'].includes(qq.stage), `没配网关时应是 unconfigured/disconnected，实际 ${qq.stage}`)
  assert.equal(qq.verified, false)
  assert.equal(qq.login, null, '未核验时 login 必须是 null（不回登录信息）')
})

test('/panel/config 走 publicConfig 脱敏：密钥不回原文，只回 *Set 标记', async () => {
  const { config } = await jsonOf('/panel/config')
  assert.equal(config.snowluma.webuiPassword, '', 'webuiPassword 不能回原文')
  assert.equal(config.snowluma.webuiPasswordSet, true, '要回 webuiPasswordSet=true 告诉面板已设置')
  assert.equal(config.snowluma.httpToken, '')
  assert.equal(config.snowluma.httpTokenSet, true)
  assert.equal(config.imageGen.apiKey, '')
  assert.equal(config.imageGen.apiKeySet, true)
  assert.equal(Object.hasOwn(config, 'ownerAuthorization'), false, '主人授权内部记录不能回面板')
  // 脱敏结果与直接调 publicConfig 一致（面板草稿的唯一来源就是它）
  const { publicConfig } = await import('../src/core/config.js')
  assert.deepEqual(config, publicConfig(api.getConfig()))
})

test('三条 GET 都带 no-store（首屏轮询绝不能被缓存）', async () => {
  for (const p of ['/panel/bootstrap', '/panel/pulse', '/panel/config']) {
    const r = await callRaw(p)
    assert.equal(r.status, 200)
    assert.equal(r.headers['cache-control'], 'no-store', `${p} 必须带 cache-control: no-store`)
  }
})

// ================= 2. 503 BOOTSTRAPPING =================

test('503 闸：三条路由都先过 bootstrapping 闸（静态契约），就绪后 200（动态）', async () => {
  const src = hostSource()
  // 闸本体：未就绪 → 503 + { ok:false, code:'BOOTSTRAPPING', bootId }
  assert.match(src, /const bootstrapping = \(res\) => \{[\s\S]{0,200}?panelCoreReady[\s\S]{0,200}?send\(res, 503, \{ ok: false, code: 'BOOTSTRAPPING', bootId \}\)/, '要有 503 BOOTSTRAPPING 闸')
  // 三条路由都在第一行过闸
  for (const p of ['/panel/bootstrap', '/panel/pulse', '/panel/config']) {
    assert.match(src, new RegExp(`route\\('${p.replace(/\//g, '\\/')}', async \\(req, res\\) => \\{\\s*if \\(bootstrapping\\(res\\)\\) return`), `${p} 必须先过 503 闸`)
  }
  // panelCoreReady 在三条路由注册完才放开
  assert.match(src, /panelCoreReady = true/, '要有就绪开关')
  // 动态：宿主就绪后绝不回 503
  for (const p of ['/panel/bootstrap', '/panel/pulse', '/panel/config']) {
    const r = await get(p)
    assert.equal(r.status, 200, `${p} 就绪后应是 200`)
    assert.notEqual(r.json().code, 'BOOTSTRAPPING')
  }
})

// ================= 3. 无探测隔离 =================

test('无探测隔离：三条 GET 期间全局 fetch 0 次调用（不打 SnowLuma/OneBot）', async () => {
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (...args) => { calls++; return realFetch(...args) }
  try {
    await get('/panel/bootstrap')
    await get('/panel/pulse')
    await get('/panel/config')
  } finally {
    globalThis.fetch = realFetch
  }
  assert.equal(calls, 0, `三条轻量 GET 打了 ${calls} 次网络探测（首屏铁规矩：只读内存）`)
  // 顺手确认没把网关带起来：连接快照仍是非连接态
  const { connections } = await jsonOf('/panel/pulse')
  const qq = connections.find((c) => c.platform === 'qq')
  assert.ok(['unconfigured', 'disconnected', 'connecting'].includes(qq.stage), '轻量 GET 不允许触发网关连接')
})

// ================= 4. 保存回执 =================

test('保存回执：正常保存 committedPaths 正确，版本恰好 +1', async () => {
  const revBefore = (await jsonOf('/panel/pulse')).configRevision
  const r = (await fake.call('/save', { voice: { engine: 'http', http: { urlTemplate: 'http://127.0.0.1:9/tts?text={text}' } } })).json()
  assert.equal(r.ok, true)
  assert.match(r.bootId, UUID_RE, '保存回执也要带 bootId')
  assert.ok(r.committedPaths.includes('/voice/engine'), `committedPaths 应含 /voice/engine，实际 ${JSON.stringify(r.committedPaths)}`)
  assert.ok(r.committedPaths.includes('/voice/http/urlTemplate'), 'committedPaths 应含 /voice/http/urlTemplate')
  assert.deepEqual(r.unchangedPaths, [], '这次全是改动，unchangedPaths 应为空')
  assert.equal(r.configRevision, revBefore + 1, '一次提交，版本应恰好 +1')
  assert.equal(api.getConfig().voice.engine, 'http', '保存真的生效了')
})

test('保存回执：RFC6901 路径转义（~ → ~0、/ → ~1）', async () => {
  const r = (await fake.call('/save', { ext: { 'mod~a/b': { flag: true } } })).json()
  assert.equal(r.ok, true)
  assert.ok(r.committedPaths.includes('/ext/mod~0a~1b/flag'), `含 ~ 与 / 的键要按 RFC6901 转义，实际 ${JSON.stringify(r.committedPaths)}`)
  assert.equal(api.getConfig().ext['mod~a/b']?.flag, true, '转义路径要能对应回真实配置')
})

test('保存回执：值相同 → unchangedPaths + 版本不递增（不重复落盘）', async () => {
  const revBefore = (await jsonOf('/panel/pulse')).configRevision
  const r = (await fake.call('/save', { voice: { engine: 'http', http: { urlTemplate: 'http://127.0.0.1:9/tts?text={text}' } } })).json()
  assert.equal(r.ok, true)
  assert.deepEqual(r.committedPaths, [], '没变化的字段不能进 committedPaths')
  assert.ok(r.unchangedPaths.includes('/voice/engine'), 'unchangedPaths 应含 /voice/engine')
  assert.ok(r.unchangedPaths.includes('/voice/http/urlTemplate'))
  assert.equal(r.configRevision, revBefore, '值没变版本不得递增')
})

test('保存回执：校验失败 → committed/unchanged 都是空数组 + 当前版本', async () => {
  const revBefore = (await jsonOf('/panel/pulse')).configRevision
  const r = (await fake.call('/save', { memory: { passiveGroups: '不是群号' } })).json()
  assert.equal(r.ok, false)
  assert.equal(r.code, 'invalid_passive_groups')
  assert.deepEqual(r.committedPaths, [], '校验失败不能有任何 committedPaths')
  assert.deepEqual(r.unchangedPaths, [], '校验失败也不能有 unchangedPaths')
  assert.equal(r.configRevision, revBefore, '失败的保存不递增版本')
  assert.match(r.bootId, UUID_RE)
})

test('保存回执：部分失败（控制台密码没改成）→ 回执仍含已落盘字段与其版本', async () => {
  const revBefore = (await jsonOf('/panel/pulse')).configRevision
  const r = (await fake.call('/save', { ownerName: '回执测试主人', snowluma: { webuiPassword: 'weak' } })).json()
  assert.equal(r.ok, false, '弱密码改控制台密码要失败')
  assert.match(String(r.message || ''), /控制台密码没改/)
  assert.ok(r.committedPaths.includes('/ownerName'), '其他已落盘字段要如实进 committedPaths')
  assert.ok(r.configRevision > revBefore, '已落盘的提交要推进版本')
  assert.equal(api.getConfig().ownerName, '回执测试主人', '除密码外的字段要真的保存了')
})

// ================= 5. 版本语义 =================

test('configRevision：api.setConfig 写入推进版本；值相同不递增（单调不回退）', async () => {
  const { configRevision } = await import('../src/core/config.js')
  const r0 = configRevision()
  assert.equal((await jsonOf('/panel/pulse')).configRevision, r0, '面板接口报的版本要和 configRevision() 一致')
  api.setConfig({ ...api.getConfig(), ownerName: '版本递增主人' })
  assert.equal(configRevision(), r0 + 1, '有实际变化的 setConfig 要 +1')
  api.setConfig({ ...api.getConfig(), ownerName: '版本递增主人' })
  assert.equal(configRevision(), r0 + 1, '值完全相同的 setConfig 不得递增')
  api.setConfig({ ...api.getConfig(), ownerName: '版本递增主人2' })
  assert.equal(configRevision(), r0 + 2, '再次变化继续 +1（单调递增）')
})

test('重启语义：新实例（新 bootId）版本从 0 重算', async () => {
  // configRevision 计数器是模块级状态：真重启 = 新进程 = 新模块实例。这里用 cache-busting
  // import 拿一个全新实例来验证「实例内从 0 起算 + 实例内单调」。
  const fresh = await import('../src/core/config.js?fresh-instance=1')
  assert.equal(fresh.configRevision(), 0, '全新实例版本从 0 起算')
  const c1 = fresh.commitConfig({ ownerName: '新实例甲' }, {})
  assert.equal(fresh.configRevision(), 1, '首次提交 → 1')
  fresh.commitConfig({ ownerName: '新实例甲' }, c1)
  assert.equal(fresh.configRevision(), 1, '值相同不递增')
  fresh.commitConfig({ ownerName: '新实例乙' }, c1)
  assert.equal(fresh.configRevision(), 2, '变化继续递增')
  // 宿主实例自己的版本不受新实例影响（各自独立计数）
  const host = await import('../src/core/config.js')
  const rev = host.configRevision()
  assert.ok(rev >= 0)
  assert.equal((await jsonOf('/panel/pulse')).configRevision, rev)
})

// ================= 6. summarizeModules =================

test('summarizeModules：字段齐全、内置模块 ready、坏模块 error、导航版本一致', async () => {
  const mods = api.modules
  const s = mods.summarizeModules()
  assert.ok(Array.isArray(s.modules) && s.modules.length > 0, '要有模块摘要')
  assert.equal(s.navigationRevision, mods.navigationRevision(), '摘要里带的版本号要和 navigationRevision() 一致')
  const byId = new Map(s.modules.map((m) => [m.id, m]))
  // 每项字段齐全
  for (const m of s.modules) {
    for (const k of ['id', 'name', 'tab', 'navGroup', 'hasSettings', 'hasPanel', 'enabled', 'running', 'platforms', 'availability', 'error']) {
      assert.ok(Object.hasOwn(m, k), `模块摘要缺字段 ${k}（${m.id}）`)
    }
    assert.ok(['ready', 'error', 'disabled', 'stopped', 'unloaded'].includes(m.availability), `availability 枚举外的值：${m.availability}`)
  }
  // 内置模块在跑：ready + running='builtin'
  const mood = byId.get('mood')
  assert.ok(mood, '摘要要含内置模块 mood')
  assert.equal(mood.availability, 'ready')
  assert.equal(mood.running, 'builtin')
  assert.equal(mood.enabled, true)
  assert.equal(mood.error, '')
  // setup 必炸的用户模块：error 态
  const broken = byId.get('broken-mod')
  assert.ok(broken, '摘要要含坏的用户模块')
  assert.equal(broken.availability, 'error')
  assert.equal(broken.running, null)
  assert.match(broken.error, /boom-测试炸/, 'error 态要带错误消息')
})

test('导航版本：模块停/起时 navigationRevision 递增，摘要同步变化', async () => {
  const mods = api.modules
  const revBefore = mods.navigationRevision()
  // 停 song（低风险模块，不影响聊天链路）
  const off = (await fake.call('/save', { modules: { song: { enabled: false } } })).json()
  assert.equal(off.ok, true)
  assert.ok(mods.navigationRevision() > revBefore, '停用模块要递增导航版本')
  let song = mods.summarizeModules().modules.find((m) => m.id === 'song')
  assert.equal(song.availability, 'disabled', '停用后 availability=disabled')
  assert.equal(song.running, null)
  assert.equal(song.enabled, false)

  const revOff = mods.navigationRevision()
  const on = (await fake.call('/save', { modules: { song: { enabled: true } } })).json()
  assert.equal(on.ok, true)
  assert.ok(mods.navigationRevision() > revOff, '重新启用也要递增导航版本')
  song = mods.summarizeModules().modules.find((m) => m.id === 'song')
  assert.equal(song.availability, 'ready')
  assert.equal(song.running, 'builtin')
  assert.equal(song.enabled, true)
})

test('summarizeModules 纯内存：不调 scanUser 重扫、不做文件系统遍历（静态契约）', async () => {
  const src = readFileSync(new URL('../src/core/modules.js', import.meta.url), 'utf8')
  const start = src.indexOf('function summarizeModules')
  assert.ok(start > 0, '要有 summarizeModules')
  // 函数体截到下一个顶层函数为止
  const end = src.indexOf('\n  function ', start + 10)
  const body = src.slice(start, end)
  assert.ok(!/scanUser\s*\(/.test(body), 'summarizeModules 不准调 scanUser（首屏只准碰内存）')
  assert.ok(!/readdirSync|statSync|readFileSync/.test(body), 'summarizeModules 不准碰文件系统')
})
