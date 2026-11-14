// 群命令和未保存面板草稿并存：不让旧页面悄悄撤销 /quiet。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { runCommand, parseCommand } from '../src/chat/commands.js'

let fake, app, dir
const G = '30000003'
const groupMsg = { kind: 'group', chatId: `group:${G}`, groupId: G, userId: '10000001' }
const save = async body => (await fake.call('/save', body)).json()
const snapshot = () => structuredClone(app.getConfig())
const command = name => runCommand(parseCommand(name), groupMsg, { getConfig: app.getConfig, setConfig: app.setConfig })
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aurabot-group-save-'))
  process.env.AURABOT_DATA_DIR = dir
  process.env.AURABOT_WORKSPACE = join(dir, 'workspace')
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ enabled: false, dryRun: true, setupDone: true,
    ownerQQ: '10000001', botQQ: '20000002', voice: { enabled: false },
    snowluma: { autoStart: false, autoAttach: false, dir: join(dir, 'no-snowluma') } }))
  fake = createFakeDsh({ brain: async () => { throw new Error('设置保存不应开启对话') } })
  app = (await import('../src/host.js')).apply(fake.ctx)
  await app.ready
})
after(async () => { fake?.dispose(); await app?.dispose?.(); rmSync(dir, { recursive: true, force: true }) })

test('面板草稿早于 /quiet：整次保存拒绝，不写其他字段', async () => {
  await command('/normal')
  const old = snapshot()
  await command('/quiet')
  const quiet = snapshot()
  const r = await save({ group: old.group, dryRun: !quiet.dryRun, _groupSettingsBase: { group: old.group } })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'group_settings_conflict')
  assert.deepEqual(app.getConfig(), quiet)
  assert.match(r.message, /读取最新设置/)
})
test('其他页面不携带未改的群设置：不妨碍 /quiet，也可保存其他项', async () => {
  const group = snapshot().group
  assert.notEqual((await save({ dryRun: false })).ok, false)
  assert.deepEqual(app.getConfig().group, group)
  assert.equal(app.getConfig().dryRun, false)
})
test('基线匹配可改窗口接话，空 overrides 可恢复继承；元数据不入配置', async () => {
  let base = snapshot().group
  let r = await save({ group: { ...base, overrides: { [G]: { proactiveEnabled: false, engagedEnabled: true } } }, _groupSettingsBase: { group: base } })
  assert.notEqual(r.ok, false)
  assert.equal(app.getConfig().group.overrides[G].engagedEnabled, true)
  assert.equal(Object.hasOwn(app.getConfig(), '_groupSettingsBase'), false)
  base = snapshot().group
  r = await save({ group: { ...base, overrides: {} }, _groupSettingsBase: { group: base } })
  assert.notEqual(r.ok, false)
  assert.deepEqual(app.getConfig().group.overrides, {})
})
test('其他地方改旁听名单：不能用旧名单覆盖，也不写同次群改动', async () => {
  const old = snapshot()
  await save({ memory: { passiveGroups: [G] } })
  const current = snapshot()
  const r = await save({ group: { ...old.group, proactiveEnabled: false }, memory: { passiveGroups: [] },
    _groupSettingsBase: { group: old.group, passiveGroups: old.memory.passiveGroups } })
  assert.equal(r.code, 'group_settings_conflict')
  assert.deepEqual(app.getConfig(), current)
})
test('旁听与群接话是独立部分，改群接话不覆盖后来增加的旁听名单', async () => {
  const base = snapshot().group
  const r = await save({ group: { ...base, proactiveEnabled: false }, _groupSettingsBase: { group: base } })
  assert.notEqual(r.ok, false)
  assert.deepEqual(app.getConfig().memory.passiveGroups, [G])
})
test('读取最新设置后可继续保存，/chatty /normal 仍可覆盖新开关', async () => {
  const base = snapshot()
  assert.notEqual((await save({ memory: { passiveGroups: [] }, _groupSettingsBase: { passiveGroups: base.memory.passiveGroups } })).ok, false)
  await command('/chatty')
  assert.equal(app.getConfig().group.overrides[G].proactiveEnabled, true)
  await command('/normal')
  assert.equal(app.getConfig().group.overrides[G], undefined)
  assert.equal(fake.agents.size, 0)
})
test('旧版和模块不带基线的局部保存继续可用', async () => {
  const r = await save({ group: { overrides: { [G]: { engagedEnabled: true } } } })
  assert.notEqual(r.ok, false)
  assert.equal(app.getConfig().group.overrides[G].engagedEnabled, true)
})
