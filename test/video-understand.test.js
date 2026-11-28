// 视频理解模块的纯逻辑测试。不联网、不调第三方 API；ffmpeg 探测只碰本地。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import def from '../src/modules/video-understand/index.js'
import { normalizeInput, createEngine, resultCacheKey } from '../src/modules/video-understand/engine.js'
import { classifyError, withRetry, describeVisualThird } from '../src/modules/video-understand/channels.js'
import { createCache, cacheKey } from '../src/modules/video-understand/cache.js'
import { findFfmpeg } from '../src/core/img.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'vu-test-'))

function mockApi({ overrides = {}, t } = {}) {
  return {
    settings: () => ({ ...def.defaults, ...overrides }),
    config: () => ({ bili: {} }),
    dataDir: (...p) => join(t, ...p),
    dsh: { get: () => null },
    log: { info: () => {}, warn: () => {} },
    route: () => {},
    core: {}, // 没有 onebot
  }
}

test('模块契约：id 与默认值（双通道默认 A、原生 API 默认关、缓存默认开）', () => {
  assert.equal(def.id, 'video-understand')
  assert.equal(def.defaults.visualChannel, 'dsh')
  assert.equal(def.defaults.asrChannel, 'dsh')
  assert.equal(def.defaults.nativeEnabled, false, '原生视频 API 默认关')
  assert.equal(def.defaults.cacheEnabled, true)
  assert.equal(def.defaults.frameCount, 6)
  // settings 表单里出现的键必须都在 defaults 里，防止面板写错键
  const keys = new Set(Object.keys(def.defaults))
  for (const s of def.settings) assert.ok(keys.has(s.key), `settings 键 ${s.key} 不在 defaults 里`)
})

test('normalizeInput：四种形态都能认出来', () => {
  assert.equal(normalizeInput('BV1xx411c7mD').kind, 'bilibili')
  assert.equal(normalizeInput('https://www.bilibili.com/video/BV1xx411c7mD?p=2').p, 2, '分P参数保留进缓存身份')
  assert.equal(normalizeInput('https://www.bilibili.com/video/av170001').kind, 'bilibili')
  assert.equal(normalizeInput('https://b23.tv/abc123').kind, 'bilibili-short')
  assert.equal(normalizeInput('https://example.com/a.mp4').kind, 'url')
  assert.equal(normalizeInput('C:\\videos\\demo.mp4').kind, 'local')
  assert.equal(normalizeInput({ path: 'D:/x/y.mp4' }).kind, 'local')
  assert.equal(normalizeInput({ url: 'https://example.com/a.mp4' }).kind, 'url')
  assert.equal(normalizeInput({ messageId: 12345 }).kind, 'qq-voice')
  assert.throws(() => normalizeInput(''), '空输入要抛错')
  assert.throws(() => normalizeInput({}), '空对象要抛错')
  assert.throws(() => normalizeInput('这不是视频$$'), '认不出的要抛错')
})

test('cache：读写往返、TTL 过期、损坏自愈、容量淘汰', () => {
  const t = tmp()
  const c = createCache({ dir: join(t, 'cache') })
  const key = cacheKey(['identity', { nv: true }])
  c.put(key, { hello: 'world' })
  const hit = c.get(key, 3600)
  assert.equal(hit.hello, 'world')
  assert.ok(hit.cachedAt, '命中结果带 cachedAt')
  assert.deepEqual(c.stats, { hits: 1, misses: 0 })

  // TTL：手动把记录改成旧时间
  const file = join(t, 'cache', key + '.json')
  const rec = JSON.parse(readFileSync(file, 'utf8'))
  rec.savedAt = Date.now() - 2 * 3600 * 1000
  writeFileSync(file, JSON.stringify(rec))
  assert.equal(c.get(key, 3600), null, '过期当未命中')
  assert.ok(!existsSync(file), '过期记录被清掉')

  // 损坏自愈
  const bad = cacheKey(['bad'])
  writeFileSync(join(t, 'cache', bad + '.json'), '{oops')
  assert.equal(c.get(bad, 3600), null, '损坏当未命中')
  assert.ok(!existsSync(join(t, 'cache', bad + '.json')), '损坏记录被清掉')

  // 容量淘汰：上限 2，放 3 个剩 2
  const c2 = createCache({ dir: join(t, 'cache2') })
  for (const k of ['a', 'b', 'c']) c2.put(cacheKey([k]), {})
  c2.trim(2)
  assert.equal(c2.count(), 2)
})

test('classifyError：content-filter 必须不可重试，限流/服务端/超时可重试', () => {
  const mk = (props) => classifyError(Object.assign(new Error('x'), props))
  assert.equal(mk({ status: 401 }).kind, 'auth')
  assert.equal(mk({ status: 401 }).retryable, false)
  assert.equal(mk({ status: 429 }).retryable, true, '限流可重试')
  assert.equal(mk({ status: 500 }).retryable, true, '服务端可重试')
  assert.equal(mk({ status: 404 }).kind, 'notfound')
  const cf = classifyError(new Error('content_filter: sensitive content detected'))
  assert.equal(cf.kind, 'content-filter')
  assert.equal(cf.retryable, false, '内容审查绝不可重试（避免重复计费）')
  const cf2 = classifyError(new Error('您的请求包含敏感内容，无法处理'))
  assert.equal(cf2.retryable, false, '中文审查话术同样不可重试')
  const to = classifyError(Object.assign(new Error('timeout'), { name: 'TimeoutError' }))
  assert.equal(to.retryable, true, '超时可重试')
  assert.equal(classifyError(new Error('fetch failed')).retryable, true, '网络错误可重试')
})

test('withRetry：可重试错误退避重试，不可重试立刻抛', async () => {
  let n = 0
  const r = await withRetry(async () => {
    if (++n < 2) { const e = new Error('boom'); e.status = 500; throw e }
    return 'ok'
  }, { retries: 3 })
  assert.equal(r, 'ok')
  assert.equal(n, 2)

  let m = 0
  await assert.rejects(
    withRetry(async () => { m++; const e = new Error('content_filter hit'); throw e }, { retries: 3 }),
    /content_filter/,
  )
  assert.equal(m, 1, 'content-filter 一次都不重试')
})

test('setup：返回五个导出并注册两条路由', () => {
  const t = tmp()
  const routes = []
  const api = mockApi({ t })
  api.route = (path) => routes.push(path)
  const engine = def.setup(api)
  for (const fn of ['understand', 'supports', 'estimate', 'status', 'clearCache']) {
    assert.equal(typeof engine[fn], 'function', `导出 ${fn}`)
  }
  assert.ok(routes.includes('/video-understand/status'))
  assert.ok(routes.includes('/video-understand/clear-cache'))
})

test('supports：按输入类型与配置给路线（同步零网络）', () => {
  const t = tmp()
  const api = mockApi({ t })
  const engine = def.setup(api)
  const bv = engine.supports('BV1xx411c7mD')
  assert.equal(bv.input.kind, 'bilibili')
  const byName = Object.fromEntries(bv.routes.map((r) => [r.route, r]))
  assert.equal(byName.subtitle.ok, true, 'B站有字幕路线')
  assert.equal(byName.native.ok, false, '原生 API 默认关')

  const noSub = def.setup(mockApi({ t, overrides: { preferSubtitle: false } })).supports('BV1xx411c7mD')
  assert.equal(Object.fromEntries(noSub.routes.map((r) => [r.route, r])).subtitle.ok, false)

  const local = engine.supports('C:\\videos\\demo.mp4')
  assert.equal(Object.fromEntries(local.routes.map((r) => [r.route, r])).subtitle.ok, false, '本地文件没有字幕路线')

  const ptt = engine.supports({ messageId: 1 })
  assert.ok(ptt.routes.some((r) => r.route === 'ptt'), '语音条给 ptt 路线')
  assert.ok(engine.supports('!!!').error, '认不出的输入给 error')
})

test('understand 错误路径：空输入 / 认不出 / 文件不存在 / 超限 / 语音条没 onebot，全部不炸', async () => {
  const t = tmp()
  const engine = def.setup(mockApi({ t }))
  await assert.rejects(() => engine.understand(''))
  await assert.rejects(() => engine.understand('这不是视频$$'))

  await assert.rejects(
    () => engine.understand(join(t, 'no-such-file.mp4')),
    (e) => e.code === 'ENOENT',
    '文件不存在给 ENOENT',
  )

  const small = join(t, 'tiny.mp4')
  writeFileSync(small, Buffer.alloc(2048, 1))
  await assert.rejects(
    () => def.setup(mockApi({ t, overrides: { maxSizeMB: 0.001 } })).understand(small),
    (e) => e.code === 'TOO_BIG',
    '超过大小上限给 TOO_BIG（不产生任何费用）',
  )

  await assert.rejects(
    () => engine.understand({ messageId: 999 }),
    (e) => e.code === 'NO_RESULT' && e.tried.some((x) => x.route === 'ptt' && !x.ok),
    '语音条拿不到 onebot 时记录失败原因再抛 NO_RESULT',
  )

  // SSRF：内网地址直接拒绝
  await assert.rejects(() => engine.understand('http://127.0.0.1:9/x.mp4'))
})

test('status：双通道就绪情况如实上报', () => {
  const t = tmp()
  const engine = def.setup(mockApi({ t }))
  const st = engine.status()
  assert.equal(st.enabled, true)
  assert.equal(st.channels.visual.channel, 'dsh')
  assert.equal(st.channels.visual.ready, true, '通道A视觉默认就绪')
  assert.equal(st.channels.asr.ready, false, '没有 DSH 语音输入时 ASR 不就绪')
  assert.ok(st.cache && typeof st.cache.entries === 'number')
  assert.equal(engine.clearCache().ok, true)
})

/* ---------------- 验收修复回归（M1~M4） ---------------- */

test('M1 classifyError：带状态码的审查话术也必须不可重试（状态码分支不再短路）', () => {
  const mk = (status, msg) => classifyError(Object.assign(new Error(msg), { status }))
  const r1 = mk(500, 'HTTP 500: {"error":{"code":"content_filter"}}')
  assert.equal(r1.kind, 'content-filter')
  assert.equal(r1.retryable, false, '500 + content_filter 不可重试')
  const r2 = mk(400, '您的请求包含敏感内容，无法处理')
  assert.equal(r2.retryable, false, '400 + 中文审查话术不可重试')
  assert.equal(mk(429, 'too many requests').retryable, true, '429 无审查词仍可重试')
  assert.equal(mk(500, 'internal error').retryable, true, '500 无审查词仍可重试')
})

test('n1 审查关键词收窄：普通 5xx 消息不再被误判为 content-filter（验收回归用例）', () => {
  const mk = (status, msg) => classifyError(Object.assign(new Error(msg), { status }))
  const r1 = mk(500, 'header is case sensitive')
  assert.equal(r1.kind, 'server')
  assert.equal(r1.retryable, true, `'header is case sensitive' 不含 sensitive content 短语，应可重试`)
  const r2 = mk(500, 'safety check failed in gateway')
  assert.equal(r2.kind, 'server', `'safety check failed' 不再命中已删除的 safety 裸词`)
  assert.equal(r2.retryable, true)
  const r3 = mk(500, 'request body is invalid: moderation_id missing')
  assert.equal(r3.kind, 'bad-request', `'moderation_id missing' 是参数错误（负向断言拦住审查判定）`)
  assert.equal(r3.retryable, false, '参数错误不可重试')
  const r4 = mk(500, 'database safety valve triggered')
  assert.equal(r4.kind, 'server')
  assert.equal(r4.retryable, true)

  // 收窄后真审查必须仍然不可重试（原矩阵不回归）
  assert.equal(mk(500, 'HTTP 500: {"error":{"code":"content_filter"}}').retryable, false, '真 500+content_filter 仍不可重试')
  assert.equal(mk(400, '您的请求包含敏感内容，无法处理').retryable, false, '真 400+敏感内容 仍不可重试')
  assert.equal(mk(403, 'content policy violation').retryable, false, 'content policy violation 仍不可重试')
  assert.equal(mk(500, 'moderation check failed for this content').retryable, false, 'moderation + 内容语义仍不可重试')
})

test('n1b 裸 violation 收窄：协议/Schema 违规是普通 5xx，不再误判为审查（第三轮验收回归用例）', () => {
  const mk = (status, msg) => classifyError(Object.assign(new Error(msg), { status }))
  const r1 = mk(500, 'protocol violation detected')
  assert.equal(r1.kind, 'server', `'protocol violation detected' 是普通 5xx`)
  assert.equal(r1.retryable, true)
  const r2 = mk(500, 'schema violation in response')
  assert.equal(r2.kind, 'server', `'schema violation in response' 是普通 5xx`)
  assert.equal(r2.retryable, true)
  const r3 = mk(500, 'moderation_id invalid')
  assert.equal(r3.kind, 'server', `'moderation_id invalid' 可能是网关临时故障，回落 server 可重试`)
  assert.equal(r3.retryable, true)
  const r4 = mk(500, 'moderation_id missing')
  assert.equal(r4.kind, 'bad-request', `'moderation_id missing' 仍是参数错误不可重试`)
  assert.equal(r4.retryable, false)
  assert.equal(mk(403, 'content policy violation').kind, 'content-filter', 'content policy violation 仍是审查')
  assert.equal(mk(500, 'content policy violation').retryable, false, '500 + content policy violation 仍不可重试')
})

async function startServer(handler) {
  return new Promise((resolve) => {
    const s = createServer((req, res) => { req.resume(); handler(req, res) })
    s.listen(0, '127.0.0.1', () => resolve(s))
  })
}
const baseOf = (srv) => `http://127.0.0.1:${srv.address().port}/v4`
const FAKE_FRAMES = [{ tSec: 0, buf: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 1)]) }]
const thirdSettings = (srv) => ({ visualBaseUrl: baseOf(srv), visualApiKey: 'k', visualModel: 'm', visualMaxTokens: 100 })

test('M2 真实 HTTP：!res.ok 在重试循环内——500 重试后成功、400 不重试、429 重试到尽', async () => {
  // ① 500 一次后 200：应重试并拿到结果
  let n = 0
  const srv1 = await startServer((req, res) => {
    n++
    res.setHeader('content-type', 'application/json')
    if (n === 1) { res.statusCode = 500; res.end(JSON.stringify({ error: 'upstream hiccup' })) }
    else res.end(JSON.stringify({ choices: [{ message: { content: 'ok-desc' } }] }))
  })
  try {
    const r = await describeVisualThird({ settings: thirdSettings(srv1), info: {}, frames: FAKE_FRAMES, log: () => {} })
    assert.equal(r.text, 'ok-desc')
    assert.equal(n, 2, '500 应触发一次重试（共 2 次）')
  } finally { srv1.close() }

  // ② 400：不可重试，只打一次
  let m = 0
  const srv2 = await startServer((req, res) => {
    m++
    res.statusCode = 400
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ error: 'invalid request' }))
  })
  try {
    await assert.rejects(
      () => describeVisualThird({ settings: thirdSettings(srv2), info: {}, frames: FAKE_FRAMES, log: () => {} }),
      /HTTP 400/,
    )
    assert.equal(m, 1, '400 不重试')
  } finally { srv2.close() }

  // ③ 429：可重试，retries:1 → 共两次后抛 rate-limit
  let k = 0
  const srv3 = await startServer((req, res) => {
    k++
    res.statusCode = 429
    res.end('rate limited')
  })
  try {
    await assert.rejects(
      () => describeVisualThird({ settings: thirdSettings(srv3), info: {}, frames: FAKE_FRAMES, log: () => {} }),
      (e) => e.kind === 'rate-limit',
    )
    assert.equal(k, 2, '429 重试一次（共 2 次）')
  } finally { srv3.close() }
})

test('M3 estimate：内网 URL 被 SSRF 校验拒绝，不发起连接', async () => {
  const t = tmp()
  const engine = def.setup(mockApi({ t }))
  const r = await engine.estimate('http://127.0.0.1:9/x.mp4')
  assert.ok(r.error, `应返回 error 字段（实际 ${JSON.stringify(r)}）`)
})

test('M4 resultCacheKey：换通道/端点/模型/提示词必须换 key；apiKey 不参与 key', () => {
  const id = 'bili:BV1xx411c7mD:p1'
  const d = def.defaults
  const k = (over, opt = {}) => resultCacheKey(id, { ...d, ...over }, opt)
  const base = k()
  assert.notEqual(k({ visualChannel: 'third' }), base, '换视觉通道')
  assert.notEqual(k({ visualBaseUrl: 'http://a/v4' }), k({ visualBaseUrl: 'http://b/v4' }), '换视觉端点')
  assert.notEqual(k({ visualModel: 'other-model' }), base, '换视觉模型')
  assert.notEqual(k({ visualPrompt: '自定义提示词' }), base, '换提示词')
  assert.notEqual(k({ visualDshModel: 'zhipu/glm-4.6v' }), base, '换通道A模型覆盖')
  assert.notEqual(k({ asrChannel: 'third' }), base, '换 ASR 通道')
  assert.notEqual(k({ asrBaseUrl: 'http://x/v1' }), base, '换 ASR 端点')
  assert.notEqual(k({ asrModel: 'whisper-large' }), base, '换 ASR 模型')
  assert.notEqual(k({ asrLanguage: 'zh' }), base, '换语言提示')
  assert.equal(k({ visualApiKey: 'sk-CHANGED' }), base, 'apiKey 不参与 key（baseUrl 已可区分端点）')
  assert.notEqual(k({}, { saveFrames: true }), base, 'saveFrames 参与 key')
  assert.notEqual(k({}, { needsVisual: true }), base, 'needsVisual 参与 key')
  // n2：路线开关与语言覆盖也参与 key
  assert.notEqual(k({}, { language: 'zh' }), base, 'options.language 参与 key')
  assert.notEqual(k({ preferSubtitle: false }), base, 'cfg.preferSubtitle 参与 key')
  assert.notEqual(k({}, { preferSubtitle: false }), base, 'options.preferSubtitle 参与 key')
  assert.notEqual(k({ preferAsr: false }), base, 'cfg.preferAsr 参与 key')
  assert.notEqual(k({ autoVisual: false }), base, 'cfg.autoVisual 参与 key')
})

test('双通道互备降级：通道A(DSH)不可用但第三方配置齐全时自动切换并出结果', async (t) => {
  const ffmpeg = findFfmpeg('')
  if (!ffmpeg) return t.skip('本机无 ffmpeg')
  const dir = tmp()
  const mp4 = join(dir, 'tiny.mp4')
  const gen = spawnSync(ffmpeg, ['-f', 'lavfi', '-i', 'testsrc=duration=1:size=128x96:rate=1', '-pix_fmt', 'yuv420p', '-y', mp4], { timeout: 30000, stdio: 'ignore' })
  if (gen.error || gen.status !== 0 || !existsSync(mp4)) return t.skip('lavfi 测试视频生成失败')

  let n = 0
  const srv = await startServer((req, res) => {
    n++
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ choices: [{ message: { content: 'mock 第三方画面描述' } }] }))
  })
  try {
    const api = mockApi({
      t: dir,
      overrides: { visualChannel: 'dsh', visualBaseUrl: baseOf(srv), visualApiKey: 'k', visualModel: 'test-model' },
    })
    const engine = def.setup(api)
    const r = await engine.understand(mp4, { needsVisual: true })
    assert.equal(r.visual.description, 'mock 第三方画面描述', '主通道不可用时应拿到第三方结果')
    assert.ok(r.route.tried.some((x) => x.route === 'frames:dsh' && !x.ok), 'tried 记录通道A不可用原因')
    assert.ok(r.route.chosen.includes('frames'), 'chosen 记录 frames 路线')
    assert.equal(n, 1, '第三方端点恰好被调用一次')
  } finally { srv.close() }
})
