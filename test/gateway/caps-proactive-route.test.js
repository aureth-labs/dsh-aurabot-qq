// G1 过关条件 · 能力叠加 / 被动回复三态+合并 / ctx.route 404 / routeTo 三优先级

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { makeGateway, fakeFactory, makeIdentity, makeTempRoot } from './helpers.js'
import { join } from 'node:path'
import { createGateway } from '../../src/gateway/index.js'

const send1 = (gateway, chatId, text, over = {}) =>
  gateway.send({ chatId, parts: [{ type: 'text', text }], kind: 'reply', note: text, ...over })

test('能力叠加：配置把 voice 关掉生效；想打开平台端没声明的能力无效并记警告', async () => {
  const a = fakeFactory({ id: 'fake' })
  const { gateway, log } = makeGateway({
    platforms: { fake: { enabled: true, caps: { voice: false, history: true, maxFileBytes: 999_999_999 } } },
    adapters: [a],
  })
  await gateway.sync()
  const caps = gateway.caps('fake')
  assert.equal(caps.voice, false, '配置把 voice 关掉 → 生效')
  assert.equal(caps.history, false, '平台端声明 history=false，配置想开 true → 无效')
  assert.equal(caps.maxFileBytes, 8 * 1024 * 1024, '上限只能调小，想调大无效')
  assert.ok(log.lines.some((l) => l.includes('往强改')), '往强改要记警告')

  // 降级链路验证：发语音 → 被丢掉
  const r = await send1(gateway, 'fake:private:1', '带语音')
  // 单独一条语音：text 部分为空则整条 nothing-to-send；这里验证 mixed 的情况
  const adapter = a.get(1)
  const r2 = await gateway.send({
    chatId: 'fake:private:1',
    parts: [{ type: 'text', text: '看' }, { type: 'voice', media: {} }],
    kind: 'reply',
    note: '带语音',
  })
  assert.ok(r2.messageId)
  assert.deepEqual(r2.degraded, ['voice dropped'])
  assert.equal(adapter.sent.at(-1).payload.parts.length, 1, '平台端只收到文字')
  void r
})

test('被动回复三态：none 拒主动且不入队 / 带 inResponseTo 在时限内放行 / 超时限按主动被拒', async () => {
  const a = fakeFactory({ id: 'fake', caps: { proactive: 'none', replyWindowMs: 60_000 } })
  const { gateway } = makeGateway({ platforms: { fake: { enabled: true } }, adapters: [a] })
  await gateway.sync()
  const adapter = a.get(1)

  // 先推一条入站，网关记下到达时间
  adapter.pushInbound({ messageId: 'in-1', parts: [{ type: 'text', text: '在吗' }] })

  // 1) none + 不带 inResponseTo → 拒绝且不入队
  await assert.rejects(
    () => send1(gateway, 'fake:private:10001', '主动打招呼'),
    (e) => e.certainty === 'not-sent' && e.code === 'proactive-not-allowed',
  )
  assert.equal(gateway.outbox.status().count, 0, 'proactive-not-allowed 不入队')

  // 2) 带 inResponseTo 且在时限内 → 放行，并带 inResponseTo 传给平台端
  const ok = await gateway.send({ chatId: 'fake:private:10001', parts: [{ type: 'text', text: '在的' }], kind: 'reply', note: '', inResponseTo: 'in-1' })
  assert.ok(ok.messageId)
  assert.equal(adapter.sent.at(-1).payload.inResponseTo, 'in-1')

  // 3) 超过 replyWindowMs（入站 at 在 70 秒前）→ 按主动消息处理，同样被拒
  adapter.pushInbound({ messageId: 'in-2', at: Date.now() - 70_000, parts: [{ type: 'text', text: '旧消息' }] })
  await assert.rejects(
    () => gateway.send({ chatId: 'fake:private:10001', parts: [{ type: 'text', text: '迟到回复' }], kind: 'reply', note: '', inResponseTo: 'in-2' }),
    (e) => e.certainty === 'not-sent' && e.code === 'proactive-not-allowed',
  )
})

test('free 平台主动消息照常发；limited 平台主动消息走平台端限额', async () => {
  const a = fakeFactory({ id: 'fake' })
  const { gateway } = makeGateway({ platforms: { fake: { enabled: true } }, adapters: [a] })
  await gateway.sync()
  const r = await send1(gateway, 'fake:private:1', '随便发')
  assert.ok(r.messageId)

  const b = fakeFactory({ id: 'limited', caps: { proactive: 'limited' } })
  const { gateway: gw2 } = makeGateway({ platforms: { limited: { enabled: true } }, adapters: [b] })
  await gw2.sync()
  const r2 = await send1(gw2, 'limited:private:1', 'limited 也能发，平台端自己记账')
  assert.ok(r2.messageId)
  // 平台端自己抛 proactive-limit → not-sent → 文字消息入队
  b.get(1).failNext('not-sent', 'proactive-limit')
  const r3 = await send1(gw2, 'limited:private:1', '超限')
  assert.equal(r3.queued, true)
})

test('repliesPerMessage=2：第三条文字并进第二条，不丢内容', async () => {
  const a = fakeFactory({ id: 'fake', caps: { repliesPerMessage: 2, replyWindowMs: 60_000 } })
  const { gateway } = makeGateway({ platforms: { fake: { enabled: true } }, adapters: [a], replyHoldMs: 60 })
  await gateway.sync()
  const adapter = a.get(1)
  adapter.pushInbound({ messageId: 'in-1', parts: [{ type: 'text', text: '问一句' }] })
  const respond = (text, over = {}) =>
    gateway.send({ chatId: 'fake:private:10001', parts: [{ type: 'text', text }], kind: 'reply', note: text, inResponseTo: 'in-1', ...over })

  await respond('第一段')
  await respond('第二段') // 最后一条允许的：挂起等待合并
  await respond('第三段') // 超出条数：并进挂起的那条
  await delay(120) // 等挂起定时器把合并后的消息发出去

  assert.equal(adapter.sent.length, 2, '只发了两条（第三条并进第二条）')
  const mergedParts = adapter.sent[1].payload.parts
  const mergedText = mergedParts.map((p) => p.text).join('')
  assert.ok(mergedText.includes('第二段') && mergedText.includes('第三段'), `内容不能丢（实际：${mergedText}）`)
  // 窗口过后第四条按主动消息（replyWindowMs 内没新入站则仍被动——这里在窗口内，计数已满则并流继续成立）
})

test('ctx.route：挂的路径能收到请求；实例停掉后同路径 404', async () => {
  const a = fakeFactory({ id: 'fake' })
  const cfg = { platforms: { fake: { enabled: true } } }
  const root = makeTempRoot()
  const identity = makeIdentity()
  const gateway = createGateway({ config: cfg, dataDir: (...p) => join(root, 'data', ...p), identity, replyHoldMs: 40 })
  gateway.register(a)
  await gateway.sync()

  // 假平台端 start 时挂了 /callback → 完整路径 /platform/fake/callback
  const seen = []
  gateway.onMessage((m) => seen.push(m))
  const res1 = { statusCode: 0, end() { this.ended = true } }
  const handled = gateway.handleHttp(
    { url: '/platform/fake/callback', headers: { 'x-fake-signature': 'fake-token' }, body: { text: '回调进来' } },
    res1,
  )
  assert.equal(handled, true)
  assert.equal(res1.statusCode, 200)
  assert.equal(seen.length, 1, '回调验签通过后 emit 一条入站')
  assert.equal(seen[0].text, '回调进来')

  // 不存在的路径 → 404
  const miss = gateway.handleHttp({ url: '/platform/fake/nope', headers: {}, body: {} }, { statusCode: 0, end() {} })
  assert.equal(miss, false, '查不到的路径回 404')

  // 停掉实例 → 路径撤销 → 404
  cfg.platforms.fake = { enabled: false }
  await gateway.sync()
  const after = gateway.handleHttp({ url: '/platform/fake/callback', headers: { 'x-fake-signature': 'fake-token' }, body: { text: 'x' } }, { statusCode: 0, end() {} })
  assert.equal(after, false, '实例停掉后路径撤销 → 404')
})

test('routeTo：固定平台 > 最近说话 > 任一在线；none 不被选；无账号返回 null', async () => {
  const a = fakeFactory({ id: 'fake' }) // 平台 fake
  const b = fakeFactory({ id: 'other' }) // 平台 other
  const { gateway, identity } = makeGateway({
    platforms: { fake: { enabled: true }, other: { enabled: true } },
    adapters: [a, b],
  })
  await gateway.sync()

  // 造一个人在两个平台都有账号
  adapterEmit(a.get(1), '20001', 'm1')
  adapterEmit(b.get(1), 'o-20001', 'm2')
  const person = identity.resolve('fake', '20001')
  // 注意：b 的入站已经把 other:o-20001 自动建成了另一个人（auto），这里要合并。
  // 假实现 link 遇到「已属于别人」会抛 IdentityConflict（与 I1 语义一致），
  // 所以先 unlink 掉那条自动建立的映射，再挂到 person 名下。
  identity.unlink('other', 'o-20001')
  identity.link('other', 'o-20001', person)
  assert.ok(identity.accountOn(person, 'fake'))
  assert.ok(identity.accountOn(person, 'other'))

  // 3) 都没有固定/最近 → 任一在线（instances() 顺序第一个 = fake）
  const anyChat = gateway.routeTo(person)
  assert.equal(anyChat, 'fake:private:20001')

  // 2) 最近说话的平台优先：刚在 other 上说过话
  gateway.noteSeen(person, 'other:private:o-20001', Date.now())
  assert.equal(gateway.routeTo(person), 'other:private:o-20001')

  // 1) 固定平台最优先
  gateway.routing.setFixed(person, 'fake')
  assert.equal(gateway.routeTo(person), 'fake:private:20001')

  // none 不被选：换一套全新工厂，fake 改成 proactive=none
  // （固定平台是 none → 不选，落到最近说话；两个平台都 none → null；无账号 → null）
  const c = fakeFactory({ id: 'fake' })
  const d = fakeFactory({ id: 'other' })
  const cfgObj = { platforms: { fake: { enabled: true, caps: { proactive: 'none' } }, other: { enabled: true } } }
  const root = makeTempRoot()
  const gw2 = createGateway({ config: cfgObj, dataDir: (...p) => join(root, 'data', ...p), identity, replyHoldMs: 40 })
  gw2.register(c)
  gw2.register(d)
  await gw2.sync()
  adapterEmit(c.get(1), '20001', 'm3')
  adapterEmit(d.get(1), 'o-20001', 'm4')
  gw2.routing.setFixed(person, 'fake')
  gw2.noteSeen(person, 'other:private:o-20001', Date.now())
  assert.equal(gw2.routeTo(person), 'other:private:o-20001', '固定平台 proactive=none → 不选，落到最近说话')

  cfgObj.platforms.other = { enabled: true, caps: { proactive: 'none' } }
  await gw2.sync()
  assert.equal(gw2.routeTo(person), null, '两个平台都是 none → null')

  // 无账号返回 null
  const stranger = identity.resolve('nobody', 'x1') // 平台 nobody 没有实例
  assert.equal(gw2.routeTo(stranger), null)
})

/** 在假平台端上推一条入站（不带 messageId 参数则用默认自增） */
function adapterEmit(adapter, account, messageId) {
  adapter.pushInbound({
    chat: { kind: 'private', id: account },
    sender: { account, name: '某人' },
    messageId,
    parts: [{ type: 'text', text: 'hi' }],
  })
}
