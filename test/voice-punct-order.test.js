// #546：语音条漏「。，」双标点；手机客户端上语音条与配文顺序反了。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHub } from '../src/chat/hub.js'
import { normalize } from '../src/core/config.js'
import { tidyPunctuation, parseReply } from '../src/chat/reply.js'

function setup(t, { hooks, synthFails = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-voice-order-'))
  const old = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const file = join(dir, 'voice.wav')
  writeFileSync(file, 'wav')
  const calls = []
  const spoken = []
  const cfg = normalize({ enabled: true, dryRun: false, workspaceDir: dir, voice: { enabled: true, autoChance: 0 }, stickers: { enabled: false } })
  const hub = createHub({ dsh: {}, getConfig: () => cfg, hooks,
    log: Object.fromEntries(['info', 'warn', 'debug', 'error'].map((k) => [k, () => {}])),
    onebot: { async call(action, params) { calls.push({ action, params, at: Date.now() }); return { message_id: calls.length } } },
    stickers: { match: () => null, segmentFor: () => null, pickForReply: () => null, markUsed: () => {} },
    moodEffects: () => ({ voice: 1, sticker: 1, delay: 0 }),
    tts: { async speak(text) { spoken.push(text); if (synthFails) throw new Error('tts failed'); return { file, engine: 'test' } } },
  })
  t.after(() => { hub.dispose(); if (old === undefined) delete process.env.AURABOT_DATA_DIR; else process.env.AURABOT_DATA_DIR = old; rmSync(dir, { recursive: true, force: true }) })
  return { hub, calls, spoken }
}

const types = (s) => s.calls.flatMap((c) => (c.params.message || []).map((x) => x.type))

test('收尾标点后的逗号收掉，正常逗号不动', () => {
  assert.equal(tidyPunctuation('算你快。，行吧'), '算你快。行吧')
  assert.equal(tidyPunctuation('真的吗！，'), '真的吗！')
  assert.equal(tidyPunctuation('好…，'), '好…')
  assert.equal(tidyPunctuation('第一句，第二句'), '第一句，第二句')
  // 删除线的 ~~ 不是收尾标点，后面的正常逗号不能动
  assert.equal(tidyPunctuation('我~~没生气~~，真的'), '我~~没生气~~，真的')
  // 代码块和行内代码是字面量，即使里面有「。，」也不改
  const code = '```js\nconst s = "句号。，";\n```'
  assert.equal(tidyPunctuation(code), code)
  assert.equal(tidyPunctuation('示例 `a。，b` 不动'), '示例 `a。，b` 不动')
  assert.equal(parseReply(code).items[0].value, 'const s = "句号。，";')
})

test('语音条和文字气泡都不再带「。，」', async (t) => {
  const s = setup(t)
  await s.hub.deliver('private:1', '算你快。，行吧|||第二句！，')
  const texts = s.calls.flatMap((c) => (c.params.message || []).filter((x) => x.type === 'text').map((x) => x.data.text))
  assert.ok(texts.length, JSON.stringify(s.calls))
  for (const text of texts) assert.doesNotMatch(text, /[。！？…][，,]/)
  assert.deepEqual(s.spoken, [])
})

test('代码围栏和行内代码混排时不重复也不误伤', () => {
  assert.equal(tidyPunctuation('看 `x` 然后 ```js\ny。，\n``` 完'), '看 `x` 然后 ```js\ny。，\n``` 完')
  assert.equal(tidyPunctuation('```js\nx。，\n``` 中间 `a。，b` 尾'), '```js\nx。，\n``` 中间 `a。，b` 尾')
  assert.deepEqual(parseReply('前 `a。，b` 后 ```js\nx。，\n``` 尾').items.map((x) => x.value), ['前 a。，b 后 x。，\n 尾'])
})

test('~~~ 与未闭合代码围栏也按字面量保护', () => {
  assert.equal(tidyPunctuation('~~~js\nx。，\n~~~'), '~~~js\nx。，\n~~~')
  assert.equal(tidyPunctuation('```js\nx。，\n'), '```js\nx。，\n')
})

test('wantVoice 含代码块时不转语音，代码字面量保留', async (t) => {
  const s = setup(t, { synthFails: true })
  await s.hub.deliver('private:1', '看示例：\n```js\nx。，\n```|||后面', { wantVoice: true })
  const texts = s.calls.flatMap((c) => (c.params.message || []).filter((x) => x.type === 'text').map((x) => x.data.text))
  assert.ok(texts.some((x) => x.includes('x。，')), JSON.stringify(texts))
  assert.deepEqual(s.spoken, [])
})

test('wantVoice 派生的语音文本也收「。，」，合成失败回退文字不漏', async (t) => {
  const s = setup(t, { synthFails: true })
  await s.hub.deliver('private:1', '第一句。|||第二句。', { wantVoice: true })
  const texts = s.calls.flatMap((c) => (c.params.message || []).filter((x) => x.type === 'text').map((x) => x.data.text))
  assert.ok(texts.length, JSON.stringify(s.calls))
  for (const text of texts) assert.doesNotMatch(text, /[。！？…][，,]/)
})

test('模块经 items 钩子原地改写已有文字也收「。，」', async (t) => {
  const s = setup(t, { hooks: { items: (items) => { if (items[0]) items[0].value = '原正文。，'; return items } } })
  await s.hub.deliver('private:1', '正常一句')
  const texts = s.calls.flatMap((c) => (c.params.message || []).filter((x) => x.type === 'text').map((x) => x.data.text))
  assert.ok(!texts.some((x) => x.includes('。，')), JSON.stringify(texts))
})

test('模块经 items 钩子追加的文字也收「。，」', async (t) => {
  const s = setup(t, { hooks: { items: (items) => [...items, { kind: 'text', value: '模块补一句。，' }] } })
  await s.hub.deliver('private:1', '正常一句')
  const texts = s.calls.flatMap((c) => (c.params.message || []).filter((x) => x.type === 'text').map((x) => x.data.text))
  assert.ok(texts.includes('模块补一句。'), JSON.stringify(texts))
  assert.ok(!texts.some((x) => x.includes('。，')), JSON.stringify(texts))
})

test('语音后面接配文时先等一拍再发文字', async (t) => {
  const s = setup(t)
  await s.hub.deliver('private:1', '<voice>晚安。，</voice>|||配文一句', { voice: false })
  assert.deepEqual(types(s), ['record', 'text'])
  const [voice, text] = s.calls
  assert.ok(text.at - voice.at >= 1000, `间隔只有 ${text.at - voice.at}ms`)
  assert.equal(s.spoken[0], '晚安。')
  assert.doesNotMatch(text.params.message[0].data.text, /[。！？…][，,]/)
})
