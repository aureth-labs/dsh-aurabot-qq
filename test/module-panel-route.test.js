import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'

test('模块声明 panel 路由复用完整管理闸，普通客户端路由保持原有边界，重载可撤销元数据', { timeout: 15000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-module-panel-'))
  const old = { data: process.env.AURABOT_DATA_DIR, workspace: process.env.AURABOT_WORKSPACE }
  process.env.AURABOT_DATA_DIR = dir; process.env.AURABOT_WORKSPACE = join(dir, 'workspace')
  const moduleDir = join(dir, 'modules', 'route-probe'); mkdirSync(moduleDir, { recursive: true })
  writeFileSync(join(moduleDir, 'index.mjs'), `export default {
    id: 'route-probe', api: 1, setup(api) {
      api.route('/manage', () => ({ ok: true, managed: true }), { access: 'panel' })
      api.route('/client', () => ({ ok: true, client: true }))
      return { }
    }
  }`)
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ enabled: true, dryRun: true, setupDone: true, ownerQQ: '10001', botQQ: '20002', voice: { enabled: false }, snowluma: { autoStart: false, autoAttach: false, dir: join(dir, 'no-snowluma') } }))
  const fake = createFakeDsh({ brain: async () => '' })
  t.after(async () => {
    fake.dispose(); await new Promise(setImmediate)
    for (const [key, value] of [['AURABOT_DATA_DIR', old.data], ['AURABOT_WORKSPACE', old.workspace]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    rmSync(dir, { recursive: true, force: true })
  })
  const app = (await import('../src/host.js')).apply(fake.ctx); await app.ready
  const path = '/ext/route-probe/manage'
  assert.equal((await fake.call(path)).status, 200)
  assert.equal((await fake.call(path, undefined, {}, '127.0.0.1')).json().managed, true)
  assert.equal((await fake.call(path, undefined, {}, '203.0.113.7')).status, 403)
  assert.equal((await fake.call(path, undefined, { 'x-forwarded-for': '127.0.0.1' }, '203.0.113.7')).status, 403)
  assert.equal((await fake.call(path, undefined, { host: 'evil.example' }, '127.0.0.1')).status, 403)
  assert.equal((await fake.call(path, {}, { origin: 'https://evil.example' }, '127.0.0.1')).status, 403)
  assert.equal((await fake.call('/ext/route-probe/client', undefined, {}, '203.0.113.7')).json().client, true)
  const setSecurity = (patch) => app.setConfig({ ...app.getConfig(), security: { ...app.getConfig().security, ...patch } })
  setSecurity({ trustedProxy: '127.0.0.1' })
  assert.equal((await fake.call(path, undefined, { 'x-forwarded-for': '203.0.113.7' }, '127.0.0.1')).status, 403)
  setSecurity({ panelRemoteAccess: true, publicHostname: 'panel.example' })
  assert.equal((await fake.call(path, undefined, { host: 'panel.example' }, '203.0.113.7')).status, 200)
  assert.equal((await fake.call(path, undefined, { host: 'evil.example' }, '203.0.113.7')).status, 403)
  assert.equal(app.modules.routeAccess('/aurabot/api' + path), 'panel')
  app.modules.stop('route-probe')
  assert.equal(app.modules.routeAccess('/aurabot/api' + path), null)
  assert.equal(app.modules.hasRoute('/aurabot/api' + path), false)
})
