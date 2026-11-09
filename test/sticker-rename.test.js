// 表情改名：本地库和 QQ 收藏备注必须一起变（回归测试）。
// 曾经的现象：QQ 那边名字变了，面板/库里还是旧名字。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-sticker-'))

const { createStickerStore } = await import('../src/features/stickers.js')
const { normalize } = await import('../src/core/config.js')

function fakePng (w = 240, h = 240) {
  const b = Buffer.alloc(80)
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  return b
}

function makeStore () {
  const calls = []
  const cfg = normalize({
    enabled: true,
    dryRun: false,
    ownerQQ: '10000001',
    stickers: { enabled: true, collect: true, caption: false }, // caption 关掉，测改名就够了
  })
  const onebot = {
    call: async (action, params) => {
      calls.push({ action, params })
      if (action === 'add_custom_face') return { emoji_id: 'emoji-1' }
      return {}
    },
  }
  const log = { info () {}, warn () {}, debug () {} }
  const store = createStickerStore({ dsh: null, getConfig: () => cfg, onebot, log })
  return { store, calls }
}

test('表情改名：本地库落盘 + QQ 收藏备注同步', async () => {
  const { store, calls } = makeStore()
  const added = await store.addFromBuffer(fakePng(), { name: '旧名字', tags: ['开心'], from: 'tool' })
  assert.equal(added.ok, true)
  assert.equal(added.item.emojiId, 'emoji-1', '收下时拿到了 QQ 的 emoji_id')

  const renamed = store.rename(added.item.md5, '新名字')
  assert.equal(renamed.ok, true)
  assert.equal(renamed.item.name, '新名字')

  // 1) 重新从磁盘读，名字必须已经是新的（这才叫真的落盘了）
  const onDisk = store.library().items.find((i) => i.md5 === added.item.md5)
  assert.equal(onDisk.name, '新名字', '本地库文件里是旧名字 = bug')

  // 2) QQ 那边也要收到改名
  const qq = calls.filter((c) => c.action === 'modify_custom_face').at(-1)
  assert.ok(qq, '没有调用 modify_custom_face')
  assert.deepEqual(qq.params, { emoji_id: 'emoji-1', desc: '新名字' })
})

test('表情改名：只改标签时名字不动；名字超长截到 12 字', async () => {
  const { store } = makeStore()
  const added = await store.addFromBuffer(fakePng(200, 200), { name: '原名', tags: ['卖萌'], from: 'tool' })
  const t = store.rename(added.item.md5, undefined, ['委屈', '难过'])
  assert.equal(t.item.name, '原名', '没传新名字就不改名字')
  assert.deepEqual(t.item.tags, ['委屈', '难过'])

  const long = store.rename(added.item.md5, '一二三四五六七八九十十一十二十三')
  assert.equal(long.item.name.length, 12, '超过 12 个字要截断')
  assert.equal(store.library().items.find((i) => i.md5 === added.item.md5).name.length, 12)
})

test('表情改名：库里没有这张时明确失败，不瞎改', async () => {
  const { store } = makeStore()
  const r = store.rename('不存在的md5', '新名字')
  assert.equal(r.ok, false)
})
