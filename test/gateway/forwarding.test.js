// G1 · 转发接口与错误包装（fetch / native / toParts；非 SendError 包成 unknown；SendError 构造）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeGateway, fakeFactory, makeIdentity, makeTempRoot } from './helpers.js'
import { join } from 'node:path'
import { createGateway } from '../../src/gateway/index.js'
import { makeSendError, isNotSent } from '../../src/gateway/errors.js'

function build(platforms, factories) {
  const root = makeTempRoot()
  const gateway = createGateway({ config: { platforms }, dataDir: (...p) => join(root, 'data', ...p), identity: makeIdentity(), replyHoldMs: 40 })
  for (const f of factories) gateway.register(f)
  return gateway
}

test('errors：makeSendError / isNotSent / 非 SendError 包成 unknown', async () => {
  const e = makeSendError('not-sent', 'offline', 'fake', '没连上')
  assert.equal(e.certainty, 'not-sent')
  assert.equal(e.instance, 'fake')
  assert.equal(isNotSent(e), true)
  assert.equal(isNotSent(makeSendError('unknown', 'timeout', 'fake')), false)
  assert.equal(isNotSent(new Error('普通错误')), false)
  assert.equal(isNotSent(null), false)

  // 网关兜底：平台端抛普通 Error（非 SendError）→ 一律包成 'unknown'
  const a = fakeFactory({ id: 'fake' })
  const gateway = build({ fake: { enabled: true } }, [a])
  await gateway.sync()
  const adapter = a.get(1)
  adapter.send = async () => {
    throw new Error('平台端代码炸了')
  }
  await assert.rejects(
    () => gateway.send({ chatId: 'fake:private:1', parts: [{ type: 'text', text: 'x' }], kind: 'reply', note: '' }),
    (err) => err.certainty === 'unknown' && !isNotSent(err) && String(err.message).includes('非 SendError'),
  )
})

test('fetch / native / toParts 转发给对应实例；实例不在线按约定抛错', async () => {
  const a = fakeFactory({ id: 'fake' })
  const gateway = build({ fake: { enabled: true } }, [a])
  await gateway.sync()
  const adapter = a.get(1)
  adapter.fetch = async (request) => ({ echoed: request.kind })
  adapter.native = async (action, params) => ({ action, params })
  adapter.toParts = (nativeMessage) => [{ type: 'text', text: String(nativeMessage?.text || '') }]

  const fetched = await gateway.fetch('fake:private:1', { kind: 'forward', id: 'f1' })
  assert.deepEqual(fetched, { echoed: 'forward' })

  const natted = await gateway.native('fake', 'get_status', { x: 1 })
  assert.deepEqual(natted, { action: 'get_status', params: { x: 1 } })

  const parts = gateway.toParts('fake', { text: '原生消息' })
  assert.deepEqual(parts, [{ type: 'text', text: '原生消息' }])

  // 实例不在线
  adapter.disconnect()
  await assert.rejects(() => gateway.fetch('fake', { kind: 'chats' }), (e) => e.certainty === 'not-sent')
  adapter.reconnect()
  // 平台端没实现 fetch
  const other = fakeFactory({ id: 'other' })
  const gw2 = build({ other: { enabled: true } }, [other])
  await gw2.sync()
  await assert.rejects(() => gw2.fetch('other', { kind: 'chats' }), /没有实现 fetch/)
  await assert.rejects(() => gw2.native('other', 'x'), /没有实现 native/)
  assert.throws(() => gw2.toParts('other', {}), /没有实现 toParts/)
  // 实例未启用 → native 抛错
  const cfgObj = { platforms: { other: { enabled: false } } }
  const root = makeTempRoot()
  const gw3 = createGateway({ config: cfgObj, dataDir: (...p) => join(root, 'd', ...p), identity: makeIdentity(), replyHoldMs: 40 })
  gw3.register(other)
  await gw3.sync()
  await assert.rejects(() => gw3.native('other', 'x'), /未启用/)
})
