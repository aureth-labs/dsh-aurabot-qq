// 总览的认领横幅（#379）：老用户待认领时才出现，选人格、确认后发 /persona/data-owner，认领后消失。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'

function loadPanel() {
  const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const marker = '    exports.apply = apply'
  assert.ok(source.includes(marker))
  const script = new Script(source.replace(marker, '    exports.panelTest = { ClaimBanner }\n' + marker), { filename: 'client/client.js' })
  const calls = []
  const env = { answer: true, reply: { ok: true, message: '认领好了' } }
  let loader
  script.runInNewContext({
    localStorage: { getItem: () => null, setItem() {} },
    confirm: () => env.answer,
    fetch: async (url, opts = {}) => { calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null }); return { json: async () => env.reply } },
    window: { __ModuleLoader__: { load: (value) => { loader = value } } },
  })
  let hook = 0
  const state = []
  const React = {
    Component: class {}, Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (initial) => {
      const i = hook++
      if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial
      return [state[i], (value) => { state[i] = typeof value === 'function' ? value(state[i]) : value }]
    },
    useEffect() {}, useRef: () => ({ current: null }), useCallback: (fn) => fn, useMemo: (fn) => fn(),
  }
  const { panelTest } = loader.factory(() => React)
  const toasts = []
  const render = (st) => { hook = 0; return panelTest.ClaimBanner({ st, toast: (msg, kind) => toasts.push({ msg, kind }) }) }
  return { render, calls, env, toasts, reset: () => { state.length = 0 } }
}

const find = (node, pred) => {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) { for (const n of node) { const hit = find(n, pred); if (hit) return hit } return null }
  if (pred(node)) return node
  return find(node.children, pred)
}
const text = (node) => (node == null || node === false ? '' : typeof node !== 'object' ? String(node) : Array.isArray(node) ? node.map(text).join('') : text(node.children))
const personas = [{ id: 'xiaoxing', name: '小星' }, { id: 'dafeiyu', name: '大肥鱼' }]

test('认领横幅：不待认领时不显示', () => {
  const p = loadPanel()
  assert.equal(p.render({ personas, persona: { current: 'dafeiyu', dataOwner: 'dafeiyu', claimPending: false } }), null)
  assert.equal(p.render({ personas }), null, '老版本的状态里没有 persona 字段也不显示')
})

test('认领横幅：默认选大肥鱼，可以改选，确认后发认领请求，成功后消失', async () => {
  const p = loadPanel()
  const st = { personas, persona: { current: 'xiaoxing', dataOwner: '', claimPending: true } }
  let tree = p.render(st)
  assert.match(text(tree), /升级前攒下的记忆和会话属于哪个人格/)
  const select = find(tree, (n) => n.type === 'select')
  assert.equal(select.props.value, 'dafeiyu', '默认选随插件自带的人格')
  assert.deepEqual(select.children.flat().map((o) => o.props.value), ['xiaoxing', 'dafeiyu'])
  select.props.onChange({ target: { value: 'xiaoxing' } })
  tree = p.render(st)
  assert.equal(find(tree, (n) => n.type === 'select').props.value, 'xiaoxing')

  p.env.answer = false
  await find(tree, (n) => n.type?.name === 'Btn').props.onClick()
  assert.equal(p.calls.length, 0, '确认框点了取消就不认领')

  p.env.answer = true
  await find(tree, (n) => n.type?.name === 'Btn').props.onClick()
  assert.equal(p.calls.length, 1)
  assert.match(p.calls[0].url, /\/persona\/data-owner$/)
  assert.equal(p.calls[0].method, 'POST')
  assert.deepEqual(p.calls[0].body, { id: 'xiaoxing' })
  assert.deepEqual(p.toasts.at(-1), { msg: '认领好了', kind: 'ok' })
  assert.equal(p.render(st), null, '认领成功后横幅消失')
})

test('认领横幅：失败时提示原因，横幅留着', async () => {
  const p = loadPanel()
  p.env.reply = { ok: false, message: '根目录的数据已经认领过了' }
  const st = { personas, persona: { current: 'xiaoxing', dataOwner: '', claimPending: true } }
  await find(p.render(st), (n) => n.type?.name === 'Btn').props.onClick()
  assert.deepEqual(p.toasts.at(-1), { msg: '根目录的数据已经认领过了', kind: 'err' })
  assert.notEqual(p.render(st), null)
})
