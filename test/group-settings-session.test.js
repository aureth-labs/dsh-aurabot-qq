// 通过真实宿主/模块装载/主人会话工具循环写入，再从面板读取，验证共用状态和冲突保护。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'

const OWNER = '10000001', G = '30000003'
test('主人会话工具修改可持久化、面板能读、旧草稿不能覆盖，其他会话不挂工具', async t => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-group-settings-session-'))
  process.env.AURABOT_DATA_DIR = root
  process.env.AURABOT_WORKSPACE = join(root, 'workspace')
  writeFileSync(join(root, 'config.json'), JSON.stringify({ enabled: false, dryRun: false, setupDone: true,
    ownerQQ: OWNER, botQQ: '20000002', allow: { groups: [G] }, voice: { enabled: false },
    snowluma: { autoStart: false, autoAttach: false, dir: join(root, 'no-snowluma') } }))
  const fake = createFakeDsh({ brain: async ({ text, callTool }) => {
    const result = await callTool('qq_group_settings', { action: 'set', group_id: G, proactive: false, engaged: true })
    assert.equal(result.ok, !text.includes('不是主人'), result.message)
    return '' // 不发送 QQ 回复；这里只验证 Agent 工具链。
  } })
  const app = (await import('../src/host.js')).apply(fake.ctx)
  t.after(async () => { fake.dispose(); await app.dispose?.(); rmSync(root, { recursive: true, force: true }) })
  await app.ready
  const old = (await fake.call('/state')).json().config
  const ownerChat = { kind: 'private', userId: OWNER, chatId: `private:${OWNER}`, nickname: '主人', groupId: '' }
  await app.hub.pushToSession(ownerChat, [{ type: 'text', text: `群 ${G} 不主动插话，窗口里可以接话` }], OWNER)
  const current = (await fake.call('/state')).json().config
  assert.deepEqual(current.group.overrides[G], { proactiveEnabled: false, engagedEnabled: true })
  assert.deepEqual(current.allow, old.allow)
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).group.overrides, current.group.overrides)
  assert.equal(fake.turns.at(-1).toolCalls[0].name, 'qq_group_settings')
  const conflict = (await fake.call('/save', { group: old.group, _groupSettingsBase: { group: old.group } })).json()
  assert.equal(conflict.code, 'group_settings_conflict')
  assert.deepEqual(app.getConfig().group.overrides, current.group.overrides)
  await app.hub.pushToSession(ownerChat, [{ type: 'text', text: '不是主人尝试修改' }], '10000002')
  assert.deepEqual(app.getConfig().group.overrides, current.group.overrides)
  const { createMutes } = await import('../src/chat/commands.js')
  createMutes().set(`group:${G}`, 0)
  const pausedFile = readFileSync(join(root, 'mutes.json'), 'utf8')
  const read = (await fake.call('/modules/tool', { as: 'owner', kind: 'private', name: 'qq_group_settings', args: { action: 'get', group_id: G } })).json()
  assert.equal(read.result.state.reply_paused, true)
  assert.match(read.result.message, /已暂停聊天/)
  assert.deepEqual(read.sent, [])
  assert.equal(readFileSync(join(root, 'mutes.json'), 'utf8'), pausedFile, '查看不改暂停记录')
  for (const q of ['as=other&kind=private', 'as=owner&kind=group']) {
    const list = (await fake.call('/modules/tools?' + q)).json().list
    assert.ok(!list.some(x => x.name === 'qq_group_settings'))
  }
})
