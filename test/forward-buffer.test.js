import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize } from '../src/core/config.js'
import { createHub } from '../src/chat/hub.js'
import { cardText } from '../src/chat/inbound.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const OWNER = '10000001', BOT = '20000002', GROUP = '30000003', GUEST = '40000004'
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])
const text = s => ({ type: 'text', data: { text: s } })
const forward = (id = 'card') => ({ type: 'forward', data: { id } })
const at = { type: 'at', data: { qq: BOT } }
const node = {
  sender: { user_id: GUEST, nickname: '卡片作者' },
  message: [text('CARD_BODY_CANARY $&'), { type: 'image', data: { file: 'base64://' + png.toString('base64') } }],
}
const event = (message, { group = GROUP, user = OWNER, id = 101 } = {}) => ({
  message_type: group ? 'group' : 'private', self_id: BOT, user_id: user,
  ...(group ? { group_id: group } : {}), message_id: id,
  sender: { user_id: user, nickname: '测试' }, message,
})
const log = { info() {}, warn() {}, debug() {}, error() {} }

function setup(t, { patch = {}, beforeRead = async () => {}, beforeVoice = async () => {} } = {}) {
  const previous = process.env.AURABOT_DATA_DIR
  const dir = mkdtempSync(join(tmpdir(), 'card-buffer-'))
  process.env.AURABOT_DATA_DIR = dir
  const cfg = normalize({
    enabled: true, dryRun: true, setupDone: true, ownerQQ: OWNER, botQQ: BOT,
    workspaceDir: join(dir, 'workspace'), allow: { groups: [GROUP] },
    merge: { enabled: false }, voice: { enabled: false },
    stickers: { enabled: false, collect: false, autoChance: 0 }, titleFilter: { enabled: false }, ...patch,
  })
  const calls = [], prompts = []
  const fake = createFakeDsh({ brain: async () => '[沉默]' })
  const hub = createHub({
    dsh: fake.ctx, getConfig: () => cfg, log, stickers: {},
    hooks: {
      prompt: content => { prompts.push(structuredClone(content)); return content },
      groupDecide: (_decision, { msg }) => ({ reply: msg.mentioned, mode: 'must' }),
    },
    onebot: {
      connected: true,
      async call(action, params) {
        calls.push({ action, params })
        if (action === 'get_group_info') return { group_name: '检查群' }
        if (action === 'get_forward_msg') {
          await beforeRead(params.id)
          return { messages: [node] }
        }
        if (action === 'fetch_ptt_text') { await beforeVoice(); return { text: 'VOICE_CANARY' } }
        if (action === 'get_msg') return event([forward()], { id: 100 })
        return {}
      },
    },
  })
  fake.ctx.effect(() => fake.ctx.on('session/event', hub.onSessionEvent))
  t.after(() => {
    hub.dispose(); fake.dispose()
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return { hub, calls, prompts, cfg, fake }
}

async function ready(s, count = 1) {
  const end = Date.now() + 3000
  while (s.prompts.length < count && Date.now() < end) await new Promise(r => setTimeout(r, 5))
  assert.ok(s.prompts.length >= count, '模型应收到消息')
  return s.prompts.at(-1)
}
const body = p => p.filter(x => x.type === 'text').map(x => x.text).join('\n')
const reads = s => s.calls.filter(x => x.action === 'get_forward_msg')

for (const group of [GROUP, '']) {
  test((group ? '群聊直接唤醒' : '私聊直接发送') + '转发仍带正文和图片', async t => {
    const s = setup(t)
    await s.hub.onMessage(event(group ? [forward(), at] : [forward()], { group }))
    const p = await ready(s)
    assert.match(body(p), /CARD_BODY_CANARY \$&/)
    assert.ok(p.some(x => x.type === 'image'))
    assert.equal(reads(s).length, 1)
  })
}

test('启用补读时，卡片随后 @ 才展开且不重复拉取', async t => {
  const s = setup(t, { patch: { forward: { expandHistory: true } } })
  await s.hub.onMessage(event([forward()], { user: GUEST, id: 100 }))
  assert.equal(reads(s).length, 0)
  assert.equal(s.prompts.length, 0)
  await s.hub.onMessage(event([at, text('上面说什么')]))
  const p = await ready(s)
  assert.match(body(p), /CARD_BODY_CANARY \$&/)
  assert.ok(p.some(x => x.type === 'image'))
  await s.hub.onMessage(event([at, text('再解释一下')], { id: 102 }))
  await ready(s, 2)
  assert.equal(reads(s).length, 1)
})

test('关着的群不读取转发', async t => {
  const s = setup(t, { patch: { allow: { groups: [] } } })
  await s.hub.onMessage(event([forward(), at]))
  assert.equal(reads(s).length, 0)
  assert.equal(s.prompts.length, 0)
})

test('其他群的唤醒不会读取本群卡片', async t => {
  const s = setup(t, { patch: { allow: { groups: [GROUP, '50000005'] } } })
  await s.hub.onMessage(event([forward()], { user: GUEST }))
  await s.hub.onMessage(event([at, text('这是什么')], { group: '50000005', id: 102 }))
  assert.doesNotMatch(body(await ready(s)), /CARD_BODY_CANARY/)
  assert.equal(reads(s).length, 0)
})

test('读取中同一人又发消息，内容仍写回卡片那条', async t => {
  let release, entered
  const gate = new Promise(r => { release = r }), start = new Promise(r => { entered = r })
  t.after(() => release())
  const s = setup(t, { beforeRead: async () => { entered(); await gate } })
  const first = s.hub.onMessage(event([forward(), at], { id: 100 }))
  await start
  await s.hub.onMessage(event([text('NEW_MESSAGE_CANARY')], { id: 101 }))
  release(); await first
  const b = body(await ready(s))
  assert.match(b, /\[1\][^\n]*合并转发的聊天记录/)
  assert.match(b, /\[2\][^\n]*NEW_MESSAGE_CANARY/)
  assert.equal(b.match(/CARD_BODY_CANARY/g)?.length, 1)
})

test('分享链接保留定位与访问参数、重复参数、片段和编码', () => {
  for (const field of ['qqdocurl', 'jumpUrl', 'url']) {
    for (const url of [
      'https://example.org/item?id=123&lang=zh#details',
      'https://example.org/?id=1&id=2&token=a%2Bb%3D',
      'https://example.org/?next=https%3A%2F%2Fa.test%2F%3Fx%3D1',
      'https://example.org/path', 'https://b23.tv/xyz?share=1',
    ]) assert.equal(cardText({ meta: { news: { title: '标题', [field]: url } } }), `[分享卡片：标题 ${url}]`)
  }
  assert.equal(cardText('broken json'), '[卡片消息]')
})


test('语音识别期间同一人又发消息，结果写回原语音', async t => {
  let release, entered
  const gate = new Promise(r => { release = r }), start = new Promise(r => { entered = r })
  t.after(() => release())
  const s = setup(t, { patch: { voice: { asr: true, enabled: false } }, beforeVoice: async () => { entered(); await gate } })
  const first = s.hub.onMessage(event([{type:'record', data:{file:'voice.silk'}}, at], { id: 100 }))
  await start
  await s.hub.onMessage(event([text('NEW_VOICE_MESSAGE_CANARY')], { id: 101 }))
  release(); await first
  const b = body(await ready(s))
  assert.match(b, /\[1\][^\n]*VOICE_CANARY/)
  assert.match(b, /\[2\][^\n]*NEW_VOICE_MESSAGE_CANARY/)
  assert.equal(b.match(/\[语音\] VOICE_CANARY/g)?.length, 1)
})
