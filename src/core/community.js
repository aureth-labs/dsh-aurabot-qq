// 社区模块：从 dsh-aurabot-qq-mods 仓库的索引下载、校验、安装、更新、卸载模块。
//
// 规则见 mods 仓库的 docs/MODULE_SPEC.md「插件端要遵守的约定」：
// - 下载后先核对 sha256，zip 里的路径不合法就整包拒绝
// - 解压到 modules/.<id>.installing/（. 开头不会被扫描），校验通过才改名落位
// - 写 .aurabot-source.json 记来源；没有这个文件的同名文件夹是用户自己写的，绝不覆盖
// - 能力声明不是沙箱：安装前面板要把来源和能力给用户看
//
// 从内置搬到社区库的模块（MOVED），老用户升级时自动装回来，只装一次，卸载后不会再装。

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { access, readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { inflateRawSync, crc32 } from 'node:zlib'
import { dataDir } from './store.js'
import { API_VERSION, builtinDir, userDir } from './modules.js'

export const REGISTRY_URL = 'https://raw.githubusercontent.com/aureth-labs/dsh-aurabot-qq-mods/registry/index.json'
// Gitee 官方镜像（由 github-to-gitee-sync 每天从 registry 分支同步），国内访问更稳
export const GITEE_MIRROR = 'https://raw.giteeusercontent.com/aureth-labs/dsh-aurabot-qq-mods/raw/registry/index.json'
export const SOURCE_FILE = '.aurabot-source.json'
const MAX_ZIP_BYTES = 25 * 1024 * 1024
const MAX_FILE_BYTES = 64 * 1024 * 1024
const ID_RE = /^[a-z][a-z0-9-]{1,39}$/
const INDEX_TTL = 5 * 60_000
const MARKET_INDEX_TIMEOUT = 8_000
const INDEX_FAIL_TTL = 30_000
const RETRY_MS = 1000
// 安装量用模块库 Releases 里安装包的下载次数：不用额外服务，代价是 GitHub 接口没登录时一小时只给 60 次，
// 所以读一次缓存一小时；读失败也记下来，5 分钟内不再试，别把额度耗在断网上。
const STATS_TTL = 60 * 60_000
const STATS_FAIL_TTL = 5 * 60_000
const RELEASES_PAGES = 3
const EMPTY_STATS = { counts: {}, released: {}, source: '', at: 0 }

/** fetch 断网时只说 fetch failed，这里把真正的原因换成人话。 */
const isNetError = (error) => error instanceof TypeError || error?.name === 'TimeoutError' || error?.name === 'AbortError' || Boolean(error?.cause?.code)
const netError = (error) => new Error(`连不上 GitHub（${error?.cause?.code || error?.name || error?.message}），检查网络或代理后再试`)

/** 网络断了再试一次：代理和直连 GitHub 都常有瞬断。 */
async function withRetry(fn, retryMs) {
  try { return await fn() } catch (error) {
    if (!isNetError(error)) throw error
    await new Promise((done) => setTimeout(done, retryMs))
    try { return await fn() } catch (again) { throw isNetError(again) ? netError(again) : again }
  }
}

/** 边收边报进度；没有流的响应（测试替身）直接整包读。 */
async function readBody(r, onBytes) {
  if (!r.body) return Buffer.from(await r.arrayBuffer())
  const chunks = []
  let got = 0
  for await (const chunk of r.body) {
    got += chunk.length
    if (got > MAX_ZIP_BYTES) throw new Error('安装包太大')
    chunks.push(chunk)
    onBytes(got)
  }
  return Buffer.concat(chunks)
}

/** 搬到社区库的原内置模块：id → 老用户是否在用（在用才自动装回来）。 */
export const MOVED = {
  pet: () => existsSync(dataDir('modules-data', 'pet', 'app')), // 装过桌宠客户端才算在用
  douyin: (cfg) => cfg.douyin?.enabled === true,
  heybox: (cfg) => cfg.heybox?.enabled === true,
}

/** 只比 x.y.z：1.2.0-beta.1 算满足 minPluginVersion 1.2.0，模块不用跟着测试版改版本要求。 */
export function compareVersions(a, b) {
  const x = String(a).split('-')[0].split('.').map(Number)
  const y = String(b).split('-')[0].split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1
  return 0
}

/** 解开 zip，返回 Map(路径 → Buffer)。不合法的路径、压缩方式、校验和一律抛错。 */
export function readZip(buf) {
  let end = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break }
  if (end < 0) throw new Error('不是有效的 zip')
  const count = buf.readUInt16LE(end + 10)
  let p = buf.readUInt32LE(end + 16)
  const files = new Map()
  let total = 0
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 目录损坏')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const packed = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen
    if (flags & 1) throw new Error('zip 不能加密')
    if (name.endsWith('/')) continue
    if (!safeName(name)) throw new Error(`zip 里有不安全的路径：${name}`)
    if (method !== 0 && method !== 8) throw new Error(`zip 用了不支持的压缩方式：${name}`)
    total += size
    if (total > MAX_FILE_BYTES) throw new Error('解压后太大')
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error('zip 文件头损坏')
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(start, start + packed)
    const data = method === 8 ? inflateRawSync(raw, { maxOutputLength: MAX_FILE_BYTES }) : Buffer.from(raw)
    if (data.length !== size || crc32(data) !== crc) throw new Error(`zip 校验失败：${name}`)
    files.set(name, data)
  }
  return files
}

function safeName(name) {
  if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false
  return name.split('/').every((seg) => seg && seg !== '.' && seg !== '..')
}

// registry 地址的优先级：调用方显式传入 > 配置 ext.market.registryUrl > 环境变量 AURABOT_REGISTRY_URL > 内置默认。
// 让模块市场支持换地址（自建索引 / 国内镜像 / 内网部署）而不必改代码或设环境变量。
function resolveRegistryUrl(arg, getConfig) {
  if (typeof arg === 'string' && arg.trim() && arg !== REGISTRY_URL) return arg // 显式传参优先（测试 / 旧式调用）
  const fromConfig = String(getConfig?.()?.ext?.market?.registryUrl || '').trim()
  if (fromConfig && /^https?:\/\//i.test(fromConfig)) return fromConfig
  const fromEnv = String(process.env.AURABOT_REGISTRY_URL || '').trim()
  if (fromEnv) return fromEnv
  return REGISTRY_URL
}

export function createCommunity({ mods, getConfig, setConfig, log, version, alive = () => true, registryUrl, fetcher = fetch, retryMs = RETRY_MS }) {
  const dirOf = (id) => join(userDir(), id)
  // 模块市场索引地址：单一真相，index 下载 / 安装量读取都用它。
  // 支持换地址（自建索引 / 镜像 / 内网）：先看配置 ext.market.registryUrl，再退环境变量，最后回到内置 github。
  const registryUrlOf = () => resolveRegistryUrl(registryUrl, getConfig)
  let cache = null // { at, url, index, sequence }
  let indexSequence = 0
  let panelRefresh = null
  let busy = null // 同一时间只跑一个安装 / 卸载
  let progress = null // 安装中：{ id, name, stage: 'index' | 'download' | 'install' | 'start', received, total }
  let statsState = null

  const readSource = (id) => {
    try { return JSON.parse(readFileSync(join(dirOf(id), SOURCE_FILE), 'utf8')) } catch (error) { return null }
  }
  const hasFolder = (id) => existsSync(dirOf(id))

  async function fetchIndex(url, signal) {
    const r = await fetcher(url, { signal, cache: 'no-store' })
    if (!r.ok) throw new Error(`读不到社区模块索引（HTTP ${r.status}）`)
    const index = await r.json()
    signal.throwIfAborted()
    if (index?.schema !== 1 || (index.modules != null && !Array.isArray(index.modules))) throw new Error('社区模块索引的格式不受支持，检查市场地址或更新插件')
    return index
  }

  function rememberIndex(url, sequence, index) {
    if (!alive() || registryUrlOf() !== url || (cache && cache.sequence > sequence)) return
    cache = { at: Date.now(), url, index, sequence }
    if (panelRefresh?.url === url) {
      panelRefresh.failedAt = null
      panelRefresh.message = ''
    }
  }

  async function loadIndex({ force = false, url = registryUrlOf() } = {}) {
    // 换地址后旧缓存作废（按 URL 判），否则改完地址可能 5 分钟内仍读到旧的索引。
    if (!force && cache && cache.url === url && Date.now() - cache.at < INDEX_TTL) return cache.index
    const sequence = ++indexSequence
    const index = await withRetry(() => fetchIndex(url, AbortSignal.timeout(20_000)), retryMs)
    rememberIndex(url, sequence, index)
    return index
  }

  function panelIndexState(url, force) {
    if (panelRefresh?.url !== url) {
      panelRefresh?.controller?.abort()
      if (statsState?.url !== url) statsState?.controller?.abort()
      panelRefresh = { url, controller: null, job: null, failedAt: null, message: '', forceStats: false }
    }
    const state = panelRefresh
    const snapshot = cache?.url === url ? cache : null
    const now = Date.now()
    if (force) state.forceStats = true
    const retry = state.failedAt == null || now - state.failedAt >= INDEX_FAIL_TTL
    if (!state.job && alive() && (force || (retry && (!snapshot || now - snapshot.at >= INDEX_TTL)))) {
      const sequence = ++indexSequence
      const controller = new AbortController()
      const timeout = AbortSignal.timeout(MARKET_INDEX_TIMEOUT)
      const signal = AbortSignal.any([controller.signal, timeout])
      state.controller = controller
      state.failedAt = null
      state.message = ''
      state.job = fetchIndex(url, signal).then(index => {
        if (!controller.signal.aborted) rememberIndex(url, sequence, index)
      }, error => {
        if (controller.signal.aborted || (cache?.url === url && cache.sequence > sequence)) return
        const message = timeout.aborted ? '读取模块市场超时，请重试'
          : isNetError(error) ? '连不上模块市场，请检查网络或代理后重试' : error.message
        state.failedAt = Date.now()
        state.message = message
      }).finally(() => { state.job = null; state.controller = null })
    }
    return { state, snapshot }
  }

  const revokedReason = (index, id, v) => (index.revoked || []).find((r) => r.id === id && r.versions?.includes(v))?.reason || ''

  /** 索引里的仓库地址 → owner/repo。索引是可下载的第三方数据，只认长得对的。 */
  function repoOf(index, indexUrl) {
    for (const url of [index?.assetsBase, index?.homepage, indexUrl]) {
      const m = String(url || '').match(/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/)
      if (m && ID_RE.test(m[1].toLowerCase()) && ID_RE.test(m[2].toLowerCase())) return `${m[1]}/${m[2]}`
    }
    return ''
  }

  /**
   * 把 Releases 列表按模块聚合：下载次数 + 最近一次 Release 的发布时间（published_at，退 created_at）。
   * tag 形如 pet-v1.0.7；日期只是排序用的参考值，索引里已有 publishedAt 时以索引为准。
   */
  function sumReleases(releases) {
    const counts = {}
    const released = {}
    for (const rel of Array.isArray(releases) ? releases : []) {
      const m = String(rel?.tag_name || '').match(/^([a-z][a-z0-9-]{1,39})-v\d+\.\d+\.\d+$/)
      if (!m) continue
      const id = m[1]
      const n = (Array.isArray(rel.assets) ? rel.assets : []).reduce((sum, a) => sum + (Number(a?.download_count) || 0), 0)
      counts[id] = (counts[id] || 0) + n
      const at = String(rel?.published_at || rel?.created_at || '')
      if (at && (!released[id] || at > released[id])) released[id] = at
    }
    return { counts, released }
  }

  async function readStats(repo, signal) {
    const counts = {}
    const released = {}
    // 有令牌就用上：没登录时 GitHub 接口一小时只给 60 次。
    const token = String(process.env.AURABOT_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '').trim()
    for (let page = 1; page <= RELEASES_PAGES; page++) {
      signal.throwIfAborted()
      const r = await fetcher(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        headers: { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const list = await r.json()
      signal.throwIfAborted()
      const pageSum = sumReleases(list)
      for (const [id, n] of Object.entries(pageSum.counts)) counts[id] = (counts[id] || 0) + n
      for (const [id, at] of Object.entries(pageSum.released)) if (!released[id] || at > released[id]) released[id] = at
      if (!Array.isArray(list) || list.length < 100) break
    }
    return { counts, released, source: repo, at: Date.now() }
  }

  function currentStats(state) {
    if (!state) return EMPTY_STATS
    const failed = state.failedAt != null
    return { ...(state.value || EMPTY_STATS), source: state.repo, failed }
  }

  function requestStats(index, url, force) {
    const repo = repoOf(index, url)
    if (!repo || !alive() || registryUrlOf() !== url) return null
    if (statsState?.url !== url || statsState.repo !== repo) {
      statsState?.controller?.abort()
      statsState = { url, repo, value: null, failedAt: null, job: null, controller: null }
    }
    const state = statsState
    const now = Date.now()
    const due = !state.value || now - state.value.at >= STATS_TTL
    const retry = state.failedAt == null || now - state.failedAt >= STATS_FAIL_TTL
    if (!state.job && (force || (retry && due))) {
      const controller = new AbortController()
      state.controller = controller
      state.job = readStats(repo, controller.signal).then(value => {
        state.value = value
        state.failedAt = null
      }, error => {
        if (!controller.signal.aborted) {
          state.failedAt = Date.now()
          log.debug?.('读不到模块下载量：', error?.message || error)
        }
      }).finally(() => { state.job = null; state.controller = null })
    }
    return state
  }

  // 旧客户端仍最多等待统计 6 秒，新面板直接使用快照。
  function statsWithin(state) {
    if (!state?.job) return Promise.resolve(currentStats(state))
    return new Promise((done) => {
      const timer = setTimeout(() => done({ ...currentStats(state), failed: true }), 6000)
      const finish = () => { clearTimeout(timer); done(currentStats(state)) }
      state.job.then(finish, finish)
    })
  }

  /** 当前启用的平台（实例名 qq#2 只算平台 qq）。 */
  function enabledPlatforms() {
    const all = getConfig?.()?.platforms || {}
    return new Set(Object.entries(all)
      .filter(([, value]) => value && value.enabled === true)
      .map(([instance]) => String(instance).split('#')[0])
      .filter(Boolean))
  }

  /** 清单里的 platforms：不写 = 只支持 QQ；["*"] = 全平台。 */
  function platformsOf(e) {
    const raw = e?.platforms
    if (!Array.isArray(raw) || !raw.length) return ['qq']
    return raw.includes('*') ? ['*'] : raw.filter((p) => typeof p === 'string' && p)
  }

  /** 平台不满足只提示，不阻断安装；用户可以先装上，等启用平台后再生效。 */
  function platformNote(wants, active) {
    if (wants.includes('*')) return ''
    if (!active.size) return '当前没有启用任何平台'
    const missing = wants.filter((platform) => !active.has(platform))
    return missing.length ? `需要平台：${missing.join('、')}（当前未启用）` : ''
  }

  /** 这一条现在装不了的原因；能装返回空串。 */
  function blocked(index, e, known) {
    if (Number(e.api) > API_VERSION) return `要扩展接口 v${e.api}，现在的插件只有 v${API_VERSION}，先更新插件`
    if (compareVersions(e.minPluginVersion, version) > 0) return `要插件 ${e.minPluginVersion} 以上，现在是 ${version}，先更新插件`
    if (revokedReason(index, e.id, e.version)) return `这个版本已撤回：${revokedReason(index, e.id, e.version)}`
    const installed = known ?? new Set(mods.status().map((m) => m.id))
    const missing = (e.requires || []).filter((dep) => !installed.has(dep))
    return missing.length ? `要先装：${missing.join('、')}` : ''
  }

  function view(index, e, { stats, folders, sources, known, active }) {
    const src = sources.get(e.id)
    const platforms = platformsOf(e)
    return {
      ...e,
      // 市场排序用的时间：新索引给 publishedAt；兼容 snake_case 的索引；都没有时退 GitHub Release 时间。
      publishedAt: e.publishedAt || e.published_at || '',
      updatedAt: e.updatedAt || e.updated_at || '',
      releasedAt: stats.released[e.id] || '',
      installed: src?.version || '',
      foreign: !src && folders.has(e.id), // 同名文件夹是用户自己写的
      update: Boolean(src && compareVersions(e.version, src.version) > 0),
      blocked: blocked(index, e, known),
      platforms,
      platformNote: platformNote(platforms, active),
      moved: e.id in MOVED,
      // 安装量：模块库 Releases 里安装包的下载次数（更新也算），读不到时是 0
      downloads: Number(stats.counts[e.id]) || 0,
    }
  }

  async function describeIndex(index, stats, { background = false } = {}) {
    const downloads = { source: stats.source, at: stats.at, failed: Boolean(stats.failed) }
    if (!index) return { list: [], revoked: [], generatedAt: '', downloads }
    const entries = (index.modules || []).filter(e => typeof e?.id === 'string' && ID_RE.test(e.id))
    const liveStatuses = background ? mods.marketStatus?.() : null
    const statuses = [...(liveStatuses ?? mods.status())]
    const known = new Set(statuses.map(m => m.id))
    const active = enabledPlatforms()
    // 扫一次目录，只读实际存在的来源文件。文件 IO 不阻塞其它面板请求。
    const localRoot = userDir()
    const localEntries = await readdir(localRoot, { withFileTypes: true }).catch(() => [])
    const folders = new Set(localEntries.map(entry => entry.name))
    if (liveStatuses) {
      // 安全模式和已停用模块可能还在磁盘上，但没有进入运行时模块表。
      const missing = localEntries.filter(entry => entry.isDirectory() && !/^[_.]/.test(entry.name) && !known.has(entry.name))
      const installed = await Promise.all(missing.map(async ({ name }) => {
        const dir = join(localRoot, name)
        try {
          await access(join(dir, 'index.mjs')).catch(() => access(join(dir, 'index.js')))
          return name
        } catch { return null }
      }))
      for (const id of installed) {
        if (!id) continue
        known.add(id)
        statuses.push({ id, name: id, description: '' })
      }
    }
    const candidates = new Set([...entries.map(e => e.id), ...known])
    const sources = new Map(await Promise.all([...candidates]
      .filter(id => folders.has(id))
      .map(async id => {
        try { return [id, JSON.parse(await readFile(join(localRoot, id, SOURCE_FILE), 'utf8'))] }
        catch { return [id, null] }
      })))
    const listed = new Set(entries.map(e => e.id))
    const list = entries.map(e => view(index, e, { stats, folders, sources, known, active }))
    // 已安装但索引里没有了（下架）的也列出来，好让用户卸载。
    for (const m of statuses) {
      const src = sources.get(m.id)
      if (listed.has(m.id) || !src) continue
      list.push({ id: m.id, name: m.name, description: m.description, version: src.version, installed: src.version, delisted: true, capabilities: [], platforms: [], platformNote: '', blocked: '', downloads: Number(stats.counts[m.id]) || 0, publishedAt: '', updatedAt: '', releasedAt: stats.released[m.id] || '' })
    }
    const revoked = list.filter(e => e.installed && revokedReason(index, e.id, e.installed))
      .map(e => ({ id: e.id, version: e.installed, reason: revokedReason(index, e.id, e.installed) }))
    return { list, revoked, generatedAt: index.generatedAt || '', downloads }
  }

  async function list({ force = false, background = false } = {}) {
    const url = registryUrlOf()
    if (!background) {
      const index = await loadIndex({ force, url })
      const stats = await statsWithin(requestStats(index, url, force))
      return describeIndex(index, stats)
    }
    const { state, snapshot } = panelIndexState(url, force)
    const index = snapshot?.index
    const loading = Boolean(state.job)
    const stats = index ? requestStats(index, url, !loading && state.forceStats) : null
    if (index && !loading) state.forceStats = false
    const status = { loading, cached: Boolean(snapshot), failed: state.failedAt != null, message: state.message }
    const downloadsLoading = Boolean(stats?.job)
    const result = await describeIndex(index, currentStats(stats), { background: true })
    const currentUrl = registryUrlOf()
    if (currentUrl !== url) {
      panelIndexState(currentUrl, false)
      return { list: [], revoked: [], generatedAt: '', index: { loading: true, cached: false, failed: false, message: '' }, downloads: { source: '', at: 0, failed: false, loading: false } }
    }
    return { ...result, index: status, downloads: { ...result.downloads, loading: downloadsLoading } }
  }

  async function download(index, e) {
    const url = String(index.assetsBase || '') + e.path
    if (!/^https:\/\//.test(url)) throw new Error('下载地址不对')
    const buf = await withRetry(async () => {
      // 「一键更新」时外层会先写 batch 进度，这里只改本条目的字段，别把 batch 抹掉
      progress = { ...(progress || {}), id: e.id, name: e.name, stage: 'download', received: 0, total: 0 }
      const r = await fetcher(url, { signal: AbortSignal.timeout(120_000), redirect: 'follow' })
      if (!r.ok) throw new Error(`下载失败（HTTP ${r.status}）`)
      progress.total = Number(r.headers?.get?.('content-length')) || 0
      return readBody(r, (received) => { progress.received = received })
    }, retryMs)
    if (buf.length > MAX_ZIP_BYTES) throw new Error('安装包太大')
    const sha = createHash('sha256').update(buf).digest('hex')
    if (sha !== e.sha256) throw new Error('安装包校验不通过，已丢弃')
    return buf
  }

  /** 解压到 .<id>.installing/，检查通过再换上去。 */
  function place(e, files) {
    const manifest = JSON.parse(files.get('module.json')?.toString('utf8') || 'null')
    if (manifest?.id !== e.id || manifest?.version !== e.version) throw new Error('安装包内容和索引对不上')
    const stage = join(userDir(), `.${e.id}.installing`)
    const old = join(userDir(), `.${e.id}.old`)
    rmSync(stage, { recursive: true, force: true })
    rmSync(old, { recursive: true, force: true })
    mkdirSync(stage, { recursive: true })
    try {
      const root = resolve(stage) + sep
      for (const [name, data] of files) {
        const dest = resolve(stage, name)
        if (!dest.startsWith(root)) throw new Error(`zip 里有不安全的路径：${name}`)
        mkdirSync(dirname(dest), { recursive: true })
        writeFileSync(dest, data)
      }
      if (!existsSync(join(stage, 'index.mjs')) && !existsSync(join(stage, 'index.js'))) throw new Error('安装包里没有入口文件')
      writeFileSync(join(stage, SOURCE_FILE), JSON.stringify({ id: e.id, version: e.version, sha256: e.sha256, installedAt: new Date().toISOString() }, null, 2))
      const target = dirOf(e.id)
      if (existsSync(target)) renameSync(target, old)
      try { renameSync(stage, target) } catch (error) {
        if (existsSync(old)) renameSync(old, target) // 换不上就把旧的放回去
        throw error
      }
      rmSync(old, { recursive: true, force: true })
    } finally { rmSync(stage, { recursive: true, force: true }) }
  }

  const exclusive = (fn) => {
    if (busy) return Promise.resolve({ ok: false, message: '上一个操作还没做完，稍等' })
    busy = Promise.resolve().then(fn).catch((error) => {
      log.warn('模块市场操作失败：', error?.message || error)
      return { ok: false, message: String(error?.message || error) }
    }).finally(() => { busy = null; progress = null })
    return busy
  }

  /**
   * 安装或更新的主体（**不含并发锁**）。
   * 「一键更新」要在同一个 exclusive 里连着跑多个，自己再包一层 exclusive 会锁死自己，
   * 所以锁留在外层 install()，批量复用它。
   * 同名但不是社区装的文件夹不碰；替换内置模块要明确 confirmReplace。
   */
  async function installNow(id, { confirmReplace = false } = {}) {
    // id 会拼进目录路径（modules/.<id>.installing → modules/<id>）：先白名单，防被篡改的索引/调用方越目录写
    if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, message: 'id 不对' }
    progress = { ...(progress || {}), id, name: id, stage: 'index', received: 0, total: 0 }
    const index = await loadIndex({ force: true })
    const e = (index.modules || []).find((x) => x.id === id)
    if (!e || e.id !== id) return { ok: false, message: `社区库里没有「${id}」` }
    if (hasFolder(id) && !readSource(id)) return { ok: false, message: `modules/${id} 是你自己的文件夹，不会覆盖；先挪走它` }
    // 替换内置按「已注册的内置模块」判断：index 里的 replacesBuiltin 可能被篡改/漏填，不能只信它；
    // 但也不能只看 builtin 目录是否存在——内置搬到社区库后残留的旧目录会让这里误报（群管就是这样）。
    const builtinRegistered = (() => {
      try { return mods.status().some((m) => m.id === id && m.builtin === true) } catch { return existsSync(join(builtinDir(), id)) }
    })()
    const replacesBuiltin = Boolean(e.replacesBuiltin) || builtinRegistered
    if (replacesBuiltin && !confirmReplace) return { ok: false, needConfirm: true, message: `「${e.name}」会替换内置模块，请确认` }
    const why = blocked(index, e)
    if (why) return { ok: false, message: why }
    const files = readZip(await download(index, e))
    progress = { ...(progress || {}), id, name: e.name, stage: 'install', received: 0, total: 0 }
    place(e, files)
    progress = { ...(progress || {}), id, name: e.name, stage: 'start', received: 0, total: 0 }
    await mods.sync()
    const m = mods.status().find((x) => x.id === id)
    if (m?.error) return { ok: false, message: `装好了，但加载失败：${m.error}` }
    log.info(`社区模块「${e.name}」${e.version} 已安装`)
    return { ok: true, message: `「${e.name}」${e.version} 装好了` }
  }

  /** 安装或更新（带并发锁）。 */
  const install = (id, opts) => exclusive(() => installNow(id, opts))

  /**
   * 一键更新：把「已装、索引里有新版本、当前能装」的模块挨个更新一遍。
   * 整批只占一个 exclusive（不会和自己抢锁）；单个失败不中断后面的。
   * 替换内置的模块在批量里直接按「已在用」处理（confirmReplace=true），不再逐个弹确认。
   * @returns {{ok:boolean, updated:object[], failed:object[], skipped:object[], message:string}}
   */
  const updateAll = () => exclusive(async () => {
    const index = await loadIndex({ force: true })
    const entries = (index.modules || []).filter((e) => ID_RE.test(String(e.id)))
    const targets = []
    const skipped = []
    for (const e of entries) {
      const src = readSource(e.id)
      if (!src || compareVersions(e.version, src.version) <= 0) continue // 没装 / 已是最新
      const why = blocked(index, e)
      if (why) { skipped.push({ id: e.id, name: e.name, message: why }); continue }
      targets.push(e)
    }
    const updated = []
    const failed = []
    for (let i = 0; i < targets.length; i++) {
      const e = targets[i]
      if (!alive()) { skipped.push({ id: e.id, name: e.name, message: '插件已卸载，先停下' }); break }
      progress = { id: e.id, name: e.name, stage: 'index', received: 0, total: 0, batch: { index: i + 1, total: targets.length } }
      try {
        const r = await installNow(e.id, { confirmReplace: true })
        if (r.ok) updated.push({ id: e.id, name: e.name, version: e.version })
        else failed.push({ id: e.id, name: e.name, message: r.message })
      } catch (error) {
        failed.push({ id: e.id, name: e.name, message: String(error?.message || error) })
      }
    }
    if (updated.length) log.info(`模块市场一键更新：成功 ${updated.length} 个${failed.length ? `，失败 ${failed.length} 个` : ''}`)
    const parts = [`更新了 ${updated.length} 个`]
    if (failed.length) parts.push(`${failed.length} 个没成功`)
    if (skipped.length) parts.push(`${skipped.length} 个跳过`)
    return { ok: failed.length === 0, updated, failed, skipped, message: targets.length || failed.length ? parts.join('，') : '没有可更新的模块' }
  })

  /** 卸载时归档源码。默认也保留模块数据和设置，purge 才清掉这两项。 */
  const remove = (id, { purge = false } = {}) => exclusive(async () => {
    if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, message: 'id 不对' }
    if (!readSource(id)) return { ok: false, message: `「${id}」不是从社区库装的，不能在这里卸载` }
    const trash = join(userDir(), '.trash')
    mkdirSync(trash, { recursive: true })
    if (!lstatSync(trash).isDirectory() || !lstatSync(dirOf(id)).isDirectory()) {
      throw new Error('模块目录或 modules/.trash 是链接，无法安全归档')
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const folder = `${id}-${stamp}-${randomUUID().slice(0, 8)}`
    const archive = `modules/.trash/${folder}`
    mods.stop(id)
    try {
      renameSync(dirOf(id), join(trash, folder))
      log.info(`面板卸载社区模块「${id}」，源码归档到 ${archive}`)
      if (purge) {
        rmSync(dataDir('modules-data', id), { recursive: true, force: true })
        const cfg = getConfig()
        const { [id]: _ext, ...ext } = cfg.ext || {}
        const { [id]: _mod, ...modules } = cfg.modules || {}
        setConfig({ ...cfg, ext, modules })
      }
    } finally {
      await mods.sync()
    }
    const dataStatus = purge ? '数据和设置已清除' : '数据和设置已保留'
    return { ok: true, archive, message: `卸载好了，源码和本地改动已移到 ${archive}。${dataStatus}。` }
  })

  /** 升级后把搬走的模块自动装回来：每个 id 只成功处理一次，失败下次启动重试。 */
  async function migrate() {
    const done = { ...(getConfig().communityMigrated || {}) }
    const result = []
    for (const [id, inUse] of Object.entries(MOVED)) {
      if (!alive()) return result
      if (done[id]) continue
      const cfg = getConfig()
      if (hasFolder(id)) done[id] = 'kept' // 已有同名文件夹：用户的版本优先
      else if (cfg.modules?.[id]?.enabled === false || !inUse(cfg)) done[id] = 'skipped'
      else {
        const r = await install(id)
        result.push({ id, ...r })
        if (r.ok) done[id] = 'installed'
        else log.warn(`搬到社区库的模块「${id}」没装上，下次启动再试：`, r.message)
      }
    }
    if (!alive()) return result // 插件已卸载：旧实例不能把旧配置写回去
    setConfig({ ...getConfig(), communityMigrated: done })
    return result
  }

  return { progress: () => progress, registryUrl: registryUrlOf, list, install, updateAll, remove, migrate, source: readSource }
}
