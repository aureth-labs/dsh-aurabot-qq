import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { normalize } from '../src/core/config.js'
import { createStickerStore } from '../src/features/stickers.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const base64 = 'base64://' + png.toString('base64')

function makeStore(t, addFace) {
  const old = process.env.AURABOT_DATA_DIR
  const root = mkdtempSync(join(tmpdir(), 'aurabot-sticker-face-'))
  process.env.AURABOT_DATA_DIR = root
  t.after(() => {
    if (old === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = old
    rmSync(root, { recursive: true, force: true })
  })
  const calls = []
  const cfg = normalize({ enabled: true, dryRun: false, stickers: { enabled: true, collect: true, caption: false } })
  const store = createStickerStore({
    dsh: null,
    getConfig: () => cfg,
    onebot: {
      async call(action, params) {
        calls.push([action, params])
        if (action === 'add_custom_face') return addFace(params.file)
      },
    },
    log: { info() {}, warn() {}, debug() {} },
  })
  return { store, calls }
}

function pathOnly(file) {
  if (file.startsWith('base64://')) throw new Error('ENAMETOOLONG: name too long, stat base64://x')
  assert.ok(isAbsolute(file))
  assert.deepEqual(readFileSync(file), png)
  return { emoji_id: 'e1' }
}

test('#502 手动收藏先传本地文件，并写入 QQ 备注', async (t) => {
  const { store, calls } = makeStore(t, pathOnly)
  const r = await store.addFromBuffer(png, { name: '测试' })
  assert.equal(r.ok, true)
  assert.equal(r.item.emojiId, 'e1')
  assert.deepEqual(calls.map(([action]) => action), ['add_custom_face', 'modify_custom_face'])
  assert.deepEqual(calls[1][1], { emoji_id: 'e1', desc: '测试' })
})

test('#502 自动收藏先传本地文件', async (t) => {
  const { store, calls } = makeStore(t, pathOnly)
  const r = await store.collect({ type: 'image', data: { file: base64 } }, 'private:1')
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.item.emojiId, 'e1')
  assert.deepEqual(calls.map(([action]) => action), ['add_custom_face'])
})

test('#502 网关读不到路径时保留本地表情，不改用 base64', async (t) => {
  const { store, calls } = makeStore(t, () => {
    throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
  })
  const r = await store.addFromBuffer(png)
  assert.equal(r.ok, true)
  assert.equal(store.library().items[0].emojiId, '')
  assert.equal(calls.length, 1)
  assert.ok(isAbsolute(calls[0][1].file))
  assert.deepEqual(readFileSync(calls[0][1].file), png)
})

test('#502 网关收藏超时保留本地表情', async (t) => {
  const { store, calls } = makeStore(t, () => { throw Object.assign(new Error('网关超时'), { uncertain: true }) })
  const r = await store.addFromBuffer(png)
  assert.equal(r.ok, true)
  assert.equal(store.library().items[0].emojiId, '')
  assert.equal(calls.length, 1)
  assert.deepEqual(readFileSync(calls[0][1].file), png)
})
