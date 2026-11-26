// 追问改到目标私聊里生成之后的时序与工具约束（#446 / #298 第 5 点）。
//
// 这里的重点是 purpose.test.js 用假 hub 测不到的东西：
//   · runTurnInChat 真的走 pushToSession，turn/end 一来就把 busy/running 放开（不踩 #90 那种泄漏）；
//   · noTools 时这一轮把全局工具整层收走，轮次结束后必须还回来；
//   · 主人正在说话（busy）时一律让位，绝不收工具；
//   · 回复由 turn/end 自己落地，调用方不再 deliver 第二次。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { createHub } from '../src/chat/hub.js'
import { normalize } from '../src/core/config.js'

const OWNER = '10000001'
const CHAT = `private:${OWNER}`
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(setImmediate) }

function setup(t, { brain, dryRun = false, review } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-nudge-session-'))
  const old = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  process.env.AURABOT_WORKSPACE = join(dir, 'workspace')
  const sent = []
  const cfg = normalize({ enabled: true, dryRun, ownerQQ: OWNER, ownerName: '主人', workspaceDir: dir, voice: { enabled: false }, stickers: { enabled: false } })
  const fake = createFakeDsh({ brain })
  const hub = createHub({
    dsh: fake.ctx,
    getConfig: () => cfg,
    log: Object.fromEntries(['info', 'warn', 'debug', 'error'].map((k) => [k, () => {}])),
    onebot: { async call() { return { message_id: 1 } } },
    // 挂一个「本机工具」：noTools 那一轮它必须被收走
    buildTools: () => [{ name: 'local-probe', execute: async () => ({ ok: true }) }],
    hooks: { send: async (segments) => { sent.push(segments); return segments } },
  })
  // 真实宿主里这条线是 host.js 接的（src/host.js 的 ctx.on('session/event')）。
  // 测试直接建 hub，必须自己接上，否则 turn/end 永远不到、轮次不会结束。
  fake.ctx.on('session/event', (session, event) => hub.onSessionEvent(session, event))
  t.after(() => {
    hub.dispose()
    fake.dispose()
    if (old === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = old
    // Windows 上 SQLite 句柄可能还没释放，清理失败不该让用例挂（临时目录由系统回收）
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })
  return { hub, fake, sent, cfg }
}

test('runTurnInChat：在目标私聊里生成一轮，回复由 turn/end 自己落地', async (t) => {
  // 注意：brain 拿到的 `text` 是整轮全部 text 块拼起来的内容，`inputText` 只是最后一段（hub 追加的时间行）。
  const s = setup(t, { brain: async ({ text }) => (String(text).includes('追一句') ? '在呢在呢' : '') })
  const r = await s.hub.runTurnInChat(CHAT, '【系统提醒】她刚才问你几点下班，20 分钟没回了，轻轻追一句。', { noTools: true, userText: '【系统提醒，不是主人说的话】（她主动找你）' })
  assert.equal(r.ok, true, '这一轮正常结束')
  assert.match(r.sent, /在呢在呢/, '真发出去的正文要如实报给调用方')
  const turn = s.fake.turns.at(-1)
  assert.match(turn.userText, /追一句/, '提示词进了这个私聊会话')
  // 回复落地走 deliver（不是调用方自己发）
  assert.ok(s.sent.length >= 1, '回复由 turn/end 正常落地')
  assert.match(JSON.stringify(s.sent), /在呢在呢/)
})

test('runTurnInChat：noTools 收走全局工具，轮次结束后还回来', async (t) => {
  const s = setup(t, { brain: async () => '在呢' })
  await s.hub.runTurnInChat(CHAT, '【系统提醒】追一句', { noTools: true })
  const agent = [...s.fake.agents.values()].pop()
  assert.equal(agent.guestLocked, 0, '轮次结束后全局工具必须还回来（不能把主人下一轮也锁住）')
})

test('runTurnInChat：主人正在说话（busy）时让位，并且绝不收工具', async (t) => {
  // 主人那一轮用一道闸门卡住：不靠固定 sleep 抢时序（以前 brain 睡 30ms + settle 固定圈数，
  // 机器慢一点那一轮就先结束了，r.ok 变 true，这条用例会随机挂）。
  let release
  const gate = new Promise((r) => { release = r })
  const s = setup(t, { brain: async () => { await gate; return '她的回答' } })
  // 先让主人说一句，把这一轮占住
  const busyPromise = s.hub.pushToSession(
    { kind: 'private', chatId: CHAT, userId: OWNER, groupId: '', nickname: '主人' },
    [{ type: 'text', text: '在吗' }], OWNER, { queryText: '在吗' },
  )
  // 等到 hub 真的认为这一轮在跑，再断言让位；最多等 1 秒，超时就是真有问题。
  const deadline = Date.now() + 1000
  while (!s.hub.busy() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
  assert.equal(s.hub.busy(), true, '主人那一轮应当已经被占住')
  const agent = [...s.fake.agents.values()].pop()
  const lockedBefore = agent.guestLocked
  const r = await s.hub.runTurnInChat(CHAT, '【系统提醒】追一句', { noTools: true })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'busy', '主人那一轮还没结束，追问必须让位')
  assert.equal(agent.guestLocked, lockedBefore, '让位时不能动主人的工具（这是不能带进线上的事故）')
  release()
  await busyPromise
  await settle()
})

test('runTurnInChat：不支持的目标（群聊/非法 chatId）直接拒绝', async (t) => {
  const s = setup(t, { brain: async () => 'x' })
  assert.equal((await s.hub.runTurnInChat('group:123', 'x')).reason, 'unsupported-chat')
  assert.equal((await s.hub.runTurnInChat('nonsense', 'x')).reason, 'unsupported-chat')
  assert.equal((await s.hub.runTurnInChat('', 'x')).reason, 'unsupported-chat')
})

test('runTurnInChat：她选择沉默时 ok:true 但 sent 为空', async (t) => {
  const s = setup(t, { brain: async () => '[沉默]' })
  const r = await s.hub.runTurnInChat(CHAT, '【系统提醒】追一句', { noTools: true })
  assert.equal(r.ok, true, '这一轮是正常结束的')
  assert.equal(r.sent, '', '没发出去就不能算发过')
})

test('runTurnInChat：suppressDelivery 时不往 QQ 发，把原文交回调用方（内部备忘不外泄）', async (t) => {
  // 目的回合的真实形态：正文 + 末尾的内部备忘
  const memo = '今天的大米布丁我做好了，你要不要尝尝？\n\n【目的】说说布丁\n【状态】完成'
  const s = setup(t, { brain: async () => memo })
  const r = await s.hub.runTurnInChat(CHAT, '【主动找主人】做布丁去了', { noTools: true, suppressDelivery: true })
  assert.equal(r.ok, true)
  assert.match(r.raw, /大米布丁/, '原文要原样交回调用方（含内部备忘）')
  assert.match(r.raw, /【目的】/, 'suppress 模式必须把备忘一起还回来，让调用方自己清洗')
  assert.equal(s.sent.length, 0, 'suppressDelivery 时一条都不许往 QQ 发（否则备忘直接泄到聊天里）')
  // 轮次也要正常放开，不能把会话卡成 running
  assert.equal(s.hub.busy(), false, 'suppress 之后轮次必须放开')
})

test('suppressDelivery 的那一轮不能被当成「她在私聊里说过话」（不落 saidElsewhere）', async (t) => {
  const s = setup(t, { brain: async () => '正文\n\n【目的】x\n【状态】完成' })
  await s.hub.runTurnInChat(CHAT, '【主动找主人】x', { noTools: true, suppressDelivery: true })
  assert.deepEqual(s.hub.saidElsewhereOf(CHAT), [], '还没真发出去的话不能算说过')
})

test('runTurnInChat：suppressDelivery 状态用完即清，不残留给下一轮', async (t) => {
  // 真事故场景：如果 st.suppressDelivery 没在轮次结束时清掉，
  // 主人下一句话会被判成「不投递」而永远发不出去。
  // 这里连跑两轮 suppress，再让主人正常说一句，验证第三轮照常投递。
  const s = setup(t, { brain: async ({ text }) => String(text).includes('主动找主人') ? '她主动说的话\n\n【目的】x' : '主人的正常回复' })
  const r1 = await s.hub.runTurnInChat(CHAT, '【主动找主人】一', { noTools: true, suppressDelivery: true })
  assert.equal(r1.ok, true)
  const r2 = await s.hub.runTurnInChat(CHAT, '【主动找主人】二', { noTools: true, suppressDelivery: true })
  assert.equal(r2.ok, true)
  assert.equal(s.sent.length, 0, '两轮 suppress 都不许往 QQ 发')

  // 主人正常说一句：走普通 pushToSession，必须能正常投递（说明 suppress 没泄漏）
  const chat = { kind: 'private', chatId: CHAT, userId: OWNER, groupId: '', nickname: '主人' }
  await s.hub.pushToSession(chat, [{ type: 'text', text: '你在干嘛' }], OWNER, { queryText: '你在干嘛' })
  for (let i = 0; i < 25; i++) await new Promise(setImmediate)
  assert.ok(s.sent.length >= 1, '主人的正常消息必须照旧投递（suppressDelivery 不能泄漏到别人的轮次）')
  assert.match(JSON.stringify(s.sent), /主人的正常回复/)
})
