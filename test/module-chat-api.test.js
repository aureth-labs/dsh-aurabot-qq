import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { normalize } from '../src/core/config.js'
import { createHub } from '../src/chat/hub.js'
import { confirmedChatDelivery } from '../src/chat/receipts.js'
import { buildWav } from '../src/voice/wav.js'

const OWNER = '10001', CHAT = `private:${OWNER}`, GROUP = 'group:555'
const ownerChat = { chatId: CHAT, kind: 'private', userId: OWNER, groupId: '', nickname: '主人' }
const groupChat = { chatId: GROUP, kind: 'group', userId: OWNER, groupId: '555', nickname: '主人' }
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
function setup(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-module-chat-'))
  const before = { data: process.env.AURABOT_DATA_DIR, workspace: process.env.AURABOT_WORKSPACE }
  process.env.AURABOT_DATA_DIR = dir; process.env.AURABOT_WORKSPACE = join(dir, 'workspace')
  const cfg = normalize({ enabled: true, dryRun: false, setupDone: true, ownerQQ: OWNER, botQQ: '20002',
    allow: { private: ['10002'], groups: ['555'] }, voice: { enabled: false },
    stickers: { enabled: false }, conversationContext: { enabled: true }, model: { vision: 'on' }, merge: { enabled: false } })
  const fake = createFakeDsh({ brain: async () => '' }), rows = [], calls = [], memory = [], activity = [], deliveries = []
  let muted = false
  const hub = createHub({ dsh: fake.ctx, getConfig: () => cfg,
    log: { info() {}, warn() {}, debug() {}, error() {} },
    onebot: { connected: true, async call(action, params) {
      calls.push({ action, params })
      return options.onebotCall ? options.onebotCall(action, params) : { message_id: calls.length }
    } },
    onMemoryCommand: (chat, text) => memory.push({ chat, text }), onActivity: (a) => activity.push(a),
    isMuted: () => muted, hooks: {
      journal: (row) => rows.push(row),
      deliveryScope: (chatId, personaId, botQQ) => ({ chatId, personaId, botQQ }),
      delivery: (chatId, messageId, scope) => {
        const receipt = confirmedChatDelivery(chatId, messageId, scope.botQQ)
        if (receipt) deliveries.push(receipt)
      },
      ...options.hooks,
    } })
  const off = fake.ctx.on('session/event', hub.onSessionEvent)
  t.after(() => {
    hub.dispose(); off(); fake.dispose()
    for (const [key, value] of [['AURABOT_DATA_DIR', before.data], ['AURABOT_WORKSPACE', before.workspace]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    rmSync(dir, { recursive: true, force: true })
  })
  return { hub, cfg, fake, rows, calls, memory, activity, deliveries, mute: (value) => { muted = value } }
}

test('流水通知与落盘同源：来源端标记不落盘，监听失败不影响写入，调试不通知', async (t) => {
  const s = setup(t)
  assert.equal(s.hub.logChat(CHAT, '主人', 'a'.repeat(600), OWNER, { via: 'external', originId: 'client-1', interaction: [OWNER, OWNER] }), true)
  assert.equal(s.rows.length, 1); assert.equal(s.rows[0].text.length, 500); assert.equal(s.rows[0].originId, 'client-1')
  assert.deepEqual(s.rows[0].interaction, [OWNER])
  const [day] = s.hub.chatLogDays(), [row] = s.hub.chatLogOf(day)
  assert.deepEqual(row, Object.fromEntries(Object.entries(s.rows[0]).filter(([k]) => k !== 'originId')))
  assert.equal('originId' in row, false)
  // sendText 只负责网关发送；正常回复由 deliver 统一记账，避免分条/语音重复落盘。
  const delivered = await s.hub.deliver(CHAT, '实际发出的消息')
  assert.equal(delivered.sent, '实际发出的消息')
  assert.deepEqual(s.calls, [{ action: 'send_private_msg', params: { user_id: Number(OWNER), message: [{ type: 'text', data: { text: '实际发出的消息' } }] } }])
  const replies = s.rows.filter((r) => r.who === 'bot')
  assert.equal(replies.length, 1)
  assert.equal(replies[0].text, '实际发出的消息')
  assert.deepEqual(s.hub.chatLogDays().flatMap((d) => s.hub.chatLogOf(d)).filter((r) => r.who === 'bot'), replies)
  const count = s.rows.length
  s.cfg.debug = true; s.hub.logChat(CHAT, '主人', '调试内容', OWNER)
  assert.equal(s.rows.length, count); assert.ok(!s.hub.chatLogOf(day).some((r) => r.text === '调试内容'))
  const other = setup(t, { hooks: { journal() { throw new Error('consumer failed') } } })
  assert.equal(other.hub.logChat(CHAT, 'bot', '落盘不回滚'), true)
  assert.equal(other.hub.chatLogOf(other.hub.chatLogDays()[0])[0].text, '落盘不回滚')
})

test('外部主人输入复用已有会话、原话档案、即时记忆和来源，群会话保留 social 权限', async (t) => {
  const s = setup(t)
  await s.hub.pushToSession(ownerChat, [{ type: 'text', text: '准备' }], OWNER)
  const sid = s.hub.sessions()[CHAT].sessionId
  let checks = 0
  assert.deepEqual(await s.hub.receiveOwnerMessage(CHAT, { text: '记住：喜欢蓝色', via: 'companion', originId: 'source-1', assertAuthorized: () => { checks++ } }), { ok: true })
  const turn = s.fake.turns.at(-1)
  assert.equal(turn.sessionId, sid); assert.equal(turn.source.speaker.role, 'owner'); assert.ok(checks >= 3)
  assert.ok(s.hub.recentMessagesOf(CHAT).some((r) => r.text.includes('喜欢蓝色')))
  assert.ok(s.memory.some((m) => m.text === '记住：喜欢蓝色'))
  const row = s.rows.find((r) => r.text === '记住：喜欢蓝色')
  assert.equal(row.via, 'companion'); assert.equal(row.originId, 'source-1'); assert.equal(row.uid, OWNER)
  assert.ok(s.activity.some((a) => a.kind === 'in' && a.owner && a.text.includes('喜欢蓝色')))
  await s.hub.pushToSession(groupChat, [{ type: 'text', text: '群准备' }], OWNER)
  const groupSid = s.hub.sessions()[GROUP].sessionId
  await s.hub.receiveOwnerMessage(GROUP, { text: '来自外部的群消息', via: 'companion' })
  assert.equal(s.fake.turns.at(-1).sessionId, groupSid); assert.equal(s.fake.turns.at(-1).preset, 'aurabot-social')
  assert.equal(s.fake.turns.at(-1).source.speaker.chat, 'group')
  assert.equal(s.fake.turns.at(-1).source.speaker.role, 'owner'); assert.equal(Object.keys(s.hub.sessions()).length, 2)
  await assert.rejects(s.hub.receiveOwnerMessage('private:999', { text: '不创建会话' }), { status: 404 })
  await assert.rejects(s.hub.receiveOwnerMessage('system:other', { text: '不创建系统会话' }), { status: 404 })
  s.cfg.allow.groups = []
  await assert.rejects(s.hub.receiveOwnerMessage(GROUP, { text: '不绕白名单' }), { status: 403 })
  s.mute(true)
  await assert.rejects(s.hub.receiveOwnerMessage(CHAT, { text: '不绕暂停' }), { status: 403 })
  s.mute(false); s.cfg.enabled = false
  await assert.rejects(s.hub.receiveOwnerMessage(CHAT, { text: '不绕总开关' }), { status: 503 })
})

test('已确认的 OneBot 送达使用稳定来源 ID，模拟或失败不会产生回执', async (t) => {
  let failed = false, current = true
  const s = setup(t, { onebotCall: async () => {
    if (failed) throw new Error('fixture transport failed')
    return { message_id: -123 }
  } })
  const message = [{ type: 'text', data: { text: '送达测试' } }]
  await s.hub.sendSegments(CHAT, message, '测试')
  await s.hub.sendSegments(CHAT, message, '测试')
  assert.equal(s.deliveries.length, 2)
  const first = s.deliveries[0]
  assert.equal(first.status, 'confirmed')
  assert.equal(first.messageId, '-123')
  assert.equal(first.chatId, CHAT)
  assert.equal(first.platform, 'qq')
  assert.equal(s.deliveries[1].originId, first.originId)
  assert.ok(Object.isFrozen(first))
  assert.equal('text' in first, false)
  const captured = await s.hub.capture(() => s.hub.sendSegments(CHAT, message, '模拟'), { simulate: true })
  assert.equal(captured.sent.closed, true, '模拟结束后捕获上下文必须作废')
  s.cfg.dryRun = true
  await s.hub.sendSegments(CHAT, message, '不发送')
  s.cfg.dryRun = false
  await s.hub.sendSegments(CHAT, message, '敏感', { sensitive: true })
  failed = true
  await s.hub.sendSegments(CHAT, message, '失败', { quiet: true })
  failed = false
  await s.hub.sendSegments(CHAT, message, '迟到', { isCurrent: () => {
    const before = current
    current = false
    return before
  } })
  assert.equal(s.deliveries.length, 2)
})

test('QQ 入站流水通知提供来源 ID，原生日志保留原字段', async (t) => {
  const s = setup(t)
  await s.hub.onMessage({
    post_type: 'message', message_type: 'private', sub_type: 'friend',
    self_id: 20002, user_id: Number(OWNER), message_id: 9988,
    sender: { user_id: Number(OWNER), nickname: '主人' },
    message: [{ type: 'text', data: { text: '入站来源测试' } }],
  })
  const row = s.rows.find((entry) => entry.text === '入站来源测试')
  assert.equal(row.originId, JSON.stringify(['in', CHAT, '20002', '9988']))
  const logged = s.hub.chatLogOf(s.hub.chatLogDays()[0]).find((entry) => entry.text === row.text)
  assert.equal('originId' in logged, false)
})

test('外部 WAV 直接走既有 DSH 识别，不调用 QQ 音频接口；撤销期间不写迟到流水或提交模型', async (t) => {
  const s = setup(t)
  await s.hub.pushToSession(ownerChat, [{ type: 'text', text: '准备' }], OWNER)
  const wav = buildWav(new Int16Array(160), 16000)
  let seen = false
  s.fake.ctx.services.speechToText = { resolve: ({ audio }) => { seen = Buffer.from(audio).equals(wav); return {} }, transcribe: async () => '外部语音内容' }
  await s.hub.receiveOwnerMessage(CHAT, { wav })
  assert.equal(seen, true); assert.ok(s.fake.turns.at(-1).userText.includes('外部语音内容'))
  assert.ok(!s.calls.some((c) => ['get_record', 'fetch_ptt_text'].includes(c.action)))
  const gate = deferred(), entered = deferred()
  s.fake.ctx.services.speechToText.transcribe = () => { entered.resolve(); return gate.promise }
  let authorized = true
  const pending = s.hub.receiveOwnerMessage(CHAT, { wav, assertAuthorized: () => { if (!authorized) throw Object.assign(new Error('revoked'), { status: 401 }) } })
  await entered.promise; authorized = false; gate.resolve('迟到输入')
  await assert.rejects(pending, { status: 401 })
  assert.ok(!s.rows.some((r) => r.text.includes('迟到输入'))); assert.ok(!s.fake.turns.some((r) => r.userText.includes('迟到输入')))
})

test('异步 prompt 准备期间撤销身份，投递前再次鉴权；旧主人在途输入不能交给新主人会话', async (t) => {
  let block = false
  const entered = deferred(), gate = deferred()
  const s = setup(t, { hooks: { prompt: async (content) => { if (block) { entered.resolve(); await gate.promise }; return content } } })
  await s.hub.pushToSession(ownerChat, [{ type: 'text', text: '准备' }], OWNER)
  block = true
  const pending = s.hub.receiveOwnerMessage(CHAT, { text: '异步输入' })
  await entered.promise; s.cfg.ownerQQ = '10009'; gate.resolve()
  await assert.rejects(pending, { status: 503 })
  assert.ok(!s.fake.turns.some((r) => r.userText.includes('异步输入')))
})
