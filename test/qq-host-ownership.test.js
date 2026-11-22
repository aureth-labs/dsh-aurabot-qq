import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { startMockOneBot } from './helpers/mock-onebot.js'

async function waitFor(predicate, message) {
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(20)
  }
  assert.fail(message)
}

async function startHost(t, { legacyQqEnabled = false } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aurabot-qq-owner-'))
  const oldDir = process.env.AURABOT_DATA_DIR
  const oldWorkspace = process.env.AURABOT_WORKSPACE
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'workspace')
  let legacy
  let managed
  let fake
  let host
  t.after(async () => {
    try {
      fake?.dispose()
      await host?.gateway?.stopAll()
      await Promise.all([managed?.close(), legacy?.close()])
    } finally {
      if (oldDir === undefined) delete process.env.AURABOT_DATA_DIR
      else process.env.AURABOT_DATA_DIR = oldDir
      if (oldWorkspace === undefined) delete process.env.AURABOT_WORKSPACE
      else process.env.AURABOT_WORKSPACE = oldWorkspace
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  const botQQ = '20000002'
  const ownerQQ = '10000001'
  legacy = await startMockOneBot({ selfId: botQQ })
  managed = await startMockOneBot({ selfId: botQQ })
  fake = createFakeDsh({ brain: async () => '收到' })
  const platform = { enabled: true, backend: 'onebot', selfId: botQQ, httpUrl: managed.httpUrl, wsUrl: managed.wsUrl, token: managed.token }
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    legacyQqEnabled,
    setupDone: true,
    dryRun: false,
    gateway: 'onebot',
    botQQ,
    ownerQQ,
    snowluma: {
      httpUrl: legacy.httpUrl,
      wsUrl: legacy.wsUrl,
      httpToken: legacy.token,
      wsToken: legacy.token,
    },
    platforms: { qq: platform },
  }))

  const { apply } = await import('../src/host.js')
  host = apply(fake.ctx)
  await host.ready
  return { host, fake, legacy, managed, botQQ, ownerQQ, platform, dataDir }
}

test('默认 QQ 由网关托管时，旧入口和总开关均不会启动直连', async (t) => {
  const { host, fake, legacy, managed, botQQ, ownerQQ } = await startHost(t)
  await waitFor(() => host.gateway?.instances().some((entry) => entry.instance === 'qq' && entry.self?.account === botQQ), '网关 QQ 未通过登录核对')
  assert.equal(host.onebot, null)
  const statuses = (await fake.call('/platforms')).json().instances
  assert.equal(statuses.filter((entry) => entry.instance === 'qq').length, 1)
  assert.equal(statuses.some((entry) => entry.legacy), false)

  assert.equal((await fake.call('/onebot/reconnect')).json().ok, false)
  assert.equal((await fake.call('/snowluma/attach')).json().ok, false)
  assert.equal((await fake.call('/onebot/test')).json().ok, true)
  assert.equal((await fake.call('/save', { botQQ: '20000003' })).json().ok, false)
  assert.equal((await fake.call('/platforms/settings', { instance: 'qq', patch: { selfId: '20000003' } })).json().ok, false)
  assert.equal(host.getConfig().botQQ, botQQ)
  assert.equal(host.getConfig().platforms.qq.selfId, botQQ)
  assert.equal((await fake.call('/permissions/friends')).json().ok, false)
  managed.state.friends = [{ user_id: Number(ownerQQ), nickname: '主人' }]
  assert.deepEqual((await fake.call('/permissions/friends')).json(), { ok: true, friends: [{ id: ownerQQ, name: '主人' }] })
  assert.ok(managed.sent('get_friend_list').length)

  await host.hub.sendText(`private:${ownerQQ}`, '网关出站')
  assert.equal(managed.sent('send_private_msg').length, 1)
  assert.equal(legacy.calls.length, 0)

  assert.equal((await fake.call('/save', { enabled: false, legacyQqEnabled: true })).json().ok, true)
  assert.equal(host.getConfig().legacyQqEnabled, false)
  await waitFor(() => managed.connected() === 0, '关闭总开关后网关 QQ 未退出')
  assert.equal((await fake.call('/onebot/reconnect')).json().ok, false)

  assert.equal((await fake.call('/save', { enabled: true })).json().ok, true)
  await waitFor(() => managed.connected() === 1, '重新开启总开关后网关 QQ 未恢复')
  await delay(3100) // 等启动看门狗运行一次，再确认没有拉起直连。
  assert.equal(legacy.connected(), 0)
  assert.equal(legacy.calls.length, 0)
})

test('热切换事务核对 revision，提交时一次写入托管和实例，反向切换恢复直连', async (t) => {
  const { host, fake, legacy, managed, ownerQQ, platform, dataDir } = await startHost(t, { legacyQqEnabled: true })
  assert.equal((await fake.call('/onebot/reconnect')).json().ok, true)
  assert.equal((await fake.call('/save', { enabled: false })).json().ok, true)
  const card = (await fake.call('/platforms')).json().instances.find((entry) => entry.instance === 'qq')
  assert.equal(card.legacy, true)
  assert.equal(card.state, 'stopped')
  assert.match(card.detail, /总开关关闭/)
  assert.equal((await fake.call('/save', { enabled: true })).json().ok, true)
  assert.equal((await fake.call('/onebot/reconnect')).json().ok, true)

  const begin = (txnId, legacyQqEnabled) => {
    const options = { txnId, legacyQqEnabled, expectedRevision: host.qqOwnership.status().revision, platform }
    return { transition: host.qqOwnership.begin(options), options }
  }
  assert.throws(() => host.qqOwnership.begin({ txnId: 'stale', expectedRevision: -1, legacyQqEnabled: false, platform }), /revision/)
  const abandoned = begin('abort-before-commit', false)
  await abandoned.transition.prepare()
  assert.throws(() => abandoned.transition.commit({ ...abandoned.options, txnId: 'wrong' }), /revision/)
  assert.throws(() => abandoned.transition.commit({ ...abandoned.options, expectedRevision: -1 }), /revision/)
  assert.equal((await fake.call('/save', { enabled: false })).json().ok, false)
  assert.equal((await fake.call('/save', { ownerName: '同时保存的称呼' })).json().ok, true)
  assert.equal(legacy.connected(), 0)
  await assert.rejects(host.gateway.send({ chatId: 'qq:private:10000001', parts: [{ type: 'text', text: '挂起时不能发' }] }), /迁移期间/)
  await abandoned.transition.abort()
  assert.equal(host.qqOwnership.status().legacyQqEnabled, true)
  await waitFor(() => managed.connected() === 0, '撤销后网关 QQ 未退出')
  await waitFor(() => legacy.connected() === 1, '撤销后旧版 QQ 未恢复')
  assert.equal((await fake.call('/onebot/reconnect')).json().ok, true)

  const forward = begin('cutover', false)
  await forward.transition.prepare()
  forward.transition.commit(forward.options)
  const persisted = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'))
  assert.equal(persisted.legacyQqEnabled, false)
  assert.deepEqual(persisted.platforms.qq, platform)
  assert.equal(persisted.ownerName, '同时保存的称呼')
  assert.equal(host.onebot, null)
  await forward.transition.finish()
  await host.hub.sendText(`private:${ownerQQ}`, '切换后的网关消息')
  assert.equal(legacy.connected(), 0)
  assert.equal(managed.sent('send_private_msg').length, 1)
  await assert.rejects(forward.transition.abort(), /状态已失效/)

  const reverse = begin('reverse', true)
  await reverse.transition.prepare()
  await waitFor(() => managed.connected() === 0, '回切时网关 QQ 未退出')
  reverse.transition.commit(reverse.options)
  await reverse.transition.finish()
  assert.equal(host.getConfig().legacyQqEnabled, true)
  assert.equal(host.getConfig().platforms.qq.enabled, false)
  assert.ok(host.onebot)
  await waitFor(() => legacy.connected() === 1, '反向切换后旧版 QQ 未恢复')
  await host.hub.sendText(`private:${ownerQQ}`, '回切后的直连消息')
  assert.equal(legacy.sent('send_private_msg').length, 1)
})
