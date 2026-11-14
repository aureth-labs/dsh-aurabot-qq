// F2：主人取绑定口令，另一平台用口令绑定到同一个 PersonId。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIdentity } from '../src/gateway/identity.js'
import { normalize } from '../src/core/config.js'
import { runCommand } from '../src/chat/commands.js'

test('主人取一次性绑定口令，新平台账号兑换到同一个 PersonId', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'f2-bind-'))
  const identity = createIdentity({ dataDir: join(dataDir, 'gw'), log: { info() {}, warn() {}, debug() {} } })
  const owner = identity.claimOwner('feishu', 'ou_owner')
  const cfg = normalize({ enabled: true, ownerQQ: '', platforms: { feishu: { enabled: true } } })
  const deps = {
    identity,
    getConfig: () => cfg,
    setConfig() {},
    mutes: { set() {}, clear() {}, muted() { return false } },
    hub: { leaveTopic() {}, joinTopic() {} },
  }
  const reply = await runCommand({ name: 'bind', arg: '' }, { kind: 'private', chatId: 'feishu:private:ou_owner', platform: 'feishu', userId: 'ou_owner' }, deps)
  const code = /绑定口令：(\d{6})/.exec(reply)?.[1]
  assert.ok(code, reply)
  assert.equal(identity.redeemCode('qq', '10001', code), owner)
  assert.equal(identity.accountOn(owner, 'qq'), '10001')
})

test('群里取绑定口令被拒绝', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'f2-bind-group-'))
  const identity = createIdentity({ dataDir: join(dataDir, 'gw'), log: { info() {}, warn() {}, debug() {} } })
  identity.claimOwner('feishu', 'ou_owner')
  const cfg = normalize({ enabled: true, ownerQQ: '', platforms: { feishu: { enabled: true } } })
  const deps = { identity, getConfig: () => cfg, setConfig() {}, mutes: { set() {}, clear() {}, muted() { return false } }, hub: {} }
  const reply = await runCommand({ name: 'bind', arg: '' }, { kind: 'group', chatId: 'feishu:group:oc_1', platform: 'feishu', userId: 'ou_owner', groupId: 'oc_1' }, deps)
  assert.match(reply, /私聊/)
})
