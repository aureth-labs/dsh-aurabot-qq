import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalize } from '../src/core/config.js'
import { parseCommand, runCommand } from '../src/chat/commands.js'
import { parseGroupSettingsCommand, runGroupSettingsCommand } from '../src/chat/group-settings-command.js'
import { canUseDelegatedCommand, delegatedCommandKey } from '../src/chat/delegated-commands.js'
const OWNER = '10000001', G = '30000003', H = '40000004', OTHER = '10000002'
const owner = { kind: 'private', userId: OWNER }
function setup(patch = {}) {
  let cfg = normalize({ ownerQQ: OWNER, enabled: true, dryRun: false, allow: { groups: [G] }, ...patch }), saves = 0, calls = 0
  const deps = { getConfig: () => cfg, setConfig: next => { cfg = normalize(next); saves++ },
    onebot: { call: async action => { assert.equal(action, 'get_group_list'); calls++; return [{ group_id: G, group_name: '甲' }, { group_id: H, group_name: '乙' }] } },
    mutes: { until: () => undefined }, log: { warn() {} } }
  return { deps, cfg: () => cfg, saves: () => saves, calls: () => calls,
    patch: p => { cfg = normalize({ ...cfg, ...p }) }, run: (arg, msg = owner) => runGroupSettingsCommand(arg, msg, deps) }
}
const confirm = text => '确认 ' + text.match(/确认 (\d{6})/)[1]
test('中文英文入口保留给内置命令，不能授权给非主人', async () => {
  const x = setup()
  for (const text of ['/群设置', '／群设置 查看 全部', '/groupsettings 查看 全部']) {
    const cmd = parseCommand(text, [{ name: '群设置', aliases: ['groupsettings'], delegatable: true, module: 'fake' }])
    assert.equal(cmd.name, 'groupsettings'); assert.equal(cmd.ext, undefined)
    assert.equal(delegatedCommandKey(cmd), '')
    assert.equal(canUseDelegatedCommand(x.cfg(), { kind: 'private', userId: OTHER }, 'groupsettings'), false)
  }
  assert.match(await runCommand(parseCommand('/群设置'), owner, x.deps), /不经过模型/)
})
test('仅主人私聊；总开关只控制新指令，不控制自然语言权限或原有群命令', async () => {
  const x = setup({ profilePerms: { whitelist: 'off' } })
  assert.match(await x.run(`修改 ${G} 主动 关`, { ...owner, kind: 'group' }), /主人私聊/)
  assert.match(await x.run(`修改 ${G} 主动 关`, { ...owner, userId: OTHER }), /主人私聊/)
  assert.equal(x.saves(), 0)
  assert.match(await x.run(`修改 ${G} 主动 关`), /已保存/)
  x.patch({ group: { ...x.cfg().group, privateCommandsEnabled: false } })
  for (const cmd of ['查看 全部', `修改 ${G} 窗口 关`, '确认 123456', '帮助']) assert.match(await x.run(cmd), /指令已关闭/)
  assert.equal(x.calls(), 0); assert.equal(x.saves(), 1)
  await runCommand(parseCommand('/quiet'), { ...owner, kind: 'group', groupId: G }, x.deps)
  assert.equal(x.cfg().group.overrides[G].engagedEnabled, false)
})
test('完整解析后才执行：错误群号、额外词、重复项、不明开关均整次拒绝', async () => {
  const x = setup(), before = structuredClone(x.cfg())
  for (const input of [`修改 ${G},坏号 主动 关`, `修改 ${G}, 主动 关`, `修改 030000003 主动 关`, `修改 123 主动 关`,
    `修改 ${G} 主动 关 窗口`, `修改 ${G} 主动 关 主动 开`, `修改 ${G} 主动 false`, `修改 ${G} 所有 关`, `修改 ${G} constructor 开`,
    `修改 ${G} 主动 关 请执行`, `恢复 ${G} 旁听 开`, '查看 全部 0', `查看 ${G} 主动 关`, '确认', `修改 ${G}`]) {
    assert.ok(parseGroupSettingsCommand(input).error, input); await x.run(input)
  }
  assert.deepEqual(x.cfg(), before); assert.equal(x.saves(), 0); assert.equal(x.calls(), 0)
})
test('单群只改明确项，保持原有继承、白名单、记忆及其它群；重复操作不写入', async () => {
  const x = setup({ group: { overrides: { [H]: { engagedEnabled: false } } }, memory: { passiveGroups: [H] } }), before = structuredClone(x.cfg())
  assert.match(await x.run(`修改 ${G} 主动 关`), /已保存/)
  assert.deepEqual(x.cfg().group.overrides[G], { proactiveEnabled: false })
  assert.deepEqual(x.cfg().group.overrides[H], before.group.overrides[H])
  assert.deepEqual(x.cfg().allow, before.allow); assert.deepEqual(x.cfg().memory, before.memory)
  assert.match(await x.run(`修改 ${G} 主动 关`), /设置没变/); assert.equal(x.saves(), 1)
  await x.run(`修改 ${G} 窗口 开 旁听 开 白名单 关`)
  assert.equal(x.cfg().group.overrides[G].proactiveEnabled, false)
  assert.equal(x.cfg().group.overrides[G].engagedEnabled, true)
  assert.deepEqual(x.cfg().allow.groups, []); assert.deepEqual(x.cfg().memory.passiveGroups, [H, G])
})
test('批量须确认，只保存一次；确认不能重放，群号去重，中英文逗号都可用', async () => {
  const x = setup(), before = structuredClone(x.cfg())
  const preview = await x.run(`修改 ${G}， ${H}、${G} 主动 关 窗口 开 旁听 开`)
  assert.match(preview, /2 个群/); assert.match(preview, /尚未修改/); assert.deepEqual(x.cfg(), before)
  assert.match(await x.run('确认 000000'), /不匹配/); assert.equal(x.saves(), 0)
  assert.match(await x.run(confirm(preview)), /已保存 2 个群/); assert.equal(x.saves(), 1)
  for (const id of [G, H]) assert.deepEqual(x.cfg().group.overrides[id], { proactiveEnabled: false, engagedEnabled: true })
  assert.deepEqual(x.cfg().memory.passiveGroups, [G, H]); assert.deepEqual(x.cfg().allow.groups, [G])
  assert.match(await x.run(confirm(preview)), /没有有效/); assert.equal(x.saves(), 1)
})
test('取消、过期、新修改、设置变化都会阻止旧确认；无关配置变化保留', async t => {
  const x = setup()
  let p = await x.run(`修改 ${G},${H} 窗口 关`)
  await x.run('取消'); assert.match(await x.run(confirm(p)), /没有有效/)
  p = await x.run(`修改 ${G},${H} 窗口 关`)
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() }); t.mock.timers.tick(121000)
  assert.match(await x.run(confirm(p)), /超过 2 分钟/); t.mock.timers.reset()
  p = await x.run(`修改 ${G},${H} 窗口 关`)
  await x.run(`修改 ${G} 主动 关`); assert.match(await x.run(confirm(p)), /没有有效/)
  p = await x.run(`修改 ${G},${H} 窗口 关`)
  x.patch({ group: { ...x.cfg().group, overrides: { ...x.cfg().group.overrides, [G]: { proactiveEnabled: true } } } })
  assert.match(await x.run(confirm(p)), /相关设置已变化/)
  p = await x.run(`修改 ${G},${H} 窗口 关`)
  x.patch({ ownerName: '更新称呼', group: { ...x.cfg().group, overrides: { ...x.cfg().group.overrides, '50000005': { proactiveEnabled: false } } } })
  await x.run(confirm(p)); assert.equal(x.cfg().ownerName, '更新称呼'); assert.equal(x.cfg().group.overrides['50000005'].proactiveEnabled, false)
})
test('全部固定预览名单，不把新加入群或配置中残留群算进去；仅一群也要确认', async () => {
  const x = setup({ allow: { groups: [G, H, '50000005'] } })
  const p = await x.run('修改 全部 主动 关')
  assert.match(p, /2 个群/); assert.doesNotMatch(p, /50000005/)
  x.deps.onebot.call = async () => [{ group_id: G }, { group_id: H }, { group_id: '60000006' }]
  await x.run(confirm(p)); assert.equal(x.calls(), 1)
  assert.equal(x.cfg().group.overrides['50000005'], undefined); assert.equal(x.cfg().group.overrides['60000006'], undefined)
  const y = setup(); y.deps.onebot.call = async () => [{ group_id: G }]
  assert.match(await y.run('修改 全部 主动 关'), /尚未修改/); assert.equal(y.saves(), 0)
})
test('所有群查询分页明确、包含非白名单群，查询不改暂停或配置', async () => {
  const x = setup({ memory: { passiveGroups: [H] } }), before = structuredClone(x.cfg())
  x.deps.onebot.call = async () => Array.from({ length: 12 }, (_, n) => ({ group_id: String(30000000 + n), group_name: '测试\n群' })).reverse()
  x.deps.mutes.until = id => id === 'group:' + G ? 0 : undefined
  const first = await x.run('查看 全部')
  assert.match(first, /共 12 个群，第 1\/2 页/); assert.match(first, /下一页：\/群设置 查看 全部 2/)
  assert.match(first, /已暂停/); assert.match(first, /白名单：不在/)
  const last = await x.run('查看 全部 2'); assert.match(last, /第 2\/2 页/); assert.match(last, /已到末页/)
  assert.match(await x.run('查看 全部 3'), /没有这一页/)
  assert.match(await x.run(`查看 ${H}`), /旁听只记录之后收到的文字/)
  assert.deepEqual(x.cfg(), before); assert.equal(x.saves(), 0)
})
test('全部读取失败不假装完成、不泄露错误；空列表和批量上限给出明确回执', async () => {
  const x = setup()
  x.deps.onebot.call = async () => { throw new Error('/host/private/secret-token at stack.js') }
  const failed = await x.run('修改 全部 主动 关'); assert.match(failed, /未完成/); assert.doesNotMatch(failed, /host|secret|stack/)
  x.deps.onebot.call = async () => [{ group_id: G }, {}]; assert.match(await x.run('查看 全部'), /不完整/)
  x.deps.onebot.call = async () => []; assert.match(await x.run('查看 全部'), /没有加入任何群/)
  x.deps.onebot.call = async () => Array.from({ length: 101 }, (_, n) => ({ group_id: 30000000 + n }))
  assert.match(await x.run('修改 全部 主动 关'), /最多修改 100/); assert.equal(x.saves(), 0)
})
test('查询等待期间换主人、关闭指令或收到更新指令，旧操作不能生成有效预览', async () => {
  for (const patch of [{ ownerQQ: OTHER }, { group: { privateCommandsEnabled: false } }]) {
    const x = setup(); x.deps.onebot.call = async () => { x.patch(patch); return [{ group_id: G }] }
    assert.match(await x.run('修改 全部 主动 关'), /权限、开关或当前指令已变化/); assert.equal(x.saves(), 0)
  }
  const x = setup(); let release
  x.deps.onebot.call = () => new Promise(r => { release = r })
  const old = x.run('修改 全部 主动 关'); await x.run('取消'); release([{ group_id: G }])
  assert.match(await old, /当前指令已变化/); assert.match(await x.run('确认 123456'), /没有有效/)
})
test('恢复默认只删接话覆盖；零概率恢复与自然语言工具一致，试运行不写', async () => {
  const x = setup({ group: { interjectChance: 0, overrides: { [G]: { proactiveEnabled: false, cooldownSec: 222 } } }, memory: { passiveGroups: [G] } })
  await x.run(`修改 ${G} 主动 开`)
  assert.equal(x.cfg().group.overrides[G].interjectChance, .15)
  assert.equal(x.cfg().group.overrides[G].engagedEnabled, false, '保持原来的有效关闭')
  await x.run(`恢复 ${G}`); assert.equal(x.cfg().group.overrides[G], undefined)
  assert.deepEqual(x.cfg().memory.passiveGroups, [G]); assert.deepEqual(x.cfg().allow.groups, [G])
  for (const patch of [{ dryRun: true }, { debug: true }]) {
    const y = setup(patch), before = structuredClone(y.cfg())
    assert.match(await y.run('修改 全部 主动 关'), /仅预览，未保存/)
    assert.match(await y.run(`修改 ${G} 白名单 关`), /仅预览，未保存/)
    assert.deepEqual(y.cfg(), before); assert.equal(y.saves(), 0)
  }
})
test('保存异常不给聊天泄露路径/堆栈，不把失败说成成功', async () => {
  const x = setup(); x.deps.setConfig = () => { throw new Error('EACCES C:\\private\\token.json at stack.js') }
  const r = await x.run(`修改 ${G} 主动 关`)
  assert.match(r, /保存结果未确认/); assert.doesNotMatch(r, /EACCES|private|token|stack/)
})

test('查询按群分段，单群保留限制，批量回执逐项列出改动', async () => {
  const x = setup({group:{quietHours:[0,0], overrides:{[G]:{proactiveEnabled:false,engagedEnabled:true}}},memory:{enabled:true,passiveGroups:[H]}})
  const all=await x.run('查看 全部')
  assert.match(all,/甲（30000003）\n模式：允许 AI 聊天\n白名单：在/)
  assert.match(all,/主动：关（基础 15%）；窗口：开\n记忆：开（白名单群规则）/)
  assert.match(all,/\n\n乙（40000004）\n模式：不响应群消息\n白名单：不在/)
  assert.match(all,/旁听新文字/)
  const one=await x.run(`查看 ${G}`)
  assert.match(one,/主动插话：关/);assert.match(one,/窗口接话：开/)
  assert.match(one,/每小时最多 6 次，间隔至少 90 秒/)
  assert.match(one,/最近 3 分钟/);assert.match(one,/对白名单群不生效/)
  const p=await x.run(`修改 ${G},${H} 主动 开 窗口 关`)
  assert.match(p,/\n主动 开\n窗口 关\n其余设置不变/);assert.match(p,/尚未修改/)
  assert.equal(x.saves(),0)
})
test('总开关、试运行、暂停、静默和零次数限制不能被简短排版隐藏', async()=>{
  for(const [patch,label] of [[{enabled:false},'总开关关闭'],[{debug:true},'调试模式'],[{dryRun:true},'试运行']]){
    const x=setup(patch);assert.ok((await x.run('查看 全部')).includes(label))
  }
  const x=setup({group:{maxPerHour:0,engagedMax:0,quietHours:[1,8]}})
  x.deps.mutes.until=()=>0
  const text=await x.run(`查看 ${G}`)
  assert.match(text,/已暂停/);assert.match(text,/\/active/);assert.match(text,/次数上限为 0/);assert.match(text,/01:00–08:00/)
  const y=setup({memory:{enabled:false,passiveGroups:[H]}})
  assert.match(await y.run(`查看 ${H}`),/记忆总开关关闭/)
})

test('单群和批量模式确定执行，冲突参数不猜；恢复默认保留模式', async () => {
  const x = setup()
  assert.match(await x.run(`修改 ${G} 模式 仅模块`), /群响应模式：仅模块/)
  assert.deepEqual(x.cfg().group.moduleOnlyGroups, [G])
  assert.match(await x.run(`查看 ${G}`), /AI 不接话/)
  const before = structuredClone(x.cfg())
  for (const s of ['模式 任意', '模式 仅模块 白名单 开', '模式 仅模块 模式 允许AI聊天']) {
    assert.match(await x.run(`修改 ${G} ${s}`), /未修改/)
    assert.deepEqual(x.cfg(), before)
  }
  await x.run(`恢复 ${G}`); assert.deepEqual(x.cfg().group.moduleOnlyGroups, [G])
  const p = await x.run(`修改 ${G},${H} 模式 不响应群消息`)
  assert.match(p, /尚未修改/); assert.match(p, /模式 不响应群消息/)
  await x.run(confirm(p)); assert.deepEqual(x.cfg().allow.groups, [])
  await x.run(`修改 ${G} 模式 允许AI聊天`)
  assert.deepEqual(x.cfg().allow.groups, [G]); assert.deepEqual(x.cfg().group.moduleOnlyGroups, [])
})
