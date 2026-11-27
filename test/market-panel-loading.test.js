import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'

const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
const exportMarker = '    exports.apply = apply'
const marketPath = '/aurabot/api/modules/community?view=panel'
const registryPath = '/aurabot/api/panel/market/registry'
const progressPath = '/aurabot/api/modules/community/progress'
const logPath = '/aurabot/api/logs?limit=400&level=info&area='
const defaultSource = 'https://raw.githubusercontent.com/aureth-labs/dsh-aurabot-qq-mods/registry/index.json'
const list = [{ id: 'example', name: '示例模块', version: '1.0.0' }]
const reply = (data) => ({ json: async () => ({ ok: true, ...data }) })
const flush = () => new Promise(setImmediate)

function panelHarness(fetcher) {
  const intervals = new Set()
  const visibilityListeners = new Set()
  const document = {
    visibilityState: 'visible',
    addEventListener(event, listener) { if (event === 'visibilitychange') visibilityListeners.add(listener) },
    removeEventListener(event, listener) { if (event === 'visibilitychange') visibilityListeners.delete(listener) },
  }
  const requests = []
  let loader
  let current
  const sameDeps = (before, after) => before && after && before.length === after.length
    && before.every((value, i) => Object.is(value, after[i]))
  const React = {
    Component: class {},
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(initial) {
      const view = current
      const i = view.cursor++
      const slot = view.hooks[i] ||= { value: typeof initial === 'function' ? initial() : initial }
      return [slot.value, next => {
        if (!view.mounted) { view.lateUpdates++; return }
        slot.value = typeof next === 'function' ? next(slot.value) : next
      }]
    },
    useRef(initial) { return current.hooks[current.cursor++] ||= { current: initial } },
    useCallback(fn, deps) {
      const view = current
      const i = view.cursor++
      if (!sameDeps(view.hooks[i]?.deps, deps)) view.hooks[i] = { fn, deps }
      return view.hooks[i].fn
    },
    useEffect(fn, deps) {
      const view = current
      const i = view.cursor++
      const prev = view.hooks[i]
      if (sameDeps(prev?.deps, deps)) return
      view.pending.push(() => {
        prev?.cleanup?.()
        view.hooks[i] = { deps, cleanup: fn() }
      })
    },
  }
  assert.ok(source.includes(exportMarker))
  new Script(source.replace(exportMarker, '    exports.marketHarness = { Market, Logs }\n' + exportMarker)).runInNewContext({
    window: { __ModuleLoader__: { load(value) { loader = value } } },
    document,
    AbortController, setTimeout, clearTimeout,
    setInterval(fn) { intervals.add(fn); return fn },
    clearInterval(fn) { intervals.delete(fn) },
    fetch(url, opts) { requests.push({ url, ...opts }); return fetcher(url, opts) },
  })
  const components = loader.factory(() => React).marketHarness
  function mount(name, { st = { modules: [] }, toast = () => {}, reload = () => {} } = {}) {
    const view = { hooks: [], cursor: 0, pending: [], mounted: true, lateUpdates: 0 }
    const draw = () => {
      current = view
      view.cursor = 0
      const tree = components[name]({ st, toast, reload })
      current = null
      for (const effect of view.pending.splice(0)) effect()
      return tree
    }
    const unmount = () => {
      if (!view.mounted) return
      view.mounted = false
      for (const hook of view.hooks) hook?.cleanup?.()
    }
    draw()
    return { draw, unmount, view }
  }
  return {
    requests, mount, poll: () => [...intervals].forEach(fn => fn()),
    visibility(value) { document.visibilityState = value; for (const fn of visibilityListeners) fn() },
  }
}

function findChild(tree, predicate) {
  if (!tree || typeof tree !== 'object') return
  if (!Array.isArray(tree) && predicate(tree)) return tree
  for (const child of Array.isArray(tree) ? tree : [...(tree.children || []), tree.props?.right]) {
    const match = findChild(child, predicate)
    if (match) return match
  }
}

const button = (tree, label) => findChild(tree, node => node.props?.onClick && node.children.includes(label))
const contents = (tree) => JSON.stringify(tree)

test('市场先显示索引，再补下载次数，已完成后不重复查询列表', async t => {
  const responses = [
    { index: { loading: true, cached: false }, downloads: {}, list: [] },
    { index: { loading: false, cached: true }, downloads: { loading: true }, list },
    { index: { loading: false, cached: true }, downloads: { loading: false }, list: [{ ...list[0], downloads: 8 }] },
  ]
  const app = panelHarness(async (url) => {
    if (url === marketPath) return reply(responses.shift())
    if (url === registryPath) return reply({ registryUrl: defaultSource })
    assert.equal(url, progressPath)
    return reply({ progress: null })
  })
  const market = app.mount('Market')
  t.after(market.unmount)
  await flush()
  const cold = contents(market.draw())
  assert.match(cold, /正在读取模块列表/)
  assert.doesNotMatch(cold, /市场里还没有模块/)
  app.poll()
  await flush()
  const indexed = contents(market.draw())
  assert.match(indexed, /示例模块/)
  assert.match(indexed, /正在更新下载次数/)
  app.poll()
  await flush()
  const filled = contents(market.draw())
  assert.match(filled, /下载 8 次/)
  assert.doesNotMatch(filled, /正在更新下载次数/)
  app.poll()
  await flush()
  assert.equal(app.requests.filter(r => r.url === marketPath).length, 3)
})

test('市场同源刷新保留列表，保存另一索引源后立即清除旧列表', async t => {
  let forced = 0
  const app = panelHarness(async (url, opts) => {
    if (url === marketPath) return reply({ index: { cached: true }, list })
    if (url === marketPath + '&force=1') {
      forced++
      return reply(forced < 2
        ? { index: { cached: true, loading: true }, list }
        : { index: { cached: false, loading: true }, list: [] })
    }
    if (url === registryPath) {
      return reply({ registryUrl: opts.method === 'POST' ? JSON.parse(opts.body).registryUrl : defaultSource })
    }
    assert.equal(url, progressPath)
    return reply({ progress: null })
  })
  const market = app.mount('Market')
  t.after(market.unmount)
  await flush()
  button(market.draw(), '刷新').props.onClick()
  await flush()
  assert.match(contents(market.draw()), /示例模块/)
  const sourceSelect = findChild(market.draw(), node => node.props?.['aria-label'] === '模块市场索引源')
  sourceSelect.props.onChange({ target: { value: 'gitee' } })
  await button(market.draw(), '保存地址').props.onClick()
  await flush()
  const changed = contents(market.draw())
  assert.match(changed, /正在读取模块列表/)
  assert.doesNotMatch(changed, /示例模块/)
  assert.equal(forced, 2)
})

test('窗口快速隐藏再恢复后重新读取市场地址', async t => {
  const first = Promise.withResolvers()
  const gitee = 'https://raw.giteeusercontent.com/aureth-labs/dsh-aurabot-qq-mods/raw/registry/index.json'
  let reads = 0
  const app = panelHarness(async url => {
    if (url === registryPath) return ++reads === 1 ? first.promise : reply({ registryUrl: gitee })
    return reply({})
  })
  const market = app.mount('Market')
  t.after(market.unmount)
  await flush()
  app.visibility('hidden')
  app.visibility('visible')
  assert.equal(app.requests.find(r => r.url === registryPath).signal.aborted, true)
  first.resolve(reply({ registryUrl: defaultSource }))
  await flush()
  app.poll()
  await flush()
  const source = findChild(market.draw(), node => node.props?.['aria-label'] === '模块市场索引源')
  assert.equal(source.props.value, 'gitee')
  app.poll()
  await flush()
  assert.equal(reads, 2)
})

test('市场地址读取失败后停止轮询，重新进入市场时再读', async t => {
  for (const [name, fail] of [
    ['接口返回失败', () => reply({ ok: false })],
    ['网络错误', () => { throw new Error('网络错误') }],
  ]) {
    await t.test(name, async t => {
      const app = panelHarness(async url => {
        if (url === registryPath) return fail()
        return reply({})
      })
      const market = app.mount('Market')
      t.after(market.unmount)
      await flush()
      app.poll()
      await flush()
      app.visibility('hidden')
      app.visibility('visible')
      app.poll()
      await flush()
      const count = () => app.requests.filter(r => r.url === registryPath).length
      assert.equal(count(), 1)

      market.unmount()
      const reopened = app.mount('Market')
      t.after(reopened.unmount)
      await flush()
      assert.equal(count(), 2)
    })
  }
})

test('读取模块列表失败时提示使用现有的刷新按钮', async t => {
  const app = panelHarness(async url => {
    if (url === marketPath) return reply({ index: { failed: true, message: '读取超时' }, list: [] })
    if (url === marketPath + '&force=1') return reply({ index: { cached: true }, list })
    return reply({})
  })
  const market = app.mount('Market')
  t.after(market.unmount)
  await flush()
  const failed = market.draw()
  assert.match(contents(failed), /点击上方「刷新」可重新读取/)
  app.poll()
  await flush()
  assert.equal(app.requests.filter(r => r.url === marketPath).length, 1)
  button(failed, '刷新').props.onClick()
  await flush()
  assert.match(contents(market.draw()), /示例模块/)
})

test('离开市场会取消尚未返回的市场请求，日志请求可独立完成', async t => {
  const pending = Promise.withResolvers()
  const app = panelHarness((url) => {
    if (url === logPath) return Promise.resolve(reply({ entries: [] }))
    assert.ok([marketPath, registryPath, progressPath].includes(url), url)
    // 模拟请求实现没有处理取消，返回结果也不能再写入卸载的市场组件。
    return pending.promise
  })
  const market = app.mount('Market')
  t.after(market.unmount)
  await flush()
  const marketRequests = app.requests.filter(r => [marketPath, registryPath, progressPath].includes(r.url))
  assert.equal(marketRequests.length, 3)
  market.unmount()
  assert.ok(marketRequests.every(req => req.signal.aborted))
  const logs = app.mount('Logs')
  t.after(logs.unmount)
  await flush()
  assert.match(contents(logs.draw()), /没有符合条件的日志/)
  pending.resolve(reply({ index: { loading: true }, list, progress: { stage: 'index' } }))
  await flush()
  app.poll()
  await flush()
  assert.equal(app.requests.filter(r => r.url === marketPath).length, 1)
  assert.equal(market.view.lateUpdates, 0)
})
