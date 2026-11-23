import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { test } from 'node:test'
import {
  AUTH_FILTER,
  DSH_IMAGE,
  SCRIPT_PATH,
  buildCleanupArgs,
  cookieDatabasePath,
  findPython,
  installDshCookieCleanup,
  isDshCookieCleanupManaged,
  silentPython,
} from '../src/core/dsh-cookies.js'
import { normalize, mergeFromPanel, publicConfig } from '../src/core/config.js'

test('DSH Cookie 清理：默认关闭、配置归一化、面板保存与回显', () => {
  assert.equal(normalize({}).security.cleanDshCookiesOnExit, false)
  assert.equal(normalize({ security: { cleanDshCookiesOnExit: true } }).security.cleanDshCookiesOnExit, true)
  assert.equal(normalize({ security: { cleanDshCookiesOnExit: 'yes' } }).security.cleanDshCookiesOnExit, false)
  const merged = mergeFromPanel(normalize({}), { security: { cleanDshCookiesOnExit: true } })
  assert.equal(merged.security.cleanDshCookiesOnExit, true)
  assert.equal(publicConfig(merged).security.cleanDshCookiesOnExit, true)
})

test('DSH Cookie 清理：仅在确认桌面宿主版本已支持时交给宿主', () => {
  const cases = [
    [undefined, false],
    ['', false],
    ['unknown', false],
    ['0.2.1-rc.5', false],
    ['0.2.2-beta.1.2', false],
    ['0.2.2-rc.1', false],
    ['0.2.2-rc.1.12', false],
    ['0.2.2-rc.1+build.7', false],
    ['0.2.2-rc.2', true],
    ['0.2.2-rc.2.1', true],
    ['0.2.2-rc.2-dev', true],
    ['0.2.2-rc.10', true],
    ['0.2.2-rc.2+build.007-local', true],
    ['0.2.2+001.007', true],
    ['0.2.3-alpha.2', true],
    ['0.2.3-beta.1.2', true],
    ['0.2.3-rc.1.12+build.7', true],
    ['00.2.3', false],
    ['0.02.3', false],
    ['0.2.03', false],
    ['0.2.3-rc.02', false],
    ['0.2.3-alpha..1', false],
    ['0.2.3-rc.2_extra', false],
    ['0.2.3+meta..1', false],
  ]
  for (const [version, expected] of cases) {
    assert.equal(isDshCookieCleanupManaged({ DSH_CLIENT_VERSION: version }), expected, String(version))
  }
})

test('DSH Cookie 清理：数据库路径、过滤条件与 helper 参数', () => {
  assert.match(AUTH_FILTER, /dsh-auth-\*/)
  assert.match(AUTH_FILTER, /localhost/)
  assert.equal(DSH_IMAGE, 'DeepSeek Harness.exe')
  assert.ok(existsSync(SCRIPT_PATH), 'Python helper 应随插件发布')
  assert.match(
    cookieDatabasePath({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }),
    /@deepseek-ai[\\/]dsh-desktop[\\/]Network[\\/]Cookies$/,
  )
  const args = buildCleanupArgs({
    script: SCRIPT_PATH,
    database: 'C:\\Cookies',
    backupDir: 'C:\\backup',
    logPath: 'C:\\log.jsonl',
    timeout: 60,
    waitPid: 4321,
  })
  assert.deepEqual(args.slice(0, 5), [SCRIPT_PATH, '--apply', '--wait-dsh', '--timeout', '60'])
  assert.ok(args.includes('--wait-pid') && args.includes('4321'))
  assert.ok(args.includes('--db') && args.includes('C:\\Cookies'))
  assert.ok(args.includes('--backup-dir') && args.includes('C:\\backup'))
  assert.ok(args.includes('--log') && args.includes('C:\\log.jsonl'))
})

test('DSH Cookie 清理：优先使用无控制台的 pythonw，避免退出时闪终端', (t) => {
  if (process.platform !== 'win32') return t.skip('Windows only')
  const python = findPython({})
  if (!python) return t.skip('Python not available')
  const silent = silentPython(python)
  assert.equal(silent.toLowerCase().endsWith('pythonw.exe'), true)
})

test('DSH Cookie 清理：安全防护面板提供开关与风险说明', () => {
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.match(client, /退出 DSH 后清理 Cookie/)
  assert.match(client, /security\.cleanDshCookiesOnExit/)
  assert.match(client, /dsh-auth-\*/)
  assert.match(client, /保留最近 5 份/)
})

test('DSH Cookie 清理：宿主提供接管状态，面板在接管时禁用旧开关', () => {
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const host = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8')
  const start = client.indexOf('退出 DSH 后清理 Cookie')
  const end = client.indexOf('SSRF 防护', start)
  assert.ok(start >= 0 && end > start)
  const card = client.slice(start, end)
  assert.match(client, /st\.dshCookieCleanupManaged/)
  assert.match(client, /const cleanCookiesOnExit = !dshCookieCleanupManaged && draft\.security\?\.cleanDshCookiesOnExit === true/)
  assert.match(card, /on:\s*cleanCookiesOnExit/)
  assert.match(card, /disabled:\s*dshCookieCleanupManaged/)
  assert.match(host, /isDshCookieCleanupManaged\(\)/)
  assert.match(host, /\bdshCookieCleanupManaged\b/)
})

test('DSH Cookie 清理：新版宿主 /state 保留既有退出清理偏好', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-dsh-cookie-state-'))
  const previousEnv = {
    AURABOT_DATA_DIR: process.env.AURABOT_DATA_DIR,
    DSH_HOME: process.env.DSH_HOME,
    DSH_CLIENT_VERSION: process.env.DSH_CLIENT_VERSION,
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(dir, { recursive: true, force: true })
  })
  process.env.AURABOT_DATA_DIR = dir
  process.env.DSH_HOME = dir
  process.env.DSH_CLIENT_VERSION = '0.2.2-rc.2'
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ security: { cleanDshCookiesOnExit: true } }))
  const { createFakeDsh } = await import('./helpers/fake-dsh.js')
  const { apply } = await import('../src/host.js')
  const dsh = createFakeDsh({ brain: () => '' })
  try {
    apply(dsh.ctx)
    const status = (await dsh.call('/state')).json()
    assert.equal(status.dshCookieCleanupManaged, true)
    assert.equal(status.config.security.cleanDshCookiesOnExit, true)
  } finally {
    // The exit listener outlives plugin disposal. Disable the fixture before restoring the host environment.
    installDshCookieCleanup({ getConfig: () => ({}) })
    dsh.dispose()
  }
})

test('DSH Cookie 清理：Python helper 只删除 localhost 的 dsh-auth-* 并保留备份', (t) => {
  if (process.platform !== 'win32') return t.skip('Windows only')
  const python = findPython({})
  if (!python) return t.skip('Python not available')
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-dsh-cookie-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const db = join(dir, 'Cookies')
  const backup = join(dir, 'backups')
  const log = join(dir, 'cleanup.jsonl')
  const create = spawnSync(python, ['-c', [
    'import sqlite3, sys',
    'db = sqlite3.connect(sys.argv[1])',
    'db.execute("create table cookies(host_key text, name text, value text)")',
    'db.executemany("insert into cookies values(?,?,?)", [',
    '  ("127.0.0.1", "dsh-auth-a", "1"),',
    '  ("localhost", "dsh-auth-b", "2"),',
    '  ("[::1]", "dsh-auth-c", "3"),',
    '  ("example.com", "dsh-auth-keep", "4"),',
    '  ("127.0.0.1", "other", "5"),',
    '])',
    'db.commit()',
  ].join('\n'), db], { encoding: 'utf8' })
  assert.equal(create.status, 0, create.stderr)
  const result = spawnSync(silentPython(python), [SCRIPT_PATH, '--apply', '--db', db, '--backup-dir', backup, '--log', log], {
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(readFileSync(log, 'utf8').trim().split(/\r?\n/).at(-1))
  assert.equal(report.local_auth_cookies_before, 3)
  assert.equal(report.removed, 3)
  assert.equal(report.local_auth_cookies_after, 0)
  assert.equal(report.other_cookies, 2)
  assert.ok(existsSync(report.backup))
  assert.match(readFileSync(log, 'utf8'), /"removed": 3/)
  const query = spawnSync(python, ['-c', [
    'import sqlite3, sys',
    'db = sqlite3.connect(sys.argv[1])',
    'print(db.execute("select host_key, name from cookies order by name").fetchall())',
  ].join('\n'), db], { encoding: 'utf8' })
  assert.equal(query.status, 0, query.stderr)
  assert.match(query.stdout, /dsh-auth-keep/)
  assert.match(query.stdout, /other/)
  assert.doesNotMatch(query.stdout, /dsh-auth-a/)
})

test('DSH Cookie 清理：真实子进程仅在旧版桌面宿主退出时启动 helper', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows only')
  const python = findPython({})
  if (!python) return t.skip('Python not available')
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-dsh-cookie-exit-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const fakeScript = join(dir, 'fake-helper.py')
  writeFileSync(fakeScript, [
    'import sys, pathlib',
    'args = sys.argv[1:]',
    'log = pathlib.Path(args[args.index("--log") + 1])',
    'log.write_text("helper-started\\n", encoding="utf-8")',
  ].join('\n'))
  const moduleUrl = new URL('../src/core/dsh-cookies.js', import.meta.url).href
  const code = [
    `import assert from 'node:assert/strict'`,
    `import childProcess from 'node:child_process'`,
    `import { writeFileSync } from 'node:fs'`,
    `import { syncBuiltinESMExports } from 'node:module'`,
    `import { join } from 'node:path'`,
    'const realSpawn = childProcess.spawn',
    'childProcess.spawn = (...args) => {',
    '  writeFileSync(join(process.env.DATA_DIR, "spawn-attempt"), "spawned")',
    '  return realSpawn(...args)',
    '}',
    'syncBuiltinESMExports()',
    `const { installDshCookieCleanup } = await import(${JSON.stringify(moduleUrl)})`,
    'const cleanup = installDshCookieCleanup({',
    '  getConfig: () => ({ security: { cleanDshCookiesOnExit: true }, tools: { python: { path: process.env.PYTHON_PATH } } }),',
    '  dataDir: () => process.env.DATA_DIR,',
    '  scriptPath: process.env.HELPER_SCRIPT,',
    '  log: { info() {}, warn() {} },',
    '})',
    'assert.equal(cleanup.enabled(), process.env.EXPECT_COOKIE_HELPER === "1")',
    'process.exit(0)',
  ].join('\n')
  for (const [version, expected] of [[undefined, true], ['0.2.2-rc.1', true], ['0.2.2-rc.2', false]]) {
    await t.test(version ?? '未提供版本', async () => {
      const dataDir = mkdtempSync(join(dir, 'run-'))
      const env = {
        ...process.env,
        EXPECT_COOKIE_HELPER: expected ? '1' : '0',
        PYTHON_PATH: python,
        DATA_DIR: dataDir,
        HELPER_SCRIPT: fakeScript,
      }
      if (version === undefined) delete env.DSH_CLIENT_VERSION
      else env.DSH_CLIENT_VERSION = version
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
        env,
        stdio: ['ignore', 'ignore', 'inherit'],
        windowsHide: true,
      })
      const status = await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', resolve)
      })
      assert.equal(status, 0)
      assert.equal(existsSync(join(dataDir, 'spawn-attempt')), expected)
      const log = join(dataDir, 'dsh-cookie-cleanup.log')
      if (expected) {
        const deadline = Date.now() + 5000
        while (!existsSync(log) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
        assert.match(readFileSync(log, 'utf8'), /helper-started/)
      } else {
        assert.equal(existsSync(log), false)
      }
    })
  }
})
