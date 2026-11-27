// WebDAV 云备份：PUT 最新 zip、按保留份数 DELETE 旧文件，不碰 git。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let push
let okFetch
const root = mkdtempSync(join(tmpdir(), 'aurabot-webdav-'))
const base = 'https://dav.example.com'
const folder = base + '/aurabot-backups/'
const calls = []

before(async () => {
  process.env.AURABOT_DATA_DIR = root
  push = await import('../src/core/backup-push.js')
  push.pushHooks.spawn = () => { throw new Error('WebDAV 不应该跑 git') }
  okFetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body })
    const method = init.method || 'GET'
    if (method === 'MKCOL') return { ok: true, status: 201 }
    if (method === 'PUT') return { ok: true, status: 201 }
    if (method === 'DELETE') return { ok: true, status: 204 }
    if (method === 'GET') return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('downloaded-zip') }
    if (method === 'PROPFIND') {
      const files = ['aurabot-backup-20261101-0330.zip', 'aurabot-backup-20261102-0330.zip', 'aurabot-backup-20261103-0330.zip']
      return {
        ok: true, status: 207,
        text: async () => '<d:multistatus>' + files.map((f) => `<d:response><d:href>/aurabot-backups/${f}</d:href></d:response>`).join('') + '</d:multistatus>',
      }
    }
    return { ok: false, status: 500 }
  }
  push.pushHooks.fetch = okFetch
})

after(() => rmSync(root, { recursive: true, force: true }))

const putBackup = (name) => {
  mkdirSync(join(root, 'backups'), { recursive: true })
  writeFileSync(join(root, 'backups', name), 'zip-' + name)
}

test('WebDAV：PUT 最新备份，按 keep 删除旧的', async () => {
  rmSync(join(root, 'backups'), { recursive: true, force: true })
  calls.length = 0
  putBackup('aurabot-backup-20261101-0330.zip')
  putBackup('aurabot-backup-20261103-0330.zip')
  const r = await push.pushBackup({
    provider: 'webdav',
    webdav: { url: base + '/', username: 'user', password: 'SECRET_PW' },
    keep: 2,
  })
  assert.equal(r.ok, true)
  assert.equal(r.name, 'aurabot-backup-20261103-0330.zip')
  assert.equal(r.dropped, 1)
  const put = calls.find((c) => c.method === 'PUT')
  assert.equal(put.url, folder + 'aurabot-backup-20261103-0330.zip')
  assert.equal(put.headers.authorization, 'Basic ' + Buffer.from('user:SECRET_PW').toString('base64'))
  assert.equal(put.body.toString(), 'zip-aurabot-backup-20261103-0330.zip')
  const mkcol = calls.find((c) => c.method === 'MKCOL')
  assert.equal(mkcol.url, folder)
  const dels = calls.filter((c) => c.method === 'DELETE').map((c) => c.url)
  assert.deepEqual(dels, [folder + 'aurabot-backup-20261101-0330.zip'])
  assert.match(r.message, /WebDAV/)
  assert.equal(r.message.includes('SECRET_PW'), false)
})

test('WebDAV：可以只上传指定的仅配置备份', async () => {
  push.pushHooks.fetch = okFetch
  rmSync(join(root, 'backups'), { recursive: true, force: true })
  calls.length = 0
  putBackup('aurabot-config-20261104-0330.zip')
  const r = await push.pushBackup({
    provider: 'webdav',
    webdav: { url: base, username: 'u', password: 'p' },
    keep: 2,
  }, { sourceName: 'aurabot-config-20261104-0330.zip' })
  assert.equal(r.ok, true)
  assert.equal(r.name, 'aurabot-config-20261104-0330.zip')
  const put = calls.find((c) => c.method === 'PUT')
  assert.equal(put.url, folder + 'aurabot-config-20261104-0330.zip')
  assert.equal(put.body.toString(), 'zip-aurabot-config-20261104-0330.zip')
})

test('WebDAV：坚果云根地址自动补 /dav/，不会往根目录 MKCOL', async () => {
  push.pushHooks.fetch = okFetch
  calls.length = 0
  await push.listWebdavBackups({ provider: 'webdav', webdav: { url: 'https://dav.jianguoyun.com/', username: 'u', password: 'p' } })
  assert.equal(calls.find((c) => c.method === 'MKCOL').url, 'https://dav.jianguoyun.com/dav/aurabot-backups/')
  calls.length = 0
  await push.listWebdavBackups({ provider: 'webdav', webdav: { url: 'https://dav.jianguoyun.com/dav/', username: 'u', password: 'p' } })
  assert.equal(calls.find((c) => c.method === 'MKCOL').url, 'https://dav.jianguoyun.com/dav/aurabot-backups/')
})

test('WebDAV：缺地址/账号/密码时明确报错', async () => {
  await assert.rejects(push.pushBackup({ provider: 'webdav', webdav: {} }), /WebDAV 服务器地址/)
  await assert.rejects(push.pushBackup({ provider: 'webdav', webdav: { url: base } }), /用户名/)
  await assert.rejects(push.pushBackup({ provider: 'webdav', webdav: { url: base, username: 'u', password: '' } }), /应用授权码/)
})

test('WebDAV：网络错误信息里不出现密码', async () => {
  push.pushHooks.fetch = async () => { throw new Error('connect failed for SECRET_PW') }
  await assert.rejects(
    push.pushBackup({ provider: 'webdav', webdav: { url: base, username: 'u', password: 'SECRET_PW' }, keep: 1 }),
    (err) => !String(err.message).includes('SECRET_PW') && /WebDAV/.test(err.message),
  )
})

test('WebDAV：列出远端备份并可下载；只填 aurabot-backups 也不会重复建目录', async () => {
  push.pushHooks.fetch = okFetch
  calls.length = 0
  const cfg = { provider: 'webdav', webdav: { url: base + '/aurabot-backups', username: 'u', password: 'p' } }
  const list = await push.listWebdavBackups(cfg)
  assert.deepEqual(list.files, ['aurabot-backup-20261103-0330.zip', 'aurabot-backup-20261102-0330.zip', 'aurabot-backup-20261101-0330.zip'])
  const got = await push.downloadWebdavBackup(cfg, 'aurabot-backup-20261103-0330.zip')
  assert.equal(got.buffer.toString(), 'downloaded-zip')
  assert.ok(calls.some((c) => c.method === 'MKCOL' && c.url === folder))
  await assert.rejects(push.downloadWebdavBackup(cfg, '../evil.zip'), /文件名/)
})
