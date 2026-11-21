// 检查更新：读 GitHub 的 Release（不是主分支 package.json）。
// 只有真正发布过 Release / Tag 的版本才会提示，避免分支上提前写好的版本号被当成更新。

import { existsSync, readFileSync } from 'node:fs'
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

/** 下载镜像预设：配置里可以填 id、域名，也可以填任意 http(s) 前缀；空 = 直连 GitHub。 */
export const MIRROR_PRESETS = [
  { id: 'gh-proxy', label: 'gh-proxy.com', prefix: 'https://gh-proxy.com/' },
  { id: 'ghfast', label: 'ghfast.top', prefix: 'https://ghfast.top/' },
]

/** 把 config.update.mirror 的写法统一成「https://前缀/」；认不出或非法时返回空串（按直连处理）。 */
export function resolveMirror(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const key = raw.toLowerCase().replace(/\/+$/, '')
  for (const preset of MIRROR_PRESETS) {
    const names = [preset.id, preset.label, preset.prefix.replace(/\/+$/, '')]
    if (preset.id === 'gh-proxy') names.push('ghproxy')
    if (names.includes(key)) return preset.prefix
  }
  if (!/^https?:\/\/[^\s]+$/i.test(raw)) return ''
  return raw.replace(/\/+$/, '') + '/'
}

/** 镜像在面板上的短名字：预设用 label，自定义用域名。 */
export function mirrorLabel(value) {
  const prefix = resolveMirror(value)
  if (!prefix) return ''
  const preset = MIRROR_PRESETS.find((p) => p.prefix === prefix)
  if (preset) return preset.label
  try { return new URL(prefix).host } catch { return prefix }
}

/** 给 GitHub 地址套上镜像前缀；已经套过的不重复套。 */
export function mirrorUrl(url, mirror) {
  const prefix = resolveMirror(mirror)
  const target = String(url || '')
  if (!prefix || !target) return target
  return target.startsWith(prefix) ? target : prefix + target
}

/**
 * GitHub 源码压缩包地址。`dsh plugin add` 的 plugin-manager 明确接受 http(s) 的
 * .tgz / .tar.gz（parseInstallSpec 的 tarball 分支），Release 没传资产时用 tag 的源码包最稳。
 */
export function githubTarballUrl(repo, { ref = '', channel = 'main' } = {}) {
  const kind = ref ? 'tags' : 'heads'
  const name = String(ref || (channel === 'main' ? 'main' : channel) || 'main')
  const safe = name.split('/').map((part) => encodeURIComponent(part)).join('/')
  return `https://github.com/${String(repo || '').replace(/^\/+|\/+$/g, '')}/archive/refs/${kind}/${safe}.tar.gz`
}

/**
 * 更新时依次尝试的安装命令：配了镜像先走镜像 tarball，失败再回退原来的 github: 直连；
 * 没配镜像时和以前完全一样，只有一条 github: 命令。
 */
export function updateAttempts({ repo, channel = 'main', ref = '', profile = 'desktop', mirror = '' } = {}) {
  const directSpec = `github:${repo}${ref ? '#' + ref : channel === 'main' ? '' : '#' + channel}`
  const direct = { kind: 'direct', spec: directSpec, args: ['plugin', '--profile', profile, 'add', directSpec] }
  const prefix = resolveMirror(mirror)
  if (!prefix) return [direct]
  const url = mirrorUrl(githubTarballUrl(repo, { ref, channel }), prefix)
  return [
    { kind: 'mirror', mirror: prefix, mirrorLabel: mirrorLabel(prefix), url, spec: url, args: ['plugin', '--profile', profile, 'add', url] },
    direct,
  ]
}

/**
 * 本地 `link:` 安装保护：读 profile 的 package.json，返回这个插件被 link 的依赖值（不是 link 返回空串）。
 * profileDir 为空、文件不存在、JSON 坏了都按「没有保护信息」处理，调用方继续正常更新流程。
 * readFile 可注入，方便单测不依赖真实 DSH profile。
 */
export function linkInstallOf({ profileDir = '', packageName = '', readFile = readFileSync } = {}) {
  if (!profileDir || !packageName) return ''
  try {
    const pkg = JSON.parse(readFile(join(profileDir, 'package.json'), 'utf8'))
    const dep = pkg?.dependencies?.[packageName]
    return typeof dep === 'string' && dep.startsWith('link:') ? dep : ''
  } catch (error) {
    return ''
  }
}

/**
 * 按顺序执行 updateAttempts 的安装尝试，直到一条成功；runAttempt 由宿主注入，
 * 真实实现会把它转成 dsh plugin add 子进程，单元测试可以直接模拟每条命令的结果。
 * 返回宿主 /update/apply 需要的 ok / message / output / usedMirror / fallback 字段。
 */
export async function runUpdateAttempts({ attempts = [], runAttempt, plan = {}, env = {}, log } = {}) {
  if (!Array.isArray(attempts) || attempts.length === 0) return { ok: false, message: '没有可执行的更新命令', usedMirror: false, fallback: false, failures: [] }
  if (typeof runAttempt !== 'function') throw new TypeError('runUpdateAttempts 需要 runAttempt 函数')
  const failures = []
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i]
    const r = await runAttempt(attempt, i)
    if (r && r.ok) {
      if (i > 0) log?.warn?.('更新镜像失败，已回退直连 GitHub：' + (failures[0]?.message || '未知错误'))
      const via = attempt.kind === 'mirror' ? `镜像 ${attempt.mirrorLabel}` : '直连 GitHub'
      const fallback = i > 0 ? '镜像下载失败，已自动回退直连。' : ''
      return {
        ...r,
        ok: true,
        command: plan.command,
        directCommand: plan.directCommand,
        mirror: plan.mirror,
        mirrorLabel: plan.mirrorLabel,
        usedMirror: attempt.kind === 'mirror',
        fallback: i > 0,
        env,
        message: fallback + r.message + `（本次走${via}）`,
      }
    }
    failures.push({ kind: attempt.kind, message: r?.message || '更新命令没跑成功', output: r?.output })
    if (i < attempts.length - 1) log?.warn?.(`更新${attempt.kind === 'mirror' ? '镜像' : '直连'}失败，尝试下一条命令：` + (r?.message || '未知错误'))
  }
  const last = failures[failures.length - 1] || { message: '更新命令没跑成功', output: '' }
  const prefix = failures.length > 1 ? '镜像和直连都没成功：' : ''
  return {
    ok: false,
    message: prefix + last.message,
    output: failures.map((f) => `[${f.kind === 'mirror' ? '镜像' : '直连'}] ${String(f.output || '').slice(-1200)}`).join('\n'),
    command: plan.command,
    directCommand: plan.directCommand,
    mirror: plan.mirror,
    mirrorLabel: plan.mirrorLabel,
    usedMirror: false,
    fallback: false,
    env,
    failures,
  }
}

function commandWithSpec(env, profile, spec) {
  const platform = env.platform || process.platform
  const cli = env.cli || (platform === 'win32' ? 'dsh.cmd' : 'dsh')
  const arg = `plugin --profile ${profile} add ${spec}`
  return platform === 'win32' ? `& "${cli}" ${arg}` : `"${cli}" ${arg}`
}

/** 更新命令：默认按分支；给 ref 时按具体 Release Tag 安装，避免装到分支上未发布的代码。 */
export function updateCommand(repo, channel = 'main', opts = {}) {
  const env = opts.env || hostEnv({ platform: opts.platform, cli: opts.cli, profile: opts.profile })
  const profile = env.profile || opts.profile || 'desktop'
  const attempt = updateAttempts({ repo, channel, ref: opts.ref || '', profile, mirror: opts.mirror }).at(0)
  return commandWithSpec(env, profile, attempt.spec)
}

/** 更新计划：链接、命令、环境标签一次给全。 */
export function updatePlan({ repo, channel = 'main', latest = '', tag = '', env = hostEnv(), mirror = '' } = {}) {
  const profile = env.profile || 'desktop'
  const attempts = updateAttempts({ repo, channel, ref: tag, profile, mirror })
  const primary = attempts[0]
  const direct = attempts[attempts.length - 1]
  return {
    platform: env.platform,
    platformLabel: env.label,
    mode: env.mode,
    modeLabel: env.modeLabel,
    profile: env.profile,
    shell: env.shell,
    cli: env.cli,
    command: commandWithSpec(env, profile, primary.spec),
    // 镜像失败时宿主会回退这条；面板上也能看到，方便手动执行。
    directCommand: commandWithSpec(env, profile, direct.spec),
    mirror: primary.kind === 'mirror' ? primary.mirror : '',
    mirrorLabel: primary.kind === 'mirror' ? primary.mirrorLabel : '',
    installUrl: primary.kind === 'mirror' ? primary.url : '',
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

export function createUpdateChecker({ pkg, log, fetchImpl = fetch, unstable = () => null, mirror = () => '' }) {
  let cache = null
  return async function check({ force = false } = {}) {
    const repo = repoOf(pkg)
    if (!repo) return { ok: false, current: pkg.version, message: '不知道从哪检查更新' }
    const subscribed = wantsUnstable(unstable(), pkg.version)
    const mirrorValue = resolveMirror(typeof mirror === 'function' ? mirror() : mirror)
    if (!force && cache && cache.subscribed === subscribed && cache.mirror === mirrorValue && Date.now() - cache.at < 6 * 3600_000) return cache.value
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
        command: latest ? updateCommand(repo, channel, { ref: best.tag, mirror: mirrorValue }) : '',
      }
      cache = { at: Date.now(), value, subscribed, mirror: mirrorValue }
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
