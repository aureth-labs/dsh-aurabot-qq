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

test('DSH Cookie 清理：进程 exit 时能拉起 detached helper（真实子进程）', async (t) => {
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
    `import { installDshCookieCleanup } from ${JSON.stringify(moduleUrl)}`,
    'installDshCookieCleanup({',
    '  getConfig: () => ({ security: { cleanDshCookiesOnExit: true }, tools: { python: { path: process.env.PYTHON_PATH } } }),',
    '  dataDir: () => process.env.DATA_DIR,',
    '  scriptPath: process.env.HELPER_SCRIPT,',
    '  log: { info() {}, warn() {} },',
    '})',
    'process.exit(0)',
  ].join('\n')
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: {
      ...process.env,
      PYTHON_PATH: python,
      DATA_DIR: dir,
      HELPER_SCRIPT: fakeScript,
    },
    stdio: 'ignore',
    windowsHide: true,
  })
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  assert.equal(status, 0)
  const log = join(dir, 'dsh-cookie-cleanup.log')
  const deadline = Date.now() + 5000
  while (!existsSync(log) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
  assert.equal(existsSync(log), true, 'detached Python helper 应在 Node 退出后启动')
  assert.match(readFileSync(log, 'utf8'), /helper-started/)
})
