// P0 · 主账号路由基础 Bugfix 验收测试：
//   1) hub.js / host.js 正确解析 gateway.routeTo() 返回的 ChatId 字符串（不穿透回 private:<qq>）
//   2) 旧版直连 OneBot 私聊入站（onMessage 无 __gateway）补记 gateway.noteSeen（网关入站不重复记）
//   3) 宿主 /platforms/people 与 /platforms/people/fixed 改调 platformGateway.routing.{fixedPlatform, setFixed}
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHub } from '../src/chat/hub.js'
import { createIdentity } from '../src/gateway/identity.js'
import { createGateway } from '../src/gateway/index.js'
import { normalize } from '../src/core/config.js'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { makeFakeAdapter } from './helpers/fake-adapter.js'

const noopLog = { debug() {}, info() {}, warn() {}, error() {} }

function makeSandbox(t, prefix = 'aurabot-p0-') {
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

test('P0-1：gateway.routeTo() 返回 ChatId 字符串时，hub.ownerChat()（直调与注入 routeOwner）正确解析不穿透 QQ', async (t) => {
  const dir = makeSandbox(t, 'aurabot-p0-route-')
  const identity = createIdentity({ dataDir: join(dir, 'gw'), log: noopLog })
  const owner = identity.claimOwner('qq', '10001')
  identity.link('feishu', 'ou_owner', owner, 'owner')

  const cfg = normalize({
    enabled: true, dryRun: true, setupDone: true, botQQ: '20000002', ownerQQ: '10001',
    voice: { enabled: false }, merge: { enabled: false }, stickers: { enabled: false, collect: false },
    platforms: { feishu: { enabled: true } }, allow: { private: ['10001'], groups: [] },
  })

  // 真网关场景：gateway.routeTo(owner) 返回字符串 'feishu:private:ou_owner'
  const gateway = createGateway({ config: cfg, dataDir: (...p) => join(dir, ...p), identity, log: noopLog })
  const adapter = makeFakeAdapter({ id: 'feishu' })
  gateway.register(() => adapter)
  await gateway.sync()
  gateway.routing.setFixed(owner, 'feishu')
  assert.equal(gateway.routeTo(owner), 'feishu:private:ou_owner')

  const fake1 = createFakeDsh({ brain: async () => '' })
  const hubDirect = createHub({ dsh: fake1.ctx, getConfig: () => cfg, log: noopLog, gateway, identity })
  t.after(async () => {
    hubDirect.dispose()
    await gateway.stopAll()
    fake1.dispose()
  })
  assert.equal(hubDirect.ownerChat(), 'feishu:private:ou_owner')

  // routeOwner 返回对象（兼容）或字符串时均能正确解析
  const fake2 = createFakeDsh({ brain: async () => '' })
  const hubInjected = createHub({
    dsh: fake2.ctx,
    getConfig: () => cfg,
    log: noopLog,
    gateway: {
      routeTo: () => 'feishu:private:ou_owner',
      caps: () => null,
      features: () => ({}),
      onCapsChanged: () => () => {},
    },
    identity,
    routeOwner: () => 'feishu:private:ou_owner',
  })
  t.after(() => {
    hubInjected.dispose()
    fake2.dispose()
  })
  assert.equal(hubInjected.ownerChat(), 'feishu:private:ou_owner')
})

test('P0-2：旧版直连 OneBot 私聊入站补记 gateway.noteSeen；网关入站不重复记第二次', async (t) => {
  const dir = makeSandbox(t, 'aurabot-p0-seen-')
  const identity = createIdentity({ dataDir: join(dir, 'gw'), log: noopLog })
  const owner = identity.claimOwner('qq', '10001')
  identity.link('feishu', 'ou_owner', owner, 'owner')

  const seenCalls = []
  const fakeGateway = {
    noteSeen: (person, chatId, at) => seenCalls.push({ person, chatId, at }),
    routeTo: () => null,
    caps: () => null,
    features: () => ({}),
    onCapsChanged: () => () => {},
  }
  const cfg = normalize({
    enabled: true, dryRun: true, setupDone: true, botQQ: '20000002', ownerQQ: '10001',
    voice: { enabled: false }, merge: { enabled: false }, stickers: { enabled: false, collect: false },
    allow: { private: ['10001'], groups: [] },
  })
  const fake = createFakeDsh({ brain: async () => '' })
  const hub = createHub({ dsh: fake.ctx, getConfig: () => cfg, log: noopLog, gateway: fakeGateway, identity })
  const offEvent = fake.ctx.on('session/event', hub.onSessionEvent)
  t.after(() => {
    offEvent()
    hub.dispose()
    fake.dispose()
  })

  // 1) 旧版直连 OneBot 私聊入站（无 __gateway）
  await hub.onMessage({
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    self_id: 20000002,
    user_id: 10001,
    message_id: 101,
    sender: { user_id: 10001, nickname: '主人' },
    message: [{ type: 'text', data: { text: '直连QQ在吗' } }],
  })
  assert.equal(seenCalls.length, 1, '旧版 OneBot 主人私聊应记录一次 noteSeen')
  assert.equal(seenCalls[0].person, owner)
  assert.equal(seenCalls[0].chatId, 'private:10001')
  assert.equal(typeof seenCalls[0].at, 'number')

  // 2) 网关入站（onGatewayMessage → 带 __gateway 调 onMessage）：只记 1 次，不能重复记
  await hub.onGatewayMessage({
    platform: 'feishu',
    instance: 'feishu',
    kind: 'private',
    chatId: 'feishu:private:ou_owner',
    chat: { kind: 'private', id: 'ou_owner' },
    sender: { account: 'ou_owner', name: '主人', person: owner, isOwner: true },
    messageId: 'gw-1',
    at: Date.now() + 1000,
    text: '飞书在吗',
    parts: [{ type: 'text', text: '飞书在吗' }],
  })
  assert.equal(seenCalls.length, 2, '网关入站总共只需一次 noteSeen（不能因内层 onMessage 重复记录）')
  assert.equal(seenCalls[1].person, owner)
  assert.equal(seenCalls[1].chatId, 'feishu:private:ou_owner')
})

test('P0-3：宿主 /platforms/people 与 /platforms/people/fixed 正常读写 routing 且宿主 routeOwner 解析字符串 ChatId', async (t) => {
  const dir = makeSandbox(t, 'aurabot-p0-host-')
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    enabled: true,
    dryRun: true,
    setupDone: true,
    botQQ: '20000002',
    ownerQQ: '',
    allow: { private: [], groups: [] },
    platforms: { bridge: { enabled: true, token: 'test-tok' } },
    snowluma: { autoStart: false, autoAttach: false, dir: join(dir, 'no-snowluma') },
    voice: { engine: 'windows', autoChance: 0 },
    stickers: { autoChance: 0 },
  }))

  const fake = createFakeDsh({ brain: async () => '嗯' })
  fake.ctx.webServer.port = 5098
  const host = await import('../src/host.js')
  const api = host.apply(fake.ctx)
  t.after(async () => {
    fake.dispose()
    await new Promise((r) => setTimeout(r, 30))
  })
  await api.ready.catch(() => {})

  // 等 bridge 实例在网关就绪（state === 'connected'）
  for (let i = 0; i < 40; i++) {
    const pRes = await fake.call('/platforms')
    const pJson = pRes.json()
    if (pJson.instances?.some((x) => x.instance === 'bridge' && x.state === 'connected')) break
    await new Promise((r) => setTimeout(r, 25))
  }

  // 认领 bridge 账号为主人
  const claimRes = await fake.call('/platforms/claim', { platform: 'bridge', account: 'b_owner' })
  const claimJson = claimRes.json()
  assert.equal(claimJson.ok, true, claimJson.message)
  const ownerPerson = claimJson.person
  assert.ok(ownerPerson)

  // /platforms/people/fixed 仅服务非主人：对主人调用应返回明确提示；对非主人成员读写 routing 正常
  const ownerFixRes = await fake.call('/platforms/people/fixed', { person: ownerPerson, platform: 'bridge' })
  assert.equal(ownerFixRes.json().ok, false)
  assert.match(ownerFixRes.json().message, /权限/)

  const guestPerson = api.gateway.identity.resolve('bridge', 'guest_1')
  api.memory.add({ text: '路人朋友测试', about: guestPerson, aboutName: '路人', source: 'panel' })
  const fixRes = await fake.call('/platforms/people/fixed', { person: guestPerson, platform: 'bridge' })
  assert.equal(fixRes.json().ok, true, fixRes.json().message)

  const peopleRes = await fake.call('/platforms/people')
  const peopleJson = peopleRes.json()
  assert.equal(peopleJson.ok, true)
  const guestRow = peopleJson.list.find((x) => x.person === guestPerson)
  assert.equal(guestRow?.fixed, 'bridge')

  // 通过 bridge /hello 声明 proactive='free'，验证宿主 routeOwner() 正确解析 gateway.routeTo() 字符串返回值
  const helloRoute = fake.routes.get('/platform/bridge/hello')
  assert.ok(helloRoute, 'bridge /hello 回调路由应已注册')
  let helloOut = ''
  let helloStatus = 200
  await helloRoute.handler(
    {
      method: 'POST',
      headers: { 'x-bridge-token': 'test-tok' },
      rawBody: Buffer.from('{}'),
      body: { caps: { proactive: 'free' } },
    },
    {
      set statusCode(v) { helloStatus = v },
      get statusCode() { return helloStatus },
      setHeader() {},
      end(s) { helloOut = s },
    },
  )
  assert.equal(helloStatus, 200, helloOut)
  assert.equal(api.hub.ownerChat(), 'bridge:private:b_owner')

  // 取消固定平台也能正常清空
  const unfixRes = await fake.call('/platforms/people/fixed', { person: guestPerson, platform: '' })
  assert.equal(unfixRes.json().ok, true)
  const peopleAfter = (await fake.call('/platforms/people')).json()
  assert.equal(peopleAfter.list.find((x) => x.person === guestPerson)?.fixed, '')
})
