// 记忆页「从其他人格导入」卡片：确认会花 token → 一批批整理（失败只重试那一批）→ 预览勾选、可改字 → 提交勾选的。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'

function loadPanel(routes) {
  const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const marker = '    exports.apply = apply'
  assert.ok(source.includes(marker))
  const script = new Script(source.replace(marker, '    exports.panelTest = { MemoryInherit }\n' + marker), { filename: 'client/client.js' })
  const calls = []
  const env = { answer: true, asked: [] }
  let loader
  script.runInNewContext({
    localStorage: { getItem: () => null, setItem() {} },
    confirm: (text) => { env.asked.push(text); return env.answer },
    fetch: async (url, opts = {}) => {
      const body = opts.body ? JSON.parse(opts.body) : null
      calls.push({ url, body })
      const path = String(url).replace(/^.*\/aurabot\/api/, '')
      return { json: async () => routes(path, body) }
    },
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
  let done = 0
  const st = { personas: [{ id: 'dafeiyu', name: '大肥鱼' }, { id: 'xiaoxing', name: '小星' }], persona: { current: 'xiaoxing', dataOwner: 'dafeiyu', claimPending: false } }
  const render = (over = {}) => { hook = 0; return panelTest.MemoryInherit({ st: { ...st, ...over }, toast: (msg, kind) => toasts.push({ msg, kind }), onDone: () => { done++ } }) }
  return { render, calls, env, toasts, done: () => done }
}

const find = (node, pred) => {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) { for (const n of node) { const hit = find(n, pred); if (hit) return hit } return null }
  if (pred(node)) return node
  return find(node.children, pred)
}
const all = (node, pred, out = []) => {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) all(n, pred, out); return out }
  if (pred(node)) out.push(node)
  all(node.children, pred, out)
  return out
}
const text = (node) => (node == null || node === false ? '' : typeof node !== 'object' ? String(node) : Array.isArray(node) ? node.map(text).join('') : text(node.children))
const button = (tree, label) => find(tree, (n) => n.type?.name === 'Btn' && text(n).includes(label))

const PLAN = { ok: true, from: 'dafeiyu', to: 'xiaoxing', fromName: '大肥鱼', toName: '小星', records: 3, calls: 2, tokens: 3200, batches: [{ kind: 'fact', label: '记忆', part: 1, parts: 1, count: 2 }, { kind: 'profile', label: '人物档案', part: 1, parts: 1, count: 1 }] }
const BATCH0 = { ok: true, results: [
  { id: 'm:a', text: '我是大肥鱼，答应主人六点播报比赛', op: 'rewrite', next: '我答应过主人六点播报比赛', reason: '改人称' },
  { id: 'm:b', text: '大肥鱼说话爱用 hhh', op: 'drop', next: '大肥鱼说话爱用 hhh', reason: '旧人格的口癖' },
] }
const BATCH1 = { ok: true, results: [{ id: 'p:1:text', text: '小王，我的主人', note: '小王的小档案', op: 'keep', next: '小王，我的主人', reason: '和旧人格无关' }] }

test('只有一个人格或者根目录还没认领时不显示', () => {
  const p = loadPanel(() => ({ ok: true }))
  assert.equal(p.render({ personas: [{ id: 'xiaoxing', name: '小星' }] }), null)
  assert.equal(p.render({ persona: { current: 'xiaoxing', claimPending: true } }), null)
})

test('确认框写清会消耗 token；点了取消就不整理', async () => {
  const p = loadPanel((path) => (path === '/memory/inherit/plan' ? PLAN : { ok: true, results: [] }))
  p.env.answer = false
  await button(p.render(), '从这个人格导入').props.onClick()
  assert.match(p.env.asked[0], /把「大肥鱼」的 3 条记忆导入给「小星」/)
  assert.match(p.env.asked[0], /会消耗 token：要调用模型 2 次，粗估约 3k tokens/)
  assert.match(p.env.asked[0], /还没变成记忆，不会被继承/)
  assert.deepEqual(p.calls.map((c) => c.url.replace(/^.*\/aurabot\/api/, '')), ['/memory/inherit/plan'])
})

test('一批批整理：失败停在那一批，重试只重做那一批；预览按块分组、按判定默认勾选，可以改字后提交', async () => {
  let fails = 1
  const p = loadPanel((path, body) => {
    if (path === '/memory/inherit/plan') return PLAN
    if (path === '/memory/inherit/batch') {
      if (body.index === 1 && fails-- > 0) return { ok: false, message: '人物档案这一批没整理成：等太久了' }
      return body.index === 0 ? BATCH0 : BATCH1
    }
    if (path === '/memory/inherit/commit') return { ok: true, message: '继承了 2 条' }
    return { ok: false }
  })
  await button(p.render(), '从这个人格导入').props.onClick()
  let tree = p.render()
  assert.match(text(tree), /人物档案：人物档案这一批没整理成：等太久了/)
  assert.ok(button(tree, '重试这一批'))
  await button(tree, '重试这一批').props.onClick()
  const batches = p.calls.filter((c) => /inherit\/batch$/.test(c.url)).map((c) => [c.body.index, c.body.from, c.body.to])
  assert.deepEqual(batches, [[0, 'dafeiyu', 'xiaoxing'], [1, 'dafeiyu', 'xiaoxing'], [1, 'dafeiyu', 'xiaoxing']], '失败后只重试第二批')

  tree = p.render()
  assert.deepEqual(all(tree, (n) => n.props?.style?.color === 'var(--ab-sub)').map(text), ['记忆', '人物档案'])
  const boxes = all(tree, (n) => n.type === 'input' && n.props.type === 'checkbox')
  assert.deepEqual(boxes.map((b) => b.props.checked), [true, false, true], '改写、原样勾上，丢掉的不勾')
  assert.match(text(tree), /改写｜原文：我是大肥鱼，答应主人六点播报比赛｜改人称/)
  assert.match(text(tree), /小王的小档案｜原样｜和旧人格无关/)
  const edits = all(tree, (n) => n.type === 'input' && n.props.className === 'ab-input')
  edits[0].props.onChange({ target: { value: '我答应过主人每天六点播报比赛' } })
  tree = p.render()
  assert.match(text(button(tree, '存进记忆库')), /2 条/)
  await button(tree, '存进记忆库').props.onClick()
  const commit = p.calls.find((c) => /inherit\/commit$/.test(c.url)).body
  assert.deepEqual(commit, { from: 'dafeiyu', to: 'xiaoxing', items: [{ id: 'm:a', text: '我答应过主人每天六点播报比赛' }, { id: 'p:1:text', text: '小王，我的主人' }] })
  assert.deepEqual(p.toasts.at(-1), { msg: '继承了 2 条', kind: 'ok' })
  assert.equal(p.done(), 1, '存完刷新记忆列表')
  assert.equal(button(p.render(), '存进记忆库'), null, '存完预览收起')
})

test('整理中点取消：后面的批次不再请求', async () => {
  let release
  const p = loadPanel((path) => {
    if (path === '/memory/inherit/plan') return PLAN
    if (path === '/memory/inherit/batch') return new Promise((r) => { release = () => r(BATCH0) })
    return { ok: true }
  })
  const running = button(p.render(), '从这个人格导入').props.onClick()
  await new Promise((r) => setTimeout(r, 0))
  const tree = p.render()
  assert.match(text(tree), /整理中 记忆（1 \/ 2）/)
  assert.ok(find(tree, (n) => n.props?.className === 'ab-progress'))
  button(tree, '取消').props.onClick()
  release()
  await running
  assert.equal(p.calls.filter((c) => /inherit\/batch$/.test(c.url)).length, 1)
  assert.equal(button(p.render(), '存进记忆库'), null)
})
