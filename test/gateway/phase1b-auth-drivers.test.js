// Phase 1B 认证驱动与宿主机集成测试：
//   - 钉钉 device-code AuthDriver（init/begin/poll 状态机、HTTPS 域名约束、QR 长度校验、deviceCode/clientSecret 零泄露）
//   - 企业微信智能机器人 qr-link AuthDriver（generate/query_result 状态机、scode/secret 零泄露、与 wechat-clawbot 隔离）
//   - 宿主机全流程（/platforms/auth/start|poll|cancel、真实 dingtalk/wecom 适配器连接 + whoami、共享目标别名、不自动认主）
//   - client/client.js 面板卡片与向导 UI 契约断言
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MAX_QR_UTF8_BYTES, encodeQrMatrix } from '../../src/core/qr.js'
import { findFfmpeg } from '../../src/core/img.js'
import { AuthError, createPlatformAuthManager } from '../../src/gateway/auth.js'
import { resolveSharedPlatformTarget } from '../../src/gateway/shared-platform-target.js'
import {
  createDingtalkAuthDriver,
  DINGTALK_REGISTRATION_BASE_URL,
  DINGTALK_REGISTRATION_SOURCE,
} from '../../src/adapters/dingtalk/index.js'
import {
  createWecomAuthDriver,
  WECOM_QR_GENERATE_URL,
  WECOM_QR_POLL_URL,
  WECOM_WS_CMD,
} from '../../src/adapters/wecom/index.js'
import { decodeQrMatrixIso } from '../helpers/qr-decoder.js'
import { createFakeDsh } from '../helpers/fake-dsh.js'

function jsonResp(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    async json() { return body },
    async text() { return JSON.stringify(body) },
  }
}

class HostMockWs extends EventEmitter {
  constructor(url) {
    super()
    this.url = url
    this.readyState = 0
    this.sentFrames = []
    queueMicrotask(() => {
      this.readyState = 1
      this.emit('open')
    })
  }
  send(raw) {
    const frame = JSON.parse(String(raw))
    this.sentFrames.push(frame)
    const reqId = frame.headers?.req_id
    queueMicrotask(() => {
      if (frame.cmd === WECOM_WS_CMD.SUBSCRIBE) {
        this.emit('message', JSON.stringify({ headers: { req_id: reqId }, errcode: 0 }))
      } else if (frame.cmd === WECOM_WS_CMD.UPLOAD_MEDIA_INIT) {
        this.emit('message', JSON.stringify({ headers: { req_id: reqId }, errcode: 0, body: { upload_id: `up_${reqId}` } }))
      } else if (frame.cmd === WECOM_WS_CMD.UPLOAD_MEDIA_CHUNK) {
        this.emit('message', JSON.stringify({ headers: { req_id: reqId }, errcode: 0 }))
      } else if (frame.cmd === WECOM_WS_CMD.UPLOAD_MEDIA_FINISH) {
        this.emit('message', JSON.stringify({ headers: { req_id: reqId }, errcode: 0, body: { media_id: `wc_m_${reqId}` } }))
      } else if (frame.cmd === WECOM_WS_CMD.SEND_MSG || frame.cmd === WECOM_WS_CMD.RESPONSE) {
        this.emit('message', JSON.stringify({ headers: { req_id: reqId }, errcode: 0, body: { msgid: `msg_${reqId}` } }))
      }
    })
  }
  close() {
    this.readyState = 3
    this.emit('close', 1000, 'closed')
  }
}

async function bootPhase1BHost(t, { cfg, opts = {} } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aurabot-phase1b-auth-'))
  const prevDir = process.env.AURABOT_DATA_DIR
  const prevWs = process.env.AURABOT_WORKSPACE
  const prevGlobal = globalThis.aurabot
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mkdirSync(join(dataDir, 'ws'), { recursive: true })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify(cfg))

  const fake = createFakeDsh({ brain: async () => 'ok' })
  const host = await import('../../src/host.js')
  const app = host.apply(fake.ctx, opts)
  t.after(async () => {
    fake.dispose()
    await app.gateway?.stopAll?.()
    if (prevDir === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prevDir
    if (prevWs === undefined) delete process.env.AURABOT_WORKSPACE
    else process.env.AURABOT_WORKSPACE = prevWs
    if (prevGlobal === undefined) delete globalThis.aurabot
    else globalThis.aurabot = prevGlobal
    try { rmSync(dataDir, { recursive: true, force: true }) } catch {}
  })
  await app.ready
  return { fake, app, dataDir }
}

test('钉钉 AuthDriver (device-code)：init -> begin -> poll 全状态机、HTTPS 白名单、QR 长度守卫与零泄漏', async () => {
  const devCodeSecret = 'dt_device_code_secret_12345'
  const appSecret = 'dt_client_secret_super_hidden_999'
  const calls = []
  let pollMode = 'waiting'

  const driver = createDingtalkAuthDriver({
    fetchImpl: async (url, init) => {
      assert.equal(init.redirect, 'error')
      const body = JSON.parse(String(init.body || '{}'))
      calls.push({ url, body })
      if (url.endsWith('/app/registration/init')) {
        assert.deepEqual(body, { source: DINGTALK_REGISTRATION_SOURCE })
        return jsonResp({ errcode: 0, nonce: 'dt_nonce_1' })
      }
      if (url.endsWith('/app/registration/begin')) {
        assert.deepEqual(body, { nonce: 'dt_nonce_1' })
        return jsonResp({
          errcode: 0,
          device_code: devCodeSecret,
          user_code: 'DT-5678',
          verification_uri_complete: 'https://oapi.dingtalk.com/verify?user_code=DT-5678',
          expires_in: 600,
          interval: 2,
        })
      }
      if (url.endsWith('/app/registration/poll')) {
        assert.equal(body.device_code, devCodeSecret)
        if (pollMode === 'waiting') return jsonResp({ errcode: 0, status: 'WAITING' })
        if (pollMode === 'scanned') return jsonResp({ errcode: 0, status: 'CONFIRMING' })
        if (pollMode === 'unknown') return jsonResp({ errcode: 0, status: 'PROVISIONING_NEW_STATE' })
        if (pollMode === 'cancelled') return jsonResp({ errcode: 0, status: 'CANCELLED' })
        if (pollMode === 'expired') return jsonResp({ errcode: 0, status: 'EXPIRED' })
        if (pollMode === 'fail') return jsonResp({ errcode: 0, status: 'FAIL', fail_reason: 'denied' })
        if (pollMode === 'completed') {
          return jsonResp({
            errcode: 0,
            status: 'COMPLETED',
            result: {
              client_id: 'ding_client_001',
              client_secret: appSecret,
            },
          })
        }
        return jsonResp({
          errcode: 0,
          status: 'SUCCESS',
          client_id: 'ding_client_001',
          client_secret: appSecret,
        })
      }
      throw new Error('unexpected url')
    },
  })

  assert.equal(driver.validateInstance('dingtalk'), true)
  assert.equal(driver.validateInstance('dingtalk#corp'), true)
  assert.equal(driver.validateInstance('feishu'), false)

  const logs = []
  const saved = []
  const mgr = createPlatformAuthManager({
    applyCompletion: async (payload) => { saved.push(payload) },
    log: { debug: (...a) => logs.push(a.join(' ')), info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')) },
  })
  mgr.register(driver)

  const s0 = await mgr.start({ platform: 'dingtalk', method: 'device-code' })
  assert.equal(s0.state, 'device_code_ready')
  assert.equal(s0.userCode, 'DT-5678')
  assert.ok(s0.qrDataUri.startsWith('data:image/svg+xml;base64,'))
  assert.ok(Buffer.byteLength(s0.verificationUrl, 'utf8') <= MAX_QR_UTF8_BYTES)
  assert.equal(decodeQrMatrixIso(encodeQrMatrix(s0.verificationUrl).modules).text, s0.verificationUrl)

  const pWait = await mgr.poll({ sessionId: s0.sessionId })
  assert.equal(pWait.state, 'polling')
  assert.equal(pWait.scanned, false)

  pollMode = 'scanned'
  const pScanned = await mgr.poll({ sessionId: s0.sessionId })
  assert.equal(pScanned.state, 'polling')
  assert.equal(pScanned.scanned, true)

  pollMode = 'unknown'
  const pUnk = await mgr.poll({ sessionId: s0.sessionId })
  assert.equal(pUnk.state, 'polling')
  assert.match(pUnk.message, /PROVISIONING_NEW_STATE/)
  assert.equal(pUnk.meta?.status, 'PROVISIONING_NEW_STATE')

  pollMode = 'expired'
  const pExp = await mgr.poll({ sessionId: s0.sessionId })
  assert.equal(pExp.state, 'expired')

  pollMode = 'cancelled'
  const sCancel = await mgr.start({ platform: 'dingtalk', method: 'device-code' })
  const pCancel = await mgr.poll({ sessionId: sCancel.sessionId })
  assert.equal(pCancel.state, 'cancelled')

  pollMode = 'fail'
  const sFail = await mgr.start({ platform: 'dingtalk', method: 'device-code' })
  const pFail = await mgr.poll({ sessionId: sFail.sessionId })
  assert.equal(pFail.state, 'error')
  assert.equal(pFail.error?.code, 'dingtalk-registration-failed')

  pollMode = 'unknown'
  const sOk = await mgr.start({ platform: 'dingtalk', method: 'device-code' })
  const pOkPre = await mgr.poll({ sessionId: sOk.sessionId })
  assert.equal(pOkPre.state, 'polling')
  pollMode = 'completed'
  const pOk = await mgr.poll({ sessionId: sOk.sessionId })
  assert.equal(pOk.state, 'succeeded')
  assert.equal(saved.length, 1)
  assert.deepEqual(saved[0].configPatch, { clientId: 'ding_client_001' })
  assert.deepEqual(saved[0].secretPatch, { clientSecret: appSecret })
  assert.deepEqual(saved[0].self, { account: 'ding_client_001' })
  const serialized = JSON.stringify({ s0, pWait, pScanned, pUnk, pExp, pCancel, pFail, sOk, pOkPre, pOk, logs })
  assert.equal(serialized.includes(devCodeSecret), false, 'deviceCode 不得泄露到任何 view 或日志')
  assert.equal(serialized.includes(appSecret), false, 'clientSecret 不得泄露到任何 view 或日志')

  // 安全防线：拒绝非钉钉注册域名 / 非默认端口与超长 QR 链接
  const badUrlDriver = createDingtalkAuthDriver({
    fetchImpl: async (url) => url.endsWith('/init')
      ? jsonResp({ errcode: 0, nonce: 'n1' })
      : jsonResp({ errcode: 0, device_code: 'd1', verification_uri_complete: 'https://evil.example.com/qr' }),
  })
  await assert.rejects(
    () => badUrlDriver.start({ params: {}, currentConfig: {} }),
    (e) => e instanceof AuthError && e.code === 'invalid-qr-url',
  )
  await assert.rejects(
    () => badUrlDriver.start({ params: { registrationBaseUrl: 'https://oapi.dingtalk.com:8443' }, currentConfig: {} }),
    (e) => e instanceof AuthError && e.code === 'invalid-registration-url',
  )
  const longDriver = createDingtalkAuthDriver({
    fetchImpl: async (url) => url.endsWith('/init')
      ? jsonResp({ errcode: 0, nonce: 'n1' })
      : jsonResp({ errcode: 0, device_code: 'd1', verification_uri_complete: 'https://oapi.dingtalk.com/verify?t=' + 'a'.repeat(450) }),
  })
  await assert.rejects(
    () => longDriver.start({ params: {}, currentConfig: {} }),
    (e) => e instanceof AuthError && e.code === 'qr-too-long' && e.stage === 'auth.qr.encode',
  )
})

test('企业微信 AuthDriver (qr-link)：generate/query_result 状态机、域名校验、与 wechat-clawbot 隔离及零泄漏', async () => {
  const scodeSecret = 'wc_scode_secret_abc'
  const botSecret = 'wc_bot_secret_do_not_leak_777'
  const requests = []
  let pollState = 'init'

  const driver = createWecomAuthDriver({
    fetchImpl: async (url, init) => {
      assert.equal(init.redirect, 'error')
      requests.push(String(url))
      if (String(url).startsWith(WECOM_QR_GENERATE_URL)) {
        return jsonResp({ data: { scode: scodeSecret, auth_url: 'https://work.weixin.qq.com/ai/qc/auth?ticket=t1' } })
      }
      if (String(url).startsWith(WECOM_QR_POLL_URL)) {
        assert.ok(String(url).includes(`scode=${scodeSecret}`))
        if (pollState === 'success') {
          return jsonResp({ data: { status: 'success', bot_info: { botid: 'wc_bot_host_1', secret: botSecret } } })
        }
        return jsonResp({ data: { status: pollState } })
      }
      throw new Error('unexpected url')
    },
  })

  assert.equal(driver.validateInstance('wecom'), true)
  assert.equal(driver.validateInstance('wecom#sales'), true)
  assert.equal(driver.validateInstance('wechat-clawbot'), false, 'wecom 驱动绝不能匹配个人微信 wechat-clawbot')

  const logs = []
  const saved = []
  const mgr = createPlatformAuthManager({
    applyCompletion: async (payload) => { saved.push(payload) },
    log: { debug: (...a) => logs.push(a.join(' ')), info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')) },
  })
  mgr.register(driver)

  const s0 = await mgr.start({ platform: 'wecom', method: 'qr-link' })
  assert.equal(s0.state, 'qr_ready')
  assert.equal(decodeQrMatrixIso(encodeQrMatrix(s0.verificationUrl).modules).text, s0.verificationUrl)

  const pInit = await mgr.poll({ sessionId: s0.sessionId })
  assert.equal(pInit.state, 'polling')
  assert.equal(pInit.scanned, false)

  pollState = 'scanned'
  const pScan = await mgr.poll({ sessionId: s0.sessionId })
  assert.equal(pScan.state, 'polling')
  assert.equal(pScan.scanned, true)

  pollState = 'expired'
  const pExp = await mgr.poll({ sessionId: s0.sessionId })
  assert.equal(pExp.state, 'expired')

  pollState = 'success'
  const sOk = await mgr.start({ platform: 'wecom', method: 'qr-link' })
  const pOk = await mgr.poll({ sessionId: sOk.sessionId })
  assert.equal(pOk.state, 'succeeded')
  assert.equal(saved.length, 1)
  assert.deepEqual(saved[0].configPatch, { botId: 'wc_bot_host_1' })
  assert.deepEqual(saved[0].secretPatch, { secret: botSecret })
  assert.deepEqual(saved[0].self, { account: 'wc_bot_host_1' })

  const leaked = JSON.stringify({ s0, pInit, pScan, pExp, sOk, pOk, logs })
  assert.equal(leaked.includes(scodeSecret), false, 'scode 不得泄露到 view 或日志')
  assert.equal(leaked.includes(botSecret), false, 'secret 不得泄露到 view 或日志')

  // 拒绝非 work.weixin.qq.com 域名
  const untrusted = createWecomAuthDriver({
    fetchImpl: async () => jsonResp({ data: { scode: 's1', auth_url: 'https://evil.example.com/auth' } }),
  })
  await assert.rejects(
    () => untrusted.start({}),
    (e) => e instanceof AuthError && e.code === 'invalid-qr-url',
  )
})

test('宿主机 Phase 1B 全流程：钉钉 / 企业微信真实适配器与 AuthDriver 端到端闭环（不自动认主 + 平台隔离）', async (t) => {
  const dtSecret = 'host_dt_secret_xyz'
  const wcSecret = 'host_wc_secret_uvw'

  const { fake, app } = await bootPhase1BHost(t, {
    cfg: {
      enabled: true,
      dryRun: false,
      setupDone: true,
      platforms: {
        'wechat-clawbot': { enabled: false, botId: 'wx_personal@im.bot', botToken: 'wx_secret_keep' },
      },
    },
    opts: {
      authVerifyTimeoutMs: 2500,
      dingtalkAuthFetch: async (url) => {
        if (url.endsWith('/app/registration/init')) return jsonResp({ errcode: 0, nonce: 'n_host_1' })
        if (url.endsWith('/app/registration/begin')) {
          return jsonResp({
            errcode: 0,
            device_code: 'host_dt_dc_1',
            user_code: 'DT-HOST',
            verification_uri_complete: `${DINGTALK_REGISTRATION_BASE_URL}/verify?user_code=DT-HOST`,
            expires_in: 600,
            interval: 1,
          })
        }
        return jsonResp({ errcode: 0, status: 'SUCCESS', client_id: 'dt_host_client', client_secret: dtSecret })
      },
      dingtalkFetch: async (url) => {
        if (url.endsWith('/v1.0/gateway/connections/open')) {
          return jsonResp({ endpoint: 'wss://wss-open.dingtalk.com/connect', ticket: 'host_dt_t1' })
        }
        return jsonResp({ accessToken: 'host_dt_tok', expireIn: 7200 })
      },
      dingtalkWs: (u) => new HostMockWs(u),
      wecomAuthFetch: async (url) => {
        if (String(url).startsWith(WECOM_QR_GENERATE_URL)) {
          return jsonResp({ data: { scode: 'host_wc_sc_1', auth_url: 'https://work.weixin.qq.com/ai/qc/auth?ticket=host_1' } })
        }
        return jsonResp({ data: { status: 'success', bot_info: { botid: 'wc_host_bot', secret: wcSecret } } })
      },
      wecomFetch: async () => jsonResp({}),
      wecomWs: (u) => new HostMockWs(u),
    },
  })

  // 1) /platforms 应注册 dingtalk & wecom 及其 authMethods
  const plats = (await fake.call('/platforms')).json()
  const authList = (plats.authMethods || []).map((x) => `${x.platform}:${x.method}`)
  assert.ok(authList.includes('dingtalk:device-code'))
  assert.ok(authList.includes('wecom:qr-link'))

  // 2) 钉钉扫码创建并连接真实 Stream 适配器 + whoami 核对
  const dtStart = (await fake.call('/platforms/auth/start', { platform: 'dingtalk', method: 'device-code' })).json()
  assert.equal(dtStart.ok, true)
  const dtPoll = (await fake.call('/platforms/auth/poll', { sessionId: dtStart.sessionId })).json()
  assert.equal(dtPoll.ok, true, dtPoll.message)
  assert.equal(dtPoll.state, 'succeeded')
  assert.equal(dtPoll.self?.account, 'dt_host_client')
  assert.equal(dtPoll.configs?.dingtalk?.clientId, 'dt_host_client')
  assert.equal(dtPoll.configs?.dingtalk?.clientSecret, '')
  assert.equal(dtPoll.configs?.dingtalk?.clientSecretSet, true)
  assert.equal(app.getConfig().platforms?.dingtalk?.clientSecret, dtSecret)
  assert.equal(JSON.stringify(dtPoll).includes(dtSecret), false)

  // 3) 企业微信智能机器人扫码绑定并连接真实 WS 适配器，绝不覆盖 wechat-clawbot 与主人身份
  const wcStart = (await fake.call('/platforms/auth/start', { platform: 'wecom', method: 'qr-link' })).json()
  assert.equal(wcStart.ok, true)
  const wcPoll = (await fake.call('/platforms/auth/poll', { sessionId: wcStart.sessionId })).json()
  assert.equal(wcPoll.ok, true, wcPoll.message)
  assert.equal(wcPoll.state, 'succeeded')
  assert.equal(wcPoll.self?.account, 'wc_host_bot')
  assert.equal(wcPoll.configs?.wecom?.botId, 'wc_host_bot')
  assert.equal(wcPoll.configs?.wecom?.secret, '')
  assert.equal(wcPoll.configs?.wecom?.secretSet, true)
  assert.equal(app.getConfig().platforms?.wecom?.secret, wcSecret)
  assert.equal(app.getConfig().platforms?.['wechat-clawbot']?.botId, 'wx_personal@im.bot')
  assert.equal(app.getConfig().platforms?.['wechat-clawbot']?.botToken, 'wx_secret_keep')
  assert.equal(app.getConfig().ownerPersonId, '', '扫码成功绝不能自动认主')
  assert.equal(JSON.stringify(wcPoll).includes(wcSecret), false)

  // 4) cancel 端点可用
  const dt2 = (await fake.call('/platforms/auth/start', { platform: 'dingtalk', method: 'device-code', instance: 'dingtalk#2' })).json()
  const dtCancel = (await fake.call('/platforms/auth/cancel', { sessionId: dt2.sessionId })).json()
  assert.equal(dtCancel.state, 'cancelled')

  // 5) shared-platform-target 别名解析（钉钉 / 企微）
  const catalog = (await fake.call('/platforms')).json().catalog || []
  const targetRes = resolveSharedPlatformTarget({
    platform: '钉钉',
    ownerPersonId: 'p-owner',
    sourceChatId: 'qq:private:10001',
    identity: { owner: () => 'p-owner', accountsOf: () => [{ platform: 'dingtalk', account: 'u_dt_1' }], lookup: () => 'p-owner' },
    gateway: {
      catalog: () => catalog,
      instances: () => [{ instance: 'dingtalk', platform: 'dingtalk', enabled: true, state: 'connected', caps: { proactive: 'free' } }],
    },
  })
  assert.equal(targetRes.ok, true)
  assert.equal(targetRes.chatId, 'dingtalk:private:u_dt_1')
})

test('面板与设置向导源码契约：Platforms 卡片与 Wizard 接入 DingtalkQrBox / WecomQrBox 且明确隔离与不自动认主', () => {
  const client = readFileSync(new URL('../../client/client.js', import.meta.url), 'utf8')
  assert.ok(client.includes('function DingtalkQrBox('), '缺少 DingtalkQrBox 组件')
  assert.ok(client.includes('function WecomQrBox('), '缺少 WecomQrBox 组件')
  assert.ok(client.includes("platform: 'dingtalk'") && client.includes("method: 'device-code'"), 'DingtalkQrBox 未绑定 device-code')
  assert.ok(client.includes("platform: 'wecom'") && client.includes("method: 'qr-link'"), 'WecomQrBox 未绑定 qr-link')
  assert.ok(client.includes("inst.platform === 'dingtalk'") && client.includes('h(DingtalkQrBox'), 'Platforms 卡片未挂接 DingtalkQrBox')
  assert.ok(client.includes("inst.platform === 'wecom'") && client.includes('h(WecomQrBox'), 'Platforms 卡片未挂接 WecomQrBox')
  assert.ok(client.includes("mode === 'dingtalk'") && client.includes("mode === 'wecom'"), 'Wizard 配置步骤未挂接钉钉/企微扫码')
  assert.ok(client.includes('与个人微信 wechat-clawbot 完全隔离') || client.includes('与个人微信 wechat-clawbot 隔离'), '面板缺少 wecom 与个人微信隔离提示')
})

test('宿主机 Hub sendParts / sendSegments 语音条联动：AMR 与 FFmpeg WAV 转码直达 wecom / dingtalk', async (t) => {
  const frame = Buffer.alloc(32, 0xaa)
  frame[0] = (7 << 3) | 0x04
  const validAmr1s = Buffer.concat([Buffer.from('#!AMR\n', 'ascii'), ...Array.from({ length: 50 }, () => frame)])

  const wcSockets = []
  const dtCalls = []
  const { app } = await bootPhase1BHost(t, {
    cfg: {
      enabled: true,
      dryRun: false,
      setupDone: true,
      platforms: {
        dingtalk: { enabled: true, clientId: 'dt_hub_1', clientSecret: 'dt_hub_sec' },
        wecom: { enabled: true, botId: 'wc_hub_1', secret: 'wc_hub_sec' },
      },
    },
    opts: {
      dingtalkFetch: async (url, init = {}) => {
        const u = String(url)
        const parsedBody = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : null
        dtCalls.push({ url: u, body: parsedBody })
        if (u.endsWith('/v1.0/gateway/connections/open')) {
          return jsonResp({ endpoint: 'wss://wss-open.dingtalk.com/connect', ticket: 'hub_t1' })
        }
        if (u.endsWith('/v1.0/oauth2/accessToken')) {
          return jsonResp({ accessToken: 'hub_tok_1', expireIn: 7200 })
        }
        if (u.includes('/media/upload?')) {
          return jsonResp({ errcode: 0, media_id: `@lAD_hub_${dtCalls.length}` })
        }
        if (u.endsWith('/v1.0/robot/oToMessages/batchSend')) {
          return jsonResp({ processQueryKey: `dt_hub_msg_${dtCalls.length}` })
        }
        return jsonResp({}, 404)
      },
      dingtalkWs: (u) => new HostMockWs(u),
      wecomWs: (u) => {
        const s = new HostMockWs(u)
        wcSockets.push(s)
        return s
      },
    },
  })

  await app.gateway.sync()

  await app.hub.sendParts(
    'wecom:private:u_hub_wc',
    [{ type: 'voice', media: { bytes: validAmr1s, mime: 'audio/amr', name: 'tts.amr' } }],
    { force: true, throwOnError: true },
  )
  await app.hub.sendSegments(
    'dingtalk:private:u_hub_dt',
    [{ type: 'record', data: { file: 'base64://' + validAmr1s.toString('base64') } }],
    '[语音]',
    { force: true, throwOnError: true },
  )

  const wcInits = wcSockets[0].sentFrames.filter((f) => f.cmd === WECOM_WS_CMD.UPLOAD_MEDIA_INIT).map((f) => f.body)
  const wcSends = wcSockets[0].sentFrames.filter((f) => f.cmd === WECOM_WS_CMD.SEND_MSG).map((f) => f.body)
  assert.equal(wcInits[0].type, 'voice')
  assert.equal(wcSends[0].msgtype, 'voice')

  const dtUpload = dtCalls.find((c) => c.url.includes('/media/upload?'))
  assert.match(dtUpload.url, /type=voice/)
  const dtSend = dtCalls.find((c) => c.url.endsWith('/v1.0/robot/oToMessages/batchSend'))
  assert.equal(dtSend.body.msgKey, 'sampleAudio')
  assert.equal(JSON.parse(dtSend.body.msgParam).duration, '1000')

  const ffmpegBin = findFfmpeg(String(app.getConfig().tools?.ffmpeg?.path || ''))
  if (ffmpegBin) {
    const pcmBytes = 16000 * 2
    const wav1s = Buffer.alloc(44 + pcmBytes, 0)
    wav1s.write('RIFF', 0)
    wav1s.writeUInt32LE(36 + pcmBytes, 4)
    wav1s.write('WAVEfmt ', 8)
    wav1s.writeUInt32LE(16, 16)
    wav1s.writeUInt16LE(1, 20)
    wav1s.writeUInt16LE(1, 22)
    wav1s.writeUInt32LE(16000, 24)
    wav1s.writeUInt32LE(32000, 28)
    wav1s.writeUInt16LE(2, 32)
    wav1s.writeUInt16LE(16, 34)
    wav1s.write('data', 36)
    wav1s.writeUInt32LE(pcmBytes, 40)

    await app.hub.sendParts(
      'wecom:private:u_hub_wc_wav',
      [{ type: 'voice', media: { bytes: wav1s, mime: 'audio/amr', name: 'tts.amr' } }],
      { force: true, throwOnError: true },
    )
    const wcInitsAfter = wcSockets[0].sentFrames.filter((f) => f.cmd === WECOM_WS_CMD.UPLOAD_MEDIA_INIT).map((f) => f.body)
    const wcSendsAfter = wcSockets[0].sentFrames.filter((f) => f.cmd === WECOM_WS_CMD.SEND_MSG).map((f) => f.body)
    assert.equal(wcInitsAfter.at(-1).type, 'voice')
    assert.equal(wcSendsAfter.at(-1).msgtype, 'voice')
  }
})
