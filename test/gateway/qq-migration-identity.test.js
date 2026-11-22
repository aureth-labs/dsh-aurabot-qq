import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { createQqAdapter } from '../../src/adapters/qq/index.js'
import { createGateway } from '../../src/gateway/index.js'
import { startMockOneBot } from '../helpers/mock-onebot.js'
import { makeIdentity, makeTempRoot } from './helpers.js'

async function setup(t, httpAccount) {
  const expected = '20000002'
  const ws = await startMockOneBot({ selfId: expected, token: 'local-ws-token' })
  t.after(() => ws.close())
  const http = await startMockOneBot({ selfId: httpAccount, token: 'local-http-token' })
  t.after(() => http.close())
  const root = makeTempRoot()
  const target = {
    enabled: true,
    selfId: expected,
    wsUrl: ws.wsUrl,
    wsToken: ws.token,
    httpUrl: http.httpUrl,
    httpToken: http.token,
  }
  const gateway = createGateway({
    config: { platforms: { qq: target } },
    dataDir: (...parts) => join(root, ...parts),
    identity: makeIdentity(),
  })
  gateway.register(() => createQqAdapter({ probeTable: [] }))
  t.after(() => gateway.stopAll())
  const lease = await gateway.acquireLease('qq', { config: target })
  await lease.startHeld()
  return { gateway, lease, http, ws, expected }
}

const reply = { chatId: 'qq:private:10001', parts: [{ type: 'text', text: '迁移测试' }] }

test('QQ 租约在隔离 WS 和 HTTP 都确认目标账号后才允许放行', async (t) => {
  const { gateway, lease, http, ws, expected } = await setup(t, '20000002')
  await assert.rejects(lease.release(), /未完成当前连接验号/)
  await assert.rejects(gateway.send(reply), { code: 'migration-held' })
  assert.equal((await lease.whenReady()).self.account, expected)
  assert.equal(ws.sent('get_login_info').length, 1)
  assert.equal(http.sent('get_login_info').length, 1)
  assert.equal(http.sent('send_private_msg').length, 0)

  await lease.release()
  await gateway.send(reply)
  assert.equal(http.sent('send_private_msg').length, 1)
  assert.equal(ws.sent('send_private_msg').length, 0)
})

test('QQ 正确的 WS 账号不能放行账号不一致的 HTTP 端点', async (t) => {
  const { gateway, lease, http, ws } = await setup(t, '30000003')
  await assert.rejects(lease.whenReady(), /HTTP.*不一致/)
  await assert.rejects(lease.release(), /未完成当前连接验号/)
  await assert.rejects(gateway.send(reply), { code: 'migration-held' })
  assert.equal(ws.sent('get_login_info').length, 1)
  assert.equal(http.sent('get_login_info').length, 1)
  assert.equal(http.sent('send_private_msg').length, 0)
})
