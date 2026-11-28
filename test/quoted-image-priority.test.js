import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHub } from '../src/chat/hub.js'
import { normalize } from '../src/core/config.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const BOT = '20000002', USER = '10000001', GROUP = '30000003'
const png = n => {
  const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])
  bytes[40] = n
  return bytes.toString('base64')
}
const image = n => ({ type: 'image', data: { file: 'base64://' + png(n) } })

function fixture(t, { merge = false, overrides = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-quote-priority-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const cfg = normalize({ enabled: true, dryRun: true, setupDone: true, botQQ: BOT, ownerQQ: USER,
    workspaceDir: join(dir, 'workspace'), allow: { groups: [GROUP] }, voice: { enabled: false },
    merge: { enabled: merge, groupWaitSec: 0.05, groupMaxSec: 0.1 }, titleFilter: { enabled: false },
    stickers: { collect: false }, ...overrides })
  let captured
  const downloads = [], fake = createFakeDsh({ brain: async () => '[沉默]' })
  const admit = fake.ctx.attachments.admitPromptContent
  fake.ctx.attachments.admitPromptContent = content => { captured = content; return admit(content) }
  const quotes = new Map(Array.from({ length: 12 }, (_, i) => [String(i + 1), [image(i + 1)]]))
  const hub = createHub({ dsh: fake.ctx, getConfig: () => cfg,
    log: { info() {}, warn() {}, debug() {}, error() {} }, stickers: {},
    onebot: { connected: true, async call(action, params) {
      if (action === 'get_group_info') return { group_name: '测试群' }
      if (action === 'get_msg') return { group_id: GROUP, sender: { user_id: USER, nickname: '甲' }, message: quotes.get(String(params.message_id)) || [] }
      if (action === 'get_image') { downloads.push(params.file); throw Error('missing fixture image') }
      return {}
    } },
    hooks: { groupDecide: (_decision, { msg }) => ({ reply: msg.mentioned || msg.text === '名字唤醒', mode: 'must' }) },
  })
  fake.ctx.effect(() => fake.ctx.on('session/event', hub.onSessionEvent))
  t.after(() => {
    hub.dispose(); fake.dispose()
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR; else process.env.AURABOT_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  let mid = 100
  async function send(quote, { direct = false, named = false, images = [] } = {}) {
    await hub.onMessage({ message_type: 'group', self_id: BOT, user_id: USER, group_id: GROUP, message_id: ++mid,
      sender: { nickname: '甲' }, message: [
        ...(quote ? [{ type: 'reply', data: { id: String(quote) } }] : []),
        ...(direct ? [{ type: 'at', data: { qq: BOT } }] : []),
        { type: 'text', data: { text: named ? '名字唤醒' : direct ? '看看引用图片' : '背景聊天' } }, ...images,
      ] })
  }
  async function result() {
    const deadline = Date.now() + 4000
    while (!captured && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(captured, 'the input should reach DSH')
    return captured.filter(x => x.type === 'image').map(x => x.data)
  }
  return { send, result, quotes, downloads }
}

test('current quoted image is not displaced by four earlier quoted images', async t => {
  const f = fixture(t)
  for (const id of [1, 2, 3, 4]) await f.send(id)
  await f.send(5, { direct: true })
  assert.deepEqual(await f.result(), [5, 4, 3, 2].map(png))
})

test('a name wake uses the recent quoted image before older background quotes', async t => {
  const f = fixture(t)
  for (const id of [1, 2, 3, 4]) await f.send(id)
  await f.send(5, { named: true })
  assert.deepEqual(await f.result(), [5, 4, 3, 2].map(png))
})

test('later background quotes cannot displace the direct request in a merged batch', async t => {
  const f = fixture(t, { merge: true })
  await f.send(1, { direct: true })
  for (const id of [2, 3, 4, 5]) await f.send(id)
  assert.deepEqual(await f.result(), [1, 5, 4, 3].map(png))
})

test('multiple direct requests are selected newest first without repeating the same quoted image', async t => {
  const f = fixture(t, { merge: true })
  await f.send(1)
  await f.send(2, { direct: true })
  await f.send(3, { direct: true })
  await f.send(3, { direct: true })
  await f.send(4)
  assert.deepEqual(await f.result(), [3, 2, 4, 1].map(png))
})

test('direct attachments retain their slots and the requested quote uses the remaining slot', async t => {
  const f = fixture(t)
  for (const id of [1, 2, 3, 4]) await f.send(id)
  await f.send(5, { direct: true, images: [image(8), image(9), image(10)] })
  assert.deepEqual(await f.result(), [8, 9, 10, 5].map(png))
})

test('photo order stays intact, with a maximum of two images per quote', async t => {
  const f = fixture(t)
  f.quotes.set('5', [image(5), image(6), image(7)])
  await f.send(1)
  await f.send(2)
  await f.send(5, { direct: true })
  assert.deepEqual(await f.result(), [5, 6, 2, 1].map(png))
})

test('a quoted sticker has the same priority as a quoted photo', async t => {
  const f = fixture(t)
  f.quotes.set('5', [{ ...image(5), data: { ...image(5).data, sub_type: 1 } }])
  for (const id of [1, 2, 3, 4]) await f.send(id)
  await f.send(5, { direct: true })
  assert.deepEqual(await f.result(), [5, 4, 3, 2].map(png))
})

test('failed requested image does not consume the remaining image slots', async t => {
  const f = fixture(t)
  f.quotes.set('5', [{ type: 'image', data: { file: 'unavailable.png' } }])
  for (const id of [1, 2, 3, 4]) await f.send(id)
  await f.send(5, { direct: true })
  assert.deepEqual(await f.result(), [4, 3, 2, 1].map(png))
  assert.ok(f.downloads.includes('unavailable.png'))
})
