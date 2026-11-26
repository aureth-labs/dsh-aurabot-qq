// 阶段三·分级导航记忆/内容平台整合 回归测试（feat/panel-nav）
//
// 被测（契约与 task-8 一字不差；实现并行，未落地处用 t.skip 守卫，落地后转真断言）：
//   1. TABS：有 {id:'memory',label:'记忆'} 与 {id:'content',label:'内容平台'}；无 persona/bili/douyin/heybox
//      独立页签；TAB_MODS/NAV_GROUPS/NAV_ALIAS 同步；body 映射 memory:MemoryTab、content:ContentTab。
//   2. 记忆双视图：默认「记忆条目」；条目视图无 Persona 组件及其请求；人物视图挂 Persona；
//      aurabot.memory-view 持久化/恢复；旧 persona 页签迁移哨兵一次（tab→memory + memory-view=person）。
//   3. 内容平台三子视图：只挂当前选中平台；默认首个可用平台（boot.modules running）；aurabot.content-view
//      记住上次有效选择、失效回落；旧 bili/douyin/heybox 页签迁移到 content+对应视图。
//   4. 记忆页「更多设置」折叠卡：向量/重排/整理参数在卡内、折叠不渲染 children；
//      聊天流水留存（memory.keepChatlogDays）等原配置键不动。
//   5. mood 仍是独立页签；扩展模块 tab:'persona' 嵌入逻辑不受影响。
//
// 方法：test/panel-stage2.test.js 同款——vm 跑真 client.js + 假 React 渲染树 + 迁移块源码切片沙箱。
// 【坑】改这个文件禁用 pwsh Get-Content/Set-Content 转写（会毁 UTF-8，见 docs/MEMORY.md §3.12），用编辑工具。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'

const CLIENT = () => readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

// ---- 假 React：state 跨渲染保留，hook 序号每次渲染归零；副作用真跑（用于断言请求/轮询） ----
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
  }
}

function loadPanel() {
  const source = CLIENT()
  const marker = '    exports.apply = apply'
  assert.ok(source.includes(marker), 'client.js 的导出锚点变了，测试要跟着改')
  // 组件按「是否已定义」导出：实现未落地时不炸加载，测试侧用 skip 守卫
  const inject = '    exports.panelTest = Object.assign({},\n'
    + '      typeof MemoryTab !== "undefined" && { MemoryTab },\n'
    + '      typeof MemoryPage !== "undefined" && { MemoryPage },\n'
    + '      typeof PersonaMemory !== "undefined" && { PersonaMemory },\n'
    + '      typeof ContentTab !== "undefined" && { ContentTab },\n'
    + '      typeof Card !== "undefined" && { Card },\n'
    + '      { TABS, TAB_MODS, NAV_GROUPS, NAV_ALIAS })\n' + marker
  const script = new Script(source.replace(marker, inject), { filename: 'client/client.js' })
  const store = new Map()
  const calls = []
  let fetchReply = { ok: true }
  const intervals = []
  const React = makeReact()
  const env = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    fetch: async (url, opts = {}) => {
      calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null })
      return { json: async () => fetchReply }
    },
    window: { __ModuleLoader__: { load(value) { env.loader = value } } },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length },
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  }
  script.runInNewContext(env)
  assert.ok(env.loader, 'client.js 没有走 ModuleLoader.load')
  const { panelTest } = env.loader.factory(() => React)
  // 展开函数组件（React 语义：children 在 props.children 里）
  const expand = (node, depth = 0) => {
    if (node == null || typeof node !== 'object' || depth > 32) return node
    if (Array.isArray(node)) return node.map((n) => expand(n, depth))
    if (typeof node.type === 'function') {
      const kids = [].concat(node.children ?? []).filter((c) => c !== undefined)
      const merged = Object.assign({}, node.props, kids.length || !node.props.children ? { children: kids.length ? kids : node.props.children } : {})
      return expand(node.type(merged), depth + 1)
    }
    return { type: node.type, props: node.props, children: expand(node.children, depth) }
  }
  const render = (comp, props, children) => {
    React.reset()
    calls.length = 0
    const merged = children !== undefined ? Object.assign({}, props, { children }) : props
    const raw = panelTest[comp](merged)
    return { raw, tree: expand(raw) }
  }
  return { panelTest, React, render, calls, store, intervals, env, setReply: (r) => { fetchReply = r } }
}

const find = (node, pred) => {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) { for (const n of node) { const hit = find(n, pred); if (hit) return hit } return null }
  if (pred(node)) return node
  return find(node.children, pred)
}
const findAll = (node, pred, out = []) => {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) findAll(n, pred, out); return out }
  if (pred(node)) out.push(node)
  findAll(node.children, pred, out)
  return out
}
const text = (node) => (node == null || node === false || node === true ? '' : typeof node !== 'object' ? String(node) : Array.isArray(node) ? node.map(text).join('') : text(node.children))

// 迁移块提取：扫所有「哨兵 if 块」（哨兵名含数字，如 -v1/-v2），按块体特征挑出目标块再沙箱执行
function findMigrationBlocks(keyword) {
  const src = CLIENT()
  const blocks = src.match(/if \(!localStorage\.getItem\('aurabot\.[a-z0-9-]+'\)\) \{[\s\S]*?\n          \}/g) || []
  return blocks.filter((b) => b.includes(keyword))
}
function migrationBlockOrNull(keyword) {
  const hits = findMigrationBlocks(keyword)
  return hits.length ? hits.at(-1) : null
}
function runBlock(blockText, store) {
  const ls = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  }
  new Script(blockText, { filename: 'migration.js' }).runInNewContext({ localStorage: ls })
}

// ================= 1. 导航常量契约 =================

test('TABS：有 memory=记忆 与 content=内容平台；无 persona/bili/douyin/heybox 独立页签；mood 保留', () => {
  const { panelTest } = loadPanel()
  const ids = panelTest.TABS.map((t) => t.id)
  assert.ok(ids.includes('memory'), 'TABS 要有 memory')
  assert.equal(panelTest.TABS.find((t) => t.id === 'memory').label, '记忆')
  assert.ok(ids.includes('content'), 'TABS 要有 content（内容平台）')
  assert.equal(panelTest.TABS.find((t) => t.id === 'content').label, '内容平台')
  for (const gone of ['persona', 'bili', 'douyin', 'heybox']) {
    assert.ok(!ids.includes(gone), `TABS 不能再有独立页签 ${gone}`)
  }
  assert.ok(ids.includes('mood'), 'mood 必须仍是独立页签')
})

test('TAB_MODS：persona/douyin/heybox 键删除；memory 归到 memory 模块；content 归三个平台模块', () => {
  const { panelTest } = loadPanel()
  for (const gone of ['persona', 'douyin', 'heybox']) {
    assert.ok(!Object.hasOwn(panelTest.TAB_MODS, gone), `TAB_MODS 要删掉 ${gone} 键`)
  }
  assert.ok(panelTest.TAB_MODS.memory.includes('memory'), 'memory 页挂在 memory 模块上')
  assert.ok(panelTest.TAB_MODS.memory.includes('persona'), '人物画像（persona 模块）归到 memory 页')
  if (panelTest.TAB_MODS.content) {
    for (const m of ['bili', 'douyin', 'heybox']) {
      assert.ok(panelTest.TAB_MODS.content.includes(m), `content 页要挂平台模块 ${m}`)
    }
  }
  assert.ok(panelTest.TAB_MODS.mood.includes('mood'), 'mood 页保持不变')
})

test('NAV_GROUPS：persona/bili/douyin/heybox 从所有分组消失；memory 保留、content 进组', () => {
  const { panelTest } = loadPanel()
  const grouped = panelTest.NAV_GROUPS.flatMap((g) => g.tabs)
  for (const gone of ['persona', 'bili', 'douyin', 'heybox']) {
    assert.ok(!grouped.includes(gone), `分组里不能再有 ${gone}`)
  }
  assert.ok(grouped.includes('memory'), 'memory 要在某个分组里')
  const src = CLIENT()
  if (!src.includes("id: 'content'")) return
  assert.ok(grouped.includes('content'), 'content 要在某个分组里')
})

test('NAV_ALIAS：persona/douyin/heybox 别名键删除；人物关键词并入 memory；content 有自己的别名', () => {
  const { panelTest } = loadPanel()
  for (const gone of ['persona', 'douyin', 'heybox']) {
    assert.ok(!Object.hasOwn(panelTest.NAV_ALIAS, gone), `NAV_ALIAS 要删掉 ${gone} 别名`)
  }
  assert.match(panelTest.NAV_ALIAS.memory, /人物|画像/, 'persona 的检索关键词要并入 memory 别名')
  assert.match(panelTest.NAV_ALIAS.memory, /记忆/, 'memory 别名保留原关键词')
  if (panelTest.NAV_ALIAS.content) {
    assert.match(panelTest.NAV_ALIAS.content, /平台|B站|bilibili|抖音|小黑盒/, 'content 别名要覆盖平台检索词')
  }
})

test('body 映射：memory:MemoryTab、content:ContentTab；无 persona:Persona(PersonaMemory)/Bili/Douyin/Heybox 直挂', () => {
  const src = CLIENT()
  assert.match(src, /memory: MemoryTab/, 'memory 页要映射到 MemoryTab 双视图外壳')
  const hasContent = /function ContentTab/.test(src)
  if (hasContent) {
    assert.match(src, /content: ContentTab/, 'content 页要映射到 ContentTab 外壳')
    assert.ok(!/\bbili: Bili\b/.test(src), '不能再直挂 bili: Bili')
    assert.ok(!/\bdouyin: Douyin\b/.test(src), '不能再直挂 douyin: Douyin')
    assert.ok(!/\bheybox: Heybox\b/.test(src), '不能再直挂 heybox: Heybox')
  }
  assert.ok(!/\bpersona: Persona\b/.test(src), '不能再有 persona: Persona 映射')
  assert.ok(!/\bpersona: PersonaMemory\b/.test(src), '不能再有 persona: PersonaMemory 映射')
})

test('mood 独立性：mood 页映射不动；扩展模块 tab:"persona" 嵌入钩子仍在', () => {
  const src = CLIENT()
  assert.match(src, /mood: Mood,/, 'mood 页映射保持原样')
  // 扩展模块声明 tab:'persona' 时仍能嵌进页面（现在应落进 memory 页所在的嵌入逻辑）
  assert.ok(/'persona'/.test(src.slice(src.indexOf('extTabs') - 500, src.indexOf('extTabs') + 1500)) || /tab === 'persona'|tab: 'persona'/.test(src), '扩展模块 tab:"persona" 的嵌入钩子不能被删掉')
})

// ================= 2. 记忆三视图（星图默认 / 记忆条目 / 人物，按需挂载） =================

const memSt = { config: { memory: {} }, modules: [] }
const memDraft = { memory: {}, song: {} }

test('记忆三视图：页签三段（星图第一/记忆条目/人物）；条目视图无 Persona/StarMap、无 persona 与星图请求', (t) => {
  const p = loadPanel()
  if (!p.panelTest.MemoryTab) return t.skip('MemoryTab 未落地（task-8 进行中）')
  const { raw, tree } = p.render('MemoryTab', { memoryView: 'entries', setMemoryView() {}, st: memSt, draft: memDraft, setDraft() {}, toast() {}, go() {} })
  const tabs = findAll(tree, (n) => n.props && n.props.role === 'tab')
  assert.deepEqual(tabs.map((x) => text(x)), ['星图', '记忆条目', '人物'], '记忆页要有三段子视图页签（星图默认排第一）')
  assert.equal(tabs[1].props['aria-selected'], true, 'entries 视图下「记忆条目」选中')
  // 条目视图：星图与人物都不挂载（raw 里按函数名找）
  assert.ok(!find(raw, (n) => n.type?.name === 'PersonaMemory'), '条目视图不能挂 PersonaMemory')
  assert.ok(!find(raw, (n) => n.type?.name === 'StarMap'), '条目视图不能挂 StarMap')
  // 无 persona 与星图请求（/memories 是条目自己的，允许）
  const extraCalls = p.calls.filter((c) => /\/persona|\/memory\/graph/.test(c.url))
  assert.equal(extraCalls.length, 0, `条目视图发了越界请求：${extraCalls.map((c) => c.url).join(',')}`)
  void tree
})

test('记忆三视图：人物视图挂 PersonaMemory 拉 persona 数据；星图视图挂 StarMap 拉 graph 数据', (t) => {
  const p = loadPanel()
  if (!p.panelTest.MemoryTab) return t.skip('MemoryTab 未落地（task-8 进行中）')
  const { raw } = p.render('MemoryTab', { memoryView: 'person', setMemoryView() {}, st: memSt, draft: memDraft, setDraft() {}, toast() {}, go() {} })
  assert.ok(find(raw, (n) => n.type?.name === 'PersonaMemory'), '人物视图要挂 PersonaMemory')
  assert.ok(!find(raw, (n) => n.type?.name === 'StarMap'), '人物视图不能顺带挂 StarMap')
  assert.ok(p.calls.some((c) => /\/persona/.test(c.url)), '人物视图要拉 persona 数据')
  assert.ok(!p.calls.some((c) => /\/memory\/graph/.test(c.url)), '人物视图不发星图请求')
  const { raw: raw2 } = p.render('MemoryTab', { memoryView: 'starmap', setMemoryView() {}, st: memSt, draft: memDraft, setDraft() {}, toast() {}, go() {} })
  assert.ok(find(raw2, (n) => n.type?.name === 'StarMap'), '星图视图要挂 StarMap')
  assert.ok(!find(raw2, (n) => n.type?.name === 'PersonaMemory'), '星图视图不能顺带挂 PersonaMemory')
  assert.ok(p.calls.some((c) => /\/memory\/graph/.test(c.url)), '星图视图要拉 /memory/graph')
  assert.ok(!p.calls.some((c) => /\/persona/.test(c.url)), '星图视图不发 persona 请求')
})

test('记忆子视图：默认「星图」+ 老值兼容；点「人物」切视图；aurabot.memory-view 持久化与恢复（源码契约）', (t) => {
  const p = loadPanel()
  if (!p.panelTest.MemoryTab) return t.skip('MemoryTab 未落地（task-8 进行中）')
  // 默认视图：starmap（未存过/异常值都落星图）；老值 entries/person 仍兼容
  const src = CLIENT()
  assert.match(src, /memoryView === 'entries' \|\| memoryView === 'person' \? memoryView : 'starmap'/, '视图归一化：entries/person 兼容，其余落默认星图')
  assert.match(src, /return v === 'entries' \|\| v === 'person' \? v : 'starmap'/, 'aurabot.memory-view 恢复时老值兼容，默认星图')
  // 三段页签、点第三个切人物
  const seen = []
  const { tree } = p.render('MemoryTab', { memoryView: 'entries', setMemoryView: (v) => seen.push(v), st: memSt, draft: memDraft, setDraft() {}, toast() {}, go() {} })
  const tabs = findAll(tree, (n) => n.props && n.props.role === 'tab')
  tabs[2].props.onClick()
  assert.deepEqual(seen, ['person'], '点「人物」要切视图')
  tabs[0].props.onClick()
  assert.deepEqual(seen.at(-1), 'starmap', '点「星图」要切回默认视图')
  assert.match(src, /const pickMemoryView = \(v\) => \{ setMemoryView\(v\); try \{ localStorage\.setItem\('aurabot\.memory-view', v\) \} catch \(e\) \{\} \}/, '子视图切换要持久化到 aurabot.memory-view')
})

test('旧 persona 页签迁移：tab→memory + memory-view=person；navlast 修正；哨兵只生效一次', () => {
  const block = migrationBlockOrNull("'persona'")
  if (!block) return // 迁移块未落地：跳过（实现完成后启用）
  const store = new Map([
    ['aurabot.tab', 'persona'],
    ['aurabot.navlast', JSON.stringify({ self: 'persona', system: 'logs' })],
  ])
  runBlock(block, store)
  assert.equal(store.get('aurabot.tab'), 'memory', '旧 persona 页签要迁到 memory')
  assert.equal(store.get('aurabot.memory-view'), 'person', '迁移要顺带记住「人物」子视图')
  const last = JSON.parse(store.get('aurabot.navlast'))
  assert.equal(last.self, 'memory', 'navlast 里的 persona 也要映射成 memory')
  assert.equal(last.system, 'logs', '其它组的记忆不能被动到')
  assert.equal(store.get('aurabot.memory-tab-v1'), '1', '要落哨兵')
  // 哨兵一次：改回旧值再跑，不许再动
  store.set('aurabot.tab', 'overview')
  store.set('aurabot.memory-view', 'entries')
  runBlock(block, store)
  assert.equal(store.get('aurabot.tab'), 'overview', '哨兵生效后不再迁移')
  assert.equal(store.get('aurabot.memory-view'), 'entries', '哨兵生效后不覆盖用户选择')
})

// ================= 3. 内容平台三子视图 =================

const mkMod = (id, patch = {}) => ({ id, name: id, running: null, enabled: true, availability: 'stopped', platforms: [], error: '', ...patch })
const contentDraft = { bili: {}, douyin: {}, heybox: {} }

test('内容平台：只挂当前选中平台；另两个组件不在渲染树、不发请求', (t) => {
  const p = loadPanel()
  if (!p.panelTest.ContentTab) return t.skip('ContentTab 未落地（task-8 进行中）')
  const boot = { modules: [mkMod('bili', { running: 'builtin' }), mkMod('douyin', { running: 'builtin' }), mkMod('heybox', { running: 'builtin' })], connections: [] }
  const { raw } = p.render('ContentTab', { contentView: 'bili', setContentView() {}, boot, st: { modules: [], config: {} }, draft: contentDraft, setDraft() {}, toast() {}, go() {}, reload() {} })
  const names = findAll(raw, (n) => typeof n.type === 'function').map((n) => n.type.name)
  assert.ok(names.some((n) => /Bili/i.test(n)), 'bili 视图要挂 Bili 组件')
  assert.ok(!names.some((n) => /Douyin/i.test(n)), '选中 bili 时不能挂 Douyin')
  assert.ok(!names.some((n) => /Heybox/i.test(n)), '选中 bili 时不能挂 Heybox')
  assert.ok(!p.calls.some((c) => /douyin|heybox/i.test(c.url)), '未选中平台不能发请求')
})

test('内容平台：默认首个可用平台（boot.modules running 判定）', (t) => {
  const p = loadPanel()
  if (!p.panelTest.ContentTab) return t.skip('ContentTab 未落地（task-8 进行中）')
  const base = { st: { modules: [], config: {} }, draft: contentDraft, setDraft() {}, toast() {}, go() {}, reload() {} }
  // douyin 在跑、bili 没跑：默认应选 douyin（首个可用），不是固定 bili
  const boot = { modules: [mkMod('douyin', { running: 'builtin' })], connections: [] }
  const { raw } = p.render('ContentTab', { ...base, boot, contentView: undefined, setContentView() {} })
  const names = findAll(raw, (n) => typeof n.type === 'function').map((n) => n.type.name)
  assert.ok(names.some((n) => /Douyin/i.test(n)), '默认选首个可用平台 douyin')
  assert.ok(!names.some((n) => /Bili/i.test(n)), '不可用的 bili 不默认挂载')
  // 一个都没跑：回落到列表第一个（渲染不炸、有页签）
  const bootNone = { modules: [], connections: [] }
  const { tree } = p.render('ContentTab', { ...base, boot: bootNone, contentView: undefined, setContentView() {} })
  const tabs = findAll(tree, (n) => n.props && n.props.role === 'tab')
  assert.ok(tabs.length >= 3, '三个平台页签都要在')
})

test('内容平台：aurabot.content-view 记住上次选择；存的平台不可用时回落', (t) => {
  const p = loadPanel()
  if (!p.panelTest.ContentTab) return t.skip('ContentTab 未落地（task-8 进行中）')
  const base = { st: { modules: [], config: {} }, draft: contentDraft, setDraft() {}, toast() {}, go() {}, reload() {} }
  // 上次停在 douyin：恢复 douyin
  const bootBoth = { modules: [mkMod('bili', { running: 'builtin' }), mkMod('douyin', { running: 'builtin' })], connections: [] }
  const { raw } = p.render('ContentTab', { ...base, boot: bootBoth, contentView: 'douyin', setContentView() {} })
  const names = findAll(raw, (n) => typeof n.type === 'function').map((n) => n.type.name)
  assert.ok(names.some((n) => /Douyin/i.test(n)), '有效记忆要恢复 douyin')
  assert.ok(!names.some((n) => /Bili/i.test(n)))
  // 记忆的 heybox 没在跑：沿用记忆（标签停在 heybox）但不挂载子组件 —— 2026-11-17 契约变更。
  // 旧契约「回落到首个可用平台」会让用户点未启用的平台被立刻弹回，表现为「按钮点不动」（实际 bug），
  // 所以改为：平台合法就沿用选择，未运行则渲染「这个平台还没启用」提示卡、不挂载子组件（不发请求、不崩）。
  const bootNoHey = { modules: [mkMod('bili', { running: 'builtin' })], connections: [] }
  const { raw: raw2 } = p.render('ContentTab', { ...base, boot: bootNoHey, contentView: 'heybox', setContentView() {} })
  const names2 = findAll(raw2, (n) => typeof n.type === 'function').map((n) => n.type.name)
  assert.ok(!names2.some((n) => /Heybox/i.test(n)), '不可用的记忆平台不能挂载子组件')
  assert.ok(!names2.some((n) => /Bili/i.test(n)), '合法但未运行的记忆平台不该被弹回别的平台（否则就是「点了没反应」）')
  // 真正非法的记忆值（不在三个平台里）才回落首个可用
  const { raw: raw3 } = p.render('ContentTab', { ...base, boot: bootNoHey, contentView: 'not-a-platform', setContentView() {} })
  const names3 = findAll(raw3, (n) => typeof n.type === 'function').map((n) => n.type.name)
  assert.ok(names3.some((n) => /Bili/i.test(n)), '非法记忆值要回落到首个可用平台')
  // 切换持久化（源码契约）
  const src = CLIENT()
  assert.match(src, /localStorage\.setItem\('aurabot\.content-view'/, '平台子视图切换要持久化到 aurabot.content-view')
})

test('内容平台：三个平台页签；点页签切平台视图', (t) => {
  const p = loadPanel()
  if (!p.panelTest.ContentTab) return t.skip('ContentTab 未落地（task-8 进行中）')
  const seen = []
  const boot = { modules: [mkMod('bili', { running: 'builtin' }), mkMod('douyin', { running: 'builtin' }), mkMod('heybox', { running: 'builtin' })], connections: [] }
  const { tree } = p.render('ContentTab', { contentView: 'bili', setContentView: (v) => seen.push(v), boot, st: { modules: [], config: {} }, draft: contentDraft, setDraft() {}, toast() {}, go() {}, reload() {} })
  const tabs = findAll(tree, (n) => n.props && n.props.role === 'tab')
  assert.equal(tabs.length, 3, '要有三个平台页签')
  tabs[1].props.onClick()
  assert.equal(seen.at(-1), 'douyin', '点第二个页签要切到 douyin')
})

test('旧 bili/douyin/heybox 页签迁移：tab→content + 对应视图；navlast 修正；哨兵只生效一次', () => {
  const block = migrationBlockOrNull("'content'")
  if (!block) return // 迁移块尚未落地：跳过（内容平台实现完成后启用）
  for (const [from, view] of [['bili', 'bili'], ['douyin', 'douyin'], ['heybox', 'heybox']]) {
    const store = new Map([
      ['aurabot.tab', from],
      ['aurabot.navlast', JSON.stringify({ express: from, system: 'logs' })],
    ])
    runBlock(block, store)
    assert.equal(store.get('aurabot.tab'), 'content', `${from} 页签要迁到 content`)
    assert.equal(store.get('aurabot.content-view'), view, `${from} 页签迁移要记住对应平台视图`)
    const last = JSON.parse(store.get('aurabot.navlast'))
    assert.equal(last.express, 'content', 'navlast 里的旧平台页签也要映射成 content')
  }
  // 哨兵一次
  const store = new Map([['aurabot.tab', 'bili']])
  runBlock(block, store)
  assert.equal(store.get('aurabot.tab'), 'content')
  store.set('aurabot.tab', 'overview')
  runBlock(block, store)
  assert.equal(store.get('aurabot.tab'), 'overview', '哨兵生效后不再迁移')
})

// ================= 4. 记忆页「更多设置」折叠卡 =================

test('记忆页折叠卡：向量/重排/整理参数收进「高级调优」折叠卡（defaultOpen=false，折叠不渲染 children）', (t) => {
  const src = CLIENT()
  const mp = src.indexOf('function MemoryPage')
  assert.ok(mp >= 0, '要有 MemoryPage')
  // 折叠契约源码：more() 子折叠卡默认不展开（可见区只放少数高频组行，其余全收进来）
  const mpZone = src.slice(mp, mp + 40000)
  assert.match(mpZone, /const more = \(title, items\) => \(items\.length \? h\(Card, \{ title: \(title \|\| '更多设置'\) \+ '（' \+ items\.length \+ ' 项）', collapsible: true, defaultOpen: false/, '折叠卡必须默认不展开')
  // 向量/重排/分层遗忘统一收进「高级调优」折叠卡
  const adv = mpZone.indexOf("more('高级调优'")
  assert.ok(adv >= 0, '要有「高级调优」折叠卡')
  const advBlock = mpZone.slice(adv, adv + 12000)
  assert.match(advBlock, /memory\.vector/, '向量检索参数要收进高级调优折叠卡')
  assert.match(advBlock, /stats\?\.vectorLastError && stats\.vectorLastErrorAt != null[\s\S]*?最近失败[\s\S]*?vectorLastErrorAt[\s\S]*?toLocaleString\(\)[\s\S]*?stats\.vectorLastError/, '向量卡同时显示最近失败原因和时间')
  assert.match(advBlock, /memory\.rerank/, '重排参数要收进高级调优折叠卡')
  assert.match(advBlock, /memory\.retentionBase|分层|遗忘/, '分层遗忘/整理参数要收进高级调优折叠卡')
  // 聊天流水留存等原配置键不动（MemoryPage 区域里，键名没被改名）
  assert.match(mpZone, /memory\.keepChatlogDays/, '聊天流水留存沿用原配置键 memory.keepChatlogDays')
  // 折叠行为渲染断言（复用 Card：折叠时 children 不进树）
  const p = loadPanel()
  if (!p.panelTest.Card) return t.skip('Card 未导出')
  const props = { title: '折叠卡', desc: 'd', collapsible: true, defaultOpen: false }
  let { tree } = p.render('Card', props, '低频参数内容')
  assert.ok(!text(tree).includes('低频参数内容'), '折叠时 children 不能渲染')
  const head = find(tree, (n) => n.type === 'h3')
  head.props.onClick()
  ;({ tree } = p.render('Card', props, '低频参数内容'))
  assert.ok(text(tree).includes('低频参数内容'), '展开后 children 要渲染')
})
