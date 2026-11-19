import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryLine } from '../src/features/memory.js'
import video, { videoFile } from '../src/modules/video/index.js'
import { SLOTS } from '../src/local/local.js'

function setup({ owner = true, result = 'D:/out/a.mp4', active = true, sendFails = false } = {}) {
  const sent = []
  const calls = []
  let tool = null
  let finish
  const done = new Promise((r) => { finish = r })
  const hub = {
    turnSendersAllOwner: () => owner,
    sendSegments: async (chatId, segs) => { if (sendFails) throw new Error('网关不收'); sent.push({ chatId, segs }); finish() },
    sendFile: async (chatId, file) => { sent.push({ chatId, file }); finish() },
    sendText: async (chatId, text) => { sent.push({ chatId, text }); finish() },
  }
  const local = { active: () => active, call: async (slot, args) => { calls.push({ slot, args }); if (result instanceof Error) throw result; return result } }
  const rules = []
  const api = { core: { hub, local }, log: { warn() {} }, rule: (f) => rules.push(f), tool: (f) => { tool = f }, onDispose() {} }
  video.setup(api)
  const chat = { chatId: 'private:1', kind: 'private' }
  return { get: (c = chat) => tool({ chat: c, sessionId: 's' }), rules, sent, calls, done }
}

test('video 槽位默认等 20 分钟', () => {
  assert.equal(SLOTS.video.file, 'video.mjs')
  assert.equal(SLOTS.video.timeoutMs, 20 * 60_000)
})

test('脚本返回路径或 { file }', () => {
  assert.equal(videoFile('a.mp4'), 'a.mp4')
  assert.equal(videoFile({ file: 'b.mp4' }), 'b.mp4')
  assert.equal(videoFile(null), '')
})

test('工具马上返回，做好后自动按视频发回聊天', async () => {
  const s = setup()
  const r = await s.get().execute({ prompt: '一条鱼', seconds: '3' })
  assert.equal(r.ok, true)
  await s.done
  assert.deepEqual(s.calls[0], { slot: 'video', args: { prompt: '一条鱼', seconds: 3 } })
  assert.equal(s.sent[0].segs[0].type, 'video')
  assert.match(s.sent[0].segs[0].data.file, /^file:/)
})

test('发视频失败时改发文件', async () => {
  const s = setup({ sendFails: true })
  await s.get().execute({ prompt: '一条鱼' })
  await s.done
  assert.equal(s.sent[0].file, 'D:/out/a.mp4')
})

test('失败时告诉对方', async () => {
  const s = setup({ result: new Error('显存不够') })
  await s.get().execute({ prompt: '一条鱼' })
  await s.done
  assert.match(s.sent[0].text, /没做成.*显存不够/)
})

test('只有主人能生成，后台会话和没开时没有工具，规则跟着开关走', async () => {
  const s = setup({ owner: false })
  assert.equal((await s.get().execute({ prompt: 'x' })).ok, false)
  assert.equal(s.calls.length, 0)
  assert.deepEqual(s.get({ chatId: 'system:x', kind: 'system' }), [])
  const off = setup({ active: false })
  assert.deepEqual(off.get(), [])
  assert.deepEqual(off.rules[0](), [])
  assert.match(setup().rules[0]()[0], /十几分钟/)
})

test('一次只跑一段', async () => {
  const s = setup()
  await s.get().execute({ prompt: 'a' })
  assert.equal((await s.get().execute({ prompt: 'b' })).ok, false)
  await s.done
})

test('记忆行带 QQ 号，重名分得清；已经带了就不重复', () => {
  assert.match(memoryLine({ at: Date.now(), text: '喜欢吃辣', aboutName: '小明', about: '123' }), /\[小明\(123\)\] 喜欢吃辣/)
  assert.match(memoryLine({ at: Date.now(), text: 'x', aboutName: '小明(123)', about: '123' }), /\[小明\(123\)\] x/)
  assert.match(memoryLine({ at: Date.now(), text: 'x', aboutName: '小明', about: '' }), /\[小明\] x/)
})

test('PR-2A 跨平台网关：飞书通过 api.sendParts 发送标准 video Part.media', async () => {
  const partsSent = []
  let finish
  const done = new Promise((r) => { finish = r })
  const contexts = []
  let tool = null
  let qqSendFileCalled = false
  video.setup({
    core: {
      hub: {
        turnSendersAllOwner: () => true,
        sendFile: async () => { qqSendFileCalled = true },
        sendText: async () => { finish() },
      },
      local: { active: () => true, call: async () => 'D:/out/feishu.mp4' },
    },
    log: { warn() {} },
    config: () => ({ allow: { private: [] }, capabilityAllow: {} }),
    caps: () => ({ video: true, file: true }),
    platformOf: (cid) => (String(cid).startsWith('feishu:') ? 'feishu' : 'qq'),
    sendParts: async (chatId, parts, opts) => {
      partsSent.push({ chatId, parts, opts })
      finish()
      return { messageId: 'om_v1' }
    },
    context: (fn) => contexts.push(fn),
    rule: () => {},
    tool: (f) => { tool = f },
    onDispose() {},
  })
  const chat = { chatId: 'feishu:private:ou_owner', platform: 'feishu', kind: 'private', userId: 'ou_owner' }
  const r = await tool({ chat, sessionId: 's-fs' }).execute({ prompt: '一只猫' })
  assert.equal(r.ok, true)
  await done
  assert.equal(qqSendFileCalled, false)
  assert.equal(partsSent.length, 1)
  assert.equal(partsSent[0].chatId, 'feishu:private:ou_owner')
  assert.deepEqual(partsSent[0].parts, [{ type: 'video', media: { path: 'D:/out/feishu.mp4', name: 'feishu.mp4' } }])
})

test('PR-2A 跨平台网关：caps.video=false 时跳过视频直降 file Part；均不支持时直接拒绝且不启脚本', async () => {
  const partsSent = []
  let finish
  const done = new Promise((r) => { finish = r })
  let calls = 0
  let tool = null
  let currentCaps = { video: false, file: true }
  video.setup({
    core: {
      hub: {
        turnSendersAllOwner: () => true,
        sendFile: async () => { throw new Error('不应走 QQ sendFile') },
        sendText: async () => { finish() },
      },
      local: { active: () => true, call: async () => { calls++; return 'D:/out/clip.mp4' } },
    },
    log: { warn() {} },
    caps: () => currentCaps,
    platformOf: () => 'feishu',
    sendParts: async (chatId, parts, opts) => {
      partsSent.push({ chatId, parts, opts })
      finish()
      return { messageId: 'om_f1' }
    },
    rule: () => {},
    tool: (f) => { tool = f },
    onDispose() {},
  })
  const chat = { chatId: 'feishu:private:ou_owner', platform: 'feishu', kind: 'private', userId: 'ou_owner' }
  const r1 = await tool({ chat, sessionId: 's1' }).execute({ prompt: '风景' })
  assert.equal(r1.ok, true)
  await done
  assert.equal(calls, 1)
  assert.deepEqual(partsSent[0].parts, [{ type: 'file', media: { path: 'D:/out/clip.mp4', name: 'clip.mp4' } }])

  currentCaps = { video: false, file: false }
  const r2 = await tool({ chat, sessionId: 's2' }).execute({ prompt: '风景2' })
  assert.equal(r2.ok, false)
  assert.match(r2.message, /不支持发送视频或文件/)
  assert.equal(calls, 1, '不支持发送时不启动生视频脚本')
})

test('PR-2A 跨平台网关：video 发送失败时通过 api.sendParts 降级为 file Part，不误调 QQ hub.sendFile', async () => {
  const partsSent = []
  let finish
  const done = new Promise((r) => { finish = r })
  let qqSendFileCalled = false
  let tool = null
  video.setup({
    core: {
      hub: {
        turnSendersAllOwner: () => true,
        sendFile: async () => { qqSendFileCalled = true },
        sendText: async () => { finish() },
      },
      local: { active: () => true, call: async () => 'D:/out/fallback.mp4' },
    },
    log: { warn() {} },
    caps: () => ({ video: true, file: true }),
    platformOf: () => 'feishu',
    sendParts: async (chatId, parts) => {
      partsSent.push(parts[0])
      if (parts[0].type === 'video') throw new Error('upload failed')
      finish()
      return { messageId: 'om_f2' }
    },
    rule: () => {},
    tool: (f) => { tool = f },
    onDispose() {},
  })
  const chat = { chatId: 'feishu:group:oc_1', platform: 'feishu', kind: 'group', groupId: 'oc_1' }
  const r = await tool({ chat, sessionId: 's3' }).execute({ prompt: '大海' })
  assert.equal(r.ok, true)
  await done
  assert.equal(qqSendFileCalled, false)
  assert.deepEqual(partsSent.map((p) => p.type), ['video', 'file'])
  assert.deepEqual(partsSent[1], { type: 'file', media: { path: 'D:/out/fallback.mp4', name: 'fallback.mp4' } })
})
