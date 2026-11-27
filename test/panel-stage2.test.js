// 阶段二·分级导航语音试点 回归测试（feat/panel-firstscreen）
//
// 被测：client/client.js 未提交改动（阶段二）：
//   1. TABS 新增 manage 删 asr；TAB_MODS / NAV_GROUPS / NAV_ALIAS 同步。
//   2. 旧页签迁移：aurabot.tab==='asr' → 'voice' + voice-view='listen'；navlast 里 asr 同映射；哨兵只跑一次。
//   3. VoiceTab 子视图：send=Voice、listen=Asr；send 视图不挂载 AsrStatus（ASR 请求与 5 秒轮询为 0）。
//   4. Manage 管理功能页：四类状态分组（ok/blocked/off/absent），启用走 /save，失败就地提示。
//   5. 语音页「更多设置」折叠 Card：defaultOpen=false，折叠不渲染 children。
//
// 手法：persona-claim-panel.test.js 同款——vm 跑真 client.js，注入 panelTest 导出内部组件，
// 假 React 渲染组件树（函数组件会被展开成真实渲染结果）做断言；
// 迁移块直接从源码切片在沙箱里执行（测的是真代码）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'

const CLIENT = () => readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

// ---- 假 React：state 跨渲染保留（模拟重渲染），hook 序号每次渲染归零 ----
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
    // 真跑副作用：才能断言 AsrStatus 的请求/轮询有没有被挂载；环境缺 DOM 时吞掉（不是被测行为）
    useEffect(fn) { try { fn() } catch (e) {} },
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
}

// ---- 加载 client.js，导出内部组件与常量；记录 fetch 与 localStorage ----
function loadPanel() {
  const source = CLIENT()
  const marker = '    exports.apply = apply'
  assert.ok(source.includes(marker), 'client.js 的导出锚点变了，测试要跟着改')
  const script = new Script(
    source.replace(marker, '    exports.panelTest = { TABS, TAB_MODS, NAV_GROUPS, NAV_ALIAS, MANAGE_FEATURES, Manage, VoiceTab, Voice, VoiceServices, VoiceServiceFields, Asr, AsrStatus, Card }\n' + marker),
    { filename: 'client/client.js' },
  )
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
  // 展开函数组件：h(Card,…) 这类节点 type 是函数，要真调用一次才能拿到渲染结果。
  // React 语义：children 既在 rest 参数里、也在 props.children 里——组件一律从 props 解构
  // children，所以调用时要把 kids 合并进 props。照树的先序连续调用（hook 序号保持连续，
  // 与真实单次渲染 pass 一致）。
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
  // 每次渲染：hook 归零、复用 state、清空当次请求记录。
  // 返回 raw（未展开，找 Switch/Btn 这类交互组件用）和 tree（展开后，做文本断言用）。
  const render = (comp, props, children) => {
    React.reset()
    calls.length = 0
    const merged = children !== undefined ? Object.assign({}, props, { children }) : props
    const raw = panelTest[comp](merged)
    return { raw, tree: expand(raw) }
  }
  return { panelTest, React, render, calls, store, intervals, env, setReply: (r) => { fetchReply = r } }
}

// ---- 树工具 ----
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
const featureCard = (tree, label) => find(tree, (n) => typeof n.type === 'string' && n.props && String(n.props.className || '').includes('ab-manage-card') && text(n).includes(label))

// ================= 1. 导航常量契约 =================

test('TABS：有 manage 无 asr；manage 在 home 组、express 组没有 asr；别名吸收 asr 关键词', () => {
  const { panelTest } = loadPanel()
  const ids = panelTest.TABS.map((t) => t.id)
  assert.ok(ids.includes('manage'), 'TABS 要有 manage（管理功能）')
  assert.ok(!ids.includes('asr'), 'TABS 不能再有独立 asr 页')
  const manage = panelTest.TABS.find((t) => t.id === 'manage')
  assert.equal(manage.label, '管理功能')
  assert.ok(!panelTest.TAB_MODS.asr, 'TAB_MODS 要删掉 asr')
  assert.ok(panelTest.TAB_MODS.voice.includes('voice'), 'voice 页还挂在 voice 模块上')

  const home = panelTest.NAV_GROUPS.find((g) => g.id === 'home')
  const express = panelTest.NAV_GROUPS.find((g) => g.id === 'express')
  assert.ok(home.tabs.includes('manage'), 'home 组要收 manage')
  assert.ok(!express.tabs.includes('asr'), 'express 组不能再有 asr')
  assert.ok(express.tabs.includes('voice'), 'express 组保留 voice')
  const grouped = new Set(panelTest.NAV_GROUPS.flatMap((g) => g.tabs))
  assert.ok(grouped.has('manage'), 'manage 必须出现在某个分组里')

  assert.ok(!Object.hasOwn(panelTest.NAV_ALIAS, 'asr'), 'NAV_ALIAS 不能再有 asr 别名')
  assert.match(panelTest.NAV_ALIAS.voice, /语音识别/, 'voice 别名要吸收「语音识别」关键词')
  assert.match(panelTest.NAV_ALIAS.voice, /听语音|转文字|asr/, 'voice 别名要吸收 asr 的检索词')
  assert.match(panelTest.NAV_ALIAS.manage, /管理功能/, 'manage 要有自己的别名')
})

test('语音页注册：curTab.voice 映射到 VoiceTab（不再是裸 Voice），TAB_KEYS 也没有 asr', () => {
  const src = CLIENT()
  assert.match(src, /voice: VoiceTab,/, '页面表里 voice 要映射到 VoiceTab 子视图外壳')
  // 页面表里有 manage 即可（本线 manage 前后夹着 platforms/tools 等特有页，不与 overview 相邻；契约声明取本机）
  assert.match(src, /manage: Manage,/, '页面表里要注册 manage')
  assert.ok(!/\basr: Asr\b/.test(src), '页面表里不能再有 asr: Asr')
  assert.ok(!/TAB_KEYS = \{[^}]*\basr\b/.test(src), 'TAB_KEYS 里不能有 asr')
})

// ================= 2. 旧页签迁移 =================

// 从源码里切出真实的迁移块执行（不是复刻逻辑，是测真代码）
function migrationBlock() {
  const src = CLIENT()
  const m = src.match(/if \(!localStorage\.getItem\('aurabot\.voice-tab-v1'\)\) \{[\s\S]*?\n          \}/)
  assert.ok(m, '找不到 asr→voice 迁移块（源码结构变了，测试要跟着改）')
  return m[0]
}
function runMigration(store) {
  const ls = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  }
  new Script(migrationBlock(), { filename: 'migration.js' }).runInNewContext({ localStorage: ls })
}

test('旧页签迁移：tab=asr → voice + voice-view=listen；navlast 里的 asr 同映射', () => {
  const store = new Map([
    ['aurabot.tab', 'asr'],
    ['aurabot.navlast', JSON.stringify({ home: 'overview', express: 'asr', system: 'logs' })],
  ])
  runMigration(store)
  assert.equal(store.get('aurabot.tab'), 'voice', '旧 asr 页签要迁到 voice')
  assert.equal(store.get('aurabot.voice-view'), 'listen', '迁移要顺带记住「听语音」子视图')
  const last = JSON.parse(store.get('aurabot.navlast'))
  assert.equal(last.express, 'voice', 'navlast 里的 asr 也要映射成 voice')
  assert.equal(last.system, 'logs', '其它组的记忆不能被动到')
  assert.equal(last.home, 'overview')
  assert.equal(store.get('aurabot.voice-tab-v1'), '1', '迁移要落哨兵')
})

test('迁移哨兵只生效一次：第二次执行不再改写（哪怕 tab 又变成 asr 也不动）', () => {
  const store = new Map([['aurabot.tab', 'asr']])
  runMigration(store)
  assert.equal(store.get('aurabot.tab'), 'voice')
  // 模拟用户之后手动把 tab 改回别的值：哨兵在，迁移不许再动
  store.set('aurabot.tab', 'overview')
  store.set('aurabot.voice-view', 'send')
  runMigration(store)
  assert.equal(store.get('aurabot.tab'), 'overview', '哨兵生效后不再迁移')
  assert.equal(store.get('aurabot.voice-view'), 'send', '哨兵生效后不覆盖用户的子视图选择')
})

test('全新用户没有 asr 记忆：迁移不产生 voice-view、只落哨兵', () => {
  const store = new Map()
  runMigration(store)
  assert.equal(store.has('aurabot.tab'), false, '不该替新用户预设页签')
  assert.equal(store.has('aurabot.voice-view'), false, '不该替新用户预设子视图')
  assert.equal(store.get('aurabot.voice-tab-v1'), '1')
})

// ================= 3. VoiceTab 子视图 =================

const voiceSt = { config: { voice: { engine: 'windows' } }, voice: { edgeInstalled: false } }
const voiceDraft = { voice: { engine: 'windows' }, song: {}, modules: {} }

test('VoiceTab：send 视图渲染语音合成页，树里没有 Asr/AsrStatus，不打 ASR 请求、不起 5 秒轮询', () => {
  const p = loadPanel()
  const { tree } = p.render('VoiceTab', { voiceView: 'send', setVoiceView() {}, st: voiceSt, draft: voiceDraft, setDraft() {}, toast() {}, reload() {} })
  const t = text(tree)
  assert.match(t, /说话（文字转语音）/, 'send 视图要有语音合成卡')
  assert.ok(!t.includes('听语音（语音转文字）'), 'send 视图不能渲染 Asr 卡')
  assert.ok(!t.includes('DSH 识别'), 'send 视图不能挂 AsrStatus 状态条')
  // 铁约束是「无 ASR 请求、无 5 秒轮询」（语音页自己的翻唱模型列表请求不算 ASR）
  assert.ok(!p.calls.some((c) => c.url.includes('asr')), `send 视图发了 ASR 请求：${p.calls.map((c) => c.url).join(',')}`)
  assert.equal(p.intervals.filter((i) => i.ms === 5000).length, 0, 'send 视图不能起 5 秒轮询')
})

test('未选 Fish、没有外接模块也可配置 Fish；只看服务不合成、不改来源、不启动识别', () => {
  const p = loadPanel()
  const { tree } = p.render('VoiceTab', { voiceView: 'services', st: voiceSt, draft: voiceDraft,
    setDraft() { assert.fail('查看服务不该改设置') }, setVoiceView() {}, toast() {}, reload() {} })
  const key = find(tree, n => n.props['aria-label'] === 'Fish API Key')
  assert.equal(key?.props.type, 'password')
  assert.ok(text(tree).includes('音色 ID'))
  assert.equal(p.calls.length, 0)
  assert.equal(p.intervals.length, 0)
})

test('扩展服务：服务表单和多账号卡片的 React key 不冲突，切换时不残留旧表单', () => {
  const { panelTest } = loadPanel()
  const draft = { voice: { http: { headers: 'Authorization: Bearer {apiKey}' } } }
  for (const selected of ['fish-free', 'http', 'breeze', 'minimax', 'volcano']) {
    const { children } = panelTest.VoiceServices({ selected, draft })
    const [, form, accounts] = children
    assert.equal(form.children[0].props.id, selected)
    assert.equal(accounts.props.id, selected)
    assert.notEqual(form.props.key, accounts.props.key, selected)
  }
})

test('Breeze 服务的音色在前，签到单独展开；本地模式不出现账户选项', () => {
  for (const mode of ['cloud', 'local']) {
    const p = loadPanel()
    const draft = { ...voiceDraft, voice: { engine: 'breeze', breeze: { mode } } }
    const { raw } = p.render('VoiceServiceFields', { id: 'breeze', st: voiceSt, draft, setDraft() {}, toast() {}, reload() {} })
    const fold = title => find(raw, n => n.type === 'details' && text(n.children[0]) === title)
    assert.ok(fold('Breeze 声音微调'))
    const quota = fold('每日额度与签到')
    if (mode === 'cloud') {
      assert.ok(find(raw, n => n.props?.label === '音色 id'))
      assert.ok(quota && !quota.props.open)
      assert.ok(find(quota, n => n.props?.label === '自动领每日额度'))
      assert.ok(!find(quota, n => n.props?.label === '音色 id'))
    } else {
      assert.equal(quota, null)
      assert.equal(find(raw, n => n.props?.label === '账号密码'), null)
    }
  }
})

test('VoiceTab：listen 视图渲染 Asr（含 AsrStatus，首查 /voice/asr-status，起 5 秒轮询）', () => {
  const p = loadPanel()
  const { tree } = p.render('VoiceTab', { voiceView: 'listen', setVoiceView() {}, st: voiceSt, draft: voiceDraft, setDraft() {}, toast() {}, reload() {} })
  const t = text(tree)
  assert.match(t, /听语音（语音转文字）/, 'listen 视图要有 Asr 卡')
  assert.ok(!t.includes('说话（文字转语音）'), 'listen 视图不该渲染合成设置')
  assert.ok(p.calls.some((c) => c.url.endsWith('/voice/asr-status')), 'AsrStatus 要发 ASR 状态查询')
  assert.ok(p.intervals.some((i) => i.ms === 5000), 'AsrStatus 的 5 秒轮询要在挂载时起')
})

test('VoiceTab：语音子视图页签；点「听语音」切 listen；子视图选择持久化（App 侧源码契约）', () => {
  const p = loadPanel()
  const seen = []
  const { tree } = p.render('VoiceTab', { voiceView: 'send', setVoiceView: (v) => seen.push(v), st: voiceSt, draft: voiceDraft, setDraft() {}, toast() {}, reload() {} })
  const tabs = findAll(tree, (n) => n.props && n.props.role === 'tab')
  assert.deepEqual(tabs.map((t) => text(t)), ['发语音', '听语音', '扩展服务'])
  assert.equal(tabs[0].props['aria-selected'], true, 'send 是当前选中')
  assert.equal(tabs[1].props['aria-selected'], false)
  tabs[1].props.onClick()
  tabs[2].props.onClick()
  assert.deepEqual(seen, ['listen', 'services'])
  // App 侧接线（源码契约）：pickVoiceView 把选择写进 localStorage；初始值从 localStorage 恢复
  assert.match(CLIENT(), /const pickVoiceView = \(v\) => \{ setVoiceView\(v\); try \{ localStorage\.setItem\('aurabot\.voice-view', v\) \} catch \(e\) \{\} \}/, '子视图切换必须持久化到 aurabot.voice-view')
  const readView = /const \[voiceView, setVoiceView\] = useState\(\(\) => (.+)\)/.exec(CLIENT())[1]
  for (const value of ['send', 'listen', 'services', 'invalid']) {
    p.store.set('aurabot.voice-view', value)
    assert.equal(new Script('(() => ' + readView + ')()').runInNewContext(p.env), value === 'invalid' ? 'send' : value)
  }
})

// ================= 4. Manage 管理功能页 =================

const mkMod = (id, patch = {}) => ({ id, name: id, running: null, enabled: true, availability: 'stopped', platforms: [], error: '', ...patch })

test('Manage：四类状态分组（ready / blocked / off / absent）各归其位，文案正确', () => {
  const p = loadPanel()
  const boot = {
    modules: [
      mkMod('voice', { running: 'builtin', availability: 'ready' }),
      mkMod('autotelic', { enabled: true, availability: 'error', error: '启动炸了：boom' }),
      mkMod('stickers', { enabled: false, availability: 'disabled' }),
      mkMod('song', { enabled: true, availability: 'unloaded' }),
    ],
    connections: [{ platform: 'qq' }],
  }
  const st = { modules: [], config: { voice: { enabled: true }, stickers: { enabled: true }, song: {}, speakUp: { enabled: true }, diary: { enabled: true } } }
  const { tree } = p.render('Manage', { st, boot, draft: { modules: {} }, toast() {}, go() {}, reload() {} })
  const t = text(tree)
  assert.match(t, /正常可用/, '要有「正常可用」分组')
  assert.match(t, /需要处理/, '要有「需要处理」分组')
  assert.match(t, /已停用/, '要有「已停用」分组')
  assert.match(t, /未安装/, '要有「未安装」分组')
  // ready：语音 → 可用徽标 + 去设置
  const voiceCard = featureCard(tree, '让她用语音条说话')
  assert.ok(voiceCard, '语音卡片要渲染')
  assert.match(text(voiceCard), /可用/)
  assert.match(text(voiceCard), /去设置/)
  // blocked（error）：自驱 → 受限 + 原因 + 排障按钮
  const autoCard = featureCard(tree, 'v5 重写，实验性功能')
  assert.ok(autoCard, '自驱卡片要渲染')
  assert.match(text(autoCard), /受限/)
  assert.match(text(autoCard), /启动炸了：boom/, 'error 原因要就地显示')
  assert.match(text(autoCard), /看日志排障/)
  // off：表情包 → 已停用徽标
  const stickerCard = featureCard(tree, '会挑合适的表情')
  assert.ok(stickerCard, '表情包卡片要渲染')
  assert.match(text(stickerCard), /已停用/)
  // absent：song 是 unloaded、pet 完全没有 → 未安装 + 去安装
  assert.match(t, /去安装/)
  const petCard = featureCard(tree, '桌面上的悬浮窗形象')
  assert.ok(petCard, '没装的桌宠也要出现在未安装分组')
  assert.match(text(petCard), /未安装/)
})

test('Manage：平台受限（模块声明 platforms 但连接里没有）→ blocked 并说明需要什么平台', () => {
  const p = loadPanel()
  const boot = {
    modules: [mkMod('douyin', { running: 'builtin', availability: 'ready', platforms: ['douyin'] })],
    connections: [{ platform: 'qq' }],
  }
  const { tree } = p.render('Manage', { st: { modules: [], config: {} }, boot, draft: { modules: {} }, toast() {}, go() {}, reload() {} })
  const card = featureCard(tree, '逛 B站 / 抖音 / 小黑盒')
  assert.ok(card, '内容平台卡要渲染')
  assert.match(text(card), /受限/)
  assert.match(text(card), /已启用，但当前连接的平台不支持（需要 douyin）/)
  assert.match(text(card), /看日志排障/)
})

test('Manage：开关走 /save 保存 modules.enabled；失败就地 toast，不刷新；草稿设置要带上', async () => {
  const p = loadPanel()
  const toasts = []
  const reloads = []
  const boot = { modules: [mkMod('stickers', { enabled: false, availability: 'disabled' })], connections: [] }
  const props = { st: { modules: [], config: { stickers: {} } }, boot, draft: { modules: {} }, toast: (msg, kind) => toasts.push({ msg, kind }), go() {}, reload: () => reloads.push(1) }
  let { raw, tree } = p.render('Manage', props)
  const sw = find(raw, (n) => n.type?.name === 'Switch')
  assert.ok(sw, '已停用卡片要有开关')
  assert.equal(sw.props.on, false, '开关初始是关')
  // 成功路径
  await sw.props.onChange(true)
  assert.equal(p.calls.length, 1)
  assert.equal(p.calls[0].method, 'POST')
  assert.match(p.calls[0].url, /\/save$/)
  assert.deepEqual(p.calls[0].body, { modules: { stickers: { enabled: true } } }, '启用要走 /save 的 modules.enabled')
  assert.deepEqual(toasts.at(-1), { msg: '已启用', kind: 'ok' })
  assert.equal(reloads.length, 1, '成功后要刷新导航')
  // 失败路径：错误就地提示（toast err），不 reload
  p.setReply({ ok: false, message: '保存失败：磁盘只读' })
  await sw.props.onChange(true)
  assert.deepEqual(toasts.at(-1), { msg: '保存失败：磁盘只读', kind: 'err' }, '失败原因要就地提示')
  assert.equal(reloads.length, 1, '失败不许刷新')
  // 草稿里已有的模块设置要带上（不丢用户的草稿）
  const props2 = { ...props, draft: { modules: { stickers: { autoChance: 0.5 } } } }
  p.setReply({ ok: true })
  ;({ raw } = p.render('Manage', props2))
  const sw2 = find(raw, (n) => n.type?.name === 'Switch')
  await sw2.props.onChange(true)
  assert.deepEqual(p.calls.at(-1).body, { modules: { stickers: { autoChance: 0.5, enabled: true } } }, '启用要合并草稿里已有的模块设置')
  // 展开
  void tree
})

test('Manage：清单固定 9 项且 key 不重复（MANAGE_FEATURES 契约）', () => {
  const { panelTest } = loadPanel()
  const list = panelTest.MANAGE_FEATURES
  assert.equal(list.length, 9, `管理功能清单应是 9 项，实际 ${list.length}`)
  const keys = list.map((f) => f.key)
  assert.equal(new Set(keys).size, keys.length, 'key 不能重复：' + keys.join(','))
  for (const f of list) assert.ok(f.label && f.desc && f.tab && f.cli, `清单项 ${f.key} 缺 label/desc/tab/cli`)
})

// ================= 5. 语音页「更多设置」折叠 =================

test('折叠契约：语音页低频参数收进 collapsible Card（defaultOpen=false，源码级）', () => {
  const src = CLIENT()
  const start = src.indexOf("title: '什么时候发语音'")
  assert.ok(start > 0, '语音页要有「更多设置」折叠卡')
  const end = src.indexOf('VoiceSongModel', start)
  const block = src.slice(Math.max(0, start - 120), end)
  assert.match(block, /collapsible: true, defaultOpen: false/, '折叠卡必须默认不展开')
  assert.match(block, /voice\.autoChance/, '短回复变语音概率要收进折叠卡')
  assert.match(block, /voice\.autoMaxChars/, '多短算短回复要收进折叠卡')
  assert.match(block, /voice\.emojiSeparate/, '表情和语音分开发要收进折叠卡')
  // 低频参数不能还散在外面：折叠卡之前的 Voice 主体里不再出现这三项的控件
  const voiceStart = src.indexOf('function Voice(')
  const before = src.slice(voiceStart, start)
  assert.ok(!/f\.percent\('voice\.autoChance'\)/.test(before), 'autoChance 不能留在折叠卡外')
  assert.ok(!/f\.range\('voice\.autoMaxChars'/.test(before), 'autoMaxChars 不能留在折叠卡外')
  assert.ok(!/f\.sw\('voice\.emojiSeparate'\)/.test(before), 'emojiSeparate 不能留在折叠卡外')
})

test('Card 折叠行为：defaultOpen=false 时 children 不渲染；点标题展开后出现', () => {
  const p = loadPanel()
  const props = { title: '什么时候发语音', desc: '折叠描述', collapsible: true, defaultOpen: false }
  let { tree } = p.render('Card', props, '低频参数内容')
  assert.ok(!text(tree).includes('低频参数内容'), '折叠时 children 不能进树（不渲染、不注册控件）')
  assert.match(text(tree), /▸ 展开/, '折叠态要有展开提示')
  assert.ok(!text(tree).includes('折叠描述'), '折叠时连 desc 都不该渲染')
  // 点标题（h3）展开 → 重渲染后 children 出现
  const head = find(tree, (n) => n.type === 'h3')
  assert.equal(typeof head.props.onClick, 'function', '可折叠卡的标题要可点')
  head.props.onClick()
  ;({ tree } = p.render('Card', props, '低频参数内容'))
  assert.ok(text(tree).includes('低频参数内容'), '展开后 children 要渲染')
  assert.match(text(tree), /▾ 收起/, '展开态要有收起提示')
  assert.match(text(tree), /折叠描述/, '展开后 desc 也出现')
  // 非 collapsible 的 Card 不受影响：children 直接渲染
  ;({ tree } = p.render('Card', { title: '普通卡' }, '普通内容'))
  assert.ok(text(tree).includes('普通内容'), '普通卡不折叠')
})
