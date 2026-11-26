// ACP 协议标记泄漏回归（2026-11-22 实况：DSH 上下文代理的 `<acp …>` 包装被模型复述后漏进 QQ）。
//
// 来源：DSH 的上下文代理给每条消息套一层 `<acp tokens="…" type="text" time="…">mNNNNN</acp>`，
// 模型状态差时把这层标记当正文模仿输出。实况三形态：
//   ① `="text" time="2026-11-22 17:26:47">>`   属性尾巴（`<acp tokens="86"` 被截掉）
//   ② `<acp tokens="86" type="text" time="…"></acp>`  完整空标签
//   ③ `6-11-22 17:26:55">`   更短的日期时间残片（`2026-…` 被截掉头）
//
// 本文件锁四层防御的契约：
//   第 1 层 reply.js 的 cleanOutboundText（全部出口的公共必经点）—— 剥除；
//   第 2 层 guard.js —— 整条只剩残渣时判沉默（宁可不说，也不发脏内容）；
//   第 3 层 hub.js sendSegments —— 真实出口幂等再剥一次；
//   配置 chat.acpSanitize —— 默认开正则、默认关模型兜底。
//
// 反向约束同样重要：正常聊天、正文里聊 `acp` 这个词、围栏内教人写标签、成对 HTML 标签，
// 都不能被误伤。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanOutboundText, cleanOutboundSegments, parseReply, stripAcpLeak, hasAcpResidue, hasSuspectTagShape } from '../src/chat/reply.js'
import { stripHtmlFragments } from '../src/chat/html-fragments.js'
import { guardOutgoing } from '../src/chat/guard.js'
import { normalize } from '../src/core/config.js'
import { createHub } from '../src/chat/hub.js'

// 2026-11-22 真机实况三条样本（逐字，勿改）
const SAMPLE_ATTR_TAIL = '="text" time="2026-11-22 17:26:47">>'
const SAMPLE_FULL_TAG = '<acp tokens="86" type="text" time="2026-11-22 18:56:41"></acp>'
const SAMPLE_TIME_TAIL = '6-11-22 17:26:55">'

// ─────────────── 第 1 层：统一清洗剥除 ───────────────

test('ACP 标记：剥完整空标签', () => {
  assert.equal(cleanOutboundText(SAMPLE_FULL_TAG, {}), '')
  // 整条只剩标记 → 判沉默，不发空气泡
  assert.deepEqual(parseReply(SAMPLE_FULL_TAG, {}), { silent: true, items: [] })
})

test('ACP 标记：剥属性尾巴残片（实况①）', () => {
  assert.equal(cleanOutboundText(SAMPLE_ATTR_TAIL, {}), '')
  assert.deepEqual(parseReply(SAMPLE_ATTR_TAIL, {}), { silent: true, items: [] })
})

test('ACP 标记：剥截断的时间残片（实况③）', () => {
  assert.equal(cleanOutboundText(SAMPLE_TIME_TAIL, {}), '')
  assert.deepEqual(parseReply(SAMPLE_TIME_TAIL, {}), { silent: true, items: [] })
})

test('ACP 标记：带 m 编号的形态连编号一起剥（与 love-mode 既有契约一致）', () => {
  // love-mode 的保险丝用例（mods-fork/modules/love-mode/test/love-mode.test.mjs:201）
  // 认定的口径是「剥完剩正文」，这里保持一致。
  assert.equal(cleanOutboundText('<acp tokens="15" type="text">m01990 刚吃完饭', {}), '刚吃完饭')
  assert.deepEqual(parseReply('<acp tokens="15" type="text">m01990 刚吃完饭', {}).items.map((i) => [i.kind, i.value]), [['text', '刚吃完饭']])
})

test('ACP 标记：正文与标记混排时正文必须完整保留', () => {
  // 用户实况就是这一条：正常人话是好的，只有标记漏出来。
  const input = `行 那我先去弄饭\n${SAMPLE_FULL_TAG}`
  assert.equal(cleanOutboundText(input, {}), '行 那我先去弄饭')
  const r = parseReply(input, {})
  assert.equal(r.silent, false)
  assert.deepEqual(r.items.map((i) => [i.kind, i.value]), [['text', '行 那我先去弄饭']])
})

test('ACP 标记：消息段出口按段删除，正文段与媒体段原样保留', () => {
  const message = [
    { type: 'text', data: { text: '行 那我先去弄饭' } },
    { type: 'image', data: { file: 'x.png' } },
    { type: 'text', data: { text: SAMPLE_FULL_TAG } },
  ]
  const out = cleanOutboundSegments(message.map((s) => ({ ...s, data: { ...s.data } })), {})
  assert.deepEqual(out.map((s) => s.type), ['text', 'image'])
  assert.equal(out[0].data.text, '行 那我先去弄饭')
})

test('ACP 标记：stripAcpLeak 幂等，剥完不再有残渣', () => {
  for (const input of [SAMPLE_ATTR_TAIL, SAMPLE_FULL_TAG, SAMPLE_TIME_TAIL]) {
    const once = stripAcpLeak(input)
    assert.equal(once, '')
    assert.equal(hasAcpResidue(once), false)
    assert.equal(stripAcpLeak(once), once)
  }
})

test('ACP 标记：html-fragments 也能认出 acp 标签（成对也不保留）', () => {
  // html-fragments 只负责标签本身（它不懂 ACP 的 mNNNNN 编号）；
  // 编号由第 1 层 cleanOutboundText 的 acpLeakRanges 连段删掉。这里锁两层各自的本职。
  assert.equal(stripHtmlFragments(SAMPLE_FULL_TAG).value.trim(), '')
  assert.equal(stripHtmlFragments('前\n<acp tokens="1">m1</acp>\n后').value, '前\nm1\n后')
  // 两层合起来才是最终口径：标签、编号、以及标签独占的那一行空行都不留
  assert.equal(cleanOutboundText('前\n<acp tokens="1">m1</acp>\n后', {}), '前\n后')
})

// ─────────────── 反向约束：不许误伤 ───────────────

test('ACP 标记：不误伤正文里正常提到 acp 这个词', () => {
  for (const t of ['你说的 acp 是啥意思', 'acp 是什么协议', '这个 acp 标签好烦']) {
    assert.equal(cleanOutboundText(t, {}), t, `误伤：${t}`)
  }
})

test('ACP 标记：不误伤正常聊天与短回复', () => {
  for (const t of ['行 那我先去弄饭', '在吗', 'ok', '好', '嗯嗯', '哈哈哈哈哈']) {
    assert.equal(cleanOutboundText(t, {}), t, `误伤：${t}`)
  }
})

test('ACP 标记：不误伤代码围栏内教人写标签', () => {
  const fenced = '```html\n<acp tokens="1">m1</acp>\n```'
  assert.equal(cleanOutboundText(fenced, {}), fenced)
})

test('ACP 标记：不误伤成对的普通 HTML 标签与相似标签名', () => {
  assert.equal(cleanOutboundText('我喜欢 <div>内容</div>', {}), '我喜欢 <div>内容</div>')
  assert.equal(cleanOutboundText('写 <p>段落</p> 这样就行', {}), '写 <p>段落</p> 这样就行')
  // `acpx` 不是 `acp`：`(?=[\s/>])` 边界必须挡住
  assert.equal(cleanOutboundText('<acpx>内容</acpx>', {}), '<acpx>内容</acpx>')
})

test('ACP 标记：不误伤正文里正常写的时间与 JSON 片段', () => {
  // 时间残片正则必须有 `">` 尾锚定，否则会误删正文里的时间
  assert.equal(cleanOutboundText('我们约 2026-11-22 17:26:55 见', {}), '我们约 2026-11-22 17:26:55 见')
  // 属性串只锚 tokens/type/time 三个名字，正常的配置/JSON 片段不受影响
  const json = '配置是 {"time": "10:00", "type": "text"}'
  assert.equal(cleanOutboundText(json, {}), json)
})

// ─────────────── 第 2 层：guard 整条剩残渣 → 判沉默 ───────────────

test('ACP 兜底：整条只剩协议残渣时 guard 判沉默', () => {
  for (const input of [SAMPLE_ATTR_TAIL, SAMPLE_FULL_TAG, SAMPLE_TIME_TAIL]) {
    const g = guardOutgoing(input, {})
    assert.equal(g.ok, false, `应当判沉默：${JSON.stringify(input)}`)
    assert.equal(g.reason, 'protocol-residue')
    assert.equal(g.text, '')
  }
})

test('ACP 兜底：guard 不误杀正常话（含很短的和提到 acp 的）', () => {
  for (const t of ['行 那我先去弄饭', '在吗', 'ok', '好', '嗯嗯', '你说的 acp 是啥意思']) {
    const g = guardOutgoing(t, {})
    assert.equal(g.ok, true, `被误杀：${JSON.stringify(t)}（reason=${g.reason}）`)
    assert.equal(g.text, t)
  }
})

test('ACP 兜底：新形态标记（cleanOutboundText 还不认识的）也能被 guard 兜住', () => {
  // 模拟将来出现别的协议标签：正文里只剩标签+属性，没有真正要说的话
  const unknown = '<future-mark tokens="9" type="text" time="2026-11-22 10:00:00"></future-mark>'
  const g = guardOutgoing(unknown, {})
  assert.equal(g.ok, false)
  assert.equal(g.reason, 'protocol-residue')
})

test('ACP 兜底：正文 + 未知标记时不能因为标记把正文一起判沉默', () => {
  const mixed = '行 那我先去弄饭 <future-mark tokens="9" type="text"></future-mark>'
  const g = guardOutgoing(mixed, {})
  assert.equal(g.ok, true, `正文被误判：reason=${g.reason}`)
  assert.match(g.text, /那我先去弄饭/)
})

test('ACP 兜底：插件自己的合法标记不能被当成残渣（戳一戳 / 语音 / 表情）', () => {
  // 回归护栏：残渣判定曾把任意标签都挖空，导致「只发一个 <poke>」被判残渣而发不出去。
  // 对应用例在 test/qq-tools-voice.test.js「原有私聊戳一戳仍报告实际成功，不误判成没发」。
  for (const t of ['<poke>', '<voice>晚上好</voice>', '<sticker:开心>', '<face:14>', '<reply:7><poke>']) {
    const g = guardOutgoing(t, {})
    assert.equal(g.ok, true, `合法标记被误判成残渣：${JSON.stringify(t)}（reason=${g.reason}）`)
  }
})

test('ACP 标记：属性尾巴规则不许切进完好标签内部（不许切出更脏的半截）', () => {
  // 回归护栏：属性尾巴正则曾在 `<future-mark tokens="9" type="text">` 内部命中，
  // 把标签切成 `<future-mark </future-mark>` —— 比原样更脏。
  // 属性尾巴只处理「`<` 已经被截掉」的残片，完好标签交给 acp 标签规则或原样放行。
  const unknownWithAttrs = '行 那我先去弄饭 <future-mark tokens="9" type="text"></future-mark>'
  assert.equal(cleanOutboundText(unknownWithAttrs, {}), unknownWithAttrs)
  const otherUnknown = '行 那我先去弄饭 <x-a tokens="9"></x-a>'
  assert.equal(cleanOutboundText(otherUnknown, {}), otherUnknown)
  // 同一个属性串，剥掉 `<` 之后才是我们的目标残片
  assert.equal(cleanOutboundText('="text" time="2026-11-22 17:26:47">>', {}), '')
})

// ─────────────── 第 3 层：出口幂等（stripAcpLeak 契约） ───────────────

test('ACP 出口：对已清洗文本再剥一次结果不变（幂等，防双份剥离破坏分段）', () => {
  const already = '行 那我先去弄饭'
  assert.equal(stripAcpLeak(already), already)
  // 钩子回写标记的场景：出口层必须还能剥掉
  const rewritten = `${already}\n${SAMPLE_FULL_TAG}`
  assert.equal(stripAcpLeak(rewritten), already)
})

test('ACP 出口：hasSuspectTagShape 只对标签/属性形状为真（模型兜底触发条件）', () => {
  assert.equal(hasSuspectTagShape('<acp tokens="1">x'), true)
  assert.equal(hasSuspectTagShape(SAMPLE_ATTR_TAIL), true)
  assert.equal(hasSuspectTagShape('行 那我先去弄饭'), false)
  assert.equal(hasSuspectTagShape('我们约 2026-11-22 17:26:55 见'), false)
  // 行内标签没有属性，不算可疑形状（不该因此去问模型）
  assert.equal(hasSuspectTagShape('<b>粗体</b>'), false)
})

// ─────────────── 配置：chat.acpSanitize ───────────────

test('ACP 配置：默认值 = 正则开、模型兜底关', () => {
  const cfg = normalize({})
  assert.deepEqual(cfg.chat.acpSanitize, {
    enabled: true,
    modelFallback: false,
    modelMaxChars: 800,
    modelTimeoutMs: 4000,
  })
})

test('ACP 配置：关掉正则净化后配置能读出来（供出口层判断）', () => {
  const cfg = normalize({ chat: { acpSanitize: { enabled: false, modelFallback: true, modelMaxChars: 1200, modelTimeoutMs: 6000 } } })
  assert.deepEqual(cfg.chat.acpSanitize, {
    enabled: false,
    modelFallback: true,
    modelMaxChars: 1200,
    modelTimeoutMs: 6000,
  })
})

test('ACP 配置：脏值回落到默认（不能把手填的离谱值当真）', () => {
  const cfg = normalize({ chat: { acpSanitize: { enabled: 'yes', modelFallback: 1, modelMaxChars: 999999, modelTimeoutMs: 0 } } })
  assert.equal(cfg.chat.acpSanitize.enabled, true) // 非 boolean → 默认 true
  assert.equal(cfg.chat.acpSanitize.modelFallback, false) // 非 boolean → 默认 false
  assert.equal(cfg.chat.acpSanitize.modelMaxChars, 4000) // 上限钳制
  assert.equal(cfg.chat.acpSanitize.modelTimeoutMs, 500) // 下限钳制
})

// ─────────────── 模型兜底开关（chat.acpSanitize.modelFallback） ───────────────
//
// 用真 hub 走 deliver 全链路，注入假的 askModel 观察调用次数与最终发出内容。
// 关键约束：默认关（一次都不调）、超时/抛错/输出更脏一律退回正则结果、绝不卡住。

/** 造一个最小可用的 hub；返回 { hub, calls(), logs() }。 */
function makeHub (askImpl, patch) {
  const base = normalize({ enabled: true, dryRun: false, ...(patch || {}) })
  const logs = []
  let calls = 0
  const hub = createHub({
    dsh: {},
    getConfig: () => base,
    log: {
      info: (...a) => logs.push(a.join(' ')),
      warn: (...a) => logs.push(a.join(' ')),
      debug: (...a) => logs.push(a.join(' ')),
      error: () => {},
      child () { return this },
    },
    onebot: { call: async () => ({ message_id: 'm1' }) },
    outbox: null,
    stickers: { pickForReply: () => null, match: () => null, enabled: false, autoChance: 0, limitTagged: false, keywordExemption: false },
    tts: { speak: async () => ({ file: '', engine: 'x' }), enabled: false },
    buildTools: () => [],
    contextProviders: [],
    onActivity: () => {},
    hooks: {},
    capabilitiesOf: () => [],
    askModel: (o) => { calls++; return askImpl(o) },
  })
  return { hub, calls: () => calls, logs }
}

// 用「未知标签带属性」当探针输入：正则不认识它，所以一定会走到兜底判定；
// 又因为它本身是完好的标签，正则不会把它切坏（见上面那条回归用例）。
const SUSPECT_INPUT = '行 那我先去弄饭 <future-mark tokens="9" type="text"></future-mark>'

test('ACP 模型兜底：默认关闭时一次都不调模型', async () => {
  const s = makeHub(async () => '不该被调用')
  await s.hub.deliver('private:1', SUSPECT_INPUT, { userText: 'x' })
  assert.equal(s.calls(), 0)
})

test('ACP 模型兜底：干净输入不触发（省 token）', async () => {
  const s = makeHub(async () => '不该被调用', { chat: { acpSanitize: { enabled: true, modelFallback: true } } })
  await s.hub.deliver('private:1', '行 那我先去弄饭', { userText: 'x' })
  assert.equal(s.calls(), 0)
})

test('ACP 模型兜底：打开后对可疑输入调一次，且采用模型结果', async () => {
  const s = makeHub(async () => '行 那我先去弄饭', { chat: { acpSanitize: { enabled: true, modelFallback: true } } })
  const r = await s.hub.deliver('private:1', SUSPECT_INPUT, { userText: 'x' })
  assert.equal(s.calls(), 1)
  assert.equal(r.sent, '行 那我先去弄饭')
})

test('ACP 模型兜底：超时必须降级到正则结果，不能卡住回复', async () => {
  const s = makeHub(() => new Promise(() => {}), { chat: { acpSanitize: { enabled: true, modelFallback: true, modelTimeoutMs: 500 } } })
  const t0 = Date.now()
  const r = await s.hub.deliver('private:1', SUSPECT_INPUT, { userText: 'x' })
  assert.ok(Date.now() - t0 < 5000, '超时保护失效，回复被卡住')
  assert.equal(s.calls(), 1)
  assert.match(String(r.sent), /那我先去弄饭/, '超时后应保留正则结果')
})

test('ACP 模型兜底：模型抛错时降级到正则结果，不炸', async () => {
  const s = makeHub(async () => { throw new Error('boom') }, { chat: { acpSanitize: { enabled: true, modelFallback: true } } })
  const r = await s.hub.deliver('private:1', SUSPECT_INPUT, { userText: 'x' })
  assert.equal(s.calls(), 1)
  assert.match(String(r.sent), /那我先去弄饭/)
})

test('ACP 模型兜底：模型输出更脏（还带标签属性）时丢弃，用正则结果', async () => {
  const s = makeHub(async () => '<acp tokens="1" type="text">行 那我先去弄饭</acp>', { chat: { acpSanitize: { enabled: true, modelFallback: true } } })
  const r = await s.hub.deliver('private:1', SUSPECT_INPUT, { userText: 'x' })
  assert.match(String(r.sent), /那我先去弄饭/, '不能采用带标签的模型输出')
  assert.equal(s.calls(), 1)
})

test('ACP 模型兜底：模型把语气全改掉（重合度不足）时丢弃', async () => {
  const s = makeHub(async () => '完全不相干的一句话啊啊啊啊啊啊', { chat: { acpSanitize: { enabled: true, modelFallback: true } } })
  const r = await s.hub.deliver('private:1', SUSPECT_INPUT, { userText: 'x' })
  assert.match(String(r.sent), /那我先去弄饭/, '不能采用改写过度（伤语气）的模型输出')
})

test('ACP 模型兜底：超长文本不送模型（省 token，走正则）', async () => {
  const long = '行 那我先去弄饭。'.repeat(100) + '<future-mark tokens="9"></future-mark>'
  const s = makeHub(async () => '不该被调用', { chat: { acpSanitize: { enabled: true, modelFallback: true, modelMaxChars: 200 } } })
  await s.hub.deliver('private:1', long, { userText: 'x' })
  assert.equal(s.calls(), 0)
})
