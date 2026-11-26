import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'
let dir, fake, app
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aurabot-filter-save-')); process.env.AURABOT_DATA_DIR = dir; process.env.AURABOT_WORKSPACE = join(dir, 'ws')
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ enabled: false, setupDone: true, ownerQQ: '10000001', botQQ: '20000002', snowluma: { autoStart: false, autoAttach: false, dir: join(dir, 'no') } }))
  fake = createFakeDsh({ brain: async () => 'unused' }); app = (await import('../src/host.js')).apply(fake.ctx); await app.ready
})
after(() => { fake?.dispose(); rmSync(dir, { recursive: true, force: true }) })
const save = async body => (await fake.call('/save', body)).json()
test('错填不保存任何项目；多个面板同时改名单会提示冲突', async () => {
  const before = structuredClone(app.getConfig()), next = { enabled: true, rules: [{ userId: '50000005', scope: 'groups', groups: ['30000003'] }] }
  const bad = await save({ memberFilter: { ...next, rules: [{ ...next.rules[0], groups: ['abc'] }] }, enabled: true })
  assert.equal(bad.code, 'invalid_member_filter'); assert.deepEqual(app.getConfig(), before)
  const ok = await save({ memberFilter: next, _groupSettingsBase: { memberFilter: before.memberFilter } }); assert.notEqual(ok.ok, false)
  const saved = structuredClone(app.getConfig())
  const conflict = await save({ memberFilter: before.memberFilter, _groupSettingsBase: { memberFilter: before.memberFilter }, enabled: true })
  assert.equal(conflict.code, 'group_settings_conflict'); assert.deepEqual(app.getConfig(), saved)
  assert.notEqual((await save({ dryRun: !saved.dryRun })).ok, false)
  assert.deepEqual(app.getConfig().memberFilter, next)
})
