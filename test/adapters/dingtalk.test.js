// 钉钉机器人（dingtalk · DingTalk Stream）平台端测试：
//   - runAdapterContract 全套契约测试
//   - connections/open (Accept: application/json)、SYSTEM ping/disconnect、EVENT/CALLBACK 即时 ACK
//   - 入站解析（单聊/群聊、picture/file/voice/richText/repliedMsg、self-sent）与媒体下载
//   - 出站发送（sessionWebhook 优先 vs OpenAPI batchSend/groupMessages/send、图片/文件上传、SendError 分类）
//   - 本地路径白名单、SSRF 防护与 replyGuard/proactiveGuard 撤销门控
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

import { runAdapterContract, makeCtx } from '../contract/adapter-kit.js'
import { assertPublicUrl } from '../../src/core/net.js'
import {
  CAPS_DINGTALK,
  createDingtalkAdapter,
  makeDingtalkMediaId,
  normalizeDingtalkSessionWebhook,
  parseDingtalkInbound,
  TOPIC_ROBOT,
} from '../../src/adapters/dingtalk/index.js'

class FakeWs extends EventEmitter {
  constructor(url) {
    super()
    this.url = url
    this.readyState = 0
    this.sentFrames = []
    this.closed = false
    queueMicrotask(() => {
      if (this.closed) return
      this.readyState = 1
      this.emit('open')
    })
  }
  send(data) {
    this.sentFrames.push(JSON.parse(String(data)))
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.readyState = 3
    this.emit('close', 1000, 'closed')
  }
  pushServerJson(obj) {
    this.emit('message', JSON.stringify(obj))
  }
}

function jsonResp(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    async json() { return body },
    async text() { return JSON.stringify(body) },
  }
}

function makeDingtalkMock({ customFetch = null } = {}) {
  const calls = []
  const sockets = []
  let seq = 0

  const fetchImpl = async (url, init = {}) => {
    const u = String(url)
    const isForm = typeof FormData !== 'undefined' && init.body instanceof FormData
    let parsedBody = null
    if (!isForm && typeof init.body === 'string' && init.body) {
      try { parsedBody = JSON.parse(init.body) } catch {}
    }
    calls.push({ url: u, method: init.method || 'GET', headers: init.headers || {}, body: parsedBody, isForm })

    if (customFetch) {
      const override = await customFetch({ url: u, init, body: parsedBody, isForm })
      if (override) return override
    }
    if (u.endsWith('/v1.0/gateway/connections/open')) {
      return jsonResp({ endpoint: 'wss://wss-open.dingtalk.com/connect', ticket: 'dt_ticket_1' })
    }
    if (u.endsWith('/v1.0/oauth2/accessToken')) {
      return jsonResp({ accessToken: 'dt_tok_1', expireIn: 7200 })
    }
    if (u.includes('/media/upload?')) {
      return jsonResp({ errcode: 0, media_id: `@lADPDg_${++seq}` })
    }
    if (u.endsWith('/v1.0/robot/oToMessages/batchSend') || u.endsWith('/v1.0/robot/groupMessages/send') || u.startsWith('https://oapi.dingtalk.com/robot/sendBySession')) {
      return jsonResp({ processQueryKey: `dt_msg_${++seq}` })
    }
    if (u.endsWith('/v1.0/robot/messageFiles/download')) {
      return jsonResp({ downloadUrl: 'http://files.dingtalk.com/download/blob_1' })
    }
    if (u === 'https://files.dingtalk.com/download/blob_1') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/octet-stream' },
        async arrayBuffer() { return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2]).buffer },
      }
    }
    return jsonResp({}, 404)
  }

  const createWebSocket = (wsUrl) => {
    const sock = new FakeWs(wsUrl)
    sockets.push(sock)
    return sock
  }

  return { calls, sockets, fetchImpl, createWebSocket }
}

function makeRobotPayload(seq = 1, overrides = {}) {
  return {
    msgId: `dt_in_${seq}`,
    createAt: Date.now(),
    conversationType: '1',
    senderStaffId: '10001',
    senderId: '$:LWCP_v1:sender',
    senderNick: '张三',
    robotCode: 'ding_bot_1',
    chatbotUserId: '$:LWCP_v1:bot',
    msgtype: 'text',
    text: { content: `你好钉钉 #${seq}` },
    sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=abc123',
    sessionWebhookExpiredTime: Date.now() + 3600_000,
    ...overrides,
  }
}

test('钉钉平台端过全套契约（runAdapterContract）', async () => {
  let seq = 0
  const harness = {
    config: { clientId: 'ding_bot_1', clientSecret: 'ding_secret_1' },
    makeAdapter() {
      const mock = makeDingtalkMock()
      return createDingtalkAdapter({
        fetchImpl: mock.fetchImpl,
        createWebSocket: mock.createWebSocket,
        assertUrl: async (u) => {
          if (String(u).startsWith('https://example.com/') || String(u).startsWith('https://files.dingtalk.com/')) return
          return assertPublicUrl(u)
        },
      })
    },
    async injectInbound(adapter) {
      adapter.platform.deliver(makeRobotPayload(++seq))
    },
    async injectUnverified(adapter) {
      adapter.platform.injectFrame({
        type: 'CALLBACK',
        headers: { topic: TOPIC_ROBOT, messageId: `self_${++seq}` },
        data: JSON.stringify(makeRobotPayload(seq, { senderId: '$:LWCP_v1:bot', senderStaffId: 'bot_staff' })),
      })
      adapter.platform.injectFrame('not-valid-json')
    },
    async injectSigned(adapter) {
      adapter.platform.deliver(makeRobotPayload(++seq))
    },
    setProactive(adapter, value) {
      adapter.platform.setProactive(value)
    },
    failSend(adapter, why) {
      if (why === 'refused') adapter.platform.refuseNext()
      else adapter.platform.hangNext()
    },
    reconnect(adapter) {
      adapter.platform.reconnect()
    },
  }
  await runAdapterContract(harness.makeAdapter, harness)
})

test('钉钉 Stream 握手、Accept JSON、SYSTEM ping/disconnect 重连与 CALLBACK 即时 ACK', async () => {
  const mock = makeDingtalkMock()
  const adapter = createDingtalkAdapter({
    fetchImpl: mock.fetchImpl,
    createWebSocket: mock.createWebSocket,
    reconnectBaseMs: 30,
    reconnectMaxMs: 60,
  })
  const ctx = makeCtx(adapter, { clientId: 'ding_bot_1', clientSecret: 'ding_secret_1' })
  await adapter.start(ctx)

  const openCall = mock.calls.find((c) => c.url.endsWith('/v1.0/gateway/connections/open'))
  assert.ok(openCall)
  assert.equal(openCall.headers.Accept || openCall.headers.accept, 'application/json')
  assert.equal(mock.sockets[0].url, 'wss://wss-open.dingtalk.com/connect?ticket=dt_ticket_1')

  const ws0 = mock.sockets[0]
  ws0.pushServerJson({
    type: 'SYSTEM',
    headers: { topic: 'ping', messageId: 'ping_1' },
    data: '{"opaque":"123"}',
  })
  assert.equal(ws0.sentFrames[0].code, 200)
  assert.equal(ws0.sentFrames[0].headers.topic, 'ping')

  ws0.pushServerJson({
    type: 'CALLBACK',
    headers: { topic: TOPIC_ROBOT, messageId: 'cb_1' },
    data: JSON.stringify(makeRobotPayload(10)),
  })
  assert.equal(ctx.emitted.length, 1)
  assert.equal(ctx.emitted[0].chat.kind, 'private')
  assert.equal(ctx.emitted[0].chat.id, '10001')
  assert.equal(ws0.sentFrames[1].headers.messageId, 'cb_1')
  assert.equal(JSON.parse(ws0.sentFrames[1].data).response.success, true)

  // 服务端 SYSTEM disconnect 后自动重连，stop() 后彻底停止且迟到消息绝不 emit
  ws0.pushServerJson({ type: 'SYSTEM', headers: { topic: 'disconnect', messageId: 'disc_1' }, data: '{}' })
  await delay(80)
  assert.ok(mock.sockets.length >= 2)
  assert.equal(ctx.states.at(-1)?.[0], 'connected')

  await adapter.stop()
  mock.sockets.at(-1).emit('message', JSON.stringify({
    type: 'CALLBACK',
    headers: { topic: TOPIC_ROBOT, messageId: 'cb_late' },
    data: JSON.stringify(makeRobotPayload(99)),
  }))
  assert.equal(ctx.emitted.length, 1)
})

test('钉钉入站媒体（picture/file/voice/richText/repliedMsg）、fetch 解密下载、出站 webhook/OpenAPI 与本地路径安全边界', async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'aurabot-dt-media-'))
  const outsideDir = mkdtempSync(join(tmpdir(), 'aurabot-dt-out-'))
  t.after(() => {
    rmSync(workDir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  })
  const chinesePath = join(workDir, '测试截图.png')
  writeFileSync(chinesePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]))
  const outsidePath = join(outsideDir, 'secret.png')
  writeFileSync(outsidePath, Buffer.from([1, 2, 3, 4]))

  let failMode = ''
  const mock = makeDingtalkMock({
    customFetch: async ({ url }) => {
      if (failMode === 'hang' && url.includes('/robot/')) {
        return new Promise(() => {})
      }
      if (failMode === '500' && url.includes('/robot/')) {
        return jsonResp({ message: 'internal error' }, 500)
      }
      if (failMode === '403' && url.includes('/robot/')) {
        return jsonResp({ code: 'Forbidden.AccessDenied' }, 403)
      }
      return null
    },
  })

  const adapter = createDingtalkAdapter({
    fetchImpl: mock.fetchImpl,
    createWebSocket: mock.createWebSocket,
    allowedLocalDirs: [workDir],
    assertUrl: async (u) => {
      if (String(u).startsWith('https://files.dingtalk.com/')) return
      return assertPublicUrl(u)
    },
  })
  const ctx = makeCtx(adapter, { clientId: 'ding_bot_1', clientSecret: 'ding_secret_1' })
  await adapter.start(ctx)

  // 解析 group richText + repliedMsg + picture + voice
  const parsedGroup = parseDingtalkInbound({
    msgId: 'dt_grp_1',
    createAt: '1700000000',
    conversationType: '2',
    conversationId: 'cid_group_1',
    conversationTitle: '研发群',
    senderStaffId: 'staff_2',
    senderNick: '李四',
    isAdmin: true,
    isInAtList: true,
    robotCode: 'ding_bot_1',
    msgtype: 'text',
    text: { content: '回复这条', isReplyMsg: true, repliedMsg: { msgId: 'dt_prev_0' } },
  })
  assert.equal(parsedGroup.inbound.chat.kind, 'group')
  assert.equal(parsedGroup.inbound.sender.role, 'admin')
  assert.equal(parsedGroup.inbound.replyTo, 'dt_prev_0')
  assert.equal(parsedGroup.inbound.at, 1700000000 * 1000)

  // 入站 picture -> fetch(media) 自动将 http 升 https 并下载
  adapter.platform.deliver({
    msgId: 'dt_pic_1',
    conversationType: '1',
    senderStaffId: '10001',
    robotCode: 'ding_bot_1',
    msgtype: 'picture',
    content: JSON.stringify({ downloadCode: 'dc_pic_1' }),
    sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=w1',
    sessionWebhookExpiredTime: Date.now() + 60_000,
  })
  const picPart = ctx.emitted[0].parts[0]
  assert.equal(picPart.type, 'image')
  assert.equal(picPart.media.id, makeDingtalkMediaId('ding_bot_1', 'dc_pic_1'))
  const fetched = await adapter.fetch({ kind: 'media', media: picPart.media })
  assert.deepEqual([...fetched.bytes], [0x89, 0x50, 0x4e, 0x47, 1, 2])
  assert.equal(fetched.mime, 'image/png')

  // 被动文本走 sessionWebhook，非文本/主动消息走 OpenAPI，file:// 中文路径正确解码上传
  await adapter.send({
    chat: { kind: 'private', id: '10001' },
    inResponseTo: 'dt_pic_1',
    parts: [
      { type: 'text', text: '看这张图' },
      { type: 'image', media: { path: pathToFileURL(chinesePath).href, mime: 'image/png', name: '测试截图.png' } },
    ],
  })
  assert.ok(mock.calls.some((c) => c.url.includes('/robot/sendBySession')))
  assert.ok(mock.calls.some((c) => c.url.includes('/media/upload?access_token=dt_tok_1&type=image')))
  const batchCall = mock.calls.find((c) => c.url.endsWith('/v1.0/robot/oToMessages/batchSend'))
  assert.equal(batchCall.body.msgKey, 'sampleImageMsg')

  // 目录越界与内网 SSRF 被拒绝为 not-sent
  await assert.rejects(
    () => adapter.send({ chat: { kind: 'private', id: '10001' }, parts: [{ type: 'image', media: { path: outsidePath } }] }),
    (e) => e.certainty === 'not-sent' && e.code === 'local-path-blocked',
  )
  await assert.rejects(
    () => adapter.send({ chat: { kind: 'private', id: '10001' }, parts: [{ type: 'image', media: { url: 'http://127.0.0.1:8080/a.png' } }] }),
    (e) => e.certainty === 'not-sent' && e.code === 'ssrf-blocked',
  )
  assert.throws(() => normalizeDingtalkSessionWebhook('https://evil.example.com/hook'))

  // 错误分类与 replyGuard 撤销
  failMode = '403'
  await assert.rejects(
    () => adapter.send({ chat: { kind: 'group', id: 'cid_1' }, parts: [{ type: 'text', text: 'hi' }] }),
    (e) => e.certainty === 'not-sent' && e.code === 'permission-denied',
  )
  failMode = '500'
  await assert.rejects(
    () => adapter.send({ chat: { kind: 'group', id: 'cid_1' }, parts: [{ type: 'text', text: 'hi' }] }),
    (e) => e.certainty === 'unknown',
  )
  failMode = 'hang'
  await assert.rejects(
    () => adapter.send({ chat: { kind: 'group', id: 'cid_1' }, parts: [{ type: 'text', text: 'hi' }], timeoutMs: 80 }),
    (e) => e.certainty === 'unknown' && e.code === 'timeout',
  )
  failMode = ''
  await assert.rejects(
    () => adapter.send({ chat: { kind: 'private', id: '10001' }, inResponseTo: 'dt_pic_1', parts: [{ type: 'text', text: 'x' }] }, { replyGuard: () => false }),
    (e) => e.certainty === 'not-sent' && e.code === 'reply-revoked',
  )
  await adapter.stop()
})

test('CAPS_DINGTALK 字段完整声明（20 L1 + 14 L2）', () => {
  assert.equal(CAPS_DINGTALK.proactive, 'free')
  assert.equal(CAPS_DINGTALK.voice, 'native')
  assert.equal(CAPS_DINGTALK.mentionAll, true)
  assert.equal(CAPS_DINGTALK.quoteReply, false)
  assert.equal(CAPS_DINGTALK.features['message.quote.read'], true)
  assert.equal(CAPS_DINGTALK.features['message.quote.send'], false)
  assert.equal(Object.keys(CAPS_DINGTALK.features).length, 14)
})

test('钉钉出站语音条：合法 AMR 发送 sampleAudio（含真实毫秒时长），非 AMR 且无 FFmpeg 诚实降级 sampleFile', async () => {
  const frame = Buffer.alloc(32, 0xaa)
  frame[0] = (7 << 3) | 0x04
  const validAmr1s = Buffer.concat([Buffer.from('#!AMR\n', 'ascii'), ...Array.from({ length: 50 }, () => frame)])
  const fakeMp3WithAmrMime = Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00'), Buffer.alloc(64, 0x11)])

  const uploadedNames = []
  const mock = makeDingtalkMock({
    customFetch: async ({ url, init }) => {
      if (url.includes('/media/upload?') && init.body && typeof init.body.get === 'function') {
        const f = init.body.get('media')
        uploadedNames.push({ url, fileName: f?.name || '', fileType: f?.type || '' })
      }
      return null
    },
  })
  const adapter = createDingtalkAdapter({
    fetchImpl: mock.fetchImpl,
    createWebSocket: mock.createWebSocket,
  })
  const ctx = makeCtx(adapter, { clientId: 'ding_bot_1', clientSecret: 'ding_secret_1' })
  await adapter.start(ctx)

  await adapter.send({
    chat: { kind: 'private', id: '10001' },
    parts: [{ type: 'voice', media: { bytes: validAmr1s, mime: 'audio/amr', name: 'tts.amr' } }],
  })
  assert.match(uploadedNames[0].url, /type=voice/)
  assert.equal(uploadedNames[0].fileName, 'voice.amr')
  const sendCalls1 = mock.calls.filter((c) => c.url.endsWith('/v1.0/robot/oToMessages/batchSend'))
  assert.equal(sendCalls1[0].body.msgKey, 'sampleAudio')
  const msgParam1 = JSON.parse(sendCalls1[0].body.msgParam)
  assert.ok(msgParam1.mediaId)
  assert.equal(msgParam1.duration, '1000')

  // 非 AMR 字节却带着默认 audio/amr 标记且无 ffmpeg：不得谎报 voice，降级按真实 .mp3 文件发送
  await adapter.send({
    chat: { kind: 'private', id: '10001' },
    parts: [{ type: 'voice', media: { bytes: fakeMp3WithAmrMime, mime: 'audio/amr', name: 'tts.amr' } }],
  })
  assert.match(uploadedNames[1].url, /type=file/)
  assert.equal(uploadedNames[1].fileName, 'voice.mp3')
  const sendCalls2 = mock.calls.filter((c) => c.url.endsWith('/v1.0/robot/oToMessages/batchSend'))
  assert.equal(sendCalls2[1].body.msgKey, 'sampleFile')
  assert.equal(JSON.parse(sendCalls2[1].body.msgParam).fileName, 'voice.mp3')
  assert.equal(JSON.parse(sendCalls2[1].body.msgParam).fileType, 'mp3')

  await adapter.stop()
})

test('钉钉加固回归：401 刷新单次重试、403 不重试、Ogg Opus 语音条、流式上限拦截、idle 重连与 ticket 脱敏', async () => {
  // 1) Ogg Opus 语音条 + 401 失效令牌自动刷新 + 403 不重试 + 流式下载超限
  let tokenSeq = 0
  let batchAttempt = 0
  let failNextMode = 'none'
  let clCancelled = false
  const ogg2s = Buffer.alloc(64, 0)
  Buffer.from('OggS', 'ascii').copy(ogg2s, 0)
  ogg2s[4] = 0
  ogg2s.writeBigInt64LE(BigInt(48_000 * 2), 6)
  Buffer.from('OpusHead', 'ascii').copy(ogg2s, 28)

  const uploaded = []
  const sockets = []
  const adapter = createDingtalkAdapter({
    fetchImpl: async (url, init = {}) => {
      const u = String(url)
      if (u.endsWith('/v1.0/gateway/connections/open')) {
        return jsonResp({ endpoint: 'wss://wss-open.dingtalk.com/connect', ticket: 't_hardening' })
      }
      if (u.endsWith('/v1.0/oauth2/accessToken')) {
        return jsonResp({ accessToken: `dt_tok_${++tokenSeq}`, expireIn: 7200 })
      }
      if (u.includes('/media/upload?')) {
        const f = init.body.get('media')
        uploaded.push({ url: u, name: f?.name || '' })
        return jsonResp({ errcode: 0, media_id: `@lAD_ogg_${uploaded.length}` })
      }
      if (u.endsWith('/v1.0/robot/oToMessages/batchSend')) {
        batchAttempt++
        const tok = init.headers['x-acs-dingtalk-access-token']
        if (failNextMode === '401-once' && tok === 'dt_tok_1') {
          return jsonResp({ code: 'InvalidAuthentication' }, 401)
        }
        if (failNextMode === '403') {
          return jsonResp({ code: 'Forbidden' }, 403)
        }
        return jsonResp({ processQueryKey: `dt_m_${batchAttempt}` })
      }
      if (u === 'https://files.dingtalk.com/too-large') {
        return {
          ok: true,
          status: 200,
          headers: { get: (k) => (String(k).toLowerCase() === 'content-length' ? '99999999' : null) },
          body: {
            cancel() { clCancelled = true },
            getReader() { throw new Error('should not read body when Content-Length exceeds cap') },
          },
        }
      }
      return jsonResp({}, 404)
    },
    createWebSocket: (u) => {
      const sock = new FakeWs(u)
      sockets.push(sock)
      return sock
    },
    assertUrl: async () => {},
  })
  const ctx = makeCtx(adapter, { clientId: 'ding_h_1', clientSecret: 'ding_s_1' })
  await adapter.start(ctx)

  // 发送 Ogg Opus 语音条
  await adapter.send({
    chat: { kind: 'private', id: 'u_ogg' },
    parts: [{ type: 'voice', media: { bytes: ogg2s, mime: 'audio/ogg', name: 'tts.ogg' } }],
  })
  assert.match(uploaded[0].url, /type=voice/)
  assert.equal(uploaded[0].name, 'voice.ogg')

  // 401 提前失效 -> 清缓存重新换 tok_2 并仅重试一次成功；403 不重换 token
  failNextMode = '401-once'
  await adapter.send({ chat: { kind: 'private', id: 'u_401' }, parts: [{ type: 'text', text: 'retry-401' }] })
  assert.equal(tokenSeq, 2)

  failNextMode = '403'
  await assert.rejects(
    () => adapter.send({ chat: { kind: 'private', id: 'u_403' }, parts: [{ type: 'text', text: 'no-retry-403' }] }),
    (e) => e.certainty === 'not-sent' && e.code === 'permission-denied',
  )
  assert.equal(tokenSeq, 2)

  // Content-Length 超限直接取消流，不读 body
  await assert.rejects(
    () => adapter.fetch({ kind: 'media', media: { url: 'https://files.dingtalk.com/too-large' } }),
    (e) => e.certainty === 'not-sent' && e.code === 'too-large',
  )
  assert.equal(clCancelled, true)
  await adapter.stop()

  // 2) idleTimeoutMs 触发静默断连自动重连
  const idleMock = makeDingtalkMock()
  const idleAdapter = createDingtalkAdapter({
    fetchImpl: idleMock.fetchImpl,
    createWebSocket: idleMock.createWebSocket,
    idleTimeoutMs: 60,
    reconnectBaseMs: 20,
    reconnectMaxMs: 40,
  })
  const idleCtx = makeCtx(idleAdapter, { clientId: 'ding_idle', clientSecret: 'ding_idle_sec' })
  await idleAdapter.start(idleCtx)
  await delay(140)
  assert.ok(idleMock.sockets.length >= 2, '静默超时应触发 Stream 重连')
  await idleAdapter.stop()

  // 3) ticket 参数脱敏与不可信 WS 协议拒绝
  const leakMock = makeDingtalkMock({
    customFetch: async ({ url }) => {
      if (String(url).endsWith('/v1.0/gateway/connections/open')) {
        return jsonResp({ endpoint: 'wss://wss-open.dingtalk.com/connect', ticket: 'secret_ticket_xyz' })
      }
      return null
    },
  })
  const badWsAdapter = createDingtalkAdapter({
    fetchImpl: leakMock.fetchImpl,
    createWebSocket: (u) => {
      const target = new EventTarget()
      target.close = () => {}
      queueMicrotask(() => {
        const ev = new Event('error')
        ev.error = new Error(`connect failed ${u}`)
        target.dispatchEvent(ev)
      })
      return target
    },
  })
  const leakCtx = makeCtx(badWsAdapter, { clientId: 'ding_leak', clientSecret: 'ding_leak_sec' })
  await assert.rejects(
    () => badWsAdapter.start(leakCtx),
    (err) => {
      assert.equal(err.message.includes('secret_ticket_xyz'), false, '报错不得泄露 ticket 参数')
      assert.match(err.message, /ticket=\*\*\*/)
      return true
    },
  )
})

test('dingtalk parseDingtalkInbound 应解析各类 repliedMsg 引用摘要并兼容不可读占位', () => {
  const basePayload = (extra) => ({
    msgId: 'dt_in_q_1',
    conversationType: '2',
    conversationId: 'cid_q_1',
    senderStaffId: 'staff_q_1',
    senderNick: '测试群友',
    createAt: 1700000100000,
    ...extra,
  })

  // 1) text 引用
  const qText = parseDingtalkInbound(basePayload({
    msgtype: 'text',
    text: {
      content: '好的，收到',
      isReplyMsg: true,
      repliedMsg: {
        msgId: 'dt_ref_text',
        msgType: 'text',
        content: JSON.stringify({ text: '记得五点前发周报' }),
      },
    },
  }), { botId: 'ding_bot' })
  assert.equal(qText.inbound.replyTo, 'dt_ref_text')
  assert.match(qText.inbound.parts[0].text, /^\[引用：记得五点前发周报\]/)
  assert.equal(qText.inbound.parts[1].text, '好的，收到')

  // 2) richText 引用（嵌套 msgType）
  const qRich = parseDingtalkInbound(basePayload({
    msgtype: 'text',
    text: {
      content: '看第二张图',
      isReplyMsg: true,
      repliedMsg: {
        msgId: 'dt_ref_rich',
        msgType: 'richText',
        content: JSON.stringify({
          richText: [
            { msgType: 'text', text: '日志截图' },
            { msgType: 'picture', pictureDownloadCode: 'pic_dc_1' },
            { content: '请排查' },
          ],
        }),
      },
    },
  }), { botId: 'ding_bot' })
  assert.equal(qRich.inbound.replyTo, 'dt_ref_rich')
  assert.equal(qRich.inbound.parts[0].text, '[引用：日志截图 [图片] 请排查]\n')

  // 3) file / audio / picture 引用，以及非文本外层 msgtype (picture) 携带 repliedMsg
  const qFile = parseDingtalkInbound(basePayload({
    msgtype: 'text',
    text: {
      content: '附件已核对',
      isReplyMsg: true,
      repliedMsg: { msgId: 'dt_ref_file', msgType: 'file', content: { fileName: '架构设计.pdf' } },
    },
  }), { botId: 'ding_bot' })
  assert.equal(qFile.inbound.parts[0].text, '[引用：[文件 架构设计.pdf]]\n')

  const qAudio = parseDingtalkInbound(basePayload({
    msgtype: 'text',
    text: {
      content: '收到语音',
      isReplyMsg: true,
      repliedMsg: { msgId: 'dt_ref_audio', msgType: 'audio', recognition: '明早九点对一下进度' },
    },
  }), { botId: 'ding_bot' })
  assert.equal(qAudio.inbound.parts[0].text, '[引用：[语音：明早九点对一下进度]]\n')

  const qOuterPic = parseDingtalkInbound(basePayload({
    msgtype: 'picture',
    content: { downloadCode: 'outer_pic_dc' },
    repliedMsg: { msgId: 'dt_ref_vid', msgType: 'video' },
  }), { botId: 'ding_bot' })
  assert.equal(qOuterPic.inbound.replyTo, 'dt_ref_vid')
  assert.equal(qOuterPic.inbound.parts[0].text, '[引用：[视频]]\n')
  assert.equal(qOuterPic.inbound.parts[1].type, 'image')

  // 4) 仅 msgId 或 interactive card 占位不可读
  const qOnlyId = parseDingtalkInbound(basePayload({
    msgtype: 'text',
    text: {
      content: '这条引用怎么说',
      isReplyMsg: true,
      repliedMsg: { msgId: 'dt_ref_only_id', content: '[interactive card message]' },
    },
  }), { botId: 'ding_bot' })
  assert.equal(qOnlyId.inbound.replyTo, 'dt_ref_only_id')
  assert.equal(qOnlyId.inbound.parts[0].text, '[引用：引用内容不可读]\n')
})

test('dingtalk quote 媒体通道：repliedMsg picture/richText 原图入站缓存、fetch(message)->fetch(media)、缺失 downloadCode 与 stop 清理', async () => {
  const mock = makeDingtalkMock()
  const adapter = createDingtalkAdapter({
    fetchImpl: mock.fetchImpl,
    createWebSocket: mock.createWebSocket,
    assertUrl: async (u) => {
      if (String(u).startsWith('https://files.dingtalk.com/')) return
      return assertPublicUrl(u)
    },
  })
  const ctx = makeCtx(adapter, { clientId: 'ding_bot_1', clientSecret: 'ding_secret_1' })
  await adapter.start(ctx)

  // 1) repliedMsg 为 picture（带 downloadCode + 发送者与秒级时间戳）
  adapter.platform.deliver(makeRobotPayload(201, {
    msgId: 'dt_in_q_media_1',
    msgtype: 'text',
    text: {
      content: '这张截图帮我看看',
      isReplyMsg: true,
      repliedMsg: {
        msgId: 'dt_q_pic_1',
        msgType: 'picture',
        senderStaffId: 'staff_q_1',
        senderNick: '王五',
        createdAt: 1700000300,
        content: JSON.stringify({ downloadCode: 'dc_quote_pic_1' }),
      },
    },
  }))

  const msg1 = ctx.emitted.at(-1)
  assert.equal(msg1.replyTo, 'dt_q_pic_1')
  const fetched1 = await adapter.fetch({ kind: 'message', messageId: 'dt_q_pic_1' })
  assert.equal(fetched1.messageId, 'dt_q_pic_1')
  assert.equal(fetched1.at, 1700000300 * 1000)
  assert.deepEqual(fetched1.sender, { account: 'staff_q_1', name: '王五' })
  assert.equal(fetched1.parts.length, 1)
  assert.equal(fetched1.parts[0].type, 'image')
  assert.equal(fetched1.parts[0].media.id, makeDingtalkMediaId('ding_bot_1', 'dc_quote_pic_1'))

  const imgBytes1 = await adapter.fetch({ kind: 'media', media: fetched1.parts[0].media })
  assert.deepEqual([...imgBytes1.bytes], [0x89, 0x50, 0x4e, 0x47, 1, 2])
  const dlCall = mock.calls.filter((c) => c.url.endsWith('/v1.0/robot/messageFiles/download')).at(-1)
  assert.equal(dlCall.body.downloadCode, 'dc_quote_pic_1')

  // 2) repliedMsg 为 richText 混排（文本 + pictureDownloadCode）且发送者为机器人自己
  adapter.platform.deliver(makeRobotPayload(202, {
    msgId: 'dt_in_q_media_2',
    msgtype: 'text',
    text: {
      content: '按你刚发的这张改',
      isReplyMsg: true,
      repliedMsg: {
        msgId: 'dt_q_rt_1',
        msgType: 'richText',
        senderId: '$:LWCP_v1:bot',
        senderNick: '钉钉助手',
        content: JSON.stringify({
          richText: [
            { msgType: 'text', text: '旧版配图' },
            { msgType: 'picture', pictureDownloadCode: 'dc_quote_rt_1' },
          ],
        }),
      },
    },
  }))

  const fetched2 = await adapter.fetch({ kind: 'message', messageId: 'dt_q_rt_1' })
  assert.equal(fetched2.sender.isBot, true)
  assert.equal(fetched2.parts[0].type, 'text')
  assert.equal(fetched2.parts[0].text, '旧版配图')
  assert.equal(fetched2.parts[1].type, 'image')
  const imgBytes2 = await adapter.fetch({ kind: 'media', media: fetched2.parts[1].media })
  assert.deepEqual([...imgBytes2.bytes], [0x89, 0x50, 0x4e, 0x47, 1, 2])

  // 3) 缺少 downloadCode 的 picture 引用不写入破损占位图；未命中抛 message-not-found
  adapter.platform.deliver(makeRobotPayload(203, {
    msgId: 'dt_in_q_media_3',
    msgtype: 'text',
    text: {
      content: '图裂了吗',
      isReplyMsg: true,
      repliedMsg: { msgId: 'dt_q_no_dc', msgType: 'picture' },
    },
  }))
  await assert.rejects(
    () => adapter.fetch({ kind: 'message', messageId: 'dt_q_no_dc' }),
    (e) => e.certainty === 'not-sent' && e.code === 'message-not-found',
  )
  await assert.rejects(
    () => adapter.fetch({ kind: 'message', messageId: 'dt_unknown_id' }),
    (e) => e.certainty === 'not-sent' && e.code === 'message-not-found',
  )

  // 4) stop() 清空 quoteCache
  await adapter.stop()
  await assert.rejects(
    () => adapter.fetch({ kind: 'message', messageId: 'dt_q_pic_1' }),
    (e) => e.certainty === 'not-sent' && e.code === 'message-not-found',
  )
})
