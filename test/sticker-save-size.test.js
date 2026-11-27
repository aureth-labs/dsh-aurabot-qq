// 收表情的体积口径（#332）：5MB 硬上限让「看得见的表情存不进去」，而且失败只回三个字「太大了」。
// 这里守住三件事：各入口共用同一个上限、超限错误带真实大小、面板上传有自己的一档且说清楚。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-sticker-size-'))

let stickersModule
let MAX_STICKER_BYTES
let PANEL_UPLOAD_MAX_BYTES
let fetchImage
let formatBytes

before(async () => {
  stickersModule = (await import('../src/modules/stickers/index.js')).default
  ;({ MAX_STICKER_BYTES, PANEL_UPLOAD_MAX_BYTES } = await import('../src/features/stickers.js'))
  ;({ fetchImage, formatBytes } = await import('../src/core/net.js'))
})

const OWNER = '10000001'

// 一张 200x200 的「表情」，大小可控（PNG 头 + 填充，够 imageSize / mimeOf 认出来）
function pngOf(bytes, salt = 0) {
  const b = Buffer.alloc(Math.max(64, bytes), salt)
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47; b[7] = 0x0a
  b.writeUInt32BE(200, 16); b.writeUInt32BE(200, 20)
  return b
}

const segOf = (buf) => ({ type: 'image', data: { file: 'base64://' + buf.toString('base64'), sub_type: 1 } })

/** 只搭表情模块要用的那点 api：工具、路由、配置、日志。 */
function fixture({ recent = [], uploadBytes = 0 } = {}) {
  const cfg = {
    ownerQQ: OWNER,
    dryRun: true,
    stickers: { enabled: true, collect: true, collectMode: 'ask', caption: false, autoChance: 0, maxPerHour: 20, maxLibrary: 300 },
  }
  const routes = new Map()
  const builders = []
  const api = {
    core: {
      hub: {
        turnSendersAllOwner: () => true,
        recentMedia: () => recent,
        stickerOf: () => recent[0]?.seg || null,
        sendSticker: async () => true,
      },
      onebot: { call: async () => ({}) },
      http: {
        body: async () => (uploadBytes ? { data: Buffer.alloc(uploadBytes, 1).toString('base64') } : {}),
        query: () => ({}),
        send: () => {},
      },
    },
    config: () => cfg,
    log: { info() {}, warn() {}, debug() {} },
    dsh: {},
    tool: (builder) => builders.push(builder),
    route: (path, handler) => routes.set(path, handler),
    rule: () => {},
  }
  const store = stickersModule.setup(api)
  const tool = (name) => builders
    .flatMap((b) => b({ chat: { kind: 'private', userId: OWNER, chatId: `private:${OWNER}` }, level: 'full', sessionId: 'test' }))
    .find((t) => t.name === name)
  return { cfg, store, routes, tool }
}

test('#332 超过 5MB 的表情也能存进库（以前卡在 5MB 硬上限）', async () => {
  const big = pngOf(7 * 1024 * 1024, 3) // 7MB > 旧的 5MB 上限
  const f = fixture({ recent: [{ userId: OWNER, seg: segOf(big) }] })
  const r = await f.tool('qq_save_sticker').execute({ name: '大动图' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(f.store.library().items.at(-1).bytes, big.length, '存下来的是原件，不是缩图')
})

test('#332 真的超限时，错误信息要说清多大、上限多少（不再只回「太大了」）', async () => {
  await assert.rejects(
    () => fetchImage('base64://' + Buffer.alloc(2000).toString('base64'), { maxBytes: 100 }),
    (error) => {
      assert.match(error.message, /图片太大/)
      assert.match(error.message, /2KB/, '要带实际大小')
      assert.match(error.message, /100B/, '要带上限')
      return true
    },
  )
})

test('#332 下载失败的原因会带回给模型（以前这里没 try，异常被压成三个字）', async () => {
  // 段里给一个取不到的地址：工具应该回「这张表情下载失败了：…」，而不是让异常冒出去变成空话
  const f = fixture({ recent: [{ userId: OWNER, seg: { type: 'image', data: { file: 'not-a-real-path-' + Date.now() } } }] })
  const r = await f.tool('qq_save_sticker').execute({})
  assert.equal(r.ok, false)
  assert.match(String(r.message), /下载失败|取不到/, '要说明是哪一步失败：' + JSON.stringify(r))
})

test('#332 各入口共用同一个上限：表情工具和「偷表情」不再各写一个数', () => {
  assert.equal(MAX_STICKER_BYTES, 1024 * 1024 * 1024, 'QQ 侧跟聊天收图同一个量级')
  assert.ok(PANEL_UPLOAD_MAX_BYTES < MAX_STICKER_BYTES, '面板上传走 JSON+base64，单独一档')
  assert.ok(PANEL_UPLOAD_MAX_BYTES >= 20 * 1024 * 1024, '至少能传 QQ 里最常见的大动图')
})

test('#332 面板上传超过自己那一档时，明确告诉主人多大、上限多少', async () => {
  const size = PANEL_UPLOAD_MAX_BYTES + 4096
  const f = fixture({ uploadBytes: size })
  const r = await f.routes.get('/sticker/upload')({})
  assert.equal(r.ok, false, JSON.stringify(r))
  assert.match(r.message, /图片太大/)
  assert.match(r.message, /上限|最多/)
})

test('formatBytes 说人话', () => {
  assert.equal(formatBytes(10348072), '9.9MB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0MB')
  assert.equal(formatBytes(900), '900B')
})
