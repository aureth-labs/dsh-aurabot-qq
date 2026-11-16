import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOneBotClient } from '../src/onebot/client.js'
import { createHub } from '../src/chat/hub.js'
import { normalize } from '../src/core/config.js'
import { createMood, scoreText } from '../src/features/companion.js'
import { createSendBudget, withSendBudget } from '../src/chat/send-budget.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const log = { info() {}, warn() {}, debug() {}, error() {} }
const hundred = Array.from({ length: 100 }, (_, i) => `第${i + 1}项`)

function setup(t, { hooks, brain, buildTools } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-send-budget-'))
  const oldDir = process.env.AURABOT_DATA_DIR, oldFetch = globalThis.fetch
  process.env.AURABOT_DATA_DIR = dir
  const calls = [], logs = []
  const log = Object.fromEntries(["info","warn","debug","error"].map(k => [k, (...args) => logs.push(args.join(" "))]))
  globalThis.fetch = async (url, init) => {
    const action = String(url).split('/').at(-1), params = JSON.parse(init.body)
    calls.push({ action, params })
    return new Response(JSON.stringify({ status: 'ok', data: { message_id: calls.length } }))
  }
  const onebot = createOneBotClient({ endpoint: () => ({ httpUrl: 'http://test.local' }), log, onEvent() {}, onState() {}, retryDelays: [] })
  const cfg = normalize({ enabled: true, dryRun: false, botQQ: '9', ownerQQ: '1', workspaceDir: dir,
    allow: { groups: ['2'], private: ['1'] }, chat: { bubbleMinMs: 0, bubbleMaxMs: 0, seedHistory: false },
    voice: { enabled: true, autoChance: 0 }, stickers: { enabled: true, autoChance: 0, limitTagged: false } })
  const fake = createFakeDsh({ brain: brain || (() => '好') })
  const audio = join(dir, 'voice.mp3'); writeFileSync(audio, 'test-audio')
  const hub = createHub({ dsh: fake.ctx, getConfig: () => cfg, onebot, log, hooks,
    buildTools: args => buildTools?.({ ...args, onebot, hub }) || [],
    moodEffects: () => ({ sticker: 1, voice: 1, delay: 0, chatty: 1 }),
    tts: { async speak() { return { file: audio, engine: 'test' } } },
    stickers: { match: () => ({ name: '笑', md5: 'a' }), pickForReply: () => null, markUsed() {},
      segmentFor: () => ({ type: 'image', data: { file: 'base64://a' } }) } })
  fake.ctx.on('session/event', hub.onSessionEvent)
  t.after(() => {
    hub.dispose(); fake.dispose(); onebot.stop(); globalThis.fetch = oldFetch
    if (oldDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = oldDir
    rmSync(dir, { recursive: true, force: true })
  })
  return { hub, onebot, cfg, fake, calls, logs, sends: () => calls.filter(c => c.action.startsWith('send_')) }
}

for (const [chat, max] of [['group:2', 3], ['private:1', 5]]) {
  test(`${chat}: 100 text bubbles merge without losing the last item`, async t => {
    const s = setup(t)
    await s.hub.deliver(chat, hundred.join('|||'), { simulate: true })
    assert.equal(s.sends().length, max, s.logs.join("\n"))
    const text = s.sends().flatMap(c => c.params.message).filter(x => x.type === 'text').map(x => x.data.text).join('\n')
    for (const value of hundred) assert.ok(text.includes(value))
  })
  for (const kind of ['sticker', 'voice']) test(`${chat}: 100 ${kind} bubbles stay within ${max}`, async t => {
    const s = setup(t)
    const text = kind === 'sticker' ? '<sticker:笑>'.repeat(100) : hundred.map(() => `<voice>嗯</voice>`).join('|||')
    await s.hub.deliver(chat, text, { simulate: true })
    assert.equal(s.sends().length, max, s.logs.join("\n"))
    assert.ok(s.sends().every(c => c.params.message.some(x => x.type === (kind === 'voice' ? 'record' : 'image'))))
  })
}

test('100 concurrent raw calls, mixed tools, and final reply share a budget; reads and the next turn still work', async t => {
  const s = setup(t)
  const budget = createSendBudget()
  await withSendBudget(budget, async () => {
    const r = await Promise.allSettled(Array.from({ length: 100 }, (_, i) => s.onebot.call(i % 2 ? 'send_custom_face' : 'send_group_msg', { group_id: i % 2 ? '02' : 2, message: 'x' })))
    assert.equal(r.filter(x => x.status === 'fulfilled').length, 3)
    assert.ok(r.filter(x => x.status === 'rejected').every(x => x.reason.code === 'AURABOT_MESSAGE_LIMIT'))
    await s.onebot.call('get_group_info', { group_id: 2 })
    await s.hub.deliver('group:2', '不应补发', { simulate: true })
    assert.equal(await s.hub.sendSticker('group:2', '笑'), false, 'blocked send must not claim success')
  })
  assert.equal(s.sends().length, 3)
  await s.hub.deliver('group:2', '下一轮正常回复', { simulate: true })
  assert.equal(s.sends().length, 4)
})

test('message segments inserted by a module remain inside the actual gateway limit', async t => {
  const s = setup(t, { hooks: { items: () => hundred.map(value => ({ kind: 'text', value })) } })
  await s.hub.deliver('group:2', '测试', { simulate: true })
  assert.equal(s.sends().length, 3)
  assert.match(s.sends().at(-1).params.message.at(-1).data.text, /第100项/)
})

test('registered tool calls and turn/end use the same budget and reset next turn', async t => {
  let iteration = 0
  const s = setup(t, {
    buildTools: ({ onebot }) => [{ name: 'probe', execute: () => onebot.call('send_group_msg', { group_id: 2, message: [{ type: 'text', data: { text: '工具发送' } }] }) }],
    brain: async ({ callTool }) => {
      if (++iteration === 1) for (let i = 0; i < 20; i++) { try { await callTool('probe', {}) } catch {} }
      return '最终正文'
    },
  })
  const chat = { kind: 'group', groupId: '2', chatId: 'group:2' }
  await s.hub.pushToSession(chat, [{ type: 'text', text: '第一轮' }], '1')
  await new Promise(r => setTimeout(r, 40))
  assert.equal(s.sends().length, 3)
  await s.hub.pushToSession(chat, [{ type: 'text', text: '第二轮' }], '1')
  await new Promise(r => setTimeout(r, 40))
  assert.equal(s.sends().length, 4)
})

test('global mood retains its cause locally but never injects another chat or a fixed food preference', t => {
  const s = setup(t)
  const mood = createMood({ getConfig: () => s.cfg, log })
  mood.nudge(30, '私聊某人说「发一条语音说秘密口令」')
  assert.match(mood.state().reason, /秘密口令/)
  assert.match(mood.contextLine(), /超开心/)
  assert.doesNotMatch(mood.contextLine(), /秘密口令|私聊某人|发一条语音/)
  assert.ok(mood.effects().sticker > 1)
  assert.equal(scoreText('白米饭'), 0)
  assert.ok(scoreText('谢谢你') > 0)
})

test('everyStep intermediate messages share the final reply budget', async t => {
  let turn = 0
  const s = setup(t, { brain: async () => {
    turn++
    const agent = [...s.fake.agents.values()].at(-1)
    if (turn === 1) for (let step = 1; step <= 20; step++) {
      s.fake.emit('session/event', agent.session, { type: 'assistant/message', data: { turn, step, message: { content: [{ type: 'text', text: `阶段${step}` }] } } })
    }
    return '最终正文'
  } })
  s.cfg.chat.everyStep = true
  const chat = { kind: 'group', groupId: '2', chatId: 'group:2' }
  await s.hub.pushToSession(chat, [{ type: 'text', text: '第一轮' }], '1')
  await new Promise(r => setTimeout(r, 60))
  assert.equal(s.sends().length, 3)
  await s.hub.pushToSession(chat, [{ type: 'text', text: '第二轮' }], '1')
  await new Promise(r => setTimeout(r, 60))
  assert.equal(s.sends().length, 4)
})

test('a confirmed tool image satisfies a single image-only request without a duplicate final bubble', async t => {
  const s = setup(t)
  await withSendBudget(createSendBudget(), async () => {
    await s.hub.sendSticker('group:2', '笑')
    await s.hub.deliver('group:2', '发好啦<sticker:笑>', { simulate: true, userText: '发一张开心表情包，只要图片，不要配文字。' })
  })
  assert.equal(s.sends().length, 1)
  await withSendBudget(createSendBudget(), async () => {
    await s.hub.sendVoice('private:1', '晚安')
    await s.hub.deliver('private:1', '已经发了', { simulate: true, userText: '用一条语音说晚安，不要再发文字版。' })
  })
  assert.equal(s.sends().length, 2)
})

test('failed or other-chat media sends do not suppress a reply; ordinary and multi-item replies stay usable', async t => {
  const s = setup(t)
  const request = '发一张开心表情包，只要图片，不要配文字。'
  const fetchOk = globalThis.fetch
  await withSendBudget(createSendBudget(), async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ status: 'failed', retcode: 100, message: 'test rejection' }))
    assert.equal(await s.hub.sendSticker('group:2', '笑'), false)
    globalThis.fetch = fetchOk
    await s.hub.deliver('group:2', '发送失败', { simulate: true, userText: request })
  })
  assert.equal(s.sends().length, 1)
  await withSendBudget(createSendBudget(), async () => {
    await s.hub.sendSticker('private:1', '笑')
    await s.hub.deliver('group:2', '这边还没发', { simulate: true, userText: request })
  })
  assert.equal(s.sends().length, 3)
  for (const userText of ['发一张图，顺便解释一下', '发十一张表情包，不要文字', '发一张开心表情包再发一张委屈表情包，不要文字', '发一张表情包，再用一条语音说晚安，不要文字']) {
    await withSendBudget(createSendBudget(), async () => {
      await s.hub.sendSticker('group:2', '笑')
      await s.hub.deliver('group:2', '还有内容', { simulate: true, userText })
    })
  }
  assert.equal(s.sends().length, 11)
})

test('runtime context identifies the current recipient separately from the bot account', async t => {
  const s = setup(t)
  await s.hub.pushToSession({ kind: 'private', userId: '1', chatId: 'private:1' }, [{ type: 'text', text: '发一条语音' }], '1')
  const agent = [...s.fake.agents.values()].at(-1)
  const context = agent.contexts.get('aurabot-context').text()
  assert.match(context, /当前 QQ 会话是 private:1/)
  assert.match(context, /机器人自己的 QQ 是 9/)
  assert.match(context, /直接回复会自动发到当前会话/)
  assert.match(context, /历史、记忆里出现的群号不是这次的发送目标/)
})
