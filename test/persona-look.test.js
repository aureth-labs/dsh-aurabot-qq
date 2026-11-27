// 人设图存储与视觉解析：隔离数据目录，不请求真实模型。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'

const previous = process.env.AURABOT_DATA_DIR
const root = mkdtempSync(join(tmpdir(), 'aurabot-look-'))
process.env.AURABOT_DATA_DIR = root
const { readLook, lookImage, lookReferences, configureLookImage, lookMime, saveLookImage, deleteLookImage, saveAppearance, appearanceBlock, describeLook, MAX_LOOK_BYTES } = await import('../src/persona/persona-look.js')
const { savePersona, deletePersona, resolvePersonaId } = await import('../src/persona/personas.js')
const { clearVisionCache } = await import('../src/core/llm.js')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
after(() => {
  if (previous === undefined) delete process.env.AURABOT_DATA_DIR
  else process.env.AURABOT_DATA_DIR = previous
  rmSync(root, { recursive: true, force: true })
})

test('独立存图、描述、换图标记、删图保留文字、删人格清理', () => {
  savePersona('look-test', { body: '测试角色' })
  assert.equal(appearanceBlock('look-test'), '')
  assert.equal(lookImage('look-test'), null)
  const first = saveLookImage('look-test', png)
  assert.equal(first.hasImage, true)
  assert.equal(first.stale, true)
  assert.deepEqual(lookImage('look-test'), png)
  const described = saveAppearance('look-test', '蓝色短发', 'vision')
  assert.equal(described.source, 'vision')
  assert.equal(described.stale, false)
  assert.ok(described.appearanceAt > 0)
  assert.match(appearanceBlock('look-test'), /蓝色短发/)
  assert.equal(saveLookImage('look-test', png).stale, false)
  const changed = saveLookImage('look-test', Buffer.concat([png, Buffer.from([0])]))
  assert.equal(changed.stale, true)
  assert.notEqual(changed.imageHash, first.imageHash)
  assert.equal(deleteLookImage('look-test').appearance, '蓝色短发')
  assert.equal(lookImage('look-test'), null)
  saveLookImage('look-test', png)
  deletePersona('look-test')
  for (const ext of ['md', 'look.img', 'look.json']) assert.equal(existsSync(join(root, 'personas', `look-test.${ext}`)), false)
})

test('输入边界、魔数与描述长度', () => {
  savePersona('limits', { body: '测试' })
  for (const id of ['', '../limits', 'limits/..', 'a'.repeat(41), null]) {
    assert.throws(() => readLook(id), /id/)
    assert.throws(() => saveLookImage(id, png), /id/)
  }
  assert.throws(() => saveLookImage('missing', png), /先保存/)
  for (const buf of [null, Buffer.alloc(0), Buffer.from('not an image'), Buffer.alloc(MAX_LOOK_BYTES + 1)]) assert.throws(() => saveLookImage('limits', buf))
  assert.equal(lookMime(Buffer.from([255, 216, 255])), 'image/jpeg')
  assert.equal(lookMime(Buffer.from('GIF89a')), 'image/gif')
  assert.equal(lookMime(Buffer.from('RIFF0000WEBP')), 'image/webp')
  assert.throws(() => lookMime(Buffer.from('<svg></svg>')))
  assert.equal(saveAppearance('limits', '字'.repeat(2500)).appearance.length, 2000)
  assert.throws(() => saveAppearance('limits', null), /文字/)
  saveAppearance('limits', '')
  assert.equal(appearanceBlock('limits'), '')
  assert.equal(resolvePersonaId('limits'), 'limits')
  assert.ok(resolvePersonaId('missing'))
})

test('多图新增、单张替换删除、上限与旧单图无损兼容', () => {
  const id = 'multi'
  savePersona(id, { body: '多图角色' })
  const legacy = join(root, 'personas', id + '.look.img')
  writeFileSync(legacy, png)
  writeFileSync(join(root, 'personas', id + '.look.json'), JSON.stringify({ appearance: '旧描述', source: 'vision' }))
  assert.equal(readLook(id).images[0].id, 'legacy')
  assert.deepEqual(readFileSync(legacy), png, '只读兼容不改原图')
  const second = Buffer.concat([png, Buffer.from([1])])
  let look = saveLookImage(id, second, { append: true })
  assert.equal(look.images.length, 2)
  assert.equal(look.appearance, '旧描述')
  const secondId = look.images[1].id
  const before = look.imageHash
  const replaced = Buffer.concat([png, Buffer.from([2])])
  look = saveLookImage(id, replaced, { imageId: secondId })
  assert.equal(look.images[1].id, secondId)
  assert.notEqual(look.imageHash, before)
  assert.deepEqual(lookImage(id), png)
  assert.deepEqual(lookImage(id, secondId), replaced)
  assert.throws(() => saveLookImage(id, png), /选择/)
  assert.throws(() => deleteLookImage(id), /选择/)
  assert.throws(() => lookImage(id, '../multi'), /id/)
  assert.throws(() => deleteLookImage(id, '0'.repeat(32)), /不存在/)
  look = deleteLookImage(id, 'legacy')
  assert.equal(look.images.length, 1)
  assert.equal(look.stale, true)
  assert.equal(existsSync(legacy), false)
  assert.deepEqual(lookImage(id), replaced, '删除第一张后取剩余首图')
  for (let i = 1; i < 8; i++) look = saveLookImage(id, png, { append: true })
  assert.equal(look.images.length, 8)
  assert.throws(() => saveLookImage(id, png, { append: true }), /最多 8/)
  saveLookImage(id, second, { imageId: secondId })
  assert.equal(readLook(id).images.length, 8, '达到上限仍可替换')
  deletePersona(id)
  assert.equal(readdirSync(join(root, 'personas')).some((name) => name.startsWith(id + '.')), false)
})

test('逐图参考默认开启、备注独立保存、替换保留设置、关闭后不读取图片', () => {
  const id = 'settings'
  savePersona(id, { body: '测试' })
  let look = saveLookImage(id, png, { append: true })
  const first = look.images[0].id
  look = saveLookImage(id, png, { append: true })
  const second = look.images[1].id
  assert.equal(look.images.every((item) => item.reference), true)
  configureLookImage(id, first, { reference: false, note: '工作服' })
  configureLookImage(id, second, { note: '常服' })
  assert.deepEqual(lookReferences(id).map((item) => item.note), ['常服'])
  const replaced = saveLookImage(id, Buffer.concat([png, Buffer.from([3])]), { imageId: first })
  assert.equal(replaced.images[0].reference, false)
  assert.equal(replaced.images[0].note, '工作服')
  assert.equal(configureLookImage(id, second, { note: '字'.repeat(130) }).images[1].note.length, 120)
  assert.throws(() => configureLookImage(id, first, { reference: 'false' }), /布尔/)
  assert.throws(() => configureLookImage(id, '../bad', { note: 'x' }), /id/)
  assert.throws(() => configureLookImage(id, first, { note: {} }), /文字/)
  configureLookImage(id, second, { reference: false })
  assert.deepEqual(lookReferences(id), [])
  deletePersona(id)
})

test('视觉解析返回文字但不保存，支持独立模型与无视觉分支', async () => {
  clearVisionCache()
  const fake = createFakeDsh({ brain: async () => '' })
  let request
  let admitted
  fake.ctx.attachments.admitPromptContent = async (content) => { admitted = content; return content }
  fake.ctx.llm.resolveModelInfo = async () => ({ inputModalities: ['text', 'image'] })
  fake.ctx.llm.stream = async function* (r) { request = r; yield { type: 'text-delta', text: '银色长发，蓝色眼睛。' } }
  const cfg = { model: { provider: 'fake', model: 'chat', vision: 'off' }, personaLook: { visionModel: { provider: 'fake', model: 'vision' } } }
  assert.equal(await describeLook({ dsh: fake.ctx, cfg, buf: png }), '银色长发，蓝色眼睛。')
  assert.equal(request.model, 'vision')
  assert.equal(admitted[1].data, png.toString('base64'))
  assert.equal(admitted[1].mediaType, 'image/png')
  await describeLook({ dsh: fake.ctx, cfg, buffers: [png, png] })
  assert.equal(admitted.filter((item) => item.type === 'image').length, 2)
  await assert.rejects(describeLook({ dsh: fake.ctx, cfg, buffers: [] }), /1–8/)
  await assert.rejects(describeLook({ dsh: fake.ctx, cfg, buffers: Array(9).fill(png) }), /1–8/)
  assert.equal(readLook('limits').appearance, '')
  await assert.rejects(describeLook({ dsh: fake.ctx, cfg: { model: cfg.model }, buf: png }), /不支持看图/)
  clearVisionCache()
  fake.ctx.llm.resolveModelInfo = async () => ({ inputModalities: ['text'] })
  await assert.rejects(describeLook({ dsh: fake.ctx, cfg, buf: png }), /不支持看图/)
  clearVisionCache()
  fake.ctx.llm.resolveModelInfo = async () => ({ inputModalities: ['image'] })
  fake.ctx.llm.stream = async function* () {}
  await assert.rejects(describeLook({ dsh: fake.ctx, cfg, buf: png }), /没有返回/)
  fake.dispose()
})
