// G1 过关条件 · 实例管理与入站（包-G1-网关骨架.md 过关条件 1/2/5/6/7/8）
// 全部用 test/helpers/fake-adapter.js 的假平台端。
// 注意：factory.get(0) 是 register 探测 id 时的样例（不会启动）；真正启动的实例从 get(1) 起。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'
import { createGateway } from '../../src/gateway/index.js'
import { makeGateway, fakeFactory, makeIdentity, makeTempRoot } from './helpers.js'

/** 外部持有 config 对象的壳：测试里直接改 cfgObj.platforms 再 gateway.sync() 模拟配置变更 */
function makeGatewayCfg(cfgObj, factories, extra = {}) {
  const root = makeTempRoot()
  const identity = extra.identity || makeIdentity()
  const gateway = createGateway({
    config: cfgObj,
    dataDir: (...p) => join(root, 'data', ...p),
    identity,
    replyHoldMs: 40,
  })
  for (const f of factories) gateway.register(f)
  return { gateway, identity }
}

test('两个假实例同时在线，入站各自带各自的 instance/chatId，互不串', async () => {
  const a = fakeFactory({ id: 'fake' })
  const b = fakeFactory({ id: 'other' })
  const { gateway } = makeGateway({
    platforms: { fake: { enabled: true }, other: { enabled: true } },
    adapters: [a, b],
  })
  await gateway.sync()
  const seen = []
  gateway.onMessage((m) => seen.push(m))

  a.get(1).pushInbound({ chat: { kind: 'private', id: '10001' }, sender: { account: '10001', name: '张三' }, messageId: 'm1', parts: [{ type: 'text', text: '来自fake' }] })
  b.get(1).pushInbound({ chat: { kind: 'group', id: 'oc_1', title: '群' }, sender: { account: 'u9', name: '李四' }, messageId: 'm2', parts: [{ type: 'text', text: '来自other' }] })

  assert.equal(seen.length, 2)
  assert.equal(seen[0].instance, 'fake')
  assert.equal(seen[0].platform, 'fake')
  assert.equal(seen[0].chatId, 'fake:private:10001')
  assert.equal(seen[1].instance, 'other')
  assert.equal(seen[1].chatId, 'other:group:oc_1')
  assert.equal(seen[1].kind, 'group')
})

test('同一条 messageId 推两次，订阅者只收到一次', async () => {
  const a = fakeFactory({ id: 'fake' })
  const { gateway } = makeGateway({ platforms: { fake: { enabled: true } }, adapters: [a] })
  await gateway.sync()
  let count = 0
  gateway.onMessage(() => count++)
  a.get(1).pushInbound({ messageId: 'dup-1', parts: [{ type: 'text', text: '第一次' }] })
  a.get(1).pushInbound({ messageId: 'dup-1', parts: [{ type: 'text', text: '重连后的重复推送' }] })
  assert.equal(count, 1, '重复推送不能进中枢两次')
})

test('关掉一个实例不影响另一个；重新打开后能收发', async () => {
  const a = fakeFactory({ id: 'fake' })
  const b = fakeFactory({ id: 'other' })
  const cfgObj = { platforms: { fake: { enabled: true }, other: { enabled: true } } }
  const { gateway } = makeGatewayCfg(cfgObj, [a, b])
  await gateway.sync()
  assert.equal(gateway.instances().find((i) => i.instance === 'other').state, 'connected')

  // 关掉 other
  cfgObj.platforms.other = { enabled: false }
  await gateway.sync()
  const stOther = gateway.instances().find((i) => i.instance === 'other')
  const stFake = gateway.instances().find((i) => i.instance === 'fake')
  assert.equal(stOther.state, 'stopped')
  assert.equal(stFake.state, 'connected', '关掉 other 不影响 fake')

  // fake 还能收
  const seen = []
  gateway.onMessage((m) => seen.push(m))
  a.get(1).pushInbound({ messageId: 'keep-1', parts: [{ type: 'text', text: '还在' }] })
  assert.equal(seen.length, 1)

  // other 期间发消息 → not-sent（实例停了，没有可重连的实例，不入队）
  await assert.rejects(
    () => gateway.send({ chatId: 'other:private:10001', parts: [{ type: 'text', text: 'x' }], kind: 'reply', note: '停用期间' }),
    (e) => e.certainty === 'not-sent' && e.code === 'offline',
  )
  assert.equal(gateway.outbox.status().count, 0, '实例停用（非断线）的消息不入队')

  // 重新打开
  cfgObj.platforms.other = { enabled: true }
  await gateway.sync()
  assert.equal(gateway.instances().find((i) => i.instance === 'other').state, 'connected')
  const ok = await gateway.send({ chatId: 'other:private:10001', parts: [{ type: 'text', text: '回来了' }], kind: 'reply', note: '重开' })
  assert.ok(ok.messageId)
  assert.equal(b.get(2).sent.length, 1, '重开后新建的实例（第 2 份 adapter）收到这条')
})

test('whoami 账号不符时实例被断开', async () => {
  const a = fakeFactory({ id: 'fake', self: { account: 'real-bot', name: '真身' } })
  const { gateway } = makeGateway({
    platforms: { fake: { enabled: true, selfId: 'expected-bot' } },
    adapters: [a],
  })
  await gateway.sync()
  const st = gateway.instances().find((i) => i.instance === 'fake')
  assert.equal(st.state, 'disconnected', '账号不符应断开')
  assert.ok(String(st.detail).includes('whoami'), `状态里要写清原因（实际：${st.detail}）`)
  await assert.rejects(
    () => gateway.send({ chatId: 'fake:private:10001', parts: [{ type: 'text', text: 'x' }], kind: 'reply', note: '' }),
    (e) => e.certainty === 'not-sent',
  )
})

test('whoami 相符时实例正常连接并记 self', async () => {
  const a = fakeFactory({ id: 'fake', self: { account: 'fake-bot', name: '假机器人' } })
  const { gateway } = makeGateway({
    platforms: { fake: { enabled: true, selfId: 'fake-bot' } },
    adapters: [a],
  })
  await gateway.sync()
  const st = gateway.instances().find((i) => i.instance === 'fake')
  assert.equal(st.state, 'connected')
  assert.deepEqual(st.self, { account: 'fake-bot', name: '假机器人' })
})

test('同平台开两个实例：地址、状态、补发互不串；身份按平台记，同账号是同一个人', async () => {
  const a = fakeFactory({ id: 'qq' })
  const { gateway, identity } = makeGateway({
    platforms: { qq: { enabled: true }, 'qq#2': { enabled: true } },
    adapters: [a],
  })
  await gateway.sync()
  const seen = []
  gateway.onMessage((m) => seen.push(m))

  a.get(1).pushInbound({ chat: { kind: 'private', id: '10001' }, sender: { account: '10001', name: '张三' }, messageId: 'q1', parts: [{ type: 'text', text: '一号机' }] })
  a.get(2).pushInbound({ chat: { kind: 'private', id: '10001' }, sender: { account: '10001', name: '张三' }, messageId: 'q2', parts: [{ type: 'text', text: '二号机' }] })

  assert.equal(seen.length, 2)
  assert.equal(seen[0].chatId, 'qq:private:10001')
  assert.equal(seen[1].chatId, 'qq#2:private:10001')
  assert.equal(seen[0].sender.person, seen[1].sender.person, '身份按平台记：同账号是同一个人')
  assert.equal(identity.resolve('qq', '10001'), seen[0].sender.person)

  // 补发互不串：qq 断线入队，qq#2 在线照常发
  a.get(1).disconnect()
  const enq = await gateway.send({ chatId: 'qq:private:10001', parts: [{ type: 'text', text: '排队' }], kind: 'reply', note: '断线' })
  assert.equal(enq.queued, true)
  const direct = await gateway.send({ chatId: 'qq#2:private:10001', parts: [{ type: 'text', text: '照发' }], kind: 'reply', note: '在线' })
  assert.ok(direct.messageId)
  assert.equal(a.get(2).sent.length, 1)
  assert.equal(a.get(1).sent.length, 0)

  // 重连后补发只发 qq 名下的那条，并触发 onFlushed
  const flushed = []
  gateway.onFlushed((m) => flushed.push(m.chatId))
  a.get(1).reconnect()
  await delay(30)
  assert.equal(a.get(1).sent.length, 1, '重连后补发 qq 名下的一条')
  assert.equal(flushed.length, 1)
  assert.equal(flushed[0], 'qq:private:10001')
})

test('adapter 同名冲突拒绝启动实例；正常 adapter 另指可用', async () => {
  const a = fakeFactory({ id: 'qq' })
  const bridge = fakeFactory({ id: 'bridge' })
  const { gateway, log } = makeGateway({
    platforms: { qq: { enabled: true, adapter: 'bridge' } },
    adapters: [a, bridge],
  })
  await gateway.sync()
  const st = gateway.instances().find((i) => i.instance === 'qq')
  assert.equal(st.state, 'stopped', '实例名前缀等于已注册平台端 id 时拒绝启动')
  assert.match(String(st.detail), /冒充|拒绝/, `要报清楚原因（实际：${st.detail}）`)
  assert.ok(log.lines.some((l) => l.includes('拒绝启动')), '要记一条警告')

  // 正常写法：实例名前缀不是任何平台端 id，adapter 另指平台端
  const b = fakeFactory({ id: 'bridge' })
  const { gateway: gw2 } = makeGateway({
    platforms: { mychat: { enabled: true, adapter: 'bridge' } },
    adapters: [b],
  })
  await gw2.sync()
  const st2 = gw2.instances().find((i) => i.instance === 'mychat')
  assert.equal(st2.state, 'connected')
  assert.equal(st2.platform, 'mychat', '平台名用实例名前缀，平台端用 adapter 指定的')
})

test('配置变了再调 sync 只动有变化的实例', async () => {
  const a = fakeFactory({ id: 'fake' })
  const b = fakeFactory({ id: 'other' })
  const cfgObj = { platforms: { fake: { enabled: true }, other: { enabled: true } } }
  const { gateway } = makeGatewayCfg(cfgObj, [a, b])
  await gateway.sync()
  await gateway.send({ chatId: 'fake:private:1', parts: [{ type: 'text', text: '留个痕迹' }], kind: 'reply', note: '' })
  const sentBefore = a.get(1).sent.length
  assert.equal(sentBefore, 1)

  // 只改 other 的配置 → fake 的 adapter 对象不变（没被重启，痕迹还在）
  cfgObj.platforms.other = { enabled: true, caps: { voice: false } }
  await gateway.sync()
  assert.equal(a.get(1).sent.length, sentBefore, 'fake 没被重启')
  const stOther = gateway.instances().find((i) => i.instance === 'other')
  assert.equal(stOther.caps.voice, false, 'other 用了新配置')
})
