import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHub } from '../src/chat/hub.js'
import { normalize, mergeFromPanel } from '../src/core/config.js'
import { rulesText } from '../src/persona/personas.js'

const item = { name: '开心', md5: '1234567890abcdef' }
function setup(t, patch = {}, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-sticker-probability-'))
  const old = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const cfg = normalize({ enabled: true, dryRun: false, workspaceDir: dir,
    chat: { bubbleMinMs: 0, bubbleMaxMs: 0 }, voice: { enabled: false },
    stickers: { enabled: true, limitTagged: true, autoChance: 0 }, ...patch })
  let draws = 0, picks = 0
  const calls = [], logs = []
  const hub = createHub({ dsh: {}, getConfig: () => cfg,
    random: () => { draws++; return options.roll ?? 0.5 },
    moodEffects: () => ({ sticker: options.mood ?? 1, voice: 1, delay: 0, chatty: 1 }),
    hooks: options.hooks,
    log: Object.fromEntries(['info', 'debug', 'warn', 'error'].map(k => [k, (...args) => logs.push(args.join(' '))])),
    onebot: { async call(action, params) { calls.push({ action, params }); return { message_id: calls.length } } },
    stickers: { match: () => item, pickForReply: () => { picks++; return item }, markUsed() {},
      segmentFor: () => ({ type: 'image', data: { file: 'base64://test', sub_type: 1 } }) } })
  t.after(() => { hub.dispose(); if (old === undefined) delete process.env.AURABOT_DATA_DIR; else process.env.AURABOT_DATA_DIR = old; rmSync(dir, { recursive: true, force: true }) })
  return { cfg, hub, calls, logs, draws: () => draws, picks: () => picks,
    segments: () => calls.flatMap(c => c.params.message || []) }
}
const images = s => s.segments().filter(x => x.type === 'image')
const words = s => s.segments().filter(x => x.type === 'text').map(x => x.data.text).join('')

test('升级默认不拦标签；面板保存新开关不改其他配置', () => {
  const before = normalize({ stickers: { autoChance: 0 }, persona: 'test' })
  assert.equal(before.stickers.limitTagged, false)
  const after = mergeFromPanel(before, { stickers: { limitTagged: true } })
  assert.deepEqual(after, { ...before, stickers: { ...before.stickers, limitTagged: true } })
  assert.equal(normalize({ stickers: { limitTagged: 'false' } }).stickers.limitTagged, false)
})
for (const chat of ['private:1', 'group:2']) test(`${chat}：0% 去掉所有标签，只发正文，标签不泄漏`, async t => {
  const s = setup(t, {}, { roll: 0 })
  await s.hub.deliver(chat, '今天真开心<sticker:开心>|||<sticker:卖萌>', { autoReply: { mid: '9', uid: '3' } })
  assert.equal(images(s).length, 0)
  assert.equal(words(s).trim(), '今天真开心')
  assert.equal(s.picks(), 0)
  assert.equal(s.draws(), 1)
  if (chat.startsWith('group:')) {
    assert.ok(s.segments().some(x => x.type === 'reply' && String(x.data.id) === '9'))
    assert.ok(s.segments().some(x => x.type === 'at' && String(x.data.qq) === '3'))
  }
})

test('被拦的标签不会挤掉群回复正文，也不会被自动补图重新抽中', async t => {
  const s = setup(t, { stickers: { limitTagged: true, autoChance: 0.4 } })
  await s.hub.deliver('group:2', '<sticker:开心>|||<sticker:卖萌>|||<sticker:委屈>|||今天真开心')
  assert.equal(words(s).trim(), '今天真开心')
  assert.equal(images(s).length, 0); assert.equal(s.draws(), 1); assert.equal(s.picks(), 0)
})

test('100% 放行标签，即使心情倍率为 0；不会额外补一张', async t => {
  const s = setup(t, { stickers: { limitTagged: true, autoChance: 1 } }, { mood: 0, roll: 0.999 })
  await s.hub.deliver('private:1', '你好呀<sticker:开心>', { simulate: true })
  assert.equal(images(s).length, 1); assert.equal(s.picks(), 0); assert.equal(s.draws(), 1)
})
for (const roll of [0.249, 0.25, 0.8]) test(`25% 用一次抽样决定标签和自动补图（${roll}）`, async t => {
  const s = setup(t, { stickers: { limitTagged: true, autoChance: 0.25 } }, { roll, mood: 100 })
  await s.hub.deliver('private:1', '你好呀<sticker:开心>', { simulate: true })
  await s.hub.deliver('private:1', '今天真开心', { simulate: true })
  assert.equal(images(s).length, roll < 0.25 ? 2 : 0)
  assert.equal(s.draws(), 2)
})

test('扩展在 items 阶段加回表情也用同一次抽样，正文照留', async t => {
  const s = setup(t, {}, { hooks: { items: items => [...items, { kind: 'sticker', value: item }] } })
  await s.hub.deliver('private:1', '你好呀<sticker:开心>')
  assert.equal(images(s).length, 0); assert.equal(words(s).trim(), '你好呀'); assert.equal(s.draws(), 1)
})

test('只有表情被拦时安静结束，下一次正常回复不受影响', async t => {
  const s = setup(t)
  await s.hub.deliver('private:1', '<sticker:开心>')
  assert.equal(s.calls.length, 0)
  await s.hub.deliver('private:1', '今天真开心')
  assert.equal(words(s).trim(), '今天真开心')
})

test('关闭新限制保持旧行为：0% 标签照发，自动补图仍不发', async t => {
  const s = setup(t, { stickers: { limitTagged: false, autoChance: 0 } })
  await s.hub.deliver('private:1', '<sticker:开心>')
  await s.hub.deliver('private:1', '今天真开心')
  assert.equal(images(s).length, 1); assert.equal(s.picks(), 0)
})

test('旧自动补图仍受心情影响；开启新限制后不再叠加', async t => {
  const s = setup(t, { stickers: { limitTagged: false, autoChance: 1 } }, { mood: 0 })
  await s.hub.deliver('private:1', '今天真开心')
  assert.equal(images(s).length, 0)
  s.cfg.stickers.limitTagged = true
  await s.hub.deliver('private:1', '今天真开心', { simulate: true })
  assert.equal(images(s).length, 1)
})

test('单独发表情工具、普通图片和 QQ 小黄脸不受回复配图限制', async t => {
  const s = setup(t)
  assert.equal(await s.hub.sendSticker('private:1', '开心'), true)
  await s.hub.sendSegments('private:1', [{ type: 'image', data: { file: 'base64://ordinary' } }], '[图片]')
  await s.hub.deliver('private:1', '你好呀<face:微笑><sticker:开心>')
  assert.equal(images(s).length, 2)
  assert.ok(s.segments().some(x => x.type === 'face'))
  assert.ok(!words(s).includes('<'))
})

test('表情总开关和试运行原有约束照常生效', async t => {
  const s = setup(t, { stickers: { enabled: false, limitTagged: true, autoChance: 1 } })
  await s.hub.deliver('private:1', '<sticker:开心>')
  assert.equal(await s.hub.sendSticker('private:1', '开心'), false)
  assert.equal(images(s).length, 0)
  s.cfg.stickers.enabled = true; s.cfg.dryRun = true
  await s.hub.deliver('private:1', '<sticker:开心>')
  assert.equal(images(s).length, 0)
})

test('规则只在功能开启时解释限流，不让模型用工具补发绕过', () => {
  const cfg = normalize({ stickers: { limitTagged: true } })
  assert.match(rulesText('private', cfg), /不要为了补发而调用工具/)
  assert.match(rulesText('private', cfg), /明确索要表情时才用 qq_send_sticker/)
  assert.doesNotMatch(rulesText('private', cfg, { off: new Set(['stickers']) }), /回复附带的表情会按设置概率/)
  cfg.stickers.enabled = false
  assert.doesNotMatch(rulesText('private', cfg), /回复附带的表情会按设置概率/)
})

test('删掉表情不会让原本的文字意外触发自动语音', async t => {
  const s = setup(t, { voice: { enabled: true, autoChance: 1, autoMaxChars: 300 } })
  await s.hub.deliver('private:1', '今天真开心<sticker:开心>')
  assert.equal(words(s).trim(), '今天真开心')
  assert.ok(!s.segments().some(x => x.type === 'record'))
})

test('分条发送的中间段也限制标签，但仍不自动补图', async t => {
  const s = setup(t)
  await s.hub.deliver('private:1', '今天真开心<sticker:开心>', { interim: true })
  assert.equal(images(s).length, 0); assert.equal(words(s).trim(), '今天真开心')
  s.cfg.stickers.autoChance = 1
  await s.hub.deliver('private:1', '你好呀', { interim: true })
  assert.equal(images(s).length, 0); assert.equal(s.picks(), 0)
})


test('关闭限制后，承诺配图的正文与对应表情一起发送，保留原概率', async t => {
  const s = setup(t, { stickers: { limitTagged: false, autoChance: 0.03 } }, { roll: 0.99 })
  await s.hub.deliver('group:2', '我发的都是正经表情\n正经点是吧，行，看我给你整一个端庄版<sticker:无语>', { simulate: true })
  assert.ok(words(s).includes('看我给你整一个端庄版'))
  assert.equal(images(s).length, 1)
  assert.equal(s.cfg.stickers.autoChance, 0.03)
})

test('实验豁免命中正文时不抽概率、不额外补图，原案例可发完整', async t => {
  const s = setup(t, { stickers: { limitTagged: true, keywordExemption: true, autoChance: 0 } }, { roll: 0.99 })
  await s.hub.deliver('group:2', '我发的都是正经表情\n正经点是吧，行，看我给你整一个端庄版<sticker:无语>', { simulate: true, autoReply: { mid: '9', uid: '3' } })
  assert.ok(words(s).includes('看我给你整一个端庄版'))
  assert.equal(images(s).length, 1); assert.equal(s.draws(), 0); assert.equal(s.picks(), 0)
  assert.ok(s.segments().some(x => x.type === 'reply' && String(x.data.id) === '9'))
})

test('实验豁免没命中仍按原概率；标签名和用户消息不能冒充正文关键词', async t => {
  const s = setup(t, { stickers: { limitTagged: true, keywordExemption: true, autoChance: 0.03 } }, { roll: 0.99 })
  await s.hub.deliver('private:1', '你好呀<sticker:一张表情图>', { userText: '给你看一张图', simulate: true })
  assert.equal(images(s).length, 0); assert.equal(words(s).trim(), '你好呀'); assert.equal(s.draws(), 1)
})

test('正文提图但没选表情时，不强行补图；自动补图仍按原概率', async t => {
  const s = setup(t, { stickers: { limitTagged: true, keywordExemption: true, autoChance: 0.03 } }, { roll: 0.99 })
  await s.hub.deliver('private:1', '地图怎么打开', { simulate: true })
  assert.equal(images(s).length, 0); assert.equal(s.picks(), 0); assert.equal(s.draws(), 1)
})

test('动态关闭实验开关恢复严格概率，关闭总限制恢复标签直发', async t => {
  const s = setup(t, { stickers: { limitTagged: true, keywordExemption: true, autoChance: 0 } })
  const body = '给你看看<sticker:开心>'
  await s.hub.deliver('private:1', body, { simulate: true }); assert.equal(images(s).length, 1)
  s.cfg.stickers.keywordExemption = false
  await s.hub.deliver('private:1', body, { simulate: true }); assert.equal(images(s).length, 1)
  s.cfg.stickers.limitTagged = false; s.cfg.stickers.keywordExemption = true
  await s.hub.deliver('private:1', '你好呀<sticker:开心>', { simulate: true }); assert.equal(images(s).length, 2)
})

test('扩展追加表情按最终正文判断关键词；没有词仍不放行', async t => {
  const s = setup(t, { stickers: { limitTagged: true, keywordExemption: true, autoChance: 0 } }, { hooks: { items: items => [...items, { kind: 'sticker', value: item }] } })
  await s.hub.deliver('private:1', '给你看看', { simulate: true }); assert.equal(images(s).length, 1)
  await s.hub.deliver('private:1', '你好呀', { simulate: true }); assert.equal(images(s).length, 1)
})

test('实验豁免不能绕过表情总开关或试运行', async t => {
  const s = setup(t, { stickers: { enabled: false, limitTagged: true, keywordExemption: true, autoChance: 0 } })
  await s.hub.deliver('private:1', '给你看看<sticker:开心>', { simulate: true }); assert.equal(images(s).length, 0)
  s.cfg.stickers.enabled = true; s.cfg.dryRun = true
  await s.hub.deliver('private:1', '给你看看<sticker:开心>'); assert.equal(images(s).length, 0)
})


test('中间段也识别本段关键词，命中只保留模型选好的表情', async t => {
  const s = setup(t, { stickers: { limitTagged: true, keywordExemption: true, autoChance: 0 } })
  await s.hub.deliver('private:1', '给你看看<sticker:开心>', { interim: true, simulate: true })
  assert.equal(images(s).length, 1); assert.equal(s.draws(), 0); assert.equal(s.picks(), 0)
})

for (const chatId of ['private:1', 'group:2']) test(`${chatId}：实验模式下两张纯表情完整发送，不抽概率也不补图`, async t => {
  const s = setup(t, { stickers: { limitTagged: true, keywordExemption: true, autoChance: 0 } }, { roll: 0.99 })
  await s.hub.deliver(chatId, '<sticker:开心> ||| <sticker:委屈>', { simulate: true })
  assert.equal(images(s).length, 2); assert.equal(words(s), ''); assert.equal(s.draws(), 0); assert.equal(s.picks(), 0)
  assert.ok(!s.logs.some(line => line.includes('选择不说话')))
  s.cfg.stickers.keywordExemption = false
  await s.hub.deliver(chatId, '<sticker:开心> ||| <sticker:委屈>', { simulate: true })
  assert.equal(images(s).length, 2); assert.equal(s.draws(), 1)
  assert.ok(s.logs.some(line => line.includes('表情被概率过滤')))
  assert.ok(!s.logs.some(line => line.includes('选择不说话')))
})

test('纯表情豁免不绕过总开关、试运行和群消息条数限制', async t => {
  const s = setup(t, { stickers: { enabled: false, limitTagged: true, keywordExemption: true, autoChance: 0 } })
  const body = '<sticker:开心> ||| <sticker:委屈>'
  await s.hub.deliver('private:1', body, { simulate: true }); assert.equal(images(s).length, 0)
  s.cfg.stickers.enabled = true; s.cfg.dryRun = true
  await s.hub.deliver('private:1', body, { simulate: true }); assert.equal(images(s).length, 0)
  s.cfg.dryRun = false
  await s.hub.deliver('group:2', body + '|||<sticker:开心>|||<sticker:开心>', { simulate: true })
  assert.equal(images(s).length, 3)
})


test('自动补图开关默认兼容旧配置，保存不改变表情节流与收藏设置', () => {
  const before = normalize({ stickers: { autoChance: 0.03, limitTagged: true, collect: true } })
  assert.equal(before.stickers.autoAppend, true)
  const after = mergeFromPanel(before, { stickers: { autoAppend: false } })
  assert.deepEqual(after, { ...before, stickers: { ...before.stickers, autoAppend: false } })
  assert.equal(normalize({ stickers: { autoAppend: false } }).stickers.autoAppend, false)
})

for (const chat of ['private:1', 'group:2']) test(`${chat}：关闭自动补图后，100% 抽中也不替纯文字配图`, async t => {
  const s = setup(t, { stickers: { autoAppend: false, limitTagged: true, autoChance: 1 } }, { roll: 0 })
  await s.hub.deliver(chat, '说明已经完整，不需要配图')
  assert.equal(images(s).length, 0)
  assert.equal(s.picks(), 0)
  assert.equal(s.draws(), 0)
  assert.match(words(s), /说明已经完整/)
})

test('关闭自动补图不拦明确选出的标签；标签仍按既有概率开关处理', async t => {
  const s = setup(t, { stickers: { autoAppend: false, limitTagged: true, autoChance: 1 } }, { roll: 0.5 })
  await s.hub.deliver('private:1', '<sticker:开心>')
  assert.equal(images(s).length, 1)
  s.cfg.stickers.autoChance = 0
  await s.hub.deliver('private:1', '文字<sticker:开心>')
  assert.equal(images(s).length, 1)
  s.cfg.stickers.limitTagged = false
  await s.hub.deliver('private:1', '<sticker:开心>')
  assert.equal(images(s).length, 2)
  assert.equal(s.picks(), 0)
})

test('关闭自动补图不影响明确索要时的 sendSticker 单独发送', async t => {
  const s = setup(t, { stickers: { autoAppend: false, limitTagged: true, autoChance: 0 } })
  assert.ok(await s.hub.sendSticker('private:1', '开心'))
  assert.equal(images(s).length, 1)
})
