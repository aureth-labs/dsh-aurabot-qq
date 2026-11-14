// U1：平台页必须同时注册在 TABS、Pages、系统分组和宿主路由里。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
const host = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8')

test('平台页接上了 TABS、组件表和系统分组', () => {
  assert.ok(client.includes("{ id: 'platforms', label: '平台' }"), 'TABS 缺平台页')
  assert.ok(client.includes('platforms: Platforms'), '组件表缺 platforms → Platforms')
  assert.ok(client.includes("tabs: ['platforms', 'connect'"), '系统分组缺 platforms')
  assert.ok(client.includes('function Platforms({ st, draft, setDraft, toast, reload, go })'), '缺 Platforms 组件')
})

test('平台页宿主路由存在', () => {
  for (const route of ['/platforms', '/platforms/toggle', '/platforms/settings', '/platforms/people', '/platforms/chats']) {
    assert.ok(host.includes(`route('${route}'`), `缺路由 ${route}`)
  }
})
