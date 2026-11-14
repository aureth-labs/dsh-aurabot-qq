// I3 主人身份清扫验收测试：
// 1) src/ 中 ownerQQ 仅允许存在于 config.js（旧字段兼容）与 host.js（启动迁移）；
// 2) 安全闸门（access / approval / danger）四用例全覆盖：平台 A 主人、平台 B 主人、非主人（含跨平台同名账号 '10001'）、无 QQ 的 p-... 主人；
// 3) 无 QQ 账号的 p-... 主人在假网关平台端全链路（私聊、命令、授权确认、主动搭话、断路由兜底）；
// 4) 双平台同一主人（QQ + 飞书）：两边私聊都认主人、共享同一按 PersonId 的每日主动发言预算。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createIdentity } from '../src/gateway/identity.js'
import { createGateway } from '../src/gateway/index.js'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { makeFakeAdapter } from './helpers/fake-adapter.js'
import { normalize } from '../src/core/config.js'
import { isOwner, isOwnerPrivateChat, resolveConfirmChat } from '../src/chat/access.js'
import { createApprovalRelay } from '../src/security/approval.js'
import { createDangerGuard } from '../src/security/danger.js'
import { createSpeakUp } from '../src/features/companion.js'
import { createPurposePolicy, createSpeakupPolicy, createSharedBudget } from '../src/features/proactive-policy.js'
import { parseCommand } from '../src/chat/commands.js'

const REPO = join(fileURLToPath(import.meta.url), '..', '..')
const SRC = join(REPO, 'src')
const root = mkdtempSync(join(tmpdir(), 'aurabot-i3-'))
process.env.AURABOT_WORKSPACE = join(root, 'workspace')
const { createHub } = await import('../src/chat/hub.js')

const noopLog = { debug() {}, info() {}, warn() {}, error() {} }

function walkJs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walkJs(p, out)
    else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

function ownerChatsOf(identity) {
  const id = identity.owner()
  if (!id) return []
  return identity.accountsOf(id).map((a) => `${a.platform}:private:${a.account}`)
}

test('I3 静态审计：src/ 中仅 config.js 与 host.js 启动迁移允许出现 ownerQQ', () => {
  const hits = []
  for (const file of walkJs(SRC)) {
    const rel = relative(REPO, file).replace(/\\/g, '/')
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((line, idx) => {
      if (/\bownerQQ\b/.test(line)) hits.push({ rel, lineNo: idx + 1, line })
    })
  }
  const unexpected = hits.filter((h) => h.rel !== 'src/core/config.js' && !(h.rel === 'src/host.js' && h.lineNo >= 155 && h.lineNo <= 190))
  assert.deepEqual(unexpected, [], `发现未清扫的 ownerQQ 引用：\n${unexpected.map((h) => `${h.rel}:${h.lineNo}: ${h.line}`).join('\n')}`)
  assert.ok(hits.some((h) => h.rel === 'src/core/config.js'))
  assert.ok(hits.some((h) => h.rel === 'src/host.js'))

  const layeringText = readFileSync(join(REPO, 'test/layering.test.js'), 'utf8')
  const wlStart = layeringText.indexOf('WHITELIST_HUB_WORDS')
  const wlEnd = layeringText.indexOf('HUB_DIRS')
  assert.equal(/ownerQQ/.test(layeringText.slice(wlStart, wlEnd)), false)
})

test('I3 安全闸门四用例（access / approval / danger）：平台 A 主人、平台 B 主人、跨平台同名非主人、无 QQ 主人', async (t) => {
  // 子情景 A：双平台主人（qq:10001 + feishu:ou_owner_b）+ 非主人（qq:20002 + 飞书上的同名账号 feishu:10001）
  await t.test('双平台主人与跨平台同名路人隔离', async () => {
    const dir = mkdtempSync(join(root, 'sec-dual-'))
    const identity = createIdentity({ dataDir: dir, log: noopLog })
    const ownerPerson = identity.claimOwner('qq', '10001')
    identity.link('feishu', 'ou_owner_b', ownerPerson, 'owner')
    const qqStranger = identity.resolve('qq', '20002')
    const feishuHomonym = identity.resolve('feishu', '10001') // 与 QQ 主人同字符串的飞书陌生人，绝不能误认为主人

    // 1. access.js
    assert.equal(isOwner(identity, ownerPerson), true)
    assert.equal(isOwner(identity, '10001', 'qq'), true)
    assert.equal(isOwner(identity, 'ou_owner_b', 'feishu'), true)
    assert.equal(isOwner(identity, qqStranger), false)
    assert.equal(isOwner(identity, feishuHomonym), false)
    assert.equal(isOwner(identity, '10001', 'feishu'), false)
    assert.equal(isOwner(identity, 'ou_owner_b', 'qq'), false)

    assert.equal(isOwnerPrivateChat(identity, 'qq:private:10001', '10001'), true)
    assert.equal(isOwnerPrivateChat(identity, 'feishu:private:ou_owner_b', 'ou_owner_b'), true)
    assert.equal(isOwnerPrivateChat(identity, 'feishu:private:10001', '10001'), false)
    assert.equal(isOwnerPrivateChat(identity, 'qq:private:20002', '20002'), false)
    assert.equal(isOwnerPrivateChat(identity, 'qq:group:999', '10001'), false)
    assert.equal(resolveConfirmChat(identity, 'feishu:private:ou_owner_b'), 'feishu:private:ou_owner_b')
    assert.equal(resolveConfirmChat(identity, 'feishu:private:10001'), '')

    // 2. approval.js（确认发回触发平台；只认本聊天回复；非主人 / 跨平台同名绝不放行）
    const sent = []
    const sessionToChat = new Map([
      ['s-qq', 'qq:private:10001'],
      ['s-fs', 'feishu:private:ou_owner_b'],
      ['s-bad', 'feishu:private:10001'],
    ])
    const relay = createApprovalRelay({
      getConfig: () => ({ enabled: true, dryRun: false, approvalViaQQ: true }),
      deliver: async (chatId, text) => sent.push({ chatId, text }),
      chatOfSession: (sid) => sessionToChat.get(sid) || '',
      identity,
      routeOwner: (p) => (p === 'feishu' ? 'feishu:private:ou_owner_b' : 'qq:private:10001'),
      timeoutMs: 2000,
      log: noopLog,
    })

    // 平台 A 审批
    const reqA = relay.onRequest({ agent: { session: { id: 's-qq' } }, toolName: 'edit_file' }, async () => 'unavailable')
    await new Promise(setImmediate)
    assert.equal(sent.at(-1).chatId, 'qq:private:10001')
    assert.equal(relay.handleReply('feishu:private:10001', '10001', '确认'), false)
    assert.equal(relay.handleReply('qq:private:10001', '10001', '确认'), true)
    assert.equal(await reqA, 'allowed-once')

    // 平台 B 审批（发到 feishu:private:ou_owner_b；qq 或 feishu 同名路人都不能代答）
    const reqB = relay.onRequest({ agent: { session: { id: 's-fs' } }, toolName: 'write_file' }, async () => 'unavailable')
    await new Promise(setImmediate)
    assert.equal(sent.at(-1).chatId, 'feishu:private:ou_owner_b')
    assert.equal(relay.handleReply('qq:private:10001', '10001', '确认'), false)
    assert.equal(relay.handleReply('feishu:private:10001', '10001', '确认'), false)
    assert.equal(relay.handleReply('feishu:private:ou_owner_b', 'ou_owner_b', '确认'), true)
    assert.equal(await reqB, 'allowed-once')

    // 非主人（含 feishu:private:10001）不经私聊问主人
    assert.equal(relay.handles('s-bad'), false)
    assert.equal(await relay.onRequest({ agent: { session: { id: 's-bad' } }, toolName: 'bash' }, async () => 'unavailable'), 'unavailable')
    relay.dispose()

    // 3. danger.js
    const dSent = []
    const danger = createDangerGuard({
      getConfig: () => ({ security: { dangerConfirm: true } }),
      deliver: async (chatId, text) => dSent.push({ chatId, text }),
      chatOfSession: (sid) => sessionToChat.get(sid) || '',
      isOwnedSession: (sid) => sessionToChat.has(sid),
      identity,
      routeOwner: () => 'qq:private:10001',
      timeoutMs: 2000,
      log: noopLog,
    })

    // 跨平台同名非主人直接拒绝，不发送确认消息
    const badRes = await danger.preExecute({ name: 'bash', arguments: { command: 'rm -rf /' }, agent: { session: { id: 's-bad' } } }, async () => ({ kind: 'allow' }))
    assert.equal(badRes.kind, 'deny')
    assert.equal(dSent.length, 0)

    // 平台 A 主人确认放行
    const pDangerA = danger.preExecute({ name: 'bash', arguments: { command: 'rm -rf /' }, agent: { session: { id: 's-qq' } } }, async () => ({ kind: 'allow' }))
    await new Promise(setImmediate)
    assert.equal(dSent.at(-1).chatId, 'qq:private:10001')
    assert.equal(danger.handleReply('feishu:private:10001', '10001', '确认'), false)
    assert.equal(danger.handleReply('qq:private:10001', '10001', '确认'), true)
    assert.equal((await pDangerA).kind, 'allow')

    // 平台 B 主人确认放行（问飞书，不问 QQ）
    const pDangerB = danger.preExecute({ name: 'bash', arguments: { command: 'rm -rf /' }, agent: { session: { id: 's-fs' } } }, async () => ({ kind: 'allow' }))
    await new Promise(setImmediate)
    assert.equal(dSent.at(-1).chatId, 'feishu:private:ou_owner_b')
    assert.equal(danger.handleReply('qq:private:10001', '10001', '确认'), false)
    assert.equal(danger.handleReply('feishu:private:ou_owner_b', 'ou_owner_b', '确认'), true)
    assert.equal((await pDangerB).kind, 'allow')
    danger.dispose()
  })

  // 子情景 B：完全无 QQ 的 p-... 主人（只在非 QQ 平台存在）
  await t.test('无 QQ 账号的 p-... 主人安全闸门全部可用', async () => {
    const dir = mkdtempSync(join(root, 'sec-noqq-'))
    const identity = createIdentity({ dataDir: dir, log: noopLog })
    const pOwner = identity.claimOwner('feishu', 'ou_only_feishu')
    assert.match(pOwner, /^p-[0-9a-z]+$/)
    assert.equal(identity.accountOn(pOwner, 'qq'), null)

    assert.equal(isOwner(identity, pOwner), true)
    assert.equal(isOwner(identity, 'ou_only_feishu', 'feishu'), true)
    assert.equal(isOwner(identity, 'ou_only_feishu', 'qq'), false)
    assert.equal(isOwnerPrivateChat(identity, 'feishu:private:ou_only_feishu', 'ou_only_feishu'), true)
    assert.equal(resolveConfirmChat(identity, '', () => 'feishu:private:ou_only_feishu'), 'feishu:private:ou_only_feishu')

    const relaySent = []
    const relay = createApprovalRelay({
      getConfig: () => ({ enabled: true, dryRun: false, approvalViaQQ: true }),
      deliver: async (chatId, text) => relaySent.push({ chatId, text }),
      chatOfSession: () => 'feishu:private:ou_only_feishu',
      identity,
      routeOwner: () => 'feishu:private:ou_only_feishu',
      timeoutMs: 2000,
      log: noopLog,
    })
    const req = relay.onRequest({ agent: { session: { id: 's-only' } }, toolName: 'bash' }, async () => 'unavailable')
    await new Promise(setImmediate)
    assert.equal(relaySent.at(-1).chatId, 'feishu:private:ou_only_feishu')
    assert.equal(relay.handleReply('feishu:private:ou_only_feishu', 'ou_only_feishu', '同意'), true)
    assert.equal(await req, 'allowed-once')
    relay.dispose()

    const dangerSent = []
    const danger = createDangerGuard({
      getConfig: () => ({ security: { dangerConfirm: true } }),
      deliver: async (chatId, text) => dangerSent.push({ chatId, text }),
      chatOfSession: () => 'feishu:private:ou_only_feishu',
      isOwnedSession: () => true,
      identity,
      routeOwner: () => 'feishu:private:ou_only_feishu',
      timeoutMs: 2000,
      log: noopLog,
    })
    const res = danger.preExecute({ name: 'bash', arguments: { command: 'rm -rf /' }, agent: { session: { id: 's-only' } } }, async () => ({ kind: 'allow' }))
    await new Promise(setImmediate)
    assert.equal(dangerSent.at(-1).chatId, 'feishu:private:ou_only_feishu')
    assert.equal(danger.handleReply('feishu:private:ou_only_feishu', 'ou_only_feishu', '确认'), true)
    assert.equal((await res).kind, 'allow')
    danger.dispose()
  })
})

test('I3 无 QQ 账号的 p-... 主人（假网关平台端）：私聊、命令、授权确认、主动搭话与 null 兜底全部正常', async (t) => {
  const dataDir = mkdtempSync(join(root, 'noqq-e2e-'))
  process.env.AURABOT_DATA_DIR = dataDir
  const identity = createIdentity({ dataDir: join(dataDir, 'gw'), log: noopLog })
  const pOwner = identity.claimOwner('feishu', 'ou_only_owner')
  assert.match(pOwner, /^p-[0-9a-z]+$/)
  assert.equal(identity.accountOn(pOwner, 'qq'), null)

  let cfg = normalize({
    enabled: true, dryRun: false, setupDone: true, botQQ: '', ownerQQ: '',
    voice: { enabled: false }, merge: { enabled: false }, stickers: { enabled: false, collect: false },
    speakUp: { enabled: true, awakeFrom: 0, awakeTo: 24, maxPerDay: 5, minIntervalMinutes: 1, maxIntervalMinutes: 1 },
    platforms: { feishu: { enabled: true, default: true } },
  })
  const gw = createGateway({ config: cfg, dataDir: (...p) => join(dataDir, ...p), identity, log: noopLog })
  const adapter = makeFakeAdapter({ id: 'feishu' })
  gw.register(() => adapter)
  await gw.sync()

  const fake = createFakeDsh({ brain: async ({ text }) => `收到非QQ回复:${String(text).slice(-12)}` })
  const routeOwner = () => gw.routeTo(identity.owner()) || null
  const hub = createHub({
    dsh: fake.ctx,
    getConfig: () => cfg,
    log: noopLog,
    gateway: gw,
    identity,
    routeOwner,
    defaultPlatform: 'qq',
  })
  const offEvt = fake.ctx.on('session/event', hub.onSessionEvent)
  t.after(async () => {
    offEvt()
    hub.dispose()
    await gw.stopAll()
    fake.dispose()
  })

  const waitFor = async (pred, ms = 1500) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (pred()) return
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  // 1. 主动找 p-... 主人（没有 QQ 账号，routeOwner 选到飞书；发送经过网关回到飞书平台端）
  assert.equal(routeOwner(), 'feishu:private:ou_only_owner')
  const speakUp = createSpeakUp({ getConfig: () => cfg, hub, log: noopLog, identity, routeOwner })
  await speakUp.fire('test-noqq')
  await waitFor(() => adapter.sent.some((r) => r.payload?.chat?.id === 'ou_only_owner' && r.payload?.parts?.some((p) => /收到非QQ回复/.test(p.text || ''))))
  assert.ok(adapter.sent.some((r) => r.payload?.chat?.id === 'ou_only_owner' && r.payload?.parts?.some((p) => /收到非QQ回复/.test(p.text || ''))))

  // 2. 路由返回 null 时不抛错、不发送（例如平台断线导致 routeTo === null）
  adapter.disconnect()
  assert.equal(routeOwner(), null)
  const outCountBefore = adapter.sent.length
  await speakUp.fire('test-null-route')
  assert.equal(adapter.sent.length, outCountBefore)
  adapter.reconnect()
  assert.equal(routeOwner(), 'feishu:private:ou_only_owner')

  // 3. p-... 主人通过非 QQ 私聊发消息 + 命令解析
  assert.equal(parseCommand('/silent', [{ name: '/silent' }])?.name, 'silent')
  const prevCount = adapter.sent.length
  await hub.receiveOwnerMessage('feishu:private:ou_only_owner', { text: '在吗p主人', via: 'feishu' })
  await waitFor(() => adapter.sent.length > prevCount)
  assert.ok(adapter.sent.length > prevCount)
  assert.equal(adapter.sent.at(-1).payload?.chat?.id, 'ou_only_owner')
})

test('I3 双平台同一主人（QQ + 飞书）：共用同一按 PersonId 的每日主动发言额度', () => {
  const gwDir = mkdtempSync(join(root, 'dual-gw-'))
  const polDir = mkdtempSync(join(root, 'dual-pol-'))
  const identity = createIdentity({ dataDir: gwDir, log: noopLog })
  const ownerPerson = identity.claimOwner('qq', '10001')
  identity.link('feishu', 'ou_owner_b', ownerPerson, 'owner')

  let tNow = new Date(2026, 2, 10, 12, 0, 0, 0).getTime()
  const cfg = {
    enabled: true,
    speakUp: { enabled: true, awakeFrom: 0, awakeTo: 24, idleMinutes: 0, minIntervalMinutes: 1, maxIntervalMinutes: 1, maxPerDay: 5 },
    ext: { purpose: { enabled: true, awakeFrom: 0, awakeTo: 24, maxPerDay: 5, minIntervalMinutes: 1, maxIntervalMinutes: 1 } },
  }
  // 同一 ownerPerson 的共享预算，硬上限 2 次/天
  const budget = createSharedBudget({ owner: ownerPerson, dataDir: polDir, now: () => tNow, dailyMax: 2, minGapMs: 60_000, log: noopLog })
  const ownerChat = () => ownerChatsOf(identity)
  assert.deepEqual(ownerChat(), ['qq:private:10001', 'feishu:private:ou_owner_b'])

  const speakup = createSpeakupPolicy({
    getConfig: () => cfg,
    speakup: { state: () => ({ day: new Date(tNow).toDateString(), count: 0, nextAt: 0, last: 0 }) },
    now: () => tNow,
    dataDir: polDir,
    log: noopLog,
    lastPrivateAt: () => 0,
    isMuted: () => false,
    identity,
    owner: ownerPerson,
    ownerChat,
    budget,
  })
  const purpose = createPurposePolicy({
    getConfig: () => cfg,
    engine: { running: () => false },
    state: () => ({ countToday: 0, nextFireAt: 0, lastAttemptAt: 0, desires: [{ status: 'pending', trigger: 't1' }] }),
    now: () => tNow,
    dataDir: polDir,
    log: noopLog,
    identity,
    owner: ownerPerson,
    ownerChat,
    budget,
  })

  // 第 1 次：向 QQ 主人私聊发送并结算
  const r1 = speakup.reserve({ to: 'qq:private:10001', at: tNow })
  assert.equal(r1.ok, true)
  speakup.commit(r1.reserveId, { deliveryId: 'd1', outcome: 'sent' })

  // 经过 minGapMs 后，第 2 次：向飞书主人私聊发送并结算（与 QQ 共享同一预算）
  tNow += 2 * 60_000
  const r2 = purpose.reserve({ to: 'feishu:private:ou_owner_b', at: tNow })
  assert.equal(r2.ok, true)
  purpose.commit(r2.reserveId, { deliveryId: 'd2', outcome: 'sent' })

  // 经过足够长时间后尝试第 3 次（无论发到 QQ 还是飞书）：共享日上限 2 已满，统一返回 budget 拒绝
  tNow += 10 * 60_000
  const r3qq = speakup.reserve({ to: 'qq:private:10001', at: tNow })
  const r3fs = purpose.reserve({ to: 'feishu:private:ou_owner_b', at: tNow })
  assert.equal(r3qq.ok, false)
  assert.equal(r3qq.reason, 'budget')
  assert.equal(r3fs.ok, false)
  assert.equal(r3fs.reason, 'budget')

  // 陌生人私聊仍不在主人策略域内
  assert.equal(speakup.reserve({ to: 'feishu:private:10001', at: tNow }).reason, 'out-of-scope')
})
