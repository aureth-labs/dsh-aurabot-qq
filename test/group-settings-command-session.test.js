import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'
const OWNER = '10000001', G = '30000003', H = '40000004'
test('真实 QQ 命令入口绕过模型：单群、批量确认、面板同步、关闭后拒绝且不落入 LLM', async t => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-group-command-'))
  process.env.AURABOT_DATA_DIR = root; process.env.AURABOT_WORKSPACE = join(root, 'workspace')
  writeFileSync(join(root, 'config.json'), JSON.stringify({ enabled: true, dryRun: false, setupDone: true,
    ownerQQ: OWNER, botQQ: '20000002', allow: { private: ['10000002'], groups: [G] }, voice: { enabled: false },
    snowluma: { autoStart: false, autoAttach: false, dir: join(root, 'no-snowluma') }, merge: { enabled: false } }))
  const fake = createFakeDsh({ brain: async () => { throw new Error('命令不能进入 LLM') } })
  const app = (await import('../src/host.js')).apply(fake.ctx)
  t.after(async () => { fake.dispose(); await app.dispose?.(); rmSync(root, { recursive: true, force: true }) })
  await app.ready
  let seq = 1
  const command = async (text, user = OWNER, group = false) => {
    const event = { post_type: 'message', message_type: group ? 'group' : 'private', self_id: 20000002,
      user_id: Number(user), ...(group ? { group_id: Number(G) } : {}), message_id: seq++,
      sender: { user_id: Number(user), nickname: '测试' }, message: [{ type: 'text', data: { text } }] }
    const { sent } = await app.hub.capture(() => app.hub.onMessage(event), { simulate: true })
    return sent.flatMap(s => s.message).filter(s => s.type === 'text').map(s => s.data.text).join('\n')
  }
  assert.match(await command(`/群设置 修改 ${G} 主动 关`), /已保存/)
  let current = (await fake.call('/state')).json().config
  assert.deepEqual(current.group.overrides[G], { proactiveEnabled: false })
  const old = structuredClone(current)
  const p = await command(`/群设置 修改 ${G},${H} 窗口 开 旁听 开`)
  assert.match(p, /尚未修改/); assert.deepEqual((await fake.call('/state')).json().config, old)
  const confirm = '/群设置 确认 ' + p.match(/确认 (\d{6})/)[1]
  assert.match(await command(confirm), /已保存 2 个群/)
  current = (await fake.call('/state')).json().config
  assert.deepEqual(current.memory.passiveGroups, [G, H]); assert.deepEqual(current.allow.groups, [G])
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'config.json'))).group.overrides, current.group.overrides)
  const conflict = (await fake.call('/save', { group: old.group, _groupSettingsBase: { group: old.group } })).json()
  assert.equal(conflict.code, 'group_settings_conflict')
  assert.match(await command(`/群设置 修改 ${G} 白名单 关`, '10000002'), /权限|主人私聊/)
  assert.match(await command(`/群设置 修改 ${G} 白名单 关`, OWNER, true), /主人私聊/)
  assert.deepEqual((await fake.call('/state')).json().config.allow.groups, [G])
  const save = (await fake.call('/save', { group: { ...current.group, privateCommandsEnabled: false } })).json()
  assert.notEqual(save.ok, false)
  assert.match(await command(`/群设置 修改 ${G} 白名单 关`), /指令已关闭/)
  assert.equal(fake.turns.length, 0)
  assert.deepEqual((await fake.call('/state')).json().config.allow.groups, [G])
  assert.equal(fake.logs.some(r => JSON.stringify(r).includes(confirm)), false, '审计日志不写确认码')
})
