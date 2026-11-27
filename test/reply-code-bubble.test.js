import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseReply } from '../src/chat/reply.js'
import { createHub } from '../src/chat/hub.js'
import { normalize } from '../src/core/config.js'

const yaml = 'service:\n  port: 8000\n  env:\n    DEBUG: "false"'
const fenced = '```yaml\n' + yaml + '\n```'

test('短代码块保持单个气泡及内部缩进，长解释被删掉后也一样', () => {
  for (const intro of ['', '保存下面配置：\n', '这段说明用于解释配置。'.repeat(30) + '\n']) {
    const result = parseReply(intro + fenced)
    assert.deepEqual(result.items, [{ kind: 'text', value: intro + yaml }])
  }
})

test('代码以外的气泡、引用和语音仍按原顺序发送', () => {
  const result = parseReply('前文|||<reply:2>' + fenced + '|||<voice>存好后启动</voice>|||后文')
  assert.deepEqual(result.items, [
    { kind: 'text', value: '前文' },
    { kind: 'text', value: yaml, replyTo: '2' },
    { kind: 'voice', value: '存好后启动' },
    { kind: 'text', value: '后文' },
  ])
  assert.deepEqual(parseReply('第一句\n第二句').items, [
    { kind: 'text', value: '第一句' }, { kind: 'text', value: '第二句' },
  ])
  assert.deepEqual(parseReply('例如 `port` 是端口\n继续').items, [
    { kind: 'text', value: '例如 port 是端口' }, { kind: 'text', value: '继续' },
  ])
})

for (const chatId of ['group:9', 'private:9']) test(`短代码经实际发送链路保留缩进：${chatId}`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-code-bubble-'))
  const old = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const calls = []
  const cfg = normalize({ enabled: true, dryRun: false, workspaceDir: dir,
    voice: { enabled: false }, stickers: { enabled: false } })
  const hub = createHub({ dsh: {}, getConfig: () => cfg,
    log: Object.fromEntries(['info', 'warn', 'debug', 'error'].map(k => [k, () => {}])),
    onebot: { async call(action, params) { calls.push({ action, params }); return { message_id: 1 } } },
    moodEffects: () => ({ voice: 1, sticker: 1, delay: 0 }),
  })
  t.after(() => { hub.dispose(); if (old === undefined) delete process.env.AURABOT_DATA_DIR; else process.env.AURABOT_DATA_DIR = old; rmSync(dir, { recursive: true, force: true }) })
  await hub.deliver(chatId, fenced)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].action, chatId.startsWith('group:') ? 'send_group_msg' : 'send_private_msg')
  assert.deepEqual(calls[0].params.message, [{ type: 'text', data: { text: yaml } }])
})
