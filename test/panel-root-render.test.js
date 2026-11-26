// AurabotPage 整树渲染回归（2026-11-16 dev 线白屏事故固化）
//
// 事故：draftBaseRef 声明在移植 dev 线时丢失，白屏——但各页组件级单测全绿，
// 因为它们只渲染页组件、从不挂载根组件 AurabotPage、不走 ready 分支。
// 本文件用「vm 跑真 client.js + 假 React 直接实调 AurabotPage()」把根组件两帧都盖住：
//   ① 首帧（!ready 骨架）：不抛异常、返回元素树；
//   ② 灌入 st/draft/boot 并把 ready 槽位置真后复渲染：整树无 ReferenceError/TypeError
//     （抓「声明/引用丢失但单测全绿」的根组件级回归）；
//   ③ 关键页签逐个切一遍（概览/语音/记忆/内容平台/管理功能），防页面级挂载回归。
//
// hook 槽位说明：假 React 的 state 数组与 hook 声明顺序一一对应，AurabotPage 的
// st=0、err=1、draft=2、tab=3、…、boot=9、bootErr=10、ready=11（persona-panel 旧用例
// 用 state[3] 断言 tab 也印证这个顺序）。用例里先做槽位哨兵校验，结构变了会明确报错。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'

const CLIENT = () => readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

// ---- 假 React：state 跨渲染保留（驱动 ready 用），hook 序号每次渲染归零 ----
function makeReact() {
  let hook = 0
  const state = []
  return {
    state,
    reset() { hook = 0 },
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    Fragment: 'fragment',
    Component: class {},
    useState(initial) {
      const i = hook++
      if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial
      return [state[i], (value) => { state[i] = typeof value === 'function' ? value(state[i]) : value }]
    },
    useEffect(fn) { try { fn() } catch (e) {} }, // 真跑副作用（首轮加载/轮询都从这里出发）
    useRef: (v) => ({ current: v === undefined ? null : v }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
}

// ---- 加载 client.js：stub fetch/localStorage/document/AbortController 等 ----
function loadPanel() {
  const source = CLIENT()
  const marker = '    exports.apply = apply'
  assert.ok(source.includes(marker), 'client.js 的导出锚点变了，测试要跟着改')
  const inject = '    exports.panelTest = { AurabotPage, TABS }\n' + marker
  const script = new Script(source.replace(marker, inject), { filename: 'client/client.js' })
  const store = new Map()
  const calls = []
  const intervals = []
  const timeouts = []
  const React = makeReact()
  const env = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    fetch: async (url, opts = {}) => {
      calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null })
      return { json: async () => ({ ok: true }) }
    },
    window: { __ModuleLoader__: { load(value) { env.loader = value } } },
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }), body: { appendChild() {} } },
    AbortController: class { constructor() { this.signal = { aborted: false, addEventListener() {}, removeEventListener() {} } } abort() { this.signal.aborted = true } },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length },
    clearInterval: () => {},
    setTimeout: (fn) => { timeouts.push(fn); return timeouts.length },
    clearTimeout: () => {},
    requestAnimationFrame: () => 0,
    confirm: () => true,
  }
  script.runInNewContext(env)
  assert.ok(env.loader, 'client.js 没有走 ModuleLoader.load')
  const { panelTest } = env.loader.factory(() => React)
  // 展开函数组件（React 语义：children 在 props.children 里）
  const expand = (node, depth = 0) => {
    if (node == null || typeof node !== 'object' || depth > 24) return node
    if (Array.isArray(node)) return node.map((n) => expand(n, depth))
    if (typeof node.type === 'function') {
      // class 组件（DSH 的 TabBoundary 等）不展开：无法用 hooks 模拟实例化，浅保留即可
      if (/^\s*class\s/.test(String(node.type))) return node
      const kids = [].concat(node.children ?? []).filter((c) => c !== undefined)
      const merged = Object.assign({}, node.props, kids.length || !node.props.children ? { children: kids.length ? kids : node.props.children } : {})
      return expand(node.type(merged), depth + 1)
    }
    return { type: node.type, props: node.props, children: expand(node.children, depth) }
  }
  const render = (comp, props) => {
    React.reset()
    calls.length = 0
    const raw = comp ? panelTest[comp](props || {}) : panelTest.AurabotPage()
    return { raw, tree: expand(raw) }
  }
  return { panelTest, React, state: React.state, render, calls, store, intervals, timeouts, env }
}

const text = (node) => (node == null || node === false || node === true ? '' : typeof node !== 'object' ? String(node) : Array.isArray(node) ? node.map(text).join('') : text(node.children))

// ---- ready 分支要用的最小状态 ----
const PERSONAS = [{ id: 'dafeiyu', name: '大肥鱼', tags: [] }]
const minimalSt = {
  ok: true,
  config: {
    enabled: true, dryRun: true, debug: false, safeMode: false, setupDone: true,
    persona: { current: 'dafeiyu' }, personas: PERSONAS,
    allow: { private: [], groups: [] },
    voice: { enabled: true, engine: 'windows' }, stickers: { enabled: true }, imageGen: { enabled: false },
    memory: {}, snowluma: {}, security: {}, modules: {}, song: {}, diary: {}, speakUp: {}, group: {},
  },
  onebot: { state: 'unconfigured', login: { uin: '20000002', nickname: '大肥鱼' } },
  personas: PERSONAS,
  persona: { current: 'dafeiyu', dataOwner: 'dafeiyu' },
  modules: [
    { id: 'memory', name: '记忆', running: 'builtin', enabled: true, availability: 'ready', platforms: [] },
    { id: 'voice', name: '语音', running: 'builtin', enabled: true, availability: 'ready', platforms: [] },
    { id: 'bili', name: 'B站', running: 'builtin', enabled: true, availability: 'ready', platforms: ['qq'] },
    { id: 'douyin', name: '抖音', running: 'user', enabled: true, availability: 'ready', platforms: [] },
    { id: 'heybox', name: '小黑盒', running: null, enabled: false, availability: 'disabled', platforms: [] },
  ],
  voice: { edgeInstalled: false },
  mood: { label: '开心' },
  snowluma: { installed: false, running: false },
  bridge: { http: false }, backup: {}, browser: {}, usage: {}, approvals: { list: [] }, tasks: [],
  chats: [], channels: [],
  stats: {},
}
const minimalDraft = {
  persona: { current: 'dafeiyu' },
  voice: { enabled: true, engine: 'windows', asr: false, asrApi: {} },
  memory: {}, stickers: {}, imageGen: {}, snowluma: {}, security: {}, modules: {},
  song: {}, diary: {}, speakUp: {}, group: {}, bili: {}, douyin: {}, heybox: {}, video: {}, local: {},
}
const minimalBoot = {
  ok: true, bootId: '00000000-0000-4000-8000-000000000000', version: 'test',
  configRevision: 1, navigationRevision: 1, setupDone: true, modulesReady: true,
  controls: { enabled: true, dryRun: true, debug: false, safeMode: false },
  connections: [{ platform: 'qq', instanceId: 'onebot', enabled: true, stage: 'unconfigured', verified: false, reason: 'gateway_unconfigured', login: null, warmupSeconds: 0 }],
  modules: minimalSt.modules,
}

test('AurabotPage 首帧（!ready 骨架）：不抛异常、返回元素树、渲染加载占位', () => {
  const p = loadPanel()
  const { tree } = p.render()
  assert.ok(tree && typeof tree === 'object' && tree.type, '首帧要返回元素树')
  assert.match(text(tree), /正在读取面板/, '骨架帧要有加载占位文案')
})

// 槽位哨兵：st=0/err=1/draft=2/tab=3/…/boot=9/bootErr=10/ready=11。
// 结构变了这里会先炸，别硬灌错槽位（那会把「白屏级」bug 变成「断言位置」噪音）。
function assertHookLayout(p) {
  const s = p.state
  assert.equal(s.length >= 13, true, `hook 槽位数量变了（现在 ${s.length} 个），测试的灌状态索引要跟着改`)
  assert.equal(typeof s[3], 'string', 'state[3] 应是 tab（字符串）；hook 顺序变了要更新本文件的槽位索引')
  assert.equal(s[9], null, 'state[9] 应是 boot（初始 null）')
  assert.equal(s[10], null, 'state[10] 应是 bootErr（初始 null）')
  assert.equal(s[11], false, 'state[11] 应是 ready（初始 false）')
}

function driveReady(p) {
  assertHookLayout(p)
  p.state[0] = minimalSt   // st
  p.state[2] = minimalDraft // draft
  p.state[9] = minimalBoot  // boot
  p.state[11] = true        // ready
}

test('AurabotPage ready 帧：整树渲染无 ReferenceError/TypeError（抓 draftBaseRef 类根组件回归）', () => {
  const p = loadPanel()
  p.render() // 首帧骨架
  driveReady(p)
  // 关键路径：ready 分支整树展开（含当前页组件），draftBaseRef 丢失时这里精确复现 ReferenceError
  const { tree } = p.render()
  assert.ok(tree && typeof tree === 'object' && tree.type, 'ready 帧要返回元素树')
  const t = text(tree)
  assert.ok(!t.includes('正在读取面板'), 'ready 帧不该还是骨架占位')
  assert.match(t, /大肥鱼/, 'ready 帧要渲染出面板主体（人格名）')
  assert.match(t, /总开关/, 'ready 帧要渲染出概览开关区')
})

test('AurabotPage 关键页签逐个渲染：概览/连接/人格/聊天/模型/语音/记忆/内容平台/管理功能不炸', () => {
  const p = loadPanel()
  p.render()
  driveReady(p)
  for (const tab of ['overview', 'connect', 'character', 'access', 'group', 'model', 'voice', 'memory', 'content', 'manage']) {
    p.state[3] = tab
    const { tree } = p.render()
    assert.ok(tree && typeof tree === 'object' && tree.type, `页签 ${tab} 渲染要返回元素树`)
    assert.ok(text(tree).length > 0, `页签 ${tab} 渲染结果为空，疑似页面级挂载回归`)
  }
})

test('TABS 每个 id 都在 body 映射里有落点（防「映射到不存在组件」回归）', () => {
  const src = CLIENT()
  const p = loadPanel()
  const m = src.match(/const body = curTab\.ext \? ExtPage : \{[\s\S]*?\n *\}\[curTab\.id\]/)
  assert.ok(m, 'body 映射对象结构变了，测试要跟着改')
  const mapBody = m[0]
  for (const t of p.panelTest.TABS) {
    assert.match(mapBody, new RegExp(`\\b${t.id}: [A-Za-z]+`), `TABS 里的 ${t.id} 在 body 映射里没有落点`)
  }
})
