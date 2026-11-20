// W1 公共微信工具层单测：文本切分、媒体校验与魔数识别、音频转码降级、主动限流、错误分类、本地 SVG 二维码编码。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  splitWechatText,
  inferMimeFromBytes,
  inferMimeFromName,
  extForMime,
  checkMediaConstraints,
  transcodeAudioForWechat,
  createProactiveRateLimiter,
  createSendError,
  classifyTransportError,
  formatWechatErrorSummary,
  encodeQrMatrix,
  encodeQrSvg,
  encodeQrSvgDataUri,
} from '../../src/adapters/wechat-common/index.js'

test('splitWechatText：优先按段落/换行拆分、遵守 UTF-8 字节上限且不切断 emoji 代理对', () => {
  assert.deepEqual(splitWechatText(''), [])
  assert.deepEqual(splitWechatText('短消息', { maxChars: 20 }), ['短消息'])

  const multiPara = '第一段内容较长一点\n\n第二段继续延续内容'
  const parts = splitWechatText(multiPara, { maxChars: 14, maxBytes: 100 })
  assert.ok(parts.length >= 2)
  assert.equal(parts.join(''), multiPara)
  assert.ok(parts.every((p) => p.length <= 14))

  // 中文 UTF-8 每字 3 字节，maxBytes=10 应保底不超 10 字节且不出现乱码字符
  const cjk = '你好世界测试文本切分'
  const byteParts = splitWechatText(cjk, { maxChars: 50, maxBytes: 10 })
  assert.equal(byteParts.join(''), cjk)
  for (const p of byteParts) {
    assert.ok(Buffer.byteLength(p, 'utf8') <= 10)
    assert.ok(!p.includes('\uFFFD'))
  }

  // 4 字节 emoji 代理对不被拆断
  const emojis = '😀😁😂😃😄😅😆'
  const emojiParts = splitWechatText(emojis, { maxChars: 3, maxBytes: 100 })
  assert.equal(emojiParts.join(''), emojis)
  for (const p of emojiParts) {
    assert.ok(!/[\uD800-\uDFFF]$/.test(p) || /[\uD800-\uDBFF][\uDC00-\uDFFF]$/.test(p))
  }
})

test('inferMimeFromBytes / checkMediaConstraints：魔数识别、后缀推断与大小上限拦截', () => {
  assert.equal(inferMimeFromBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png')
  assert.equal(inferMimeFromBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16])), 'image/jpeg')
  assert.equal(inferMimeFromBytes(Buffer.from('GIF89a......')), 'image/gif')
  assert.equal(inferMimeFromBytes(Buffer.from('RIFF\x00\x00\x00\x00WEBP')), 'image/webp')
  assert.equal(inferMimeFromBytes(Buffer.from('RIFF\x00\x00\x00\x00WAVE')), 'audio/wav')
  assert.equal(inferMimeFromBytes(Buffer.from('#!AMR\nxxxx')), 'audio/amr')
  assert.equal(inferMimeFromBytes(Buffer.from('\x02#!SILK_V3xxxx')), 'audio/silk')
  assert.equal(inferMimeFromBytes(Buffer.from('\x00\x00\x00\x18ftypmp42')), 'video/mp4')
  assert.equal(inferMimeFromBytes(Buffer.from('%PDF-1.7')), 'application/pdf')

  assert.equal(inferMimeFromName('photo.JPEG'), 'image/jpeg')
  assert.equal(extForMime('image/png; charset=utf-8'), 'png')

  const okCheck = checkMediaConstraints({ bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]), name: 'a.bin' }, { kind: 'image', maxBytes: 100 })
  assert.equal(okCheck.ok, true)
  assert.equal(okCheck.mime, 'image/png')
  assert.equal(okCheck.ext, 'png')

  const bigCheck = checkMediaConstraints({ size: 2048 }, { kind: 'file', maxBytes: 1024 })
  assert.equal(bigCheck.ok, false)
  assert.match(bigCheck.reason, /超过上限 1024/)

  const denyMime = checkMediaConstraints({ bytes: Buffer.from('GIF89a1234') }, { kind: 'image', allowedMimes: ['image/png'] })
  assert.equal(denyMime.ok, false)
  assert.match(denyMime.reason, /image\/gif/)
})

test('transcodeAudioForWechat：缺 ffmpeg 或退出码非零时明确 fallbackToFile，绝不谎报成功', async () => {
  const noFfmpeg = await transcodeAudioForWechat(Buffer.from('RIFF\x00\x00\x00\x00WAVE'), { ffmpegPath: '' })
  assert.equal(noFfmpeg.ok, false)
  assert.equal(noFfmpeg.fallbackToFile, true)
  assert.match(noFfmpeg.reason, /ffmpeg/)

  const failSpawn = () => {
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    setTimeout(() => {
      child.stderr.emit('data', 'codec error')
      child.emit('exit', 1)
    }, 5)
    return child
  }
  const failed = await transcodeAudioForWechat(Buffer.from('audio'), { ffmpegPath: 'ffmpeg', spawnImpl: failSpawn })
  assert.equal(failed.ok, false)
  assert.equal(failed.fallbackToFile, true)
  assert.match(failed.reason, /codec error/)
})

test('createProactiveRateLimiter：最小间隔、滑动窗口上限、按目标隔离与 reset', () => {
  let now = 100_000
  const limiter = createProactiveRateLimiter({ minIntervalMs: 3000, windowMs: 60_000, maxPerWindow: 2, clock: () => now })

  assert.equal(limiter.check('user_a').ok, true)
  limiter.record('user_a')

  now += 1000
  const tooFast = limiter.check('user_a')
  assert.equal(tooFast.ok, false)
  assert.equal(tooFast.retryAfterMs, 2000)
  // 另一个目标不受影响
  assert.equal(limiter.check('user_b').ok, true)

  now += 2500
  assert.equal(limiter.check('user_a').ok, true)
  limiter.record('user_a')

  now += 4000
  const capped = limiter.check('user_a')
  assert.equal(capped.ok, false)
  assert.match(capped.reason, /上限/)

  // 滑出窗口后恢复
  now += 60_000
  assert.equal(limiter.check('user_a').ok, true)
  limiter.record('user_a')
  limiter.reset('user_a')
  assert.equal(limiter.check('user_a').ok, true)
})

test('classifyTransportError / formatWechatErrorSummary：Timeout 按 unknown、ECONNREFUSED 按 not-sent、敏感值打码', () => {
  const errTimeout = classifyTransportError(Object.assign(new Error('timed out'), { name: 'TimeoutError' }), 'wechat-clawbot')
  assert.equal(errTimeout.certainty, 'unknown')
  assert.equal(errTimeout.instance, 'wechat-clawbot')

  const errRefused = classifyTransportError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), 'wechat-clawbot')
  assert.equal(errRefused.certainty, 'not-sent')

  const errReset = classifyTransportError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), 'wechat-clawbot')
  assert.equal(errReset.certainty, 'unknown')

  const explicit = createSendError('not-sent', 'explicit', 'wechat-clawbot', 'explicit')
  assert.equal(classifyTransportError(explicit, 'wechat-clawbot'), explicit)

  const summary = formatWechatErrorSummary('发送失败', -14, 'bad token=secret_token_999', ['secret_token_999'])
  assert.doesNotMatch(summary, /secret_token_999/)
  assert.match(summary, /\*\*\*/)
})

test('qr-svg：本地编码 ISO 二维码（V1–V10）结构完整并输出有效 SVG Data URI', () => {
  // 典型微信 iLink QR 链接长度（~50-90 字节，对应 V3–V6）以及 V7（含版本信息区）
  for (const text of [
    'hello',
    'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=abc123def456',
    'https://ilinkai.weixin.qq.com/qr/' + 'x'.repeat(80), // ~113B -> V7 (trigger version bits)
  ]) {
    const { version, size, modules } = encodeQrMatrix(text)
    assert.ok(version >= 1 && version <= 10)
    assert.equal(size, 17 + version * 4)
    assert.equal(modules.length, size)

    // 校验 3 个 7x7 Finder 图案中心 3x3 全黑、外框全黑
    for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
      assert.equal(modules[r0][c0], 1)
      assert.equal(modules[r0 + 3][c0 + 3], 1)
      assert.equal(modules[r0 + 1][c0 + 1], 0)
    }
    // 校验固定暗块 (size - 8, 8)
    assert.equal(modules[size - 8][8], 1)
    // 校验 Timing Pattern（绝不能被格式信息覆盖）
    for (let i = 8; i < size - 8; i++) {
      assert.equal(modules[6][i], i % 2 === 0 ? 1 : 0)
      assert.equal(modules[i][6], i % 2 === 0 ? 1 : 0)
    }
    // 校验两侧格式信息拷贝对称一致（Copy 1 MSB=bit14 at (8,0)/(size-1,8), LSB=bit0 at (0,8)/(8,size-1)）
    assert.equal(modules[8][0], modules[size - 1][8])
    assert.equal(modules[8][7], modules[size - 7][8])
    assert.equal(modules[0][8], modules[8][size - 1])
    assert.equal(modules[7][8], modules[8][size - 7])
  }

  const svg = encodeQrSvg('https://weixin.qq.com/x/test')
  assert.ok(svg.startsWith('<svg '))
  assert.ok(svg.includes('<path d="M'))

  const uri = encodeQrSvgDataUri('https://weixin.qq.com/x/test')
  assert.ok(uri.startsWith('data:image/svg+xml;base64,'))
  const decoded = Buffer.from(uri.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8')
  assert.equal(decoded, svg)
})
