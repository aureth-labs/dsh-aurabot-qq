// P1 · 单一主账号配置 + 纯只读集中式 resolveOwnerRoute + 防穿透 + 清除一致性验收测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize, mergeFromPanel, pickPlatformNeutralConfig, publicConfig } from '../src/core/config.js'
import { createHub } from '../src/chat/hub.js'
import { createIdentity } from '../src/gateway/identity.js'
import { createRouter } from '../src/gateway/router.js'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { startMockOneBot } from './helpers/mock-onebot.js'

const noopLog = { debug() {}, info() {}, warn() {}, error() {} }

function makeSandbox(t, prefix = 'aurabot-p1-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const prevData = process.env.AURABOT_DATA_DIR
  const prevWs = process.env.AURABOT_WORKSPACE
  process.env.AURABOT_DATA_DIR = dir
  process.env.AURABOT_WORKSPACE = join(dir, 'workspace')
  mkdirSync(join(dir, 'workspace'), { recursive: true })
  t.after(() => {
    if (prevData === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prevData
    if (prevWs === undefined) delete process.env.AURABOT_WORKSPACE
    else process.env.AURABOT_WORKSPACE = prevWs
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })
  return dir
}

async function callBridgeHello(fake, instance, token, caps) {
  const helloRoute = fake.routes.get(`/platform/${instance}/hello`)
  assert.ok(helloRoute, `应已注册 ${instance} /hello 路由`)
  let out = ''
  let status = 200
  await helloRoute.handler(
    {
      method: 'POST',
      headers: { 'x-bridge-token': token },
      rawBody: Buffer.from('{}'),
      body: { caps },
    },
    {
      set statusCode(v) { status = v },
      get statusCode() { return status },
      setHeader() {},
      end(s) { out = s },
    },
  )
  assert.equal(status, 200, out)
}

async function waitUntil(fn, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return false
}

test('P1-1：config.js ownerPrimary 默认值、normalize、mergeFromPanel 清空联动与中性字段迁移', () => {
  const def = normalize({})
  assert.deepEqual(def.ownerPrimary, {
    mode: 'fixed',
    platform: '',
    instance: '',
    account: '',
    fallback: false,
    noticeFallback: true,
    fallbackOrder: [],
  })

  // 非法值归一化与 publicConfig 保留
  const bad = normalize({
    ownerPrimary: { mode: 'invalid', platform: ' feishu ', instance: ' feishu#2 ', account: ' ou_1 ', fallback: 'yes', noticeFallback: undefined, fallbackOrder: 'bad' },
  })
  assert.deepEqual(bad.ownerPrimary, {
    mode: 'fixed',
    platform: 'feishu',
    instance: 'feishu#2',
    account: 'ou_1',
    fallback: false,
    noticeFallback: true,
    fallbackOrder: [],
  })
  assert.deepEqual(publicConfig(bad).ownerPrimary, bad.ownerPrimary)

  // fallbackOrder 归一化：去空格、单实例默认填 platform、滤除残缺项并去重
  const normOrder = normalize({
    ownerPrimary: {
      fallbackOrder: [
        { platform: ' feishu ', account: ' ou_1 ' },
        { platform: 'feishu', instance: 'feishu', account: 'ou_1' },
        { platform: 'bridge', instance: ' bridge#2 ', account: ' b_2 ' },
        { platform: 'qqbot', account: '' },
        'invalid',
      ],
    },
  })
  assert.deepEqual(normOrder.ownerPrimary.fallbackOrder, [
    { platform: 'feishu', instance: 'feishu', account: 'ou_1' },
    { platform: 'bridge', instance: 'bridge#2', account: 'b_2' },
  ])

  // recent 模式下强清三元组；切换 platform 清旧 instance/account；切换 instance 清旧 account；单传 account:'' 清空 account；均保留 fallbackOrder
  const step1 = mergeFromPanel(def, {
    ownerPrimary: {
      mode: 'fixed',
      platform: 'feishu',
      instance: 'feishu#2',
      account: 'ou_2',
      fallback: true,
      noticeFallback: false,
      fallbackOrder: [
        { platform: 'feishu', instance: 'feishu#2', account: 'ou_2' },
        { platform: 'bridge', instance: 'bridge', account: 'b_1' },
      ],
    },
  })
  assert.deepEqual(step1.ownerPrimary, {
    mode: 'fixed',
    platform: 'feishu',
    instance: 'feishu#2',
    account: 'ou_2',
    fallback: true,
    noticeFallback: false,
    fallbackOrder: [
      { platform: 'feishu', instance: 'feishu#2', account: 'ou_2' },
      { platform: 'bridge', instance: 'bridge', account: 'b_1' },
    ],
  })

  // 仅保存无关字段：保留 ownerPrimary 原样
  const stepUnrelated = mergeFromPanel(step1, { ownerName: '大主人' })
  assert.deepEqual(stepUnrelated.ownerPrimary, step1.ownerPrimary)

  // 保持 platform/instance 不变，仅显式传 account: '' → 清空 account
  const stepClearAcc = mergeFromPanel(step1, {
    ownerPrimary: { mode: 'fixed', platform: 'feishu', instance: 'feishu#2', account: '' },
  })
  assert.equal(stepClearAcc.ownerPrimary.platform, 'feishu')
  assert.equal(stepClearAcc.ownerPrimary.instance, 'feishu#2')
  assert.equal(stepClearAcc.ownerPrimary.account, '')

  // 同 platform 仅切换 instance → 清空旧 account
  const stepSwitchInst = mergeFromPanel(step1, { ownerPrimary: { instance: 'feishu' } })
  assert.equal(stepSwitchInst.ownerPrimary.platform, 'feishu')
  assert.equal(stepSwitchInst.ownerPrimary.instance, 'feishu')
  assert.equal(stepSwitchInst.ownerPrimary.account, '')

  // 切换 platform → 清空旧 instance 与 account（不丢失 fallbackOrder）
  const stepSwitchPlat = mergeFromPanel(step1, { ownerPrimary: { platform: 'qqbot' } })
  assert.equal(stepSwitchPlat.ownerPrimary.platform, 'qqbot')
  assert.equal(stepSwitchPlat.ownerPrimary.instance, '')
  assert.equal(stepSwitchPlat.ownerPrimary.account, '')
  assert.deepEqual(stepSwitchPlat.ownerPrimary.fallbackOrder, step1.ownerPrimary.fallbackOrder)

  // 从 fixed 切到 recent → 强制清空三元组，同时保留 fallbackOrder
  const stepRecent = mergeFromPanel(step1, { ownerPrimary: { mode: 'recent' } })
  assert.deepEqual(stepRecent.ownerPrimary, {
    mode: 'recent',
    platform: '',
    instance: '',
    account: '',
    fallback: true,
    noticeFallback: false,
    fallbackOrder: [
      { platform: 'feishu', instance: 'feishu#2', account: 'ou_2' },
      { platform: 'bridge', instance: 'bridge', account: 'b_1' },
    ],
  })

  // 显式清空 fallbackOrder: []
  const stepClearOrder = mergeFromPanel(step1, { ownerPrimary: { fallbackOrder: [] } })
  assert.deepEqual(stepClearOrder.ownerPrimary.fallbackOrder, [])

  // pickPlatformNeutralConfig 保留 ownerPrimary
  const picked = pickPlatformNeutralConfig(step1)
  assert.deepEqual(picked.ownerPrimary, step1.ownerPrimary)
})

test('P1-2 & P1-3：resolveOwnerRoute 多实例/多账号精确匹配、blocking 语义（unlinked/offline/proactive-none）及 A/B 类回退区分', async (t) => {
  const dir = makeSandbox(t, 'aurabot-p1-multi-')
  const mockOb = await startMockOneBot({ selfId: '20000002' })
  t.after(() => mockOb.close())

  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    enabled: true,
    dryRun: false,
    setupDone: true,
    gateway: 'onebot',
    snowluma: { httpUrl: mockOb.httpUrl, wsUrl: mockOb.wsUrl, httpToken: mockOb.token, wsToken: mockOb.token, autoStart: false, autoAttach: false },
    botQQ: '20000002',
    ownerQQ: '10001',
    allow: { private: ['10001'], groups: [] },
    platforms: {
      bridge: { enabled: true, token: 'tok-1' },
      'bridge#2': { enabled: true, token: 'tok-2' },
    },
    voice: { engine: 'windows', autoChance: 0 },
    stickers: { autoChance: 0 },
  }))

  const fake = createFakeDsh({ brain: async () => '嗯' })
  fake.ctx.webServer.port = 5101
  const host = await import('../src/host.js')
  const api = host.apply(fake.ctx)
  t.after(async () => {
    fake.dispose()
    await new Promise((r) => setTimeout(r, 30))
  })
  await api.ready.catch(() => {})

  assert.equal(await waitUntil(() => {
    const gw = api.gateway
    const list = gw?.instances?.() || []
    return list.some((x) => x.instance === 'bridge' && x.state === 'connected')
      && list.some((x) => x.instance === 'bridge#2' && x.state === 'connected')
  }), true, 'bridge 与 bridge#2 均应连接成功')

  // 确认旧版 QQ 已连上（legacy external instance）
  assert.equal(await waitUntil(() => mockOb.connected() >= 1 && api.resolveOwnerRoute().reason === 'ok', 4000), true)

  // 1) 未配置 ownerPrimary（向后兼容）：旧版 QQ / 网关正常生效
  assert.equal(api.resolveOwnerRoute({ purpose: 'proactive' }).chatId, 'private:10001')

  // 给主人绑定两个 bridge 账号与一个 qqbot 账号，再解绑第三个账号用于校验越权/解绑
  const ownerId = api.hub.sessions && (await fake.call('/platforms/people')).json().owner
  assert.ok(ownerId)
  // 用 identity 通过 platform/unlink API 测试解绑前先通过 bridge/inbound 或 hub 无法直接 link？改为验证 gateway.identity
  const gw = api.gateway
  gw.identity.link('bridge', 'b_one', ownerId, 'manual')
  gw.identity.link('bridge', 'b_two', ownerId, 'manual')
  gw.identity.link('bridge', 'b_unseen', ownerId, 'manual')
  // 记录实例级账号归属：b_one 属于 bridge，b_two 属于 bridge#2（同平台多实例隔离）；b_unseen 从未在任何实例出现
  gw.routing.noteAccountInstance('bridge', 'bridge', 'b_one')
  gw.routing.noteAccountInstance('bridge#2', 'bridge', 'b_two')
  assert.deepEqual(gw.routing.instancesForAccount('bridge', 'b_one'), ['bridge'])
  assert.deepEqual(gw.routing.instancesForAccount('bridge', 'b_two'), ['bridge#2'])
  assert.deepEqual(gw.routing.instancesForAccount('bridge', 'b_unseen'), [])
  assert.deepEqual(gw.routing.accountsForInstance('bridge', 'bridge'), ['b_one'])
  assert.deepEqual(gw.routing.accountsForInstance('bridge#2', 'bridge'), ['b_two'])
  const otherPerson = gw.identity.resolve('bridge', 'b_stranger')
  assert.notEqual(otherPerson, ownerId)

  // bridge 仅开启收消息能力（proactive === 'none'），bridge#2 声明 proactive === 'free'
  await callBridgeHello(fake, 'bridge#2', 'tok-2', { proactive: 'free' })

  // 1b) 无 ownerPrimary 且主人最近在 bridge#2 私聊过（router.seen 已记）+ QQ 在线 → 主动消息与通知仍优先 QQ，不漂移到 seen！
  gw.noteSeen(ownerId, 'bridge#2:private:b_two', Date.now())
  assert.equal(api.resolveOwnerRoute({ purpose: 'proactive' }).chatId, 'private:10001')
  assert.equal(api.resolveOwnerRoute({ purpose: 'notice' }).chatId, 'private:10001')

  // 2) 多实例 + 多账号精确命中 bridge#2 + b_two（即便 bridge 在前且 caps.proactive === 'none'、QQ 在线）
  api.setConfig(mergeFromPanel(api.getConfig(), {
    ownerPrimary: { mode: 'fixed', platform: 'bridge', instance: 'bridge#2', account: 'b_two', fallback: false, noticeFallback: true },
  }))
  const hitMulti = api.resolveOwnerRoute({ purpose: 'proactive' })
  assert.equal(hitMulti.blocked, false)
  assert.equal(hitMulti.reason, 'ok')
  assert.equal(hitMulti.chatId, 'bridge#2:private:b_two')
  assert.deepEqual(hitMulti.target, { platform: 'bridge', instance: 'bridge#2', account: 'b_two' })
  assert.equal(api.proactHealth(), null)

  // 3) 仅清空 account (account: '') → 优先按目标实例 bridge#2 自动选中 b_two（绝不盲取 b_one）
  api.setConfig(mergeFromPanel(api.getConfig(), {
    ownerPrimary: { mode: 'fixed', platform: 'bridge', instance: 'bridge#2', account: '' },
  }))
  const hitAutoAcc = api.resolveOwnerRoute({ purpose: 'proactive' })
  assert.equal(hitAutoAcc.blocked, false)
  assert.equal(hitAutoAcc.chatId, 'bridge#2:private:b_two')

  // 3b) 跨实例错配与同平台多实例未归属账号：
  //     b_one 属于 bridge → 配到 bridge#2 报 primary-unlinked；
  //     b_unseen 从未在任何实例出现 → 同平台多实例下无从证明归属 bridge#2，同样报 primary-unlinked
  api.setConfig(mergeFromPanel(api.getConfig(), {
    ownerPrimary: { mode: 'fixed', platform: 'bridge', instance: 'bridge#2', account: 'b_one', fallback: false },
  }))
  const blockedCrossInst = api.resolveOwnerRoute({ purpose: 'proactive' })
  assert.equal(blockedCrossInst.blocked, true)
  assert.equal(blockedCrossInst.reason, 'primary-unlinked')
  assert.equal(blockedCrossInst.chatId, '')

  api.setConfig(mergeFromPanel(api.getConfig(), {
    ownerPrimary: { mode: 'fixed', platform: 'bridge', instance: 'bridge#2', account: 'b_unseen', fallback: false },
  }))
  const blockedUnseenMulti = api.resolveOwnerRoute({ purpose: 'proactive' })
  assert.equal(blockedUnseenMulti.blocked, true)
  assert.equal(blockedUnseenMulti.reason, 'primary-unlinked')
  assert.equal(blockedUnseenMulti.chatId, '')

  // 4) 指定 instance='bridge'（caps.proactive === 'none'）+ 归属 bridge 的 b_one → fallback=false 阻塞并报 primary-proactive-none，绝不跳去 bridge#2 或 QQ！
  api.setConfig(mergeFromPanel(api.getConfig(), {
    ownerPrimary: { mode: 'fixed', platform: 'bridge', instance: 'bridge', account: 'b_one', fallback: false, noticeFallback: true },
  }))
  const blockedNone = api.resolveOwnerRoute({ purpose: 'proactive' })
  assert.equal(blockedNone.blocked, true)
  assert.equal(blockedNone.reason, 'primary-proactive-none')
  assert.equal(blockedNone.chatId, '')
  assert.equal(api.hub.ownerChat(), '')
  assert.equal(api.proactHealth()?.reason, 'primary-proactive-none')

  // 同一配置下 purpose: 'notice'（noticeFallback: true）→ 允许回退到 online & proactive!=='none' 的 bridge#2（绝不选 caps='none'）
  const noticeFallback = api.resolveOwnerRoute({ purpose: 'notice' })
  assert.equal(noticeFallback.blocked, false)
  assert.equal(noticeFallback.fallbackUsed, true)
  assert.equal(noticeFallback.reason, 'fallback-used')
  assert.equal(noticeFallback.chatId, 'bridge#2:private:b_two')

  // 关闭 noticeFallback → /test-send 必须返回 blocked: true 且不发出消息
  api.setConfig(mergeFromPanel(api.getConfig(), {
    ownerPrimary: { noticeFallback: false },
  }))
  const obSentBefore = mockOb.sent('send_private_msg').length
  const testSendBlocked = (await fake.call('/test-send', {})).json()
  assert.equal(testSendBlocked.ok, false)
  assert.equal(testSendBlocked.blocked, true)
  assert.equal(testSendBlocked.reason, 'primary-proactive-none')
  assert.equal(mockOb.sent('send_private_msg').length, obSentBefore)

  // 5) 账号解绑或属于别人 → primary-unlinked（即便 fallback=false 且同类 bridge 其他账号还在）
  api.setConfig(mergeFromPanel(api.getConfig(), {
    ownerPrimary: { mode: 'fixed', platform: 'bridge', instance: 'bridge#2', account: 'b_stranger', fallback: false },
  }))
  const blockedOther = api.resolveOwnerRoute({ purpose: 'proactive' })
  assert.equal(blockedOther.blocked, true)
  assert.equal(blockedOther.reason, 'primary-unlinked')
  assert.equal(blockedOther.chatId, '')

  gw.identity.unlink('bridge', 'b_unseen')
  api.setConfig(mergeFromPanel(api.getConfig(), {
    ownerPrimary: { mode: 'fixed', platform: 'bridge', instance: 'bridge#2', account: 'b_unseen', fallback: false },
  }))
  const blockedUnlinked = api.resolveOwnerRoute({ purpose: 'proactive' })
  assert.equal(blockedUnlinked.blocked, true)
  assert.equal(blockedUnlinked.reason, 'primary-unlinked')
  assert.equal(blockedUnlinked.chatId, '')

  // 6) 实例离线 / 停用 → primary-offline（fallback=false 阻塞；fallback=true 回退）
  api.setConfig(mergeFromPanel(api.getConfig(), {
    ownerPrimary: { mode: 'fixed', platform: 'bridge', instance: 'bridge#missing', account: 'b_one', fallback: false },
  }))
  const blockedOffline = api.resolveOwnerRoute({ purpose: 'proactive' })
  assert.equal(blockedOffline.blocked, true)
  assert.equal(blockedOffline.reason, 'primary-offline')
  assert.equal(blockedOffline.chatId, '')

  api.setConfig(mergeFromPanel(api.getConfig(), {
    ownerPrimary: { fallback: true },
  }))
  const allowProactiveFallback = api.resolveOwnerRoute({ purpose: 'proactive' })
  assert.equal(allowProactiveFallback.blocked, false)
  assert.equal(allowProactiveFallback.fallbackUsed, true)
  assert.equal(allowProactiveFallback.reason, 'fallback-used')
  assert.match(allowProactiveFallback.chatId, /^bridge#2:private:/)

  // 7) 明确选择旧版直连 QQ 且在线 → 返回 private:10001 并清除 blocked 健康态
  api.setConfig(mergeFromPanel(api.getConfig(), {
    ownerPrimary: { mode: 'fixed', platform: 'qq', instance: 'qq', account: '10001', fallback: false },
  }))
  const hitLegacyQq = api.resolveOwnerRoute({ purpose: 'proactive' })
  assert.equal(hitLegacyQq.blocked, false)
  assert.equal(hitLegacyQq.reason, 'ok')
  assert.equal(hitLegacyQq.chatId, 'private:10001')
  assert.equal(api.proactHealth(), null)
})

test('P1-4：hub.ownerChat() 注入 resolveOwnerRoute 后在 blocked 与 no-route 时均严格返回空串，绝不穿透回 QQ', (t) => {
  const dir = makeSandbox(t, 'aurabot-p1-hub-')
  const identity = createIdentity({ dataDir: join(dir, 'gw'), log: noopLog })
  const owner = identity.claimOwner('qq', '10001')
  identity.link('feishu', 'ou_owner', owner, 'owner')

  const cfg = normalize({
    enabled: true, dryRun: true, setupDone: true, botQQ: '20000002', ownerQQ: '10001',
    voice: { enabled: false }, merge: { enabled: false }, stickers: { enabled: false, collect: false },
    allow: { private: ['10001'], groups: [] },
  })

  let currentRoute = { chatId: '', blocked: true, reason: 'primary-offline', target: null, fallbackUsed: false }
  const fake = createFakeDsh({ brain: async () => '' })
  const hub = createHub({
    dsh: fake.ctx,
    getConfig: () => cfg,
    log: noopLog,
    gateway: {
      routeTo: () => 'feishu:private:ou_owner',
      caps: () => null,
      features: () => ({}),
      onCapsChanged: () => () => {},
    },
    identity,
    resolveOwnerRoute: () => currentRoute,
    routeOwner: () => (currentRoute.blocked ? '' : currentRoute.chatId),
  })
  t.after(() => {
    hub.dispose()
    fake.dispose()
  })

  // blocked: true 不穿透到 gateway.routeTo / private:10001 / accounts[0]
  assert.equal(hub.ownerChat(), '')

  // reason: 'no-route' 同样不穿透
  currentRoute = { chatId: '', blocked: false, reason: 'no-route', target: null, fallbackUsed: false }
  assert.equal(hub.ownerChat(), '')

  // 正常命中则返回目标 chatId
  currentRoute = { chatId: 'feishu:private:ou_owner', blocked: false, reason: 'ok', target: null, fallbackUsed: false }
  assert.equal(hub.ownerChat(), 'feishu:private:ou_owner')
})

test('P1-5：resolveOwnerRoute 纯只读零写 router.json；启动迁移与 setConfig 仅按非空幂等清理 router.fixed[owner] 一次', async (t) => {
  const dir = makeSandbox(t, 'aurabot-p1-readonly-')
  const routerDir = join(dir, 'gateway', 'gateway')
  const routerFile = join(routerDir, 'router.json')

  const identity = createIdentity({ dataDir: join(dir, 'gateway'), log: noopLog })
  const owner = identity.claimOwner('qq', '10001')
  identity.link('bridge', 'b_owner', owner, 'manual')

  // 预置旧版遗留的 router.fixed[owner] = 'bridge'
  mkdirSync(routerDir, { recursive: true })
  writeFileSync(routerFile, JSON.stringify({
    fixed: { [owner]: 'bridge' },
    seen: {},
    kinds: {},
  }))

  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    enabled: false,
    dryRun: true,
    setupDone: true,
    platforms: { bridge: { enabled: true, token: 'tok-ro' } },
    snowluma: { autoStart: false, autoAttach: false },
    voice: { engine: 'windows', autoChance: 0 },
    stickers: { autoChance: 0 },
  }))

  const fake = createFakeDsh({ brain: async () => '' })
  fake.ctx.webServer.port = 5102
  const host = await import('../src/host.js')
  const api = host.apply(fake.ctx)
  t.after(async () => {
    fake.dispose()
    await new Promise((r) => setTimeout(r, 30))
  })
  await api.ready.catch(() => {})

  assert.equal(await waitUntil(() => {
    const list = api.gateway?.instances?.() || []
    return list.some((x) => x.instance === 'bridge' && x.state === 'connected')
  }), true)

  // 启动迁移应将旧 router.fixed[owner]='bridge' 迁入 ownerPrimary.platform 并清零 router.fixed[owner]
  assert.equal(api.getConfig().ownerPrimary.platform, 'bridge')
  assert.equal(existsSync(routerFile), true)
  const afterMigrate = JSON.parse(readFileSync(routerFile, 'utf8'))
  assert.equal(afterMigrate.fixed?.[owner] || '', '')

  // 监测 setFixed 调用与 router.json 修改时间戳
  const originalSetFixed = api.gateway.routing.setFixed
  let setFixedCount = 0
  api.gateway.routing.setFixed = (...args) => {
    setFixedCount += 1
    return originalSetFixed(...args)
  }
  const mtimeBeforeRead = statSync(routerFile).mtimeMs

  await new Promise((r) => setTimeout(r, 30))
  // 连续多次只读调用 resolveOwnerRoute（无论 ok / blocked / recent）：0 次 setFixed、router.json 零写入
  await callBridgeHello(fake, 'bridge', 'tok-ro', { proactive: 'free' })
  for (let i = 0; i < 5; i++) {
    assert.equal(api.resolveOwnerRoute({ purpose: 'proactive' }).chatId, 'bridge:private:b_owner')
    assert.equal(api.resolveOwnerRoute({ purpose: 'notice' }).chatId, 'bridge:private:b_owner')
  }
  assert.equal(setFixedCount, 0, 'resolveOwnerRoute 绝不能调用 setFixed')
  assert.equal(statSync(routerFile).mtimeMs, mtimeBeforeRead, 'resolveOwnerRoute 绝不能写 router.json')

  // 当 router.fixed[owner] 已清空后，重复 setConfig 保存配置不得再写 router.json 或调 setFixed
  api.setConfig(mergeFromPanel(api.getConfig(), { ownerPrimary: { mode: 'recent' } }))
  api.setConfig(mergeFromPanel(api.getConfig(), { ownerPrimary: { mode: 'fixed', platform: 'bridge', instance: 'bridge', account: 'b_owner' } }))
  assert.equal(setFixedCount, 0, 'router.fixed[owner] 已为空时，setConfig 不得反复调 setFixed')
  assert.equal(statSync(routerFile).mtimeMs, mtimeBeforeRead, 'router.fixed[owner] 已为空时，setConfig 不得重写 router.json')

  // 若外部遗留写入了非空 fixed，下一次 setConfig 应幂等清理一次
  originalSetFixed(owner, 'qq')
  assert.equal(api.gateway.routing.fixedPlatform(owner), 'qq')
  api.setConfig(mergeFromPanel(api.getConfig(), { ownerPrimary: { mode: 'recent' } }))
  assert.equal(setFixedCount, 1, '检测到非空 router.fixed[owner] 时 setConfig 清理一次')
  assert.equal(api.gateway.routing.fixedPlatform(owner), null)
})

test('P1-6：syncOwnerFixedCleanup 迁入 saveConfig 失败时保留旧 router.fixed 供下次启动重试', async (t) => {
  const dir = makeSandbox(t, 'aurabot-p1-migrate-fail-')
  const routerDir = join(dir, 'gateway', 'gateway')
  const routerFile = join(routerDir, 'router.json')

  const identity = createIdentity({ dataDir: join(dir, 'gateway'), log: noopLog })
  const owner = identity.claimOwner('qq', '10001')
  identity.link('bridge', 'b_owner', owner, 'manual')

  mkdirSync(routerDir, { recursive: true })
  writeFileSync(routerFile, JSON.stringify({
    fixed: { [owner]: 'bridge' },
    seen: {},
    kinds: {},
  }))

  const cfgFile = join(dir, 'config.json')
  writeFileSync(cfgFile, JSON.stringify({
    enabled: false,
    dryRun: true,
    setupDone: true,
    platforms: {},
    snowluma: { autoStart: false, autoAttach: false },
    voice: { engine: 'windows', autoChance: 0 },
    stickers: { autoChance: 0 },
  }))

  const fake = createFakeDsh({ brain: async () => '' })
  fake.ctx.webServer.port = 5103
  const host = await import('../src/host.js')
  const api = host.apply(fake.ctx)
  t.after(async () => {
    fake.dispose()
    await new Promise((r) => setTimeout(r, 30))
  })
  await api.ready.catch(() => {})

  // 制造 saveConfig 落盘失败条件：将 config.json 替换为同名目录（renameSync 必然抛错）
  unlinkSync(cfgFile)
  mkdirSync(cfgFile, { recursive: true })

  // 触发懒建网关与 syncOwnerFixedCleanup({ allowMigrate: true })
  await fake.call('/platforms/people')

  // 迁移写配置失败时，旧 router.fixed[owner] 必须原样保留，绝不清空
  const preserved = JSON.parse(readFileSync(routerFile, 'utf8'))
  assert.equal(preserved.fixed?.[owner], 'bridge')
  assert.equal(api.gateway?.routing?.fixedPlatform?.(owner), 'bridge')
})

test('P1-7：旧配置无 ownerPrimary 时即使 router.seen 为其他平台仍默认回 QQ（QQ离线阻塞不漂移、显式 recent 才跟随、未观测单实例给告警）', async (t) => {
  const dir = makeSandbox(t, 'aurabot-p1-legacy-qq-')
  const mockOb = await startMockOneBot({ selfId: '20000002' })
  t.after(() => mockOb.close())

  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    enabled: true,
    dryRun: false,
    setupDone: true,
    gateway: 'onebot',
    snowluma: { httpUrl: mockOb.httpUrl, wsUrl: mockOb.wsUrl, httpToken: mockOb.token, wsToken: mockOb.token, autoStart: false, autoAttach: false },
    botQQ: '20000002',
    ownerQQ: '10001',
    allow: { private: ['10001'], groups: [] },
    platforms: { bridge: { enabled: true, token: 'tok-single' } },
    voice: { engine: 'windows', autoChance: 0 },
    stickers: { autoChance: 0 },
  }))

  const fake = createFakeDsh({ brain: async () => '嗯' })
  fake.ctx.webServer.port = 5104
  const host = await import('../src/host.js')
  const api = host.apply(fake.ctx)
  t.after(async () => {
    fake.dispose()
    await new Promise((r) => setTimeout(r, 30))
  })
  await api.ready.catch(() => {})

  assert.equal(await waitUntil(() => {
    const list = api.gateway?.instances?.() || []
    return list.some((x) => x.instance === 'bridge' && x.state === 'connected')
  }), true)
  assert.equal(await waitUntil(() => mockOb.connected() >= 1 && api.resolveOwnerRoute().reason === 'ok', 4000), true)

  const gw = api.gateway
  const ownerId = gw.identity.owner()
  gw.identity.link('bridge', 'b_single_unseen', ownerId, 'manual')
  await callBridgeHello(fake, 'bridge', 'tok-single', { proactive: 'free' })
  gw.noteSeen(ownerId, 'bridge:private:b_single_unseen', Date.now())

  // 未配置 ownerPrimary + bridge 已在 seen + QQ 在线 → 必须回 QQ
  const hitLegacy = api.resolveOwnerRoute({ purpose: 'proactive' })
  assert.equal(hitLegacy.blocked, false)
  assert.equal(hitLegacy.reason, 'ok')
  assert.equal(hitLegacy.chatId, 'private:10001')

  // 若此时 QQ 离线且未开启回退（默认 fallback: false）：proactive 不得漂移到 router.seen（bridge），notice 允许回退
  api.onebot.stop()
  const offProactive = api.resolveOwnerRoute({ purpose: 'proactive' })
  assert.equal(offProactive.blocked, true)
  assert.equal(offProactive.reason, 'primary-offline')
  assert.equal(offProactive.chatId, '')
  assert.equal(api.hub.ownerChat(), '')

  const offNotice = api.resolveOwnerRoute({ purpose: 'notice' })
  assert.equal(offNotice.blocked, false)
  assert.equal(offNotice.fallbackUsed, true)
  assert.equal(offNotice.chatId, 'bridge:private:b_single_unseen')

  // 显式切到 mode='recent' 后，才允许跟随 router.seen 发给 bridge
  api.setConfig(mergeFromPanel(api.getConfig(), { ownerPrimary: { mode: 'recent' } }))
  const hitRecent = api.resolveOwnerRoute({ purpose: 'proactive' })
  assert.equal(hitRecent.blocked, false)
  assert.equal(hitRecent.reason, 'ok')
  assert.equal(hitRecent.chatId, 'bridge:private:b_single_unseen')

  // 单实例平台 + 未观测到 instanceAccounts 仅绑定了账号时：允许按唯一单实例发送，且不改写 router.json
  gw.identity.link('bridge', 'b_only_linked', ownerId, 'manual')
  api.setConfig(mergeFromPanel(api.getConfig(), {
    ownerPrimary: { mode: 'fixed', platform: 'bridge', instance: 'bridge', account: 'b_only_linked', fallback: false },
  }))
  const hitSingleUnseen = api.resolveOwnerRoute({ purpose: 'proactive' })
  assert.equal(hitSingleUnseen.blocked, false)
  assert.equal(hitSingleUnseen.chatId, 'bridge:private:b_only_linked')
})

test('P1-8：旧 router.json 仅含 seen 无 instanceAccounts 时只读推导实例归属，且 allowMigrate=false 不清未迁移 fixed', async (t) => {
  const dir = makeSandbox(t, 'aurabot-p1-seen-fallback-')
  const routerDir = join(dir, 'gateway', 'gateway')
  const routerFile = join(routerDir, 'router.json')
  mkdirSync(routerDir, { recursive: true })
  writeFileSync(routerFile, JSON.stringify({
    fixed: {},
    seen: { 'p-owner': { chatId: 'feishu#2:private:ou_old', at: 1700000000000 } },
    kinds: {},
  }))
  const mtimeBefore = statSync(routerFile).mtimeMs

  const router = createRouter({ file: routerFile, log: noopLog })
  assert.deepEqual(router.instancesForAccount('feishu', 'ou_old'), ['feishu#2'])
  assert.deepEqual(router.accountsForInstance('feishu#2', 'feishu'), ['ou_old'])
  assert.equal(statSync(routerFile).mtimeMs, mtimeBefore, '只读推导不得写 router.json')

  // 验证 allowMigrate=false 时：当 ownerPrimary 仍为空（fixed + platform/instance 均空），setConfig 不得清掉外部/未迁移的 router.fixed
  const cfgDir = makeSandbox(t, 'aurabot-p1-nomigrate-clear-')
  writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({
    enabled: false,
    dryRun: true,
    setupDone: true,
    platforms: { bridge: { enabled: true, token: 'tok-nm' } },
    snowluma: { autoStart: false, autoAttach: false },
    voice: { engine: 'windows', autoChance: 0 },
    stickers: { autoChance: 0 },
  }))
  const fake = createFakeDsh({ brain: async () => '' })
  fake.ctx.webServer.port = 5105
  const host = await import('../src/host.js')
  const api = host.apply(fake.ctx)
  t.after(async () => {
    fake.dispose()
    await new Promise((r) => setTimeout(r, 30))
  })
  await api.ready.catch(() => {})
  assert.equal(await waitUntil(() => (api.gateway?.instances?.() || []).some((x) => x.instance === 'bridge')), true)

  const gw = api.gateway
  const ownerId = gw.identity.claimOwner('bridge', 'b_nm')
  gw.routing.setFixed(ownerId, 'bridge')
  assert.equal(gw.routing.fixedPlatform(ownerId), 'bridge')
  api.setConfig(mergeFromPanel(api.getConfig(), { dryRun: false }))
  assert.equal(gw.routing.fixedPlatform(ownerId), 'bridge', 'ownerPrimary 尚未写入时 allowMigrate=false 不得清掉未迁移的 fixed')
})

test('P1-9：存在已停用的 QQ 实例配置（platforms.qq.enabled=false）且直连 QQ 关闭时，不误判 implicitLegacyQq 阻塞其他平台', async (t) => {
  const dir = makeSandbox(t, 'aurabot-p1-disabled-qq-')
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    enabled: false,
    dryRun: true,
    setupDone: true,
    ownerQQ: '',
    platforms: {
      qq: { enabled: false },
      bridge: { enabled: true, token: 'tok-dq' },
    },
    snowluma: { autoStart: false, autoAttach: false },
    voice: { engine: 'windows', autoChance: 0 },
    stickers: { autoChance: 0 },
  }))

  const fake = createFakeDsh({ brain: async () => '' })
  fake.ctx.webServer.port = 5106
  const host = await import('../src/host.js')
  const api = host.apply(fake.ctx)
  t.after(async () => {
    fake.dispose()
    await new Promise((r) => setTimeout(r, 30))
  })
  await api.ready.catch(() => {})
  assert.equal(await waitUntil(() => {
    const list = api.gateway?.instances?.() || []
    return list.some((x) => x.instance === 'bridge' && x.state === 'connected')
  }), true)

  const gw = api.gateway
  const ownerId = gw.identity.claimOwner('qq', '10001')
  gw.identity.link('bridge', 'b_dq', ownerId, 'manual')
  await callBridgeHello(fake, 'bridge', 'tok-dq', { proactive: 'free' })
  gw.noteSeen(ownerId, 'bridge:private:b_dq', Date.now())

  // 主人名下有 qq 账号且 platforms.qq 存在但 enabled=false，直连 QQ 也未启用 → 不得按 implicitLegacyQq 报 primary-offline，应正常走可用平台
  const route = api.resolveOwnerRoute({ purpose: 'proactive' })
  assert.equal(route.blocked, false)
  assert.equal(route.reason, 'ok')
  assert.equal(route.chatId, 'bridge:private:b_dq')
})

async function startFakeFeishuServer(t) {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url?.includes('/auth/v3/tenant_access_token/internal')) {
      res.end(JSON.stringify({ code: 0, tenant_access_token: 'tenant-tok-golden', expire: 7200 }))
      return
    }
    res.end(JSON.stringify({ code: 0, data: {} }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  t.after(() => new Promise((resolve) => server.close(() => resolve())))
  return { baseUrl: `http://127.0.0.1:${addr.port}` }
}

test('P1-10：Golden Tests（evaluateOwnerTarget 纯重构等价性与 9 类基线路由边界）', async (t) => {
  // 组 1：含传统直连 QQ + 飞书(webhook) + 多实例 bridge + proactive=none 全矩阵
  const dir = makeSandbox(t, 'aurabot-p1-golden-')
  const mockOb = await startMockOneBot({ selfId: '20000002' })
  const feishuStub = await startFakeFeishuServer(t)
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    enabled: true,
    dryRun: false,
    setupDone: true,
    gateway: 'onebot',
    snowluma: { httpUrl: mockOb.httpUrl, wsUrl: mockOb.wsUrl, httpToken: mockOb.token, wsToken: mockOb.token, autoStart: false, autoAttach: false },
    botQQ: '20000002',
    ownerQQ: '10001',
    allow: { private: ['10001'], groups: [] },
    platforms: {
      feishu: { enabled: true, transport: 'webhook', appId: 'cli_gold', appSecret: 'sec_gold', verificationToken: 'vt-gold', baseUrl: feishuStub.baseUrl },
      bridge: { enabled: true, token: 'tok-g1' },
      'bridge#2': { enabled: true, token: 'tok-g2' },
    },
    voice: { engine: 'windows', autoChance: 0 },
    stickers: { autoChance: 0 },
  }))

  const fake = createFakeDsh({ brain: async () => '' })
  fake.ctx.webServer.port = 5111
  const host = await import('../src/host.js')
  const api = host.apply(fake.ctx)
  t.after(async () => {
    try { await mockOb.close() } catch {}
    fake.dispose()
    await new Promise((r) => setTimeout(r, 30))
  })
  await api.ready.catch(() => {})
  assert.equal(await waitUntil(() => {
    const list = api.gateway?.instances?.() || []
    return list.some((x) => x.instance === 'feishu' && x.state === 'connected')
      && list.some((x) => x.instance === 'bridge' && x.state === 'connected')
      && list.some((x) => x.instance === 'bridge#2' && x.state === 'connected')
      && mockOb.connected() >= 1
      && api.resolveOwnerRoute().reason === 'ok'
  }, 5000), true, '传统 QQ、飞书 webhook、bridge 与 bridge#2 均应连上')

  const gw = api.gateway
  const ownerId = gw.identity.owner()
  gw.identity.link('feishu', 'ou_gold', ownerId, 'manual')
  gw.identity.link('bridge', 'b_1', ownerId, 'manual')
  gw.identity.link('bridge', 'b_2', ownerId, 'manual')
  gw.identity.link('bridge', 'b_unseen', ownerId, 'manual')
  gw.routing.noteAccountInstance('bridge', 'bridge', 'b_1')
  gw.routing.noteAccountInstance('bridge#2', 'bridge', 'b_2')
  // bridge 仅被动回复；bridge#2 与 feishu 可主动发送
  await callBridgeHello(fake, 'bridge', 'tok-g1', { proactive: 'none' })
  await callBridgeHello(fake, 'bridge#2', 'tok-g2', { proactive: 'free' })

  // 1) fixed + implicitLegacyQq：即便最近在飞书私聊过，默认仍优先走传统 QQ
  gw.noteSeen(ownerId, 'feishu:private:ou_gold', Date.now())
  const rImplicit = api.resolveOwnerRoute({ purpose: 'proactive' })
  assert.deepEqual(rImplicit, {
    chatId: 'private:10001',
    blocked: false,
    reason: 'ok',
    target: { platform: 'qq', instance: 'qq', account: '10001' },
    fallbackUsed: false,
  })

  // 2) fixed + 显式 QQ（在线）
  api.setConfig(mergeFromPanel(api.getConfig(), {
    ownerPrimary: { mode: 'fixed', platform: 'qq', instance: 'qq', account: '10001', fallback: false, noticeFallback: true },
  }))
  const rExplicitQq = api.resolveOwnerRoute({ purpose: 'proactive' })
  assert.equal(rExplicitQq.chatId, 'private:10001')
  assert.equal(rExplicitQq.blocked, false)

  // 3) fixed + 飞书
  api.setConfig(mergeFromPanel(api.getConfig(), {
    ownerPrimary: { mode: 'fixed', platform: 'feishu', instance: 'feishu', account: 'ou_gold', fallback: false, noticeFallback: true },
  }))
  const rFeishu = api.resolveOwnerRoute({ purpose: 'proactive' })
  assert.deepEqual(rFeishu, {
    chatId: 'feishu:private:ou_gold',
    blocked: false,
    reason: 'ok',
    target: { platform: 'feishu', instance: 'feishu', account: 'ou_gold' },
    fallbackUsed: false,
  })

  // 4) recent + 有效 lastSeen（bridge#2:private:b_2）
  gw.noteSeen(ownerId, 'bridge#2:private:b_2', Date.now())
  api.setConfig(mergeFromPanel(api.getConfig(), {
    ownerPrimary: { mode: 'recent' },
  }))
  const rRecentPrivate = api.resolveOwnerRoute({ purpose: 'proactive' })
  assert.equal(rRecentPrivate.chatId, 'bridge#2:private:b_2')
  assert.equal(rRecentPrivate.fallbackUsed, false)

  // 5) recent + 群聊/陌生人 lastSeen（改造前基线：noteSeen 拒绝写入 group 地址，陌生人/无归属实例在 routeTo 被跳过，绝不发往 group 或 stranger）
  gw.noteSeen(ownerId, 'feishu:group:oc_gold', Date.now())
  const rAfterGroupNote = api.resolveOwnerRoute({ purpose: 'proactive' })
  assert.equal(rAfterGroupNote.chatId, 'bridge#2:private:b_2', 'noteSeen 拒绝用 group 覆盖原 private lastSeen')
  assert.ok(!rAfterGroupNote.chatId.includes(':group:'))
  gw.noteSeen(ownerId, 'qqbot:private:stranger_only', Date.now())
  const rRecentStranger = api.resolveOwnerRoute({ purpose: 'proactive' })
  assert.notEqual(rRecentStranger.chatId, 'qqbot:private:stranger_only')
  assert.ok(rRecentStranger.chatId.includes('private:'))

  // 6) 多实例未观测 → primary-unlinked + blocked
  api.setConfig(mergeFromPanel(api.getConfig(), {
    ownerPrimary: { mode: 'fixed', platform: 'bridge', instance: 'bridge#2', account: 'b_unseen', fallback: false, noticeFallback: true },
  }))
  const rMultiUnseen = api.resolveOwnerRoute({ purpose: 'proactive' })
  assert.equal(rMultiUnseen.blocked, true)
  assert.equal(rMultiUnseen.reason, 'primary-unlinked')
  assert.equal(rMultiUnseen.chatId, '')

  // 7) proactive=none：设为主账号报 primary-proactive-none；允许回退时被 routeTo 跳过（绝不选到 bridge）
  api.setConfig(mergeFromPanel(api.getConfig(), {
    ownerPrimary: { mode: 'fixed', platform: 'bridge', instance: 'bridge', account: 'b_1', fallback: false, noticeFallback: true },
  }))
  const rProNone = api.resolveOwnerRoute({ purpose: 'proactive' })
  assert.equal(rProNone.blocked, true)
  assert.equal(rProNone.reason, 'primary-proactive-none')
  const rProNoneNotice = api.resolveOwnerRoute({ purpose: 'notice' })
  assert.equal(rProNoneNotice.blocked, false)
  assert.equal(rProNoneNotice.fallbackUsed, true)
  assert.notEqual(rProNoneNotice.target?.instance, 'bridge')

  // 8) 传统 QQ 离线切换：断掉 mockOb 后显式 QQ（fallback=false）与隐式 QQ 均应阻塞 proactive、回退 notice
  api.setConfig(mergeFromPanel(api.getConfig(), {
    ownerPrimary: { mode: 'fixed', platform: 'qq', instance: 'qq', account: '10001', fallback: false, noticeFallback: true },
  }))
  await mockOb.close()
  assert.equal(await waitUntil(() => api.resolveOwnerRoute({ purpose: 'proactive' }).reason === 'primary-offline', 4000), true)
  const rQqOffline = api.resolveOwnerRoute({ purpose: 'proactive' })
  assert.equal(rQqOffline.blocked, true)
  assert.equal(rQqOffline.reason, 'primary-offline')
  const rQqOfflineNotice = api.resolveOwnerRoute({ purpose: 'notice' })
  assert.equal(rQqOfflineNotice.blocked, false)
  assert.equal(rQqOfflineNotice.fallbackUsed, true)

  // 组 2：纯非 QQ 未指定模式
  const dir2 = makeSandbox(t, 'aurabot-p1-golden-purenonqq-')
  const feishuStub2 = await startFakeFeishuServer(t)
  writeFileSync(join(dir2, 'config.json'), JSON.stringify({
    enabled: false,
    dryRun: true,
    setupDone: true,
    ownerQQ: '',
    platforms: {
      feishu: { enabled: true, transport: 'webhook', appId: 'cli_gold2', appSecret: 'sec_gold2', verificationToken: 'vt-gold2', baseUrl: feishuStub2.baseUrl },
    },
    snowluma: { autoStart: false, autoAttach: false },
    voice: { engine: 'windows', autoChance: 0 },
    stickers: { autoChance: 0 },
  }))
  const fake2 = createFakeDsh({ brain: async () => '' })
  fake2.ctx.webServer.port = 5112
  const api2 = host.apply(fake2.ctx)
  t.after(async () => {
    fake2.dispose()
    await new Promise((r) => setTimeout(r, 30))
  })
  await api2.ready.catch(() => {})
  assert.equal(await waitUntil(() => (api2.gateway?.instances?.() || []).some((x) => x.instance === 'feishu' && x.state === 'connected')), true)
  const gw2 = api2.gateway
  gw2.identity.claimOwner('feishu', 'ou_pure')
  const rPureDefault = api2.resolveOwnerRoute({ purpose: 'proactive' })
  assert.deepEqual(rPureDefault, {
    chatId: 'feishu:private:ou_pure',
    blocked: false,
    reason: 'ok',
    target: { platform: 'feishu', instance: 'feishu', account: 'ou_pure' },
    fallbackUsed: false,
  })
})

test('P1-11：严格 fallbackOrder 选路、不绕过列表也不误触发旧 QQ/routeTo、方案 A 开关控制与脏 lastSeen 拦截', async (t) => {
  const dir = makeSandbox(t, 'aurabot-p1-fallback-order-')
  const mockOb = await startMockOneBot({ selfId: '20000002' })
  const feishuStub = await startFakeFeishuServer(t)
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    enabled: true,
    dryRun: false,
    setupDone: true,
    gateway: 'onebot',
    snowluma: { httpUrl: mockOb.httpUrl, wsUrl: mockOb.wsUrl, httpToken: mockOb.token, wsToken: mockOb.token, autoStart: false, autoAttach: false },
    botQQ: '20000002',
    ownerQQ: '10001',
    allow: { private: ['10001'], groups: [] },
    platforms: {
      feishu: { enabled: true, transport: 'webhook', appId: 'cli_fo', appSecret: 'sec_fo', verificationToken: 'vt-fo', baseUrl: feishuStub.baseUrl },
      bridge: { enabled: true, token: 'tok-fo1' },
      'bridge#2': { enabled: true, token: 'tok-fo2' },
    },
    voice: { engine: 'windows', autoChance: 0 },
    stickers: { autoChance: 0 },
  }))
  const fake = createFakeDsh({ brain: async () => '' })
  fake.ctx.webServer.port = 5113
  const host = await import('../src/host.js')
  const api = host.apply(fake.ctx)
  t.after(async () => {
    try { await mockOb.close() } catch {}
    fake.dispose()
    await new Promise((r) => setTimeout(r, 30))
  })
  await api.ready.catch(() => {})
  assert.equal(await waitUntil(() => {
    const list = api.gateway?.instances?.() || []
    return list.some((x) => x.instance === 'feishu' && x.state === 'connected')
      && list.some((x) => x.instance === 'bridge' && x.state === 'connected')
      && list.some((x) => x.instance === 'bridge#2' && x.state === 'connected')
      && mockOb.connected() >= 1
      && api.resolveOwnerRoute().reason === 'ok'
  }, 5000), true)

  const gw = api.gateway
  const ownerId = gw.identity.owner()
  gw.identity.link('feishu', 'ou_1', ownerId, 'manual')
  gw.identity.link('bridge', 'b_1', ownerId, 'manual')
  gw.identity.link('bridge', 'b_2', ownerId, 'manual')
  gw.routing.noteAccountInstance('bridge', 'bridge', 'b_1')
  gw.routing.noteAccountInstance('bridge#2', 'bridge', 'b_2')
  await callBridgeHello(fake, 'bridge', 'tok-fo1', { proactive: 'none' })
  await callBridgeHello(fake, 'bridge#2', 'tok-fo2', { proactive: 'free' })

  // 先在 bridge#2 留一条私聊 seen 记录：后续用来验证自定义列表绝不会被 routeTo.lastSeen 抢走或截胡
  gw.noteSeen(ownerId, 'bridge#2:private:b_2', Date.now())

  // 1) 主账号指向离线/不存在实例，开启 fallback 并设顺序 [feishu, qq]：优先命中 feishu（忽略 router.seen 里的 bridge#2）
  api.setConfig(mergeFromPanel(api.getConfig(), {
    ownerPrimary: {
      mode: 'fixed',
      platform: 'bridge',
      instance: 'bridge#missing',
      account: 'b_2',
      fallback: true,
      noticeFallback: true,
      fallbackOrder: [
        { platform: 'feishu', instance: 'feishu', account: 'ou_1' },
        { platform: 'qq', instance: 'qq', account: '10001' },
      ],
    },
  }))
  const rFirst = api.resolveOwnerRoute({ purpose: 'proactive' })
  assert.equal(rFirst.chatId, 'feishu:private:ou_1')
  assert.equal(rFirst.fallbackUsed, true)
  assert.equal(rFirst.reason, 'fallback-used')

  // 调整顺序把传统直连 QQ 放到首位 → 改发传统 QQ
  api.setConfig(mergeFromPanel(api.getConfig(), {
    ownerPrimary: {
      fallbackOrder: [
        { platform: 'qq', instance: 'qq', account: '10001' },
        { platform: 'feishu', instance: 'feishu', account: 'ou_1' },
      ],
    },
  }))
  const rQqFirst = api.resolveOwnerRoute({ purpose: 'proactive' })
  assert.equal(rQqFirst.chatId, 'private:10001')
  assert.equal(rQqFirst.fallbackUsed, true)

  // 2) fallback=false + noticeFallback=true：A 类严格 blocked，绝不读 fallbackOrder；B 类按列表顺位改发
  api.setConfig(mergeFromPanel(api.getConfig(), {
    ownerPrimary: { fallback: false, noticeFallback: true },
  }))
  const rBlockedA = api.resolveOwnerRoute({ purpose: 'proactive' })
  assert.equal(rBlockedA.blocked, true)
  assert.equal(rBlockedA.reason, 'primary-offline')
  assert.equal(rBlockedA.chatId, '')
  const rNoticeB = api.resolveOwnerRoute({ purpose: 'notice' })
  assert.equal(rNoticeB.blocked, false)
  assert.equal(rNoticeB.chatId, 'private:10001')
  assert.equal(rNoticeB.fallbackUsed, true)

  // 3) 列表全不可用 + routeTo(lastSeen=bridge#2) 在线 + 传统 QQ 在线，列表刻意不含 QQ → 严格返回 no-route，绝不绕过列表！
  api.setConfig(mergeFromPanel(api.getConfig(), {
    ownerPrimary: {
      mode: 'fixed',
      platform: 'bridge',
      instance: 'bridge#missing',
      account: 'b_2',
      fallback: true,
      noticeFallback: true,
      fallbackOrder: [
        // bridge 仅 proactive='none'（不可主动）；feishu 未连/已改用不存在实例
        { platform: 'bridge', instance: 'bridge', account: 'b_1' },
        { platform: 'bridge', instance: 'bridge#2', account: 'b_unlinked' },
      ],
    },
  }))
  const rStrictNoRouteA = api.resolveOwnerRoute({ purpose: 'proactive' })
  assert.deepEqual(rStrictNoRouteA, {
    chatId: '',
    blocked: false,
    reason: 'no-route',
    target: null,
    fallbackUsed: false,
  })
  const rStrictNoRouteB = api.resolveOwnerRoute({ purpose: 'notice' })
  assert.deepEqual(rStrictNoRouteB, {
    chatId: '',
    blocked: false,
    reason: 'no-route',
    target: null,
    fallbackUsed: false,
  })

  // 列表内所有账号均为 stale / 不归属主人时，同样返回 no-route，绝不调用 routeTo 或误发 QQ
  api.setConfig(mergeFromPanel(api.getConfig(), {
    ownerPrimary: {
      fallbackOrder: [{ platform: 'feishu', instance: 'feishu', account: 'ou_gone_stale' }],
    },
  }))
  assert.equal(api.resolveOwnerRoute({ purpose: 'proactive' }).reason, 'no-route')

  // 4) 方案 A：recent 模式下即使 fallback=false，当 lastSeen 失效/被跳过时仍按 fallbackOrder 取下一个可用账号
  // 同时向磁盘 router.json 写入一条污染的 group 记录验证 evalLastSeenTarget 拦截
  const routerPath = join(dir, 'gateway', 'gateway', 'router.json')
  const routerJson = JSON.parse(readFileSync(routerPath, 'utf8'))
  routerJson.seen[ownerId] = { chatId: 'feishu:group:oc_dirty_legacy', at: Date.now() + 10_000 }
  writeFileSync(routerPath, JSON.stringify(routerJson))
  api.setConfig(mergeFromPanel(api.getConfig(), {
    ownerPrimary: {
      mode: 'recent',
      fallback: false,
      noticeFallback: false,
      fallbackOrder: [
        { platform: 'bridge', instance: 'bridge#2', account: 'b_2' },
        { platform: 'feishu', instance: 'feishu', account: 'ou_1' },
      ],
    },
  }))
  const rRecentFallback = api.resolveOwnerRoute({ purpose: 'proactive' })
  assert.equal(rRecentFallback.blocked, false)
  assert.equal(rRecentFallback.reason, 'ok')
  assert.equal(rRecentFallback.chatId, 'bridge#2:private:b_2')

  // 若 dirty lastSeen 指向同平台陌生人 private 地址，同样跳过并用 fallbackOrder 首位
  routerJson.seen[ownerId] = { chatId: 'feishu:private:ou_stranger_dirty', at: Date.now() + 20_000 }
  writeFileSync(routerPath, JSON.stringify(routerJson))
  const rRecentStranger = api.resolveOwnerRoute({ purpose: 'proactive' })
  assert.equal(rRecentStranger.chatId, 'bridge#2:private:b_2')

  // 5) 方案 A：纯非 QQ「未单独指定」且 fallback=false 时，按 fallbackOrder 首位可用接收
  const dirPure = makeSandbox(t, 'aurabot-p1-pure-order-')
  const feishuStubPure = await startFakeFeishuServer(t)
  writeFileSync(join(dirPure, 'config.json'), JSON.stringify({
    enabled: false,
    dryRun: true,
    setupDone: true,
    ownerQQ: '',
    ownerPrimary: {
      mode: 'fixed',
      platform: '',
      instance: '',
      account: '',
      fallback: false,
      noticeFallback: false,
      fallbackOrder: [
        { platform: 'bridge', instance: 'bridge#2', account: 'b_p2' },
        { platform: 'feishu', instance: 'feishu', account: 'ou_pure2' },
      ],
    },
    platforms: {
      feishu: { enabled: true, transport: 'webhook', appId: 'cli_p2', appSecret: 'sec_p2', verificationToken: 'vt-p2', baseUrl: feishuStubPure.baseUrl },
      'bridge#2': { enabled: true, token: 'tok-p2' },
    },
    voice: { engine: 'windows', autoChance: 0 },
    stickers: { autoChance: 0 },
  }))
  const fakePure = createFakeDsh({ brain: async () => '' })
  fakePure.ctx.webServer.port = 5114
  const apiPure = host.apply(fakePure.ctx)
  t.after(async () => {
    fakePure.dispose()
    await new Promise((r) => setTimeout(r, 30))
  })
  await apiPure.ready.catch(() => {})
  assert.equal(await waitUntil(() => {
    const list = apiPure.gateway?.instances?.() || []
    return list.some((x) => x.instance === 'feishu' && x.state === 'connected')
      && list.some((x) => x.instance === 'bridge#2' && x.state === 'connected')
  }, 4000), true)
  const gwPure = apiPure.gateway
  const pureOwner = gwPure.identity.claimOwner('feishu', 'ou_pure2')
  gwPure.identity.link('bridge', 'b_p2', pureOwner, 'manual')
  gwPure.routing.noteAccountInstance('bridge#2', 'bridge', 'b_p2')
  await callBridgeHello(fakePure, 'bridge#2', 'tok-p2', { proactive: 'free' })
  apiPure.setConfig(mergeFromPanel(apiPure.getConfig(), {
    ownerPrimary: {
      mode: 'fixed',
      platform: '',
      instance: '',
      account: '',
      fallback: false,
      noticeFallback: false,
      fallbackOrder: [
        { platform: 'bridge', instance: 'bridge#2', account: 'b_p2' },
        { platform: 'feishu', instance: 'feishu', account: 'ou_pure2' },
      ],
    },
  }))
  // bridge#2 排在第 1 → 即使 fallback=false 且未单独指定主账号，直接取列表首位可用 bridge#2
  const rPureOrder = apiPure.resolveOwnerRoute({ purpose: 'proactive' })
  assert.equal(rPureOrder.blocked, false)
  assert.equal(rPureOrder.reason, 'ok')
  assert.equal(rPureOrder.chatId, 'bridge#2:private:b_p2')
  assert.equal(rPureOrder.fallbackUsed, false)
})

test('P1-12：启动期清理 stale 与机器人自身账号、全失效列表下新绑定仍自动追加、以及 /bind-code 自动追加新绑定账号', async (t) => {
  // A) 启动时：identity 已有 qq:10001（用户刻意排除）、feishu:ou_keep、bridge:b_bot_self（却配为 bridge 机器人自身 selfId），
  // 配置含 stale 项 qqbot:qb_stale + b_bot_self + ou_keep → 仅保留 ou_keep，既剔除 stale 也剔除配置自身账号，且绝不复活 ownerQQ
  const dirStart = makeSandbox(t, 'aurabot-p1-startup-reconcile-')
  const gwDir = join(dirStart, 'gateway')
  mkdirSync(gwDir, { recursive: true })
  const idPre = createIdentity({ dataDir: gwDir, log: noopLog })
  const ownerPre = idPre.claimOwner('qq', '10001')
  idPre.link('feishu', 'ou_keep', ownerPre, 'manual')
  idPre.link('bridge', 'b_bot_self', ownerPre, 'manual')
  writeFileSync(join(dirStart, 'config.json'), JSON.stringify({
    enabled: false,
    dryRun: true,
    setupDone: true,
    botQQ: '20000002',
    ownerQQ: '10001',
    platforms: {
      bridge: { enabled: false, selfId: 'b_bot_self' },
      feishu: { enabled: false, account: 'ou_keep' },
    },
    ownerPrimary: {
      mode: 'fixed',
      platform: 'feishu',
      instance: 'feishu',
      account: 'ou_keep',
      fallbackOrder: [
        { platform: 'qqbot', instance: 'qqbot', account: 'qb_stale_removed' },
        { platform: 'bridge', instance: 'bridge', account: 'b_bot_self' },
        { platform: 'feishu', instance: 'feishu', account: 'ou_keep' },
      ],
    },
    snowluma: { autoStart: false, autoAttach: false },
    voice: { engine: 'windows', autoChance: 0 },
    stickers: { autoChance: 0 },
  }))
  const fakeStart = createFakeDsh({ brain: async () => '' })
  fakeStart.ctx.webServer.port = 5115
  const hostMod = await import('../src/host.js')
  const apiStart = hostMod.apply(fakeStart.ctx)
  t.after(async () => {
    fakeStart.dispose()
    await new Promise((r) => setTimeout(r, 30))
  })
  await apiStart.ready.catch(() => {})
  assert.deepEqual(
    apiStart.getConfig().ownerPrimary.fallbackOrder,
    [{ platform: 'feishu', instance: 'feishu', account: 'ou_keep' }],
    '启动期必须同时剔除 stale 项与配置里的机器人自身账号，且不得复活用户刻意未放进列表的已存在 ownerQQ',
  )

  // B) /bind-code 绑定新账号到主人：若 fallbackOrder 非空，自动追加到末尾且立即可用
  const dirBind = makeSandbox(t, 'aurabot-p1-bindcode-append-')
  const feishuStubB = await startFakeFeishuServer(t)
  const gwBindDir = join(dirBind, 'gateway')
  mkdirSync(gwBindDir, { recursive: true })
  const idBind = createIdentity({ dataDir: gwBindDir, log: noopLog })
  const ownerBind = idBind.claimOwner('feishu', 'ou_bind_main')
  const code = idBind.issueCode(ownerBind)
  writeFileSync(join(dirBind, 'config.json'), JSON.stringify({
    enabled: false,
    dryRun: false,
    setupDone: true,
    ownerQQ: '',
    ownerPrimary: {
      mode: 'fixed',
      platform: 'bridge',
      instance: 'bridge',
      account: 'b_offline_primary',
      fallback: true,
      noticeFallback: true,
      fallbackOrder: [{ platform: 'feishu', instance: 'feishu', account: 'ou_bind_main' }],
    },
    platforms: {
      feishu: { enabled: true, transport: 'webhook', appId: 'cli_bc', appSecret: 'sec_bc', verificationToken: 'vt-bc', baseUrl: feishuStubB.baseUrl },
      'bridge#2': { enabled: true, token: 'tok-bc2' },
    },
    voice: { engine: 'windows', autoChance: 0 },
    stickers: { autoChance: 0 },
  }))
  const fakeBind = createFakeDsh({ brain: async () => '' })
  fakeBind.ctx.webServer.port = 5116
  const apiBind = hostMod.apply(fakeBind.ctx)
  t.after(async () => {
    fakeBind.dispose()
    await new Promise((r) => setTimeout(r, 30))
  })
  await apiBind.ready.catch(() => {})
  assert.equal(await waitUntil(() => (apiBind.gateway?.instances?.() || []).some((x) => x.instance === 'bridge#2' && x.state === 'connected')), true)
  await callBridgeHello(fakeBind, 'bridge#2', 'tok-bc2', { proactive: 'free' })

  // 通过 bridge#2 发送 /bind-code 兑换口令
  const inRoute = fakeBind.routes.get('/platform/bridge#2/inbound')
  assert.ok(inRoute)
  let inStatus = 200
  const inPayload = {
    chat: { kind: 'private', id: 'b_bound_via_code' },
    sender: { account: 'b_bound_via_code', name: '新账号' },
    messageId: 'm_bind_code_1',
    parts: [{ type: 'text', text: `/bind-code ${code}` }],
  }
  await inRoute.handler(
    {
      method: 'POST',
      headers: { 'x-bridge-token': 'tok-bc2' },
      rawBody: Buffer.from(JSON.stringify(inPayload)),
      body: inPayload,
    },
    { set statusCode(v) { inStatus = v }, get statusCode() { return inStatus }, setHeader() {}, end() {} },
  )
  assert.equal(inStatus, 200)
  assert.equal(await waitUntil(() => (apiBind.getConfig().ownerPrimary.fallbackOrder || []).length === 2, 3000), true)
  assert.deepEqual(apiBind.getConfig().ownerPrimary.fallbackOrder, [
    { platform: 'feishu', instance: 'feishu', account: 'ou_bind_main' },
    { platform: 'bridge', instance: 'bridge#2', account: 'b_bound_via_code' },
  ])

  // C) 原 fallbackOrder 仅剩已失效 stale 项（过滤后曾为空 []）：后续绑定新账号仍须自动追加，且不复活已排除的旧账号（审阅 §3.1）
  apiBind.gateway.identity.unlink('bridge', 'b_bound_via_code')
  apiBind.setConfig({
    ...apiBind.getConfig(),
    ownerPrimary: {
      ...apiBind.getConfig().ownerPrimary,
      fallbackOrder: [{ platform: 'bridge', instance: 'bridge', account: 'b_only_stale' }],
    },
  })
  const code2 = apiBind.gateway.identity.issueCode(ownerBind)
  let inStatus2 = 200
  const inPayload2 = {
    chat: { kind: 'private', id: 'b_bound_after_all_stale' },
    sender: { account: 'b_bound_after_all_stale', name: '全失效后新绑定' },
    messageId: 'm_bind_code_2',
    parts: [{ type: 'text', text: `/bind-code ${code2}` }],
  }
  await inRoute.handler(
    {
      method: 'POST',
      headers: { 'x-bridge-token': 'tok-bc2' },
      rawBody: Buffer.from(JSON.stringify(inPayload2)),
      body: inPayload2,
    },
    { set statusCode(v) { inStatus2 = v }, get statusCode() { return inStatus2 }, setHeader() {}, end() {} },
  )
  assert.equal(inStatus2, 200)
  assert.equal(
    await waitUntil(() => {
      const ord = apiBind.getConfig().ownerPrimary.fallbackOrder || []
      return ord.length === 1 && ord[0].account === 'b_bound_after_all_stale'
    }, 3000),
    true,
  )
  assert.deepEqual(apiBind.getConfig().ownerPrimary.fallbackOrder, [
    { platform: 'bridge', instance: 'bridge#2', account: 'b_bound_after_all_stale' },
  ])
})
