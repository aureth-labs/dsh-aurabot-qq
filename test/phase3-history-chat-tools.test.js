// Phase 3 端到端与回归验证：
//   - hub.quoteFromHistory & hub.seedHistoryOnce 统一消费归一化 FetchedHistoryPage，且非默认实例绝不回落 legacy onebot
//   - chat_history 随 Gateway message.history.read 能力（onCapsChanged -> remountAll）动态挂载/卸载及上下文同步，支持游标分页与跨群 fail-closed
//   - chat-tools 与 qq-tools 拆分：模型侧仅暴露唯一权威工具名（无 qq_* 重复），旧名 qq_chat_history / qq_search_chatlog / qq_send_file / qq_send_message 经 resolveTool 与 /modules/tool 保持执行兼容
//   - 7 个 QQ 专属模块在纯 Feishu / 纯 QQBot 严格隔离，search_chatlog / send_message / send_file 跨平台与被动平台护栏生效

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHub } from '../src/chat/hub.js'
import { normalize } from '../src/core/config.js'
import chatTools from '../src/modules/chat-tools/index.js'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { makeFakeAdapter } from './helpers/fake-adapter.js'

const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return this } }

const until = async (predicate, ms = 8000) => {
  const deadline = Date.now() + ms
  while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 15))
  assert.ok(predicate(), '等待条件超时')
}

async function bootHost(t, { cfg }) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aurabot-p3-'))
  const wsDir = join(dataDir, 'ws')
  mkdirSync(wsDir, { recursive: true })
  const prevDir = process.env.AURABOT_DATA_DIR
  const prevWs = process.env.AURABOT_WORKSPACE
  const prevGlobal = globalThis.aurabot
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = wsDir
  const resolvedCfg = typeof cfg === 'function' ? cfg({ wsDir, dataDir }) : cfg
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify(resolvedCfg))

  let brainHandler = async () => '收到'
  const fake = createFakeDsh({ brain: (args) => brainHandler(args) })
  const host = await import('../src/host.js')
  const app = host.apply(fake.ctx)
  t.after(async () => {
    fake.dispose()
    await app.gateway?.stopAll?.()
    if (prevDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prevDir
    if (prevWs === undefined) delete process.env.AURABOT_WORKSPACE
    else process.env.AURABOT_WORKSPACE = prevWs
    if (prevGlobal === undefined) delete globalThis.aurabot
    else globalThis.aurabot = prevGlobal
  })
  await app.ready
  return {
    fake,
    app,
    dataDir,
    wsDir,
    setBrain(fn) { brainHandler = fn },
  }
}

test('Phase 3A：hub.seedHistoryOnce 与 hub.quoteFromHistory 消费 FetchedHistoryPage，且非默认实例绝不回落 legacy onebot', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-p3-hub-'))
  const prevDir = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir

  const onebotCalls = []
  const fakeOnebot = {
    async call(action, params) {
      onebotCalls.push({ action, params })
      return {}
    },
  }
  const gwFetches = []
  const fakeGw = {
    instances: () => [
      { instance: 'feishu', platform: 'feishu', enabled: true, state: 'connected', self: { account: 'ou_bot' }, caps: { history: true } },
      { instance: 'qq', platform: 'qq', enabled: true, state: 'connected', self: { account: '20000002' }, caps: { history: true } },
      { instance: 'qq#2', platform: 'qq', enabled: true, state: 'connected', self: { account: '20000009' }, caps: { history: false } },
    ],
    caps: (cid) => {
      if (String(cid).startsWith('qq#2:')) return { history: false, quoteReply: true, features: { 'message.history.read': false, 'message.quote.read': true } }
      return { history: true, quoteReply: true, features: { 'message.history.read': true, 'message.quote.read': true } }
    },
    features: (cid) => {
      if (String(cid).startsWith('qq#2:')) return { 'message.history.read': false, 'message.quote.read': true, 'media.fetch': false }
      return { 'message.history.read': true, 'message.quote.read': true, 'media.fetch': false }
    },
    async fetch(cid, req) {
      gwFetches.push({ cid, req })
      if (req.kind === 'message') {
        if (String(req.messageId) === 'qq_img_no_url') {
          return {
            messageId: 'qq_img_no_url',
            at: 1700000500000,
            sender: { account: '10000001', name: '群友', isBot: false },
            parts: [{ type: 'image', media: { id: 'no-url.png' } }],
          }
        }
        throw Object.assign(new Error('transient timeout'), { code: 'ECONNRESET' })
      }
      if (req.kind === 'history') {
        if (String(cid).startsWith('feishu:group:')) {
          return {
            hasMore: true,
            before: 'pt_older',
            messages: [
              { messageId: 'om_h1', at: 1700000100000, sender: { account: 'ou_u1', name: '张三', isBot: false }, parts: [{ type: 'text', text: '飞书老消息' }] },
              { messageId: 'om_h2', at: 1700000200000, sender: { account: 'ou_bot', isBot: true }, parts: [{ type: 'text', text: '飞书新消息' }] },
            ],
          }
        }
        if (String(cid).startsWith('feishu:private:')) {
          return {
            hasMore: false,
            messages: [
              { messageId: 'om_old_before_reset', at: 1700000010000, sender: { account: 'ou_u1', name: '张三', isBot: false }, parts: [{ type: 'text', text: '清理前的秘话' }] },
              { messageId: 'om_new_after_reset', at: 1700000900000, sender: { account: 'ou_u1', name: '张三', isBot: false }, parts: [{ type: 'text', text: '清理后的新话' }] },
            ],
          }
        }
        if (String(cid).startsWith('qq:group:')) {
          if (!req.before) {
            return {
              hasMore: true,
              before: 'qq_cursor_1',
              messages: [{ messageId: 'qq_latest', at: 1700000600000, sender: { account: '10000001', name: '群友', isBot: false }, parts: [{ type: 'text', text: '最近' }] }],
            }
          }
          return {
            hasMore: false,
            messages: [
              { messageId: 'qq_img_no_url', at: 1700000500000, sender: { account: '10000001', name: '群友', isBot: false }, parts: [{ type: 'image', media: { id: 'rescued.png', url: 'https://qq.example/rescued.png' } }] },
            ],
          }
        }
      }
      return null
    },
  }

  const cfg = normalize({
    enabled: true,
    dryRun: false,
    botQQ: '20000002',
    ownerQQ: '10000001',
    merge: { enabled: false },
    chat: { seedHistory: true, seedHistoryCount: 5 },
    allow: {
      private: ['feishu:private:ou_u1'],
      groups: ['feishu:group:oc_1', 'qq:group:777', 'qq#2:group:888'],
    },
  })
  const dsh = createFakeDsh({ brain: async () => '收到' })
  const hub = createHub({
    dsh: dsh.ctx,
    getConfig: () => cfg,
    log: silent,
    onebot: fakeOnebot,
    gateway: fakeGw,
    onActivity: () => {},
    isMuted: () => false,
  })
  t.after(() => {
    hub.dispose()
    if (prevDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prevDir
  })

  // 1) 飞书群新会话首次发言触发 seedHistoryOnce：消费 FetchedHistoryPage（旧 -> 新）
  await hub.onGatewayMessage({
    v: 1,
    instance: 'feishu',
    platform: 'feishu',
    chatId: 'feishu:group:oc_1',
    kind: 'group',
    chat: { kind: 'group', id: 'oc_1' },
    sender: { account: 'ou_u1', name: '张三', role: 'member', isOwner: false },
    messageId: 'om_now_1',
    at: 1700000300000,
    mentionedMe: true,
    parts: [{ type: 'text', text: '在吗' }],
  })
  await until(() => dsh.turns.length >= 1)
  assert.match(dsh.turns[0].userText, /你刚上线，先补看最近 2 条群记录/)
  assert.ok(dsh.turns[0].userText.indexOf('飞书老消息') < dsh.turns[0].userText.indexOf('飞书新消息'))

  // 2) 飞书私聊经过 /记忆清理 后，seedHistoryOnce 的 filterHistory 必须剔除清理前 FetchedMessage
  hub.resetChat('feishu:private:ou_u1', { memoryResetAt: 1700000500000 })
  await hub.onGatewayMessage({
    v: 1,
    instance: 'feishu',
    platform: 'feishu',
    chatId: 'feishu:private:ou_u1',
    kind: 'private',
    chat: { kind: 'private', id: 'ou_u1' },
    sender: { account: 'ou_u1', name: '张三', isOwner: false },
    messageId: 'om_now_pm',
    at: 1700000990000,
    mentionedMe: false,
    parts: [{ type: 'text', text: '清理后再聊' }],
  })
  await until(() => dsh.turns.length >= 2)
  assert.doesNotMatch(dsh.turns[1].userText, /清理前的秘话/)
  assert.match(dsh.turns[1].userText, /清理后的新话/)

  // 3) 非默认实例 qq#2 关闭 history 时，seedHistoryOnce 不补历史，也绝不越权调 legacy onebot
  await hub.onGatewayMessage({
    v: 1,
    instance: 'qq#2',
    platform: 'qq',
    chatId: 'qq#2:group:888',
    kind: 'group',
    chat: { kind: 'group', id: '888' },
    sender: { account: '10000001', name: '群友', role: 'member', isOwner: false },
    messageId: 'qq2_m1',
    at: 1700000400000,
    mentionedMe: true,
    parts: [{ type: 'text', text: 'qq2 测试' }],
  })
  await until(() => dsh.turns.length >= 3)
  assert.doesNotMatch(dsh.turns[2].userText, /你刚上线，先补看/)
  assert.equal(onebotCalls.length, 0)

  // 4) quotedInfo 在网关模式下通过 quoteFromGatewayHistory 跨分页捞回 QQ 图片 URL（以及飞书 message miss 捞回）
  const qQqImg = await hub.quotedInfo('qq_img_no_url', { chatId: 'qq:group:777', groupId: '777' })
  assert.equal(qQqImg.ok, true)
  assert.equal(qQqImg.images[0]?.data?.url, 'https://qq.example/rescued.png')
  assert.ok(gwFetches.some((f) => f.cid === 'qq:group:777' && f.req.kind === 'history' && f.req.before === 'qq_cursor_1'))

  const qFsMiss = await hub.quotedInfo('om_h2', { chatId: 'feishu:group:oc_1' })
  assert.equal(qFsMiss.ok, true)
  assert.equal(qFsMiss.text, '飞书新消息')
  assert.equal(qFsMiss.isBot, true)
  assert.equal(onebotCalls.length, 0, '非无网关默认 QQ 场景绝不回退 onebot')
})

test('Phase 3：chat_history 随 onCapsChanged 动态挂撤与上下文同步、分页游标与跨群 fail-closed', async (t) => {
  const { fake, app, setBrain } = await bootHost(t, {
    cfg: {
      enabled: true,
      dryRun: false,
      setupDone: true,
      ownerName: '阿白',
      merge: { enabled: false },
      allow: { private: ['feishu:private:ou_owner'], groups: ['feishu:group:oc_1', 'feishu:group:oc_2'] },
      platforms: { qq: { enabled: false }, feishu: { enabled: true } },
    },
  })
  app.gateway.identity.claimOwner('feishu', 'ou_owner')
  await app.gateway.stopAll()

  const historyCalls = []
  let fsAdapter = null
  app.gateway.register(() => {
    fsAdapter = makeFakeAdapter({
      id: 'feishu',
      self: { account: 'ou_bot', name: '飞书Bot' },
      caps: { image: true, file: true, voice: 'native', video: true, sticker: false, poke: false, history: false, proactive: 'free', features: { 'media.fetch': true, 'chat.member.read': false } },
    })
    fsAdapter.fetch = async (req) => {
      if (req.kind !== 'history') return null
      historyCalls.push({ chatId: req.chat?.id, count: req.count, before: req.before })
      if (req.chat?.id === 'oc_2') {
        return {
          hasMore: false,
          messages: [
            { messageId: 'om_oc2_1', at: 1700000100000, sender: { account: 'ou_other', name: '同事B', isBot: false }, parts: [{ type: 'text', text: '二群机密讨论' }] },
          ],
        }
      }
      if (!req.before) {
        return {
          hasMore: true,
          before: 'cursor_p2',
          messages: [
            { messageId: 'om_p1_1', at: 1700000200000, sender: { account: 'ou_owner', name: '阿白', isBot: false }, parts: [{ type: 'text', text: '较早一页结尾' }] },
            { messageId: 'om_p1_2', at: 1700000300000, sender: { account: 'ou_bot', isBot: true }, parts: [{ type: 'text', text: '最新一条' }] },
          ],
        }
      }
      return {
        hasMore: false,
        messages: [
          { messageId: 'om_p0_1', at: 1700000100000, sender: { account: 'ou_owner', name: '阿白', isBot: false }, parts: [{ type: 'text', text: '最早期第一条' }] },
        ],
      }
    }
    return fsAdapter
  })
  await app.gateway.sync()

  // 1) 初始 history=false：不挂 chat_history 也不透出 chat_history 上下文提示
  fsAdapter.pushInbound({
    chat: { id: 'ou_owner', kind: 'private', name: '阿白' },
    sender: { account: 'ou_owner', name: '阿白', isOwner: true },
    messageId: 'om_turn1',
    at: Date.now(),
    text: '先聊聊',
    parts: [{ type: 'text', text: '先聊聊' }],
  })
  await until(() => fake.turns.length >= 1)
  const ownerAgent = [...fake.agents.values()].find((a) => a.tools.has('search_chatlog'))
  assert.ok(ownerAgent)
  assert.equal(ownerAgent.tools.has('chat_history'), false)
  assert.equal(ownerAgent.tools.has('qq_chat_history'), false)
  assert.equal(ownerAgent.tools.has('qq_search_chatlog'), false)
  assert.doesNotMatch(fake.turns[0].ctxText, /chat_history/)

  // 2) 开启 history=true -> 触发 onCapsChanged -> host 100ms 防抖后 hub.remountAll -> 自动挂上 chat_history 且 ctx 同步出现
  fsAdapter.setCaps({ history: true })
  await until(() => ownerAgent.tools.has('chat_history'))
  const ctxAfterEnable = [...ownerAgent.contexts.values()].map((c) => c.text()).filter(Boolean).join('\n')
  assert.match(ctxAfterEnable, /用 chat_history/)
  assert.equal(ownerAgent.tools.has('qq_chat_history'), false, '模型侧只暴露去重后的唯一权威工具名')

  // 3) 分页游标与主人跨群（允许）vs 非主人跨群（chat.member.read=false 下 fail-closed）
  setBrain(async ({ callTool }) => {
    const p1 = await callTool('chat_history', { count: 2 })
    const p2 = await callTool('chat_history', { count: 2, before: p1.before })
    const crossOwner = await callTool('chat_history', { group: 'oc_2' })
    return `p1=${p1.before}|p2=${p2.has_more}|cross=${crossOwner.ok}`
  })
  fsAdapter.pushInbound({
    chat: { id: 'ou_owner', kind: 'private', name: '阿白' },
    sender: { account: 'ou_owner', name: '阿白', isOwner: true },
    messageId: 'om_turn2',
    at: Date.now(),
    text: '翻历史',
    parts: [{ type: 'text', text: '翻历史' }],
  })
  await until(() => fake.turns.length >= 2)
  assert.equal(fake.turns[1].reply, 'p1=cursor_p2|p2=false|cross=true')
  assert.deepEqual(historyCalls.slice(0, 2), [
    { chatId: 'ou_owner', count: 2, before: undefined },
    { chatId: 'ou_owner', count: 2, before: 'cursor_p2' },
  ])
  const crossResult = fake.turns[1].toolCalls[2].result
  assert.match(crossResult.message, /二群机密讨论/)

  // 非主人群聊尝试跨群看 oc_2（chat.member.read=false 且 allow 群不在当前群）：fail-closed 拒绝且不泄漏群名
  setBrain(async ({ callTool }) => {
    const r = await callTool('chat_history', { group: 'oc_2' })
    return r.message
  })
  fsAdapter.pushInbound({
    chat: { id: 'oc_1', kind: 'group', name: '一群' },
    sender: { account: 'ou_stranger', name: '路人', role: 'member', isOwner: false },
    messageId: 'om_turn_group',
    at: Date.now(),
    mentionedMe: true,
    text: '看看二群在聊啥',
    parts: [{ type: 'text', text: '看看二群在聊啥' }],
  })
  await until(() => fake.turns.length >= 3)
  assert.equal(fake.turns[2].reply, '这个群看不了')

  // 4) 关闭 history=false -> remountAll 后动态卸载 chat_history 并收回上下文提示
  fsAdapter.setCaps({ history: false })
  await until(() => !ownerAgent.tools.has('chat_history'))
  const ctxAfterDisable = [...ownerAgent.contexts.values()].map((c) => c.text()).filter(Boolean).join('\n')
  assert.doesNotMatch(ctxAfterDisable, /chat_history/)
})

test('Phase 3：工具去重、legacy qq_* 执行路由兼容、7 个 QQ 模块在纯 QQBot 隔离与主动护栏', async (t) => {
  // 先验证 QQ + Feishu + QQBot 多平台下的工具清单去重与 legacy qq_* 执行兼容性
  const { fake, app, wsDir } = await bootHost(t, {
    cfg: ({ wsDir: ws }) => ({
      enabled: true,
      dryRun: false,
      setupDone: true,
      botQQ: '20000002',
      ownerQQ: '10000001',
      ownerName: '阿白',
      merge: { enabled: false },
      files: { enabled: true, dirs: [ws] },
      allow: {
        private: ['10000001', 'feishu:private:ou_owner'],
        groups: ['777', 'feishu:group:oc_1', 'qqbot:group:g_bot'],
      },
      platforms: { qq: { enabled: true }, feishu: { enabled: true }, qqbot: { enabled: true } },
    }),
  })

  const ownerPerson = app.gateway.identity.owner() || app.gateway.identity.claimOwner('qq', '10000001')
  app.gateway.identity.link('feishu', 'ou_owner', ownerPerson, 'manual')
  await app.gateway.stopAll()

  let fsAdapter = null
  let botAdapter = null
  app.gateway.register(() => makeFakeAdapter({
    id: 'qq',
    self: { account: '20000002', name: 'QQBot' },
    caps: { image: true, file: true, sticker: true, poke: true, history: true, card: true, proactive: 'free', features: { 'card.send': true, 'message.history.read': true } },
  }))
  app.gateway.register(() => {
    fsAdapter = makeFakeAdapter({
      id: 'feishu',
      self: { account: 'ou_bot', name: '飞书Bot' },
      caps: { image: true, file: true, voice: 'native', video: true, sticker: false, poke: false, history: true, card: true, proactive: 'free', features: { 'media.fetch': true, 'message.history.read': true } },
    })
    fsAdapter.fetch = async (req) => (req.kind === 'history'
      ? { hasMore: false, messages: [{ messageId: 'om_legacy', at: 1700000100000, sender: { account: 'ou_owner', name: '阿白', isBot: false }, parts: [{ type: 'text', text: '旧工具路由验证' }] }] }
      : null)
    return fsAdapter
  })
  app.gateway.register(() => {
    botAdapter = makeFakeAdapter({
      id: 'qqbot',
      self: { account: 'bot_1', name: '官方Bot' },
      caps: { image: true, file: true, voice: 'native', sticker: false, poke: false, history: false, card: false, proactive: 'none', features: { 'message.history.read': false } },
    })
    return botAdapter
  })
  await app.gateway.sync()

  // 1) buildTools / /modules/tools：只暴露唯一权威名，不重复出现 qq_chat_history / qq_search_chatlog / qq_send_message / qq_send_file
  const qqTools = (await fake.call('/modules/tools?kind=private&platform=qq&owner=1')).json().list.map((x) => x.name)
  for (const canonical of ['chat_history', 'search_chatlog', 'send_message', 'send_file']) {
    assert.ok(qqTools.includes(canonical), `QQ 侧应暴露权威名 ${canonical}`)
    assert.ok(!qqTools.includes(`qq_${canonical}`), `QQ 侧不应重复暴露旧名 qq_${canonical}`)
  }
  assert.ok(qqTools.includes('qq_send_card'), 'QQ 专属 qq_send_card 保留在 qq-tools')
  assert.ok(qqTools.includes('qq_read_file'), 'QQ 专属 qq_read_file 保留在 qq-tools')

  const fsTools = (await fake.call('/modules/tools?kind=private&platform=feishu&owner=1')).json().list.map((x) => x.name)
  assert.ok(fsTools.includes('search_chatlog'))
  assert.ok(fsTools.includes('send_message'))
  assert.ok(fsTools.includes('send_file'))
  assert.ok(!fsTools.includes('qq_send_card'), 'Feishu 不应出现 qq_send_card')
  assert.ok(!fsTools.includes('qq_read_file'), 'Feishu 不应出现 qq_read_file')

  // 2) search_chatlog 兼容旧聊天 ID 格式，且 /modules/tool 调 4 个旧名 qq_* 都能向后兼容执行
  const legacyHist = (await fake.call('/modules/tool', {
    name: 'qq_chat_history',
    platform: 'feishu',
    owner: true,
    userId: 'ou_owner',
    args: { count: 5 },
  })).json()
  assert.equal(legacyHist.ok, true)
  assert.match(legacyHist.result.message, /旧工具路由验证/)

  app.hub.logChat('private:10000001', '阿白', '咖啡豆放在左边柜子', '10000001')
  const legacySearch = (await fake.call('/modules/tool', {
    name: 'qq_search_chatlog',
    platform: 'qq',
    owner: true,
    userId: '10000001',
    args: { query: '咖啡豆', chat: 'qq:private:10000001' },
  })).json()
  assert.equal(legacySearch.ok, true)
  assert.match(legacySearch.result.message, /咖啡豆放在左边柜子/)

  const legacySendOk = (await fake.call('/modules/tool', {
    name: 'qq_send_message',
    platform: 'qq',
    owner: true,
    userId: '10000001',
    args: { target: 'feishu:group:oc_1', text: '从QQ跨平台问候' },
  })).json()
  assert.equal(legacySendOk.ok, true)
  assert.equal(legacySendOk.result.ok, true)
  assert.ok(legacySendOk.sent.some((x) => x.chatId === 'feishu:group:oc_1' && /从QQ跨平台问候/.test(x.text)))

  // 直接通过 modules.resolveTool('qq_send_message') 执行（非 simulate capture）验证真实经网关触达飞书 adapter
  const resolvedSend = app.modules.resolveTool(
    { chat: { chatId: 'qq:private:10000001', platform: 'qq', kind: 'private', userId: '10000001' }, level: 'full', sessionId: 'sim-direct' },
    'qq_send_message',
  )
  assert.equal(resolvedSend?.name, 'send_message')
  const directSendRes = await resolvedSend.execute({ target: 'feishu:group:oc_1', text: '真实触达飞书' })
  assert.equal(directSendRes.ok, true)
  assert.ok(fsAdapter.sent.some((x) => x.message?.parts?.some((p) => /真实触达飞书/.test(String(p.text || '')))))

  const demoFile = join(wsDir, 'note.txt')
  writeFileSync(demoFile, 'hello phase3')
  const legacySendFile = (await fake.call('/modules/tool', {
    name: 'qq_send_file',
    platform: 'qq',
    owner: true,
    userId: '10000001',
    args: { target: 'feishu:group:oc_1', file: demoFile },
  })).json()
  assert.equal(legacySendFile.ok, true)
  assert.equal(legacySendFile.result.ok, true)
  assert.ok(legacySendFile.sent.some((x) => x.chatId === 'feishu:group:oc_1' && /note\.txt/.test(x.note)))

  // 被动平台 qqbot (proactive='none') 拒绝主动 send_message 与跨聊 send_file
  const sendToPassive = (await fake.call('/modules/tool', {
    name: 'send_message',
    platform: 'qq',
    owner: true,
    userId: '10000001',
    args: { target: 'qqbot:group:g_bot', text: '不应该发出' },
  })).json()
  assert.equal(sendToPassive.ok, true)
  assert.equal(sendToPassive.result.ok, false)
  assert.match(sendToPassive.result.message, /仅支持被动回复/)

  const sendFilePassive = (await fake.call('/modules/tool', {
    name: 'send_file',
    platform: 'qq',
    owner: true,
    userId: '10000001',
    args: { target: 'qqbot:group:g_bot', file: demoFile },
  })).json()
  assert.equal(sendFilePassive.ok, true)
  assert.equal(sendFilePassive.result.ok, false)
  assert.match(sendFilePassive.result.message, /仅支持被动回复/)
  assert.equal(botAdapter.sent.length, 0)
})

test('Phase 4：纯 QQBot 环境下 7 个 QQ 专属模块不运行且全被动场景隐藏 send_message / chat_history', async (t) => {
  const { fake, app } = await bootHost(t, {
    cfg: {
      enabled: true,
      dryRun: false,
      setupDone: true,
      ownerName: '阿白',
      merge: { enabled: false },
      allow: { private: ['qqbot:private:u_bot_owner'], groups: ['qqbot:group:g_bot'] },
      platforms: { qq: { enabled: false }, qqbot: { enabled: true } },
    },
  })
  app.gateway.identity.claimOwner('qqbot', 'u_bot_owner')
  await app.gateway.stopAll()
  app.gateway.register(() => makeFakeAdapter({
    id: 'qqbot',
    self: { account: 'bot_official', name: '官方Bot' },
    caps: { image: true, file: true, voice: 'none', video: false, sticker: false, poke: false, history: false, card: false, proactive: 'none', features: { 'message.history.read': false } },
  }))
  await app.gateway.sync()

  for (const id of ['contacts', 'diary', 'group-admin', 'profile', 'qq-api', 'qq-tools', 'qzone-social']) {
    const row = app.modules.status().find((m) => m.id === id)
    assert.ok(!row || row.running === null, `${id} 在纯 QQBot 下不应运行`)
  }
  const chatToolsRow = app.modules.status().find((m) => m.id === 'chat-tools')
  assert.equal(chatToolsRow?.running, 'builtin', '跨平台 chat-tools 应在纯 QQBot 下正常运行')

  const botTools = (await fake.call('/modules/tools?kind=group&platform=qqbot&groupId=g_bot&owner=0')).json().list.map((x) => x.name)
  assert.ok(botTools.includes('search_chatlog'))
  assert.ok(!botTools.includes('chat_history'), 'qqbot history=false 时不挂 chat_history')
  assert.ok(!botTools.includes('send_message'), '全实例均为 proactive=none 时不挂主动 send_message')
})

test('Phase 3 P2 收口：飞书按群名跨群 / qq#2 caps=null 口径一致 / legacy 倒序重排 / 64 位 before 字符串 ID', async (t) => {
  // 1) P2-2：qq#2 在网关 caps=null 且 onebot 存在时，historyAvailable 不误按默认 QQ 放行
  let toolBuilder = null
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-p3-p2-'))
  const prevDir = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const legacyCalls = []
  const legacyOnebot = {
    async call(action, params) {
      legacyCalls.push({ action, params })
      // P2-3：故意返回倒序（新 -> 旧），且 P2-5 用超过 JS 安全整数的 64 位字符串 ID 作为锚点
      return {
        messages: [
          { message_id: '9007199254740993123', time: 1700000300, sender: { user_id: 10000001, nickname: '阿白' }, message: [{ type: 'text', data: { text: '锚点本身' } }] },
          { message_id: '9007199254740993122', time: 1700000200, sender: { user_id: 20000002, nickname: 'Bot' }, message: [{ type: 'text', data: { text: '第二条' } }] },
          { message_id: '9007199254740993121', time: 1700000100, sender: { user_id: 10000001, nickname: '阿白' }, message: [{ type: 'text', data: { text: '第一条' } }] },
        ],
      }
    },
  }
  const fakeGw = {
    caps: () => null,
    features: () => ({}),
    async fetch(cid, req) {
      if (req?.kind === 'chats') return { groups: [{ id: 'oc_2', name: '项目设计二群' }], friends: [] }
      if (req?.kind === 'history') return { hasMore: false, messages: [{ messageId: 'om_fs_name', at: 1700000100000, sender: { account: 'ou_u2', name: '同事B', isBot: false }, parts: [{ type: 'text', text: '按群名翻到的飞书记录' }] }] }
      return null
    },
  }
  const cfg = normalize({
    enabled: true,
    dryRun: false,
    botQQ: '20000002',
    allow: { groups: ['777', 'feishu:group:oc_2'] },
    platforms: { qq: { enabled: true }, 'qq#2': { enabled: true }, feishu: { enabled: true } },
  })
  const dsh = createFakeDsh({ brain: async () => 'ok' })
  const hub = createHub({
    dsh: dsh.ctx,
    getConfig: () => cfg,
    log: silent,
    onebot: legacyOnebot,
    gateway: fakeGw,
    onActivity: () => {},
    isMuted: () => false,
  })
  t.after(() => {
    hub.dispose()
    if (prevDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prevDir
  })

  chatTools.setup({
    core: { hub, onebot: legacyOnebot, gateway: fakeGw },
    config: () => cfg,
    tool: (fn) => { toolBuilder = fn },
    features: (cid) => (String(cid).startsWith('feishu:') ? { 'message.history.read': true } : { 'message.history.read': false }),
  })

  // qq#2 caps=null 时不挂 chat_history（与 hub.fetchHistory 一致，避免挂载即失败）
  const qq2Tools = toolBuilder({ chat: { chatId: 'qq#2:group:888', kind: 'group', groupId: '888', platform: 'qq' }, level: 'social', sessionId: 's_qq2' })
  assert.equal(qq2Tools.some((x) => x.name === 'chat_history'), false)

  // P2-3 & P2-5：默认实例传统 QQ 支持超大 64 位字符串 before，并把倒序响应重排为 [旧 -> 新]
  const qqDefTools = toolBuilder({ chat: { chatId: 'qq:group:777', kind: 'group', groupId: '777', platform: 'qq' }, level: 'full', sessionId: 's_qq1' })
  const qqHistTool = qqDefTools.find((x) => x.name === 'chat_history')
  assert.ok(qqHistTool)
  const badZero = await qqHistTool.execute({ before: '0' })
  assert.equal(badZero.ok, false)
  const bigIdRes = await qqHistTool.execute({ count: 2, before: '9007199254740993123' })
  assert.equal(bigIdRes.ok, true)
  assert.equal(legacyCalls.at(-1).params.message_id, '9007199254740993123', '超过 MAX_SAFE_INTEGER 的游标须原样以字符串透传，不可精度截断')
  assert.equal(bigIdRes.oldest_message_id, '9007199254740993121')
  assert.ok(bigIdRes.message.indexOf('第一条') < bigIdRes.message.indexOf('第二条'), 'legacy fetchHistory 应统一按时间升序 [旧 -> 新] 输出')

  // P2-1：飞书按群名（「设计二群」）解析并跨群读取（走 hub.chatGroups -> adapter fetch(chats)）
  const fsGwWithCaps = {
    ...fakeGw,
    caps: () => ({ history: true, features: { 'message.history.read': true } }),
    features: () => ({ 'message.history.read': true }),
  }
  const hubFs = createHub({ dsh: dsh.ctx, getConfig: () => cfg, log: silent, gateway: fsGwWithCaps, onActivity: () => {}, isMuted: () => false })
  t.after(() => hubFs.dispose())
  let fsBuilder = null
  chatTools.setup({
    core: { hub: hubFs, gateway: fsGwWithCaps },
    config: () => cfg,
    tool: (fn) => { fsBuilder = fn },
    features: () => ({ 'message.history.read': true }),
  })
  const fsHistTool = fsBuilder({ chat: { chatId: 'feishu:private:ou_owner', kind: 'private', userId: 'ou_owner', platform: 'feishu' }, level: 'full', sessionId: 's_fs' }).find((x) => x.name === 'chat_history')
  const byNameRes = await fsHistTool.execute({ group: '设计二群' })
  assert.equal(byNameRes.ok, true)
  assert.match(byNameRes.message, /按群名翻到的飞书记录/)
})

test('Phase 3 P2-7：网关模式 hub.groupName() 经 chats / 入站 title 解析并按实例隔离群名，不回落 legacy onebot', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-p3-gname-'))
  const prevDir = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const onebotCalls = []
  const chatCalls = []
  const fakeOnebot = { async call(action, params) { onebotCalls.push({ action, params }); return {} } }
  const gw = {
    caps: () => ({ history: true }),
    features: () => ({ 'message.history.read': true }),
    async fetch(target, req) {
      if (req?.kind !== 'chats') return null
      chatCalls.push(target)
      if (target === 'qq#2') return { groups: [{ id: '777', name: '二号机同名群' }], friends: [] }
      if (target === 'feishu') return { groups: [{ id: 'oc_1', name: '飞书产品群' }], friends: [] }
      return { groups: [{ group_id: 777, group_name: '默认QQ群名' }], friends: [] }
    },
  }
  const cfg = normalize({ enabled: true, dryRun: false, allow: { groups: ['qq:group:777', 'qq#2:group:777', 'feishu:group:oc_1'] } })
  const dsh = createFakeDsh({ brain: async () => 'ok' })
  const hub = createHub({ dsh: dsh.ctx, getConfig: () => cfg, log: silent, onebot: fakeOnebot, gateway: gw, onActivity: () => {}, isMuted: () => false })
  t.after(() => {
    hub.dispose()
    if (prevDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prevDir
  })

  assert.equal(await hub.groupName('qq:group:777'), '默认QQ群名')
  assert.equal(await hub.groupName('qq#2:group:777'), '二号机同名群')
  assert.equal(await hub.groupName('feishu:group:oc_1'), '飞书产品群')
  // 同 TTL 内再查命中缓存，不再重复打 chats
  const callsAfterFirst = chatCalls.length
  assert.equal(await hub.groupName('qq:group:777'), '默认QQ群名')
  assert.equal(chatCalls.length, callsAfterFirst)
  assert.equal(onebotCalls.length, 0)

  // 入站自带 chat.title 直接缓存到对应 chatId 作用域，不覆盖别的实例
  await hub.onGatewayMessage({
    v: 1,
    instance: 'qq#2',
    platform: 'qq',
    chatId: 'qq#2:group:999',
    kind: 'group',
    chat: { kind: 'group', id: '999', title: '入站群标题' },
    sender: { account: '10001', name: 'A', role: 'member', isOwner: false },
    messageId: 'm_title_1',
    at: Date.now(),
    mentionedMe: false,
    parts: [{ type: 'text', text: 'hi' }],
  })
  assert.equal(await hub.groupName('qq#2:group:999'), '入站群标题')
})
