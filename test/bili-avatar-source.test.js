// B站头像的 last 由 B站模块解析；不依赖 QQ 画作别名，也不访问真实账号。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import biliModule from '../src/modules/bili/index.js'
import { normalize } from '../src/core/config.js'
import { dataDir } from '../src/core/store.js'

test('B站头像：last / 最近图片 / 网址、主人权限和开关在模块内正确解析', async () => {
  const cfg = normalize({ enabled: true, dryRun: true, ownerQQ: '10000001', bili: { enabled: true } })
  const builders = [], events = new Map()
  let owner = true
  const hub = { turnSendersAllOwner: () => owner, chatOfSession: () => '' }
  biliModule.setup({
    config: () => cfg, lazy: () => null, log: { info() {}, debug() {}, warn() {} },
    on: (kind, fn) => events.set(kind, fn), tool: (fn) => builders.push(fn), every() {}, route() {},
    dataDir: (...parts) => dataDir('modules-data', 'bili', ...parts), onDispose() {},
    core: { hub },
  })
  const chat = { kind: 'private', userId: '10000001', chatId: 'private:10000001' }
  const tools = builders[1]({ chat, sessionId: 'owner' })
  const avatar = tools.find((t) => t.name === 'bili_set_avatar')
  assert.ok(avatar)
  assert.match((await avatar.execute({ image: 'last' })).message, /没人发过/)
  events.get('message')({ chatId: chat.chatId, images: [{ data: { url: 'https://image.example/owner.png' } }] })
  events.get('message')({ chatId: 'group:123', images: [{ data: { url: 'https://image.example/other.png' } }] })
  for (const image of ['last', '刚才那张图', '最近的图片']) {
    const r = await avatar.execute({ image })
    assert.equal(r.ok, true, r.message)
    assert.match(r.message, /试运行/)
    assert.match(r.message, /https:\/\/image\.example\/owner\.png/)
  }
  const explicit = await avatar.execute({ image: 'https://image.example/explicit.png' })
  assert.equal(explicit.ok, true)
  assert.match(explicit.message, /explicit\.png/)
  hub.chatOfSession = () => chat.chatId
  const restored = builders[1]({ chat: { ...chat, chatId: 'private:stale' }, sessionId: 'restored' }).find((t) => t.name === 'bili_set_avatar')
  assert.match((await restored.execute({ image: 'last' })).message, /owner\.png/, '使用会话映射的聊天图片，不串到其他聊天')
  assert.match((await avatar.execute({ image: '#1' })).message, /找不到画作|只能用网址图片/, '机器人没画过 #1 时明确说找不到')
  assert.equal((await avatar.execute({ image: 'C:\\private.png' })).ok, false)
  // 画过之后：#1 直接读存图文件，不再要求网址
  const { mkdtempSync, mkdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-bili-avatar-'))
  const prevData = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  mkdirSync(join(dir, 'imagegen'), { recursive: true })
  const { savePainting, rememberPainting } = await import('../src/features/paintings.js')
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)])
  rememberPainting(chat.chatId, savePainting(png, 'B站头像测试'))
  const byPainting = await avatar.execute({ image: '#1' })
  assert.equal(byPainting.ok, true, byPainting.message)
  assert.match(byPainting.message, /试运行/)
  if (prevData === undefined) delete process.env.AURABOT_DATA_DIR
  else process.env.AURABOT_DATA_DIR = prevData
  owner = false
  assert.equal((await avatar.execute({ image: 'last' })).ok, false, '执行时复查当前轮主人权限')
  assert.deepEqual(builders[1]({ chat: { ...chat, userId: '10000002', chatId: 'private:10000002' }, sessionId: 'guest' }), [])
  owner = true
  cfg.bili.enabled = false
  assert.equal((await avatar.execute({ image: 'last' })).ok, false, '已注册工具也复查开关')
})
