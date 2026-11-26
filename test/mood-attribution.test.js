// 心情归属：原因跟着产生它的聊天走，不把别人的私聊/群聊事件带进当前会话（issue #273）；
// 说话人标签带 QQ，同名群友也能分清是谁。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMood } from '../src/features/mood.js'
import { normalize } from '../src/core/config.js'
import moodModule from '../src/modules/mood/index.js'

const now = new Date(2026, 10, 4, 14, 0).getTime()

function setup(t, patch = {}, dsh) {
  const previous = process.env.AURABOT_DATA_DIR
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-mood-attribution-'))
  process.env.AURABOT_DATA_DIR = dir
  t.after(() => {
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
  })
  t.mock.timers.enable({ apis: ['Date'], now })
  const cfg = normalize({ ownerName: '若青木', mood: { enabled: true, halfLifeHours: 24, ...patch }, model: { provider: 'p', model: 'm' } })
  return { mood: createMood({ getConfig: () => cfg, dsh }), cfg, file: join(dir, 'mood.json') }
}

test('关键词记下的心情原因只在产生它的聊天里出现', (t) => {
  const { mood } = setup(t)
  mood.observe('谢谢你，真棒', '小明(111)', { chatId: 'group:777', direct: true })
  const state = mood.state()
  assert.equal(state.reasonChat, 'group:777')
  assert.equal(state.history[0].chatId, 'group:777')
  assert.match(state.reason, /小明\(111\)说/)
  assert.match(mood.contextLine({ kind: 'group', chatId: 'group:777' }), /1 分钟前因为小明\(111\)说/)
  assert.doesNotMatch(mood.contextLine({ kind: 'private', chatId: 'private:20002' }), /因为|小明/)
  assert.match(mood.contextLine({ kind: 'private', chatId: 'private:20002' }), /心情不错|超开心/)
})

test('模型判心情也把原因记在当前聊天，不串到别的私聊', async (t) => {
  const dsh = { get: () => null, llm: { async *stream() {
    yield { type: 'text-delta', text: '{"delta":10,"reason":"被主人夸了","confidence":0.9}' }
    yield { type: 'finish', reason: { kind: 'completed' } }
  } } }
  const { mood } = setup(t, { judge: true }, dsh)
  await mood.judge({ userText: '你真棒', reply: '嘿嘿', who: '主人', chatId: 'private:10001' })
  assert.equal(mood.state().reasonChat, 'private:10001')
  assert.match(mood.contextLine({ kind: 'private', chatId: 'private:10001' }), /因为被主人夸了/)
  assert.doesNotMatch(mood.contextLine({ kind: 'private', chatId: 'private:20002' }), /因为|被主人夸了/)
})

test('旧存档没有来源聊天：按聊天注入时不猜原因，面板/无 chat 调用仍可看到旧理由', (t) => {
  const { mood, file } = setup(t)
  writeFileSync(file, JSON.stringify({ value: 90, at: now - 60_000, reason: '旧事', history: [] }))
  assert.match(mood.contextLine(), /因为旧事/)
  assert.doesNotMatch(mood.contextLine({ kind: 'private', chatId: 'private:10001' }), /因为|旧事/)
})

test('模块事件把聊天和带 QQ 的说话人传给心情：主人私聊的原因不会出现在别人的私聊或群里', (t) => {
  const { cfg } = setup(t)
  const handlers = new Map()
  const mood = moodModule.setup({ config: () => cfg, log: {}, dsh: null,
    on: (event, handler) => handlers.set(event, handler),
    route: () => {},
  })
  const activity = handlers.get('activity')
  const promptOf = (chat) => handlers.get('prompt')([{ type: 'text', text: '你好' }], { chat }).at(-1).text
  activity({ kind: 'in', chatId: 'private:10001', userId: '10001', nickname: '若青木', text: '谢谢你，真棒', direct: true, owner: true })
  assert.match(mood.state().reason, /若青木说/)
  assert.match(promptOf({ kind: 'private', chatId: 'private:10001' }), /因为若青木说/)
  assert.doesNotMatch(promptOf({ kind: 'private', chatId: 'private:20002' }), /因为|若青木/)
  assert.doesNotMatch(promptOf({ kind: 'group', chatId: 'group:888' }), /因为|若青木/)

  // 群友的事件只进这个群，且同名群友靠 QQ 区分。
  activity({ kind: 'in', chatId: 'group:888', userId: '222', nickname: '小明', text: '爱你', direct: true, owner: false })
  assert.match(mood.state().reason, /小明\(222\)说/)
  assert.match(promptOf({ kind: 'group', chatId: 'group:888' }), /因为小明\(222\)说/)
  assert.doesNotMatch(promptOf({ kind: 'private', chatId: 'private:10001' }), /小明\(222\)/)

  activity({ kind: 'in', chatId: 'group:888', userId: '333', nickname: '小明', text: '真棒', direct: true, owner: false })
  assert.match(mood.state().reason, /小明\(333\)说/)
})
