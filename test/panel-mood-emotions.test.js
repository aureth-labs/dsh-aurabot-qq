// 面板：心情页 = 单标量心情 + 情绪向量（心情项可配）；目的引擎页不再画心情进度条。
//
// 背景（2026-11-17 合并）：
//   合并前「心情」在两处各画一套（心情页的数值条 / 目的引擎状态卡的十维进度条），
//   两套数据源不同（mood.json 的 value vs purpose-state.json 的 moods）、半衰期也不同（3h vs 写死 6h），
//   用户看到的是「两块心情对不上」。合并后向量归心情模块，面板只在心情页展示一次。
//
// 渲染方式照 panel-stage2.test.js：假 React + 展开函数组件（Card/Row 都是函数组件，
// 不展开就只能拿到 h(Card) 那层壳，文本断言全落空——这坑在写第一版用例时踩过）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'

const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

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
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    memo: (fn) => fn,
  }
}

function loadPanel() {
  const marker = '    exports.apply = apply'
  assert.ok(source.includes(marker), 'client.js 的导出锚点变了，测试要跟着改')
  const script = new Script(
    source.replace(marker, '    exports.panelTest = { Mood, PurposeStatus, EmotionEditor, EMOTION_DEFAULTS, EMOTION_KEY_RE }\n' + marker),
    { filename: 'client/client.js' },
  )
  const calls = []
  let fetchReply = { ok: true }
  const React = makeReact()
  const env = {
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch: async (url, opts = {}) => {
      calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null })
      return { json: async () => fetchReply }
    },
    window: { __ModuleLoader__: { load(value) { env.loader = value } } },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  }
  script.runInNewContext(env)
  assert.ok(env.loader, 'client.js 没有走 ModuleLoader.load')
  const { panelTest } = env.loader.factory(() => React)

  // 展开函数组件：h(Card,…)/h(Row,…) 的 type 是函数，必须真调用一次才有 children 可断言
  const expand = (node, depth = 0) => {
    if (node == null || typeof node !== 'object' || depth > 40) return node
    if (Array.isArray(node)) return node.map((n) => expand(n, depth))
    if (typeof node.type === 'function') {
      const kids = [].concat(node.children ?? []).filter((c) => c !== undefined)
      const merged = Object.assign({}, node.props, kids.length || !node.props.children ? { children: kids.length ? kids : node.props.children } : {})
      return expand(node.type(merged), depth + 1)
    }
    return { type: node.type, props: node.props, children: expand(node.children, depth) }
  }
  const render = (comp, props) => { React.reset(); calls.length = 0; return expand(panelTest[comp](props)) }
  return { panelTest, render, calls, env, React, expand, setReply: (r) => { fetchReply = r } }
}

const text = (node) => (node == null || node === false || node === true ? '' : typeof node !== 'object' ? String(node) : Array.isArray(node) ? node.map(text).join('') : text(node.children))
const findAll = (node, pred, out = []) => {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) findAll(n, pred, out); return out }
  if (pred(node)) out.push(node)
  findAll(node.children, pred, out)
  return out
}

const st = (over = {}) => ({
  ok: true,
  modules: [{ id: 'mood', running: 'builtin' }, { id: 'purpose', running: 'builtin' }, { id: 'memory', running: 'builtin' }],
  mood: {
    value: 72,
    label: '心情不错',
    reason: '主人夸她可爱',
    emotions: { curious: 0.4, amused: 0.7 },
    emotionsAt: Date.now(),
    emotionsItems: [
      { key: 'curious', label: '好奇', icon: '🤔', valence: 0.3, arousal: 0.6, value: 0.4 },
      { key: 'amused', label: '好笑', icon: '😄', valence: 0.6, arousal: 0.7, value: 0.7 },
      { key: 'lonely', label: '寂寞', icon: '😔', valence: -0.6, arousal: 0.3, value: 0 },
    ],
    emotionTop: { key: 'amused', label: '好笑', icon: '😄', value: 0.7 },
  },
  speakUp: { count: 1, reminders: [] },
  purpose: {
    available: true, enabled: true, carrier: 'qq', petFallbackToQQ: true, pacing: 'default',
    dailyMax: 20, quietStart: '23:00', quietEnd: '08:00', awakeFrom: 8, awakeTo: 23,
    status: {
      drives: { connect: 0.4, share: 0.3 },
      // 后端兼容期还可能带旧字段：面板也不该再画它（数据源已换到心情页）
      moods: { lonely: 0.9 },
      lastEmotion: 'lonely', lastEmotionLabel: '寂寞', lastEmotionText: '想你了',
      goals: [], materialCount: 1, observationCount: 0, goalCount: 0, candidateCount: 1,
      countToday: 1, dailyMax: 20, lastOutcome: 'sent', nextFireText: '10 分钟后',
    },
  },
  ...over,
})

const draft = (over = {}) => ({
  mood: { enabled: true, halfLifeHours: 3, base: 60, judge: false, emotions: [] },
  memory: { adaptStyle: true },
  ext: { purpose: { enabled: true } },
  speakUp: {},
  ...over,
})

test('心情页：有「此刻的情绪」卡，逐项画进度条，最强项单独点出来', () => {
  const { render } = loadPanel()
  const tree = render('Mood', { st: st(), draft: draft(), setDraft: () => {}, toast: () => {} })
  const all = text(tree)
  assert.match(all, /此刻的情绪/, '要有情绪卡')
  assert.match(all, /好笑/, '情绪项名字要出现')
  assert.match(all, /好奇/)
  assert.match(all, /寂寞/)
  assert.match(all, /现在最明显/, '最强项要单独点出来')
  assert.match(all, /70%/, '情绪强度按百分比展示')
  const bars = findAll(tree, (n) => n.props && n.props.className === 'ab-mood')
  assert.ok(bars.length >= 3, `至少要画出配置里那几项，实际 ${bars.length}`)
})

test('心情页：心情项卡片就在心情页（折叠卡，标题常显，展开后是编辑器）', () => {
  const { render } = loadPanel()
  const tree = render('Mood', { st: st(), draft: draft(), setDraft: () => {}, toast: () => {} })
  const all = text(tree)
  assert.match(all, /心情项/, '要有「心情项」卡（增删改情绪的入口）')
  assert.match(all, /展开/, '折叠卡未展开时给展开提示——编辑器内容不占版面')
})

test('心情项编辑器：能改名/调正负强弱/增删/恢复出厂（原来这里是写死的十项表）', () => {
  const { panelTest, render } = loadPanel()
  let next = null
  const tree = render('EmotionEditor', {
    value: [
      { key: 'curious', label: '好奇', icon: '🤔', valence: 0.3, arousal: 0.6 },
      { key: 'lonely', label: '寂寞', icon: '😔', valence: -0.6, arousal: 0.3 },
    ],
    onChange: (list) => { next = list },
    disabled: false,
  })
  const all = text(tree)
  for (const label of ['添加一项', '恢复出厂十项', '上移', '下移', '删除', '正负', '强弱']) {
    assert.match(all, new RegExp(label), `编辑器缺少「${label}」`)
  }
  // 正负 / 强弱各一条滑块（每项两条）
  const ranges = findAll(tree, (n) => n.type === 'input' && n.props && n.props.type === 'range')
  assert.equal(ranges.length, 4, '两项 × 正负/强弱 = 4 条滑块')
  // 名字可改：label 输入框绑到了 setItem
  const inputs = findAll(tree, (n) => n.type === 'input' && n.props && typeof n.props.onChange === 'function')
  const nameInput = inputs.find((n) => n.props.value === '好奇')
  assert.ok(nameInput, '找不到名字输入框')
  nameInput.props.onChange({ target: { value: '雀跃' } })
  assert.equal(next[0].label, '雀跃', '改名写回')
  assert.equal(next[1].label, '寂寞', '别的项不动')
  // 出厂十项常量仍在（草稿没值时的兜底）
  assert.equal(panelTest.EMOTION_DEFAULTS.length, 10)
  assert.ok(panelTest.EMOTION_KEY_RE.test('curious'), '键名规则可用')
})

test('心情项编辑器：添加一项会生成唯一键，删除至少留一项', () => {
  const { render } = loadPanel()
  let next = null
  const value = [{ key: 'curious', label: '好奇' }]
  const tree = render('EmotionEditor', { value, onChange: (l) => { next = l }, disabled: false })
  const buttons = findAll(tree, (n) => n.type === 'button')
  const add = buttons.find((n) => text(n.children).includes('添加一项'))
  assert.ok(add, '找不到「添加一项」按钮')
  add.props.onClick()
  assert.equal(next.length, 2)
  assert.equal(new Set(next.map((e) => e.key)).size, 2, '新键不重复')
  assert.ok(next[1].key !== 'curious')
  // 只剩一项时删除按钮被禁用（不能删到 0 项——后端会回落出厂十项，不如从 UI 就拦住）
  const del = buttons.find((n) => text(n.children).includes('删除'))
  assert.equal(del.props.disabled, true, '只剩一项时删除要禁用')
})

test('心情页：情绪数据读 st.mood.emotionsItems，不再读目的引擎的 status.moods', () => {
  const { render } = loadPanel()
  // 目的引擎关掉、但心情模块在跑：情绪条照常显示（这正是不该挂在目的引擎下的理由）
  const tree = render('Mood', {
    st: st({ purpose: { ...st().purpose, enabled: false, status: { ...st().purpose.status, moods: {} } } }),
    draft: draft(),
    setDraft: () => {},
    toast: () => {},
  })
  const all = text(tree)
  assert.match(all, /此刻的情绪/)
  assert.match(all, /好笑/)
})

test('心情页：历史从 /mood/history 拉（/state 已剥掉 history，过去这段渲染不出来）', () => {
  const moodSrc = source.slice(source.indexOf('function Mood('), source.indexOf('function MemoryTab('))
  assert.match(moodSrc, /\/mood\/history/, '心情页要主动拉 /mood/history')
  assert.doesNotMatch(moodSrc, /st\.mood\.history/, '不能再指望 /state 带 history')
})

test('目的引擎页：不再画心情进度条，只留「上一轮的情绪」', async () => {
  const { render, setReply, React, expand, panelTest } = loadPanel()
  // PurposeStatus 挂载时异步拉 /panel/purpose/status，拿到回包才 setD 重渲染；
  // 只渲染一次永远是 null（组件首帧 return null）。这里等微任务跑完再渲染一次。
  setReply({ ok: true, purpose: st().purpose })
  render('PurposeStatus', { toast: () => {}, part: 'view' })
  await new Promise((resolve) => setImmediate(resolve))
  React.reset()
  const all = text(expand(panelTest.PurposeStatus({ toast: () => {}, part: 'view' })))
  assert.doesNotMatch(all, /各种心情现在的强弱/, '旧的心情进度条说明要消失')
  assert.match(all, /寂寞/, '上一轮的瞬时情绪照常显示（提示词/桌宠辉光用）')
  // 驱力条还在（那是目的引擎自己的东西，跟心情无关）
  assert.match(all, /驱力/)
})
