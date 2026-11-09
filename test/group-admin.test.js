// 群管：禁言某人 / 全体禁言 / 解除全体禁言，参数要发对（回归测试）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const groupAdmin = (await import('../src/modules/group-admin/index.js')).default
const { normalize } = await import('../src/core/config.js')

const GROUP = '555'

function boot ({ ownerTurn = true, dryRun = false } = {}) {
  const calls = []
  const tools = []
  const cfg = normalize({
    enabled: true,
    dryRun,
    ownerQQ: '10000001',
    allow: { groups: [GROUP] },
  })
  const api = {
    core: {
      hub: { turnHasOwner: () => ownerTurn, turnSendersAllOwner: () => ownerTurn, groupName: async () => '测试群' },
      onebot: { call: async (action, params) => { calls.push({ action, params }); return {} } },
      groupRoles: { peek: () => 'owner', get: async () => 'owner', canManage: () => true, label: () => '群主' },
    },
    config: () => cfg,
    log: { info () {}, warn () {}, debug () {}, child () { return this } },
    context: () => {},
    route: () => {},
    tool: (fn) => {
      const r = fn({ chat: { kind: 'group', groupId: GROUP, chatId: 'group:' + GROUP }, level: 'social', sessionId: 's1' })
      if (r) tools.push(...[r].flat())
    },
  }
  groupAdmin.setup(api)
  const tool = tools.find((t) => t.name === 'qq_group_admin')
  return { tool, calls, cfg }
}

test('群管工具里能选到全体禁言', () => {
  const { tool } = boot()
  assert.ok(tool, '没有 qq_group_admin 工具')
  const enumList = tool.parameters.properties.action.enum
  assert.ok(enumList.includes('whole_ban'), '枚举里没有 whole_ban')
  assert.ok(enumList.includes('whole_unban'), '枚举里没有 whole_unban')
})

test('全体禁言：直接对当前群调用 set_group_whole_ban，不需要 QQ 号', async () => {
  const { tool, calls } = boot()
  const r = await tool.execute({ action: 'whole_ban' }, {})
  assert.equal(r.ok, true, r.message)
  assert.deepEqual(calls, [{ action: 'set_group_whole_ban', params: { group_id: 555, enable: true } }])
})

test('解除全体禁言：enable=false', async () => {
  const { tool, calls } = boot()
  const r = await tool.execute({ action: 'whole_unban' }, {})
  assert.equal(r.ok, true, r.message)
  assert.deepEqual(calls, [{ action: 'set_group_whole_ban', params: { group_id: 555, enable: false } }])
})

test('单个禁言仍然要 QQ 号，别拿全体禁言当默认', async () => {
  const { tool, calls } = boot()
  const bad = await tool.execute({ action: 'ban' }, {})
  assert.equal(bad.ok, false)
  assert.match(bad.message, /对谁/)
  assert.equal(calls.length, 0, '缺参数时不该真的调用')

  const ok = await tool.execute({ action: 'ban', user_id: '999', minutes: 5 }, {})
  assert.equal(ok.ok, true)
  assert.deepEqual(calls[0], { action: 'set_group_ban', params: { group_id: 555, user_id: 999, duration: 300 } })
})

test('试运行时不真的调用；主人没开口也拦住', async () => {
  const dry = boot({ dryRun: true })
  const r1 = await dry.tool.execute({ action: 'whole_ban' }, {})
  assert.equal(r1.ok, true)
  assert.match(r1.message, /试运行/)
  assert.equal(dry.calls.length, 0, '试运行不该真的调用')

  const noOwner = boot({ ownerTurn: false })
  const r2 = await noOwner.tool.execute({ action: 'whole_ban' }, {})
  assert.equal(r2.ok, false)
  assert.match(r2.message, /只有主人/)
  assert.equal(noOwner.calls.length, 0)
})
