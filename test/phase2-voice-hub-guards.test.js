import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { makeTestIdentity } from './helpers/identity.js'
import { normalize } from '../src/core/config.js'
import { createTitleFilter } from '../src/chat/title-filter.js'
import { buildActPrompt } from '../src/autotelic/exec.js'
import voiceModule from '../src/modules/voice/index.js'

function makeWavBuffer(durationMs = 50, sampleRate = 16000) {
  const numSamples = Math.max(1, Math.floor((sampleRate * durationMs) / 1000))
  const dataSize = numSamples * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16) // PCM fmt chunk size
  buf.writeUInt16LE(1, 20)  // audio format PCM
  buf.writeUInt16LE(1, 22)  // mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28) // byteRate
  buf.writeUInt16LE(2, 32)  // blockAlign
  buf.writeUInt16LE(16, 34) // bitsPerSample
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataSize, 40)
  return buf
}

const until = async (predicate, ms = 3000) => {
  const deadline = Date.now() + ms
  while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
}

test('PR-2F: buildActPrompt 不含 onebot 或 QQ 平台专有字样', () => {
  const prompt = buildActPrompt({ goal: '整理今天的心情', plan: '先看日记再写一句反思' }, ['diary', 'memory'])
  assert.doesNotMatch(prompt, /onebot|QQ/i)
})

test('PR-2F: 飞书入站语音走 gateway.fetch -> DSH 本地识别，不调 QQ fetch_ptt_text / get_record', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-p2f-voice-'))
  const prevData = process.env.AURABOT_DATA_DIR
  const prevWs = process.env.AURABOT_WORKSPACE
  process.env.AURABOT_DATA_DIR = join(root, 'data')
  process.env.AURABOT_WORKSPACE = join(root, 'ws')

  const { createHub } = await import('../src/chat/hub.js')
  const cfg = normalize({
    enabled: true,
    dryRun: false,
    setupDone: true,
    ownerQQ: '10000001',
    botQQ: '20000002',
    allow: { groups: ['oc_g1'], private: ['ou_owner'] },
    merge: { enabled: false },
    voice: { enabled: true, asr: true },
    stickers: { enabled: false, collect: false, reactChance: 0 },
    chat: { seedHistory: true },
    model: { vision: 'off' },
  })
  const promptsSeen = []
  const fake = createFakeDsh({
    brain: async ({ text }) => {
      promptsSeen.push(text)
      return '<poke>'
    },
  })
  const sttSpecs = []
  const dshWithStt = {
    ...fake.ctx,
    get(name) {
      if (name === 'speechToText') {
        return {
          snapshot: () => ({ selection: { providerId: 'sensevoice' }, providers: [{ id: 'sensevoice', preparation: { phase: 'ready' } }] }),
          resolve: ({ audio }) => { sttSpecs.push(audio); return { audio } },
          transcribe: async () => ({ text: '飞书语音内容测试' }),
        }
      }
      return fake.ctx.get(name)
    },
  }

  const onebotCalls = []
  const gwFetches = []
  const gwSends = []
  const identity = makeTestIdentity('ou_owner', 'feishu')
  const wav = makeWavBuffer(50, 16000)

  const gateway = {
    selfAccount: (cid) => (String(cid).startsWith('feishu') ? 'cli_bot' : '20000002'),
    caps: (cid) => (String(cid).startsWith('feishu')
      ? { voice: 'native', file: true, image: true, poke: false, typing: false, history: false, stickers: false, forward: 'none', reaction: false }
      : { voice: 'native', file: true, image: true, poke: true, typing: true, history: true }),
    features: (cid) => (String(cid).startsWith('feishu')
      ? { 'media.fetch': true, 'chat.typing': false, 'message.history.read': false, 'message.reaction': false, 'sticker.collect': false }
      : { 'media.fetch': true, 'chat.typing': true, 'message.history.read': true, 'message.reaction': true, 'sticker.collect': true }),
    fetch: async (chatId, req) => {
      gwFetches.push({ chatId, req })
      return { bytes: wav }
    },
    send: async (out) => {
      gwSends.push(out)
      return { messageId: 'om_out_' + gwSends.length }
    },
    noteSeen() {},
  }

  const hub = createHub({
    dsh: dshWithStt,
    getConfig: () => cfg,
    identity,
    routeOwner: identity.routeOwner,
    defaultPlatform: 'qq',
    gateway,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    onebot: {
      connected: true,
      async call(action, params) {
        onebotCalls.push({ action, params })
        return { message_id: onebotCalls.length }
      },
    },
  })
  const off = fake.ctx.on('session/event', hub.onSessionEvent)
  t.after(() => {
    hub.dispose(); off(); fake.dispose()
    if (prevData === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prevData
    if (prevWs === undefined) delete process.env.AURABOT_WORKSPACE
    else process.env.AURABOT_WORKSPACE = prevWs
  })

  await hub.onGatewayMessage({
    id: 'evt-v1',
    platform: 'feishu',
    instance: 'feishu',
    chatId: 'feishu:private:ou_owner',
    kind: 'private',
    chat: { id: 'ou_owner', kind: 'private', name: '主人' },
    sender: { account: 'ou_owner', name: '主人', isOwner: true, person: identity.owner() },
    messageId: 'om_voice_in_1',
    at: Date.now(),
    text: '',
    parts: [{ type: 'voice', media: { id: 'om_audio_file_1', mime: 'audio/wav' } }],
  })
  await until(() => fake.turns.length >= 1)
  await new Promise((r) => setTimeout(r, 40))

  // 1) 验证确实通过 gateway.fetch 拉取媒体并走 DSH STT 转写进提示词
  assert.equal(gwFetches.length, 1)
  assert.equal(gwFetches[0].req.kind, 'media')
  assert.equal(gwFetches[0].req.media.id, 'om_audio_file_1')
  assert.equal(gwFetches[0].req.media.messageId, 'om_voice_in_1')
  assert.equal(sttSpecs.length, 1)
  assert.ok(fake.turns[0].userText.includes('[语音] 飞书语音内容测试'))

  // 2) 验证 lastInboundVoice 已记录最新飞书入站语音
  const recent = hub.lastInboundVoice({ chatId: 'feishu:private:ou_owner' })
  assert.ok(recent)
  assert.equal(recent.platform, 'feishu')
  assert.equal(recent.messageId, 'om_voice_in_1')

  // 3) 验证未触碰任何 QQ/OneBot 专属动作（fetch_ptt_text / get_record / send_poke / set_input_status / get_friend_msg_history / set_msg_emoji_like）
  // 注意：允许 init/refreshFriends 调用一次 get_friend_list（若触发）；但其它平台动作一个不许有
  const forbidden = onebotCalls.filter((c) => ['fetch_ptt_text', 'get_record', 'send_poke', 'set_input_status', 'get_friend_msg_history', 'set_msg_emoji_like'].includes(c.action))
  assert.deepEqual(forbidden, [], `飞书语音回合不应调用 OneBot 动作：${JSON.stringify(forbidden)}`)
})

test('PR-2F: /voice/asr-last 优先读取最近入站语音，无缓存时按平台能力明确降级', async () => {
  const routes = new Map()
  let lastVoice = null
  let instances = []
  let featuresMap = {}
  const sttReady = {
    snapshot: () => ({ selection: { providerId: 'sv' }, providers: [{ id: 'sv', preparation: { phase: 'ready' } }] }),
    resolve: () => ({}),
    transcribe: async () => ({ text: 'ok' }),
  }

  voiceModule.setup({
    config: () => ({ voice: {} }),
    route: (path, fn) => routes.set(path, fn),
    every() {},
    core: {
      dsh: { get: (k) => (k === 'speechToText' ? sttReady : null) },
      hub: {
        lastInboundVoice: () => lastVoice,
        localTranscribe: async (_seg, _wav, msg) => (msg?.platform === 'feishu' ? '飞书最近语音转写' : ''),
      },
      gateway: {
        instances: () => instances,
        features: (cid) => featuresMap[cid] || { 'media.fetch': true, 'message.history.read': true },
      },
      identity: makeTestIdentity('ou_owner', 'feishu'),
      http: { body: async () => ({}) },
    },
  })

  const asrLast = routes.get('/voice/asr-last')
  assert.ok(asrLast)

  // 1) 离线状态明确降级
  const offRes = await asrLast({})
  assert.deepEqual({ ok: offRes.ok, degraded: offRes.degraded, reason: offRes.reason }, { ok: false, degraded: true, reason: 'offline' })

  // 2) 仅飞书连接且无最近入站语音 -> no-history-support 降级
  instances = [{ instance: 'feishu', platform: 'feishu', enabled: true, state: 'connected', caps: { history: false } }]
  const noHistRes = await asrLast({})
  assert.equal(noHistRes.ok, false)
  assert.equal(noHistRes.degraded, true)
  assert.equal(noHistRes.reason, 'no-history-support')

  // 3) 有最近入站语音但 media.fetch=false -> unsupported-media-fetch 降级
  lastVoice = { chatId: 'feishu:private:ou_1', platform: 'feishu', messageId: 'om_1', seg: { type: 'record', data: { file: 'om_a' } }, at: Date.now() }
  featuresMap['feishu:private:ou_1'] = { 'media.fetch': false }
  const noMediaRes = await asrLast({})
  assert.equal(noMediaRes.reason, 'unsupported-media-fetch')

  // 4) media.fetch=true 时直接识别成功并返回来源与平台
  featuresMap['feishu:private:ou_1'] = { 'media.fetch': true }
  const okRes = await asrLast({})
  assert.equal(okRes.ok, true)
  assert.equal(okRes.source, 'inbound-cache')
  assert.equal(okRes.platform, 'feishu')
  assert.equal(okRes.heard, '飞书最近语音转写')

  // 5) P2-5: 无缓存且无在线网关实例时，如传统 standalone onebot 已连，仍可走 legacy history 兜底自检
  lastVoice = null
  instances = []
  const routesLegacy = new Map()
  voiceModule.setup({
    config: () => ({ voice: {} }),
    route: (path, fn) => routesLegacy.set(path, fn),
    every() {},
    core: {
      dsh: { get: (k) => (k === 'speechToText' ? sttReady : null) },
      hub: {
        lastInboundVoice: () => null,
        localTranscribe: async (_seg, _wav, msg) => (msg?.platform === 'qq' ? '传统直连历史语音' : ''),
      },
      gateway: { instances: () => [] },
      onebot: {
        state: 'connected',
        call: async (action) => (action === 'get_friend_msg_history'
          ? { messages: [{ user_id: 10000001, time: 1700000000, message_id: 77, message: [{ type: 'record', data: { file: 'a.silk' } }] }] }
          : {}),
      },
      identity: makeTestIdentity('10000001', 'qq'),
      http: { body: async () => ({}) },
    },
  })
  const legRes = await routesLegacy.get('/voice/asr-last')({})
  assert.equal(legRes.ok, true)
  assert.equal(legRes.source, 'legacy-qq-history')
  assert.equal(legRes.heard, '传统直连历史语音')
})

test('§3.1 守卫：title-filter / refreshFriends / onPoke / sendFile / maybeReact 跨平台隔离与网关路由', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-hub-guards-'))
  const prevData = process.env.AURABOT_DATA_DIR
  const prevWs = process.env.AURABOT_WORKSPACE
  process.env.AURABOT_DATA_DIR = join(root, 'data')
  process.env.AURABOT_WORKSPACE = join(root, 'ws')

  // title-filter 守卫（注意 rule 字段是单数 title；支持 chatId 带前缀）
  const tfCalls = []
  const tf = createTitleFilter({
    getConfig: () => ({ titleFilter: { enabled: true, groups: ['oc_g1', '123456'], title: '机器人' } }),
    onebot: {
      call: async (action, params) => {
        tfCalls.push({ action, params })
        return { title: '机器人' }
      },
    },
    log: { debug() {}, warn() {} },
  })
  assert.equal(await tf.shouldIgnore({ chatId: 'feishu:group:oc_g1', group_id: 'oc_g1', user_id: 'ou_1' }), false)
  assert.equal(await tf.shouldIgnore({ chatId: 'feishu:group:123456', group_id: '123456', user_id: '777888' }), false)
  assert.deepEqual(tfCalls, [])
  assert.equal(await tf.shouldIgnore({ group_id: '123456', user_id: '999999' }), true)
  assert.equal(tfCalls.length, 1)

  const tfNoOnebot = createTitleFilter({
    getConfig: () => ({ titleFilter: { enabled: true, groups: ['123456'], title: '机器人' } }),
    onebot: null,
    log: { debug() {}, warn() {} },
  })
  assert.deepEqual(await tfNoOnebot.titlesIn(['123456', 'feishu:group:999']), { titles: [], failed: [] })

  // hub.refreshFriends / onPoke / sendFile / maybeReact
  const { createHub } = await import('../src/chat/hub.js')
  mkdirSync(join(root, 'ws'), { recursive: true })
  const filePath = join(root, 'ws', 'hello.txt')
  writeFileSync(filePath, 'hello feishu')

  const cfg = normalize({
    enabled: true,
    dryRun: false,
    setupDone: true,
    ownerQQ: '10000001',
    botQQ: '20000002',
    allow: { groups: [], private: [] },
    files: { enabled: true, dirs: [join(root, 'ws')], maxMB: 10 },
    stickers: { enabled: true, react: true, reactChance: 1 },
  })
  const fake = createFakeDsh({ brain: async () => 'ok' })
  const identity = makeTestIdentity('10000001', 'qq')
  const onebotCalls = []
  const gwSends = []
  let capsByChat = {
    'feishu:private:ou_1': { file: true, poke: false, reaction: false },
    'qq:private:10000001': { file: true, poke: false, reaction: true },
  }
  const gateway = {
    selfAccount: () => 'bot',
    caps: (cid) => capsByChat[cid] || null,
    features: (cid) => (String(cid).startsWith('feishu') ? { 'message.reaction': false } : { 'message.reaction': true }),
    send: async (out) => {
      gwSends.push(out)
      return { messageId: 'gw_' + gwSends.length }
    },
  }
  const hub = createHub({
    dsh: fake.ctx,
    getConfig: () => cfg,
    identity,
    routeOwner: identity.routeOwner,
    defaultPlatform: 'qq',
    gateway,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    onebot: null,
  })
  const off = fake.ctx.on('session/event', hub.onSessionEvent)
  t.after(() => {
    hub.dispose(); off(); fake.dispose()
    if (prevData === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prevData
    if (prevWs === undefined) delete process.env.AURABOT_WORKSPACE
    else process.env.AURABOT_WORKSPACE = prevWs
  })

  // 1) onebot 为 null 时 refreshFriends 与 onPoke 安全跳过
  await hub.refreshFriends()
  await hub.onPoke({ platform: 'feishu', target_id: '20000002', user_id: 'ou_1', sender_id: 'ou_1' })
  await hub.onPoke({ chatId: 'qq:private:10000001', target_id: '20000002', user_id: '10000001', sender_id: '10000001' })
  await hub.maybeReact({ chatId: 'feishu:private:ou_1', platform: 'feishu', messageId: 'om_1' })
  assert.deepEqual(onebotCalls, [])

  // 2) sendFile 在网关路径下走 file Part，caps.file=false 时明确拒发
  await hub.sendFile('feishu:private:ou_1', filePath, 'hello.txt')
  assert.equal(gwSends.length, 1)
  assert.equal(gwSends[0].chatId, 'feishu:private:ou_1')
  assert.equal(gwSends[0].parts[0].type, 'file')
  assert.equal(gwSends[0].parts[0].media.name, 'hello.txt')

  capsByChat['feishu:private:ou_1'] = { file: false }
  await assert.rejects(() => hub.sendFile('feishu:private:ou_1', filePath, 'hello.txt'), /不支持发送文件/)

  // 3) 即使 onebot 存在，飞书与关闭对应能力的 QQ 网关实例也不会触发 set_input_status / send_poke / get_friend_msg_history / set_msg_emoji_like
  const calls2 = []
  const fake2 = createFakeDsh({ brain: async () => '<poke>' })
  const cfg2 = normalize({
    enabled: true,
    dryRun: false,
    setupDone: true,
    ownerQQ: '10000001',
    botQQ: '20000002',
    allow: { groups: [], private: ['ou_1', '10000001'] },
    merge: { enabled: false },
    chat: { seedHistory: true },
    stickers: { enabled: true, react: true, reactChance: 1 },
  })
  const gw2 = {
    selfAccount: (cid) => (String(cid).startsWith('feishu') ? 'cli_b' : '20000002'),
    caps: (cid) => (String(cid).startsWith('feishu')
      ? { poke: false, typing: false, history: false, reaction: false }
      : { poke: false, typing: false, history: false, reaction: false }),
    features: () => ({ 'chat.typing': false, 'message.history.read': false, 'message.reaction': false }),
    send: async () => ({ messageId: 'm_1' }),
    noteSeen() {},
  }
  const hub2 = createHub({
    dsh: fake2.ctx,
    getConfig: () => cfg2,
    identity: makeTestIdentity('10000001', 'qq'),
    routeOwner: identity.routeOwner,
    defaultPlatform: 'qq',
    gateway: gw2,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    onebot: {
      connected: true,
      call: async (action, params) => {
        calls2.push({ action, params })
        return { message_id: calls2.length }
      },
    },
  })
  const off2 = fake2.ctx.on('session/event', hub2.onSessionEvent)
  t.after(() => { hub2.dispose(); off2(); fake2.dispose() })

  await hub2.onPoke({ chatId: 'qq:private:10000001', target_id: '20000002', user_id: '10000001', sender_id: '10000001' })
  await hub2.maybeReact({ chatId: 'qq:private:10000001', platform: 'qq', messageId: '99' })
  await hub2.onGatewayMessage({
    id: 'e2',
    platform: 'qq',
    instance: 'qq',
    chatId: 'qq:private:10000001',
    kind: 'private',
    chat: { id: '10000001', kind: 'private', name: '主人' },
    sender: { account: '10000001', name: '主人', isOwner: true },
    messageId: '101',
    at: Date.now(),
    text: '你好',
    parts: [{ type: 'text', text: '你好' }],
  })
  await until(() => fake2.turns.length >= 1)
  await new Promise((r) => setTimeout(r, 40))
  const badCalls = calls2.filter((c) => ['send_poke', 'set_input_status', 'get_friend_msg_history', 'set_msg_emoji_like'].includes(c.action))
  assert.deepEqual(badCalls, [])
})

test('同平台多实例隔离（qq + qq#2）与 lastInboundVoice TTL/dispose 清理', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-multi-inst-'))
  const prevData = process.env.AURABOT_DATA_DIR
  const prevWs = process.env.AURABOT_WORKSPACE
  process.env.AURABOT_DATA_DIR = join(root, 'data')
  process.env.AURABOT_WORKSPACE = join(root, 'ws')
  mkdirSync(join(root, 'ws'), { recursive: true })

  const { createHub } = await import('../src/chat/hub.js')
  const { normalize } = await import('../src/core/config.js')

  // title-filter 也不应为 qq#2 调默认 onebot
  const tfCalls = []
  const tf = createTitleFilter({
    getConfig: () => ({ titleFilter: { enabled: true, groups: ['888888'], title: '机器人' } }),
    onebot: { call: async (a, p) => { tfCalls.push({ a, p }); return { title: '机器人' } } },
    log: { debug() {}, warn() {} },
  })
  assert.equal(await tf.shouldIgnore({ chatId: 'qq#2:group:888888', instance: 'qq#2', platform: 'qq', group_id: '888888', user_id: '999999' }), false)
  assert.deepEqual(await tf.titlesIn(['qq#2:group:888888']), { titles: [], failed: [] })
  assert.deepEqual(tfCalls, [])

  const cfg = normalize({
    enabled: true,
    dryRun: false,
    setupDone: true,
    ownerQQ: '10000001',
    botQQ: '20000002',
    allow: { groups: ['qq#2:group:888888'], private: ['qq#2:private:10000001', '10000001'] },
    merge: { enabled: false },
    chat: { seedHistory: true },
    voice: { enabled: true, asr: false },
    stickers: { enabled: false, collect: false, reactChance: 0 },
  })
  const fake = createFakeDsh({ brain: async () => '<poke>收到' })
  const identity = makeTestIdentity('10000001', 'qq')
  const onebotCalls = []
  const gwSends = []
  const gateway = {
    selfAccount: (cid) => (String(cid).startsWith('qq#2') ? '20000099' : '20000002'),
    caps: () => ({ image: true, voice: 'native', file: true, poke: true, typing: true, history: true }),
    features: () => ({ 'chat.typing': true, 'message.history.read': true, 'media.fetch': true }),
    send: async (out) => { gwSends.push(out); return { messageId: 'm_' + gwSends.length } },
    noteSeen() {},
  }
  const hub = createHub({
    dsh: fake.ctx,
    getConfig: () => cfg,
    identity,
    routeOwner: identity.routeOwner,
    defaultPlatform: 'qq',
    gateway,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    onebot: {
      connected: true,
      call: async (action, params) => {
        onebotCalls.push({ action, params })
        return { message_id: onebotCalls.length }
      },
    },
  })
  const off = fake.ctx.on('session/event', hub.onSessionEvent)
  t.after(() => {
    hub.dispose(); off(); fake.dispose()
    if (prevData === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prevData
    if (prevWs === undefined) delete process.env.AURABOT_WORKSPACE
    else process.env.AURABOT_WORKSPACE = prevWs
  })

  // 1) qq#2 入站（带语音以便同时测 lastInboundVoice，后测 dispose 清理）
  await hub.onPoke({ instance: 'qq#2', platform: 'qq', chatId: 'qq#2:private:10000001', target_id: '20000099', user_id: '10000001', sender_id: '10000001' })
  await hub.onGatewayMessage({
    id: 'evt-qq2',
    platform: 'qq',
    instance: 'qq#2',
    chatId: 'qq#2:private:10000001',
    kind: 'private',
    chat: { id: '10000001', kind: 'private', name: '主人' },
    sender: { account: '10000001', name: '主人', isOwner: true, person: identity.owner() },
    messageId: 'qq2_m1',
    at: Date.now(),
    text: '你好',
    parts: [{ type: 'text', text: '你好' }, { type: 'voice', media: { id: 'v_qq2', mime: 'audio/wav' } }],
  })
  await until(() => fake.turns.length >= 1)
  await new Promise((r) => setTimeout(r, 40))

  // qq#2 会话 context 不得出现「<poke>（会变成 QQ 的戳一戳）」提示
  assert.doesNotMatch(fake.turns[0].ctxText, /会变成 QQ 的戳一戳/)
  // 默认 onebot 不应收到 set_input_status / get_friend_msg_history / send_poke / get_stranger_info
  const leaked = onebotCalls.filter((c) => ['set_input_status', 'get_friend_msg_history', 'get_group_msg_history', 'send_poke', 'get_stranger_info', 'get_group_member_info'].includes(c.action))
  assert.deepEqual(leaked, [], `qq#2 不得调用默认 onebot：${JSON.stringify(leaked)}`)

  // 2) lastInboundVoice 正常命中；30 分钟过期或 dispose 后自动失效
  const hit = hub.lastInboundVoice({ chatId: 'qq#2:private:10000001' })
  assert.ok(hit)
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 31 * 60_000 })
  assert.equal(hub.lastInboundVoice({ chatId: 'qq#2:private:10000001' }), null, '超过 30 分钟应自动过期清理')
  t.mock.timers.reset()

  // 再注入一条验证 dispose() 清理
  await hub.onGatewayMessage({
    id: 'evt-qq2-2',
    platform: 'qq',
    instance: 'qq#2',
    chatId: 'qq#2:private:10000001',
    kind: 'private',
    chat: { id: '10000001', kind: 'private', name: '主人' },
    sender: { account: '10000001', name: '主人', isOwner: true, person: identity.owner() },
    messageId: 'qq2_m2',
    at: Date.now(),
    text: '',
    parts: [{ type: 'voice', media: { id: 'v_qq2_2', mime: 'audio/wav' } }],
  })
  assert.ok(hub.lastInboundVoice({ chatId: 'qq#2:private:10000001' }))
  hub.dispose()
  assert.equal(hub.lastInboundVoice({ chatId: 'qq#2:private:10000001' }), null)
})
