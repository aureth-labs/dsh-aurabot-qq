// 假平台端自己的测试。过关条件：它必须先过 runAdapterContract 全套契约，
// 才有资格给别人的测试当平台用。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeFakeAdapter, fakeHarness } from './fake-adapter.js'
import { runAdapterContract, makeCtx } from '../contract/adapter-kit.js'

test('假平台端过全套契约（这是它给别的测试用的资格证）', async () => {
  await runAdapterContract(makeFakeAdapter, fakeHarness)
})

test('注入入站消息：字段补齐、emit 恰好一条', async () => {
  const adapter = makeFakeAdapter()
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  adapter.pushInbound({ chat: { kind: 'group', id: '888', title: '群' }, sender: { account: '20002', name: '李四', role: 'admin' }, text: '自己送来的' })
  assert.equal(ctx.emitted.length, 1)
  const m = ctx.emitted[0]
  assert.equal(m.chat.id, '888')
  assert.equal(m.sender.account, '20002')
  assert.equal(m.sender.role, 'admin')
  assert.ok(m.messageId)
  assert.ok(Number.isInteger(m.at))
  assert.deepEqual(m.parts, [{ type: 'text', text: '自己送来的' }])
  await adapter.stop()
})

test('重复推送同一 messageId 也照发（去重在网关：实例 + messageId）', async () => {
  const adapter = makeFakeAdapter()
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  adapter.pushInbound({ messageId: 'dup-1', text: '同一条' })
  adapter.pushInbound({ messageId: 'dup-1', text: '同一条' })
  assert.equal(ctx.emitted.length, 2, '假平台允许重复推；网关按 实例+messageId 去重')
  await adapter.stop()
})

test('failNext：按指令抛 not-sent 或 unknown，SendError 带 instance', async () => {
  const adapter = makeFakeAdapter()
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  adapter.failNext('not-sent', 'too-large')
  await assert.rejects(() => adapter.send({ chat: { kind: 'private', id: '1' }, parts: [{ type: 'text', text: 'x' }] }),
    (e) => e.certainty === 'not-sent' && e.code === 'too-large' && e.instance === 'fake')
  adapter.failNext('unknown')
  await assert.rejects(() => adapter.send({ chat: { kind: 'private', id: '1' }, parts: [{ type: 'text', text: 'x' }], timeoutMs: 120 }),
    (e) => e.certainty === 'unknown')
  await adapter.stop()
})

test('断线后 send 抛 not-sent、推送失效；重连恢复', async () => {
  const adapter = makeFakeAdapter()
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  adapter.disconnect()
  assert.equal(ctx.states.at(-1)[0], 'disconnected')
  adapter.pushInbound()
  assert.equal(ctx.emitted.length, 0, '断线时推送不该进来')
  await assert.rejects(() => adapter.send({ chat: { kind: 'private', id: '1' }, parts: [{ type: 'text', text: 'x' }] }),
    (e) => e.certainty === 'not-sent' && e.code === 'offline')
  adapter.reconnect()
  assert.equal(ctx.states.at(-1)[0], 'connected')
  adapter.pushInbound()
  assert.equal(ctx.emitted.length, 1)
  const r = await adapter.send({ chat: { kind: 'private', id: '1' }, parts: [{ type: 'text', text: 'x' }] })
  assert.ok(r.messageId)
  await adapter.stop()
})

test('hangNext：send 挂起，按 timeoutMs 超时抛 unknown', async () => {
  const adapter = makeFakeAdapter()
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  adapter.hangNextSend()
  const t0 = Date.now()
  await assert.rejects(() => adapter.send({ chat: { kind: 'private', id: '1' }, parts: [{ type: 'text', text: 'x' }], timeoutMs: 100 }),
    (e) => e.certainty === 'unknown')
  assert.ok(Date.now() - t0 >= 95, '确实等了接近 timeoutMs 才抛')
  await adapter.stop()
})

test('运行中改 caps 并通知网关（capsChanged）', async () => {
  const adapter = makeFakeAdapter()
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  assert.equal(adapter.caps().voice, 'native')
  adapter.setCaps({ voice: 'file' })
  assert.equal(adapter.caps().voice, 'file')
  assert.ok(ctx.capsChanges >= 1, '改完能力要调 ctx.capsChanged() 让网关重读')
  adapter.setCaps({ proactive: 'none' })
  await assert.rejects(() => adapter.send({ chat: { kind: 'private', id: '1' }, parts: [{ type: 'text', text: 'x' }] }),
    (e) => e.certainty === 'not-sent' && e.code === 'proactive-not-allowed')
  await adapter.stop()
})

test('出站记录：send 的内容、replyTo / inResponseTo 都留在 adapter.sent 里', async () => {
  const adapter = makeFakeAdapter()
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  const r = await adapter.send({ chat: { kind: 'private', id: '9' }, parts: [{ type: 'text', text: '记录我' }], replyTo: 'in-1', inResponseTo: 'in-1' })
  assert.equal(adapter.sent.length, 1)
  const rec = adapter.sent[0]
  assert.equal(rec.payload.chat.id, '9')
  assert.deepEqual(rec.payload.parts, [{ type: 'text', text: '记录我' }])
  assert.equal(rec.payload.replyTo, 'in-1')
  assert.equal(rec.payload.inResponseTo, 'in-1')
  assert.ok(rec.at <= Date.now())
  assert.ok(r.messageId)
  await adapter.stop()
})
