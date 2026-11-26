import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveReplyTargets } from '../src/chat/reply-targets.js'
import { parseReply } from '../src/chat/reply.js'
import { createHub } from '../src/chat/hub.js'
import { normalize } from '../src/core/config.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const refs = { 1: { mid: '-31', uid: '10000001', direct: true }, 2: { mid: '-32', uid: '10000002', direct: false } }
const autoReply = { mid: '-31', uid: '10000001' }
const resolve = (text, options = {}) => resolveReplyTargets(parseReply(text).items, { refs, autoReply, ...options })

test('automatic and explicit replies to the same message resolve identically', () => {
  assert.deepEqual(resolve('收到'), resolve('<reply:1>收到'))
  assert.deepEqual(resolve('<reply:1>收到', { autoReply: null }), resolve('收到'))
  assert.equal(resolve('<reply:2>收到')[0].replyId, '-32')
  assert.equal(resolve('<reply:2>收到')[0].userId, undefined)
})

test('reply placement follows parsed items, with no automatic reply added elsewhere', () => {
  const items = parseReply('先说一句|||<reply:1><voice>收到</voice>|||再说一句').items
  const frozen = structuredClone(items)
  assert.deepEqual(resolveReplyTargets(items, { refs, autoReply }).map(t => t.replyId), [undefined, '-31', undefined])
  assert.deepEqual(items, frozen)
})

test('missing references stay distinguishable and do not fall back to another message', () => {
  assert.deepEqual(resolve('<reply:9>收到'), [{ replyId: undefined, userId: undefined, sourceUserId: undefined, unresolvedReply: '9' }])
  assert.equal(resolve('收到', { refs: {}, autoReply: null })[0].replyId, undefined)
})

test('automatic reply skips poke and unavailable stickers, but follows images and voice', () => {
  const items = [{ kind: 'poke' }, { kind: 'sticker', value: 'missing' }, { kind: 'voice', value: '你好' }]
  assert.deepEqual(resolveReplyTargets(items, { refs, autoReply, canSendSticker: () => false }).map(t => t.replyId),
    [undefined, undefined, '-31'])
  assert.deepEqual(resolveReplyTargets(items, { refs, autoReply }).map(t => t.replyId), [undefined, '-31', undefined])
  assert.equal(resolveReplyTargets([{ kind: 'image' }], { autoReply })[0].replyId, '-31')
})

test('prompt reference snapshots and actual delivery use the same targets across turns and groups', { timeout: 10000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-targets-'))
  const old = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const cfg = normalize({ enabled: true, dryRun: false, botQQ: '20000002', ownerQQ: '10000001',
    workspaceDir: dir, allow: { groups: ['555', '666'] }, merge: { enabled: false },
    voice: { enabled: false }, stickers: { enabled: false, collect: false } })
  const snapshots = [], sent = [], errors = []
  const fake = createFakeDsh({ brain: async () => '<reply:1>收到' })
  const hub = createHub({ dsh: fake.ctx, getConfig: () => cfg,
    log: Object.fromEntries(['info', 'warn', 'debug', 'error'].map(k => [k, (...args) => {
      if (k === 'warn' || k === 'error') errors.push(args.join(' '))
    }])),
    moodEffects: () => ({ voice: 1, sticker: 1, delay: 0 }),
    onebot: { connected: true, async call(action, params) {
      if (action === 'get_group_member_list') return []
      if (action === 'send_group_msg') sent.push(params)
      return { message_id: 99 }
    } },
    hooks: { prompt: async (content, info) => { snapshots.push(info); return content } },
  })
  fake.ctx.on('session/event', hub.onSessionEvent)
  t.after(() => {
    hub.dispose(); fake.dispose()
    if (old === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = old
    rmSync(dir, { recursive: true, force: true })
  })
  for (const [group, mid] of [[555, -31], [555, -32], [666, -33]]) {
    await hub.onMessage({ post_type: 'message', message_type: 'group', group_id: group, self_id: 20000002,
      user_id: 10000001, message_id: mid, sender: { user_id: 10000001, nickname: '甲' },
      message: [{ type: 'at', data: { qq: '20000002' } }, { type: 'text', data: { text: '你好' } }] })
    for (let n = 0; sent.length < snapshots.length || snapshots.length < Math.abs(mid) - 30; n++) {
      assert.ok(n < 200, 'turn did not finish')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  assert.deepEqual(snapshots.map(s => String(s.replyRefs[1].mid)), ['-31', '-32', '-33'])
  assert.deepEqual(sent.map(s => s.message.find(x => x.type === 'reply')?.data.id), ['-31', '-32', '-33'])
  assert.deepEqual(sent.map(s => s.message.find(x => x.type === 'at')?.data.qq), ['10000001', '10000001', '10000001'])
  assert.deepEqual(hub.replyTargets(parseReply('<reply:1>短稿').items, { refs: snapshots[0].replyRefs, autoReply: snapshots[0].autoReply }),
    [{ replyId: '-31', userId: '10000001', sourceUserId: '10000001', unresolvedReply: undefined }])
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(errors, [])
})
