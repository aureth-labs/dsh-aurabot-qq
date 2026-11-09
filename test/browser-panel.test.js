// 浏览器页源码契约：页签、组件、路由、全局配置 browser.useDshSidebar 的默认值与归一化都不能丢。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
const config = readFileSync(new URL('../src/core/config.js', import.meta.url), 'utf8')

test('浏览器页接上了页签、导航、组件、路由和脏检查', () => {
  assert.ok(client.includes("{ id: 'browser', label: '浏览器' }"), '缺浏览器页签')
  assert.ok(client.includes("tabs: ['connect', 'model', 'access', 'browser', 'security'"), '浏览器页要注册在系统组（排在安全防护前）')
  assert.ok(client.includes('local: LocalApi, browser: Browser,'), '组件表缺 browser → Browser')
  assert.ok(client.includes('function Browser({ st, draft, setDraft })'), '缺 Browser 组件')
  assert.ok(client.includes("browser: '浏览器 侧边"), '搜索索引缺浏览器关键词')
  assert.ok(client.includes("browser: ['browser']"), '浏览器页的未保存改动没接上')
})

test('全局开关落在 browser 段：默认关 + 归一化补默认值', () => {
  assert.match(config, /browser:\s*\{\s*useDshSidebar:\s*false\s*\}/, 'DEFAULTS 缺 browser.useDshSidebar: false')
  assert.ok(config.includes("c.browser.useDshSidebar = bool(c.browser.useDshSidebar, false)"), '缺 browser.useDshSidebar 归一化')
  assert.ok(config.includes('if (!isObj(c.browser)) c.browser = {}'), '老配置缺 browser 段兜底')
})

test('面板开关改的就是 browser.useDshSidebar，且开关卡片文案齐全', () => {
  const start = client.indexOf('function Browser(')
  const sec = client.indexOf('function Security(')
  assert.ok(start >= 0 && sec > start, '页面组件边界找不到')
  const page = client.slice(start, sec)
  assert.ok(page.includes("draft.browser.useDshSidebar"), '面板没读 browser.useDshSidebar')
  assert.ok(page.includes("'browser.useDshSidebar'"), '面板没写 browser.useDshSidebar')
  assert.ok(page.includes('DSH 侧边浏览器'), '缺「DSH 侧边浏览器」说明文案')
  assert.ok(page.includes('Agent 浏览器'), '缺画面入口（DSH 右侧 Agent 浏览器）提示')
})
