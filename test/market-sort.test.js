// 模块市场排序：最新发布 / 最近更新按索引时间排，缺时间时保持原顺序排最后；纯函数直接单测。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'

function loadMarketTest(marketData) {
  const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const marker = '    exports.apply = apply'
  assert.ok(source.includes(marker), 'client 导出锚点没了，测试注入失败')
  let loader
  new Script(source.replace(marker, '    exports.marketTest = { Market, sortMarketModules, marketTimeOf }\n' + marker)).runInNewContext({
    window: { innerWidth: 1200, __ModuleLoader__: { load: (value) => { loader = value } } },
  })
  const React = {
    Component: class {},
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (initial) => {
      if (initial === null && marketData) {
        const value = marketData
        marketData = undefined
        return [value, () => {}]
      }
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useRef: (initial) => ({ current: initial }),
    useEffect() {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
  return loader.factory(() => React).marketTest
}

const modules = [
  { id: 'old', name: 'Old', downloads: 100, publishedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' },
  { id: 'new', name: 'New', downloads: 1, publishedAt: '2026-11-01T00:00:00Z' },
  { id: 'none', name: 'None', downloads: 50 },
  { id: 'released', name: 'Released', downloads: 10, releasedAt: '2026-10-01T00:00:00Z' },
]

test('最新发布：按 publishedAt 倒序，缺时间的保持原顺序排在最后', () => {
  const { sortMarketModules } = loadMarketTest()
  assert.deepEqual(sortMarketModules(modules, 'latest').map((m) => m.id), ['new', 'released', 'old', 'none'])
})

test('最近更新：updatedAt 优先，其次 publishedAt / Release 时间；缺时间排最后', () => {
  const { sortMarketModules } = loadMarketTest()
  assert.deepEqual(sortMarketModules(modules, 'updated').map((m) => m.id), ['new', 'released', 'old', 'none'])
  const withUpdated = [{ id: 'a', updatedAt: '2026-12-01T00:00:00Z', publishedAt: '2026-01-01T00:00:00Z' }, { id: 'b', publishedAt: '2026-11-01T00:00:00Z' }]
  assert.deepEqual(sortMarketModules(withUpdated, 'updated').map((m) => m.id), ['a', 'b'])
})

test('按热度：下载次数倒序，同分按名字；默认排序完全不改原顺序', () => {
  const { sortMarketModules } = loadMarketTest()
  assert.deepEqual(sortMarketModules(modules, 'hot').map((m) => m.id), ['old', 'none', 'released', 'new'])
  assert.deepEqual(sortMarketModules(modules, 'default').map((m) => m.id), ['old', 'new', 'none', 'released'])
  assert.deepEqual(modules.map((m) => m.id), ['old', 'new', 'none', 'released'], '纯函数不能改原数组')
})

test('时间解析：非法/缺失返回 0，发布日期和 GitHub Release 时间都能用', () => {
  const { marketTimeOf } = loadMarketTest()
  assert.equal(marketTimeOf({}, 'latest'), 0)
  assert.equal(marketTimeOf({ publishedAt: 'not-a-date' }, 'latest'), 0)
  assert.ok(marketTimeOf({ publishedAt: '2026-11-01T00:00:00Z' }, 'latest') > 0)
  assert.ok(marketTimeOf({ releasedAt: '2026-10-01T00:00:00Z' }, 'latest') > 0)
})

test('模块市场首屏挂载完整的筛选结果，一次可以滚动浏览超过 12 个模块', () => {
  const list = Array.from({ length: 16 }, (_, i) => ({ id: `demo-${i}`, name: `模块 ${i}`, version: '1.0.0' }))
  const { Market } = loadMarketTest({ list })
  const tree = Market({ st: { modules: [] } })
  const grid = tree.children.find((child) => child?.props.className === 'ab-grid ab-market-grid')
  assert.ok(grid)
  assert.deepEqual(Array.from(grid.children[0], (item) => item.props.key), list.map((item) => item.id))
  assert.doesNotMatch(JSON.stringify(tree), /上一页|下一页/)
})

test('市场面板源码契约：提供最新发布/最近更新两个排序入口和缺时间提示', () => {
  const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.ok(source.includes("'最新发布'"), '缺「最新发布」排序按钮')
  assert.ok(source.includes("'最近更新'"), '缺「最近更新」排序按钮')
  assert.ok(source.includes('const sortMarketModules = '), '排序逻辑没有抽成纯函数')
  assert.ok(source.includes('个模块没有发布时间/更新时间，按原顺序排在最后'), '缺时间字段退化为原顺序的提示')
  assert.ok(!source.includes('if (hot && canHot) shown.sort(byHot)'), '旧的热度排序内联逻辑没清掉')
})
