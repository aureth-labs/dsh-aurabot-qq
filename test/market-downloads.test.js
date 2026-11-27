// 模块市场的下载量：从模块库 Releases 聚合、按 tag 认模块、读不到时降级、缓存不重复读。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { crc32, deflateRawSync } from 'node:zlib'
import { createFakeDsh } from './helpers/fake-dsh.js'

let root, createCommunity, userDir

const zip = (files) => {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text)
    const path = Buffer.from(name)
    const body = deflateRawSync(data)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(0x0800, 6)
    head.writeUInt16LE(8, 8)
    head.writeUInt32LE(crc32(data), 14)
    head.writeUInt32LE(body.length, 18)
    head.writeUInt32LE(data.length, 22)
    head.writeUInt16LE(path.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    head.copy(central, 6, 4, 30)
    central.writeUInt32LE(offset, 42)
    locals.push(head, path, body)
    centrals.push(central, path)
    offset += head.length + path.length + body.length
  }
  const dir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  const n = Object.keys(files).length
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(n, 8)
  end.writeUInt16LE(n, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}

const pack = (id, version, code = 'export default {}') => {
  const buf = zip({ 'module.json': JSON.stringify({ id, version }), 'index.mjs': code })
  return { buf, entry: { id, name: id, version, api: 1, minPluginVersion: '1.0.0', requires: [], capabilities: [], path: `${id}/${id}.zip`, sha256: createHash('sha256').update(buf).digest('hex') } }
}

/** releases 是按页返回的假 GitHub 列表。 */
function setup(packs, { releases = [], releasesFail = null, assetsBase = 'https://github.com/aureth-labs/dsh-aurabot-qq-mods/releases/download/' } = {}) {
  const asked = []
  const fetcher = async (url) => {
    asked.push(url)
    if (url.endsWith('index.json')) return { ok: true, json: async () => ({ schema: 1, assetsBase, modules: packs.map((p) => p.entry) }) }
    if (url.includes('api.github.com')) {
      if (releasesFail) return { ok: false, status: releasesFail }
      const page = Number(new URL(url).searchParams.get('page') || 1)
      return { ok: true, json: async () => releases[page - 1] || [] }
    }
    const p = packs.find((x) => url.endsWith(x.entry.path))
    return { ok: true, arrayBuffer: async () => p.buf }
  }
  const mods = { status: () => [], sync: async () => {}, stop: () => true }
  const c = createCommunity({ mods, getConfig: () => ({}), setConfig() {}, log: { info() {}, warn() {}, debug() {} }, version: '1.2.0', registryUrl: 'https://x/index.json', fetcher })
  return { c, asked, apiCalls: () => asked.filter((u) => u.includes('api.github.com')) }
}

const rel = (tag, counts, publishedAt) => ({ tag_name: tag, assets: counts.map((n) => ({ name: `x-${n}.zip`, download_count: n })), ...(publishedAt ? { published_at: publishedAt } : {}) })

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'aurabot-community-dl-'))
  process.env.AURABOT_DATA_DIR = root
  ;({ createCommunity } = await import('../src/core/community.js'))
  ;({ userDir } = await import('../src/core/modules.js'))
  mkdirSync(userDir(), { recursive: true })
})
after(() => rmSync(root, { recursive: true, force: true }))

test('每个模块的下载量：按 tag 累加所有版本和资产', async () => {
  const packs = [pack('pet', '1.0.0'), pack('douyin', '2.0.0')]
  const s = setup(packs, {
    releases: [[
      rel('pet-v1.0.7', [3, 2]),
      rel('pet-v1.0.6', [12]),
      rel('douyin-v2.0.4', [0]),
      rel('phone-v0.1.0', [4]),
    ]],
  })
  const r = await s.c.list()
  const byId = Object.fromEntries(r.list.map((m) => [m.id, m]))
  assert.equal(byId.pet.downloads, 17, '同一模块多个版本要累加')
  assert.equal(byId.douyin.downloads, 0)
  assert.equal(r.downloads.source, 'aureth-labs/dsh-aurabot-qq-mods')
  assert.equal(r.downloads.failed, false)
  // 只在 GitHub 上有包的模块，索引里没有就不凭空冒出来
  assert.equal(byId.phone, undefined)
})

test('认识的 tag 才统计，翻页要翻完；没资产的版本记 0', async () => {
  const packs = [pack('pet', '1.0.0')]
  const first = Array.from({ length: 100 }, (_, i) => rel(`pet-v1.0.${i}`, [1]))
  const s = setup(packs, { releases: [first, [rel('pet-v1.1.0', [5]), rel('not-a-tag', [99]), { tag_name: 'pet-v9.9.9' }]] })
  const r = await s.c.list()
  assert.equal(r.list[0].downloads, 105, '第二页也要算进来，没资产的 tag 记 0')
})

test('索引里的仓库地址决定查哪个仓库；域名不对就不查', async () => {
  const packs = [pack('pet', '1.0.0')]
  const good = setup(packs, { releases: [[rel('pet-v1.0.0', [7])]] })
  await good.c.list()
  assert.match(good.apiCalls()[0], /^https:\/\/api\.github\.com\/repos\/aureth-labs\/dsh-aurabot-qq-mods\/releases\?/)
  const bad = setup(packs, { releases: [[rel('pet-v1.0.0', [7])]], assetsBase: 'https://example.com/dl/' })
  const r = await bad.c.list()
  assert.equal(bad.apiCalls().length, 0, '认不出仓库就不去问 GitHub')
  assert.equal(r.list[0].downloads, 0)
  assert.equal(r.downloads.source, '', 'registryUrl 也认不出 owner/repo')
})

test('读不到下载量时市场照常可用（403 / 500 / 断网都算）', async () => {
  for (const fail of [403, 500]) {
    const s = setup([pack('pet', '1.0.0')], { releasesFail: fail })
    const r = await s.c.list()
    assert.equal(r.list.length, 1, '市场列表不受影响：' + fail)
    assert.equal(r.list[0].downloads, 0)
    assert.equal(r.downloads.failed, true)
  }
  const broken = createCommunity({
    mods: { status: () => [], sync: async () => {}, stop: () => true },
    getConfig: () => ({}), setConfig() {}, log: { info() {}, warn() {}, debug() {} }, version: '1.2.0', registryUrl: 'https://x/index.json',
    fetcher: async (url) => {
      if (url.endsWith('index.json')) return { ok: true, json: async () => ({ schema: 1, assetsBase: 'https://github.com/o/r/releases/download/', modules: [pack('pet', '1.0.0').entry] }) }
      throw new TypeError('fetch failed')
    },
  })
  const r = await broken.list()
  assert.equal(r.list.length, 1)
  assert.equal(r.list[0].downloads, 0)
})

test('下载量有缓存：连着打开市场不重复打 GitHub 接口；刷新才重读', async () => {
  const s = setup([pack('pet', '1.0.0')], { releases: [[rel('pet-v1.0.0', [9])]] })
  await s.c.list()
  await s.c.list()
  assert.equal(s.apiCalls().length, 1, '一次市场列表只问一次')
  await s.c.list({ force: true })
  assert.equal(s.apiCalls().length, 2, '强制刷新才再问一次')
})

test('面板列表不等待网络任务；索引和安装量分别合并并发请求', { timeout: 5000 }, async (t) => {
  const index = Promise.withResolvers()
  const releases = Promise.withResolvers()
  t.after(() => { index.resolve(); releases.resolve([]) })
  let indexReads = 0
  let statReads = 0
  let summaryReads = 0
  const c = createCommunity({
    mods: {
      status: () => { assert.fail('面板不应构造模块工具清单') },
      marketStatus: () => { summaryReads++; return [] },
    },
    getConfig: () => ({}), log: {}, version: '1.2.0', registryUrl: 'https://x/index.json',
    fetcher: async url => {
      if (url.includes('api.github.com')) {
        statReads++
        return { ok: true, json: () => releases.promise }
      }
      indexReads++
      return { ok: true, json: () => index.promise }
    },
  })
  const cold = await Promise.all([c.list({ background: true }), c.list({ background: true })])
  assert.deepEqual(cold[0].index, { loading: true, cached: false, failed: false, message: '' })
  assert.deepEqual(cold[1].list, [])
  assert.equal(indexReads, 1)
  assert.equal(summaryReads, 0)
  index.resolve({ schema: 1, assetsBase: 'https://github.com/aureth-labs/dsh-aurabot-qq-mods/releases/download/', modules: [pack('pet', '1.0.0').entry] })
  await new Promise(setImmediate)
  const ready = await Promise.all([c.list({ background: true }), c.list({ background: true })])
  assert.equal(ready[0].index.loading, false)
  assert.equal(ready[0].list[0].id, 'pet')
  assert.equal(ready[1].downloads.loading, true)
  assert.equal(summaryReads, 2, '每次响应只读取一次轻量模块信息')
  assert.equal(statReads, 1)
  releases.resolve([rel('pet-v1.0.0', [7])])
  await new Promise(setImmediate)
  const withStats = await c.list({ background: true })
  assert.equal(withStats.downloads.loading, false)
  assert.equal(withStats.list[0].downloads, 7)
  assert.equal(indexReads, 1)
  assert.equal(statReads, 1)
})

test('旧市场 API 等待下载量，新面板可先读同源列表', { timeout: 5000 }, async t => {
  const started = Promise.withResolvers()
  const releases = Promise.withResolvers()
  t.after(() => releases.resolve([]))
  const c = createCommunity({
    mods: { status: () => [] }, getConfig: () => ({}), log: {}, version: '1.2.0',
    registryUrl: 'https://legacy.example.test/index.json',
    fetcher: async url => {
      if (url.includes('api.github.com')) {
        started.resolve()
        return { ok: true, json: () => releases.promise }
      }
      return { ok: true, json: async () => ({
        schema: 1,
        assetsBase: 'https://github.com/aureth-labs/dsh-aurabot-qq-mods/releases/download/',
        modules: [pack('pet', '1.0.0').entry],
      }) }
    },
  })
  const legacy = c.list()
  await started.promise
  const panel = await c.list({ background: true })
  assert.equal(panel.list[0].id, 'pet')
  assert.equal(panel.downloads.loading, true)
  const returnedEarly = await Promise.race([legacy.then(() => true), new Promise(resolve => setImmediate(() => resolve(false)))])
  assert.equal(returnedEarly, false)

  releases.resolve([rel('pet-v1.0.0', [9])])
  const complete = await legacy
  assert.equal(complete.list[0].downloads, 9)
  assert.equal(Object.hasOwn(complete, 'index'), false)
  assert.equal(Object.hasOwn(complete.downloads, 'loading'), false)
})

test('索引超时后保留同源缓存并退避，用户可以立即重试', { timeout: 5000 }, async t => {
  const expired = new AbortController()
  const deadline = AbortSignal.timeout
  t.mock.method(AbortSignal, 'timeout', ms => ms === 8000 && reads === 1 ? expired.signal : deadline(ms))
  let reads = 0
  const c = createCommunity({
    mods: { status: () => [] }, getConfig: () => ({}), log: {}, version: '1.2.0',
    registryUrl: 'https://x/index.json',
    fetcher: async (_url, { signal }) => {
      if (++reads === 2) {
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      }
      return { ok: true, json: async () => ({ schema: 1, modules: [pack('pet', reads === 1 ? '1.0.0' : '2.0.0').entry] }) }
    },
  })
  await c.list({ background: true })
  await new Promise(setImmediate)
  const refresh = await c.list({ background: true, force: true })
  assert.equal(refresh.index.loading, true)
  assert.equal(refresh.list[0].version, '1.0.0')
  expired.abort(new DOMException('deadline', 'TimeoutError'))
  await new Promise(setImmediate)
  const fallback = await c.list({ background: true })
  assert.deepEqual(fallback.index, { loading: false, cached: true, failed: true, message: '读取模块市场超时，请重试' })
  assert.equal(fallback.list[0].version, '1.0.0')
  assert.equal(reads, 2)
  await c.list({ background: true, force: true })
  await new Promise(setImmediate)
  const latest = await c.list({ background: true })
  assert.equal(latest.index.failed, false)
  assert.equal(latest.list[0].version, '2.0.0')
})

test('切换市场源取消旧索引，晚到的旧结果不覆盖当前模块', { timeout: 5000 }, async t => {
  const old = Promise.withResolvers()
  t.after(() => old.resolve({ schema: 1, modules: [] }))
  const firstUrl = 'https://first.example/index.json'
  const secondUrl = 'https://second.example/index.json'
  let url = firstUrl
  let oldSignal
  const currentVersion = '2.0.0'
  const c = createCommunity({
    mods: { status: () => [] },
    getConfig: () => ({ ext: { market: { registryUrl: url } } }),
    log: {}, version: '1.2.0',
    fetcher: async (requested, { signal }) => {
      if (requested === firstUrl) {
        oldSignal = signal
        return { ok: true, json: () => old.promise }
      }
      assert.equal(requested, secondUrl)
      return { ok: true, json: async () => ({ schema: 1, modules: [pack('douyin', currentVersion).entry] }) }
    },
  })
  await c.list({ background: true })
  url = secondUrl
  const switched = await c.list({ background: true })
  assert.equal(oldSignal.aborted, true)
  assert.equal(switched.index.cached, false)
  await new Promise(setImmediate)
  old.resolve({ schema: 1, modules: [pack('pet', '1.0.0').entry] })
  await new Promise(setImmediate)
  const latest = await c.list({ background: true })
  assert.deepEqual(latest.list.map(m => [m.id, m.version]), [['douyin', currentVersion]])
})

test('市场面板：卡片显示下载次数、可以按热度排', () => {
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.match(src, /'下载 ' \+ num\(m\.downloads\) \+ ' 次'/)
  assert.match(src, /按热度/)
  assert.match(src, /sortMarketModules/)
})

test('市场立即反映安装、更新和卸载，在安全模式下仍显示已装模块', { timeout: 15000 }, async t => {
  const dir = mkdtempSync(join(root, 'market-lifecycle-'))
  const env = { AURABOT_DATA_DIR: dir, AURABOT_WORKSPACE: join(dir, 'workspace'), DSH_HOME: join(dir, 'dsh') }
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(env)) {
    mkdirSync(value, { recursive: true })
    process.env[key] = value
  }
  const registryUrl = 'https://lifecycle.example.test/index.json'
  const assetsBase = 'https://lifecycle.example.test/modules/'
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    setupDone: true, dryRun: true,
    ext: { market: { registryUrl } },
    snowluma: { autoStart: false, autoAttach: false, dir: join(dir, 'no-snowluma') },
    memory: { enabled: false, vector: { enabled: false } },
  }))
  const probe = Symbol.for('aurabot.market-lifecycle.tool-probes')
  globalThis[probe] = 0
  const baseId = 'market-base'
  const dependent = pack('market-addon', '1.0.0')
  dependent.entry.requires = [baseId]
  const makeBase = version => pack(baseId, version, `
    export default {
      id: '${baseId}', name: '市场基础测试模块', version: '${version}', platforms: ['*'],
      setup(api) { api.tool(() => { globalThis[Symbol.for('${Symbol.keyFor(probe)}')]++; return [] }) }
    }
  `)
  let base = makeBase('1.0.0')
  let delisted = false
  t.mock.method(globalThis, 'fetch', async input => {
    const url = String(input)
    if (url === registryUrl) return Response.json({ schema: 1, assetsBase, modules: delisted ? [dependent.entry] : [base.entry, dependent.entry] })
    if (url === assetsBase + base.entry.path) return new Response(base.buf)
    throw new Error('隔离测试不访问远端')
  })
  const fake = createFakeDsh({ brain: async () => '' })
  let api
  t.after(async () => {
    try {
      fake.dispose()
      await api?.dispose?.()
    } finally {
      delete globalThis[probe]
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
  const { apply } = await import('../src/host.js')
  api = apply(fake.ctx)
  await api.ready
  const request = async (path, body) => {
    const response = await fake.call(path, body)
    assert.equal(response.status, 200, path)
    const data = response.json()
    assert.equal(data.ok, true, data.message)
    return data
  }
  const panel = '/modules/community?view=panel'
  const getRows = async () => Object.fromEntries((await request(panel)).list.map(row => [row.id, row]))
  const refresh = async () => {
    await request(panel + '&force=1')
    await new Promise(setImmediate)
    return getRows()
  }

  let rows = await refresh()
  assert.equal(rows[baseId].installed, '')
  assert.match(rows['market-addon'].blocked, /market-base/)
  await request('/modules/community/install', { id: baseId })
  rows = await getRows()
  assert.equal(rows[baseId].installed, '1.0.0')
  assert.equal(rows['market-addon'].blocked, '')

  base = makeBase('1.1.0')
  rows = await refresh()
  assert.equal(rows[baseId].update, true)
  await request('/modules/community/update-all', {})
  await request('/modules')
  assert.ok(globalThis[probe] > 0, '完整模块状态会查询工具')
  const probes = globalThis[probe]
  rows = await getRows()
  assert.equal(rows[baseId].installed, '1.1.0')
  assert.equal(rows[baseId].update, false)
  assert.equal(globalThis[probe], probes, '刷新市场列表不查询工具')

  delisted = true
  rows = await refresh()
  assert.equal(rows[baseId].delisted, true)
  await request('/save', { safeMode: true })
  rows = await getRows()
  assert.equal(rows[baseId]?.installed, '1.1.0', '安全模式中仍可以在市场查看下架的已装模块')
  assert.equal(rows['market-addon'].blocked, '', '已经安装的依赖仍可识别')
  await request('/modules/community/remove', { id: baseId })
  rows = await getRows()
  assert.equal(rows[baseId], undefined)
  assert.match(rows['market-addon'].blocked, /market-base/)
})

test('市场面板：连续滚动时延迟视口外卡片的布局', () => {
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.match(src, /\.ab-market-grid>\.ab-card\{[^}]*content-visibility:auto/)
  assert.match(src, /\.ab-market-grid>\.ab-card\{[^}]*contain-intrinsic-block-size:auto \d+px/)
})

test('市场面板：标题跳仓库，只认 http(s) 的 homepage', () => {
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  // 默认深入到模块库里该模块自己的目录（有的 homepage 指向别处仓库根，不准）
  assert.match(
    src,
    /stats\.source\s*\n\s*\? 'https:\/\/github\.com\/' \+ stats\.source \+ '\/tree\/main\/modules\/' \+ m\.id/,
  )
  // 认不出模块库仓库才退 homepage，且必须过 http(s) 校验
  assert.match(src, /m\.homepage/)
  assert.match(src, /\/i\.test\(String\(m\.homepage \|\| ''\)\)/, 'homepage 必须过 http(s) 正则校验')
  assert.match(src, /target: '_blank', rel: 'noreferrer', title: '打开仓库主页'/)
})

test('市场面板：地址设置默认折叠、放在市场上方', () => {
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const market = src.indexOf("title: '模块市场'")
  const registry = src.indexOf("title: '模块市场地址'")
  assert.ok(registry >= 0 && market > registry, '地址卡要在市场卡的上方')
  assert.match(src, /collapsible: true, defaultOpen: false/, '地址卡要默认折叠')
  assert.match(src, /function Card\(\{ title, desc, icon, right, children, className, collapsible, defaultOpen = true/, 'Card 要支持折叠')
})

test('排序时间兜底：索引 publishedAt 原样带出，缺失时用 GitHub Release 最新 published_at', async () => {
  const packs = [pack('pet', '1.0.0'), pack('douyin', '2.0.0')]
  packs[0].entry.publishedAt = '2026-11-12T04:18:02.203Z'
  const s = setup(packs, {
    releases: [[
      rel('pet-v1.0.7', [1], '2026-10-01T00:00:00Z'),
      rel('pet-v1.0.8', [1], '2026-11-01T00:00:00Z'),
      rel('douyin-v2.0.4', [0], '2026-09-01T00:00:00Z'),
    ]],
  })
  const r = await s.c.list()
  const byId = Object.fromEntries(r.list.map((m) => [m.id, m]))
  assert.equal(byId.pet.publishedAt, '2026-11-12T04:18:02.203Z', '索引的发布时间要原样回传给面板排序')
  assert.equal(byId.douyin.publishedAt, '', '没有 publishedAt 也不能凭空造')
  assert.equal(byId.pet.releasedAt, '2026-11-01T00:00:00Z', '取模块最新一个 Release 的发布时间')
  assert.equal(byId.douyin.releasedAt, '2026-09-01T00:00:00Z', '每个模块各取自己的最新 Release')
})

test('排序时间兜底：索引用 snake_case 的 published_at / updated_at 也认', async () => {
  const p = pack('pet', '1.0.0')
  p.entry.published_at = '2026-11-12T04:18:02.203Z'
  p.entry.updated_at = '2026-11-13T04:18:02.203Z'
  const s = setup([p], { releases: [] })
  const r = await s.c.list()
  assert.equal(r.list[0].publishedAt, '2026-11-12T04:18:02.203Z')
  assert.equal(r.list[0].updatedAt, '2026-11-13T04:18:02.203Z')
})
