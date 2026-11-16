import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseReply } from '../src/chat/reply.js'
import { createHub } from '../src/chat/hub.js'
import { normalize } from '../src/core/config.js'

const raw = '<voice>今晚聊得挺热闹，谢谢捧场|||晚安，做个好梦</voice>'
const spoken = '今晚聊得挺热闹，谢谢捧场\n晚安，做个好梦'

test('完整语音块里的气泡分隔符作为停顿，不拆断语音标签', () => {
  assert.deepEqual(parseReply(raw).items, [{ kind: 'voice', value: spoken }])
  for (const separator of ['|||', '||||', '|||||']) {
    assert.deepEqual(parseReply(`<voice>甲${separator}乙${separator}丙</voice>`).items,
      [{ kind: 'voice', value: '甲\n乙\n丙' }])
  }
})

test('语音外分条、多个语音块、引用和其他媒体保持原有顺序', () => {
  assert.deepEqual(parseReply(`前文|||<reply:2>${raw}|||<voice>再见</voice>|||后文|||<sticker:晚安>`).items, [
    { kind: 'text', value: '前文' }, { kind: 'voice', value: spoken, replyTo: '2' },
    { kind: 'voice', value: '再见' }, { kind: 'text', value: '后文' }, { kind: 'sticker', value: '晚安' },
  ])
  assert.deepEqual(parseReply('<voice>A | B || C</voice>').items, [{ kind: 'voice', value: 'A | B || C' }])
  assert.deepEqual(parseReply('<voice>甲\n乙</voice>').items, [{ kind: 'voice', value: '甲\n乙' }])
})

test('代码里的voice标签不因修复变成语音，代码后真实的语音仍能解析', () => {
  for (const literal of ['`<voice>甲|||乙</voice>`', '```xml\n<voice>甲|||乙</voice>\n```', '`<voice>`']) {
    const items = parseReply(`示例：${literal}|||${raw}`).items
    assert.deepEqual(items.filter(x => x.kind === 'voice'), [{ kind: 'voice', value: spoken }])
    assert.ok(items.filter(x => x.kind === 'text').map(x => x.value).join('').includes('<voice>'))
  }
})

test('未闭合、嵌套、非标准标签不猜测修复，普通文字和replace标签不清除', () => {
  for (const value of ['<voice>甲|||乙', '<VOICE>甲|||乙</VOICE>', '<voice rate="1">甲|||乙</voice>', '<voice>甲<voice>乙|||丙</voice></voice>']) {
    assert.equal(parseReply(value).items.some(x => x.kind === 'voice'), false, value)
  }
  assert.deepEqual(parseReply('甲|||乙').items, [{ kind: 'text', value: '甲' }, { kind: 'text', value: '乙' }])
  assert.deepEqual(parseReply('<replace>保留这个例子').items, [{ kind: 'text', value: '<replace>保留这个例子' }])
})

// Real hub, fake TTS/OneBot: exercise routing and fallbacks without sending to QQ.
for (const mode of ['voice', 'disabled', 'synth-failure']) test(`完整语音块跨分隔符走原有发送链路：${mode}`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-voice-separator-'))
  const old = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const audio = join(dir, 'voice.wav')
  writeFileSync(audio, 'test')
  const calls = [], speech = []
  const cfg = normalize({ enabled: true, dryRun: false, workspaceDir: dir, voice: { enabled: mode !== 'disabled', autoChance: 0 }, stickers: { enabled: false } })
  const hub = createHub({ dsh: {}, getConfig: () => cfg,
    log: Object.fromEntries(['info', 'warn', 'debug', 'error'].map(k => [k, () => {}])),
    onebot: { async call(action, params) { calls.push({ action, params }); return { message_id: 1 } } },
    moodEffects: () => ({ voice: 1, sticker: 1, delay: 0 }),
    tts: { async speak(text) { speech.push(text); if (mode === 'synth-failure') throw Error('test synthesis failure'); return { file: audio, engine: 'test' } } },
  })
  t.after(() => { hub.dispose(); if (old === undefined) delete process.env.AURABOT_DATA_DIR; else process.env.AURABOT_DATA_DIR = old; rmSync(dir, { recursive: true, force: true }) })
  await hub.deliver('group:9', raw)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].action, 'send_group_msg')
  assert.deepEqual(speech, mode === 'disabled' ? [] : [spoken])
  const message = calls[0].params.message
  assert.deepEqual(message.map(x => x.type), [mode === 'voice' ? 'record' : 'text'])
  if (mode !== 'voice') {
    assert.doesNotMatch(message[0].data.text, /<\/?voice>|\|{3,}/)
    assert.ok(message[0].data.text.includes('谢谢捧场') && message[0].data.text.includes('做个好梦'))
  }
})
