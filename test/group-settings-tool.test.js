import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupSettingsTool, planGroupSettings } from '../src/modules/contacts/group-settings.js'
import { normalize } from '../src/core/config.js'
import { decideGroupReply, policyFor } from '../src/chat/group-policy.js'
import { runCommand, parseCommand } from '../src/chat/commands.js'

const OWNER = '10000001', OTHER = '10000002', G = '30000003', H = '40000004'
const chat = { kind: 'private', userId: OWNER, chatId: `private:${OWNER}` }
function setup(patch = {}, { allOwner = true, beforeSave, failSave = false } = {}) {
  let cfg = normalize({ ownerQQ: OWNER, botQQ: '20000002', enabled: true, dryRun: false,
    allow: { groups: [G] }, ...patch })
  let saves = 0
  const warnings = []
  const api = { config: () => cfg, core: { hub: { turnSendersAllOwner: () => allOwner } }, log: { warn: (...args) => warnings.push(args) },
    setConfig(fn) {
      if (failSave) throw new Error('EACCES /home/private/secret-config.json\n at internal.js:12')
      if (beforeSave) cfg = normalize(beforeSave(cfg))
      cfg = normalize(fn(cfg)); saves++
    } }
  return { api, tool: groupSettingsTool(api, { chat, sessionId: 's' }), cfg: () => cfg, saves: () => saves,
    set: patch => { cfg = normalize({ ...cfg, ...patch }) }, warnings }
}
const call = (s, args = {}) => s.tool.execute({ action: 'set', group_id: G, ...args })
const read = s => call(s, { action: 'get' })

test('只挂主人私聊；名单权限 all 也不开放给别人或群，off 不挂', () => {
  const s = setup({ profilePerms: { whitelist: 'all' } })
  assert.ok(s.tool)
  for (const c of [{ kind: 'private', userId: OTHER }, { kind: 'group', userId: OWNER }, { kind: 'system', userId: OWNER }]) {
    assert.equal(groupSettingsTool(s.api, { chat: c, sessionId: 's' }), null)
  }
  assert.equal(setup({ profilePerms: { whitelist: 'off' } }).tool, null)
  assert.equal(setup({ ownerQQ: '' }).tool, null)
})
test('执行时复查主人、名单权限与本轮来源，不依赖已经挂好的工具', async () => {
  for (const patch of [{ ownerQQ: OTHER }, { profilePerms: { whitelist: 'off' } }]) {
    const s = setup(); s.set(patch)
    assert.equal((await call(s, { engaged: true })).ok, false)
    assert.equal((await read(s)).ok, false)
    assert.equal(s.saves(), 0)
  }
  const s = setup({}, { allOwner: false })
  assert.equal((await call(s, { engaged: true })).ok, false)
  assert.equal(s.saves(), 0)
})
test('查看不写配置、不返回私密字段；只开放固定参数', async () => {
  const s = setup({ snowluma: { httpToken: 'test-private-token' } })
  const r = await read(s)
  assert.equal(r.ok, true); assert.equal(r.state.group_id, G); assert.equal(s.saves(), 0)
  assert.equal(JSON.stringify(r).includes('test-private-token'), false)
  assert.equal(s.tool.parameters.additionalProperties, false)
  assert.deepEqual(s.tool.parameters.properties.action.enum, ['list', 'get', 'set', 'reset'])
})
test('严格拒绝错误类型、多个群号、群名、额外参数和混合 get/reset，整次不改', async () => {
  const s = setup(), before = structuredClone(s.cfg())
  for (const args of [{}, { engaged: 'false' }, { proactive: null }, { passive_memory: 0 },
    { engaged: true, group_id: '30000003,40000004' }, { engaged: true, group_id: '群30000003' },
    { engaged: true, group_id: 'abc30000003def' }, { engaged: true, group_id: 30000003 },
    { engaged: true, group_id: '123' }, { engaged: true, group_id: '030000003' },
    { action: 'delete', engaged: true }, { action: 'get', engaged: true }, { action: 'reset', passive_memory: true },
    { engaged: true, ownerQQ: OTHER }, { engaged: true, passive_memory: 'false' }]) {
    assert.equal((await call(s, args)).ok, false, JSON.stringify(args))
    assert.deepEqual(s.cfg(), before)
  }
  assert.equal(s.saves(), 0)
})
test('只改指定群指定开关，保留概率、其它限制、其它群及白名单；同样请求幂等', async () => {
  const s = setup({ group: { overrides: { [G]: { cooldownSec: 93, interjectChance: .22 }, [H]: { engagedEnabled: false } } } })
  const before = structuredClone(s.cfg())
  let r = await call(s, { proactive: false, engaged: true })
  assert.equal(r.ok, true); assert.equal(r.changed, true)
  assert.deepEqual(s.cfg().group.overrides[G], { cooldownSec: 93, interjectChance: .22, proactiveEnabled: false, engagedEnabled: true })
  assert.deepEqual(s.cfg().group.overrides[H], before.group.overrides[H]); assert.deepEqual(s.cfg().allow, before.allow)
  r = await call(s, { proactive: false, engaged: true }); assert.equal(r.changed, false); assert.equal(s.saves(), 1)
})
test('群命令和工具使用同一份设置，quiet 后单独打开窗口立刻有效', async () => {
  const s = setup()
  await runCommand(parseCommand('/quiet'), { kind: 'group', groupId: G }, { getConfig: s.cfg, setConfig: next => s.set(next) })
  let r = await read(s); assert.equal(r.state.engaged, false)
  r = await call(s, { engaged: true }); assert.equal(r.state.proactive, false); assert.equal(r.state.engaged, true)
  const policy = policyFor(s.cfg().group, s.cfg().group.overrides, G)
  assert.equal(decideGroupReply({ policy, now: 10000, hour: 12, text: '我也喜欢', relevance: 1, engagedUntil: 20000 }).mode, 'engaged')
})
test('开启主动插话时恢复零概率，并保留未指定的旧式窗口行为', async () => {
  for (const globalChance of [0, .25]) {
    const s = setup({ group: { interjectChance: globalChance, overrides: { [G]: { interjectChance: 0 } } } })
    assert.equal((await read(s)).state.engaged, false)
    const r = await call(s, { proactive: true })
    assert.equal(r.state.proactive, true); assert.equal(r.state.engaged, false)
    assert.equal(r.state.interject_chance, globalChance || .15)
    assert.equal(s.cfg().group.interjectChance, globalChance)
  }
  const s = setup({ group: { interjectChance: 0 } })
  const r = await call(s, { proactive: true, engaged: true })
  assert.equal(r.state.engaged, true)
})
test('reset 对齐 /normal，只恢复群覆盖，不删除其它群或旁听名单', async () => {
  const s = setup({ group: { overrides: { [G]: { engagedEnabled: true, cooldownSec: 99 }, [H]: { proactiveEnabled: false } } }, memory: { passiveGroups: [G] } })
  let r = await call(s, { action: 'reset' }); assert.equal(r.changed, true)
  assert.equal(s.cfg().group.overrides[G], undefined); assert.ok(s.cfg().group.overrides[H])
  assert.deepEqual(s.cfg().memory.passiveGroups, [G]); assert.equal(r.state.overrides.engaged, null)
  r = await call(s, { action: 'reset' }); assert.equal(r.changed, false); assert.equal(s.saves(), 1)
})
test('旁听只操作名单，不擅自开记忆、不加聊天白名单；移除对白名单群不会夸称停止记录', async () => {
  const s = setup({ memory: { enabled: false, passiveGroups: [G] } })
  let r = await call(s, { group_id: H, passive_memory: true })
  assert.deepEqual(s.cfg().memory.passiveGroups, [G, H]); assert.equal(s.cfg().memory.enabled, false)
  assert.equal(r.state.chat_whitelisted, false); assert.match(r.message, /未自动加入白名单/); assert.match(r.message, /记忆开关已关闭，不会新增旁听记录/)
  r = await call(s, { passive_memory: false }); assert.match(r.message, /移出旁听名单不等于停止记录/)
  assert.deepEqual(s.cfg().allow.groups, [G]); assert.deepEqual(s.cfg().memory.passiveGroups, [H])
  r = await call(s, { group_id: H, passive_memory: false }); assert.match(r.message, /已有记忆不删除/)
})
test('dryRun 和 debug 只预览，不保存；查看仍返回当前真实状态', async () => {
  for (const patch of [{ dryRun: true }, { debug: true }]) {
    const s = setup(patch), before = structuredClone(s.cfg())
    const r = await call(s, { proactive: false, passive_memory: true })
    assert.equal(r.preview, true); assert.equal(r.changed, false); assert.match(r.message, /未保存/)
    assert.deepEqual(s.cfg(), before); assert.equal(s.saves(), 0)
    assert.equal((await read(s)).state.passive_memory, false)
  }
})
test('保存时在最新配置上规划，保留同时改的其它项', async () => {
  const s = setup({}, { beforeSave: cur => ({ ...cur,
    group: { ...cur.group, overrides: { [G]: { cooldownSec: 99 }, [H]: { engagedEnabled: false } } },
    memory: { ...cur.memory, passiveGroups: [H] } }) })
  await call(s, { engaged: true, passive_memory: true })
  assert.equal(s.cfg().group.overrides[G].cooldownSec, 99); assert.ok(s.cfg().group.overrides[H])
  assert.deepEqual(s.cfg().memory.passiveGroups, [H, G])
})
test('写入边界再次复核权限与调试，发生变化就拒绝', async () => {
  for (const patch of [{ ownerQQ: OTHER }, { debug: true }, { profilePerms: { whitelist: 'off' } }]) {
    const s = setup({}, { beforeSave: cur => ({ ...cur, ...patch }) })
    assert.equal((await call(s, { engaged: true })).ok, false)
    assert.equal(s.saves(), 0); assert.equal(s.cfg().group.overrides[G], undefined)
  }
})
test('保存异常不会把堆栈、宿主路径或密钥回到工具结果', async () => {
  const s = setup({}, { failSave: true })
  const r = await call(s, { engaged: true })
  assert.equal(r.ok, false); assert.match(r.message, /保存未确认/)
  assert.doesNotMatch(JSON.stringify(r), /home|secret|internal|EACCES/); assert.equal(s.warnings.length, 1)
})
test('规划器不修改输入对象', () => {
  const cfg = normalize({}), before = structuredClone(cfg)
  const plan = planGroupSettings(cfg, { action: 'set', group_id: G, proactive: false, passive_memory: true })
  assert.equal(plan.ok, true); assert.deepEqual(cfg, before)
})

test('查询把保存的设置和暂停、试运行、零上限区分开，恢复默认不解除暂停', async () => {
  const s = setup({ group: { overrides: { [G]: { engagedEnabled: true } }, maxPerHour: 0, engagedMax: 0 } })
  s.api.core.mutes = { until: () => 0 }
  let r = await read(s)
  assert.equal(r.state.reply_paused, true)
  assert.equal(r.state.follows_defaults, false)
  assert.match(r.message, /这个群已暂停聊天/)
  assert.match(r.message, /每小时插话上限为 0/)
  assert.match(r.message, /连续接话次数为 0/)
  r = await call(s, { action: 'reset' })
  assert.equal(r.state.follows_defaults, true)
  assert.equal(r.state.reply_paused, true)
  assert.match(r.message, /已恢复跟随全局，旁听名单没改/)
  s.api.core.mutes = { until: () => Date.now() - 1000 }
  assert.equal((await read(s)).state.reply_paused, false, '过期暂停不误报，也不调用会写文件的 muted')
  s.set({ dryRun: true })
  assert.match((await read(s)).message, /试运行：不发消息/)
  s.set({ dryRun: false, enabled: false })
  assert.match((await read(s)).message, /总开关已关闭：不会回复/)
  s.set({ enabled: true, debug: true })
  assert.match((await read(s)).message, /调试模式：不发消息/)
})
test('错误回执提供操作指导，不暴露接口字段名', async () => {
  const s = setup()
  for (const args of [{ action: 'unknown' }, { engaged: 'false' }, { extra: true }]) {
    const r = await call(s, args)
    assert.equal(r.ok, false)
    assert.doesNotMatch(r.message, /group_id|action|true|false|reset|set| get /)
    assert.match(r.message, /未修改设置/)
  }
})

test('一次查询给出完整群设置，区分白名单、发言开关、概率、窗口、旁听和记忆', async () => {
  const s = setup({ group: { proactiveEnabled: false, engagedEnabled: true, interjectChance: .25,
    maxPerHour: 4, cooldownSec: 90, engagedMax: 3, quietHours: [0, 0] }, memory: { enabled: true, passiveGroups: [H] } })
  let r = await read(s)
  assert.equal(r.state.chat_whitelisted, true)
  assert.equal(r.state.can_reply_by_settings, true)
  assert.equal(r.state.proactive, false); assert.equal(r.state.engaged, true)
  assert.equal(r.state.interject_chance, .25); assert.equal(r.state.proactive_max_per_hour, 4)
  assert.equal(r.state.engaged_max, 3); assert.equal(r.state.memory_enabled, true)
  assert.equal(r.state.memory_scope, 'whitelist'); assert.equal(r.state.passive_memory, false)
  for (const label of ['聊天白名单：在', '被叫到时：按原规则回复', '主动加入话题：关', '基础概率 25%', '窗口内接话：开', '旁听名单：未加入', '记忆开关：开', '静默时段：未设置']) assert.ok(r.message.includes(label), label)
  r = await call(s, { action: 'get', group_id: H })
  assert.equal(r.state.can_reply_by_settings, false)
  assert.equal(r.state.memory_scope, 'passive'); assert.equal(r.state.passive_memory, true)
  assert.match(r.message, /聊天白名单：不在/); assert.match(r.message, /旁听只记录之后收到的文字/)
  assert.equal(s.saves(), 0)
})

test('全群总览含非白名单群，不改配置，分页明确且不遗漏', async () => {
  const s = setup({ memory: { passiveGroups: [H] } })
  const joined = Array.from({ length: 23 }, (_, n) => ({ group_id: 30000000 + n, group_name: '测试群 ' + n }))
  joined.push({ group_id: Number(H), group_name: '旁听群' })
  const actions = []
  s.api.core.onebot = { call: async (action, args) => { actions.push(action); assert.deepEqual(args, {}); return [...joined].reverse() } }
  const before = structuredClone(s.cfg())
  const first = await s.tool.execute({ action: 'list' })
  assert.equal(first.ok, true); assert.equal(first.total, 24); assert.equal(first.groups.length, 20)
  assert.equal(first.complete, false); assert.equal(first.next_offset, 20); assert.match(first.message, /还有未列出的群/)
  assert.equal(first.groups.find(g => g.group_id === G).chat_whitelisted, true)
  assert.equal(first.groups[0].chat_whitelisted, false)
  assert.match(s.tool.output.render({ action: 'list' }, first)[0].text, /offset 填 20/, '模型实际读到的文本必须包含下一页参数')
  const last = await s.tool.execute({ action: 'list', offset: first.next_offset })
  assert.equal(last.groups.length, 4); assert.equal(last.complete, true); assert.equal(last.next_offset, null)
  assert.equal(last.groups.find(g => g.group_id === H).memory_scope, 'passive')
  assert.equal(new Set([...first.groups, ...last.groups].map(g => g.group_id)).size, 24)
  assert.deepEqual(actions, ['get_group_list', 'get_group_list'])
  assert.deepEqual(s.cfg(), before); assert.equal(s.saves(), 0)
})
test('全群只读，不接受批量修改、群号 all 或不正确的分页参数', async () => {
  const s = setup(); let calls = 0
  s.api.core.onebot = { call: async () => { calls++; return [] } }
  for (const args of [{ action: 'list', proactive: false }, { action: 'list', group_id: 'all' },
    { action: 'list', offset: -1 }, { action: 'list', offset: '20' }, { action: 'list', offset: 0.5 },
    { action: 'set', group_id: 'all', engaged: false }, { action: 'get' }, { action: 'get', group_id: G, offset: 0 }]) {
    assert.equal((await s.tool.execute(args)).ok, false)
  }
  assert.equal(calls, 0); assert.equal(s.saves(), 0)
  const r = await s.tool.execute({ action: 'list' })
  assert.equal(r.total, 0); assert.equal(r.complete, true); assert.match(r.message, /没有加入任何群/)
})
test('取群列表失败不冒充全群结果、不泄露路径；等待期间撤销权限也不返回列表', async () => {
  const s = setup()
  s.api.core.onebot = { call: async () => { throw new Error('/home/private/config secret') } }
  let r = await s.tool.execute({ action: 'list' })
  assert.equal(r.ok, false); assert.match(r.message, /未完成全群查询/); assert.doesNotMatch(r.message, /home|secret/)
  assert.equal(r.groups, undefined)
  s.api.core.onebot.call = async () => [{ group_id: 'invalid' }]
  assert.equal((await s.tool.execute({ action: 'list' })).ok, false)
  s.api.core.onebot.call = async () => { s.set({ profilePerms: { whitelist: 'off' } }); return [{ group_id: G }] }
  r = await s.tool.execute({ action: 'list' }); assert.equal(r.ok, false); assert.equal(r.groups, undefined)
  assert.equal(s.saves(), 0)
})
