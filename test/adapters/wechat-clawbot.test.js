// 个人微信 ClawBot（wechat-clawbot · 原生 iLink）平台端测试：
//   - runAdapterContract 全套契约测试
//   - AES-128-ECB 格式 A / 格式 B / 原始 hex 解密与 CDN 加密上传闭环
//   - getupdates 长轮询（游标持久化 / context_token 持久化 / -14 会话失效 / 断线退避重连 / stop 中止）
//   - 入站解析（文本 / ref_msg 引用 / 图片 / 语音转文字优先 / 无文字语音 / 文件 / 视频 / self-sent / 群聊开关）
//   - 出站发送（长文本拆分 / 媒体加密上传 / 语音优先 SILK 语音条、失败降文件 / proactive limited 限流 / 缺 context_token 拒绝）
//   - getconfig + sendtyping 票据缓存 + 二维码扫码状态机
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { runAdapterContract, makeCtx } from '../contract/adapter-kit.js'
import { assertPublicUrl } from '../../src/core/net.js'
import {
  createWechatClawbotAdapter,
  CAPS_WECHAT_CLAWBOT,
  startQrLogin,
  pollQrStatus,
  parseInboundMessage,
  parseAesKey,
  encryptAesEcb,
  decryptAesEcb,
  encodeOutboundAesKey,
  aesEcbPaddedSize,
  ITEM_TYPE,
  MESSAGE_TYPE,
  MESSAGE_STATE,
  UPLOAD_MEDIA_TYPE,
} from '../../src/adapters/wechat-clawbot/index.js'

let silkAvailable = true
try {
  await import('silk-wasm')
} catch {
  silkAvailable = false
}

function makeWavPcm16({ sampleRate = 16000, seconds = 1, frequency = 440 } = {}) {
  const frames = Math.max(1, Math.round(sampleRate * seconds))
  const out = Buffer.alloc(44 + frames * 2)
  out.write('RIFF', 0)
  out.writeUInt32LE(36 + frames * 2, 4)
  out.write('WAVE', 8)
  out.write('fmt ', 12)
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(1, 22)
  out.writeUInt32LE(sampleRate, 24)
  out.writeUInt32LE(sampleRate * 2, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36)
  out.writeUInt32LE(frames * 2, 40)
  for (let i = 0; i < frames; i++) {
    out.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 8000), 44 + i * 2)
  }
  return out
}

function makeMockIlinkClient(customHandler = null) {
  const calls = []
  const uploadedPayloads = new Map()
  let uploadSeq = 0
  let msgSeq = 0
  let needsBootstrap = true
  let longPollWaiters = []

  const client = {
    calls,
    uploadedPayloads,
    longPollWaiters,
    pushUpdateWaiterError(err) {
      for (const w of longPollWaiters.splice(0)) w.reject(err)
    },
    resolveNextUpdateWaiter(res) {
      const w = longPollWaiters.shift()
      if (w) w.resolve(res)
      return Boolean(w)
    },
    async request(req) {
      const url = String(req.url || '')
      const bodyObj = typeof req.body === 'string' && req.body ? JSON.parse(req.body) : null
      calls.push({ method: req.method, url, headers: req.headers || {}, body: bodyObj, rawBody: req.body })

      if (customHandler) {
        const res = await customHandler({ req, url, bodyObj, uploadedPayloads })
        if (res) {
          if (url.includes('/ilink/bot/getupdates')) needsBootstrap = false
          return res
        }
      }

      if (url.startsWith('https://example.com/')) {
        return { status: 200, headers: {}, bytes: Buffer.from(`sample-${url}`), json: null, text: '' }
      }
      if (url.includes('/ilink/bot/getuploadurl')) {
        uploadSeq++
        return { status: 200, headers: {}, json: { ret: 0, upload_param: `up_${uploadSeq}` } }
      }
      if (url.includes('/upload?')) {
        const u = new URL(url)
        const filekey = u.searchParams.get('filekey') || `fk_${uploadSeq}`
        const eqp = `eqp_${filekey}`
        uploadedPayloads.set(eqp, Buffer.from(req.body || []))
        return { status: 200, headers: { 'x-encrypted-param': eqp }, json: {}, text: '' }
      }
      if (url.includes('/ilink/bot/sendmessage')) {
        msgSeq++
        return { status: 200, headers: {}, json: { ret: 0, message_id: `wx_msg_${msgSeq}` } }
      }
      if (url.includes('/ilink/bot/getconfig')) {
        return { status: 200, headers: {}, json: { ret: 0, typing_ticket: 'ticket_abc' } }
      }
      if (url.includes('/ilink/bot/sendtyping')) {
        return { status: 200, headers: {}, json: { ret: 0 } }
      }
      if (url.includes('/ilink/bot/getupdates')) {
        if (needsBootstrap) {
          needsBootstrap = false
          return { status: 200, headers: {}, json: { ret: 0, get_updates_buf: 'init_buf', msgs: [] } }
        }
        return await new Promise((resolve, reject) => {
          const waiter = { resolve, reject }
          longPollWaiters.push(waiter)
          req.signal?.addEventListener?.('abort', () => {
            const idx = longPollWaiters.indexOf(waiter)
            if (idx >= 0) longPollWaiters.splice(idx, 1)
            needsBootstrap = true
            const abortErr = new Error('aborted')
            abortErr.name = 'AbortError'
            reject(abortErr)
          }, { once: true })
        })
      }
      return { status: 404, headers: {}, json: { errcode: 404 }, text: '' }
    },
  }
  return client
}

let kitSeq = 0
function makeContractInbound(idSuffix) {
  return {
    message_id: `wx_in_${idSuffix}`,
    from_user_id: '10001',
    from_user_name: '测试微信好友',
    message_type: MESSAGE_TYPE.USER,
    create_time_ms: Date.now(),
    context_token: `ctx_tok_${idSuffix}`,
    item_list: [{ type: ITEM_TYPE.TEXT, text_item: { text: '你好呀' } }],
  }
}

test('wechat-clawbot 平台端过全套契约（runAdapterContract）', async () => {
  const harness = {
    config: { botToken: 'wx_token_contract', botId: 'wx_bot_1@im.bot' },
    makeAdapter() {
      const client = makeMockIlinkClient()
      return createWechatClawbotAdapter({
        client,
        assertUrl: async (u) => {
          if (String(u).startsWith('https://example.com/')) return
          return assertPublicUrl(u)
        },
      })
    },
    async injectInbound(adapter) {
      kitSeq++
      adapter.platform.deliver(makeContractInbound(kitSeq))
    },
    async injectUnverified(adapter) {
      // 机器人自己发出的消息（message_type=BOT）只能走 self-sent 事件，绝不能 emit 成入站
      adapter.platform.deliver({
        message_id: `wx_self_${++kitSeq}`,
        from_user_id: 'wx_bot_1@im.bot',
        to_user_id: '10001',
        message_type: MESSAGE_TYPE.BOT,
        create_time_ms: Date.now(),
        item_list: [{ type: ITEM_TYPE.TEXT, text_item: { text: '自己说的话' } }],
      })
    },
    async injectSigned(adapter) {
      kitSeq++
      adapter.platform.deliver(makeContractInbound(`signed_${kitSeq}`))
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

test('AES-128-ECB 加解密：兼容 Format A / Format B / 原始 32 位 hex 与密文尺寸对齐', () => {
  assert.equal(aesEcbPaddedSize(0), 16)
  assert.equal(aesEcbPaddedSize(15), 16)
  assert.equal(aesEcbPaddedSize(16), 32)
  assert.equal(aesEcbPaddedSize(17), 32)

  const rawKey = randomBytes(16)
  const hexKey = rawKey.toString('hex')
  const formatA = rawKey.toString('base64')
  const formatB = encodeOutboundAesKey(rawKey) // base64(32 hex chars)

  assert.deepEqual(parseAesKey(hexKey), rawKey)
  assert.deepEqual(parseAesKey(formatA), rawKey)
  assert.deepEqual(parseAesKey(formatB), rawKey)

  const plain = Buffer.from('Hello WeChat iLink Encrypted Media 测试字节')
  const cipher = encryptAesEcb(plain, formatA)
  assert.equal(cipher.length, aesEcbPaddedSize(plain.length))
  assert.deepEqual(decryptAesEcb(cipher, formatB), plain)
  assert.throws(() => parseAesKey('bad'), /格式无效/)
})

test('入站消息解析：文本、引用 ref_msg、图片/语音/文件/视频 CDN 解密、群聊门控与 self-sent', async () => {
  const keyImg = randomBytes(16)
  const keyVoice = randomBytes(16)
  const keyFile = randomBytes(16)
  const imgPlain = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  const voicePlain = Buffer.from('#!SILK_V3raw-audio-bytes')
  const filePlain = Buffer.from('%PDF-1.7 test doc')

  const cdnFiles = new Map([
    ['eqp_img_1', encryptAesEcb(imgPlain, keyImg)],
    ['eqp_voice_1', encryptAesEcb(voicePlain, keyVoice)],
    ['eqp_file_1', encryptAesEcb(filePlain, keyFile)],
  ])

  const client = makeMockIlinkClient(async ({ url }) => {
    if (url.includes('/download?')) {
      const eqp = new URL(url).searchParams.get('encrypted_query_param')
      const bytes = cdnFiles.get(eqp)
      if (!bytes) return { status: 404, headers: {}, bytes: Buffer.alloc(0) }
      return { status: 200, headers: {}, bytes }
    }
    return null
  })

  const adapter = createWechatClawbotAdapter({ client })
  const ctx = makeCtx(adapter, { botToken: 'tok_in', botId: 'bot@im.bot', allowGroup: false })
  await adapter.start(ctx)

  // 1) 引用文本 + 图片 + 平台转写语音 + 文件 + 视频 + 未知项
  adapter.platform.deliver({
    message_id: 'msg_rich_1',
    from_user_id: 'wxu_alice@im.wechat',
    from_user_name: 'Alice',
    message_type: MESSAGE_TYPE.USER,
    create_time: 1700000100, // 秒级也应转成毫秒
    context_token: 'ctx_alice_1',
    item_list: [
      {
        type: ITEM_TYPE.TEXT,
        text_item: { text: '看这张图' },
        ref_msg: { title: 'Bob', message_item: { type: ITEM_TYPE.TEXT, text_item: { text: '之前的消息' } } },
      },
      {
        type: ITEM_TYPE.IMAGE,
        image_item: { media: { encrypt_query_param: 'eqp_img_1', aes_key: keyImg.toString('base64') }, mid_size: 16 },
      },
      {
        type: ITEM_TYPE.VOICE,
        voice_item: { text: '这是语音识别出的文本', media: { encrypt_query_param: 'eqp_voice_unused', aes_key: encodeOutboundAesKey(keyVoice) } },
      },
      {
        type: ITEM_TYPE.VOICE,
        voice_item: { playtime: 2300, media: { encrypt_query_param: 'eqp_voice_1', aes_key: encodeOutboundAesKey(keyVoice) } },
      },
      {
        type: ITEM_TYPE.FILE,
        file_item: { file_name: 'report.pdf', len: String(filePlain.length), media: { encrypt_query_param: 'eqp_file_1', aes_key: encodeOutboundAesKey(keyFile) } },
      },
      {
        type: ITEM_TYPE.VIDEO,
        video_item: { video_size: 2048, media: { encrypt_query_param: 'eqp_vid_1', aes_key: encodeOutboundAesKey(keyFile) } },
      },
      { type: 99 },
    ],
  })

  assert.equal(ctx.emitted.length, 1)
  const inb = ctx.emitted[0]
  assert.equal(inb.at, 1700000100000)
  assert.equal(inb.sender.name, 'Alice')
  assert.equal(inb.parts[0].type, 'text')
  assert.match(inb.parts[0].text, /\[引用: Bob: 之前的消息\]/)
  assert.match(inb.parts[0].text, /看这张图/)
  assert.equal(inb.parts[1].type, 'image')
  assert.equal(inb.parts[2].type, 'text')
  assert.equal(inb.parts[2].text, '这是语音识别出的文本')
  assert.equal(inb.parts[3].type, 'voice')
  assert.equal(inb.parts[3].durationMs, 2300)
  assert.equal(inb.parts[4].type, 'file')
  assert.equal(inb.parts[4].media.name, 'report.pdf')
  assert.equal(inb.parts[5].type, 'video')
  assert.equal(inb.parts[6].type, 'other')

  // fetch(media) 下载并解密 Format A 图片 / Format B 语音与文件
  const fetchedImg = await adapter.fetch({ kind: 'media', media: inb.parts[1].media })
  assert.deepEqual(fetchedImg.bytes, imgPlain)
  assert.equal(fetchedImg.mime, 'image/png')

  const fetchedVoice = await adapter.fetch({ kind: 'media', media: inb.parts[3].media })
  assert.deepEqual(fetchedVoice.bytes, voicePlain)
  assert.equal(fetchedVoice.mime, 'audio/silk')

  const fetchedFile = await adapter.fetch({ kind: 'media', media: inb.parts[4].media })
  assert.deepEqual(fetchedFile.bytes, filePlain)
  assert.equal(fetchedFile.name, 'report.pdf')

  // 2) allowGroup=false 时忽略群聊；allowGroup=true 时正常入站
  const ignoredGroup = adapter.platform.deliver({
    message_id: 'grp_1',
    from_user_id: 'wxu_bob@im.wechat',
    group_id: '123456@chatroom',
    message_type: MESSAGE_TYPE.USER,
    item_list: [{ type: ITEM_TYPE.TEXT, text_item: { text: '群里说话' } }],
  })
  assert.equal(ignoredGroup, false)
  assert.equal(ctx.emitted.length, 1)

  const parsedGroup = parseInboundMessage({
    message_id: 'grp_2',
    group_id: '123456@chatroom',
    sender_user_id: 'wxu_bob@im.wechat',
    sender_name: 'Bob',
    mentioned_me: true,
    message_type: MESSAGE_TYPE.USER,
    context_token: 'ctx_grp_2',
    item_list: [{ type: ITEM_TYPE.TEXT, text_item: { text: '@Bot 你好' } }],
  }, { allowGroup: true })
  assert.equal(parsedGroup.kind, 'inbound')
  assert.equal(parsedGroup.inbound.chat.kind, 'group')
  assert.equal(parsedGroup.inbound.chat.id, '123456@chatroom')
  assert.equal(parsedGroup.inbound.mentionedMe, true)

  // 3) self-sent 不进 emit，只记 emitEvent
  adapter.platform.deliver({
    message_id: 'self_1',
    from_user_id: 'bot@im.bot',
    to_user_id: 'wxu_alice@im.wechat',
    message_type: MESSAGE_TYPE.BOT,
    item_list: [{ type: ITEM_TYPE.TEXT, text_item: { text: 'echo' } }],
  })
  assert.equal(ctx.emitted.length, 1)
  assert.equal(ctx.events.at(-1)?.type, 'self-sent')

  await adapter.stop()
})

test('出站 send：长文本分段、图片/视频/文件/语音降级加密上传、proactive limited 限流与错因分类', async () => {
  let now = 500_000
  const client = makeMockIlinkClient()
  const adapter = createWechatClawbotAdapter({ client, clock: () => now })
  const ctx = makeCtx(adapter, { botToken: 'tok_out', botId: 'bot@im.bot', maxTextChars: 10 })
  await adapter.start(ctx)

  // 无 context_token 且 proactive='limited' -> 拒绝 (not-sent/no-context-token)
  await assert.rejects(
    () => adapter.send({ chat: { kind: 'private', id: 'wxu_nobody' }, parts: [{ type: 'text', text: '在吗' }] }),
    (e) => e.certainty === 'not-sent' && e.code === 'no-context-token',
  )

  // 先收到一条入站拿 context_token
  adapter.platform.deliver({
    message_id: 'in_out_1',
    from_user_id: 'wxu_alice',
    message_type: MESSAGE_TYPE.USER,
    context_token: 'ctx_out_alice',
    item_list: [{ type: ITEM_TYPE.TEXT, text_item: { text: '发点东西' } }],
  })

  // 发送超长文本（拆 2 条） + 图片 + 语音（降级成文件）
  const imgBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7])
  const voiceBytes = Buffer.from('ID3fake-mp3-audio-payload')
  const sendRes = await adapter.send({
    chat: { kind: 'private', id: 'wxu_alice' },
    inResponseTo: 'in_out_1',
    parts: [
      { type: 'text', text: '123456789012345' },
      { type: 'image', media: { bytes: imgBytes, mime: 'image/png' } },
      { type: 'voice', media: { bytes: voiceBytes, mime: 'audio/mpeg' }, durationMs: 1500 },
    ],
  })
  assert.ok(sendRes.messageId)

  const sentMsgs = client.calls.filter((c) => c.url.includes('/ilink/bot/sendmessage'))
  assert.equal(sentMsgs.length, 4) // 2 text + 1 image + 1 voice-as-file
  assert.equal(sentMsgs[0].body.msg.message_type, MESSAGE_TYPE.BOT)
  assert.equal(sentMsgs[0].body.msg.message_state, MESSAGE_STATE.FINISH)
  assert.equal(sentMsgs[0].body.msg.context_token, 'ctx_out_alice')
  assert.equal(sentMsgs[2].body.msg.item_list[0].type, ITEM_TYPE.IMAGE)
  assert.equal(sentMsgs[3].body.msg.item_list[0].type, ITEM_TYPE.FILE)

  // 用 getuploadurl 里拿到的随机 aeskey 解密 CDN 收到的密文，核对与原始图片字节完全一致
  const upUrlReqImg = client.calls.find((c) => c.url.includes('/ilink/bot/getuploadurl') && c.body.media_type === UPLOAD_MEDIA_TYPE.IMAGE)
  const imgEqp = sentMsgs[2].body.msg.item_list[0].image_item.media.encrypt_query_param
  const imgOutAesKeyB64 = sentMsgs[2].body.msg.item_list[0].image_item.media.aes_key
  assert.deepEqual(parseAesKey(imgOutAesKeyB64), parseAesKey(upUrlReqImg.body.aeskey))
  assert.deepEqual(decryptAesEcb(client.uploadedPayloads.get(imgEqp), imgOutAesKeyB64), imgBytes)

  // 体积超限在发请求前拦下 (not-sent/too-large)
  await assert.rejects(
    () => adapter.send({
      chat: { kind: 'private', id: 'wxu_alice' },
      inResponseTo: 'in_out_1',
      parts: [{ type: 'file', media: { name: 'huge.zip', size: 25 * 1024 * 1024, url: 'https://example.com/huge.zip' } }],
    }),
    (e) => e.certainty === 'not-sent' && e.code === 'too-large',
  )

  // 主动发送频控：第 1 次通过，立即第 2 次被拒 (not-sent/proactive-limit)，等 4 秒恢复
  await adapter.send({ chat: { kind: 'private', id: 'wxu_alice' }, parts: [{ type: 'text', text: '主动1' }] })
  await assert.rejects(
    () => adapter.send({ chat: { kind: 'private', id: 'wxu_alice' }, parts: [{ type: 'text', text: '主动2' }] }),
    (e) => e.certainty === 'not-sent' && e.code === 'proactive-limit',
  )
  now += 4000
  await adapter.send({ chat: { kind: 'private', id: 'wxu_alice' }, parts: [{ type: 'text', text: '主动2成功' }] })

  await adapter.stop()
})

test('语音出站：voiceOutbound=true 时转 SILK 语音条，编码失败才降级文件', { skip: !silkAvailable }, async () => {
  const client = makeMockIlinkClient()
  const adapter = createWechatClawbotAdapter({ client })
  const ctx = makeCtx(adapter, { botToken: 'tok_voice', botId: 'bot_voice', voiceOutbound: true })
  await adapter.start(ctx)
  adapter.platform.deliver({
    message_id: 'in_voice_1',
    from_user_id: 'wxu_voice',
    message_type: MESSAGE_TYPE.USER,
    context_token: 'ctx_voice',
    item_list: [{ type: ITEM_TYPE.TEXT, text_item: { text: '来条语音' } }],
  })

  const wav = makeWavPcm16({ seconds: 0.8 })
  await adapter.send({
    chat: { kind: 'private', id: 'wxu_voice' },
    inResponseTo: 'in_voice_1',
    parts: [{ type: 'voice', media: { bytes: wav, mime: 'audio/wav' }, durationMs: 800 }],
  })

  const sent = client.calls.filter((c) => c.url.includes('/ilink/bot/sendmessage')).at(-1)
  const item = sent.body.msg.item_list[0]
  assert.equal(item.type, ITEM_TYPE.VOICE)
  assert.equal(item.voice_item.encode_type, 0)
  assert.equal(item.voice_item.bits_per_sample, 16)
  assert.equal(item.voice_item.sample_rate, 16000)
  assert.ok(item.voice_item.playtime >= 1)

  const uploadReq = client.calls.find((c) => c.url.includes('/ilink/bot/getuploadurl') && c.body.media_type === UPLOAD_MEDIA_TYPE.VOICE)
  assert.ok(uploadReq)
  const silkBytes = decryptAesEcb(client.uploadedPayloads.get(item.voice_item.media.encrypt_query_param), item.voice_item.media.aes_key)
  assert.equal(silkBytes.subarray(0, 10).toString('hex'), '02232153494c4b5f5633')
  await adapter.stop()

  // 坏音频不能谎报语音条：仍然按文件发，且文件名按真实魔数纠正，不再一律 voice.amr。
  const fallbackClient = makeMockIlinkClient()
  const fallbackAdapter = createWechatClawbotAdapter({ client: fallbackClient })
  const fallbackCtx = makeCtx(fallbackAdapter, { botToken: 'tok_voice_bad', botId: 'bot_voice_bad', voiceOutbound: true })
  await fallbackAdapter.start(fallbackCtx)
  fallbackAdapter.platform.deliver({
    message_id: 'in_voice_2',
    from_user_id: 'wxu_voice',
    message_type: MESSAGE_TYPE.USER,
    context_token: 'ctx_voice_2',
    item_list: [{ type: ITEM_TYPE.TEXT, text_item: { text: '再来一条' } }],
  })
  await fallbackAdapter.send({
    chat: { kind: 'private', id: 'wxu_voice' },
    inResponseTo: 'in_voice_2',
    parts: [{ type: 'voice', media: { bytes: Buffer.from('ID3not-a-real-mp3-payload'), mime: 'audio/wav' }, durationMs: 900 }],
  })
  const fallbackItem = fallbackClient.calls.filter((c) => c.url.includes('/ilink/bot/sendmessage')).at(-1).body.msg.item_list[0]
  assert.equal(fallbackItem.type, ITEM_TYPE.FILE)
  assert.equal(fallbackItem.file_item.file_name, 'voice.mp3')
  await fallbackAdapter.stop()
})

test('长轮询持久化游标 / context_token 跨重启恢复，以及 -14 会话过期立即断开停止轮询', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-wx-persist-'))
  let pollStep = 0
  let getUpdatesCount = 0
  const client1 = makeMockIlinkClient(async ({ url }) => {
    if (!url.includes('/ilink/bot/getupdates')) return null
    getUpdatesCount++
    pollStep++
    if (pollStep === 1) {
      return {
        status: 200,
        headers: {},
        json: {
          ret: 0,
          get_updates_buf: 'cursor_v2',
          msgs: [{
            message_id: 'poll_msg_1',
            from_user_id: 'wxu_persist',
            message_type: MESSAGE_TYPE.USER,
            context_token: 'ctx_persisted_abc',
            create_time_ms: Date.now(),
            item_list: [{ type: ITEM_TYPE.TEXT, text_item: { text: '长轮询消息' } }],
          }],
        },
      }
    }
    return null // 第二次开始挂起直到 stop()
  })

  const a1 = createWechatClawbotAdapter({ client: client1, dataDir: () => dir })
  const ctx1 = makeCtx(a1, { botToken: 'tok_p', botId: 'bot_p' })
  await a1.start(ctx1)
  await delay(40)
  assert.equal(ctx1.emitted.length, 1)
  assert.equal(a1.__clawbot.getSyncCursor(), 'cursor_v2')
  assert.equal(a1.__clawbot.getContextToken('wxu_persist'), 'ctx_persisted_abc')
  await a1.stop()

  // 重启实例后携带 cursor_v2 续传，且即使不带 inResponseTo 也能用落盘恢复的 context_token 发送；
  // 紧接着服务端回 ret=-14 -> 立刻 disconnected 且停止继续轮询
  let secondPollSeenBuf = null
  let a2Polls = 0
  const client2 = makeMockIlinkClient(async ({ url, bodyObj }) => {
    if (!url.includes('/ilink/bot/getupdates')) return null
    a2Polls++
    secondPollSeenBuf = bodyObj?.get_updates_buf
    return { status: 200, headers: {}, json: { errcode: -14, errmsg: 'session expired' } }
  })
  const a2 = createWechatClawbotAdapter({ client: client2, dataDir: () => dir })
  const ctx2 = makeCtx(a2, { botToken: 'tok_p', botId: 'bot_p' })
  await assert.rejects(() => a2.start(ctx2), (e) => e.certainty === 'not-sent' && e.code === 'session-expired')
  assert.equal(a2.__clawbot.getSyncCursor(), 'cursor_v2')
  assert.equal(a2.__clawbot.getContextToken('wxu_persist'), 'ctx_persisted_abc')
  assert.equal(secondPollSeenBuf, 'cursor_v2')
  assert.equal(a2.__clawbot.isSessionExpired(), true)
  assert.equal(ctx2.states.at(-1)?.[0], 'disconnected')
  assert.ok(!ctx2.states.some(([s]) => s === 'connected'), '首轮 getupdates 返回 -14 时不得进入 connected')
  assert.equal(a2Polls, 1, '-14 会话失效后应立即停轮询，不死循环')
  await a2.stop()

  // 3) 会话运行中途收到 -14：首轮正常 connected，第二轮返回 -14 -> 立即断开并停止轮询
  let midPolls = 0
  const client3 = makeMockIlinkClient(async ({ url }) => {
    if (!url.includes('/ilink/bot/getupdates')) return null
    midPolls++
    if (midPolls === 1) return { status: 200, headers: {}, json: { ret: 0, get_updates_buf: 'cursor_v3', msgs: [] } }
    return { status: 200, headers: {}, json: { errcode: -14, errmsg: 'session expired mid-run' } }
  })
  const a3 = createWechatClawbotAdapter({ client: client3, dataDir: () => dir })
  const ctx3 = makeCtx(a3, { botToken: 'tok_p', botId: 'bot_p' })
  await a3.start(ctx3)
  await delay(40)
  assert.equal(a3.__clawbot.isSessionExpired(), true)
  assert.equal(ctx3.states.at(-1)?.[0], 'disconnected')
  assert.equal(midPolls, 2)
  await a3.stop()

  // 4) 重新扫码换号（botId 变化）：同一 dataDir 下旧游标与旧 context_token 不得带入新账号
  let otherSeenBuf = null
  let otherPolls = 0
  const client4 = makeMockIlinkClient(async ({ url, bodyObj }) => {
    if (!url.includes('/ilink/bot/getupdates')) return null
    if (otherPolls++ > 0) return null // 之后挂起，避免即时返回造成忙轮询
    otherSeenBuf = bodyObj?.get_updates_buf
    return { status: 200, headers: {}, json: { ret: 0, get_updates_buf: 'cursor_other', msgs: [] } }
  })
  const a4 = createWechatClawbotAdapter({ client: client4, dataDir: () => dir })
  const ctx4 = makeCtx(a4, { botToken: 'tok_new', botId: 'bot_other' })
  await a4.start(ctx4)
  assert.equal(otherSeenBuf, '', '换号后首轮游标必须从空开始')
  assert.equal(a4.__clawbot.getContextToken('wxu_persist'), '', '换号后不得沿用旧账号的 context_token')
  await a4.stop()
})

test('sendtyping 票据缓存与扫码登录状态机（wait → scaned → confirmed / expired）', async () => {
  const client = makeMockIlinkClient(async ({ url }) => {
    if (url.includes('/ilink/bot/get_bot_qrcode')) {
      return {
        status: 200,
        headers: {},
        json: { qrcode: 'qr_sess_1', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=qr_sess_1' },
      }
    }
    return null
  })

  // 1) startQrLogin + pollQrStatus 状态流转
  const qr = await startQrLogin({ client })
  assert.equal(qr.qrcode, 'qr_sess_1')
  assert.ok(qr.qrDataUri.startsWith('data:image/svg+xml;base64,'))
  assert.equal(client.calls.at(-1)?.headers['iLink-App-ClientVersion'], '1')

  let statusStep = 0
  const statusClient = {
    calls: [],
    async request(req) {
      statusClient.calls.push(req)
      statusStep++
      if (statusStep === 1) return { status: 200, headers: {}, json: { status: 'wait' } }
      if (statusStep === 2) return { status: 200, headers: {}, json: { status: 'scaned' } }
      if (statusStep === 3) {
        return {
          status: 200,
          headers: {},
          json: {
            status: 'confirmed',
            bot_token: 'tok_confirmed_888',
            ilink_bot_id: 'bot_888@im.bot',
            baseurl: 'https://sz.ilinkai.weixin.qq.com/',
            ilink_user_id: 'wx_user_888',
          },
        }
      }
      return { status: 200, headers: {}, json: { status: 'expired' } }
    },
  }

  assert.equal((await pollQrStatus({ qrcode: qr.qrcode, client: statusClient })).state, 'wait')
  assert.equal((await pollQrStatus({ qrcode: qr.qrcode, client: statusClient })).state, 'scaned')
  const confirmed = await pollQrStatus({ qrcode: qr.qrcode, client: statusClient })
  assert.equal(confirmed.state, 'confirmed')
  assert.equal(confirmed.botToken, 'tok_confirmed_888')
  assert.equal(confirmed.botId, 'bot_888@im.bot')
  assert.equal(confirmed.baseUrl, 'https://sz.ilinkai.weixin.qq.com')
  assert.equal((await pollQrStatus({ qrcode: qr.qrcode, client: statusClient })).state, 'expired')

  // 2) native('send_typing') 命中 getconfig 缓存，两次打字只请求一次 wxu_bob 的 getconfig（且 start() 绝不调 getconfig）
  const adapter = createWechatClawbotAdapter({ client })
  const ctx = makeCtx(adapter, { botToken: 'tok_t', botId: 'bot_t' })
  await adapter.start(ctx)
  assert.equal(client.calls.filter((c) => c.url.includes('/ilink/bot/getconfig')).length, 0, 'start() 绝不应拿 botId 调 getconfig')
  await adapter.native('send_typing', { chatId: 'wxu_bob' })
  await adapter.native('send_typing', { chatId: 'wxu_bob', cancel: true })
  assert.equal(client.calls.filter((c) => c.url.includes('/ilink/bot/getconfig') && c.body?.ilink_user_id === 'wxu_bob').length, 1)
  const typingCalls = client.calls.filter((c) => c.url.includes('/ilink/bot/sendtyping'))
  assert.equal(typingCalls.length, 2)
  assert.equal(typingCalls[0].body.status, 1)
  assert.equal(typingCalls[1].body.status, 2)
  await adapter.stop()
})

test('审阅加固：P1 群 @ 过滤、P2-1 启动探活、P2-2 缺 botId 拦截、P2-3 群 sender 不猜群号、P2-4 SSRF 与路径边界', async () => {
  // ── P1：allowGroup=true + listenAllInGroup=false 时，严格只放行 mentioned_me=true 的群消息 ──
  const clientGroup = makeMockIlinkClient()
  const aGroup = createWechatClawbotAdapter({ client: clientGroup })
  const ctxGroup = makeCtx(aGroup, { botToken: 'tok_g', botId: 'bot_g', allowGroup: true, listenAllInGroup: false })
  await aGroup.start(ctxGroup)

  // 未 @ 且 mentioned_me 缺失 / false → 不 emit
  assert.equal(aGroup.platform.deliver({
    message_id: 'g_plain_1',
    group_id: '123456@chatroom',
    sender_user_id: 'wxu_alice',
    message_type: MESSAGE_TYPE.USER,
    item_list: [{ type: ITEM_TYPE.TEXT, text_item: { text: '群友闲聊' } }],
  }), false)
  assert.equal(aGroup.platform.deliver({
    message_id: 'g_plain_2',
    group_id: '123456@chatroom',
    sender_user_id: 'wxu_alice',
    mentioned_me: false,
    message_type: MESSAGE_TYPE.USER,
    item_list: [{ type: ITEM_TYPE.TEXT, text_item: { text: '另一句闲聊' } }],
  }), false)
  assert.equal(ctxGroup.emitted.length, 0)

  // mentioned_me=true → emit
  assert.equal(aGroup.platform.deliver({
    message_id: 'g_at_1',
    group_id: '123456@chatroom',
    sender_user_id: 'wxu_alice',
    mentioned_me: true,
    message_type: MESSAGE_TYPE.USER,
    context_token: 'ctx_g_at',
    item_list: [{ type: ITEM_TYPE.TEXT, text_item: { text: '@Bot 帮我看看' } }],
  }), true)
  assert.equal(ctxGroup.emitted.length, 1)
  assert.equal(ctxGroup.emitted[0].sender.account, 'wxu_alice')

  // P2-3：缺少成员 sender（仅 group_id / from_user_id=@chatroom）时即使 mentioned_me=true 也不猜成群 ID
  assert.equal(aGroup.platform.deliver({
    message_id: 'g_nosender',
    from_user_id: '123456@chatroom',
    mentioned_me: true,
    message_type: MESSAGE_TYPE.USER,
    item_list: [{ type: ITEM_TYPE.TEXT, text_item: { text: '缺 sender' } }],
  }), false)
  assert.equal(ctxGroup.emitted.length, 1)
  await aGroup.stop()

  // allowGroup=true + listenAllInGroup=true 时，未 @ 的合法群消息也放行
  const aGroupAll = createWechatClawbotAdapter({ client: makeMockIlinkClient() })
  const ctxGroupAll = makeCtx(aGroupAll, { botToken: 'tok_ga', botId: 'bot_ga', allowGroup: true, listenAllInGroup: true })
  await aGroupAll.start(ctxGroupAll)
  assert.equal(aGroupAll.platform.deliver({
    message_id: 'g_all_1',
    group_id: '123456@chatroom',
    sender_user_id: 'wxu_bob',
    message_type: MESSAGE_TYPE.USER,
    item_list: [{ type: ITEM_TYPE.TEXT, text_item: { text: '群全量监听测试' } }],
  }), true)
  assert.equal(ctxGroupAll.emitted.length, 1)
  await aGroupAll.stop()

  // ── P1 & P2-2：启动未填 botId 拒启动；token 失效（getupdates 返回 -14 / 401）绝不误报 connected，也不调 getconfig ──
  const aNoBotId = createWechatClawbotAdapter({ client: makeMockIlinkClient() })
  const ctxNoId = makeCtx(aNoBotId, { botToken: 'tok_only' })
  await assert.rejects(() => aNoBotId.start(ctxNoId), /botId/)
  assert.equal(ctxNoId.states.at(-1)?.[0], 'unconfigured')
  assert.ok(!ctxNoId.states.some(([s]) => s === 'connected'))

  for (const failCase of [
    { status: 200, json: { errcode: -14, errmsg: 'session timeout' } },
    { status: 401, json: { errmsg: 'unauthorized' } },
  ]) {
    const failClient = makeMockIlinkClient(async ({ url }) => {
      if (url.includes('/ilink/bot/getupdates')) return { ...failCase, headers: {} }
      return null
    })
    const aFail = createWechatClawbotAdapter({ client: failClient })
    const ctxFail = makeCtx(aFail, { botToken: 'tok_expired', botId: 'bot_expired' })
    await assert.rejects(() => aFail.start(ctxFail))
    assert.equal(ctxFail.states.at(-1)?.[0], 'disconnected')
    assert.ok(!ctxFail.states.some(([s]) => s === 'connected'), '首轮 getupdates 授权失败时绝不能出现 connected')
    assert.equal(failClient.calls.filter((c) => c.url.includes('/ilink/bot/getconfig')).length, 0, 'start() 不得调用 getconfig')
    await aFail.stop()
  }

  // ── 首轮 getupdates 长轮询挂起超时（未拒绝也未成功响应）→ 停在 connecting，不中止请求；首轮最终响应后再 connected ──
  const slowWaiters = []
  const slowClient = makeMockIlinkClient(async ({ req, url }) => {
    if (!url.includes('/ilink/bot/getupdates')) return null
    return await new Promise((resolve, reject) => {
      const w = { resolve, reject, aborted: false }
      slowWaiters.push(w)
      req.signal?.addEventListener?.('abort', () => {
        w.aborted = true
        const err = new Error('aborted')
        err.name = 'AbortError'
        reject(err)
      }, { once: true })
    })
  })
  const aSlow = createWechatClawbotAdapter({ client: slowClient, startupWaitMs: 30 })
  const ctxSlow = makeCtx(aSlow, { botToken: 'tok_slow', botId: 'bot_slow' })
  await aSlow.start(ctxSlow)
  assert.equal(ctxSlow.states.at(-1)?.[0], 'connecting', '首轮 getupdates 尚在长轮询等待中时应保持 connecting')
  assert.ok(!ctxSlow.states.some(([s]) => s === 'connected'))
  assert.equal(slowWaiters.length, 1)
  assert.equal(slowWaiters[0].aborted, false, 'startupWaitMs 到期不应中止挂起中的首轮 getupdates')
  assert.equal(slowClient.calls.filter((c) => c.url.includes('/ilink/bot/getconfig')).length, 0)
  slowWaiters[0].resolve({ status: 200, headers: {}, json: { ret: 0, get_updates_buf: 'slow_buf_1', msgs: [] } })
  await delay(25)
  assert.equal(ctxSlow.states.at(-1)?.[0], 'connected', '首轮 getupdates 真正成功后转为 connected')
  await aSlow.stop()

  // ── 首轮 getupdates 瞬态失败（HTTP 502）→ 维持 connecting 重试，绝不误报 connected ──
  let errPollCount = 0
  const errClient = makeMockIlinkClient(async ({ url }) => {
    if (!url.includes('/ilink/bot/getupdates')) return null
    errPollCount++
    return { status: 502, headers: {}, json: {}, text: 'bad gateway' }
  })
  const aTransient = createWechatClawbotAdapter({ client: errClient, startupWaitMs: 80 })
  const ctxTransient = makeCtx(aTransient, { botToken: 'tok_502', botId: 'bot_502' })
  await aTransient.start(ctxTransient)
  assert.equal(ctxTransient.states.at(-1)?.[0], 'connecting')
  assert.ok(!ctxTransient.states.some(([s]) => s === 'connected'))
  assert.equal(errClient.calls.filter((c) => c.url.includes('/ilink/bot/getconfig')).length, 0)
  assert.ok(errPollCount >= 1)
  await aTransient.stop()

  // ── P2-4：媒体 URL SSRF + 重定向保护 & 本地路径边界（不绕过真实 assertPublicUrl） ──
  const redirectClient = makeMockIlinkClient(async ({ url }) => {
    if (url === 'https://93.184.216.34/redirect-inner.png') {
      return { status: 302, headers: { location: 'http://127.0.0.1/secret' }, bytes: Buffer.alloc(0) }
    }
    if (String(url).startsWith('https://93.184.216.34/loop-')) {
      const n = Number(url.split('-').pop()) || 0
      return { status: 302, headers: { location: `https://93.184.216.34/loop-${n + 1}` }, bytes: Buffer.alloc(0) }
    }
    return null
  })
  const aSec = createWechatClawbotAdapter({ client: redirectClient, allowLocalPath: false })
  const ctxSec = makeCtx(aSec, { botToken: 'tok_sec', botId: 'bot_sec' })
  await aSec.start(ctxSec)
  aSec.platform.deliver({
    message_id: 'sec_in_1',
    from_user_id: 'wxu_sec',
    message_type: MESSAGE_TYPE.USER,
    context_token: 'ctx_sec',
    item_list: [{ type: ITEM_TYPE.TEXT, text_item: { text: '安全边界' } }],
  })

  for (const blockedUrl of [
    'http://127.0.0.1/admin',
    'http://169.254.169.254/latest/meta-data/',
    'http://192.168.1.2/lan.png',
    'file:///etc/passwd',
    'https://93.184.216.34/redirect-inner.png',
  ]) {
    await assert.rejects(
      () => aSec.send({ chat: { kind: 'private', id: 'wxu_sec' }, inResponseTo: 'sec_in_1', parts: [{ type: 'image', media: { url: blockedUrl } }] }),
      (e) => e.certainty === 'not-sent' && e.code === 'ssrf-blocked',
      `应拦截不安全媒体地址：${blockedUrl}`,
    )
  }

  await assert.rejects(
    () => aSec.send({ chat: { kind: 'private', id: 'wxu_sec' }, inResponseTo: 'sec_in_1', parts: [{ type: 'image', media: { url: 'https://93.184.216.34/loop-0' } }] }),
    (e) => e.certainty === 'not-sent' && e.code === 'too-many-redirects',
  )

  await assert.rejects(
    () => aSec.send({ chat: { kind: 'private', id: 'wxu_sec' }, inResponseTo: 'sec_in_1', parts: [{ type: 'file', media: { path: '../relative.txt' } }] }),
    (e) => e.certainty === 'not-sent' && e.code === 'local-path-blocked',
  )

  await assert.rejects(
    () => aSec.fetch({ kind: 'media', media: { path: 'C:\\Windows\\win.ini' } }),
    (e) => e.certainty === 'not-sent' && e.code === 'local-path-blocked',
  )

  await aSec.stop()

  // 默认未配置 allowedLocalDirs 时 fail-closed，即使真实存在的绝对文件也拒绝读取
  const sandboxRoot = mkdtempSync(join(tmpdir(), 'aurabot-wx-dirs-'))
  const insideDir = join(sandboxRoot, 'allowed')
  const outsideDir = join(sandboxRoot, 'outside')
  const insideSiblingPrefixDir = join(sandboxRoot, 'allowed-other')
  mkdirSync(insideDir, { recursive: true })
  mkdirSync(outsideDir, { recursive: true })
  mkdirSync(insideSiblingPrefixDir, { recursive: true })
  const insideFile = join(insideDir, 'ok.txt')
  const outsideFile = join(outsideDir, 'secret.txt')
  const siblingPrefixFile = join(insideSiblingPrefixDir, 'trap.txt')
  writeFileSync(insideFile, 'hello allowed')
  writeFileSync(outsideFile, 'secret outside')
  writeFileSync(siblingPrefixFile, 'prefix trap')

  const aDefaultFailClosed = createWechatClawbotAdapter({ client: makeMockIlinkClient() })
  const ctxDefaultFC = makeCtx(aDefaultFailClosed, { botToken: 'tok_fc', botId: 'bot_fc' })
  await aDefaultFailClosed.start(ctxDefaultFC)
  aDefaultFailClosed.platform.deliver({
    message_id: 'fc_in_1',
    from_user_id: 'wxu_fc',
    message_type: MESSAGE_TYPE.USER,
    context_token: 'ctx_fc',
    item_list: [{ type: ITEM_TYPE.TEXT, text_item: { text: 'fc' } }],
  })
  await assert.rejects(
    () => aDefaultFailClosed.send({ chat: { kind: 'private', id: 'wxu_fc' }, inResponseTo: 'fc_in_1', parts: [{ type: 'file', media: { path: insideFile, name: 'ok.txt' } }] }),
    (e) => e.certainty === 'not-sent' && e.code === 'local-path-blocked',
    '未传 allowedLocalDirs 时 adapter 默认 fail-closed，禁止直接读取本地绝对路径',
  )
  await aDefaultFailClosed.stop()

  // allowedLocalDirs: [] 也应 fail-closed
  const aEmptyDirs = createWechatClawbotAdapter({ client: makeMockIlinkClient(), allowedLocalDirs: [] })
  const ctxEmptyDirs = makeCtx(aEmptyDirs, { botToken: 'tok_ed', botId: 'bot_ed' })
  await aEmptyDirs.start(ctxEmptyDirs)
  aEmptyDirs.platform.deliver({
    message_id: 'ed_in_1',
    from_user_id: 'wxu_ed',
    message_type: MESSAGE_TYPE.USER,
    context_token: 'ctx_ed',
    item_list: [{ type: ITEM_TYPE.TEXT, text_item: { text: 'ed' } }],
  })
  await assert.rejects(
    () => aEmptyDirs.send({ chat: { kind: 'private', id: 'wxu_ed' }, inResponseTo: 'ed_in_1', parts: [{ type: 'file', media: { path: insideFile, name: 'ok.txt' } }] }),
    (e) => e.certainty === 'not-sent' && e.code === 'local-path-blocked',
  )
  await aEmptyDirs.stop()

  // allowedLocalDirs getter：允许白名单目录内文件，拦截相对路径、越界目录与前缀同名目录
  const aScoped = createWechatClawbotAdapter({
    client: makeMockIlinkClient(),
    allowedLocalDirs: () => [insideDir],
  })
  const ctxScoped = makeCtx(aScoped, { botToken: 'tok_path', botId: 'bot_path' })
  await aScoped.start(ctxScoped)
  aScoped.platform.deliver({
    message_id: 'path_in_1',
    from_user_id: 'wxu_p',
    message_type: MESSAGE_TYPE.USER,
    context_token: 'ctx_path',
    item_list: [{ type: ITEM_TYPE.TEXT, text_item: { text: 'path' } }],
  })
  const sentOk = await aScoped.send({
    chat: { kind: 'private', id: 'wxu_p' },
    inResponseTo: 'path_in_1',
    parts: [{ type: 'file', media: { path: insideFile, name: 'ok.txt' } }],
  })
  assert.ok(sentOk.messageId)
  for (const badPath of ['../relative.txt', outsideFile, siblingPrefixFile]) {
    await assert.rejects(
      () => aScoped.send({ chat: { kind: 'private', id: 'wxu_p' }, inResponseTo: 'path_in_1', parts: [{ type: 'file', media: { path: badPath } }] }),
      (e) => e.certainty === 'not-sent' && e.code === 'local-path-blocked',
      `应拦截白名单外路径：${badPath}`,
    )
  }
  await aScoped.stop()
})
