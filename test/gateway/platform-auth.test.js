// Phase 0 统一认证基础设施测试：通用 QR 编码、状态机、取消/退避/防泄漏、微信 ClawBot 驱动与宿主机路由集成。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'

import {
  MAX_QR_UTF8_BYTES,
  encodeQrMatrix,
  encodeQrSvg,
  encodeQrSvgDataUri,
  isSafeQrImageDataUri,
  renderQrDataUri,
} from '../../src/core/qr.js'
import {
  AUTH_ERROR_STAGES,
  AuthError,
  createPlatformAuthManager,
  sanitizeAuthSessionView,
} from '../../src/gateway/auth.js'
import { createWechatClawbotAuthDriver } from '../../src/adapters/wechat-clawbot/index.js'
import { createFakeDsh } from '../helpers/fake-dsh.js'
import { decodeQrMatrixIso } from '../helpers/qr-decoder.js'
import {
  createFakeCancelDriver,
  createFakeDeviceCodeDriver,
  createFakeDomainSwitchDriver,
  createFakeExpiredDriver,
  createFakeQrAppDriver,
  createFakeSlowDownDriver,
} from '../helpers/fake-auth-drivers.js'

test('src/core/qr.js：支持 V1–V16（最高 450 UTF-8 字节），校验 URI 安全与超限报错', () => {
  assert.equal(MAX_QR_UTF8_BYTES, 450)
  for (const sample of [
    'https://ex.co/a', // V1/V2
    'https://open.feishu.cn/qr/' + 'x'.repeat(210), // ~236B -> V11
    'https://accounts.example.com/oauth/device?user_code=ABCD-EFGH&redirect=' + 'y'.repeat(280), // ~349B -> V14
    'https://open.example.com/auth?' + 'z'.repeat(410), // ~440B -> V16
  ]) {
    const { version, size, modules } = encodeQrMatrix(sample)
    assert.ok(version >= 1 && version <= 16)
    assert.equal(size, 17 + version * 4)
    assert.equal(modules.length, size)
    // Timing pattern 第 6 行/第 6 列严格交替
    for (let i = 8; i < size - 8; i++) {
      assert.equal(modules[6][i], i % 2 === 0 ? 1 : 0)
      assert.equal(modules[i][6], i % 2 === 0 ? 1 : 0)
    }
    const svg = encodeQrSvg(sample)
    assert.ok(svg.startsWith('<svg '))
    const dataUri = encodeQrSvgDataUri(sample)
    assert.ok(dataUri.startsWith('data:image/svg+xml;base64,'))
    assert.equal(isSafeQrImageDataUri(dataUri), true)
  }

  // 安全 Data URI 透传与危险协议拦截
  const pngUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
  assert.equal(renderQrDataUri(pngUri), pngUri)
  assert.throws(() => renderQrDataUri(''), /不能为空/)
  assert.throws(() => renderQrDataUri('javascript:alert(1)'), /不支持/)
  assert.throws(() => renderQrDataUri('data:text/html;base64,PGh0bWw+'), /不支持/)
  assert.throws(() => encodeQrMatrix('a'.repeat(451)), /上限 450/)
})

test('AuthManager：qr-app 与 device-code 完整状态机、展示字段在终态自动清除', async () => {
  const saved = []
  let synced = 0
  const mgr = createPlatformAuthManager({
    applyCompletion: async (payload) => { saved.push(payload) },
    syncInstance: async () => { synced++ },
    verifyInstance: async ({ expectedSelf }) => ({ ok: true, self: expectedSelf }),
  })

  // 1) fake-qr-app
  const qrDriver = createFakeQrAppDriver()
  mgr.register(qrDriver)
  const s1 = await mgr.start({ platform: 'fake-qr', method: 'qr-app', params: { region: 'overseas' } })
  assert.equal(s1.state, 'qr_ready')
  assert.ok(s1.qrDataUri.startsWith('data:image/svg+xml;base64,'))
  assert.equal(s1.verificationUrl, 'https://auth.example.com/qr/ticket_alpha_001')

  const p1 = await mgr.poll({ sessionId: s1.sessionId })
  assert.equal(p1.state, 'polling')
  assert.equal(p1.scanned, true)
  assert.ok(p1.qrDataUri)

  const p2 = await mgr.poll({ sessionId: s1.sessionId })
  assert.equal(p2.state, 'succeeded')
  assert.equal(p2.qrDataUri, undefined, '成功后必须隐藏二维码')
  assert.equal(p2.verificationUrl, undefined, '成功后必须隐藏授权链接')
  assert.equal(p2.self?.account, 'bot_fake_qr_1')
  assert.equal(saved.length, 1)
  assert.equal(synced, 1)
  assert.deepEqual(saved[0].configPatch, { botId: 'bot_fake_qr_1', region: 'overseas' })
  assert.deepEqual(saved[0].secretPatch, { botToken: 'fake_qr_bot_token_secret_12345' })

  // 2) fake-device-code（RFC 8628：deviceCode 绝不暴露到视图）
  let clock = 10_000
  const devMgr = createPlatformAuthManager({
    now: () => clock,
    applyCompletion: async (payload) => { saved.push(payload) },
  })
  const devDriver = createFakeDeviceCodeDriver()
  devMgr.register(devDriver)
  const d0 = await devMgr.start({ platform: 'fake-device', method: 'device-code' })
  assert.equal(d0.state, 'device_code_ready')
  assert.equal(d0.userCode, 'ABCD-EFGH')
  assert.equal(d0.verificationUrl, 'https://auth.example.com/device')
  assert.ok(!JSON.stringify(d0).includes('dev_code_secret_xyz_9988'), 'AuthSessionView 严禁暴露 deviceCode')

  const d1 = await devMgr.poll({ sessionId: d0.sessionId })
  assert.equal(d1.state, 'slow_down')
  assert.equal(d1.pollIntervalMs, 4000)

  // 未满 slow_down 退避期不触发上游轮询
  clock += 1000
  const d1Blocked = await devMgr.poll({ sessionId: d0.sessionId })
  assert.equal(d1Blocked.state, 'slow_down')
  assert.equal(devDriver.pollCalls.length, 1)

  clock += 4000
  const d2 = await devMgr.poll({ sessionId: d0.sessionId })
  assert.equal(d2.state, 'succeeded')
  assert.equal(d2.userCode, undefined, '成功后必须隐藏 userCode')
  assert.equal(d2.verificationUrl, undefined)
  assert.ok(!JSON.stringify(d2).includes('dev_app_secret_should_never_leak_7766'))
})

test('AuthManager：domain_switched 刷新二维码，slow_down 退避，TTL 过期与上游 expired', async () => {
  let clock = 1_000_000
  const saved = []
  const mgr = createPlatformAuthManager({
    now: () => clock,
    applyCompletion: async (p) => { saved.push(p) },
  })
  mgr.register(createFakeDomainSwitchDriver())
  const slowDriver = createFakeSlowDownDriver({ intervalMs: 6000 })
  mgr.register(slowDriver)
  const expDriver = createFakeExpiredDriver()
  mgr.register(expDriver)

  // domain_switched
  const ds0 = await mgr.start({ platform: 'fake-domain', method: 'qr-app' })
  assert.equal(ds0.domain, 'open.feishu.cn')
  const ds1 = await mgr.poll({ sessionId: ds0.sessionId })
  assert.equal(ds1.state, 'domain_switched')
  assert.equal(ds1.domain, 'open.larksuite.com')
  assert.notEqual(ds1.qrDataUri, ds0.qrDataUri)
  const ds2 = await mgr.poll({ sessionId: ds0.sessionId })
  assert.equal(ds2.state, 'succeeded')

  // slow_down 退避拦截
  const sl0 = await mgr.start({ platform: 'fake-slow', method: 'qr-link' })
  const sl1 = await mgr.poll({ sessionId: sl0.sessionId })
  assert.equal(sl1.state, 'slow_down')
  assert.equal(sl1.pollIntervalMs, 6000)
  clock += 2000
  await mgr.poll({ sessionId: sl0.sessionId })
  assert.equal(slowDriver.pollCount, 1, '退避窗口内不得再次调用 driver.poll')
  clock += 4500
  const sl2 = await mgr.poll({ sessionId: sl0.sessionId })
  assert.equal(sl2.state, 'succeeded')
  assert.equal(slowDriver.pollCount, 2)

  // 上游 expired
  const e0 = await mgr.start({ platform: 'fake-expired', method: 'qr-app' })
  const e1 = await mgr.poll({ sessionId: e0.sessionId })
  assert.equal(e1.state, 'expired')
  assert.equal(e1.qrDataUri, undefined)
  assert.equal(e1.error?.stage, 'auth.qr.expire')

  // 本地 TTL 超时过期
  const e2 = await mgr.start({ platform: 'fake-expired', method: 'qr-app' })
  clock += 60_000
  const e3 = await mgr.poll({ sessionId: e2.sessionId })
  assert.equal(e3.state, 'expired')
  assert.equal(e3.error?.stage, 'auth.qr.expire')
  assert.ok(expDriver.cancelCalls.includes('expired'))
})

test('AuthManager：cancel 中止信号、重复 start 替换旧会话与迟到 poll 绝不落盘、并发 poll 去重', async () => {
  const saved = []
  const mgr = createPlatformAuthManager({
    applyCompletion: async (p) => { saved.push(p) },
  })
  const cancelDriver = createFakeCancelDriver()
  mgr.register(cancelDriver)

  // 1) 同 instance + method 再次 start：必须中止旧信号、取消旧会话，迟到的 authorized 绝不写入配置
  const sOld = await mgr.start({ platform: 'fake-cancel', instance: 'fake-cancel', method: 'qr-app' })
  const inFlightOldPoll = mgr.poll({ sessionId: sOld.sessionId })
  assert.equal(cancelDriver.signals[0].aborted, false)

  const sNew = await mgr.start({ platform: 'fake-cancel', instance: 'fake-cancel', method: 'qr-app' })
  assert.notEqual(sNew.sessionId, sOld.sessionId)
  assert.equal(cancelDriver.signals[0].aborted, true, '重新 start 必须中止旧会话 AbortSignal')
  assert.ok(cancelDriver.cancelCalls.includes('replaced'))

  // 模拟旧请求在被取消后迟到返回 authorized
  cancelDriver.releaseFirstPollWith({
    state: 'authorized',
    completion: {
      configPatch: { botId: 'stale_should_not_save' },
      secretPatch: { botToken: 'stale_secret_tok' },
    },
  })
  const lateRes = await inFlightOldPoll
  assert.equal(lateRes.state, 'cancelled')
  assert.equal(saved.length, 0, '已替代旧会话的迟到 authorized 绝不可写入凭证')

  // 2) 显式 cancel 幂等并隐藏二维码
  const cancelledView = await mgr.cancel({ sessionId: sNew.sessionId, reason: 'user-clicked' })
  assert.equal(cancelledView.state, 'cancelled')
  assert.equal(cancelledView.qrDataUri, undefined)
  assert.ok(cancelDriver.cancelCalls.includes('user-clicked'))
  const cancelledAgain = await mgr.cancel({ sessionId: sNew.sessionId })
  assert.equal(cancelledAgain.state, 'cancelled')

  // 3) 多实例隔离 + 并发 poll 防重入（只调一次 driver.poll 且只写一次）
  let singlePollCalls = 0
  let resolveSlowPoll = null
  const slowQrDriver = createFakeQrAppDriver({
    pollSteps: [() => {
      singlePollCalls++
      return new Promise((resolve) => {
        resolveSlowPoll = () => resolve({
          state: 'authorized',
          completion: {
            configPatch: { botId: 'bot_dedupe' },
            secretPatch: { botToken: 'dedupe_tok_999' },
            self: { account: 'bot_dedupe' },
          },
        })
      })
    }],
  })
  mgr.register(slowQrDriver)
  const inst2 = await mgr.start({ platform: 'fake-qr', instance: 'fake-qr#acct2', method: 'qr-app' })
  const pA = mgr.poll({ sessionId: inst2.sessionId })
  const pB = mgr.poll({ sessionId: inst2.sessionId })
  await new Promise((r) => setTimeout(r, 15))
  assert.equal(singlePollCalls, 1, '同一 session 并发 poll 只允许一次在途 upstream 请求')
  resolveSlowPoll()
  const [resA, resB] = await Promise.all([pA, pB])
  assert.equal(resA.state, 'succeeded')
  assert.equal(resB.state, 'succeeded')
  assert.equal(saved.length, 1, '并发 poll 成功后只落盘一次')
})

test('AuthManager：错误阶段码、configPatch/secretPatch 安全边界与敏感字段全链路零泄漏', async () => {
  const registeredSecrets = []
  const saved = []
  const logs = []
  let failStage = 'none'

  const mgr = createPlatformAuthManager({
    registerSecret: (s) => registeredSecrets.push(s),
    redact: (text) => {
      let out = String(text ?? '')
      for (const s of registeredSecrets) if (s) out = out.split(s).join('[redacted]')
      return out
    },
    applyCompletion: async (payload) => {
      if (failStage === 'save') throw new Error('disk full while writing fake_leak_secret_888')
      saved.push(payload)
    },
    syncInstance: async () => {
      if (failStage === 'connect') throw new Error('ws dial timeout')
    },
    verifyInstance: async () => {
      if (failStage === 'verify') return { ok: false, code: 'whoami-mismatch', message: '账号不符：bot_wrong' }
      return { ok: true }
    },
    log: { debug: (...a) => logs.push(a.join(' ')), info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')) },
  })

  // unsupported platform / method / invalid instance -> auth.begin
  await assert.rejects(
    () => mgr.start({ platform: 'nonexistent', method: 'qr-app' }),
    (e) => e instanceof AuthError && e.stage === 'auth.begin' && e.code === 'auth-unsupported',
  )
  const baseDriver = createFakeQrAppDriver()
  mgr.register(baseDriver)
  await assert.rejects(
    () => mgr.start({ platform: 'fake-qr', method: 'device-code' }),
    (e) => e instanceof AuthError && e.stage === 'auth.begin' && e.code === 'auth-unsupported',
  )
  await assert.rejects(
    () => mgr.start({ platform: 'fake-qr', instance: 'other#1', method: 'qr-app' }),
    (e) => e instanceof AuthError && e.stage === 'auth.begin' && e.code === 'invalid-instance',
  )

  // qrContent 编码失败 -> auth.qr.encode
  await assert.rejects(
    () => mgr.start({ platform: 'fake-qr', method: 'qr-app', params: { qrContent: 'k'.repeat(500) } }),
    (e) => e instanceof AuthError && e.stage === 'auth.qr.encode' && e.code === 'qr-encode-failed',
  )

  // malicious secret leak driver: configPatch 塞 secret/deviceCode/非白名单键、meta 塞 secret
  let mode = 'leak-config-secret'
  mgr.register({
    platform: 'sec-test',
    methods: [{ method: 'qr-app', label: 'SecTest' }],
    allowedConfigKeys: ['botId'],
    async start() {
      return {
        state: 'qr_ready',
        driverSession: { deviceCode: 'dev_code_must_redact_444', rawToken: 'raw_tok_must_redact_555' },
        qrContent: 'https://auth.example.com/sec/1',
        extraSecret: 'must_not_copy_into_view',
        meta: { appSecret: 'meta_secret_drop_me', note: 'using dev_code_must_redact_444 ok' },
      }
    },
    async poll() {
      if (mode === 'throw-secret') {
        throw new Error('upstream failed with dev_code_must_redact_444 and raw_tok_must_redact_555')
      }
      if (mode === 'leak-config-secret') {
        return {
          state: 'authorized',
          completion: {
            configPatch: { appSecret: 'forbidden_in_config' },
            secretPatch: { botToken: 'valid_tok_123' },
          },
        }
      }
      if (mode === 'leak-config-transient') {
        return {
          state: 'authorized',
          completion: {
            configPatch: { deviceCode: 'forbidden_transient' },
            secretPatch: { botToken: 'valid_tok_123' },
          },
        }
      }
      if (mode === 'bad-secret-key') {
        return {
          state: 'authorized',
          completion: {
            configPatch: { botId: 'b1' },
            secretPatch: { unknownField: 'val_123' },
          },
        }
      }
      return {
        state: 'authorized',
        completion: {
          configPatch: { botId: 'b1' },
          secretPatch: { botToken: 'fake_leak_secret_888' },
          self: { account: 'b1' },
          meta: { botToken: 'should_drop_from_meta', botId: 'b1' },
        },
      }
    },
  })

  const sv = await mgr.start({ platform: 'sec-test', method: 'qr-app' })
  const svJson = JSON.stringify(sv)
  assert.ok(!svJson.includes('dev_code_must_redact_444'))
  assert.ok(!svJson.includes('raw_tok_must_redact_555'))
  assert.ok(!svJson.includes('must_not_copy_into_view'))
  assert.ok(!svJson.includes('meta_secret_drop_me'))
  assert.equal(sv.extraSecret, undefined)

  // 抛出含敏感串的 error 必须被脱敏
  mode = 'throw-secret'
  const errPoll = await mgr.poll({ sessionId: sv.sessionId })
  assert.equal(errPoll.state, 'error')
  assert.equal(errPoll.error?.stage, 'auth.poll')
  assert.ok(!JSON.stringify(errPoll).includes('dev_code_must_redact_444'))
  assert.ok(!JSON.stringify(errPoll).includes('raw_tok_must_redact_555'))

  // configPatch 写 secret -> auth.save 拒绝
  mode = 'leak-config-secret'
  const sCfg1 = await mgr.start({ platform: 'sec-test', method: 'qr-app' })
  const rCfg1 = await mgr.poll({ sessionId: sCfg1.sessionId })
  assert.equal(rCfg1.state, 'error')
  assert.equal(rCfg1.error?.stage, 'auth.save')
  assert.equal(rCfg1.error?.code, 'invalid-config-patch')

  // configPatch 写 deviceCode -> auth.save 拒绝
  mode = 'leak-config-transient'
  const sCfg2 = await mgr.start({ platform: 'sec-test', method: 'qr-app' })
  const rCfg2 = await mgr.poll({ sessionId: sCfg2.sessionId })
  assert.equal(rCfg2.state, 'error')
  assert.equal(rCfg2.error?.stage, 'auth.save')

  // secretPatch 未登记键 -> auth.save 拒绝
  mode = 'bad-secret-key'
  const sCfg3 = await mgr.start({ platform: 'sec-test', method: 'qr-app' })
  const rCfg3 = await mgr.poll({ sessionId: sCfg3.sessionId })
  assert.equal(rCfg3.state, 'error')
  assert.equal(rCfg3.error?.stage, 'auth.save')
  assert.equal(rCfg3.error?.code, 'invalid-secret-patch')
  assert.equal(saved.length, 0)

  // applyCompletion / sync / verify 失败阶段归类与秘密脱敏
  mode = 'ok'
  failStage = 'save'
  const sSaveFail = await mgr.start({ platform: 'sec-test', method: 'qr-app' })
  const rSaveFail = await mgr.poll({ sessionId: sSaveFail.sessionId })
  assert.equal(rSaveFail.error?.stage, 'auth.save')
  assert.ok(!JSON.stringify(rSaveFail).includes('fake_leak_secret_888'))

  failStage = 'connect'
  const sConnFail = await mgr.start({ platform: 'sec-test', method: 'qr-app' })
  const rConnFail = await mgr.poll({ sessionId: sConnFail.sessionId })
  assert.equal(rConnFail.error?.stage, 'auth.connect')

  failStage = 'verify'
  const sVerFail = await mgr.start({ platform: 'sec-test', method: 'qr-app' })
  const rVerFail = await mgr.poll({ sessionId: sVerFail.sessionId })
  assert.equal(rVerFail.error?.stage, 'auth.verify')
  assert.equal(rVerFail.error?.code, 'whoami-mismatch')

  failStage = 'none'
  const sOk = await mgr.start({ platform: 'sec-test', method: 'qr-app' })
  const rOk = await mgr.poll({ sessionId: sOk.sessionId })
  assert.equal(rOk.state, 'succeeded')
  assert.equal(rOk.meta?.botId, 'b1')
  assert.equal(rOk.meta?.botToken, undefined)
  assert.ok(!JSON.stringify(rOk).includes('fake_leak_secret_888'))
  assert.ok(!JSON.stringify(logs).includes('fake_leak_secret_888'))

  // 验证所有 9 个合法 stage 枚举存在
  for (const s of ['auth.begin', 'auth.qr.encode', 'auth.qr.expire', 'auth.poll', 'auth.slow_down', 'auth.cancel', 'auth.verify', 'auth.save', 'auth.connect']) {
    assert.ok(AUTH_ERROR_STAGES.includes(s))
  }
  assert.equal(sanitizeAuthSessionView(null), null)
})

test('WeChat ClawBot AuthDriver：支持 qr-link 全流程与 -14 失效拦截', async () => {
  let mode = 'normal'
  let step = 0
  const client = {
    async request(req) {
      const url = String(req.url || '')
      if (url.includes('/ilink/bot/get_bot_qrcode')) {
        return {
          status: 200,
          headers: {},
          json: { qrcode: 'wx_drv_qr_1', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/drv1' },
        }
      }
      if (url.includes('/ilink/bot/get_qrcode_status')) {
        if (mode === 'err14') {
          return { status: 200, headers: {}, json: { errcode: -14, errmsg: 'session timeout' } }
        }
        step++
        if (step === 1) return { status: 200, headers: {}, json: { status: 'wait' } }
        if (step === 2) return { status: 200, headers: {}, json: { status: 'scaned' } }
        return {
          status: 200,
          headers: {},
          json: {
            status: 'confirmed',
            bot_token: 'wx_drv_secret_token_666',
            ilink_bot_id: 'wx_drv_bot@im.bot',
            baseurl: 'https://ilinkai.weixin.qq.com',
            ilink_user_id: 'wx_scanner_1',
          },
        }
      }
      return { status: 404, headers: {}, json: {} }
    },
  }

  const saved = []
  const mgr = createPlatformAuthManager({ applyCompletion: async (p) => saved.push(p) })
  mgr.register(createWechatClawbotAuthDriver({ defaultClient: client }))

  // 非 HTTPS baseUrl 在 auth.begin 阶段拦截
  await assert.rejects(
    () => mgr.start({ platform: 'wechat-clawbot', method: 'qr-link', params: { baseUrl: 'http://evil.example.com' } }),
    (e) => e instanceof AuthError && e.stage === 'auth.begin',
  )

  const v0 = await mgr.start({ platform: 'wechat-clawbot', method: 'qr-link', params: { routeTag: 'canary' } })
  assert.equal(v0.state, 'qr_ready')
  assert.ok(v0.qrDataUri.startsWith('data:image/svg+xml;base64,'))

  const v1 = await mgr.poll({ sessionId: v0.sessionId })
  assert.equal(v1.state, 'polling')
  assert.equal(v1.scanned, false)

  const v2 = await mgr.poll({ sessionId: v0.sessionId })
  assert.equal(v2.state, 'polling')
  assert.equal(v2.scanned, true)

  const v3 = await mgr.poll({ sessionId: v0.sessionId })
  assert.equal(v3.state, 'succeeded')
  assert.equal(v3.qrDataUri, undefined)
  assert.ok(!JSON.stringify(v3).includes('wx_drv_secret_token_666'))
  assert.equal(saved.length, 1)
  assert.deepEqual(saved[0].configPatch, {
    botId: 'wx_drv_bot@im.bot',
    baseUrl: 'https://ilinkai.weixin.qq.com',
    routeTag: 'canary',
  })
  assert.deepEqual(saved[0].secretPatch, { botToken: 'wx_drv_secret_token_666' })

  // -14 错误停轮询
  mode = 'err14'
  const vErrStart = await mgr.start({ platform: 'wechat-clawbot', method: 'qr-link' })
  const vErrPoll = await mgr.poll({ sessionId: vErrStart.sessionId })
  assert.equal(vErrPoll.state, 'error')
  assert.equal(vErrPoll.error?.stage, 'auth.poll')
  assert.equal(vErrPoll.error?.code, 'session-expired-14')
  assert.equal(vErrPoll.error?.retryable, false)
})

async function bootAuthHost(t, { cfg, opts = {} } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aurabot-auth-host-'))
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
  })
  await app.ready
  return { fake, app, dataDir }
}

test('宿主机统一认证路由：/platforms/auth/start|poll|cancel、凭证脱敏、不自动认主、whoami 不符自动断开与兼容旧路由', async (t) => {
  const devDriver = createFakeDeviceCodeDriver({
    platform: 'fake-device',
    deviceCodeSecret: 'host_dev_code_secret_111',
    appSecret: 'host_app_secret_do_not_expose_222',
    account: 'expected_device_bot',
    includeSlowDown: false,
  })
  const mismatchDriver = createFakeQrAppDriver({
    platform: 'fake-mismatch',
    account: 'expected_bot_999',
    botToken: 'mismatch_bot_secret_333',
  })
  const makeFakeAdapter = (id, whoamiAccount) => () => ({
    id,
    name: id,
    contract: 1,
    settings: [{ key: 'appSecret', label: 'Secret', type: 'password' }],
    caps: () => ({
      image: true, sticker: false, voice: false, video: false, file: true, maxFileBytes: 1024,
      quoteReply: false, mention: false, mentionAll: false, poke: false, typing: false, recall: false,
      card: false, listenAllInGroup: false, proactive: 'free', replyWindowMs: 0, repliesPerMessage: 0,
      history: false, memberList: false, forwardExpand: false,
    }),
    async start(ctx) { ctx.state('connected', 'fake connected') },
    async stop() {},
    async whoami() { return { account: whoamiAccount, name: whoamiAccount } },
    async send() { return { messageId: 'm1' } },
  })

  // 仅允许 iLink QR 流程的小型 mock client（验证新旧路由兼容与不自动认主）
  let wxStep = 0
  const wechatClient = {
    async request(req) {
      const url = String(req.url || '')
      if (url.includes('/ilink/bot/get_bot_qrcode')) {
        return { status: 200, headers: {}, json: { qrcode: 'wx_compat_qr', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/compat' } }
      }
      if (url.includes('/ilink/bot/get_qrcode_status')) {
        wxStep++
        if (wxStep === 1) return { status: 200, headers: {}, json: { status: 'wait' } }
        return {
          status: 200,
          headers: {},
          json: { status: 'confirmed', bot_token: 'wx_compat_secret_777', ilink_bot_id: 'wx_compat@im.bot', baseurl: 'https://ilinkai.weixin.qq.com' },
        }
      }
      if (url.includes('/ilink/bot/getupdates')) {
        return { status: 200, headers: {}, json: { ret: 0, get_updates_buf: 'b1', msgs: [] } }
      }
      return { status: 404, headers: {}, json: {} }
    },
  }

  const { fake, app, dataDir } = await bootAuthHost(t, {
    cfg: {
      enabled: true,
      dryRun: false,
      setupDone: true,
      platforms: { qq: { enabled: false } },
    },
    opts: {
      wechatClient,
      authDrivers: [devDriver, mismatchDriver],
      adapters: [
        makeFakeAdapter('fake-device', 'expected_device_bot'),
        makeFakeAdapter('fake-mismatch', 'actual_wrong_bot'),
      ],
    },
  })

  const sharedBefore = JSON.stringify(app.hub.sharedStatus())

  // 1) /platforms 投影 authMethods（含 wechat-clawbot 与测试注入驱动）且初始无主人
  const pView = (await fake.call('/platforms')).json()
  assert.equal(pView.owner, null)
  assert.ok(Array.isArray(pView.authMethods))
  assert.ok(pView.authMethods.some((m) => m.platform === 'wechat-clawbot' && m.method === 'qr-link'))
  assert.ok(pView.authMethods.some((m) => m.platform === 'fake-device' && m.method === 'device-code'))

  // 2) Device Code 完整闭环 + authMode 落盘 + 凭证脱敏 + 不自动认主 + 共享会话隔离
  const st0 = (await fake.call('/platforms/auth/start', { platform: 'fake-device', method: 'device-code' })).json()
  assert.equal(st0.ok, true, st0.message)
  assert.equal(st0.state, 'device_code_ready')
  assert.equal(st0.userCode, 'ABCD-EFGH')
  assert.ok(!JSON.stringify(st0).includes('host_dev_code_secret_111'))

  const pl0 = (await fake.call('/platforms/auth/poll', { sessionId: st0.sessionId })).json()
  assert.equal(pl0.ok, true, pl0.message)
  assert.equal(pl0.state, 'succeeded')
  assert.equal(pl0.userCode, undefined)
  assert.equal(pl0.configs?.['fake-device']?.appSecretSet, true)
  assert.equal(pl0.configs?.['fake-device']?.appSecret, '')
  assert.ok(!JSON.stringify(pl0).includes('host_app_secret_do_not_expose_222'))

  const persistedCfg = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'))
  assert.equal(persistedCfg.platforms['fake-device'].authMode, 'device-code')
  assert.equal(persistedCfg.platforms['fake-device'].appSecret, 'host_app_secret_do_not_expose_222')
  assert.equal(app.gateway.identity.owner(), null, '扫码/设备码认证绝不可自动认主')
  assert.equal(JSON.stringify(app.hub.sharedStatus()), sharedBefore, '认证绝不可改动共享会话 checkpoint')

  // 3) cancel 路由
  const cStart = (await fake.call('/platforms/auth/start', { platform: 'wechat-clawbot', method: 'qr-link' })).json()
  assert.equal(cStart.ok, true)
  const cEnd = (await fake.call('/platforms/auth/cancel', { sessionId: cStart.sessionId })).json()
  assert.equal(cEnd.ok, true)
  assert.equal(cEnd.state, 'cancelled')
  assert.equal(cEnd.qrDataUri, undefined)

  // 4) whoami 不符 -> auth.verify 失败，宿主机自动禁用并断开该实例
  const mStart = (await fake.call('/platforms/auth/start', { platform: 'fake-mismatch', method: 'qr-app' })).json()
  assert.equal(mStart.ok, true)
  const mWait = (await fake.call('/platforms/auth/poll', { sessionId: mStart.sessionId })).json()
  assert.equal(mWait.state, 'polling')
  const mVerifyFail = (await fake.call('/platforms/auth/poll', { sessionId: mStart.sessionId })).json()
  assert.equal(mVerifyFail.ok, false)
  assert.equal(mVerifyFail.state, 'error')
  assert.equal(mVerifyFail.error?.stage, 'auth.verify')
  assert.equal(mVerifyFail.error?.code, 'whoami-mismatch')
  assert.equal(app.getConfig().platforms?.['fake-mismatch']?.enabled, false, 'whoami 不符后应停用实例')

  // 5) 旧版 /platforms/wechat-clawbot/qr/start|status 兼容回归
  const compatStart = (await fake.call('/platforms/wechat-clawbot/qr/start', { instance: 'wechat-clawbot' })).json()
  assert.equal(compatStart.ok, true)
  assert.equal(compatStart.state, 'wait')
  const compatWait = (await fake.call('/platforms/wechat-clawbot/qr/status', { sessionId: compatStart.sessionId })).json()
  assert.equal(compatWait.state, 'wait')
  const compatConfirmed = (await fake.call('/platforms/wechat-clawbot/qr/status', { sessionId: compatStart.sessionId })).json()
  assert.equal(compatConfirmed.ok, true)
  assert.equal(compatConfirmed.state, 'confirmed')
  assert.equal(compatConfirmed.botId, 'wx_compat@im.bot')
  assert.ok(!JSON.stringify(compatConfirmed).includes('wx_compat_secret_777'))
  assert.equal(app.getConfig().platforms?.['wechat-clawbot']?.authMode, 'qr-link')

  // 6) 全流程日志零敏感信息泄漏
  const allLogs = JSON.stringify(fake.logs)
  for (const s of ['host_dev_code_secret_111', 'host_app_secret_do_not_expose_222', 'mismatch_bot_secret_333', 'wx_compat_secret_777']) {
    assert.ok(!allLogs.includes(s), `日志不得包含敏感串 ${s}`)
  }
})

test('src/core/qr.js：本地 ISO/IEC 18004 解码与矩阵快照回归（V1–V16 含中文与长链接；第三方解码见 npm run test:qr-decode）', () => {
  const vectors = [
    { label: 'V1', expectedVersion: 1, text: 'hello', sha256: '52a7aa67e7296ede539d6be86579c7180e3b6d417445712ae8bd314c1818458a' },
    { label: 'V4', expectedVersion: 4, text: 'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=abc123def456', sha256: 'c2f315168264a8f6eca172c767033ed84eee8631701460fd682c2de665d95f79' },
    { label: 'V7', expectedVersion: 7, text: 'https://ilinkai.weixin.qq.com/qr/' + 'x'.repeat(80), sha256: 'ac68a0d4819afce4a7620a03ab604d90dae3354786e4e5c298a525ea6c272f2c' },
    { label: 'V10', expectedVersion: 10, text: 'https://open.example.com/v10?' + 'a'.repeat(175), sha256: '3813974fd137d43d024ab98100af017299a2d147f21017a0006cca44e734dc24' },
    { label: 'V11', expectedVersion: 11, text: 'https://open.feishu.cn/qr/' + 'x'.repeat(210), sha256: 'e386979d18585b130f1691ed73de2943ffee50b2c43f92b952b8bb1cd4eec666' },
    { label: 'V12', expectedVersion: 12, text: 'https://open.feishu.cn/qr/' + 'b'.repeat(250), sha256: 'dda02542651d8d5a28d87cd585f7c67b2e9c635999bd7df8712fd1c206871fcb' },
    { label: 'V13', expectedVersion: 13, text: 'https://open.feishu.cn/qr/' + 'c'.repeat(290), sha256: '910aa0ef94ff1200947096b7f1cbf65a7d03b61af996c39a4958e53fe8dc8c61' },
    { label: 'V14', expectedVersion: 14, text: 'https://accounts.example.com/oauth/device?user_code=ABCD-EFGH&redirect=' + 'y'.repeat(280), sha256: '04dacd2443758413a8d38ec57281b28853124b5003d9185e4cc78fcadd147e1b' },
    { label: 'V15', expectedVersion: 15, text: 'https://open.example.com/v15?' + 'd'.repeat(370), sha256: 'ddceded872a88d2d567e3c1e044b6c57a411c8f21676fa83790e9b364fb3eeb6' },
    { label: 'V16', expectedVersion: 16, text: 'https://open.example.com/auth?' + 'z'.repeat(415), sha256: 'c21238811ed62c3cf0b51369d427bc55162e4c14b8cfcc063c1eeaef7b292382' },
    { label: 'UTF8', expectedVersion: 5, text: 'https://aurabot.example.com/扫码登录?msg=你好世界&tag=v11', sha256: '2334ad473fec920c7861ec05726464517e888f5e2a3ae9367db4b236c28be82e' },
  ]

  for (const v of vectors) {
    const encoded = encodeQrMatrix(v.text)
    assert.equal(encoded.version, v.expectedVersion, `${v.label} 版本应精确匹配`)
    const decoded = decodeQrMatrixIso(encoded.modules)
    assert.equal(decoded.version, v.expectedVersion)
    assert.equal(decoded.text, v.text, `${v.label} 解码原文必须与输入逐字节一致`)
    const matrixDigest = createHash('sha256')
      .update(encoded.modules.map((row) => Array.from(row).join('')).join('\n'))
      .digest('hex')
    assert.equal(matrixDigest, v.sha256, `${v.label} 矩阵黄金哈希不匹配`)
  }
})

function loadCreateAuthPollLoopFromClient() {
  const clientCode = readFileSync(new URL('../../client/client.js', import.meta.url), 'utf8')
  let exported = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load({ factory }) {
          exported = factory((id) => {
            if (id === 'react') {
              return {
                Component: class Component {},
                useState: () => [null, () => {}],
                useEffect: () => {},
                useRef: () => ({ current: null }),
                useCallback: (fn) => fn,
                useMemo: (fn) => fn(),
                Fragment: 'Fragment',
                createElement: () => null,
              }
            }
            return {}
          })
        },
      },
    },
    setTimeout,
    clearTimeout,
    fetch: async () => ({ json: async () => ({}) }),
    document: {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  }
  vm.runInNewContext(clientCode, sandbox)
  assert.equal(typeof exported?.createAuthPollLoop, 'function')
  return exported.createAuthPollLoop
}

test('client createAuthPollLoop：连续返回相同 polling 不断轮询、slow_down 动态调频、网络异常退避恢复与 stop 保护', async () => {
  const createAuthPollLoop = loadCreateAuthPollLoopFromClient()

  // 伪定时器控制（按 FIFO + 记录每次延时的精确触发）
  const scheduled = []
  let nextId = 1
  const fakeSchedule = (fn, delay) => {
    const entry = { id: nextId++, fn, delay, cancelled: false }
    scheduled.push(entry)
    return entry.id
  }
  const fakeCancel = (id) => {
    const entry = scheduled.find((x) => x.id === id)
    if (entry) entry.cancelled = true
  }
  const flushNextTimer = async () => {
    const entry = scheduled.find((x) => !x.cancelled)
    assert.ok(entry, '应当存在待触发的下一次轮询定时器')
    entry.cancelled = true
    await entry.fn()
    return entry.delay
  }

  // 1) 连续 4 次完全相同的 polling 状态后，第 5 次返回 succeeded
  let pollCalls = 0
  const updates = []
  let completed = null
  const loop1 = createAuthPollLoop({
    sessionId: 'sid_same_1',
    initialDelayMs: 2000,
    schedule: fakeSchedule,
    cancelSchedule: fakeCancel,
    pollFn: async () => {
      pollCalls++
      if (pollCalls <= 4) {
        return {
          ok: true,
          state: 'polling',
          scanned: false,
          message: '等待手机微信扫码…',
          pollIntervalMs: 2000,
        }
      }
      return { ok: true, state: 'succeeded', message: '扫码成功' }
    },
    onUpdate: (u) => updates.push(u),
    onComplete: (r) => { completed = r },
  })
  loop1.start()
  for (let i = 0; i < 4; i++) {
    const d = await flushNextTimer()
    assert.equal(d, 2000)
  }
  assert.equal(pollCalls, 4)
  assert.equal(updates.length, 4)
  assert.equal(scheduled.filter((x) => !x.cancelled).length, 1, '相同状态后仍必须继续调度第 5 次轮询')

  await flushNextTimer()
  assert.equal(pollCalls, 5)
  assert.equal(completed?.state, 'succeeded')
  assert.equal(scheduled.filter((x) => !x.cancelled).length, 0, '成功后必须停止后续调度')

  // 2) slow_down 降频 + 网络断连（post() 无 state 返回 ok:false 以及抛错）退避重连后恢复成功
  scheduled.length = 0
  let step2 = 0
  let errResult = null
  let okResult2 = null
  const updates2 = []
  const loop2 = createAuthPollLoop({
    sessionId: 'sid_net_2',
    initialDelayMs: 2000,
    maxConsecutiveErrors: 3,
    schedule: fakeSchedule,
    cancelSchedule: fakeCancel,
    pollFn: async () => {
      step2++
      if (step2 === 1) return { ok: true, state: 'slow_down', pollIntervalMs: 5000, message: '请放慢速度' }
      if (step2 === 2) return { ok: false, message: '连不上插件：fetch failed' } // post() 捕获形态
      if (step2 === 3) throw new Error('socket hang up')
      return { ok: true, state: 'succeeded', message: '恢复并成功' }
    },
    onUpdate: (u) => updates2.push(u),
    onComplete: (r) => { okResult2 = r },
    onError: (e) => { errResult = e },
  })
  loop2.start()
  await flushNextTimer() // step 1 -> slow_down (5000ms)
  assert.equal(scheduled.find((x) => !x.cancelled)?.delay, 5000, 'slow_down 应按 5000ms 调度下次轮询')
  await flushNextTimer() // step 2 -> transient ok:false -> backoff retry
  assert.equal(updates2.at(-1)?.transientError, true)
  await flushNextTimer() // step 3 -> transient throw -> backoff retry (2/3)
  assert.equal(updates2.at(-1)?.transientError, true)
  await flushNextTimer() // step 4 -> succeeded
  assert.equal(okResult2?.state, 'succeeded')
  assert.equal(errResult, null)

  // 3) 连续错误达到 maxConsecutiveErrors 上限后中止
  scheduled.length = 0
  let netErr = null
  const loop3 = createAuthPollLoop({
    sessionId: 'sid_fail_3',
    initialDelayMs: 1000,
    maxConsecutiveErrors: 2,
    schedule: fakeSchedule,
    cancelSchedule: fakeCancel,
    pollFn: async () => ({ ok: false, message: '连不上插件：offline' }),
    onError: (e) => { netErr = e },
  })
  loop3.start()
  await flushNextTimer() // 1/2
  await flushNextTimer() // 2/2 -> fail
  assert.equal(netErr?.error?.code, 'network-poll-failed')
  assert.equal(loop3.isStopped(), true)

  // 4) stop() 后迟到返回不再触发回调或继续调度
  scheduled.length = 0
  let resolveLate = null
  let lateCalled = false
  const loop4 = createAuthPollLoop({
    sessionId: 'sid_stop_4',
    initialDelayMs: 1000,
    schedule: fakeSchedule,
    cancelSchedule: fakeCancel,
    pollFn: () => new Promise((r) => { resolveLate = r }),
    onUpdate: () => { lateCalled = true },
    onComplete: () => { lateCalled = true },
  })
  loop4.start()
  const runningPromise = flushNextTimer()
  loop4.stop()
  resolveLate({ ok: true, state: 'polling', pollIntervalMs: 1000 })
  await runningPromise
  assert.equal(lateCalled, false)
  assert.equal(scheduled.filter((x) => !x.cancelled).length, 0)
})

test('宿主机 verifyInstance 严格门控：等待慢连接+异步 whoami 成功，超时/未连接/无 self/缺失实例均拒绝并停用', async (t) => {
  const buildFakeAdapter = ({ platform, behavior }) => () => {
    let stopped = false
    return {
      id: platform,
      name: platform,
      contract: 1,
      settings: [{ key: 'botToken', label: 'Token', type: 'password' }],
      caps: () => ({
        image: false, sticker: false, voice: false, video: false, file: false, maxFileBytes: 0,
        quoteReply: false, mention: false, mentionAll: false, poke: false, typing: false, recall: false,
        card: false, listenAllInGroup: false, proactive: 'none', replyWindowMs: 0, repliesPerMessage: 0,
        history: false, memberList: false, forwardExpand: false,
      }),
      async start(ctx) {
        stopped = false
        if (behavior === 'slow-connect-ok') {
          ctx.state('connecting', '握手建立中')
          const timer = setTimeout(() => {
            if (!stopped) ctx.state('connected', '慢连接建立完成')
          }, 50)
          timer.unref?.()
          return
        }
        if (behavior === 'stuck-connecting') {
          ctx.state('connecting', '始终握手卡住')
          return
        }
        if (behavior === 'empty-whoami') {
          ctx.state('connected', '已连但缺 self')
          return
        }
        if (behavior === 'disconnected') {
          ctx.state('disconnected', '网络鉴权拒绝（握手失败）')
        }
      },
      async stop() { stopped = true },
      async whoami() {
        if (behavior === 'slow-connect-ok') {
          await new Promise((r) => setTimeout(r, 25))
          return { account: `expected_${platform}`, name: 'Slow Bot' }
        }
        if (behavior === 'empty-whoami') {
          return { account: '', name: '' }
        }
        return { account: `expected_${platform}`, name: platform }
      },
      async send() { return { messageId: 'm1' } },
    }
  }

  // 1) 慢连接成功路径：留足超时余量（2000ms），避免高并发全量回归下误超时
  const slowOkScenario = { platform: 'slow-ok', behavior: 'slow-connect-ok' }
  const { fake: fakeSlowOk, app: appSlowOk } = await bootAuthHost(t, {
    cfg: { enabled: true, dryRun: false, setupDone: true, platforms: { qq: { enabled: false } } },
    opts: {
      authVerifyTimeoutMs: 2000,
      authDrivers: [createFakeQrAppDriver({
        platform: slowOkScenario.platform,
        method: 'qr-app',
        account: `expected_${slowOkScenario.platform}`,
        botToken: `tok_verify_${slowOkScenario.platform}_secret`,
      })],
      adapters: [buildFakeAdapter(slowOkScenario)],
    },
  })
  const okStart = (await fakeSlowOk.call('/platforms/auth/start', { platform: slowOkScenario.platform, method: 'qr-app' })).json()
  assert.equal(okStart.ok, true)
  const okP1 = (await fakeSlowOk.call('/platforms/auth/poll', { sessionId: okStart.sessionId })).json()
  assert.equal(okP1.state, 'polling')
  const okP2 = (await fakeSlowOk.call('/platforms/auth/poll', { sessionId: okStart.sessionId })).json()
  assert.equal(okP2.ok, true, okP2.message)
  assert.equal(okP2.state, 'succeeded')
  assert.equal(okP2.self?.account, `expected_${slowOkScenario.platform}`)
  assert.equal(appSlowOk.getConfig().platforms?.[slowOkScenario.platform]?.enabled, true)

  // 2) 失败与超时拦截路径：使用较短超时（250ms）验证超时、断连、空 whoami 与未注册适配器均拒绝并停用
  const failScenarios = [
    { platform: 'hang-conn', behavior: 'stuck-connecting', expectedCode: 'connect-timeout' },
    { platform: 'empty-who', behavior: 'empty-whoami', expectedCode: 'whoami-timeout' },
    { platform: 'drop-disc', behavior: 'disconnected', expectedCode: 'instance-disconnected' },
    { platform: 'no-adapt', behavior: 'no-adapter', expectedCode: 'instance-not-connected' },
  ]
  const { fake: fakeFail, app: appFail } = await bootAuthHost(t, {
    cfg: { enabled: true, dryRun: false, setupDone: true, platforms: { qq: { enabled: false } } },
    opts: {
      authVerifyTimeoutMs: 250,
      authDrivers: failScenarios.map(({ platform }) => createFakeQrAppDriver({
        platform,
        method: 'qr-app',
        account: `expected_${platform}`,
        botToken: `tok_verify_${platform}_secret`,
      })),
      adapters: failScenarios.filter((s) => s.behavior !== 'no-adapter').map(buildFakeAdapter),
    },
  })

  for (const s of failScenarios) {
    const startRes = (await fakeFail.call('/platforms/auth/start', { platform: s.platform, method: 'qr-app' })).json()
    assert.equal(startRes.ok, true)
    const p1 = (await fakeFail.call('/platforms/auth/poll', { sessionId: startRes.sessionId })).json()
    assert.equal(p1.state, 'polling')
    const p2 = (await fakeFail.call('/platforms/auth/poll', { sessionId: startRes.sessionId })).json()
    assert.equal(p2.ok, false)
    assert.equal(p2.state, 'error')
    assert.equal(p2.error?.stage, 'auth.verify')
    assert.equal(p2.error?.code, s.expectedCode)
    assert.equal(appFail.getConfig().platforms?.[s.platform]?.enabled, false, `${s.platform} 核验失败必须停用实例`)
  }
})

test('AuthManager 与微信驱动：错误消息回显 qrcode 或 sensitiveDriverSessionKeys 时全链路自动打码', async () => {
  const logs = []
  const mgr = createPlatformAuthManager({
    log: { debug: (...a) => logs.push(a.join(' ')), info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')) },
  })

  // 1) 微信驱动 poll 错误（如非 JSON 响应体）回显了 qrcode，必须从 view / error / logs 抹除
  const wxQRCodeSecret = 'wx_ephemeral_qrcode_secret_654321'
  const wxClientWithEchoErr = {
    async request(req) {
      const url = String(req.url || '')
      if (url.includes('/ilink/bot/get_bot_qrcode')) {
        return { status: 200, headers: {}, json: { qrcode: wxQRCodeSecret, qrcode_img_content: 'https://liteapp.weixin.qq.com/q/safe' } }
      }
      if (url.includes('/ilink/bot/get_qrcode_status')) {
        return { status: 500, headers: {}, json: null, text: `server echoed qrcode=${wxQRCodeSecret}` }
      }
      return { status: 404, headers: {}, json: {} }
    },
  }
  mgr.register(createWechatClawbotAuthDriver({ defaultClient: wxClientWithEchoErr }))
  const wxStart = await mgr.start({ platform: 'wechat-clawbot', method: 'qr-link' })
  assert.ok(!JSON.stringify(wxStart).includes(wxQRCodeSecret))
  const wxPollErr = await mgr.poll({ sessionId: wxStart.sessionId })
  assert.equal(wxPollErr.state, 'error')
  assert.ok(!JSON.stringify(wxPollErr).includes(wxQRCodeSecret), '微信错误视图严禁暴露 driverSession.qrcode')

  // 2) 自定义驱动通过 sensitiveDriverSessionKeys 声明非典型临时字段名
  const customNonce = 'opaque_session_nonce_value_7788'
  mgr.register({
    platform: 'custom-sec',
    methods: [{ method: 'qr-app', label: 'Custom Sec' }],
    sensitiveDriverSessionKeys: ['opaqueHandle'],
    async start() {
      return {
        state: 'qr_ready',
        driverSession: { opaqueHandle: customNonce },
        qrContent: 'https://auth.example.com/custom/1',
      }
    },
    async poll() {
      throw new Error(`poll exploded on handle=${customNonce}`)
    },
  })
  const cs0 = await mgr.start({ platform: 'custom-sec', method: 'qr-app' })
  const cs1 = await mgr.poll({ sessionId: cs0.sessionId })
  assert.equal(cs1.state, 'error')
  assert.ok(!JSON.stringify(cs1).includes(customNonce), 'sensitiveDriverSessionKeys 指定字段必须被脱敏')
  assert.match(cs1.error?.message || '', /\[redacted\]/)
  assert.ok(!JSON.stringify(logs).includes(wxQRCodeSecret))
  assert.ok(!JSON.stringify(logs).includes(customNonce))
})
