// G1 过关条件 · 补发队列（not-sent 入队重连补发触发 onFlushed / unknown 不入队 /
// 含媒体不入队 / 过期丢弃；proactive/diary 有效期）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createOutbox, hasMedia } from '../../src/gateway/outbox.js'
import { fakeFactory, makeGateway, makeTempRoot } from './helpers.js'
import { makeSendError } from '../../src/gateway/errors.js'

const msg = (over = {}) => ({
  chatId: 'fake:private:10001',
  parts: [{ type: 'text', text: '补发我' }],
  kind: 'reply',
  note: '测试消息',
  ...over,
})

test('outbox 拒绝保存敏感消息，并过滤以前落盘的敏感消息', async () => {
  const file = join(makeTempRoot(), 'outbox.json')
  const expiresAt = Date.now() + 60_000
  await writeFile(file, JSON.stringify([
    { id: 'sensitive', instance: 'fake', expiresAt, message: msg({ sensitive: true }) },
    { id: 'ordinary', instance: 'fake', expiresAt, message: msg() },
  ]))
  const box = createOutbox({ file })
  assert.equal(box.add(msg({ sensitive: true }), { instance: 'fake' }).ok, false)
  assert.deepEqual(box.list().map(item => item.id), ['ordinary'])
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).map(item => item.id), ['ordinary'])
})

test('带轮次守卫的回复保留入站凭据，授权失效或发送失败时不进入延迟发送', async (t) => {
  let now = 100_000
  const fake = fakeFactory({ id: 'fake', caps: { repliesPerMessage: 1, replyWindowMs: 1000 } })
  const { gateway } = makeGateway({ platforms: { fake: { enabled: true } }, adapters: [fake], now: () => now })
  t.after(() => gateway.stopAll())
  await gateway.sync()
  const adapter = fake.get(1)
  const admit = id => adapter.pushInbound({
    messageId: id, at: now, chat: { kind: 'private', id: '10001' }, sender: { account: '10001' },
    parts: [{ type: 'text', text: '本地测试' }],
  })
  const guarded = { replyGuard: () => true }
  const byCode = code => error => error.certainty === 'not-sent' && error.code === code
  admit('live')
  await assert.rejects(gateway.send(msg({ inResponseTo: 'live' }), { replyGuard: () => false }), byCode('reply-revoked'))
  assert.equal(adapter.sent.length, 0)
  await gateway.send(msg({ inResponseTo: 'live' }), guarded)
  assert.deepEqual(adapter.sent.map(item => item.payload.inResponseTo), ['live'])
  await assert.rejects(gateway.send(msg({ inResponseTo: 'live' }), guarded), byCode('reply-limit'))

  admit('late')
  now += 1001
  await assert.rejects(gateway.send(msg({ inResponseTo: 'late' }), guarded), byCode('reply-window-expired'))
  await assert.rejects(gateway.send(msg(), guarded), byCode('reply-window-expired'))

  admit('offline')
  adapter.disconnect()
  await assert.rejects(gateway.send(msg({ inResponseTo: 'offline' }), guarded), byCode('offline'))
  assert.equal(gateway.outbox.status().count, 0)
  adapter.reconnect()
  admit('not-sent')
  adapter.send = async () => { throw makeSendError('not-sent', 'offline', 'fake', '测试发送失败') }
  await assert.rejects(gateway.send(msg({ inResponseTo: 'not-sent' }), guarded), byCode('offline'))
  assert.equal(gateway.outbox.status().count, 0)
  assert.equal(adapter.sent.length, 1)
})

test('outbox：只收不含媒体的消息（text/mention/face 之外有别的类型就拒）', () => {
  const box = createOutbox({})
  assert.equal(hasMedia([{ type: 'text', text: 'x' }, { type: 'mention', account: '1' }, { type: 'face', name: '捂脸' }]), false)
  assert.equal(hasMedia([{ type: 'text', text: 'x' }, { type: 'image', media: {} }]), true)
  assert.equal(hasMedia([{ type: 'voice', media: {} }]), true)
  const ok = box.add(msg(), { instance: 'fake' })
  assert.equal(ok.ok, true)
  const bad = box.add(msg({ parts: [{ type: 'text', text: 'x' }, { type: 'image', media: {} }] }), { instance: 'fake' })
  assert.equal(bad.ok, false)
  assert.equal(box.status().count, 1, '媒体消息不入队')
})

test('outbox：有效期按 SendKind（proactive 1 分钟 / diary 10 分钟 / 其余 5 分钟）', () => {
  let at = 1_000_000_000_000
  const box = createOutbox({ now: () => at })
  const p = box.add(msg({ kind: 'proactive' }), { instance: 'fake' })
  const d = box.add(msg({ kind: 'diary' }), { instance: 'fake' })
  const r = box.add(msg({ kind: 'reply' }), { instance: 'fake' })
  const items = box.list()
  assert.equal(items.find((x) => x.id === p.id).expiresAt - at, 60_000)
  assert.equal(items.find((x) => x.id === d.id).expiresAt - at, 10 * 60_000)
  assert.equal(items.find((x) => x.id === r.id).expiresAt - at, 5 * 60_000)
})

test('outbox：过期的丢弃；unknown 视同丢弃防重复；not-sent 留队退避', async () => {
  let at = 1_000_000_000_000
  const box = createOutbox({ now: () => at })

  // 过期：时间越过有效期 → 丢弃
  box.add(msg({ note: '会过期' }), { instance: 'fake' })
  at += 5 * 60_000 + 1
  let r = await box.flush(async () => ({ messageId: 'x' }))
  assert.equal(r.dropped, 1, '过期丢弃')
  assert.equal(r.left, 0)

  // unknown：丢弃防重复
  box.add(msg({ note: '不确定' }), { instance: 'fake' })
  r = await box.flush(async () => {
    throw Object.assign(new Error('拿不准'), { certainty: 'unknown', instance: 'fake' })
  })
  assert.equal(r.dropped, 1, 'unknown 丢弃')
  assert.equal(r.left, 0)

  // not-sent：留队、指数退避（同一时刻内不再重试）
  box.add(msg({ note: '留队' }), { instance: 'fake' })
  r = await box.flush(async () => {
    throw Object.assign(new Error('还没连上'), { certainty: 'not-sent', code: 'offline', instance: 'fake' })
  })
  assert.equal(r.sent, 0)
  assert.equal(r.dropped, 0)
  assert.equal(r.left, 1, 'not-sent 留队')
  at += 1000 // 还没到退避点
  r = await box.flush(async () => ({ messageId: 'ok' }))
  assert.equal(r.sent, 0, '退避期内不重试')
  at += 60_000 // 退避已过
  r = await box.flush(async () => ({ messageId: 'ok' }))
  assert.equal(r.sent, 1, '退避期过后补发成功')
  assert.equal(r.left, 0)
})

test('网关：not-sent 文字消息入队，重连后补发并触发 onFlushed；unknown 不入队；含媒体不入队', async () => {
  const a = fakeFactory({ id: 'fake' })
  const { gateway } = makeGateway({ platforms: { fake: { enabled: true } }, adapters: [a] })
  await gateway.sync()
  const adapter = a.get(1)

  // 断线 → 入队
  adapter.disconnect()
  const flushedMessages = []
  const flushedResults = []
  gateway.onFlushed((m, r) => {
    flushedMessages.push(m)
    flushedResults.push(r)
  })

  const queued = await gateway.send(msg({ note: '断线排队' }))
  assert.equal(queued.queued, true)
  assert.equal(gateway.outbox.status().count, 1)
  assert.equal(flushedMessages.length, 0, '没补发前不触发 onFlushed')

  // 重连 → 自动补发该实例名下的 → onFlushed(message, result)
  adapter.reconnect()
  await delay(30)
  assert.equal(adapter.sent.length, 1, '补发了一条')
  assert.equal(adapter.sent[0].payload.parts[0].text, '补发我')
  assert.equal(flushedMessages.length, 1)
  assert.equal(flushedMessages[0].note, '断线排队')
  assert.equal(flushedMessages[0].chatId, 'fake:private:10001')
  assert.ok(flushedResults[0]?.messageId, 'onFlushed 的 result 带 messageId')
  assert.equal(gateway.outbox.status().count, 0)

  // unknown 不入队、原样抛出（队列此时已空，count 必须还是 0）
  adapter.failNext('unknown', 'timeout')
  await assert.rejects(
    () => gateway.send(msg({ note: '超时', timeoutMs: 30 })),
    (e) => e.certainty === 'unknown',
  )
  assert.equal(gateway.outbox.status().count, 0, 'unknown 不入队')

  // 含媒体的 not-sent 不入队
  adapter.disconnect()
  await assert.rejects(
    () => gateway.send(msg({ note: '带图', parts: [{ type: 'image', media: { url: 'https://x/a.png' } }] })),
    (e) => e.certainty === 'not-sent',
  )
  assert.equal(gateway.outbox.status().count, 0, '媒体消息不进补发队列')
})

test('落盘恢复：同一数据目录重建网关后补发队列还在（含手动 flush 触发 onFlushed）', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createGateway } = await import('../../src/gateway/index.js')
  const { makeIdentity } = await import('./helpers.js')

  const root = mkdtempSync(join(tmpdir(), 'aurabot-gw-persist-'))
  const dataDir = (...p) => join(root, 'data', ...p)
  const identity = makeIdentity()
  const a = fakeFactory({ id: 'fake' })
  const opts = { config: { platforms: { fake: { enabled: true } } }, dataDir, identity, replyHoldMs: 40 }

  const gw1 = createGateway(opts)
  gw1.register(a)
  await gw1.sync()
  a.get(1).disconnect()
  const enq = await gw1.send(msg({ note: '落盘队列' }))
  assert.equal(enq.queued, true)

  const gw2 = createGateway(opts)
  gw2.register(a)
  // 先验落盘：sync 之前（实例还没连上，不会触发自动补发）队列就该从磁盘读回来
  assert.equal(gw2.outbox.status().count, 1, '重启后队列从磁盘读回')
  const flushed = []
  gw2.onFlushed((m) => flushed.push(m.note))
  // sync 起实例 → 连上后自动补发该实例名下的
  await gw2.sync()
  await gw2.outbox.flush()
  assert.deepEqual(flushed, ['落盘队列'])
  assert.equal(a.get(3).sent.length, 1, '补发恰好一条（不能重复发）')
  assert.equal(gw2.outbox.status().count, 0)
})
