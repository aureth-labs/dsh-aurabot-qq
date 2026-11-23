// DSH Desktop 退出后的 Cookie 清理：
// DSH 的 Chromium Cookie 库在反复重启后会堆积 dsh-auth-*，超过约 71 次后可能
// 导致桌面端无法正常启动。清理必须先等 DSH 完全退出，因此这里在进程 exit 时
// 拉起一个 detached Python helper；helper 自己等 DeepSeek Harness.exe 消失，
// 再备份并删除 localhost 下的 dsh-auth-*，其他 Cookie 不动。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeToolPath } from './tools.js'
import { compareVersions } from './update.js'

const WIN = process.platform === 'win32'
const NATIVE_CLEANUP_MIN_VERSION = '0.2.2'
const NATIVE_CLEANUP_MIN_PRERELEASE = ['rc', '2']
const DSH_VERSION = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const NUMERIC_IDENTIFIER = /^\d+$/
const SCRIPT_PATH = fileURLToPath(new URL('../scripts/clean-dsh-cookies.py', import.meta.url))
const AUTH_FILTER = "host_key IN ('127.0.0.1', 'localhost', '[::1]', '::1') AND name GLOB 'dsh-auth-*'"
const DSH_IMAGE = 'DeepSeek Harness.exe'

function comparePrerelease(ids, minimum) {
  for (let i = 0; i < Math.min(ids.length, minimum.length); i++) {
    const a = ids[i]
    const b = minimum[i]
    if (a === b) continue
    const aNumeric = NUMERIC_IDENTIFIER.test(a)
    const bNumeric = NUMERIC_IDENTIFIER.test(b)
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    if (aNumeric && a.length !== b.length) return a.length - b.length
    // SemVer 的文本标识符按 ASCII 顺序比较，等长数字也可直接比较。
    return a < b ? -1 : 1
  }
  return ids.length - minimum.length
}

export function isDshCookieCleanupManaged(env = process.env) {
  // DSH Desktop 在启动 Host 子进程时传入当前桌面构建版本。
  const version = DSH_VERSION.exec(String(env.DSH_CLIENT_VERSION || '').trim())
  if (!version) return false
  const [, core, prerelease] = version
  const ids = prerelease?.split('.') ?? []
  if (ids.some(id => /^0\d+$/.test(id))) return false

  const order = compareVersions(core, NATIVE_CLEANUP_MIN_VERSION)
  if (order !== 0) return order > 0
  return !ids.length || comparePrerelease(ids, NATIVE_CLEANUP_MIN_PRERELEASE) >= 0
}

function cleanupEnabled(cfg) {
  return cfg?.security?.cleanDshCookiesOnExit === true && !isDshCookieCleanupManaged()
}

function exe(name) {
  return WIN ? `${name}.exe` : name
}

function onPath(name) {
  const dirs = String(process.env.PATH || '').split(WIN ? ';' : ':').filter(Boolean)
  for (const dir of dirs) {
    const path = join(dir, exe(name))
    if (existsSync(path)) return path
  }
  return ''
}

export function cookieDatabasePath(env = process.env) {
  const appdata = env.APPDATA || env.LOCALAPPDATA || ''
  if (!appdata) return ''
  return join(appdata, '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies')
}

export function findPython(cfg) {
  if (!WIN) return ''
  const configured = normalizeToolPath(cfg?.tools?.python?.path || '', 'python')
  if (configured && existsSync(configured)) return configured
  const candidates = [
    process.env.AURABOT_PYTHON,
    process.env.AURABOT_PYENV ? join(process.env.AURABOT_PYENV, 'Scripts', 'python.exe') : '',
    join(homedir(), 'Aurabot', 'pyenv', 'Scripts', 'python.exe'),
    'C:\\Aurabot\\pyenv\\Scripts\\python.exe',
    onPath('python3'),
    onPath('python'),
  ].filter(Boolean)
  return candidates.find((path) => existsSync(path)) || ''
}

/**
 * 优先用 pythonw.exe：它没有控制台子系统，detached 启动时不会闪终端窗口。
 * 找不到 pythonw 时退回 python.exe，并继续用 windowsHide 兜底。
 */
export function silentPython(python) {
  if (!WIN || !python) return python
  const pythonw = join(dirname(python), 'pythonw.exe')
  return existsSync(pythonw) ? pythonw : python
}

export function buildCleanupArgs({
  script = SCRIPT_PATH,
  database = cookieDatabasePath(),
  backupDir = '',
  logPath = '',
  timeout = 900,
  waitPid = 0,
} = {}) {
  const args = [script, '--apply', '--wait-dsh', '--timeout', String(timeout)]
  if (waitPid) args.push('--wait-pid', String(waitPid))
  if (database) args.push('--db', database)
  if (backupDir) args.push('--backup-dir', backupDir)
  if (logPath) args.push('--log', logPath)
  return args
}

let active = null
let exitHandlerInstalled = false

function spawnDetachedCleanup({ python, args, log }) {
  const child = spawn(python, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.on('error', (error) => log?.warn?.('DSH Cookie 清理 helper 启动失败：', error?.message || error))
  child.unref()
  return child
}

function onProcessExit() {
  const current = active
  if (!current) return
  try {
    const cfg = current.getConfig?.() || {}
    if (!cleanupEnabled(cfg)) return
    if (!WIN) return
    const python = findPython(cfg)
    if (!python) {
      current.log?.warn?.('DSH Cookie 清理已开启，但没找到 Python；本次跳过')
      return
    }
    const pythonExe = silentPython(python)
    const script = current.scriptPath || SCRIPT_PATH
    if (!existsSync(script)) {
      current.log?.warn?.('DSH Cookie 清理脚本不存在；本次跳过：', script)
      return
    }
    const root = current.dataDir?.() || ''
    const backupDir = root ? join(root, 'dsh-cookie-backups') : ''
    const logPath = root ? join(root, 'dsh-cookie-cleanup.log') : ''
    const args = buildCleanupArgs({
      script,
      database: cookieDatabasePath(process.env),
      backupDir,
      logPath,
      waitPid: process.pid,
    })
    spawnDetachedCleanup({ python: pythonExe, args, log: current.log })
    current.log?.info?.('已安排 DSH 退出后的 Cookie 清理')
  } catch (error) {
    current.log?.warn?.('安排 DSH Cookie 清理失败：', error?.message || error)
  }
}

/**
 * 注册/更新当前插件的退出清理配置。
 * 进程级 exit listener 只装一次；插件重载时只替换 getConfig/dataDir/log。
 * 不要在插件 dispose 时移除 listener：DSH 退出前可能先 dispose 插件。
 */
export function installDshCookieCleanup({ getConfig, dataDir, log, scriptPath = SCRIPT_PATH }) {
  active = { getConfig, dataDir, log, scriptPath }
  if (!exitHandlerInstalled) {
    exitHandlerInstalled = true
    process.once('exit', onProcessExit)
  }
  return {
    scriptPath,
    enabled: () => cleanupEnabled(getConfig?.()),
  }
}

export { AUTH_FILTER, DSH_IMAGE, SCRIPT_PATH }
