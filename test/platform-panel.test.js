// U1：平台页必须同时注册在 TABS、Pages、系统分组和宿主路由里。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
const host = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8')

test('平台页接上了 TABS、组件表和系统分组', () => {
  assert.ok(client.includes("{ id: 'platforms', label: '平台' }"), 'TABS 缺平台页')
  assert.ok(client.includes('platforms: Platforms'), '组件表缺 platforms → Platforms')
  assert.ok(client.includes("tabs: ['platforms', 'tools', 'connect'"), '系统分组缺 platforms')
  assert.ok(client.includes('function Platforms({ st, draft, setDraft, toast, reload, go })'), '缺 Platforms 组件')
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

test('平台设置支持 boolean 类型（飞书群消息开关）', () => {
  assert.ok(client.includes("s.type === 'boolean'"), '面板没有把 boolean 渲染成开关')
  assert.ok(host.includes("spec?.type === 'boolean'"), '宿主没有归一化 boolean 设置')
})

test('平台页宿主路由存在', () => {
  for (const route of ['/platforms', '/platforms/add', '/platforms/toggle', '/platforms/settings', '/platforms/people', '/platforms/chats']) {
    assert.ok(host.includes(`route('${route}'`), `缺路由 ${route}`)
  }
})
