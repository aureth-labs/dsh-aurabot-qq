// QQ 官方机器人平台端（F3）测试。
//
// 没有真实凭证：全部用可注入的假 client 跑。断言分四类：
//   1) 通用契约：runAdapterContract（test/contract/adapter-kit.js）
//   2) 被动回复：窗口、条数、无 inResponseTo 拒绝、msg_seq 递增
//   3) token：有效期复用、过期前自动刷新、401 强制刷新重试
//   4) 事件转换 / 错误分类 / 验签（含官方 DEMO 签名向量）/ 富媒体上传路径
//
// 跑法：node --test test/adapters/qqbot.test.js

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sign as ed25519Sign, verify as ed25519Verify } from 'node:crypto'

import { runAdapterContract } from '../contract/adapter-kit.js'
import {
  createQqbotAdapter,
  createHttpClient,
  deriveEd25519,
  verifySignature,
  NetworkError,
  TimeoutError,
  REPLY_WINDOW_MS,
  REPLIES_PER_MESSAGE,
} from '../../src/adapters/qqbot/index.js'

// ───────────────────────── 测试替身 ─────────────────────────

/** 可注入的假 client：记录每次请求，按队列注入故障，默认给出平台结构的成功响应。 */
function makeFakeClient(options = {}) {
  const client = {
    calls: [],
    sent: [], // 发消息请求（/messages）
    uploads: [], // 富媒体上传请求（/files）
    faults: [], // 依次消费的故障（函数或 {status, data}）
    tokenCalls: 0,
    async request(req = {}) {
      client.calls.push(req)
      const path = String(req.path || '')

      // 1) token 接口：失败也回 HTTP 200 + code（官方明确要求看 code，不看状态码）
      if (path === '/app/getAppAccessToken') {
        client.tokenCalls++
        if (options.tokenFail) return { status: 200, data: { code: 100016, message: 'invalid appid or secret' } }
        return { status: 200, data: { access_token: `token-${client.tokenCalls}`, expires_in: options.expiresIn ?? 7200 } }
      }

      // 2) 注入的故障（连不上 / 超时 / 平台拒绝）
      const fault = client.faults.shift()
      if (typeof fault === 'function') return fault(req)
      if (fault) return fault

      // 3) 富媒体上传
      if (path.endsWith('/files')) {
        client.uploads.push({ path, body: req.body })
        return { status: 200, data: { file_info: `file-info-${client.uploads.length}` } }
      }
      // 4) 机器人自身信息
      if (path === '/users/@me') return { status: 200, data: { id: 'BOT-OPENID', username: '大齿轮鱼' } }
      // 5) 发消息
      if (path.endsWith('/messages')) {
        client.sent.push({ path, body: req.body })
        return { status: 200, data: { id: `m-${client.sent.length}`, timestamp: 1700000000 } }
      }
      return { status: 404, data: null }
    },
  }
  return client
}

/** 记录型 AdapterContext（形状与 adapter-kit 的 makeCtx 一致，额外支持注入 config）。 */
function makeCtx(adapter, config = {}) {
  const ctx = {
    instance: adapter.id,
    config: () => config,
    emitted: [],
    events: [],
    states: [],
    capsChanges: 0,
    routes: new Map(),
    logs: [],
    route(path, handler) {
      ctx.routes.set(String(path), handler)
      return () => ctx.routes.delete(String(path))
    },
    emit(message) { ctx.emitted.push(message) },
    emitEvent(event) { ctx.events.push(event) },
    state(state, detail) { ctx.states.push([state, detail]) },
    capsChanged() { ctx.capsChanges++ },
    log: {
      debug() {},
      info() {},
      warn(...a) { ctx.logs.push(a) },
      error(...a) { ctx.logs.push(a) },
    },
    dataDir: (...parts) => parts.join('/'),
  }
  ctx.__routes = ctx.routes
  return ctx
}

const BASE_CONFIG = { appId: '102030405', clientSecret: 'client-secret-xyz', botSecret: 'naOC0ocQE3shWLAfffVLB1rhYPG7' }

/** 一份官方「单聊消息事件」样例（C2C_MESSAGE_CREATE） */
const C2C_EVENT = {
  id: 'ROBOT1.0_c2c_msg_1',
  author: {
    id: 'USER-OPENID-A1',
    user_openid: 'USER-OPENID-A1',
    union_openid: 'UNION-OPENID-A1',
    username: '小明',
    bot: false,
  },
  content: '你好，今天有什么推荐的活动吗？',
  message_type: 0,
  message_scene: { source: 'default', ext: ['msg_idx=REFIDX_xxxxxxxxxxxxxxx=='] },
  timestamp: '2026-07-21T10:00:00+08:00',
}

/** 一份官方「群 @ 机器人消息」样例 */
const GROUP_AT_EVENT = {
  id: 'ROBOT1.0_group_msg_1',
  author: { id: 'MEMBER-OPENID-B1', member_openid: 'MEMBER-OPENID-B1', member_role: 'admin', username: '小红', bot: false },
  content: ' 看看这张风景照 ',
  group_openid: 'GROUP-OPENID-B2',
  message_type: 0,
  timestamp: '2026-07-21T10:05:00+08:00',
  attachments: [
    { content_type: 'image/jpeg', filename: 'photo.jpg', url: 'https://multimedia.nt.qq.com.cn/download?fileid=x', width: 1920, height: 1080, size: 256000 },
  ],
  message_scene: { source: 'default', ext: ['msg_idx=REFIDX_yyyyyyyyyy==', 'auth_token=zzz'] },
}

/** 契约测试用的 harness：注入点全部走 adapter.platform 后门。 */
function makeHarness() {
  return {
    injectInbound(adapter) {
      adapter.platform.deliver('C2C_MESSAGE_CREATE', C2C_EVENT)
    },
    /** 验签不过：签名头随便给一个 */
    injectUnverified(adapter, ctx) {
      const handler = ctx.routes.get('/callback') || adapter.platform.deliverWebhook
      const req = { headers: { 'x-signature-timestamp': '1725442341', 'x-signature-ed25519': 'deadbeef', 'x-bot-appid': BASE_CONFIG.appId }, body: C2C_EVENT }
      const res = makeRes()
      handler(req, res)
      assert.equal(res.statusCode, 401, '验签不过必须回 4xx')
    },
    /** 验签通过：用 adapter.platform.sign 造合法签名 */
    injectSigned(adapter, ctx) {
      const handler = ctx.routes.get('/callback') || adapter.platform.deliverWebhook
      const raw = JSON.stringify({ op: 0, s: 1, t: 'C2C_MESSAGE_CREATE', d: C2C_EVENT })
      const ts = '1725442341'
      const req = {
        headers: { 'x-signature-timestamp': ts, 'x-signature-ed25519': adapter.platform.sign(raw, ts), 'x-bot-appid': BASE_CONFIG.appId },
        rawBody: raw,
        body: JSON.parse(raw),
      }
      const res = makeRes()
      handler(req, res)
      assert.equal(res.statusCode, 200, '验签通过应回 200')
    },
    setProactive(adapter, value) { adapter.platform.setProactive(value) },
    failSend(adapter, why) {
      if (why === 'refused') adapter.platform.refuseNext()
      else adapter.platform.hangNext()
    },
    reconnect(adapter) {
      adapter.platform.break()
      adapter.platform.restore()
    },
  }
}

function makeRes() {
  return {
    statusCode: 0,
    body: undefined,
    end(chunk) { if (chunk !== undefined) this.body = chunk },
  }
}

/** 造一个已启动的平台端 + 假 client + 自有 ctx */
async function boot({ config = {}, options = {} } = {}) {
  const client = makeFakeClient(options)
  const adapter = createQqbotAdapter({ client, ...(options.adapter || {}) })
  const ctx = makeCtx(adapter, { ...BASE_CONFIG, ...config })
  await adapter.start(ctx)
  return { adapter, client, ctx }
}

// ───────────────────────── 1. 通用契约 ─────────────────────────

test('qqbot 平台端过全套契约（adapter-kit）', async () => {
  // kit 的 makeCtx 里 config() 返回 {}，所以适配实例默认配置由 options 提供（等价于面板里填好了凭证）
  await runAdapterContract(
    () => createQqbotAdapter({ client: makeFakeClient(), defaultConfig: BASE_CONFIG }),
    makeHarness(),
  )
})

// ───────────────────────── 2. caps 逐字段 ─────────────────────────

test('caps 每个字段都填了，且填的值与官方文档一致', async () => {
  const { adapter } = await boot()
  const caps = adapter.caps()

  // 键给全（kit 也查这一条，这里额外查值）
  const expected = {
    image: true, // 富媒体 file_type=1，支持 png/jpg/gif/webp/bmp
    sticker: false, // 平台没有表情包消息，让网关降级成图片
    voice: 'file', // 语音条要 silk；本包只保证当音频文件发（file_type=4）
    video: true, // file_type=2，仅 mp4
    file: true, // file_type=4，任意格式
    maxFileBytes: 200 * 1024 * 1024, // 富媒体硬限制 200MB
    quoteReply: false, // message_reference 官方标注「暂未支持」
    mention: true, // 文本里可写 <@openid>
    mentionAll: false, // <qqbot-at-everyone /> 要求机器人为群管理员且每群每天 1 次
    poke: false,
    typing: false,
    recall: true, // 可撤回自己 2 分钟内的消息
    card: false,
    listenAllInGroup: false, // 只有群主开了「接收全量消息」才收得到，默认按收不到报
    proactive: 'limited', // 主动能力已收敛：有额度、可被用户/群主关闭
    replyWindowMs: 5 * 60 * 1000, // 群聊 5 分钟（单聊 60 分钟），取严
    repliesPerMessage: 4, // 单聊 4 次 / 群聊 5 次，取严
    history: false,
    memberList: false,
    forwardExpand: false,
  }
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(caps[key], value, `caps.${key} 应为 ${JSON.stringify(value)}，实际 ${JSON.stringify(caps[key])}`)
  }
  // 常量导出与 caps 必须一致，避免两处各写一个数
  assert.equal(caps.replyWindowMs, REPLY_WINDOW_MS)
  assert.equal(caps.repliesPerMessage, REPLIES_PER_MESSAGE)
  assert.equal(adapter.id, 'qqbot')
  assert.equal(adapter.contract, 1)
  assert.ok(Array.isArray(adapter.settings) && adapter.settings.length > 0, 'settings 面板表单不能为空')
})

test('未配置凭证时 start 抛错，不假装连上', async () => {
  const client = makeFakeClient()
  const adapter = createQqbotAdapter({ client })
  const ctx = makeCtx(adapter, {})
  await assert.rejects(() => adapter.start(ctx), /缺少 AppID/)
  assert.equal(ctx.states.at(-1)?.[0], 'unconfigured')
})

// ───────────────────────── 3. token 获取与自动刷新 ─────────────────────────

test('access_token 在有效期内复用，不会每次发消息都重新获取', async () => {
  let clock = 1_700_000_000_000
  const client = makeFakeClient()
  const adapter = createQqbotAdapter({ client, now: () => clock })
  const ctx = makeCtx(adapter, BASE_CONFIG)
  await adapter.start(ctx)
  const afterStart = client.tokenCalls // start 里的 /users/@me 已经取过一次

  await adapter.send({ chat: { kind: 'private', id: 'U1' }, parts: [{ type: 'text', text: 'hi' }], inResponseTo: 'msg-x' })
  await adapter.send({ chat: { kind: 'private', id: 'U1' }, parts: [{ type: 'text', text: 'hi2' }], inResponseTo: 'msg-x' })
  assert.equal(client.tokenCalls, afterStart, '有效期内不该重复获取 token')

  // 推进到「过期前 60 秒」以内：官方说这时再取会拿到新 token，平台端应主动换新
  clock += 7200_000 - 30_000
  client.tokenCalls = 0
  await adapter.send({ chat: { kind: 'private', id: 'U1' }, parts: [{ type: 'text', text: 'after refresh window' }], inResponseTo: 'msg-x' })
  assert.equal(client.tokenCalls, 1, '进入过期前 60 秒窗口后应重新获取 token')
  assert.match(String(adapter.platform.tokenState().value), /token-/)

  // 真的过期后：也一定会换
  clock += 7200_000
  client.tokenCalls = 0
  await adapter.send({ chat: { kind: 'private', id: 'U1' }, parts: [{ type: 'text', text: 'expired' }], inResponseTo: 'msg-x' })
  assert.equal(client.tokenCalls, 1, 'token 过期后应重新获取')
})

test('接口返回 401 时强制换 token 并重试一次（token 过期是最常见失败）', async () => {
  const client = makeFakeClient()
  const adapter = createQqbotAdapter({ client })
  const ctx = makeCtx(adapter, BASE_CONFIG)
  await adapter.start(ctx)

  // 第一次发消息 → 401（token 过期）；重试时故障队列已空 → 正常成功
  client.faults.push({ status: 401, data: { code: 11244, message: 'token expired' } })
  const before = client.tokenCalls
  const result = await adapter.send({ chat: { kind: 'private', id: 'U1' }, parts: [{ type: 'text', text: 'retry' }], inResponseTo: 'msg-r' })
  assert.ok(result.messageId, '401 后应换 token 重试并成功')
  assert.ok(client.tokenCalls > before, '重试前必须重新获取 token')
  assert.equal(client.sent.length, 1, '只应留下重试成功的那一次发送')
})

test('token 接口失败时按响应体 code 判定（HTTP 仍是 200）', async () => {
  const client = makeFakeClient({ tokenFail: true })
  const adapter = createQqbotAdapter({ client })
  const ctx = makeCtx(adapter, BASE_CONFIG)
  // start 里的 /users/@me 会失败但不算致命
  await adapter.start(ctx)
  await assert.rejects(
    () => adapter.send({ chat: { kind: 'private', id: 'U1' }, parts: [{ type: 'text', text: 'x' }], inResponseTo: 'msg-t' }),
    (error) => {
      assert.equal(error.certainty, 'not-sent')
      assert.equal(error.code, 'token-100016')
      return true
    },
  )
})

// ───────────────────────── 4. 被动回复：窗口 / 条数 / 拒绝 ─────────────────────────

test('passive: inResponseTo 作为 msg_id 发出，msg_seq 递增（同一 msg_id 重复回复会失败）', async () => {
  const { adapter, client } = await boot()
  await adapter.send({ chat: { kind: 'group', id: 'G1' }, parts: [{ type: 'text', text: '第一条' }], inResponseTo: 'MSG-A' })
  await adapter.send({ chat: { kind: 'group', id: 'G1' }, parts: [{ type: 'text', text: '第二条' }], inResponseTo: 'MSG-A' })

  assert.equal(client.sent.length, 2)
  assert.equal(client.sent[0].body.msg_id, 'MSG-A', 'inResponseTo 必须变成 msg_id')
  assert.equal(client.sent[0].body.msg_seq, 1, '第一次回复 msg_seq=1')
  assert.equal(client.sent[1].body.msg_seq, 2, '同一 msg_id 的第二次回复必须递增 msg_seq')
  assert.equal(client.sent[0].path, '/v2/groups/G1/messages', '群聊必须打群聊接口')
})

test('passive: 单聊打 /v2/users/{openid}/messages', async () => {
  const { adapter, client } = await boot()
  await adapter.send({ chat: { kind: 'private', id: 'U1' }, parts: [{ type: 'text', text: '嗨' }], inResponseTo: 'MSG-B' })
  assert.equal(client.sent.at(-1).path, '/v2/users/U1/messages')
})

test("passive: proactive='none' 时，不带 inResponseTo 的发送抛 not-sent/proactive-not-allowed", async () => {
  const { adapter, client } = await boot({ config: { proactive: 'none' } })
  await assert.rejects(
    () => adapter.send({ chat: { kind: 'private', id: 'U1' }, parts: [{ type: 'text', text: '主动' }] }),
    (error) => {
      assert.equal(error.certainty, 'not-sent')
      assert.equal(error.code, 'proactive-not-allowed')
      assert.equal(error.instance, 'qqbot')
      return true
    },
    'proactive=none 时主动消息必须被平台端自己拦下',
  )
  assert.equal(client.sent.length, 0, '被拦下的消息不能真的发出去')
})

test('passive: 超出回复窗口后按主动消息处理（proactive=none → 拒绝）', async () => {
  let clock = 1_700_000_000_000
  const client = makeFakeClient()
  const adapter = createQqbotAdapter({ client, now: () => clock })
  const ctx = makeCtx(adapter, { ...BASE_CONFIG, proactive: 'none' })
  await adapter.start(ctx)

  // 造一条入站消息（记账被动窗口起点）
  adapter.platform.deliver('C2C_MESSAGE_CREATE', C2C_EVENT)

  clock += REPLY_WINDOW_MS - 1000 // 还在窗口内
  await adapter.send({ chat: { kind: 'private', id: 'USER-OPENID-A1' }, parts: [{ type: 'text', text: '窗口内' }], inResponseTo: C2C_EVENT.id })

  clock += 2000 // 超出 5 分钟窗口
  await assert.rejects(
    () => adapter.send({ chat: { kind: 'private', id: 'USER-OPENID-A1' }, parts: [{ type: 'text', text: '超窗' }], inResponseTo: C2C_EVENT.id }),
    (error) => {
      assert.equal(error.certainty, 'not-sent')
      assert.equal(error.code, 'proactive-not-allowed')
      return true
    },
    '超窗的回复必须按主动消息算，proactive=none 时拒绝',
  )
})

test('passive: 超过 repliesPerMessage 次回复后拒绝（平台侧硬限制，不等平台报错）', async () => {
  const { adapter, client } = await boot()
  adapter.platform.deliver('C2C_MESSAGE_CREATE', C2C_EVENT)
  const chat = { kind: 'private', id: 'USER-OPENID-A1' }

  for (let i = 1; i <= REPLIES_PER_MESSAGE; i++) {
    await adapter.send({ chat, parts: [{ type: 'text', text: `第 ${i} 条` }], inResponseTo: C2C_EVENT.id })
  }
  const sentBefore = client.sent.length
  await assert.rejects(
    () => adapter.send({ chat, parts: [{ type: 'text', text: '第 5 条' }], inResponseTo: C2C_EVENT.id }),
    (error) => {
      assert.equal(error.certainty, 'not-sent')
      assert.equal(error.code, 'proactive-limit')
      return true
    },
    `一条消息最多回 ${REPLIES_PER_MESSAGE} 次`,
  )
  assert.equal(client.sent.length, sentBefore, '超限的请求不能发出')
  assert.equal(adapter.platform.replyCountOf('private', 'USER-OPENID-A1', C2C_EVENT.id), REPLIES_PER_MESSAGE)
})

test('passive: 一次回复里含多个媒体时，按「回复一次」计数但拆成多条平台消息', async () => {
  const { adapter, client } = await boot()
  adapter.platform.deliver('C2C_MESSAGE_CREATE', C2C_EVENT)
  const chat = { kind: 'private', id: 'USER-OPENID-A1' }
  // 一次 send 带两个媒体：平台一条消息只能带一个 media，所以要拆成两条 API 调用
  await adapter.send({
    chat,
    parts: [
      { type: 'image', media: { url: 'https://example.com/1.png', mime: 'image/png' } },
      { type: 'image', media: { url: 'https://example.com/2.png', mime: 'image/png' } },
    ],
    inResponseTo: C2C_EVENT.id,
  })
  assert.equal(client.sent.length, 2, '两个媒体要拆成两条平台消息')
  assert.equal(client.sent[0].body.msg_seq, 1)
  assert.equal(client.sent[1].body.msg_seq, 2)
  assert.equal(adapter.platform.replyCountOf('private', 'USER-OPENID-A1', C2C_EVENT.id), 1, '按回复次数计 1 次')
})

test('passive: proactive=limited 时主动消息按每日额度记账，超了抛 proactive-limit', async () => {
  const { adapter, client } = await boot({ config: { proactivePerDay: 2 } })
  const chat = { kind: 'group', id: 'G9' }
  await adapter.send({ chat, parts: [{ type: 'text', text: '主动 1' }] })
  await adapter.send({ chat, parts: [{ type: 'text', text: '主动 2' }] })
  await assert.rejects(
    () => adapter.send({ chat, parts: [{ type: 'text', text: '主动 3' }] }),
    (error) => {
      assert.equal(error.certainty, 'not-sent')
      assert.equal(error.code, 'proactive-limit')
      return true
    },
  )
  assert.equal(client.sent.length, 2)
  assert.equal(adapter.platform.proactiveCountOf('group', 'G9'), 2)
})

test('passive: 空内容抛 nothing-to-send，未连接抛 offline', async () => {
  const { adapter } = await boot()
  await assert.rejects(
    () => adapter.send({ chat: { kind: 'private', id: 'U1' }, parts: [], inResponseTo: 'MSG-C' }),
    (error) => { assert.equal(error.certainty, 'not-sent'); assert.equal(error.code, 'nothing-to-send'); return true },
  )
  await adapter.stop()
  await assert.rejects(
    () => adapter.send({ chat: { kind: 'private', id: 'U1' }, parts: [{ type: 'text', text: 'x' }], inResponseTo: 'MSG-C' }),
    (error) => { assert.equal(error.certainty, 'not-sent'); assert.equal(error.code, 'offline'); return true },
  )
})

// ───────────────────────── 5. 错误分类 ─────────────────────────

test('错误分类：连不上 → not-sent；超时 → unknown；平台限流 → not-sent/proactive-limit；5xx → unknown', async () => {
  const { adapter, client } = await boot()
  const chat = { kind: 'private', id: 'U1' }
  const parts = [{ type: 'text', text: '分类' }]

  // 连不上：确定没发出去，可重试
  client.faults.push(() => { throw new NetworkError(Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' })) })
  await assert.rejects(
    () => adapter.send({ chat, parts, inResponseTo: 'E1' }),
    (error) => { assert.equal(error.certainty, 'not-sent'); assert.equal(error.code, 'network'); return true },
  )

  // 超时：不知道发没发出去，绝不重发
  client.faults.push(() => { throw new TimeoutError(8000) })
  await assert.rejects(
    () => adapter.send({ chat, parts, inResponseTo: 'E2' }),
    (error) => { assert.equal(error.certainty, 'unknown'); assert.equal(error.code, 'timeout'); return true },
  )

  // 平台明确拒绝 22009（消息发送超频）
  client.faults.push({ status: 400, data: { code: 22009, message: 'msg limit exceed' } })
  await assert.rejects(
    () => adapter.send({ chat, parts, inResponseTo: 'E3' }),
    (error) => { assert.equal(error.certainty, 'not-sent'); assert.equal(error.code, 'proactive-limit'); return true },
  )

  // 富媒体拉取失败 304082
  client.faults.push({ status: 400, data: { code: 304082, message: 'upload media info fail' } })
  await assert.rejects(
    () => adapter.send({ chat, parts, inResponseTo: 'E4' }),
    (error) => { assert.equal(error.certainty, 'not-sent'); assert.equal(error.code, 'media-fetch-failed'); return true },
  )

  // 5xx：响应含义不明 → unknown（拿不准必须 unknown）
  client.faults.push({ status: 502, data: null })
  await assert.rejects(
    () => adapter.send({ chat, parts, inResponseTo: 'E5' }),
    (error) => { assert.equal(error.certainty, 'unknown'); return true },
  )

  // 连上了、平台成功：要能发出去（上面的故障都各消费一次）
  const ok = await adapter.send({ chat, parts, inResponseTo: 'E6' })
  assert.ok(ok.messageId)
})

// ───────────────────────── 6. 事件转换 ─────────────────────────

test('事件转换：C2C 单聊事件 → AdapterInbound（openid 做 account，union_openid 进 alt）', async () => {
  const { adapter, ctx } = await boot()
  adapter.platform.deliver('C2C_MESSAGE_CREATE', C2C_EVENT)
  assert.equal(ctx.emitted.length, 1)
  const m = ctx.emitted[0]

  assert.equal(m.chat.kind, 'private')
  assert.equal(m.chat.id, 'USER-OPENID-A1', '私聊 chat.id 用 user_openid')
  assert.equal(m.sender.account, 'USER-OPENID-A1', 'openid 做 account')
  assert.equal(m.sender.alt, 'UNION-OPENID-A1', 'union_openid 存 alt')
  assert.equal(m.sender.name, '小明')
  assert.equal(m.sender.role, '', '私聊没有群身份')
  assert.equal(m.messageId, C2C_EVENT.id)
  assert.equal(m.at, Date.parse('2026-07-21T10:00:00+08:00'), 'at 用平台给的时间（毫秒）')
  assert.equal(m.mentionedMe, true, '单聊天然是在跟她说话')
  assert.deepEqual(m.parts, [{ type: 'text', text: '你好，今天有什么推荐的活动吗？' }])
  assert.equal(m.raw, C2C_EVENT)
  assert.equal(m.ext.eventType, 'C2C_MESSAGE_CREATE')
  assert.equal(m.ext.unionOpenid, 'UNION-OPENID-A1')
})

test('事件转换：群 @ 事件 → kind=group、角色映射、图片附件、@ 前缀已被平台去掉', async () => {
  const { adapter, ctx } = await boot()
  adapter.platform.deliver('GROUP_AT_MESSAGE_CREATE', GROUP_AT_EVENT)
  const m = ctx.emitted.at(-1)

  assert.equal(m.chat.kind, 'group')
  assert.equal(m.chat.id, 'GROUP-OPENID-B2')
  assert.equal(m.sender.account, 'MEMBER-OPENID-B1')
  assert.equal(m.sender.role, 'admin', 'member_role=admin 要映射成 admin')
  assert.equal(m.mentionedMe, true, '群 @ 事件天生就是 @ 了她')
  assert.equal(m.parts[0].type, 'text')
  assert.equal(m.parts[0].text.trim(), '看看这张风景照')
  const image = m.parts.find((p) => p.type === 'image')
  assert.ok(image, '附件图片要变成 image Part')
  assert.equal(image.media.mime, 'image/jpeg')
  assert.equal(image.media.width, 1920)
  assert.equal(m.ext.groupOpenid, 'GROUP-OPENID-B2')
  assert.equal(m.ext.msgIdx, 'REFIDX_yyyyyyyyyy==')
})

test('事件转换：全量群消息里的 <@openid> / <@all> 拆成 mention，@自己体现在 mentionedMe', async () => {
  const { adapter, ctx } = await boot()
  const full = {
    id: 'FULL-1',
    author: { member_openid: 'M1', member_role: 'owner', username: '群主' },
    content: '<@BOT-OPENID> 你好 <@M2> 还有 <@all>',
    group_openid: 'G7',
    message_type: 0,
    timestamp: '2026-07-21T11:00:00+08:00',
    mentions: [{ id: 'M2', username: '小刚' }],
  }
  adapter.platform.deliver('GROUP_MESSAGE_CREATE', full)
  const m = ctx.emitted.at(-1)

  assert.equal(m.sender.role, 'owner')
  assert.equal(m.mentionedMe, true, 'content 里 @ 了机器人自己')
  assert.ok(!m.parts.some((p) => p.type === 'mention' && p.account === 'BOT-OPENID'), '@自己 不进 parts')
  const mentions = m.parts.filter((p) => p.type === 'mention')
  assert.deepEqual(mentions.map((p) => p.account), ['M2', 'all'])
  assert.equal(mentions[0].name, '小刚')
  assert.ok(m.parts.some((p) => p.type === 'text' && p.text.includes('你好')))

  // 没 @ 她：mentionedMe=false（中枢据此判断要不要回）
  adapter.platform.deliver('GROUP_MESSAGE_CREATE', { ...full, id: 'FULL-2', content: '大家早上好' })
  assert.equal(ctx.emitted.at(-1).mentionedMe, false)
})

test('事件转换：卡片 / 引用消息 / 未知事件', async () => {
  const { adapter, ctx } = await boot()

  // ark 卡片
  adapter.platform.deliver('C2C_MESSAGE_CREATE', {
    id: 'ARK-1',
    author: { user_openid: 'U-ARK' },
    content: '',
    message_type: 3,
    ark_data: { ark_type: 'miniapp', ark_name: '小程序', prompt: '快来完成今日学习打卡', fields: { title: '快来完成今日打卡', source: '学习助手', jump_url: 'https://example.com/x' } },
    timestamp: '2026-07-21T10:01:00+08:00',
  })
  const card = ctx.emitted.at(-1).parts.find((p) => p.type === 'card')
  assert.ok(card, 'ark_data 要变成 card Part')
  assert.equal(card.title, '快来完成今日打卡')
  assert.equal(card.url, 'https://example.com/x')
  assert.equal(card.from, '学习助手')

  // 引用消息（message_type=103）：被引用正文单独占位，不假装是这次说的
  adapter.platform.deliver('C2C_MESSAGE_CREATE', {
    id: 'QUOTE-1',
    author: { user_openid: 'U-Q' },
    content: '这个建议很有帮助，谢谢你！',
    message_type: 103,
    msg_elements: [{ msg_idx: 'REF1', message_type: 103, content: '每天坚持阅读半小时' }],
    timestamp: '2026-07-21T10:02:00+08:00',
  })
  const quote = ctx.emitted.at(-1).parts.find((p) => p.type === 'other' && String(p.text).startsWith('[引用'))
  assert.ok(quote, '引用正文要作为 other 占位保留')

  // 非消息事件：走 emitEvent('native')，不进 emit（否则会把事件当对话写进记忆）
  const before = ctx.emitted.length
  adapter.platform.deliver('GROUP_ADD_ROBOT', { group_openid: 'G1', op_member_openid: 'U1', timestamp: 1700000000 })
  assert.equal(ctx.emitted.length, before, '非消息事件不能 emit')
  assert.equal(ctx.events.at(-1).type, 'native')
  assert.equal(ctx.events.at(-1).name, 'GROUP_ADD_ROBOT')
})

test('事件转换：缺关键字段的事件直接丢弃，不 emit 半条消息', async () => {
  const { adapter, ctx } = await boot()
  adapter.platform.deliver('C2C_MESSAGE_CREATE', { id: 'X1', author: {}, content: 'hi' }) // 没有 openid
  adapter.platform.deliver('C2C_MESSAGE_CREATE', { author: { user_openid: 'U1' }, content: 'hi' }) // 没有 id
  assert.equal(ctx.emitted.length, 0)
})

test('stop 之后即使平台再推事件也不再 emit', async () => {
  const { adapter, ctx } = await boot()
  adapter.platform.deliver('C2C_MESSAGE_CREATE', C2C_EVENT)
  const before = ctx.emitted.length
  await adapter.stop()
  adapter.platform.deliver('C2C_MESSAGE_CREATE', { ...C2C_EVENT, id: 'AFTER-STOP' })
  assert.equal(ctx.emitted.length, before)
  assert.equal(ctx.states.at(-1)?.[0], 'stopped')
})

// ───────────────────────── 7. 验签（Ed25519） ─────────────────────────

test('验签：Ed25519 密钥派生与官方文档 DEMO 的公钥逐字节一致', () => {
  // 官方「安全和授权」页 DEMO：secret → seed → publicKey（32 字节）
  const keys = deriveEd25519('naOC0ocQE3shWLAfffVLB1rhYPG7')
  const pubRaw = Buffer.from(keys.publicKey.export({ format: 'jwk' }).x, 'base64url')
  const demoSec = 'naOC0ocQE3shWLAfffVLB1rhYPG7'
  assert.equal(pubRaw.length, 32)
  // 官方 DEMO 输出：publicKey: [215 195 98 254 ... 118 103 58]
  assert.deepEqual(
    [...pubRaw],
    [215, 195, 98, 254, 120, 174, 248, 31, 242, 50, 135, 180, 147, 98, 139, 93, 176, 42, 60, 79, 227, 11, 33, 94, 77, 25, 96, 155, 93, 118, 103, 58],
    'seed = repeat(secret) 截断 32 字节 → Ed25519 公钥，必须与官方 DEMO 相同',
  )
  // 官方 DEMO 的 seed 也写了：naOC0ocQE3shWLAfffVLB1rhYPG7naOC
  let seed = Buffer.from(demoSec, 'utf8')
  while (seed.length < 32) seed = Buffer.concat([seed, seed])
  assert.equal(seed.subarray(0, 32).toString('utf8'), 'naOC0ocQE3shWLAfffVLB1rhYPG7naOC')

  // 签名/验签自洽：我们自己签的能验过，改一个字节就验不过。
  // （官方文档给的 sig 示例与 body 空格/时间戳不完全自洽，不能当固定向量用，
  //   见 docs/ADAPTER-QQBOT.md「未确认点」第 6 条。）
  const body = '{ "op": 0,"d": {}, "t": "GATEWAY_EVENT_NAME"}'
  const ts = '1725442341'
  const sig = payloadSignature(keys, ts, body)
  assert.match(sig, /^[0-9a-f]{128}$/)
  assert.equal(verifySignature(keys, sig, ts, body), true)
  assert.equal(verifySignature(keys, sig, ts, body + ' '), false, 'body 改一个字节必须验不过')
  assert.equal(verifySignature(keys, sig, '1725442342', body), false, '时间戳不同必须验不过')
  assert.equal(verifySignature(keys, 'zz', ts, body), false, '非法签名格式返回 false 而不是抛错')
  assert.equal(verifySignature(null, sig, ts, body), false, '没有密钥时必须 false（配置缺失不能放行）')
})

test('验签：回调验证（op=13）返回 plain_token + 合法 signature，且不 emit', async () => {
  const { adapter, ctx } = await boot()
  const handler = ctx.routes.get('/callback')
  const payload = { d: { plain_token: 'Arq0D5A61EgUu4OxUvOp', event_ts: '1725442341' }, op: 13 }
  const raw = JSON.stringify(payload)
  const ts = '1725442341'
  const req = { headers: { 'x-signature-timestamp': ts, 'x-signature-ed25519': adapter.platform.sign(raw, ts) }, rawBody: raw }
  const res = makeRes()
  handler(req, res)

  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.plain_token, 'Arq0D5A61EgUu4OxUvOp')
  assert.match(body.signature, /^[0-9a-f]{128}$/, 'signature 是 64 字节的小写 hex')
  // 用公钥独立验一遍：Ed25519(event_ts + plain_token)
  const keys = deriveEd25519(BASE_CONFIG.botSecret)
  const ok = ed25519Verify(
    null,
    Buffer.concat([Buffer.from('1725442341'), Buffer.from('Arq0D5A61EgUu4OxUvOp')]),
    keys.publicKey,
    Buffer.from(body.signature, 'hex'),
  )
  assert.equal(ok, true, '回调验证签名必须能被对应公钥验过')
  assert.equal(ctx.emitted.length, 0, '验证请求不是消息，不能 emit')
})

test('验签：验不过一律 401 且不 emit；X-Bot-Appid 不匹配回 403', async () => {
  const { adapter, ctx } = await boot()
  const handler = ctx.routes.get('/callback')
  const raw = JSON.stringify({ op: 0, t: 'C2C_MESSAGE_CREATE', d: C2C_EVENT })
  const ts = '1725442341'

  // 签名错
  let res = makeRes()
  handler({ headers: { 'x-signature-timestamp': ts, 'x-signature-ed25519': '0'.repeat(128) }, rawBody: raw }, res)
  assert.equal(res.statusCode, 401)
  assert.equal(ctx.emitted.length, 0)

  // 缺签名头
  res = makeRes()
  handler({ headers: {}, rawBody: raw }, res)
  assert.equal(res.statusCode, 401)
  assert.equal(ctx.emitted.length, 0)

  // 签名对但 AppID 头不是自己的
  res = makeRes()
  handler({ headers: { 'x-signature-timestamp': ts, 'x-signature-ed25519': adapter.platform.sign(raw, ts), 'x-bot-appid': '999' }, rawBody: raw }, res)
  assert.equal(res.statusCode, 403)
  assert.equal(ctx.emitted.length, 0)

  // 签名对、AppID 对 → 200 且 emit 一条
  res = makeRes()
  handler({ headers: { 'x-signature-timestamp': ts, 'x-signature-ed25519': adapter.platform.sign(raw, ts), 'x-bot-appid': BASE_CONFIG.appId }, rawBody: raw }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(ctx.emitted.length, 1)
  assert.deepEqual(JSON.parse(res.body), { op: 12, d: {} }, '回调要回 op 12 ACK')
})

// ───────────────────────── 8. 富媒体 ─────────────────────────

test('富媒体：图片先上传拿 file_info，再用 msg_type=7 发送；单聊 / 群聊上传接口不互通', async () => {
  const { adapter, client } = await boot()
  await adapter.send({
    chat: { kind: 'group', id: 'G1' },
    parts: [
      { type: 'text', text: '给你看' },
      { type: 'image', media: { url: 'https://example.com/a.png', mime: 'image/png' } },
    ],
    inResponseTo: 'M1',
  })

  assert.equal(client.uploads.length, 1, '图片要先上传')
  assert.equal(client.uploads[0].path, '/v2/groups/G1/files', '群聊必须走群聊上传接口')
  assert.equal(client.uploads[0].body.file_type, 1, '图片 file_type=1')
  assert.equal(client.uploads[0].body.url, 'https://example.com/a.png')
  assert.equal(client.uploads[0].body.srv_send_msg, false, '上传时不能顺手发送（会额外吃主动消息额度）')

  // 文本一条 + 媒体一条，顺序保持
  assert.equal(client.sent.length, 2)
  assert.equal(client.sent[0].body.msg_type, 0)
  assert.equal(client.sent[0].body.content, '给你看')
  assert.equal(client.sent[1].body.msg_type, 7)
  assert.equal(client.sent[1].body.media.file_info, 'file-info-1')
  assert.equal(client.sent[1].body.content, ' ', 'msg_type=7 时 content 仍需给值（官方错误码提示）')
  assert.equal(client.sent[1].body.msg_seq, 2, '同一条入站消息的两次发送要递增 msg_seq')
  assert.equal(client.sent[0].body.msg_seq, 1)
})

test('富媒体：没有公网 URL 时明确抛 not-sent/media-url-required（不静默丢内容）', async () => {
  const { adapter, client } = await boot()
  await assert.rejects(
    () => adapter.send({
      chat: { kind: 'private', id: 'U1' },
      parts: [{ type: 'image', media: { path: 'C:/tmp/a.png' } }],
      inResponseTo: 'M2',
    }),
    (error) => {
      assert.equal(error.certainty, 'not-sent')
      assert.equal(error.code, 'media-url-required')
      return true
    },
  )
  assert.equal(client.sent.length, 0)
})

test('富媒体：文件超过 200MB 上限抛 too-large', async () => {
  const { adapter } = await boot()
  await assert.rejects(
    () => adapter.send({
      chat: { kind: 'private', id: 'U1' },
      parts: [{ type: 'file', media: { url: 'https://example.com/big.zip', size: 201 * 1024 * 1024 } }],
      inResponseTo: 'M3',
    }),
    (error) => {
      assert.equal(error.certainty, 'not-sent')
      assert.equal(error.code, 'too-large')
      return true
    },
  )
})

// ───────────────────────── 9. 其它 ─────────────────────────

test('caps 可由配置改小（proactive / listenAllInGroup），但不会被配置放大', async () => {
  const { adapter } = await boot({ config: { proactive: 'none', listenAllInGroup: true } })
  assert.equal(adapter.caps().proactive, 'none')
  assert.equal(adapter.caps().listenAllInGroup, true)
  // 平台端没声明的能力，配置也说不出来
  adapter.platform.setCapsOverride({ history: true })
  assert.equal(adapter.caps().history, true, 'setCapsOverride 是测试后门，允许改')
})

test('whoami 在拿不到 /users/@me 时用配置兜底，不抛错', async () => {
  const client = makeFakeClient()
  const adapter = createQqbotAdapter({ client })
  const ctx = makeCtx(adapter, { ...BASE_CONFIG, selfOpenid: 'FALLBACK-BOT', selfName: '兜底名' })
  client.faults.push(() => { throw new NetworkError(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })) })
  await adapter.start(ctx)
  const me = await adapter.whoami()
  assert.equal(me.account, 'FALLBACK-BOT')
  assert.equal(me.name, '兜底名')
})

test('createHttpClient：连不上抛 NetworkError，超时抛 TimeoutError（供上层分类）', async () => {
  // 连不上
  const refused = createHttpClient({ fetchImpl: async () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) } })
  await assert.rejects(() => refused.request({ path: '/x' }), (error) => error.name === 'NetworkError')

  // 超时：never resolve
  const hang = createHttpClient({ fetchImpl: () => new Promise(() => {}) })
  await assert.rejects(() => hang.request({ path: '/x', timeoutMs: 20 }), (error) => error.name === 'TimeoutError')
})

test('createHttpClient：用内置 fetch 拼 URL / query / JSON body（不引依赖）', async () => {
  const seen = []
  const client = createHttpClient({
    baseUrl: 'https://api.bot.qq.com',
    fetchImpl: async (url, init) => {
      seen.push({ url, init })
      return { status: 200, headers: {}, text: async () => '{"ok":true}' }
    },
  })
  const res = await client.request({ method: 'POST', path: '/v2/users/U1/messages', body: { msg_type: 0 }, query: { x: 1 } })
  assert.equal(seen[0].url, 'https://api.bot.qq.com/v2/users/U1/messages?x=1')
  assert.equal(seen[0].init.method, 'POST')
  assert.equal(seen[0].init.headers['Content-Type'], 'application/json')
  assert.equal(seen[0].init.body, '{"msg_type":0}')
  assert.deepEqual(res.data, { ok: true })
})

/** 用派生出的私钥签 timestamp+body，返回小写 hex（用来对官方 DEMO 向量） */
function payloadSignature(keys, timestamp, body) {
  const msg = Buffer.concat([Buffer.from(String(timestamp), 'utf8'), Buffer.from(String(body), 'utf8')])
  // 官方 DEMO 的 sig 是 ed25519.Sign(privateKey, timestamp+body) 的 hex
  return ed25519Sign(null, msg, keys.privateKey).toString('hex')
}
