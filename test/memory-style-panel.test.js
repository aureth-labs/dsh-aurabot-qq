import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Script } from 'node:vm'
import { normalize, mergeFromPanel, saveConfig, loadConfig } from '../src/core/config.js'

const label = '使用学来的语气与相处建议'
function harness(initial) {
  const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const marker = '    exports.apply = apply'
  assert.ok(source.includes(marker))
  let loader
  new Script(source.replace(marker, '    exports.styleTest = Mood\n' + marker)).runInNewContext({
    window: { __ModuleLoader__: { load: value => { loader = value } } },
  })
  const React = {
    Component: class {}, Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: init => [typeof init === 'function' ? init() : init, () => {}],
    useRef: init => ({ current: init }), useEffect() {}, useCallback: fn => fn, useMemo: fn => fn(),
  }
  const Mood = loader.factory(() => React).styleTest
  let draft = normalize(initial)
  const find = (node, predicate) => {
    if (!node || typeof node !== 'object') return null
    if (Array.isArray(node)) return node.map(n => find(n, predicate)).find(Boolean)
    return predicate(node) ? node : find(node.children, predicate)
  }
  const render = () => Mood({ st: { modules: [{ id: 'memory', running: true }] }, draft, setDraft: next => { draft = next }, toast() {} })
  return {
    draft: () => JSON.parse(JSON.stringify(draft)),
    toggle: () => find(render(), node => node.props.title === label),
    row: () => find(render(), node => node.props.label === label),
  }
}

test('语气开关显示现有配置，明确全局范围及存档继续；切换只修改草稿中的 adaptStyle', () => {
  assert.equal(harness({}).toggle().props.on, true)
  const ui = harness({ memory: { adaptStyle: false, recallCount: 7 } })
  const before = ui.draft()
  assert.equal(ui.toggle().props.on, false)
  assert.match(ui.row().props.hint, /所有群和私聊/)
  assert.match(ui.row().props.hint, /学习和存档继续/)
  ui.toggle().props.onChange(true)
  assert.equal(ui.toggle().props.on, true)
  assert.deepEqual(ui.draft(), { ...before, memory: { ...before.memory, adaptStyle: true } })
  ui.toggle().props.onChange(false)
  assert.deepEqual(ui.draft(), before)
})

test('面板保存并重新读取，开启和关闭均保留，其他记忆设置不变', t => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-style-panel-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  t.after(() => {
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  const ui = harness({ memory: { adaptStyle: false, recallCount: 7 } })
  for (const on of [true, false]) {
    ui.toggle().props.onChange(on)
    const expected = ui.draft()
    const saved = mergeFromPanel(normalize({}), expected)
    saveConfig(saved)
    assert.deepEqual(loadConfig(), saved)
    assert.equal(harness(loadConfig()).toggle().props.on, on)
    assert.equal(loadConfig().memory.recallCount, 7)
  }
})
