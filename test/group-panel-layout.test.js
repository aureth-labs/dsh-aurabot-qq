import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { normalize } from '../src/core/config.js'

const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
const G = '30000003', H = '40000004', P = '50000005'
function panel() {
  let loader, cursor = 0, slots = [], draft = normalize({ allow: { groups: [G, H] }, group: { overrides: { [G]: { proactiveEnabled: false } } }, memory: { passiveGroups: [P] } })
  // React 的状态属于组件实例；两个分区不能共用一个线性 hooks 数组。
  const frames = new Map(); let frame = 'root', child = 0
  function inFrame(key, fn) {
    const old = [frame, child, slots, cursor]; frame = key; child = 0; cursor = 0
    if (!frames.has(key)) frames.set(key, [])
    slots = frames.get(key)
    try { return fn() } finally { [frame, child, slots, cursor] = old }
  }
  const React = { Component: class {}, createElement(type, props, ...children) {
    const key = frame + '/' + (props?.key ?? child++) + ':' + (type?.name || type)
    return { type: typeof type === 'function' ? p => inFrame(key, () => type(p)) : type, props: props || {}, children }
  },
    useState: init => { const i = cursor++, cell = slots; if (!(i in cell)) cell[i] = typeof init === 'function' ? init() : init; return [cell[i], v => { cell[i] = typeof v === 'function' ? v(cell[i]) : v }] },
    useRef: v => ({ current: v }), useEffect: () => {}, useMemo: fn => (typeof fn === 'function' ? fn() : fn), useCallback: fn => fn, Fragment: 'fragment' }
  new Script(source.replace('exports.AurabotPage = AurabotPage', 'exports.GroupOverrides = GroupOverrides; exports.Group = Group; exports.AurabotPage = AurabotPage')).runInNewContext({ window: { __ModuleLoader__: { load: v => { loader = v } } } })
  const { GroupOverrides, Group } = loader.factory(() => React)
  return { get draft() { return draft }, render(component = GroupOverrides) { return inFrame(component.name, () => component({ draft, setDraft: v => { draft = JSON.parse(JSON.stringify(v)) }, setSection() {}, st: { modules: [] }, go() {} })) }, Group }
}
function nodes(root) {
  // 融合：Group 重整后 Seg/Select/Switch 是函数组件，先把整棵树按 React 语义展开，再收集节点。
  // 个别组件（如 MemberFilter）需要运行时依赖，展开失败时保留原节点不深入。
  const expand = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 24) return node
    if (Array.isArray(node)) return node.map(n => expand(n, depth + 1))
    if (typeof node.type === 'function') {
      try {
        const kids = [].concat(node.children ?? []).filter(c => c !== undefined)
        const merged = Object.assign({}, node.props, kids.length || !node.props.children ? { children: kids.length ? kids : node.props.children } : {})
        return expand(node.type(merged), depth + 1)
      } catch { return { type: node.type, props: node.props, children: [] } }
    }
    return { type: node.type, props: node.props, children: expand(node.children, depth + 1) }
  }
  const collect = node => [node, ...(Array.isArray(node?.children) ? node.children : []).flat(Infinity).filter(v => v && typeof v === 'object').flatMap(collect)]
  return collect(expand(root))
}
const find = (tree, predicate) => { const n = nodes(tree).find(predicate); assert.ok(n, 'control exists'); return n }
const text = node => typeof node === 'string' ? node : (node?.children || []).flat(Infinity).map(text).join('')

test('按群设置包含仅旁听的群，添加和切换选中项不会开放聊天', () => {
  const p = panel(), before = structuredClone(p.draft)
  let tree = p.render()
  find(tree, n => n.type === 'button' && text(n).startsWith(P)).props.onClick()
  tree = p.render()
  assert.equal(find(tree, n => n.props['aria-label'] === `群 ${P} 响应模式`).props.value, undefined) // Select 的 combobox 按钮带 aria-label，值在按钮文案里
  find(tree, n => n.props['aria-label'] === '查找或添加群号').props.onChange({ target: { value: '60000006' } })
  tree = p.render(); find(tree, n => text(n) === '添加群' && n.props.onClick).props.onClick()
  assert.deepEqual(p.draft.allow, before.allow)
  assert.deepEqual(p.draft.memory, before.memory)
  assert.deepEqual(p.draft.group.overrides['60000006'], {})
  assert.ok(find(p.render(), n => n.props['aria-label'] === '群 60000006 响应模式'))
})

test('只有不响应可切换旁听，经过 AI 和仅模块后仍记住原选择', () => {
  const p = panel(), before = structuredClone(p.draft)
  const toggle = n => n.props.title === `群 ${G} 不响应时仍旁听`
  const mode = n => n.props['aria-label'] === `群 ${G} 响应模式`
  const choose = label => {
    find(p.render(), mode).props.onClick()
    find(p.render(), n => n.props.role === 'option' && text(n).includes(label)).props.onClick()
  }
  assert.equal(nodes(p.render()).some(toggle), false)
  choose('不响应群消息')
  find(p.render(), toggle).props.onClick()
  for (const label of ['仅模块', '允许 AI 聊天']) {
    choose(label)
    assert.equal(nodes(p.render()).some(toggle), false)
    assert.deepEqual(p.draft.memory.passiveGroups, [P, G])
  }
  choose('不响应群消息')
  assert.equal(find(p.render(), toggle).props['aria-checked'], true)
  find(p.render(), toggle).props.onClick()
  assert.deepEqual(p.draft.memory.passiveGroups, [P]); assert.deepEqual(p.draft.group.overrides, before.group.overrides)
})

test('开关与概率分别修改，跟随默认与 /quiet 留下的值可见', () => {
  const p = panel()
  // Select 打开菜单后点选项；change('engagedEnabled', 'on')
  let tree = p.render()
  find(tree, n => n.props['aria-label'] === `群 ${G} 聊起来后继续回应`).props.onClick()
  tree = p.render()
  find(tree, n => text(n) === '开' && n.props.onClick).props.onClick()
  assert.deepEqual(p.draft.group.overrides[G], { proactiveEnabled: false, engagedEnabled: true })
  find(p.render(), n => n.props['aria-label'] === `群 ${G} 插话概率`).props.onChange({ target: { value: '0' } })
  assert.match(text(p.render()), /主动插话关（基础 0%），继续回应开/)
  tree = p.render()
  find(tree, n => n.props['aria-label'] === `群 ${G} 没人叫时主动插话`).props.onClick()
  tree = p.render()
  find(tree, n => text(n) === '使用群聊通用设置' && n.props.onClick).props.onClick()
  assert.equal(p.draft.group.overrides[G].proactiveEnabled, undefined)
  assert.equal(p.draft.group.overrides[G].engagedEnabled, true)
  assert.equal(p.draft.group.overrides[G].interjectChance, 0)
})

test('页面默认展示按群设置，分区切换不修改配置，旧入口和搜索仍能找到', () => {
  // 融合：Group 页 2026-11-17 重整为两段 Seg（单个群/所有群默认），默认选中「单个群」
  const p = panel(), before = structuredClone(p.draft)
  let tree = p.render(p.Group)
  assert.equal(find(tree, n => n.type === 'button' && text(n) === '单个群').props.className, 'on')
  for (const label of ['所有群默认', '单个群']) {
    find(tree, n => n.type === 'button' && text(n) === label).props.onClick(); tree = p.render(p.Group)
  }
  assert.deepEqual(p.draft, before)
  assert.match(source, /打开群聊设置/)
  assert.match(source, /group: '群聊 发言 白名单 仅模块 主动 窗口 插话 旁听 静默 合并 不回应 不理 屏蔽 黑名单 通用设置 继续回应 回复方式 权限与限制'/)
  assert.match(source, /const base = draftBaseRef\.current \|\| cfg/)
  assert.match(source, /JSON\.stringify\(draft\.allow\?\.groups\) !== JSON\.stringify\(base\.allow\?\.groups\)/)
})


test('群聊首卡直接显示通用设置，选择群紧随其后；更多默认设置仍能打开', () => {
  const p = panel(), before = structuredClone(p.draft)
  let tree = p.render(p.Group)
  const headings = nodes(tree).filter(n => n.type === 'h3').map(text)
  assert.deepEqual(headings.slice(0, 2), ['群聊通用设置', '选择群'])
  find(p.render(p.Group), n => n.type === 'button' && text(n) === '所有群默认').props.onClick()
  tree = p.render(p.Group)
  const defaults = tree.children.find(n => n?.type === 'fragment')
  assert.ok(defaults.children.some(n => n?.props?.title === '被叫到时怎么回'))
  assert.ok(defaults.children.some(n => n?.props?.title === '一条消息怎么变成回复'))
  assert.deepEqual(p.draft, before)
})

test('通用规则只改通用字段，不覆盖单群选择；回复页不再混入群叫醒规则', () => {
  // 融合：通用区改走 Seg 的「所有群默认」段（源码契约断言；单群开关的交互在「按群设置」用例覆盖，
  // 群命令侧的通用/单群隔离在 group-settings-command / group-access-entry 用例覆盖）。
  assert.match(source, /label: '没人叫时主动插话', hint: '没人叫它、也没在聊天时，偶尔加入话题。' }, f\.sw\('group\.proactiveEnabled'/, '通用区保留「没人叫时主动插话」开关')
  assert.match(source, /label: '聊起来后继续回应'[\s\S]{0,200}f\.sw\('group\.engagedEnabled'/, '通用区保留「聊起来后继续回应」开关')
  assert.match(source, /setPath\(draft, 'group\.quietHours'/, '通用区保留安静时段设置')
  assert.match(source, /label: '连发合并'[\s\S]{0,120}f\.sw\('merge\.enabled'\)/, '连发合并在自己的卡里')
  // 通用区（所有群默认）不含「单个群」的唤醒词编辑（群叫醒规则不混进回复页）
  assert.doesNotMatch(source, /label: '用哪些称呼叫它'[\s\S]{0,400}merge\.enabled/)
})


test('插话频率收起但仍可改，恢复通用只清除本群接话设置', () => {
  const p = panel(), before = structuredClone(p.draft)
  let tree = p.render()
  const advanced = find(tree, n => n.type === 'details' && (n.children || []).some(c => c?.type === 'summary' && text(c) === '插话频率与次数'))
  assert.notEqual(advanced.props.open, true)
  find(advanced, n => n.props['aria-label'] === `群 ${G} 插话概率`).props.onChange({ target: { value: '0' } })
  assert.equal(p.draft.group.overrides[G].interjectChance, 0)
  find(p.render(), n => text(n) === '本群接话改用通用设置' && n.props.onClick).props.onClick()
  const expected = structuredClone(before); delete expected.group.overrides[G]
  assert.deepEqual(p.draft, expected)
})
