// 收表情：同一张重复收时不能白跑一次，提示也要说清楚「之前就收过了」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-addsticker-'))
// 每条用例换一个数据目录，互不干扰（dataDir() 每次都读这个环境变量）
const freshDir = () => { process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-addsticker-')) }

const { createStickerStore } = await import('../src/features/stickers.js')
const { normalize } = await import('../src/core/config.js')

function fakePng (salt = 0) {
  const b = Buffer.alloc(80)
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47
  b.writeUInt32BE(240, 16)
  b.writeUInt32BE(240, 20)
  b[40] = salt
  return b
}

function makeStore () {
  freshDir()
  const calls = []
  const cfg = normalize({ enabled: true, dryRun: false, ownerQQ: '10000001', stickers: { enabled: true, caption: false } })
  const onebot = { call: async (a, p) => { calls.push({ a, p }); return a === 'add_custom_face' ? { emoji_id: 'e1' } : {} } }
  const store = createStickerStore({ dsh: null, getConfig: () => cfg, onebot, log: { info () {}, warn () {}, debug () {} } })
  return { store, calls }
}

test('第一次收：正常入库，不带 existed', async () => {
  const { store } = makeStore()
  const r = await store.addFromBuffer(fakePng(1), { name: '新表情', tags: ['开心'], from: 'tool' })
  assert.equal(r.ok, true)
  assert.equal(Boolean(r.existed), false)
  assert.equal(store.library().items.length, 1)
  assert.equal(store.library().items[0].name, '新表情')
})

test('重复收同一张：existed=true，且不重复入库', async () => {
  const { store } = makeStore()
  const buf = fakePng(2)
  await store.addFromBuffer(buf, { name: '第一张', tags: ['开心'], from: 'tool' })
  const r = await store.addFromBuffer(buf, { name: '第一张', tags: ['开心'], from: 'tool' })
  assert.equal(r.ok, true)
  assert.equal(r.existed, true)
  assert.equal(store.library().items.length, 1, '库里还是一张')
  assert.equal(r.item.name, '第一张', '提示里能拿到名字')
})

test('重复收但这次给了名字/标签：把缺的补上，不算白跑', async () => {
  const { store } = makeStore()
  const buf = fakePng(3)
  // 模拟「她刚收到图时后台自动收了一张」——没有名字和标签
  await store.addFromBuffer(buf, { from: 'private:1' })
  assert.equal(store.library().items[0].name, '')

  const r = await store.addFromBuffer(buf, { name: '委屈巴巴', tags: ['委屈', '卖萌'], from: 'tool' })
  assert.equal(r.existed, true)
  assert.equal(r.touched, true, '应该标记补过了')
  const it = store.library().items[0]
  assert.equal(it.name, '委屈巴巴', '名字补上了')
  assert.deepEqual(it.tags, ['委屈', '卖萌'], '标签补上了')
})

test('重复收、库里已经有名字：不覆盖人家已有的名字', async () => {
  const { store } = makeStore()
  const buf = fakePng(4)
  await store.addFromBuffer(buf, { name: '原来的名字', tags: ['开心'], from: 'tool' })
  const r = await store.addFromBuffer(buf, { name: '新名字', tags: ['委屈'], from: 'tool' })
  assert.equal(r.existed, true)
  assert.equal(r.touched, false, '没什么可补的')
  assert.equal(store.library().items[0].name, '原来的名字')
  assert.deepEqual(store.library().items[0].tags, ['开心'])
})
