// 外置工具探测（只读阶段）：把 FFmpeg / Python / uv / Git / edge-tts 的位置和版本
// 汇总给「系统 → 外置工具」页。这里只探测，不修改配置、不下载、不执行用户内容。
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { findFfmpeg } from './img.js'

const WIN = process.platform === 'win32'
const exe = (name) => (WIN ? `${name}.exe` : name)

function onPath(name) {
  const dirs = String(process.env.PATH || '').split(WIN ? ';' : ':').filter(Boolean)
  for (const dir of dirs) {
    const p = join(dir, exe(name))
    if (existsSync(p)) return p
  }
  return ''
}

function probe(cmd, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    if (!cmd || !existsSync(cmd)) return resolve({ ok: false, output: '' })
    let out = ''
    let err = ''
    let done = false
    let child
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try { child?.kill() } catch (error) {}
      finish({ ok: false, output: '超时' })
    }, timeoutMs)
    try {
      child = spawn(cmd, args, { windowsHide: true })
      child.stdout.on('data', (d) => { out += d; if (out.length > 4000) out = out.slice(-4000) })
      child.stderr.on('data', (d) => { err += d; if (err.length > 4000) err = err.slice(-4000) })
      child.on('error', (error) => finish({ ok: false, output: error.message }))
      child.on('close', (code) => finish({ ok: code === 0, output: (out + '\n' + err).trim() }))
    } catch (error) {
      finish({ ok: false, output: error.message })
    }
  })
}

const firstLine = (s) => String(s || '').split(/\r?\n/).map((x) => x.trim()).find(Boolean) || ''
const versionMatch = (s) => {
  const text = String(s || '')
  const semver = text.match(/\b(\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)/)?.[1]
  if (semver) return semver
  // FFmpeg 的构建号是 N-107464-g...，不是标准 semver；至少把可读版本串带出来。
  return text.match(/\bversion\s+([^\s]+)/i)?.[1] || ''
}

function pythonCandidates() {
  const dirs = [process.env.AURABOT_PYENV, join(homedir(), 'Aurabot', 'pyenv'), 'C:\\Aurabot\\pyenv'].filter(Boolean)
  const out = []
  for (const dir of dirs) out.push(WIN ? join(dir, 'Scripts', 'python.exe') : join(dir, 'bin', 'python'))
  for (const name of ['python', 'python3']) { const p = onPath(name); if (p) out.push(p) }
  return [...new Set(out)].filter(Boolean)
}

function edgeInstalled(pythonPath) {
  if (!pythonPath) return false
  const root = dirname(dirname(pythonPath))
  const candidates = WIN
    ? [join(root, 'Lib', 'site-packages', 'edge_tts')]
    : [join(root, 'lib', 'python3.12', 'site-packages', 'edge_tts'), join(root, 'lib', 'python3.11', 'site-packages', 'edge_tts')]
  return candidates.some((p) => existsSync(p))
}

/**
 * @param {() => object} getConfig
 * @param {{fresh?: boolean}} [opts]
 * @returns {Promise<{ok:true, tools:Array}>}
 */
let listCache = null
export async function listTools(getConfig, { fresh = false } = {}) {
  if (!fresh && listCache && Date.now() - listCache.at < 20_000) return listCache.value
  const cfg = getConfig?.() || {}
  const tools = []

  const configuredFfmpeg = String(cfg.bili?.ffmpegPath || '').trim()
  const ffmpeg = findFfmpeg(configuredFfmpeg)
  const ffmpegProbe = ffmpeg ? await probe(ffmpeg, ['-version']) : { ok: false, output: '' }
  tools.push({
    id: 'ffmpeg',
    label: 'FFmpeg',
    kind: 'media',
    status: ffmpeg && ffmpegProbe.ok ? 'ready' : ffmpeg ? 'invalid' : 'missing',
    path: ffmpeg,
    version: versionMatch(firstLine(ffmpegProbe.output)),
    detail: firstLine(ffmpegProbe.output),
    source: configuredFfmpeg && ffmpeg === configuredFfmpeg ? 'legacy' : ffmpeg ? 'auto' : '',
    usedBy: ['B 站看画面', '聊天图片缩小', '生图', '头像', '翻唱'],
  })

  const ffprobe = ffmpeg ? (WIN ? join(dirname(ffmpeg), 'ffprobe.exe') : join(dirname(ffmpeg), 'ffprobe')) : onPath('ffprobe')
  const ffprobeProbe = ffprobe ? await probe(ffprobe, ['-version']) : { ok: false, output: '' }
  tools.push({
    id: 'ffprobe',
    label: 'FFprobe',
    kind: 'media',
    status: ffprobe && ffprobeProbe.ok ? 'ready' : ffprobe ? 'invalid' : 'missing',
    path: ffprobe,
    version: versionMatch(firstLine(ffprobeProbe.output)),
    detail: firstLine(ffprobeProbe.output),
    source: ffprobe ? 'auto' : '',
    usedBy: ['B 站视频信息', '翻唱时长检测'],
  })

  let python = ''
  let pythonProbe = { ok: false, output: '' }
  for (const candidate of pythonCandidates()) {
    const p = await probe(candidate, ['--version'])
    if (p.ok) { python = candidate; pythonProbe = p; break }
    if (!python) { python = candidate; pythonProbe = p }
  }
  tools.push({
    id: 'python',
    label: 'Python',
    kind: 'runtime',
    status: python && pythonProbe.ok ? 'ready' : python ? 'invalid' : 'missing',
    path: python,
    version: versionMatch(firstLine(pythonProbe.output)),
    detail: firstLine(pythonProbe.output),
    source: python ? 'auto' : '',
    usedBy: ['翻唱 / RVC', '语音合成 edge-tts'],
  })

  const uvCandidates = [process.env.AURABOT_UV, join(homedir(), 'Aurabot', 'bin', 'uv.exe'), join('C:\\Aurabot', 'bin', 'uv.exe'), onPath('uv')].filter(Boolean)
  let uv = ''
  let uvProbe = { ok: false, output: '' }
  for (const candidate of uvCandidates) {
    const p = await probe(candidate, ['--version'])
    if (p.ok) { uv = candidate; uvProbe = p; break }
  }
  tools.push({
    id: 'uv',
    label: 'uv',
    kind: 'runtime',
    status: uv && uvProbe.ok ? 'ready' : uv ? 'invalid' : 'missing',
    path: uv,
    version: versionMatch(firstLine(uvProbe.output)),
    detail: firstLine(uvProbe.output),
    source: uv ? 'auto' : '',
    usedBy: ['创建 Python 环境', '安装翻唱依赖'],
  })

  const git = onPath('git')
  const gitProbe = git ? await probe(git, ['--version']) : { ok: false, output: '' }
  tools.push({
    id: 'git',
    label: 'Git',
    kind: 'tool',
    status: git && gitProbe.ok ? 'ready' : git ? 'invalid' : 'missing',
    path: git,
    version: versionMatch(firstLine(gitProbe.output)),
    detail: firstLine(gitProbe.output),
    source: git ? 'auto' : '',
    usedBy: ['备份推送'],
  })

  tools.push({
    id: 'edge-tts',
    label: 'edge-tts',
    kind: 'runtime',
    status: edgeInstalled(python) ? 'ready' : 'missing',
    path: edgeInstalled(python) ? dirname(python) : '',
    version: '',
    detail: edgeInstalled(python) ? '已安装到 Python 环境' : '未安装到 Python 环境',
    source: edgeInstalled(python) ? 'managed' : '',
    usedBy: ['语音合成'],
  })

  const value = { ok: true, tools }
  listCache = { at: Date.now(), value }
  return value
}
