// Full upstream merge × local customizations. Only fake DSH/OneBot, no services.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { normalize } from '../src/core/config.js'
import { clearVisionCache, clearReasoningCache } from '../src/core/llm.js'

const root = mkdtempSync(join(tmpdir(), 'aurabot-merge-'))
process.env.AURABOT_WORKSPACE = join(root, 'workspace')
const { createHub } = await import('../src/chat/hub.js')
const OWNER = '10000001'
const BOT = '20000002'
const CHAT = `private:${OWNER}`

test('升级 1.1.6 后，三种生图通道与本地增强配置在保存重载后保持兼容', async (t) => {
  for (const provider of ['openai', 'custom', 'codex']) await t.test(provider, () => {
    const before = normalize({
      imageGen: { provider, shape: 'wide', seeOwn: false, galleryShown: 17,
        codex: { model: 'gpt-image-2', quality: 'high', background: 'transparent' },
        custom: { method: 'POST', url: 'https://image.test/generate', bodyType: 'json', responsePath: 'data.0.url', params: [{ key: 'prompt', value: '{prompt}' }] } },
      voice: { engine: 'edge', rate: '+0%', pitch: '+50Hz' },
      debug: true, security: { ssrfMode: 'loose' }, stickers: { collectMode: 'owner' },
      group: { ownerBrief: { enabled: true, lines: 12, groups: ['777'] } },
      bili: { vision: true, visionFrames: 6 }, douyin: { enabled: false },
      modules: { douyin: { enabled: false }, bili: { useBuiltin: false, enabled: true } },
    })
    const after = normalize(JSON.parse(JSON.stringify(before)))
    assert.deepEqual(after.imageGen, before.imageGen)
    assert.equal(after.imageGen.provider, provider)
    assert.equal(after.voice.rate, '+0%')
    assert.equal(after.voice.pitch, '+50Hz')
    assert.equal(after.debug, true)
    assert.equal(after.security.ssrfMode, 'loose')
    assert.equal(after.stickers.collectMode, 'owner')
    assert.deepEqual(after.group.ownerBrief, before.group.ownerBrief)
    assert.equal(after.bili.vision, true)
    assert.equal(after.douyin.enabled, false)
    assert.equal(after.modules.douyin.enabled, false)
    assert.equal(after.modules.bili.useBuiltin, false)
    assert.equal(after.profilePerms.douyinDm, 'owner')
  })
})

const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(setImmediate) }
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }

function setup(t, { config = {}, brain = async () => '', hooks = {}, buildTools } = {}) {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(root, 'data-'))
  clearVisionCache()
  clearReasoningCache()
  let cfg = normalize({ enabled: true, dryRun: true, setupDone: true, ownerQQ: OWNER, botQQ: BOT,
    model: { provider: 'p', model: 'blind', reasoningEffort: 'low' },
    voice: { enabled: false }, stickers: { enabled: false, collect: false }, merge: { enabled: false },
    allow: { groups: ['777'] }, ...config })
  const fake = createFakeDsh({ brain })
  const selections = []
  fake.ctx.services.sessionController.agents = { selectForNextRequest(agent, selection) {
    selections.push({ agent, selection })
    agent.selection = selection
  } }
  fake.ctx.llm.resolveModelInfo = async (_p, model) => model === 'unknown' ? {} : {
    inputModalities: model === 'see' ? ['text', 'image'] : ['text'],
    ...(model === 'reason' ? { reasoning: { efforts: ['low', 'high'], defaultEffort: 'low' } } : {}),
  }
  const hub = createHub({ dsh: fake.ctx, getConfig: () => cfg,
    log: Object.fromEntries(['info', 'warn', 'debug', 'error'].map((k) => [k, (...v) => fake.logs.push(v.join(' '))])),
    onebot: { connected: true, async call() { return { message_id: 1, group_name: '测试群' } } },
    hooks, buildTools, availableModels: () => null })
  fake.ctx.on('session/event', hub.onSessionEvent)
  t.after(() => fake.dispose())
  const send = (text = '你好', message) => hub.onMessage({ post_type: 'message', message_type: 'private',
    self_id: Number(BOT), user_id: Number(OWNER), message_id: 1, sender: { user_id: Number(OWNER), nickname: '主人' },
    message: message || [{ type: 'text', data: { text } }] })
  return { fake, hub, send, selections, cfg: () => cfg, set: (patch) => { cfg = normalize({ ...cfg, ...patch }) },
    agent: () => fake.agents.get(hub.sessions()[CHAT]?.sessionId) }
}

const PNG = Buffer.alloc(64)
PNG.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
PNG.writeUInt32BE(64, 16)
PNG.writeUInt32BE(64, 20)
const image = [{ type: 'image', data: { sub_type: 0, file: 'base64://' + PNG.toString('base64') } }]

test('按聊天选模与视觉降级共存（含模块覆盖、手动声明和未知能力）', async (t) => {
  for (const c of [
    { global: 'blind', selected: 'see', images: 1 },
    { global: 'see', selected: 'blind', images: 0 },
    { global: 'blind', selected: 'unknown', images: 1 },
    { global: 'blind', selected: 'see', vision: 'off', images: 0 },
    { global: 'see', selected: 'blind', vision: 'on', images: 1 },
    { global: 'blind', selected: 'blind', hook: 'see', images: 1 },
  ]) await t.test(JSON.stringify(c), async (t) => {
    const s = setup(t, { config: { model: { provider: 'p', model: c.global, vision: c.vision || 'auto' },
      chatModels: { privates: { [OWNER]: { provider: 'p', model: c.selected } } } },
      hooks: c.hook ? { model: () => ({ provider: 'p', model: c.hook }) } : {} })
    await s.send('', image)
    await settle()
    assert.equal(s.fake.turns.length, 1)
    assert.equal(s.fake.turns[0].images, c.images)
    assert.equal(s.agent().selection.model, c.hook || c.selected)
  })
})

test('聊天选模后思考强度仍按实际模型能力收敛', async (t) => {
  const s = setup(t, { config: { chatModels: { privates: { [OWNER]: { provider: 'p', model: 'reason', reasoningEffort: 'max' } } } } })
  await s.send()
  await settle()
  assert.deepEqual(s.agent().selection, { provider: 'p', model: 'reason', reasoningEffort: 'low' })
  s.set({ chatModels: { privates: { [OWNER]: { provider: 'p', model: 'blind', reasoningEffort: 'high' } } } })
  await s.send('切换')
  await settle()
  assert.deepEqual(s.agent().selection, { provider: 'p', model: 'blind' })
})

test('正式/调试与长任务切换时，每个实际 agent 都应用选模，复用不重建', async (t) => {
  const s = setup(t)
  await s.send()
  await settle()
  const live = s.agent()
  s.set({ debug: true })
  await s.send('调试')
  await settle()
  const debug = s.agent()
  assert.notEqual(debug, live)
  assert.deepEqual(debug.selection, live.selection)
  s.set({ debug: false })
  await s.send('回来')
  await settle()
  assert.equal(s.agent(), live)
  assert.equal(s.fake.agents.size, 2)
  s.set({ longTasks: true })
  await s.send('长任务')
  await settle()
  assert.equal(s.agent().preset, 'aurabot-private-long')
  assert.deepEqual(s.agent().selection, live.selection)
  s.set({ ownerLevel: 'social' })
  await s.send('降权')
  await settle()
  assert.equal(s.agent().preset, 'aurabot-social')
})

for (const rejectOld of [false, true]) test(`旧会话${rejectOld ? '失败' : '结束'}不能释放新会话，补充消息仍走 steer`, async (t) => {
  const old = deferred(), current = deferred()
  t.after(() => { old.resolve(''); current.resolve('') })
  const s = setup(t, { brain: ({ text }) => text.includes('旧轮') ? old.promise : current.promise })
  await s.send('旧轮')
  await settle()
  const a = s.agent()
  s.set({ debug: true })
  await s.send('新轮')
  await settle()
  const b = s.agent()
  assert.notEqual(a, b)
  b.steer = async (msg) => { b.steered.push(msg) }
  if (rejectOld) old.reject(new Error('旧会话失败'))
  else old.resolve('')
  await settle()
  await s.send('补充')
  await settle()
  assert.equal(b.steered.length, 1, '新会话仍在运行，不能当空闲开新轮')
  assert.match(b.steered[0].content[0].text, /补充/)
  assert.equal(s.hub.prevTextOf(b.id), '新轮')
  assert.equal(s.hub.lastTextOf(b.id), '补充')
  current.resolve('')
  await settle()
})

test('切换后的新会话准备期间也占忙，不会因连发而并发建会话', async (t) => {
  const old = deferred(), prepare = deferred(), current = deferred()
  const seen = []
  t.after(() => { old.resolve(''); prepare.resolve(); current.resolve('') })
  const s = setup(t, { hooks: { prompt: async (content) => {
    if (content[0].text.includes('新轮')) await prepare.promise
    return content
  } }, brain: ({ text }) => {
    seen.push(text)
    return text.includes('旧轮') ? old.promise : text.includes('新轮') ? current.promise : ''
  } })
  await s.send('旧轮')
  await settle()
  s.set({ debug: true })
  await s.send('新轮')
  await settle()
  await s.send('准备时补充')
  await settle()
  assert.equal(s.fake.agents.size, 2, '新 prompt 先绑定会话，但准备期间的补充消息不能再建第三个会话')
  assert.equal(seen.length, 1, '新 prompt 未放行，准备期间的补充消息也不能提前进入模型')
  prepare.resolve()
  await settle()
  assert.equal(s.fake.agents.size, 2)
  assert.equal(seen.length, 2)
  current.resolve('')
  await settle()
  assert.equal(s.fake.agents.size, 2)
  assert.equal(seen.length, 3, '准备期间的消息应保留，当前轮结束后再处理')
  assert.match(seen[2], /准备时补充/)
  old.resolve('')
  await settle()
})

test('长任务超过四分钟仍在运行时，私聊继续 steer 而不是重复开轮', async (t) => {
  const work = deferred()
  t.after(() => work.resolve(''))
  const s = setup(t, { config: { longTasks: true }, brain: () => work.promise })
  await s.send('开始长任务')
  await settle()
  const a = s.agent()
  a.steer = async (msg) => { a.steered.push(msg) }
  const now = Date.now
  try {
    Date.now = () => now() + 5 * 60_000
    await s.send('还要补充')
    await settle()
    assert.equal(a.steered.length, 1)
    assert.equal(s.fake.agents.size, 1)
  } finally { Date.now = now }
  work.resolve('')
  await settle()
})

test('后台 noTools 与长任务、调试共存，实际不挂模块工具', async (t) => {
  const tools = [{ name: 'test_tool', execute: async () => ({ ok: true }) }]
  const s = setup(t, { config: { longTasks: true, debug: true }, buildTools: () => tools, brain: async () => '后台结果' })
  const result = await s.hub.runSystemTurn('merge-no-tools', '后台验证', '只返回结果', { noTools: true })
  assert.equal(result, '后台结果')
  assert.equal([...s.fake.agents.values()][0].tools.size, 0)
  assert.equal(s.fake.turns[0].preset, 'aurabot-social')
})

test('群聊也按该群的最终模型判断图片能力，长任务不扩权', async (t) => {
  for (const model of ['see', 'blind']) await t.test(model, async (t) => {
    const s = setup(t, { config: { longTasks: true, model: { provider: 'p', model: model === 'see' ? 'blind' : 'see' },
      chatModels: { groups: { '777': { provider: 'p', model } } } } })
    await s.hub.onMessage({ post_type: 'message', message_type: 'group', self_id: Number(BOT),
      group_id: 777, user_id: Number(OWNER), message_id: 99, sender: { nickname: '主人' },
      message: [{ type: 'at', data: { qq: BOT } }, ...image] })
    await settle()
    assert.equal(s.fake.turns.length, 1)
    assert.equal(s.fake.turns[0].images, model === 'see' ? 1 : 0)
    assert.equal(s.fake.turns[0].preset, 'aurabot-social')
  })
})

test('会话创建中途切换模式，旧创建结果不能覆盖新映射或清掉新轮状态', async (t) => {
  const createGate = deferred(), work = deferred()
  t.after(() => { createGate.resolve(); work.resolve('') })
  const s = setup(t, { brain: () => work.promise })
  const controller = s.fake.ctx.services.sessionController
  const create = controller.create
  let count = 0
  controller.create = async (args) => {
    const n = ++count
    const result = await create(args)
    if (n === 1) await createGate.promise
    return result
  }
  await s.send('旧创建')
  await settle()
  s.set({ debug: true })
  await s.send('新创建')
  await settle()
  const current = s.agent()
  assert.ok(current)
  current.steer = async (msg) => { current.steered.push(msg) }
  createGate.resolve()
  await settle()
  assert.equal(s.agent(), current, '旧结果不得写回当前映射')
  await s.send('继续补充')
  await settle()
  assert.equal(current.steered.length, 1)
  work.resolve('')
  await settle()
})
