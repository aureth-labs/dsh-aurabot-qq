// 检查更新：读 GitHub 的 Release（不是主分支 package.json）。
// 只有真正发布过 Release / Tag 的版本才会提示，避免分支上提前写好的版本号被当成更新。

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const STAGE = { alpha: 1, beta: 2, rc: 3 }
const PLATFORM_LABEL = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** 比较 x.y.z、x.y.z-beta.n、x.y.z-rc.n：a > b 返回正数；同一版本号里 beta < rc < 正式版。 */
export function compareVersions(a, b) {
  const [ca, ba] = String(a || '0').split('-')
  const [cb, bb] = String(b || '0').split('-')
  const pa = ca.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = cb.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  if (!ba || !bb) return (ba ? 0 : 1) - (bb ? 0 : 1)
  const [sa, na] = ba.split('.')
  const [sb, nb] = bb.split('.')
  if (sa !== sb) return (STAGE[sa] || 0) - (STAGE[sb] || 0)
  return (parseInt(na, 10) || 0) - (parseInt(nb, 10) || 0)
}

/** 测试版走 beta 分支，正式版走 main：互不打扰。 */
export const channelOf = (version) => (String(version).includes('-') ? 'beta' : 'main')

/** 订阅不稳定版本：主人选过就听主人的，没选过时正在用测试版的算已订阅，免得老测试用户收不到更新。 */
export const wantsUnstable = (choice, version) => (typeof choice === 'boolean' ? choice : channelOf(version) === 'beta')

/** 从 repository.url 拿 owner/repo。 */
export function repoOf(pkg) {
  const url = typeof pkg?.repository === 'string' ? pkg.repository : pkg?.repository?.url || ''
  const m = String(url).match(/github\.com[/:]([^/]+)\/([^/.]+)/)
  return m ? `${m[1]}/${m[2]}` : ''
}

/** 找 dsh CLI：桌面版优先用安装目录里的 cli，找不到就用 PATH 里的 dsh。 */
export function findCli({ platform = process.platform, exePath = process.execPath, resourcesPath = process.resourcesPath || '', env = process.env } = {}) {
  const bin = platform === 'win32' ? 'dsh.cmd' : 'dsh'
  const roots = []
  if (resourcesPath) roots.push(resourcesPath)
  if (exePath) {
    const dir = dirname(exePath)
    roots.push(platform === 'darwin' ? join(dir, '..', 'Resources') : join(dir, 'resources'))
  }
  if (platform === 'win32' && env.LOCALAPPDATA) roots.push(join(env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources'))
  for (const root of roots) {
    const p = join(root, 'runtime', 'cli', 'bin', bin)
    if (existsSync(p)) return { cli: p, mode: 'desktop', resourcesPath: root }
  }
  return { cli: 'dsh', mode: 'web', resourcesPath: '' }
}

/** 宿主环境：面板据此决定命令怎么写、显示哪个平台标签。 */
export function hostEnv(opts = {}) {
  const platform = opts.platform || process.platform
  const profile = opts.profile || process.env.DSH_PROFILE || 'desktop'
  const found = opts.cli ? { cli: opts.cli, mode: opts.mode || 'custom', resourcesPath: opts.resourcesPath || '' } : findCli({ ...opts, platform })
  return {
    platform,
    label: PLATFORM_LABEL[platform] || platform,
    mode: found.mode,
    modeLabel: found.mode === 'desktop' ? '桌面版' : found.mode === 'web' ? '网页版' : '自定义',
    profile,
    cli: found.cli,
    resourcesPath: found.resourcesPath,
    shell: platform === 'win32' ? 'powershell' : 'shell',
  }
}

/** 更新命令：默认按分支；给 ref 时按具体 Release Tag 安装，避免装到分支上未发布的代码。 */
export function updateCommand(repo, channel = 'main', opts = {}) {
  const env = opts.env || hostEnv({ platform: opts.platform, cli: opts.cli, profile: opts.profile })
  const platform = env.platform || process.platform
  const profile = env.profile || 'desktop'
  const cli = env.cli || (platform === 'win32' ? 'dsh.cmd' : 'dsh')
  const ref = opts.ref || (channel === 'main' ? '' : channel)
  const arg = `plugin --profile ${profile} add github:${repo}${ref ? '#' + ref : ''}`
  return platform === 'win32' ? `& "${cli}" ${arg}` : `"${cli}" ${arg}`
}

/** 更新计划：链接、命令、环境标签一次给全。 */
export function updatePlan({ repo, channel = 'main', latest = '', tag = '', env = hostEnv() } = {}) {
  return {
    platform: env.platform,
    platformLabel: env.label,
    mode: env.mode,
    modeLabel: env.modeLabel,
    profile: env.profile,
    shell: env.shell,
    cli: env.cli,
    command: updateCommand(repo, channel, { env, ref: tag }),
    releaseUrl: `https://github.com/${repo}/releases`,
    tagUrl: tag ? `https://github.com/${repo}/releases/tag/${tag}` : latest ? `https://github.com/${repo}/releases/tag/v${latest}` : `https://github.com/${repo}/releases`,
  }
}

/** 从 GitHub Releases Atom feed 里取 tag 和版本。 */
function releasesFromAtom(xml) {
  const out = []
  for (const m of String(xml).matchAll(/<entry>([\s\S]*?)<\/entry>/gi)) {
    const block = m[1]
    const link = block.match(/href="https:\/\/github\.com\/[^"]+\/releases\/tag\/([^"]+)"/i) || block.match(/<id>[^<]*\/releases\/tag\/([^<]+)<\/id>/i)
    if (!link) continue
    let tag = link[1]
    try { tag = decodeURIComponent(tag) } catch { /* 保留原样 */ }
    const version = tag.replace(/^v/i, '')
    if (VERSION_RE.test(version)) out.push({ tag, version })
  }
  return out
}

/** 从 GitHub Releases API 的 JSON 里取 tag 和版本（Atom 读不到时的后备）。 */
function releasesFromApi(json) {
  const out = []
  for (const rel of Array.isArray(json) ? json : []) {
    if (!rel || rel.draft) continue
    const tag = String(rel.tag_name || '')
    const version = tag.replace(/^v/i, '')
    if (VERSION_RE.test(version)) out.push({ tag, version })
  }
  return out
}

/** 只认发布过的版本：先读 releases.atom，失败再读 GitHub API；绝不回退到分支上的 package.json。 */
async function readReleases(repo, fetchImpl) {
  let lastError = null
  for (const url of [`https://github.com/${repo}/releases.atom`, `https://api.github.com/repos/${repo}/releases?per_page=30`]) {
    try {
      const r = await fetchImpl(url, { headers: { 'user-agent': 'aurabot-panel' }, signal: AbortSignal.timeout(8000) })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      const list = url.endsWith('.atom') ? releasesFromAtom(await r.text()) : releasesFromApi(await r.json())
      if (list.length) return list
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('拿不到 Release 列表')
}

export function createUpdateChecker({ pkg, log, fetchImpl = fetch, unstable = () => null }) {
  let cache = null
  return async function check({ force = false } = {}) {
    const repo = repoOf(pkg)
    if (!repo) return { ok: false, current: pkg.version, message: '不知道从哪检查更新' }
    const subscribed = wantsUnstable(unstable(), pkg.version)
    if (!force && cache && cache.subscribed === subscribed && Date.now() - cache.at < 6 * 3600_000) return cache.value
    try {
      const releases = await readReleases(repo, fetchImpl)
      // 没订阅只看正式版；订阅了才把 beta/rc 也算进来
      const candidates = releases.filter((r) => subscribed || !r.version.includes('-'))
      const best = candidates.reduce((a, b) => (!a || compareVersions(b.version, a.version) > 0 ? b : a), null)
      const latest = best?.version || ''
      const channel = best ? (latest.includes('-') ? 'beta' : 'main') : 'main'
      const value = {
        ok: true,
        current: pkg.version,
        latest,
        tag: best?.tag || '',
        newer: Boolean(latest) && compareVersions(latest, pkg.version) > 0,
        repo,
        unstable: subscribed,
        channel,
        command: latest ? updateCommand(repo, channel, { ref: best.tag }) : '',
      }
      cache = { at: Date.now(), value, subscribed }
      return value
    } catch (error) {
      log?.debug('检查更新失败：', error.message)
      return { ok: false, current: pkg.version, message: '检查更新失败：' + error.message }
    }
  }
}

/** CHANGELOG.md 里某个版本那一段（「## 0.3.0」到下一个「## 」）。 */
export function changelogSection(text, version) {
  const lines = String(text || '').split(/\r?\n/)
  const start = lines.findIndex((l) => new RegExp(`^##\\s+v?${String(version).replace(/\./g, '\\.')}\\b`).test(l))
  if (start < 0) return ''
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l))
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim()
}
