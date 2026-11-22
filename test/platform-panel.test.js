// U1：平台页必须同时注册在 TABS、Pages、系统分组和宿主路由里。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
const host = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8')

test('平台页接上了 TABS、组件表和系统分组', () => {
  assert.ok(client.includes("{ id: 'platforms', label: '通讯平台' }"), 'TABS 缺通讯平台页')
  assert.ok(client.includes('platforms: Platforms'), '组件表缺 platforms → Platforms')
  assert.ok(client.includes("tabs: ['platforms', 'model'"), '系统分组缺 platforms')
  assert.ok(client.includes('function Platforms({ st, draft, setDraft, toast, reload, go, openWizard })'), '缺 Platforms 组件')
})

test('连接页改成临时 QQ详细设置，只从 QQ 卡片进入，外置工具排在安全防护前', () => {
  assert.ok(!client.includes("{ id: 'connect', label: '连接QQ' }"), '连接页仍是常驻标签')
  assert.ok(client.includes("label: 'QQ详细设置'"), '临时页未改名为 QQ详细设置')
  assert.ok(client.includes("if (tab === 'connect')"), '详细设置页没有临时插入逻辑')
  assert.ok(client.includes("go('connect')"), 'QQ 卡片没有打开详细设置的入口')
  assert.ok(client.includes("if (id === 'connect') localStorage.removeItem('aurabot.tab')"), '详细设置页不应写入持久 tab')
  assert.ok(client.includes("if (saved === 'connect')"), '刷新时没有把临时详细设置页降级')
  assert.equal((client.match(/go\('connect'\)/g) || []).length, 1, '详细设置页只能从 QQ 卡片进入')
  assert.ok(client.includes("cur.id === 'connect' || last[curGroup.id]"), '导航分组不应记住临时详细设置页')
  assert.ok(client.includes("t.id !== 'connect'"), '重新点系统分组不应自动打开详细设置页')
  const systemTabs = "tabs: ['platforms', 'model', 'access', 'browser', 'tools', 'security'"
  assert.ok(client.includes(systemTabs), '系统页签顺序不是 tools 在 security 前')
  assert.ok(client.includes("right: openWizard ? h(Btn, { small: true, kind: 'ghost', onClick: openWizard }, '重新走一遍设置向导')"), '向导按钮未挂到通讯平台')
  assert.ok(!client.includes("right: openWizard ? h(Btn, { small: true, kind: 'ghost', onClick: openWizard }, '重新走一遍设置向导') : null }, h(GatewayChoice"), '连接页仍挂着向导按钮')
})

test('顶部状态按主平台判断，SnowLuma/OneBot 标签只在 QQ 直连时显示', () => {
  assert.ok(client.includes('const qqDirectEnabled'), '缺少 QQ 直连判断')
  assert.ok(client.includes('const mainConnected = qqDirectEnabled ? qqConnected'), '主平台状态未合并网关 qq')
  assert.ok(client.includes("const backendPill = !qqDirectEnabled"), 'SnowLuma/OneBot 标签没有按 QQ 直连门控')
  assert.ok(client.includes("'OneBot ' + (qqConnected ? '已连接' : '未连接')"), '缺少 OneBot 运行状态标签')
  assert.ok(client.includes("'SnowLuma ' + (sl.installed"), '缺少 SnowLuma 运行状态标签')
})

test('平台页状态每 5 秒自动刷新，旧版能力提示明确', () => {
  assert.ok(client.includes('setInterval(tick, 5000)'), '平台页缺状态轮询')
  assert.ok(client.includes('旧版直连（由 QQ 网关页管理）'), '旧版直连能力提示缺失')
})

test('平台页可以添加尚未配置的平台', () => {
  assert.ok(client.includes("post('/platforms/add'"), '面板缺添加平台请求')
  assert.ok(client.includes("{ title: '添加平台'"), '面板缺添加平台卡片')
  assert.ok(host.includes("route('/platforms/add'"), '宿主缺添加平台路由')
})

test('平台卡片可以移除：启用/连接中禁用，移除前二次确认', () => {
  assert.ok(client.includes("post('/platforms/remove'"), '面板缺移除平台请求')
  assert.ok(client.includes('window.confirm(`确定移除平台'), '移除前缺确认框')
  assert.ok(client.includes("inst.enabled || inst.state === 'connected' || inst.state === 'connecting'"), '启用/连接中未禁用移除')
  assert.ok(host.includes("route('/platforms/remove'"), '宿主缺移除平台路由')
  assert.ok(host.includes("inst.enabled) return { ok: false, message: '先停用这个平台"), '宿主未拒绝启用中的平台')
})

test('平台设置支持 boolean 类型（飞书群消息开关）', () => {
  assert.ok(client.includes("s.type === 'boolean'"), '面板没有把 boolean 渲染成开关')
  assert.ok(host.includes("spec?.type === 'boolean'"), '宿主没有归一化 boolean 设置')
})

test('平台页宿主路由存在', () => {
  for (const route of ['/platforms', '/platforms/add', '/platforms/toggle', '/platforms/remove', '/platforms/settings', '/platforms/people', '/platforms/chats']) {
    assert.ok(host.includes(`route('${route}'`), `缺路由 ${route}`)
  }
})
