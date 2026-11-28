// WebSocket 令牌清空回归（2026-11-28）
// publicConfig 把 secret 脱敏成空串、用 wsTokenSet 表示“已配置”；mergeFromPanel 约定
// 空串 = 没改（保留旧值），只有显式 null = 清空。因此 UI 必须能生成 null，单靠把输入框删空
// 永远不会清掉已保存的令牌。这里同时锁配置层语义和 OneBotFields 的清空按钮。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Script } from 'node:vm'
import { createFakeDsh } from './helpers/fake-dsh.js'

const CLIENT = () => readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

// ---- 假 React：够跑 OneBotFields / Row / Btn / useField ----
function makeReact() {
  let hook = 0
  const state = []
  return {
    reset() { hook = 0 },
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    Fragment: 'fragment',
    Component: class {},
    useState(initial) {
      const i = hook++
      if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial
      return [state[i], (value) => { state[i] = typeof value === 'function' ? value(state[i]) : value }]
    },
    useEffect(fn) { try { fn() } catch (e) {} },
    useRef: (v) => ({ current: v === undefined ? null : v }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
}

function loadPanel() {
  const source = CLIENT()
  const marker = '    exports.apply = apply'
  assert.ok(source.includes(marker), 'client.js 的导出锚点变了，测试要跟着改')
  const inject = '    exports.panelTest = { OneBotFields, useField }\n' + marker
  const script = new Script(source.replace(marker, inject), { filename: 'client/client.js' })
  const store = new Map()
  const React = makeReact()
  const env = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    fetch: async () => ({ json: async () => ({ ok: true }) }),
    window: { __ModuleLoader__: { load(value) { env.loader = value } } },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  }
  script.runInNewContext(env)
  assert.ok(env.loader, 'client.js 没有走 ModuleLoader.load')
  const { panelTest } = env.loader.factory(() => React)
  return { panelTest, React }
}

const expand = (node, depth = 0) => {
  if (node == null || typeof node !== 'object' || depth > 24) return node
  if (Array.isArray(node)) return node.map((n) => expand(n, depth))
  if (typeof node.type === 'function') {
    const kids = [].concat(node.children ?? []).filter((c) => c !== undefined)
    const props = Object.assign({}, node.props, kids.length || !node.props.children ? { children: kids.length ? kids : node.props.children } : {})
    return expand(node.type(props), depth + 1)
  }
  return { type: node.type, props: node.props, children: expand(node.children, depth) }
}
const findAll = (node, pred, out = []) => {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) findAll(n, pred, out); return out }
  if (pred(node)) out.push(node)
  findAll(node.children, pred, out)
  return out
}
const text = (node) => (node == null || node === false || node === true ? '' : typeof node !== 'object' ? String(node) : Array.isArray(node) ? node.map(text).join('') : text(node.children))

test('配置层：wsToken 空串保留旧值，显式 null 才能清空并持久化', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-ws-token-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  try {
    const { normalize, publicConfig, mergeFromPanel, saveConfig, loadConfig } = await import('../src/core/config.js')
    const cfg = normalize({
      botQQ: '10001',
      ownerQQ: '10002',
      snowluma: { wsUrl: 'ws://127.0.0.1:3001', wsToken: 'old-token', httpToken: 'keep-http' },
    })
    const shown = publicConfig(cfg)
    assert.equal(shown.snowluma.wsToken, '', '面板不应拿到令牌原文')
    assert.equal(shown.snowluma.wsTokenSet, true)
    // 输入框删空 → 空串 = “没改”，旧令牌保留
    assert.equal(mergeFromPanel(cfg, { snowluma: { wsToken: '' } }).snowluma.wsToken, 'old-token')
    // 清空按钮 → null = 明确清空
    const cleared = mergeFromPanel(cfg, { snowluma: { wsToken: null } })
    assert.equal(cleared.snowluma.wsToken, '')
    assert.equal(cleared.snowluma.httpToken, 'keep-http', '其他令牌不被重置')
    assert.equal(cleared.snowluma.wsUrl, 'ws://127.0.0.1:3001', '其他配置不被重置')
    assert.equal(cleared.botQQ, '10001')
    saveConfig(cleared, cfg)
    const reloaded = loadConfig()
    assert.equal(reloaded.snowluma.wsToken, '', '刷新/重读后仍为空')
    assert.equal(publicConfig(reloaded).snowluma.wsTokenSet, false, '刷新后不再显示已配置')
    assert.equal(reloaded.snowluma.httpToken, 'keep-http')
    assert.equal(reloaded.snowluma.wsUrl, 'ws://127.0.0.1:3001')
    assert.equal(reloaded.botQQ, '10001')
  } finally {
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('后端接口：POST /save 传 null 后配置和 /panel/config 都为空，其他字段不变', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-ws-token-api-'))
  const previousData = process.env.AURABOT_DATA_DIR
  const previousWorkspace = process.env.AURABOT_WORKSPACE
  process.env.AURABOT_DATA_DIR = dir
  process.env.AURABOT_WORKSPACE = join(dir, 'workspace')
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    enabled: false, dryRun: true, setupDone: true, ownerQQ: '10000001', botQQ: '20000002',
    snowluma: { autoStart: false, autoAttach: false, dir: join(dir, 'no-snowluma'), wsUrl: 'ws://127.0.0.1:3001', wsToken: 'old-token', httpToken: 'keep-http' },
  }))
  const fake = createFakeDsh({ brain: async () => { throw new Error('保存配置不应开聊天') } })
  const app = (await import('../src/host.js')).apply(fake.ctx)
  await app.ready
  try {
    const saved = await (await fake.call('/save', { snowluma: { wsToken: null } })).json()
    assert.equal(saved.ok, true)
    assert.equal(app.getConfig().snowluma.wsToken, '')
    assert.equal(app.getConfig().snowluma.httpToken, 'keep-http')
    assert.equal(app.getConfig().snowluma.wsUrl, 'ws://127.0.0.1:3001')
    const visible = await (await fake.call('/panel/config')).json()
    assert.equal(visible.config.snowluma.wsToken, '')
    assert.equal(visible.config.snowluma.wsTokenSet, false)
    const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    assert.equal(raw.snowluma.wsToken, '', '落盘配置也应为空')
    assert.equal(raw.snowluma.httpToken, 'keep-http')
  } finally {
    fake.dispose()
    await app.dispose?.()
    if (previousData === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previousData
    if (previousWorkspace === undefined) delete process.env.AURABOT_WORKSPACE
    else process.env.AURABOT_WORKSPACE = previousWorkspace
    rmSync(dir, { recursive: true, force: true })
  }
})

test('OneBotFields：已配置令牌时显示「清空」按钮，点击把草稿设为 null', async () => {
  const { panelTest } = loadPanel()
  const draft = { snowluma: { wsToken: '', wsTokenSet: true } }
  const updates = []
  const f = panelTest.useField(draft, (next) => updates.push(next))
  const tree = expand(panelTest.OneBotFields({ draft, f }))
  const inputs = findAll(tree, (n) => n.type === 'input' && n.props.type === 'password')
  assert.equal(inputs.length, 2, 'OneBotFields 有 WS/HTTP 两个密码框')
  assert.equal(inputs[0].props.placeholder, '已保存')
  const clear = findAll(tree, (n) => n.type === 'button').find((n) => text(n) === '清空')
  assert.ok(clear, '已配置令牌时应显示「清空」按钮')
  await clear.props.onClick()
  assert.equal(updates.length, 1)
  assert.equal(updates[0].snowluma.wsToken, null, '清空动作必须生成 null，空串会被后端当成没改')
})

test('OneBotFields：从未配置令牌时不显示「清空」按钮', () => {
  const { panelTest } = loadPanel()
  const draft = { snowluma: { wsToken: '', wsTokenSet: false } }
  const f = panelTest.useField(draft, () => {})
  const tree = expand(panelTest.OneBotFields({ draft, f }))
  const inputs = findAll(tree, (n) => n.type === 'input' && n.props.type === 'password')
  assert.equal(inputs[0].props.placeholder, '没有就留空')
  assert.equal(findAll(tree, (n) => n.type === 'button').some((n) => text(n) === '清空'), false)
})

test('OneBotFields：清空后仍可撤销（不会把 null 当普通文本）', async () => {
  const { panelTest } = loadPanel()
  const draft = { snowluma: { wsToken: null, wsTokenSet: true } }
  const updates = []
  const f = panelTest.useField(draft, (next) => updates.push(next))
  const tree = expand(panelTest.OneBotFields({ draft, f }))
  const inputs = findAll(tree, (n) => n.type === 'input' && n.props.type === 'password')
  assert.equal(inputs[0].props.value, '')
  assert.equal(inputs[0].props.placeholder, '保存后清空')
  const undo = findAll(tree, (n) => n.type === 'button').find((n) => text(n) === '撤销')
  assert.ok(undo, '清空后应能撤销')
  await undo.props.onClick()
  assert.equal(updates[0].snowluma.wsToken, '')
})
