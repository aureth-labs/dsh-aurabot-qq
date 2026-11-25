// 企业微信智能机器人（wecom · 官方 WebSocket 长连接）平台端测试：
//   - runAdapterContract 全套契约测试
//   - aibot_subscribe 鉴权、ping 心跳与 2 次丢包触发重连、disconnected_event 停止自动重连
//   - 入站 text/voice/image/file/mixed/quote、群 @ 前缀剥离、aeskey 绝不泄露进 parts/raw
//   - AES-256-CBC + 32 字节块 PKCS#7 文件加解密闭环及异常填充拒绝
//   - 出站 aibot_respond_msg 流式首回、aibot_send_msg 主动发送与三步分片上传 (init/chunk/finish)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

import { runAdapterContract, makeCtx } from '../contract/adapter-kit.js'
import { assertPublicUrl } from '../../src/core/net.js'
import {
  CAPS_WECOM,
  createWecomAdapter,
  decryptWecomFile,
  encryptWecomFile,
  parseWecomInbound,
  WECOM_WS_CMD,
} from '../../src/adapters/wecom/index.js'

class FakeWecomWs extends EventEmitter {
  constructor(url, behavior = {}) {
    super()
    this.url = url
    this.readyState = 0
    this.sentFrames = []
    this.closed = false
    this.behavior = behavior
    queueMicrotask(() => {
      if (this.closed) return
      this.readyState = 1
      this.emit('open')
    })
  }

  send(raw) {
    const frame = JSON.parse(String(raw))
    this.sentFrames.push(frame)
    if (typeof this.behavior.onSend === 'function') {
      this.behavior.onSend(this, frame)
      return
    }
    const reqId = frame.headers?.req_id
    queueMicrotask(() => {
      if (this.closed) return
      if (frame.cmd === WECOM_WS_CMD.SUBSCRIBE) {
        this.emit('message', JSON.stringify({ headers: { req_id: reqId }, errcode: 0, errmsg: 'ok' }))
      } else if (frame.cmd === WECOM_WS_CMD.HEARTBEAT) {
        this.emit('message', JSON.stringify({ headers: { req_id: reqId }, errcode: 0 }))
      } else if (frame.cmd === WECOM_WS_CMD.UPLOAD_MEDIA_INIT) {
        this.emit('message', JSON.stringify({ headers: { req_id: reqId }, errcode: 0, body: { upload_id: 'up_wecom_1' } }))
      } else if (frame.cmd === WECOM_WS_CMD.UPLOAD_MEDIA_CHUNK) {
        this.emit('message', JSON.stringify({ headers: { req_id: reqId }, errcode: 0 }))
      } else if (frame.cmd === WECOM_WS_CMD.UPLOAD_MEDIA_FINISH) {
        this.emit('message', JSON.stringify({ headers: { req_id: reqId }, errcode: 0, body: { media_id: 'wc_media_1' } }))
      } else {
        this.emit('message', JSON.stringify({ headers: { req_id: reqId }, errcode: 0, body: { msgid: `ack_${reqId}` } }))
      }
    })
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.readyState = 3
    this.emit('close', 1000, 'closed')
  }
}

function makeWecomCallbackFrame(seq = 1, overrides = {}) {
  return {
    cmd: WECOM_WS_CMD.CALLBACK,
    headers: { req_id: `req_cb_${seq}` },
    body: {
      msgid: `wc_in_${seq}`,
      chattype: 'single',
      from: { userid: 'zhangsan' },
      msgtype: 'text',
      text: { content: `你好企微 #${seq}` },
      create_time: Math.floor(Date.now() / 1000),
      ...overrides,
    },
  }
}

test('企业微信智能机器人过全套契约（runAdapterContract）', async () => {
  let seq = 0
  const harness = {
    config: { botId: 'wc_bot_1', secret: 'wc_secret_1' },
    makeAdapter() {
      return createWecomAdapter({
        createWebSocket: (u) => new FakeWecomWs(u),
        assertUrl: async (u) => {
          if (String(u).startsWith('https://example.com/')) return
          return assertPublicUrl(u)
        },
      })
    },
    async injectInbound(adapter) {
      adapter.platform.deliver(makeWecomCallbackFrame(++seq))
    },
    async injectUnverified(adapter) {
      adapter.platform.injectFrame(makeWecomCallbackFrame(++seq, { from: { userid: 'wc_bot_1' } }))
      adapter.platform.injectFrame('{bad-json')
    },
    async injectSigned(adapter) {
      adapter.platform.deliver(makeWecomCallbackFrame(++seq))
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

test('AES-256-CBC + 32 字节 PKCS#7 加解密闭环与错误填充拒绝', () => {
  const keyBase64 = randomBytes(32).toString('base64')
  for (const plain of [
    Buffer.from('Hello WeCom 32B PKCS7'),
    randomBytes(32), // 整块 32 字节，必须追加完整 32 字节填充块
    randomBytes(65),
  ]) {
    const enc = encryptWecomFile(plain, keyBase64)
    assert.equal(enc.length % 16, 0)
    assert.deepEqual(decryptWecomFile(enc, keyBase64), plain)
  }
  // 翻转倒数第二密文块末字节，确定性破坏末块 32 字节 PKCS#7 填充（避免单块改写 1/256 概率碰巧落在 0x01）
  const corrupted = encryptWecomFile(Buffer.alloc(32, 0x41), keyBase64)
  corrupted[corrupted.length - 33] ^= 0x01
  assert.throws(() => decryptWecomFile(corrupted, keyBase64), /PKCS#7|Decryption/i)
  assert.throws(() => decryptWecomFile(Buffer.alloc(0), keyBase64), /为空/)
})

test('企业微信 WS 鉴权、心跳丢包重连、disconnected_event 禁重连与 AES 密钥零泄露', async () => {
  let dropHeartbeatAck = false
  const sockets = []
  const aesKey = randomBytes(32).toString('base64')
  const imgPlain = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
  const encImg = encryptWecomFile(imgPlain, aesKey)

  const adapter = createWecomAdapter({
    heartbeatIntervalMs: 220,
    reconnectBaseMs: 30,
    reconnectMaxMs: 60,
    fetchImpl: async (url) => {
      assert.equal(url, 'https://qyapi.weixin.qq.com/cgi-bin/media/enc_1')
      return { ok: true, status: 200, arrayBuffer: async () => encImg.buffer.slice(encImg.byteOffset, encImg.byteOffset + encImg.byteLength) }
    },
    assertUrl: async () => {},
    createWebSocket: (u) => {
      const sock = new FakeWecomWs(u, {
        onSend: (self, frame) => {
          const reqId = frame.headers?.req_id
          queueMicrotask(() => {
            if (self.closed) return
            if (frame.cmd === WECOM_WS_CMD.SUBSCRIBE) {
              self.emit('message', JSON.stringify({ headers: { req_id: reqId }, errcode: 0 }))
            } else if (frame.cmd === WECOM_WS_CMD.HEARTBEAT) {
              if (!dropHeartbeatAck) self.emit('message', JSON.stringify({ headers: { req_id: reqId }, errcode: 0 }))
            }
          })
        },
      })
      sockets.push(sock)
      return sock
    },
  })

  const ctx = makeCtx(adapter, { botId: 'wc_bot_1', secret: 'wc_secret_1' })
  await adapter.start(ctx)
  assert.equal(sockets[0].sentFrames[0].cmd, WECOM_WS_CMD.SUBSCRIBE)

  // 入站加密图片与群 @ 前缀剥离：aeskey 绝不出现在 inbound.parts 或 inbound.raw 中
  sockets[0].emit('message', JSON.stringify({
    cmd: WECOM_WS_CMD.CALLBACK,
    headers: { req_id: 'req_media_1' },
    body: {
      msgid: 'wc_img_1',
      chattype: 'group',
      chatid: 'wr_group_1',
      from: { userid: 'u1', name: '王五' },
      msgtype: 'mixed',
      mixed: {
        msg_item: [
          { msgtype: 'text', text: { content: '@Aurabot 看下这张图' } },
          { msgtype: 'image', image: { url: 'https://qyapi.weixin.qq.com/cgi-bin/media/enc_1', aeskey: aesKey } },
        ],
      },
    },
  }))
  assert.equal(ctx.emitted.length, 1)
  const inMsg = ctx.emitted[0]
  assert.equal(inMsg.chat.kind, 'group')
  assert.equal(inMsg.mentionedMe, true)
  assert.equal(inMsg.parts[0].text, '看下这张图')
  assert.equal(JSON.stringify(inMsg).includes(aesKey), false, 'aeskey 不得泄露到 AdapterInbound 或 raw')

  const fetched = await adapter.fetch({ kind: 'media', media: inMsg.parts[1].media })
  assert.deepEqual(fetched.bytes, imgPlain)

  // 心跳连续两次无 ack 触发重连
  dropHeartbeatAck = true
  await delay(720)
  dropHeartbeatAck = false
  await delay(120)
  assert.ok(sockets.length >= 2, '连续丢失心跳应自动重连')

  // 收到 disconnected_event（新连接顶号）必须停止重连并发 offline 事件
  const countBeforeKick = sockets.length
  sockets.at(-1).emit('message', JSON.stringify({
    cmd: WECOM_WS_CMD.EVENT_CALLBACK,
    body: { event: { eventtype: 'disconnected_event' } },
  }))
  await delay(120)
  assert.equal(sockets.length, countBeforeKick, 'disconnected_event 不得自动重连')
  assert.ok(ctx.events.some((e) => e.type === 'offline' && e.reason === 'disconnected_event'))
  assert.equal(ctx.states.at(-1)?.[0], 'disconnected')
  await adapter.stop()
})

test('企业微信出站：aibot_respond_msg 首回、多分片媒体上传及错误分类', async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'aurabot-wc-media-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const largeFile = join(workDir, '大文件.bin')
  writeFileSync(largeFile, randomBytes(600 * 1024)) // > 512KB => 2 个分片

  let ackMode = 'ok'
  const sockets = []
  const adapter = createWecomAdapter({
    createWebSocket: (u) => {
      const sock = new FakeWecomWs(u, {
        onSend: (self, frame) => {
          const reqId = frame.headers?.req_id
          queueMicrotask(() => {
            if (self.closed) return
            if (frame.cmd === WECOM_WS_CMD.SUBSCRIBE) {
              self.emit('message', JSON.stringify({ headers: { req_id: reqId }, errcode: 0 }))
              return
            }
            if (ackMode === 'hang') return
            if (ackMode === 'init-no-id' && frame.cmd === WECOM_WS_CMD.UPLOAD_MEDIA_INIT) {
              self.emit('message', JSON.stringify({ headers: { req_id: reqId }, errcode: 0, body: {} }))
              return
            }
            if (ackMode === '48002') {
              self.emit('message', JSON.stringify({ headers: { req_id: reqId }, errcode: 48002 }))
              return
            }
            if (frame.cmd === WECOM_WS_CMD.UPLOAD_MEDIA_INIT) {
              self.emit('message', JSON.stringify({ headers: { req_id: reqId }, errcode: 0, body: { upload_id: 'up_multi_1' } }))
            } else if (frame.cmd === WECOM_WS_CMD.UPLOAD_MEDIA_CHUNK) {
              self.emit('message', JSON.stringify({ headers: { req_id: reqId }, errcode: 0 }))
            } else if (frame.cmd === WECOM_WS_CMD.UPLOAD_MEDIA_FINISH) {
              self.emit('message', JSON.stringify({ headers: { req_id: reqId }, errcode: 0, body: { media_id: 'wc_up_multi' } }))
            } else {
              self.emit('message', JSON.stringify({ headers: { req_id: reqId }, errcode: 0, body: { msgid: `msg_${reqId}` } }))
            }
          })
        },
      })
      sockets.push(sock)
      return sock
    },
    allowedLocalDirs: [workDir],
  })
  const ctx = makeCtx(adapter, { botId: 'wc_bot_1', secret: 'wc_secret_1' })
  await adapter.start(ctx)

  adapter.platform.deliver({
    cmd: WECOM_WS_CMD.CALLBACK,
    headers: { req_id: 'inbound_req_77' },
    body: {
      msgid: 'wc_in_77',
      chattype: 'single',
      from: { userid: 'u77' },
      msgtype: 'text',
      text: { content: '发文件' },
    },
  })

  await adapter.send({
    chat: { kind: 'private', id: 'u77' },
    inResponseTo: 'wc_in_77',
    parts: [
      { type: 'text', text: '第一段流式回复' },
      { type: 'file', media: { path: pathToFileURL(largeFile).href, name: '大文件.bin' } },
    ],
  })

  const cmds = sockets[0].sentFrames.map((f) => f.cmd)
  assert.deepEqual(cmds, [
    WECOM_WS_CMD.SUBSCRIBE,
    WECOM_WS_CMD.RESPONSE,
    WECOM_WS_CMD.UPLOAD_MEDIA_INIT,
    WECOM_WS_CMD.UPLOAD_MEDIA_CHUNK,
    WECOM_WS_CMD.UPLOAD_MEDIA_CHUNK,
    WECOM_WS_CMD.UPLOAD_MEDIA_FINISH,
    WECOM_WS_CMD.SEND_MSG,
  ])
  const respondFrame = sockets[0].sentFrames[1]
  assert.equal(respondFrame.headers.req_id, 'inbound_req_77')
  assert.equal(respondFrame.body.msgtype, 'stream')
  assert.equal(respondFrame.body.stream.finish, true)
  const chunkFrames = sockets[0].sentFrames.filter((f) => f.cmd === WECOM_WS_CMD.UPLOAD_MEDIA_CHUNK)
  assert.equal(chunkFrames[0].body.chunk_index, 0)
  assert.equal(chunkFrames[1].body.chunk_index, 1)

  ackMode = '48002'
  await assert.rejects(
    () => adapter.send({ chat: { kind: 'private', id: 'u77' }, parts: [{ type: 'text', text: 'proactive' }] }),
    (e) => e.certainty === 'not-sent' && e.code === 'permission-denied',
  )
  ackMode = 'init-no-id'
  await assert.rejects(
    () => adapter.send({ chat: { kind: 'private', id: 'u77' }, parts: [{ type: 'file', media: { bytes: Buffer.from('hi'), name: 'a.txt' } }] }),
    (e) => e.certainty === 'not-sent' && e.code === 'upload-init-failed',
  )
  await assert.rejects(
    () => adapter.send({ chat: { kind: 'private', id: 'u77' }, parts: [{ type: 'file', media: { bytes: Buffer.alloc(0), name: 'empty.bin' } }] }),
    (e) => e.certainty === 'not-sent' && e.code === 'empty-media',
  )
  await assert.rejects(
    () => adapter.send({ chat: { kind: 'private', id: 'u77' }, parts: [{ type: 'file', media: { size: 50 * 1024 * 1024, bytes: Buffer.from('x'), name: 'huge.bin' } }] }),
    (e) => e.certainty === 'not-sent' && e.code === 'too-large',
  )
  await assert.rejects(
    () => adapter.send({ chat: { kind: 'private', id: 'u77' }, parts: [{ type: 'file', media: {} }] }),
    (e) => e.certainty === 'not-sent' && e.code === 'media-needs-upload',
  )
  ackMode = 'hang'
  await assert.rejects(
    () => adapter.send({ chat: { kind: 'private', id: 'u77' }, parts: [{ type: 'text', text: 'hang' }], timeoutMs: 80 }),
    (e) => e.certainty === 'unknown' && e.code === 'timeout',
  )
  assert.equal(CAPS_WECOM.proactive, 'free')
  assert.equal(CAPS_WECOM.voice, 'native')
  assert.equal(CAPS_WECOM.quoteReply, false)
  assert.equal(CAPS_WECOM.features['message.quote.read'], true)
  assert.equal(CAPS_WECOM.features['message.quote.send'], false)
  assert.equal(Object.keys(CAPS_WECOM.features).length, 14)
  await adapter.stop()
})

test('parseWecomInbound 正确处理 voice/quote 与空 payload', () => {
  assert.equal(parseWecomInbound(null), null)
  const voice = parseWecomInbound({
    headers: { req_id: 'r1' },
    body: {
      msgid: 'm1',
      chattype: 'single',
      from: { userid: 'u1' },
      msgtype: 'voice',
      voice: { content: '语音转写文本' },
      quote: { msgid: 'q0', msgtype: 'text', text: { content: '前一句' } },
    },
  })
  assert.equal(voice.inbound.replyTo, 'q0')
  assert.match(voice.inbound.parts.map((p) => p.text).join(''), /引用：前一句/)
  assert.match(voice.inbound.parts.map((p) => p.text).join(''), /语音转写文本/)
})

test('WebSocket 握手失败触发空 message 的 TypeError 时不退化为裸 TypeError', async () => {
  const adapter = createWecomAdapter({
    createWebSocket: () => {
      const target = new EventTarget()
      target.close = () => {}
      queueMicrotask(() => {
        const ev = new Event('error')
        ev.error = new TypeError('')
        target.dispatchEvent(ev)
      })
      return target
    },
  })
  const ctx = makeCtx(adapter, { botId: 'wc_bot_err', secret: 'wc_sec_err' })
  await assert.rejects(
    () => adapter.start(ctx),
    (err) => {
      assert.notEqual(err.message, 'TypeError')
      assert.match(err.message, /WebSocket 连接或握手失败/)
      return true
    },
  )
})

test('企业微信出站语音条：合法 AMR 发送 voice，超 60s 或非 AMR 且无 FFmpeg 诚实降级为 file', async () => {
  const frame = Buffer.alloc(32, 0xaa)
  frame[0] = (7 << 3) | 0x04
  const validAmr1s = Buffer.concat([Buffer.from('#!AMR\n', 'ascii'), ...Array.from({ length: 50 }, () => frame)])
  const longAmr61s = Buffer.concat([Buffer.from('#!AMR\n', 'ascii'), ...Array.from({ length: 3050 }, () => frame)])
  const fakeMp3WithAmrMime = Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00'), Buffer.alloc(64, 0x22)])

  const sockets = []
  let mediaSeq = 0
  const adapter = createWecomAdapter({
    createWebSocket: (u) => {
      const sock = new FakeWecomWs(u, {
        onSend: (self, frameObj) => {
          const reqId = frameObj.headers?.req_id
          queueMicrotask(() => {
            if (self.closed) return
            if (frameObj.cmd === WECOM_WS_CMD.SUBSCRIBE) {
              self.emit('message', JSON.stringify({ headers: { req_id: reqId }, errcode: 0 }))
            } else if (frameObj.cmd === WECOM_WS_CMD.UPLOAD_MEDIA_INIT) {
              self.emit('message', JSON.stringify({ headers: { req_id: reqId }, errcode: 0, body: { upload_id: `up_${++mediaSeq}` } }))
            } else if (frameObj.cmd === WECOM_WS_CMD.UPLOAD_MEDIA_CHUNK) {
              self.emit('message', JSON.stringify({ headers: { req_id: reqId }, errcode: 0 }))
            } else if (frameObj.cmd === WECOM_WS_CMD.UPLOAD_MEDIA_FINISH) {
              self.emit('message', JSON.stringify({ headers: { req_id: reqId }, errcode: 0, body: { media_id: `wc_m_${mediaSeq}` } }))
            } else {
              self.emit('message', JSON.stringify({ headers: { req_id: reqId }, errcode: 0, body: { msgid: `msg_${reqId}` } }))
            }
          })
        },
      })
      sockets.push(sock)
      return sock
    },
  })
  const ctx = makeCtx(adapter, { botId: 'wc_bot_voice', secret: 'wc_secret_voice' })
  await adapter.start(ctx)

  // 1) 合法 AMR（<=2MB 且 <=60s）走 voice
  await adapter.send({
    chat: { kind: 'private', id: 'u77' },
    parts: [{ type: 'voice', media: { bytes: validAmr1s, mime: 'audio/amr', name: 'tts.amr' } }],
  })
  // 2) 非 AMR 且无 ffmpeg（即使带着默认 audio/amr 标识）降级 file（扩展名按真实魔数 corrected 为 mp3）
  await adapter.send({
    chat: { kind: 'private', id: 'u77' },
    parts: [{ type: 'voice', media: { bytes: fakeMp3WithAmrMime, mime: 'audio/amr', name: 'tts.amr' } }],
  })
  // 3) 超过 60s 的 AMR 降级 file
  await adapter.send({
    chat: { kind: 'private', id: 'u77' },
    parts: [{ type: 'voice', media: { bytes: longAmr61s, mime: 'audio/amr', name: 'long.amr' } }],
  })

  const inits = sockets[0].sentFrames.filter((f) => f.cmd === WECOM_WS_CMD.UPLOAD_MEDIA_INIT).map((f) => f.body)
  const sends = sockets[0].sentFrames.filter((f) => f.cmd === WECOM_WS_CMD.SEND_MSG).map((f) => f.body)

  assert.equal(inits[0].type, 'voice')
  assert.equal(inits[0].filename, 'voice.amr')
  assert.equal(sends[0].msgtype, 'voice')
  assert.equal(sends[0].voice.media_id, 'wc_m_1')

  assert.equal(inits[1].type, 'file')
  assert.equal(inits[1].filename, 'voice.mp3')
  assert.equal(sends[1].msgtype, 'file')
  assert.equal(sends[1].file.media_id, 'wc_m_2')

  assert.equal(inits[2].type, 'file')
  assert.equal(sends[2].msgtype, 'file')
  assert.equal(sends[2].file.media_id, 'wc_m_3')

  await adapter.stop()
})

test('企业微信入站带 url/aeskey 语音保留 MediaRef 且下载流超出上限时提前取消', async () => {
  const parsedVoice = parseWecomInbound({
    headers: { req_id: 'r_v1' },
    body: {
      msgid: 'm_v1',
      chattype: 'single',
      from: { userid: 'u_v1' },
      msgtype: 'voice',
      voice: {
        url: 'https://qyapi.weixin.qq.com/voice.amr',
        aeskey: 'secret_aes_should_not_leak',
      },
    },
  })
  assert.equal(parsedVoice.inbound.parts[0].type, 'voice')
  assert.ok(parsedVoice.inbound.parts[0].media?.id?.startsWith('wc_m_v1_'))
  assert.equal(JSON.stringify(parsedVoice.inbound).includes('secret_aes_should_not_leak'), false)

  let streamCancelled = false
  let chunksPulled = 0
  const adapter = createWecomAdapter({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: new ReadableStream({
        pull(controller) {
          chunksPulled++
          if (chunksPulled <= 5) controller.enqueue(new Uint8Array(40))
          else controller.close()
        },
        cancel() {
          streamCancelled = true
        },
      }),
    }),
    createWebSocket: (u) => new FakeWecomWs(u),
    assertUrl: async () => {},
  })
  const ctx = makeCtx(adapter, { botId: 'wc_bot_stream', secret: 'wc_secret_stream', maxFileBytes: 64 })
  await adapter.start(ctx)

  await assert.rejects(
    () => adapter.fetch({ kind: 'media', media: { url: 'https://files.example.com/big.amr' } }),
    (e) => e.certainty === 'not-sent' && e.code === 'too-large',
  )
  assert.equal(streamCancelled, true)
  assert.ok(chunksPulled < 5, `应在超限时中止读取，实际拉取分片数=${chunksPulled}`)

  await adapter.stop()
})

test('wecom quote 摘要扩展与脱敏结构日志校验', async () => {
  const mkFrame = (quote) => ({
    cmd: WECOM_WS_CMD.CALLBACK,
    headers: { req_id: 'req_q_1' },
    body: {
      msgid: 'wc_q_in_1',
      chattype: 'group',
      chatid: 'chat_q_1',
      from: { userid: 'lisi' },
      msgtype: 'text',
      text: { content: '@Bot 看这个' },
      quote,
      create_time: 1700000200,
    },
  })

  const md = parseWecomInbound(mkFrame({ msgid: 'q_md', msgtype: 'markdown', markdown: { content: '**重要变更**' } }), { botId: 'wc_b' })
  assert.equal(md.inbound.replyTo, 'q_md')
  assert.equal(md.inbound.parts[0].text, '[引用：**重要变更**]\n')
  assert.equal(md.inbound.parts[1].text, '看这个')

  const st = parseWecomInbound(mkFrame({ msgid: 'q_st', msgtype: 'stream', stream: { content: '分段流式结论' } }), { botId: 'wc_b' })
  assert.equal(st.inbound.parts[0].text, '[引用：分段流式结论]\n')

  const tc = parseWecomInbound(mkFrame({
    msgid: 'q_tc',
    msgtype: 'template_card',
    template_card: { main_title: { title: '发布审批', desc: '待确认' } },
  }), { botId: 'wc_b' })
  assert.equal(tc.inbound.parts[0].text, '[引用：发布审批 - 待确认]\n')

  const vid = parseWecomInbound(mkFrame({ msgid: 'q_vid', msgtype: 'video' }), { botId: 'wc_b' })
  assert.equal(vid.inbound.parts[0].text, '[引用：[视频]]\n')

  const mix = parseWecomInbound(mkFrame({
    msgid: 'q_mix',
    msgtype: 'mixed',
    mixed: {
      msg_item: [
        { msgtype: 'text', text: { content: '请查收' } },
        { msgtype: 'file', file: { filename: 'report.csv' } },
        { msgtype: 'video' },
      ],
    },
  }), { botId: 'wc_b' })
  assert.equal(mix.inbound.parts[0].text, '[引用：请查收 [文件 report.csv] [视频]]\n')

  const unreadable = parseWecomInbound(mkFrame({ msgid: 'q_only_id' }), { botId: 'wc_b' })
  assert.equal(unreadable.inbound.replyTo, 'q_only_id')
  assert.equal(unreadable.inbound.parts[0].text, '[引用：引用正文不可读]\n')

  // 实时回调应仅记录脱敏结构字段，不得泄露 aeskey/url/secret
  let activeWs = null
  const debugLogs = []
  const adapter = createWecomAdapter({
    createWebSocket: (u) => {
      activeWs = new FakeWecomWs(u)
      return activeWs
    },
    assertUrl: async () => {},
  })
  const baseCtx = makeCtx(adapter, { botId: 'wc_bot_log', secret: 'wc_secret_should_not_leak' })
  const ctx = {
    ...baseCtx,
    log: {
      ...baseCtx.log,
      debug: (...args) => debugLogs.push(args),
    },
  }
  await adapter.start(ctx)
  activeWs.emit('message', JSON.stringify(mkFrame({
    msgid: 'q_secret_test',
    msgtype: 'image',
    image: { url: 'https://secret.example.com/private.jpg?token=tok_leak', aeskey: 'aes_key_should_not_leak' },
  })))
  await new Promise((r) => setTimeout(r, 20))
  await adapter.stop()

  const quoteLog = debugLogs.find((entry) => entry[0] === 'wecom.inbound.quote')
  assert.ok(quoteLog, '应记录 wecom.inbound.quote 调试结构日志')
  assert.equal(quoteLog[1].msgtype, 'image')
  assert.equal(quoteLog[1].hasMsgId, true)
  assert.equal(quoteLog[1].hasSummary, true)
  assert.equal(quoteLog[1].hasMedia, true)
  assert.ok(Array.isArray(quoteLog[1].keys) && quoteLog[1].keys.includes('image'))
  const serialized = JSON.stringify(quoteLog)
  assert.equal(serialized.includes('aes_key_should_not_leak'), false)
  assert.equal(serialized.includes('tok_leak'), false)
  assert.equal(serialized.includes('wc_secret_should_not_leak'), false)
  assert.ok(ctx.emitted.length >= 1)
})

test('wecom quote 媒体通道：image/mixed 引用加密原图入站缓存、无 msgid 合成键、fetch(message)->fetch(media)、零密钥泄漏与 stop 清理', async () => {
  const aesImg = randomBytes(32).toString('base64')
  const aesMix = randomBytes(32).toString('base64')
  const plainImg = Buffer.from([0x89, 0x50, 0x4e, 0x47, 10, 20, 30])
  const plainMixImg = Buffer.from([0x89, 0x50, 0x4e, 0x47, 40, 50, 60])
  const encMap = new Map([
    ['https://files.example.com/q_img.enc', encryptWecomFile(plainImg, aesImg)],
    ['https://files.example.com/q_mix.enc', encryptWecomFile(plainMixImg, aesMix)],
  ])

  let activeWs = null
  const debugLogs = []
  const adapter = createWecomAdapter({
    fetchImpl: async (url) => {
      const buf = encMap.get(String(url))
      if (!buf) return { ok: false, status: 404, headers: { get: () => null }, body: null }
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/octet-stream' },
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      }
    },
    createWebSocket: (u) => {
      activeWs = new FakeWecomWs(u)
      return activeWs
    },
    assertUrl: async () => {},
  })
  const baseCtx = makeCtx(adapter, { botId: 'wc_bot_qmedia', secret: 'wc_sec_qmedia' })
  const ctx = {
    ...baseCtx,
    log: {
      ...baseCtx.log,
      debug: (...args) => debugLogs.push(args),
    },
  }
  await adapter.start(ctx)

  const sendCb = (msgid, quote) => {
    activeWs.emit('message', JSON.stringify({
      cmd: WECOM_WS_CMD.CALLBACK,
      headers: { req_id: `req_${msgid}` },
      body: {
        msgid,
        chattype: 'single',
        from: { userid: 'zhangsan' },
        msgtype: 'text',
        text: { content: '看看引用原图' },
        quote,
        create_time: 1700000400,
      },
    }))
  }

  // 1) 带 msgid 的 image 引用
  sendCb('wc_m_1', {
    msgid: 'wc_q_with_id',
    msgtype: 'image',
    image: { url: 'https://files.example.com/q_img.enc', aeskey: aesImg },
  })
  const fetched1 = await adapter.fetch({ kind: 'message', messageId: 'wc_q_with_id' })
  assert.equal(fetched1.messageId, 'wc_q_with_id')
  assert.equal(fetched1.parts.length, 1)
  assert.equal(fetched1.parts[0].type, 'image')
  assert.equal(JSON.stringify(fetched1).includes(aesImg), false)
  assert.equal(JSON.stringify(fetched1).includes('https://files.example.com'), false)
  assert.equal('raw' in fetched1, false)
  const dec1 = await adapter.fetch({ kind: 'media', media: fetched1.parts[0].media })
  assert.deepEqual(dec1.bytes, plainImg)

  // 2) 不带 msgid 的 image 引用（生成合成键 wc_q_${messageId}）
  sendCb('wc_m_2', {
    msgtype: 'image',
    image: { url: 'https://files.example.com/q_img.enc', aeskey: aesImg },
  })
  const msg2 = ctx.emitted.at(-1)
  assert.equal(msg2.replyTo, 'wc_q_wc_m_2')
  const fetched2 = await adapter.fetch({ kind: 'message', messageId: msg2.replyTo })
  const dec2 = await adapter.fetch({ kind: 'media', media: fetched2.parts[0].media })
  assert.deepEqual(dec2.bytes, plainImg)

  // 3) mixed 混排引用（text + image）
  sendCb('wc_m_3', {
    msgid: 'wc_q_mixed',
    msgtype: 'mixed',
    mixed: {
      msg_item: [
        { msgtype: 'text', text: { content: '附图说明' } },
        { msgtype: 'image', image: { url: 'https://files.example.com/q_mix.enc', aeskey: aesMix } },
      ],
    },
  })
  const fetched3 = await adapter.fetch({ kind: 'message', messageId: 'wc_q_mixed' })
  assert.equal(fetched3.parts[0].type, 'text')
  assert.equal(fetched3.parts[0].text, '附图说明')
  assert.equal(fetched3.parts[1].type, 'image')
  const dec3 = await adapter.fetch({ kind: 'media', media: fetched3.parts[1].media })
  assert.deepEqual(dec3.bytes, plainMixImg)
  assert.ok(debugLogs.some((e) => e[0] === 'wecom.inbound.quote' && e[1].hasMedia === true))

  // 4) 无 url 的 image 引用不落破损图；未知 ID 抛 message-not-found；stop() 清空 quoteCache
  sendCb('wc_m_4', { msgid: 'wc_q_no_url', msgtype: 'image' })
  await assert.rejects(
    () => adapter.fetch({ kind: 'message', messageId: 'wc_q_no_url' }),
    (e) => e.certainty === 'not-sent' && e.code === 'message-not-found',
  )
  await assert.rejects(
    () => adapter.fetch({ kind: 'message', messageId: 'wc_q_unknown' }),
    (e) => e.certainty === 'not-sent' && e.code === 'message-not-found',
  )

  await adapter.stop()
  await assert.rejects(
    () => adapter.fetch({ kind: 'message', messageId: 'wc_q_with_id' }),
    (e) => e.certainty === 'not-sent' && e.code === 'message-not-found',
  )
})
