// 跨聊天语音：真实 hub + 假 TTS/OneBot，不联网、不发送 QQ 消息。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import qqTools from '../src/modules/qq-tools/index.js'
import { createHub } from '../src/chat/hub.js'
import { hasInvalidVoiceMarkup } from '../src/chat/reply.js'
import { normalize } from '../src/core/config.js'
import { scopeCoreForModule } from '../src/core/modules.js'
import { OneBotError } from '../src/onebot/client.js'

function setup(t, { patch = {}, synthFails = false, sendFails = false, outbox, hooks, level = 'full', kind = 'private' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-cross-voice-'))
  const old = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const file = join(dir, 'voice.wav')
  writeFileSync(file, 'test audio')
  const calls = [], spoken = []
  const cfg = normalize({ enabled: true, dryRun: false, ownerQQ: '1', allow: { groups: ['9'], private: [] }, workspaceDir: dir,
    voice: { enabled: true, autoChance: 0 }, stickers: { enabled: false }, ...patch })
  const onebot = { async call(action, params) {
    calls.push({ action, params })
    if (sendFails) throw sendFails
    return { message_id: calls.length }
  } }
  const hub = createHub({ dsh: {}, getConfig: () => cfg, onebot, outbox, hooks,
    log: Object.fromEntries(['info', 'warn', 'debug', 'error'].map(k => [k, () => {}])),
    stickers: { match: () => null, segmentFor: () => null, pickForReply: () => null, markUsed: () => {} },
    moodEffects: () => ({ voice: 1, sticker: 1, delay: 0 }),
    tts: { async speak(text) { spoken.push(text); if (synthFails) throw new Error('secret/local/path'); return { file, engine: 'test' } } },
  })
  let build
  qqTools.setup({ core: scopeCoreForModule({ hub, onebot }, 'qq-tools'), config: () => cfg, tool: fn => { build = fn } })
  const tool = build({ chat: { kind, chatId: kind === 'private' ? 'private:1' : 'group:8' }, level, sessionId: 's' }).find(x => x.name === 'qq_send_message')
  t.after(() => { hub.dispose(); if (old === undefined) delete process.env.AURABOT_DATA_DIR; else process.env.AURABOT_DATA_DIR = old; rmSync(dir, { recursive: true, force: true }) })
  return { tool, hub, calls, spoken }
}
const types = s => s.calls.flatMap(c => c.params.message || []).map(x => x.type)
const send = (s, args) => s.tool.execute({ target: 'group:9', ...args })

test('voice=true 长正文直接发到目标群，不依赖标签和300字兜底，也不改变下一次私聊', async t => {
  const s = setup(t)
  const body = Array.from({ length: 30 }, (_, i) => `第${i + 1}点，给群里的朋友解释一下。`).join('')
  assert.ok(body.length > 300)
  const r = await send(s, { text: body, voice: true })
  assert.equal(r.ok, true); assert.deepEqual(r.sentTypes, ['record']); assert.match(r.message, /已发送：语音/)
  assert.equal(s.calls[0].params.group_id, 9); assert.equal(s.spoken[0], body)
  await s.hub.deliver('private:1', '群里的事情处理好了')
  assert.deepEqual(types(s), ['record', 'text'])
})

test('旧的正确语音标签仍可发送，普通文字不变', async t => {
  const s = setup(t)
  assert.deepEqual((await send(s, { text: '<voice>晚上好</voice>' })).sentTypes, ['record'])
  assert.deepEqual((await send(s, { text: '晚上好', voice: false })).sentTypes, ['text'])
})

test('原始错误闭合标签在发送前拒绝；改用voice=true后同一工具仍能正常发送', async t => {
  const s = setup(t)
  const r = await send(s, { text: '<voice>这个罐头是什么</</text>' })
  assert.equal(r.ok, false); assert.match(r.message, /还没有发送/); assert.equal(s.calls.length, 0); assert.equal(s.spoken.length, 0)
  assert.equal((await send(s, { text: '这个罐头是什么', voice: true })).ok, true)
})

test('半条正确半条错误时不先发第一条；嵌套、跨气泡、缺结束及大小写错误都拦下', async t => {
  const s = setup(t)
  for (const text of ['先发这句|||<voice>坏了', '<voice>一<voice>二</voice></voice>', '<voice>一|||二</voice>', '你好</voice>', '<VOICE>你好</VOICE>', '<voice><VOICE>你好</VOICE></voice>', '<voice 你好']) {
    assert.equal((await send(s, { text })).ok, false, text)
  }
  assert.equal(s.calls.length, 0)
})

test('语音标签校验不拦代码示例、普通尖括号或正确混排', () => {
  for (const text of ['示例：`<voice>`', '```xml\n<voice>\n```', 'a < b', '<b>正文</b>', '你好|||<voice>晚安</voice>', '<voice>一</voice><voice>二</voice>']) assert.equal(hasInvalidVoiceMarkup(text), false, text)
})

test('显式语音参数只收布尔值和正文；不把标签或分隔符念出来', async t => {
  const s = setup(t)
  for (const args of [{ voice: 'true', text: '你好' }, { voice: true, text: '<voice>你好</voice>' }, { voice: true, text: '你好|||晚安' }]) assert.equal((await send(s, args)).ok, false)
  assert.equal(s.calls.length, 0)
})

for (const scenario of ['合成失败', '语音关闭']) test(`${scenario}改发文字时回执不能声称语音成功`, async t => {
  const s = setup(t, scenario === '合成失败' ? { synthFails: true } : { patch: { voice: { enabled: false } } })
  const r = await send(s, { text: '晚上好', voice: true })
  assert.equal(r.ok, true); assert.deepEqual(types(s), ['text']); assert.deepEqual(r.sentTypes, ['text'])
  assert.match(r.message, /没有发出语音/); assert.doesNotMatch(r.message, /secret|local\/path/)
})

test('发送超时不重复发送、不回退文字、不误报成功', async t => {
  const s = setup(t, { sendFails: new Error('timeout secret/local/path') })
  const r = await send(s, { text: '晚上好', voice: true })
  assert.equal(r.ok, false); assert.equal(s.calls.length, 1); assert.deepEqual(r.sentTypes, [])
  assert.match(r.message, /未确认/); assert.doesNotMatch(r.message, /secret|local\/path/)
})

test('入补发队列不是已经送达，不诱导重复发送', async t => {
  const queued = []
  const s = setup(t, { sendFails: new OneBotError('send_group_msg', { status: 'failed', message: 'offline' }), outbox: { add(x) { queued.push(x); return { ok: true, id: 'q1' } } } })
  const r = await send(s, { text: '晚上好', voice: true })
  assert.equal(r.ok, true); assert.deepEqual(r.sentTypes, []); assert.deepEqual(r.queuedTypes, ['record'])
  assert.match(r.message, /尚未确认送达/); assert.equal(queued.length, 1)
})

for (const patch of [{ dryRun: true }, { enabled: false }]) test(`没真实发送时不能报成功 ${JSON.stringify(patch)}`, async t => {
  const s = setup(t, { patch })
  const r = await send(s, { text: '晚上好' })
  assert.equal(r.ok, false); assert.equal(s.calls.length, 0)
})

test('回执以最终出站段为准：发送钩子将语音换成文字', async t => {
  const s = setup(t, { hooks: { send: () => [{ type: 'text', data: { text: '替换后的文字' } }] } })
  const r = await send(s, { text: '晚上好', voice: true })
  assert.deepEqual(r.sentTypes, ['text']); assert.match(r.message, /没有发出语音/)
})

test('发送钩子拦下时不能报成功', async t => {
  const s = setup(t, { hooks: { send: () => null } })
  assert.equal((await send(s, { text: '晚上好', voice: true })).ok, false)
  assert.equal(s.calls.length, 0)
})

test('白名单、当前聊天限制和群聊主人权限保持生效', async t => {
  const s = setup(t)
  assert.equal((await s.tool.execute({ target: 'group:99', text: '晚上好', voice: true })).ok, false)
  assert.equal((await s.tool.execute({ target: 'private:1', text: '晚上好', voice: true })).ok, false)
  assert.equal(s.calls.length, 0)
  const group = setup(t, { kind: 'group', level: 'social' })
  assert.equal((await send(group, { text: '晚上好', voice: true })).ok, false)
  assert.equal(group.calls.length, 0)
})

test('原有私聊戳一戳仍报告实际成功，不误判成没发', async t => {
  const s = setup(t, { patch: { allow: { private: ['2'], groups: ['9'] } } })
  const r = await s.tool.execute({ target: 'private:2', text: '<poke>' })
  assert.equal(r.ok, true); assert.deepEqual(r.sentTypes, ['poke'])
  assert.equal(s.calls[0].action, 'send_poke')
})

test('同一条旧格式消息语音和文字混排，回执保留两种实际类型', async t => {
  const s = setup(t)
  const r = await send(s, { text: '<voice>晚上好</voice>|||这条是文字说明' })
  assert.equal(r.ok, true); assert.deepEqual(new Set(r.sentTypes), new Set(['record', 'text']))
})

test('模块包装层保留第三个发送参数，普通旧调用仍能使用', async () => {
  const calls = []
  const core = { hub: { subagentFor() {}, deliver: (...args) => { calls.push(args); return { sent: 'ok' } } } }
  const scoped = scopeCoreForModule(core, 'test-module')
  await scoped.hub.deliver('group:9', '你好', { voice: true, own: true })
  assert.deepEqual(calls[0], ['group:9', '你好', { voice: true, own: true, sourceModule: 'test-module' }])
  await scoped.hub.deliver('group:9', '普通消息')
  assert.deepEqual(calls[1], ['group:9', '普通消息', { sourceModule: 'test-module' }])
  const policy = { reserve() {} }
  await scoped.hub.deliver('group:9', '引擎消息', { enginePolicy: policy })
  assert.equal(calls[2][2].enginePolicy, policy)
})

test('显式语音仍清理模型残片和Markdown，沉默不合成', async t => {
  const s = setup(t)
  const r = await send(s, { voice: true, text: 'm00896b **晚上好**' })
  assert.equal(r.ok, true); assert.equal(s.spoken[0], '晚上好')
  const empty = await send(s, { voice: true, text: '[沉默]' })
  assert.equal(empty.ok, false); assert.equal(s.calls.length, 1)
})

test('两个目标并发投递的回执不串台', async t => {
  const s = setup(t, { patch: { allow: { groups: ['9'], private: ['2'] } } })
  const [voice, text] = await Promise.all([
    send(s, { text: '晚上好', voice: true }),
    s.tool.execute({ target: 'private:2', text: '文字说明' }),
  ])
  assert.deepEqual(voice.sentTypes, ['record']); assert.deepEqual(text.sentTypes, ['text'])
})


test('跨聊天发送抛异常也不透传路径或代码，不自动重发',async()=>{
  let build, calls=0
  qqTools.setup({core:{hub:{deliver:async()=>{calls++;throw Error('ENOENT /home/private/voice.js at send()')}},onebot:{}},config:()=>normalize({ownerQQ:'1',allow:{groups:['9']}}),tool:f=>build=f,log:{warn(){}}})
  const tool=build({chat:{kind:'private',chatId:'private:1'},level:'full',sessionId:'s'}).find(t=>t.name==='qq_send_message')
  const r=await tool.execute({target:'group:9',text:'你好',voice:true})
  assert.equal(r.ok,false);assert.match(r.message,/发送结果未确认/);assert.doesNotMatch(r.message,/private|ENOENT|voice\.js|send\(\)/);assert.equal(calls,1)
})

test('跨群两条语音：多写一个分隔竖线不会夹带 | 消息，回执只报告语音', async t => {
  const s = setup(t)
  const r = await send(s, { text: '<voice>第一条语音</voice>||||<voice>第二条语音</voice>' })
  assert.equal(r.ok, true); assert.deepEqual(r.sentTypes, ['record'])
  assert.deepEqual(types(s), ['record', 'record'])
  assert.deepEqual(s.spoken, ['第一条语音', '第二条语音'])
})
