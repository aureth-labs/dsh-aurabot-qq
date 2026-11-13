// 契约测试包的自测：用模板平台端（src/adapters/_template）跑通全部过关项。
// 也就是说：一个照着模板抄出来的新平台端，天然能过这套契约。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import templateModule from '../../src/adapters/_template/index.js'
import { createTemplateAdapter } from '../../src/adapters/_template/index.js'
import { runAdapterContract, makeCtx } from './adapter-kit.js'

// ───────────────────────── 模板平台端的 harness ─────────────────────────
// 注入点全走 adapter.platform（模板自带的模拟平台）；真实平台端换成自己的
// 客户端 / 回调入口，harness 形状要求见 adapter-kit.js 文件头。
const templateHarness = {
  async injectInbound(adapter) {
    adapter.platform.deliver({
      message_id: 'tpl-in-1', time: Date.now(),
      chat_type: 'group', chat_id: '888', chat_title: '测试群',
      user_id: '10001', nickname: '张三', role: 'member', at_me: true,
      segments: [{ type: 'text', text: '模板你好' }, { type: 'image', url: 'https://example.com/a.png' }],
    })
  },
  async injectUnverified(adapter, ctx) {
    const handler = ctx.__routes?.get('/callback')
    assert.ok(handler, '模板平台端 start 后应挂 /callback 路由')
    handler({ headers: { 'x-template-signature': 'bad' }, body: { text: '不该进来的' } }, stubRes())
  },
  async injectSigned(adapter, ctx) {
    const handler = ctx.__routes?.get('/callback')
    assert.ok(handler, '模板平台端 start 后应挂 /callback 路由')
    handler({ headers: { 'x-template-signature': 'template-token' }, body: { text: '签名正确的回调' } }, stubRes())
  },
  setProactive(adapter, value) { adapter.platform.setCapsOverride({ proactive: value }) },
  failSend(adapter, why) {
    if (why === 'timeout') adapter.platform.hangNext()
    else adapter.platform.refuseNext()
  },
  async reconnect(adapter) {
    adapter.platform.break()
    adapter.platform.restore()
  },
}

function stubRes() { return { statusCode: 0, end() {}, setHeader() {} } }

test('模板平台端过全套契约（start / 入站 / send / 错误分类 / 重启 / proactive / 验签 / 断线重连）', async () => {
  await runAdapterContract(() => createTemplateAdapter(), templateHarness)
})

test('模板默认导出本身也能跑（register 直接给工厂用的那种）', async () => {
  // 默认导出是一次性实例：只验证它结构合规，不复用（用例内部各自 new）
  assert.equal(templateModule.contract, 1)
  assert.equal(templateModule.id, 'template')
  assert.equal(typeof templateModule.start, 'function')
  assert.equal(typeof templateModule.send, 'function')
})

test('模板的 toParts 能把原生消息段转成契约 parts', async () => {
  const adapter = createTemplateAdapter()
  const parts = adapter.toParts({
    segments: [
      { type: 'text', text: '嗨' },
      { type: 'image', url: 'https://example.com/x.png' },
      { type: 'at', account: '10002', name: '小明' },
      { type: 'unknown-thing' },
    ],
  })
  assert.deepEqual(parts, [
    { type: 'text', text: '嗨' },
    { type: 'image', media: { url: 'https://example.com/x.png', mime: undefined } },
    { type: 'mention', account: '10002', name: '小明' },
    { type: 'other', text: '[unknown-thing]', native: { type: 'unknown-thing' } },
  ])
})

test('模板验签不过的回调返回 401 且不 emit（emit 口是特权，验签不过绝不放行）', async () => {
  const adapter = createTemplateAdapter()
  const ctx = makeCtx(adapter)
  await adapter.start(ctx)
  const handler = ctx.routes.get('/callback')
  const res = stubRes()
  handler({ headers: { 'x-template-signature': 'wrong' }, body: { text: '伪造' } }, res)
  assert.equal(res.statusCode, 401)
  assert.equal(ctx.emitted.length, 0)
  await adapter.stop()
})
