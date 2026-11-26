// 人设图面板：执行组件事件和 effect，验证异步结果不覆盖较新的编辑。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'

const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
function mount(component, props, respond) {
  let loader, cursor = 0, effects = [], tree
  const cells = [], storage = new Map(), calls = []
  const React = {
    Component: class {}, Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(initial) {
      const i = cursor++
      if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial
      return [cells[i], (value) => { cells[i] = typeof value === 'function' ? value(cells[i]) : value }]
    },
    useRef(initial) { const i = cursor++; if (!(i in cells)) cells[i] = { current: initial }; return cells[i] },
    useEffect(fn, deps) {
      const i = cursor++, old = cells[i]
      if (!old || !deps || deps.some((value, n) => value !== old.deps[n])) effects.push(() => { old?.cleanup?.(); cells[i] = { deps, cleanup: fn() } })
    },
    useMemo: (fn) => fn(), useCallback: (fn) => fn,
  }
  const instrumented = source.replace('    exports.apply = apply', '    exports.panelTest = { PersonaLook, Persona, PersonaImageSettings }\n    exports.apply = apply')
  new Script(instrumented).runInNewContext({
    window: { __ModuleLoader__: { load: (value) => { loader = value } } },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    fetch: async (url, init = {}) => { const call = { path: url.replace('/aurabot/api', ''), body: init.body ? JSON.parse(init.body) : undefined }; calls.push(call); return { json: async () => respond(call) } },
    FileReader: class { readAsDataURL(file) { if (file.fail) this.onerror(); else { this.result = file.data; this.onload() } } },
    confirm: () => true, setTimeout, clearTimeout,
  })
  const panel = loader.factory(() => React).panelTest
  const render = () => { cursor = 0; tree = panel[component](props); const jobs = effects; effects = []; jobs.forEach((fn) => fn()); return tree }
  const unmount = () => { for (const cell of cells) cell?.cleanup?.() }
  return { render, unmount, props, calls, storage }
}
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...nodes(tree.children)]
}
const text = (node) => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.children) : String(node ?? '')
const button = (tree, label) => nodes(tree).find((n) => n.type?.name === 'Btn' && text(n) === label)
function lookProps() {
  const props = {
    edit: { id: 'a', appearance: '旧外貌' }, look: { hasImage: true, imageHash: 'one', stale: false }, saved: true,
    st: { config: { personaLook: { visionModel: { provider: '', model: '' } } } },
    draft: { personaLook: { visionModel: { provider: '', model: '' } }, unrelated: '保留' }, notices: [],
  }
  props.patch = (p) => { props.edit = { ...props.edit, ...p } }
  props.setLook = (v) => { props.look = typeof v === 'function' ? v(props.look) : v }
  props.setDraft = (v) => { props.draft = typeof v === 'function' ? v(props.draft) : v }
  props.toast = (message) => props.notices.push(message)
  return props
}

test('逐图开关与备注独立保存，备注输入不触发网络写入', async () => {
  const saves = []
  const props = { image: { id: 'one', reference: true, note: '常服' }, disabled: false, onSave: (value) => saves.push(value) }
  const ui = mount('PersonaImageSettings', props, () => ({}))
  let tree = ui.render()
  nodes(tree).find((n) => n.props.type === 'checkbox').props.onChange({ target: { checked: false } })
  assert.equal(saves[0].reference, false)
  const input = nodes(tree).find((n) => n.type === 'input' && n.props.placeholder)
  input.props.onChange({ target: { value: '工作服' } })
  tree = ui.render()
  assert.equal(saves.length, 1)
  button(tree, '保存备注').props.onClick()
  assert.equal(saves[1].note, '工作服')
  props.disabled = true; tree = ui.render()
  assert.equal(button(tree, '保存备注').props.disabled, true)
  ui.unmount()

  const look = lookProps()
  look.look.images = [{ id: 'one', hash: 'one', note: '常服', reference: true }]
  const parent = mount('PersonaLook', look, ({ path, body }) => path === '/models' ? { list: [] } : { ok: true, look: { ...look.look, images: [{ ...look.look.images[0], reference: body.reference }] } })
  tree = parent.render()
  await nodes(tree).find((n) => n.type?.name === 'PersonaImageSettings').props.onSave({ reference: false })
  assert.equal(parent.calls.find((c) => c.path.endsWith('/configure')).body.imageId, 'one')
  assert.equal(look.look.images[0].reference, false)
  parent.unmount()
})

test('备注保存去空格回显；失败时保留未保存输入', async () => {
  let succeed = true
  const props = { image: { id: 'one', reference: true, note: '常服' }, disabled: false,
    onSave: async ({ note }) => succeed ? { images: [{ id: 'one', note: note.trim() }] } : undefined }
  const ui = mount('PersonaImageSettings', props, () => ({}))
  let tree = ui.render()
  const input = () => nodes(tree).find((n) => n.type === 'input' && n.props.placeholder)
  input().props.onChange({ target: { value: ' 常服 ' } })
  tree = ui.render()
  await button(tree, '保存备注').props.onClick()
  tree = ui.render()
  assert.equal(input().props.value, '常服')
  assert.equal(button(tree, '保存备注').props.disabled, true)
  succeed = false
  input().props.onChange({ target: { value: '工作服' } })
  tree = ui.render()
  await button(tree, '保存备注').props.onClick()
  tree = ui.render()
  assert.equal(input().props.value, '工作服')
  assert.equal(button(tree, '保存备注').props.disabled, false)
  ui.unmount()
})

test('人设图组件：未保存提示、模型草稿、描述输入和解析保存提示', async () => {
  const props = lookProps()
  const ui = mount('PersonaLook', props, ({ path }) => path === '/models' ? { list: [{ provider: 'p', model: 'vision::x', name: '视觉', vision: true }] } : { ok: true, text: '解析的外貌', imageHash: 'one' })
  let tree = ui.render()
  await flush(); tree = ui.render()
  assert.match(text(tree), /与左侧「面板头像」分别保存/)
  const modelRow = nodes(tree).find((n) => n.props.label === '外貌解析模型')
  assert.match(modelRow.props.hint, /仅用于读取人设图/)
  assert.match(text(tree), /不会更换聊天模型或生图模型/)
  assert.match(text(tree), /所有人格共用此设置/)
  assert.match(text(tree), /才会把全部人设图发送给这个模型/)
  const select = nodes(tree).find((n) => n.type?.name === 'Select')
  select.props.onChange('p::vision::x')
  assert.equal(props.draft.personaLook.visionModel.model, 'vision::x')
  assert.equal(props.draft.unrelated, '保留')
  tree = ui.render()
  assert.equal(button(tree, '从人设图生成描述').props.disabled, true)
  props.st.config.personaLook = props.draft.personaLook
  tree = ui.render()
  assert.equal(button(tree, '从人设图生成描述').props.disabled, false)
  await button(tree, '从人设图生成描述').props.onClick()
  assert.equal(props.edit.appearance, '解析的外貌')
  assert.equal(props.edit.appearanceSource, 'vision')
  assert.equal(props.edit.appearanceDirty, true)
  tree = ui.render()
  nodes(tree).find((n) => n.type === 'textarea').props.onChange({ target: { value: '手动外貌' } })
  assert.equal(props.edit.appearanceSource, 'manual')
  props.saved = false
  tree = ui.render()
  assert.match(text(tree), /请先保存新人格/)
  assert.equal(button(tree, '添加人设图').props.disabled, true)
  assert.equal(button(tree, '从人设图生成描述').props.disabled, true)
  ui.unmount()
})

test('解析结果在手工修改、换模型、换图或卸载后失效', async () => {
  for (const action of ['edit', 'model', 'image', 'unmount']) {
    const props = lookProps()
    let finish
    const ui = mount('PersonaLook', props, ({ path }) => path === '/models' ? { list: [] } : new Promise((resolve) => { finish = resolve }))
    const tree = ui.render()
    const running = button(tree, '从人设图生成描述').props.onClick()
    await flush()
    if (action === 'edit') props.edit = { ...props.edit, appearance: '新外貌' }
    if (action === 'model') props.draft.personaLook.visionModel = { provider: 'new', model: 'new' }
    if (action === 'image') props.look = { ...props.look, imageHash: 'two' }
    if (action === 'unmount') ui.unmount()
    else ui.render()
    finish({ ok: true, text: '迟到的外貌', imageHash: 'one' })
    await running
    assert.notEqual(props.edit.appearance, '迟到的外貌', action)
    ui.unmount()
  }
})

test('上传与删除：刷新预览、保留文字、失败保留旧图、限制大小及重复选择', async () => {
  const props = lookProps()
  let failDelete = true
  const ui = mount('PersonaLook', props, ({ path }) => {
    if (path === '/models') return { list: [] }
    if (path === '/persona/look/upload') return { ok: true, look: { hasImage: true, imageHash: 'two', stale: true } }
    return failDelete ? { ok: false, message: '删除失败' } : { ok: true, look: { hasImage: false, imageHash: '', stale: false } }
  })
  let tree = ui.render()
  const pick = (file) => { const target = { files: [file], value: 'selected' }; nodes(tree).find((n) => n.type === 'input' && n.props.type === 'file').props.onChange({ target }); assert.equal(target.value, '') }
  pick({ size: 100, data: 'data:image/png;base64,aGVsbG8=' })
  await flush(); tree = ui.render()
  assert.equal(props.look.imageHash, 'two')
  assert.equal(props.edit.appearance, '旧外貌')
  assert.match(nodes(tree).find((n) => n.type === 'img').props.src, /v=two/)
  assert.match(text(tree), /可重新生成描述/)
  await button(tree, '删除这张').props.onClick()
  assert.equal(props.look.hasImage, true)
  failDelete = false; tree = ui.render()
  await button(tree, '删除这张').props.onClick()
  assert.equal(props.look.hasImage, false)
  assert.equal(props.edit.appearance, '旧外貌')
  tree = ui.render()
  const count = ui.calls.length
  pick({ size: 6 * 1024 * 1024 })
  await flush(); tree = ui.render()
  assert.equal(ui.calls.length, count)
  assert.match(props.notices.at(-1), /5MB/)
  pick({ size: 10, fail: true })
  await flush()
  assert.match(props.notices.at(-1), /读取失败/)
  ui.unmount()
})

test('多图面板：多选新增、逐张替换删除和按钮边距', async () => {
  const props = lookProps()
  props.look.images = [{ id: 'first', hash: 'h1' }, { id: 'second', hash: 'h2' }]
  const ui = mount('PersonaLook', props, ({ path, body }) => {
    if (path === '/models') return { list: [] }
    let images = props.look.images.slice()
    if (path.endsWith('/delete')) images = images.filter((item) => item.id !== body.imageId)
    else if (body.append) images.push({ id: 'added-' + images.length, hash: 'new' })
    else images = images.map((item) => item.id === body.imageId ? { ...item, hash: 'replaced' } : item)
    return { ok: true, look: { ...props.look, images } }
  })
  let tree = ui.render()
  assert.equal(tree.props.style.padding, 20)
  const cards = nodes(tree).filter((n) => n.props.className === 'ab-look-image')
  assert.equal(cards.length, 2)
  assert.equal(cards[0].props.style.padding, 14)
  assert.equal(nodes(cards[0]).find((n) => n.props.className === 'ab-flex ab-look-actions').props.style.paddingTop, 12)
  assert.match(nodes(cards[1]).find((n) => n.type === 'img').props.src, /imageId=second/)
  button(cards[1], '替换这张').props.onClick()
  let input = nodes(tree).find((n) => n.type === 'input' && n.props.type === 'file' && !n.props.multiple)
  input.props.onChange({ target: { files: [{ size: 10, data: 'data:image/png;base64,aA==' }], value: 'x' } })
  await flush(); tree = ui.render()
  assert.equal(ui.calls.find((c) => c.path.endsWith('/upload')).body.imageId, 'second')
  assert.equal(props.look.images[0].hash, 'h1')
  assert.equal(props.look.images[1].hash, 'replaced')
  await button(nodes(tree).filter((n) => n.props.className === 'ab-look-image')[0], '删除这张').props.onClick()
  tree = ui.render()
  assert.equal(props.look.images.length, 1)
  assert.equal(props.look.images[0].id, 'second')
  input = nodes(tree).find((n) => n.type === 'input' && n.props.multiple)
  input.props.onChange({ target: { files: [{ size: 10, data: 'data:image/png;base64,aA==' }, { size: 11, data: 'data:image/png;base64,aQ==' }], value: 'x' } })
  await flush(); await flush(); tree = ui.render()
  assert.equal(props.look.images.length, 3)
  assert.equal(ui.calls.filter((c) => c.body?.append).length, 2)
  assert.equal(props.edit.appearance, '旧外貌')
  ui.unmount()
})

test('旧响应的替换仍指定 legacy 图片，模型选择器不强制固定宽度', async () => {
  const props = lookProps()
  const ui = mount('PersonaLook', props, ({ path }) => path === '/models' ? { list: [] } : { ok: true, look: props.look })
  const tree = ui.render()
  assert.equal(nodes(tree).find((n) => n.type?.name === 'Select').props.width, undefined)
  button(tree, '替换这张').props.onClick()
  nodes(tree).find((n) => n.type === 'input' && n.props.type === 'file' && !n.props.multiple).props.onChange({ target: { files: [{ size: 10, data: 'data:image/png;base64,aA==' }], value: 'x' } })
  await flush()
  const call = ui.calls.find((c) => c.path.endsWith('/upload'))
  assert.equal(call.body.imageId, 'legacy')
  assert.equal(call.body.append, undefined)
  ui.unmount()
})

test('往返编辑描述或模型也使旧解析失效', async () => {
  for (const kind of ['appearance', 'model']) {
    const props = lookProps()
    let finish
    const ui = mount('PersonaLook', props, ({ path }) => path === '/models' ? { ok: true, list: [] } : new Promise((resolve) => { finish = resolve }))
    let tree = ui.render()
    const pending = button(tree, '从人设图生成描述').props.onClick()
    await flush()
    if (kind === 'appearance') {
      nodes(tree).find((n) => n.type === 'textarea').props.onChange({ target: { value: '改过' } })
      tree = ui.render()
      nodes(tree).find((n) => n.type === 'textarea').props.onChange({ target: { value: '旧外貌' } })
    } else {
      nodes(tree).find((n) => n.type?.name === 'Select').props.onChange('p::m')
      tree = ui.render()
      nodes(tree).find((n) => n.type?.name === 'Select').props.onChange('')
    }
    ui.render()
    finish({ ok: true, text: '迟到的描述', imageHash: 'one' })
    await pending
    assert.equal(props.edit.appearance, '旧外貌')
    ui.unmount()
  }
})

test('模型列表失败与人格加载失败均可重试', async () => {
  const props = lookProps()
  let modelOk = false
  const ui = mount('PersonaLook', props, () => modelOk ? { ok: true, list: [{ provider: 'p', model: 'm', name: 'M' }] } : { ok: false, message: '模型服务故障' })
  ui.render(); await flush()
  let tree = ui.render()
  assert.match(text(tree), /模型服务故障/)
  modelOk = true
  await button(tree, '重试模型列表').props.onClick()
  tree = ui.render()
  assert.equal(nodes(tree).find((n) => n.type?.name === 'Select').props.options.length, 2)
  assert.doesNotMatch(text(tree), /模型服务故障/)
  ui.unmount()
  let cardOk = false
  const p = { st: { personas: [{ id: 'a', name: 'A', tags: [] }, { id: 'b', name: 'B', tags: [] }], config: { persona: { current: 'a' } } }, toast() {}, draft: {}, setDraft() {} }
  const cards = mount('Persona', p, ({ path }) => {
    const id = path.endsWith('b') ? 'b' : 'a'
    return id === 'b' && !cardOk ? { ok: false, message: '人格网络失败' } : { ok: true, persona: { id, name: id, tags: [], body: '内容' }, look: {} }
  })
  cards.render(); await flush(); tree = cards.render()
  nodes(tree).find((n) => n.type === 'button' && n.props.key === 'b').props.onClick()
  cards.render(); await flush(); tree = cards.render()
  assert.match(text(tree), /人格网络失败/)
  cardOk = true
  await button(tree, '重试加载人格').props.onClick()
  tree = cards.render()
  assert.equal(nodes(tree).find((n) => n.type?.name === 'PersonaLook').props.edit.id, 'b')
  cards.unmount()
})

test('Persona 外貌进入 dirty、草稿和保存请求；保存途中继续编辑仍保持 dirty', async () => {
  let completeSave
  const props = { st: { personas: [{ id: 'a', name: 'A', tags: [] }], config: { persona: { current: 'a' } } }, toast() {}, reload() {}, draft: {}, setDraft() {} }
  const ui = mount('Persona', props, ({ path }) => {
    if (path.startsWith('/persona/get')) return { ok: true, persona: { id: 'a', name: 'A', tags: [], body: '测试人格' }, look: { appearance: '原外貌', imageHash: 'one', source: 'manual' } }
    if (path === '/persona/save') return new Promise((resolve) => { completeSave = resolve })
    if (path === '/personas') return { ok: true, list: props.st.personas, current: 'a' }
  })
  ui.render(); await flush()
  let tree = ui.render()
  let look = nodes(tree).find((n) => n.type?.name === 'PersonaLook')
  look.props.patch({ appearance: '新外貌', appearanceSource: 'manual', appearanceDirty: true })
  tree = ui.render()
  assert.equal(JSON.parse(ui.storage.get('aurabot.persona.draft.a')).appearance, '新外貌')
  const saving = button(tree, '保存人格').props.onClick()
  await flush()
  assert.equal(ui.calls.find((c) => c.path === '/persona/save').body.appearance, '新外貌')
  tree = ui.render()
  look = nodes(tree).find((n) => n.type?.name === 'PersonaLook')
  look.props.patch({ appearance: '保存期间修改', appearanceDirty: true })
  tree = ui.render()
  completeSave({ ok: true, look: { imageHash: 'one', stale: false } })
  await saving
  tree = ui.render()
  assert.ok(button(tree, '保存人格'))
  assert.equal(nodes(tree).find((n) => n.type?.name === 'PersonaLook').props.edit.appearance, '保存期间修改')
  assert.equal(JSON.parse(ui.storage.get('aurabot.persona.draft.a')).appearance, '保存期间修改')
  ui.unmount()
})
