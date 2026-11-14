// F2：非 QQ 平台的入站必须进入同一条中枢路径（G3 只开了 QQ，这里验 F2 的门）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGateway } from '../src/gateway/index.js'
import { createIdentity } from '../src/gateway/identity.js'
import { createHub } from '../src/chat/hub.js'
import { normalize } from '../src/core/config.js'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { makeFakeAdapter } from './helpers/fake-adapter.js'

const noopLog = { debug() {}, info() {}, warn() {}, error() {} }
const waitFor = async (pred, ms = 2000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 20))
  }
}

test('非 QQ 平台私聊进入中枢并回到原平台', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'f2-inbound-'))
  process.env.AURABOT_DATA_DIR = dataDir
  const identity = createIdentity({ dataDir: join(dataDir, 'gw'), log: noopLog })
  const owner = identity.claimOwner('feishu', 'ou_owner')
  const cfg = normalize({
    enabled: true, dryRun: false, setupDone: true, botQQ: '', ownerQQ: '',
    voice: { enabled: false }, merge: { enabled: false },
    stickers: { enabled: false, collect: false },
    platforms: { feishu: { enabled: true, default: true } },
    allow: { private: [], groups: [] },
  })
  const gateway = createGateway({ config: cfg, dataDir: (...p) => join(dataDir, ...p), identity, log: noopLog })
  const adapter = makeFakeAdapter({ id: 'feishu' })
  gateway.register(() => adapter)
  await gateway.sync()

  const fake = createFakeDsh({ brain: async ({ text }) => `收到：${String(text).slice(-10)}` })
  const hub = createHub({
    dsh: fake.ctx, getConfig: () => cfg, log: noopLog,
    gateway, identity, routeOwner: () => gateway.routeTo(identity.owner()), defaultPlatform: 'qq',
  })
  const offEvent = fake.ctx.on('session/event', hub.onSessionEvent)
  const offMessage = gateway.onMessage((m) => hub.onGatewayMessage(m))
  t.after(async () => {
    offMessage()
    offEvent()
    hub.dispose()
    await gateway.stopAll()
    fake.dispose()
  })

  adapter.pushInbound({
    chat: { kind: 'private', id: 'ou_owner' },
    sender: { account: 'ou_owner', name: '主人', role: 'owner' },
    parts: [{ type: 'text', text: '跨平台你好' }],
  })
  await waitFor(() => adapter.sent.some((r) => r.payload?.chat?.id === 'ou_owner' && r.payload?.parts?.some((p) => /收到：/.test(p.text || ''))))
  assert.ok(adapter.sent.some((r) => r.payload?.chat?.id === 'ou_owner'))
  assert.equal(identity.accountOn(owner, 'feishu'), 'ou_owner')
})
