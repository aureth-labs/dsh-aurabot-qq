// 记忆的两个面板配置：常驻上限、私人记忆优先。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-memory-settings-'))

const { normalize } = await import('../src/core/config.js')
const { createMemoryStore } = await import('../src/features/memory.js')

const owner = '10000001'
const log = { info () {}, warn () {}, debug () {} }
const mk = (memory = {}) => normalize({ enabled: true, ownerQQ: owner, memory: { enabled: true, recallCount: 4, ...memory } })
const store = (cfg) => createMemoryStore({ dsh: null, getConfig: () => cfg, hub: null, log })

test('配置：常驻上限默认 1200、范围 200~4000；私人记忆优先默认开', () => {
  const c = normalize({})
  assert.equal(c.memory.residentMaxChars, 1200)
  assert.equal(c.memory.preferPersonal, true)
  assert.equal(normalize({ memory: { residentMaxChars: 50 } }).memory.residentMaxChars, 200)
  assert.equal(normalize({ memory: { residentMaxChars: 99999 } }).memory.residentMaxChars, 4000)
  assert.equal(normalize({ memory: { preferPersonal: false } }).memory.preferPersonal, false)
})

test('常驻记忆按面板上限截断，默认比旧的 600 更宽', () => {
  const mem = store(mk({ residentMaxChars: 250 }))
  mem.setStyle('qq:' + owner, ['第一条很长的说话方式'.repeat(5), '第二条很长的说话方式'.repeat(5), '第三条很长的说话方式'.repeat(5)])
  mem.setInsights('qq:' + owner, ['第一条很长的相处经验'.repeat(5), '第二条很长的相处经验'.repeat(5)])
  const ctx = mem.contextFor({ kind: 'private', userId: owner, chatId: 'private:' + owner }, 's1')
  assert.ok(ctx.length <= 251, '应该按 250 字截断，实际 ' + ctx.length)
  assert.ok(ctx.endsWith('…'))
})

test('私人记忆优先：没在问 B站时先私人；问具体 B站视频仍以视频为准', () => {
  const mem = store(mk({ preferPersonal: true }))
  mem.add({ text: '白恒aead和白米饭约定：晚上吃白米饭', about: owner, aboutName: '白恒aead', source: 'auto', importance: 1 })
  mem.add({ text: '在B站看了《白米饭的一百种做法》视频，做法很简单', source: 'event', importance: 1 })

  // 模糊问题：私人记忆先出来
  const vague = mem.recall('你还记得我们之前说好什么吗', { about: owner, limit: 2 })
  assert.match(vague[0].it.text, /约定/)

  // 明确问 B站视频：相关度高的视频仍然优先，不被私人记忆无条件压过
  const bili = mem.recall('B站 视频 做法', { about: owner, limit: 2 })
  assert.match(bili[0].it.text, /B站看了/)
  const off = mem.recall('B站 视频 做法', { about: owner, limit: 2, preferPersonal: false })
  assert.match(off[0].it.text, /B站看了/)
})

test('问约定/说好时，明确的约定排在空间日记前面', () => {
  const mem = store(mk({ preferPersonal: true }))
  mem.add({ text: '我在 QQ 空间写过：说好今天一起看番，晚饭吃白米饭。', source: 'diary', importance: 1 })
  mem.add({ text: '白恒aead和大肥鱼约定：熬夜时十二点前必须躺下。', about: owner, aboutName: '白恒aead', source: 'auto', importance: 0.8 })

  const hits = mem.recall('你还记得我们之前说好什么吗', { about: owner, limit: 5 })
  assert.match(hits[0].it.text, /约定/)
  assert.equal(hits.some((h) => /空间写过/.test(h.it.text)), true)
})
