// Phase 1A 认证驱动与宿主机集成测试：飞书 qr-app（含 RFC 8628 HTTP 400 / slow_down / domain_switched / 待发布审批）、QQBot qr-app（AES-256-GCM / 与 qq 隔离）与面板源码契约。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MAX_QR_UTF8_BYTES, encodeQrMatrix } from '../../src/core/qr.js'
import { AuthError, createPlatformAuthManager } from '../../src/gateway/auth.js'
import {
  FEISHU_ACCOUNTS_BASE_URL,
  FEISHU_API_BASE_URL,
  LARK_ACCOUNTS_BASE_URL,
  LARK_API_BASE_URL,
} from '../../src/adapters/feishu/auth.js'
import {
  FEISHU_QR_ADDONS,
  createFeishuAuthDriver,
  encodeFeishuAddons,
} from '../../src/adapters/feishu/index.js'
import {
  QQBOT_BIND_STATUS,
  buildQqbotConnectUrl,
  createQqbotAuthDriver,
  decryptQqbotSecret,
} from '../../src/adapters/qqbot/index.js'
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

function encryptQqbotSecret(plainText, keyBase64) {
  const key = Buffer.from(keyBase64, 'base64')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(Buffer.from(plainText, 'utf8')), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, ct, tag]).toString('base64')
}

async function bootPhase1AuthHost(t, { cfg, opts = {} } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aurabot-phase1-auth-'))
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

test('飞书 AuthDriver (qr-app)：addons 编码、QR 解码、HTTP 400 轮询态、slow_down 与 Lark domain_switched', async () => {
  const calls = []
  const devCodeSecret = 'feishu_dev_code_secret_xyz123'
  const appSecret = 'feishu_cli_secret_do_not_leak_999'
  let pollIdx = 0

  const fetchImpl = async (url, init) => {
    const form = Object.fromEntries(new URLSearchParams(String(init.body || '')))
    calls.push({ url, form })
    if (form.action === 'begin') {
      assert.equal(url, `${FEISHU_ACCOUNTS_BASE_URL}/oauth/v1/app/registration`)
      assert.equal(form.archetype, 'PersonalAgent')
      assert.equal(form.auth_method, 'client_secret')
      assert.equal(form.request_user_info, 'open_id')
      return jsonResp({
        device_code: devCodeSecret,
        verification_uri_complete: 'https://accounts.feishu.cn/oauth/v1/authorize?token=tok_begin_1',
        expires_in: 600,
        interval: 2,
      })
    }
    if (form.action === 'poll') {
      assert.equal(form.device_code, devCodeSecret)
      pollIdx++
      if (pollIdx === 1) {
        assert.equal(url, `${FEISHU_ACCOUNTS_BASE_URL}/oauth/v1/app/registration`)
        return jsonResp({ error: 'authorization_pending' }, 400)
      }
      if (pollIdx === 2) {
        return jsonResp({ error: 'slow_down' }, 400)
      }
      if (pollIdx === 3) {
        return jsonResp({
          error: 'authorization_pending',
          user_info: { tenant_brand: 'lark' },
        }, 400)
      }
      assert.equal(url, `${LARK_ACCOUNTS_BASE_URL}/oauth/v1/app/registration`, 'tenant_brand=lark 后必须切换到 Lark 域名轮询')
      return jsonResp({
        client_id: 'cli_lark_new_001',
        client_secret: appSecret,
        user_info: { tenant_brand: 'lark', open_id: 'ou_scanner_ignored' },
      }, 200)
    }
    throw new Error('unexpected action')
  }

  const driver = createFeishuAuthDriver({ fetchImpl })
  assert.equal(driver.validateInstance('feishu'), true)
  assert.equal(driver.validateInstance('feishu#work'), true)
  assert.equal(driver.validateInstance('qq'), false)
  assert.equal(driver.validateInstance('qqbot'), false)

  const logs = []
  let nowMs = 1_700_000_000_000
  const mgr = createPlatformAuthManager({
    now: () => nowMs,
    log: { debug: (...a) => logs.push(a.join(' ')), info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')) },
  })
  mgr.register(driver)

  const s0 = await mgr.start({ platform: 'feishu', method: 'qr-app' })
  assert.equal(s0.state, 'qr_ready')
  assert.equal(s0.domain, 'feishu')
  assert.ok(s0.qrDataUri.startsWith('data:image/svg+xml;base64,'))
  assert.ok(Buffer.byteLength(s0.verificationUrl, 'utf8') <= MAX_QR_UTF8_BYTES)

  const u = new URL(s0.verificationUrl)
  assert.equal(u.searchParams.get('from'), 'sdk')
  assert.equal(u.searchParams.get('tp'), 'sdk')
  assert.equal(u.searchParams.get('createOnly'), 'true')
  const addonsJson = JSON.parse(gunzipSync(Buffer.from(u.searchParams.get('addons'), 'base64url')).toString('utf8'))
  assert.deepEqual(addonsJson, FEISHU_QR_ADDONS)
  assert.ok(addonsJson.scopes.tenant.includes('im:message:readonly'), '扫码应用必须预申请 im:message:readonly 以读取用户图片/文件')
  assert.ok(addonsJson.scopes.tenant.includes('im:message.group_at_msg.include_bot:readonly'), '扫码应用必须预申请群内含机器人@权限')
  assert.equal(decodeQrMatrixIso(encodeQrMatrix(s0.verificationUrl).modules).text, s0.verificationUrl)

  const s1 = await mgr.poll({ sessionId: s0.sessionId })
  assert.equal(s1.state, 'polling')

  const s2 = await mgr.poll({ sessionId: s0.sessionId })
  assert.equal(s2.state, 'slow_down')
  assert.equal(s2.pollIntervalMs, 7000)

  // 未到退避时间前不打飞书接口
  const s2Early = await mgr.poll({ sessionId: s0.sessionId })
  assert.equal(s2Early.state, 'slow_down')
  assert.equal(pollIdx, 2)

  nowMs += 7500
  const s3 = await mgr.poll({ sessionId: s0.sessionId })
  assert.equal(s3.state, 'domain_switched')
  assert.equal(s3.domain, 'lark')
  assert.equal(s3.verificationUrl, s0.verificationUrl, '标准 SDK domain_switched 未返回新链接时保留原扫码链接且继续用同一 deviceCode 轮询')
  assert.ok(s3.message.includes('无需重新扫码'))

  // 验证 s3 下一步 poll 成功落盘、appSecret/deviceCode 零泄漏
  const s4 = await mgr.poll({ sessionId: s0.sessionId })
  assert.equal(s4.state, 'succeeded')
  assert.equal(s4.qrDataUri, undefined)
  assert.equal(s4.meta?.appId, 'cli_lark_new_001')
  assert.equal(s4.meta?.baseUrl, LARK_API_BASE_URL)
  const serialized = JSON.stringify({ s0, s1, s2, s3, s4, logs })
  assert.equal(serialized.includes(devCodeSecret), false, 'deviceCode 不得泄漏到任何 view 或日志')
  assert.equal(serialized.includes(appSecret), false, 'appSecret 不得泄漏到任何 view 或日志')
})

test('飞书 AuthDriver (qr-app)：非受信 QR 域名、超长链接、expired_token、access_denied 与 Lark 初始配置', async () => {
  // 1) 不受信任的 verification_uri_complete
  const untrustedDriver = createFeishuAuthDriver({
    fetchImpl: async () => jsonResp({ device_code: 'dc_bad', verification_uri_complete: 'https://evil.example.com/phish' }),
  })
  await assert.rejects(
    () => untrustedDriver.start({ params: {}, currentConfig: {} }),
    (e) => e instanceof AuthError && e.code === 'invalid-qr-url' && e.stage === 'auth.begin',
  )

  // 2) 超出 MAX_QR_UTF8_BYTES
  const tooLongDriver = createFeishuAuthDriver({
    fetchImpl: async () => jsonResp({
      device_code: 'dc_long',
      verification_uri_complete: 'https://accounts.feishu.cn/oauth/v1/authorize?token=' + 'x'.repeat(300),
    }),
  })
  await assert.rejects(
    () => tooLongDriver.start({ params: {}, currentConfig: {} }),
    (e) => e instanceof AuthError && e.code === 'qr-too-long' && e.stage === 'auth.qr.encode',
  )

  // 3) currentConfig.baseUrl 含 larksuite.com -> 初始走 Lark 域，且 access_denied / expired_token / cancel 正常
  const seenUrls = []
  let errMode = 'expired_token'
  const larkDriver = createFeishuAuthDriver({
    fetchImpl: async (url, init) => {
      seenUrls.push(url)
      const form = Object.fromEntries(new URLSearchParams(String(init.body || '')))
      if (form.action === 'begin') {
        return jsonResp({
          device_code: 'dc_lark_init',
          verification_uri_complete: 'https://accounts.larksuite.com/oauth/v1/authorize?token=lark_tok',
          expires_in: 300,
          interval: 3,
        })
      }
      return jsonResp({ error: errMode }, 400)
    },
  })
  const mgr = createPlatformAuthManager({
    getInstanceConfig: (inst) => (inst === 'feishu#lark' ? { baseUrl: LARK_API_BASE_URL } : {}),
  })
  mgr.register(larkDriver)

  const st1 = await mgr.start({ platform: 'feishu', instance: 'feishu#lark', method: 'qr-app' })
  assert.equal(st1.domain, 'lark')
  assert.equal(seenUrls[0], `${LARK_ACCOUNTS_BASE_URL}/oauth/v1/app/registration`)
  const pExp = await mgr.poll({ sessionId: st1.sessionId })
  assert.equal(pExp.state, 'expired')

  errMode = 'access_denied'
  const st2 = await mgr.start({ platform: 'feishu', method: 'qr-app', params: { domain: 'feishu' } })
  assert.equal(seenUrls.at(-1), `${FEISHU_ACCOUNTS_BASE_URL}/oauth/v1/app/registration`)
  const pDenied = await mgr.poll({ sessionId: st2.sessionId })
  assert.equal(pDenied.state, 'error')
  assert.equal(pDenied.error?.code, 'access_denied')
  assert.equal(pDenied.error?.stage, 'auth.poll')

  const st3 = await mgr.start({ platform: 'feishu', method: 'qr-app' })
  const cancelled = await mgr.cancel({ sessionId: st3.sessionId, reason: 'user-cancelled' })
  assert.equal(cancelled.state, 'cancelled')
  assert.equal(cancelled.qrDataUri, undefined)

  // 4) 若 domain_switched 随响应返回新的 verification_uri_complete，必须校验域名安全并刷新 verificationUrl 与二维码
  const refreshedSwitchDriver = createFeishuAuthDriver({
    fetchImpl: async (_url, init) => {
      const form = Object.fromEntries(new URLSearchParams(String(init.body || '')))
      if (form.action === 'begin') {
        return jsonResp({ device_code: 'dc_ref', verification_uri_complete: 'https://accounts.feishu.cn/oauth/v1/authorize?token=t_init', expires_in: 300, interval: 1 })
      }
      return jsonResp({
        error: 'authorization_pending',
        user_info: { tenant_brand: 'lark' },
        verification_uri_complete: 'https://accounts.larksuite.com/oauth/v1/authorize?token=t_lark_refreshed',
      }, 400)
    },
  })
  const mgrRef = createPlatformAuthManager()
  mgrRef.register(refreshedSwitchDriver)
  const r0 = await mgrRef.start({ platform: 'feishu', method: 'qr-app' })
  const rSwitched = await mgrRef.poll({ sessionId: r0.sessionId })
  assert.equal(rSwitched.state, 'domain_switched')
  assert.equal(new URL(rSwitched.verificationUrl).hostname, 'accounts.larksuite.com')
  assert.notEqual(rSwitched.qrDataUri, r0.qrDataUri)
})

test('QQBot AuthDriver (qr-app)：AES-256-GCM 解包、NONE/PENDING/EXPIRED、错误脱敏与实例隔离', async () => {
  const qqAppSecret = 'qqbot_app_secret_super_sensitive_456'
  let capturedKey = ''
  let pollMode = 'none'
  let tamperCipher = false

  const driver = createQqbotAuthDriver({
    fetchImpl: async (url, init) => {
      const body = JSON.parse(String(init.body || '{}'))
      if (url.endsWith('/lite/create_bind_task')) {
        capturedKey = body.key
        assert.equal(Buffer.from(capturedKey, 'base64').length, 32)
        return jsonResp({ retcode: 0, data: { task_id: 'qq_task_123456' } })
      }
      if (url.endsWith('/lite/poll_bind_result')) {
        assert.equal(body.task_id, 'qq_task_123456')
        if (pollMode === 'none') return jsonResp({ retcode: 0, data: { status: QQBOT_BIND_STATUS.NONE } })
        if (pollMode === 'pending') return jsonResp({ retcode: 0, data: { status: QQBOT_BIND_STATUS.PENDING } })
        if (pollMode === 'expired') return jsonResp({ retcode: 0, data: { status: QQBOT_BIND_STATUS.EXPIRED } })
        const enc = tamperCipher ? Buffer.from('tampered_cipher_data_not_valid_gcm').toString('base64') : encryptQqbotSecret(qqAppSecret, capturedKey)
        return jsonResp({
          retcode: 0,
          data: {
            status: QQBOT_BIND_STATUS.COMPLETED,
            bot_appid: '102998877',
            bot_encrypt_secret: enc,
            user_openid: 'qq_creator_openid_1',
          },
        })
      }
      throw new Error('unexpected url')
    },
  })

  assert.equal(driver.validateInstance('qqbot'), true)
  assert.equal(driver.validateInstance('qqbot#alt'), true)
  assert.equal(driver.validateInstance('qq'), false, 'QQ 官方机器人扫码绝不能匹配个人号 qq')
  assert.equal(driver.validateInstance('feishu'), false)
  assert.ok(buildQqbotConnectUrl('t1', 'aurabot').startsWith('https://q.qq.com/qqbot/openclaw/connect.html?task_id=t1'))
  const roundKey = randomBytes(32).toString('base64')
  assert.equal(decryptQqbotSecret(encryptQqbotSecret('abc-secret', roundKey), roundKey), 'abc-secret')
  assert.throws(() => decryptQqbotSecret('short', 'short'))

  const logs = []
  const saved = []
  const mgr = createPlatformAuthManager({
    applyCompletion: async (payload) => { saved.push(payload) },
    log: { debug: (...a) => logs.push(a.join(' ')), info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')) },
  })
  mgr.register(driver)

  const s0 = await mgr.start({ platform: 'qqbot', method: 'qr-app' })
  assert.equal(s0.state, 'qr_ready')
  assert.ok(s0.qrDataUri.startsWith('data:image/svg+xml;base64,'))
  const mat = encodeQrMatrix(s0.verificationUrl)
  assert.equal(decodeQrMatrixIso(mat.modules).text, s0.verificationUrl)

  const p0 = await mgr.poll({ sessionId: s0.sessionId })
  assert.equal(p0.state, 'polling')

  pollMode = 'pending'
  const p1 = await mgr.poll({ sessionId: s0.sessionId })
  assert.equal(p1.state, 'polling')

  pollMode = 'expired'
  const pExp = await mgr.poll({ sessionId: s0.sessionId })
  assert.equal(pExp.state, 'expired')

  // 篡改密文不成功、且不泄露 bindKey/taskId
  pollMode = 'completed'
  tamperCipher = true
  const sBad = await mgr.start({ platform: 'qqbot', method: 'qr-app' })
  const pBad = await mgr.poll({ sessionId: sBad.sessionId })
  assert.equal(pBad.state, 'error')
  assert.equal(pBad.error?.code, 'invalid-credentials')
  assert.equal(pBad.error?.stage, 'auth.poll')
  assert.equal(JSON.stringify(pBad).includes(capturedKey), false)

  // 正常解密并映射为 secretPatch.clientSecret + configPatch.appId
  tamperCipher = false
  const sGood = await mgr.start({ platform: 'qqbot', method: 'qr-app' })
  const pOk = await mgr.poll({ sessionId: sGood.sessionId })
  assert.equal(pOk.state, 'succeeded')
  assert.equal(saved.length, 1)
  assert.deepEqual(saved[0].configPatch, { appId: '102998877' })
  assert.deepEqual(saved[0].secretPatch, { clientSecret: qqAppSecret })
  assert.equal(saved[0].self, undefined, 'qqbot 不得把 appId 当作 expectedSelf.account')
  const leaked = JSON.stringify({ s0, p0, p1, pExp, pBad, sGood, pOk, logs })
  assert.equal(leaked.includes(qqAppSecret), false)
  assert.equal(leaked.includes(capturedKey), false)
  const terminalLeaked = JSON.stringify({ pExp, pBad, pOk, logs })
  assert.equal(terminalLeaked.includes('qq_task_123456'), false)

  // 接口变更/不可用/限流/业务拒绝时提示回退手动填写 AppID / AppSecret，且绝不泄漏 bindKey/taskId
  for (const [status, body, expectedCode] of [
    [404, { err: 'not found' }, 'qqbot-bind-unavailable'],
    [429, { err: 'rate limit' }, 'qqbot-rate-limited'],
    [200, { retcode: -1001, msg: 'bind deprecated' }, 'qqbot-retcode--1001'],
  ]) {
    const errMgr = createPlatformAuthManager()
    errMgr.register(createQqbotAuthDriver({ fetchImpl: async () => jsonResp(body, status) }))
    await assert.rejects(
      () => errMgr.start({ platform: 'qqbot', method: 'qr-app' }),
      (e) => e instanceof AuthError && e.code === expectedCode && e.message.includes('AppID / AppSecret'),
    )
  }
})

test('宿主机 Phase 1A 全流程：飞书扫码（含 Lark 切换/未发布拦截/whoami）与 QQBot 扫码（不触碰 qq 与主人绑定）', async (t) => {
  const feishuSecret = 'feishu_host_secret_value_888'
  const qqbotSecret = 'qqbot_host_secret_value_777'
  let feishuPollStep = 0
  let qqbotBindKey = ''
  let feishuConnectBehavior = 'ok'

  const feishuAdapterFactory = () => {
    let curCtx = null
    return {
      id: 'feishu',
      name: '飞书',
      contract: 1,
      settings: [
        { key: 'appId', label: 'App ID', type: 'text' },
        { key: 'appSecret', label: 'App Secret', type: 'password' },
        { key: 'baseUrl', label: 'API 域名', type: 'text', default: FEISHU_API_BASE_URL },
      ],
      caps: () => ({
        image: true, sticker: false, voice: 'native', video: true, file: true, maxFileBytes: 30 * 1024 * 1024,
        quoteReply: true, mention: true, mentionAll: true, poke: false, typing: false, recall: false,
        card: true, listenAllInGroup: false, proactive: 'free', replyWindowMs: 0, repliesPerMessage: 0,
        history: false, memberList: true, forwardExpand: true,
      }),
      async start(ctx) {
        curCtx = ctx
        const cfg = ctx.config()
        if (feishuConnectBehavior === 'pending-publish') {
          ctx.state('stopped', '启动失败：长连接端点发现失败：230006 Bot not enabled or app not published')
          throw new Error('长连接端点发现失败：230006 Bot not enabled or app not published')
        }
        assert.equal(cfg.baseUrl, LARK_API_BASE_URL)
        ctx.state('connected', 'fake lark connected')
      },
      async stop() { curCtx?.state?.('stopped') },
      async whoami() { return { account: 'ou_lark_bot_identity', name: 'Lark Aurabot' } },
      async send() { return { messageId: 'om_1' } },
    }
  }

  const qqbotAdapterFactory = () => ({
    id: 'qqbot',
    name: 'QQ 官方机器人',
    contract: 1,
    settings: [
      { key: 'appId', label: 'AppID', type: 'text' },
      { key: 'clientSecret', label: 'AppSecret', type: 'password' },
    ],
    caps: () => ({
      image: true, sticker: false, voice: 'file', video: true, file: true, maxFileBytes: 200 * 1024 * 1024,
      quoteReply: false, mention: true, mentionAll: false, poke: false, typing: false, recall: true,
      card: false, listenAllInGroup: false, proactive: 'limited', replyWindowMs: 300_000, repliesPerMessage: 4,
      history: false, memberList: false, forwardExpand: false,
    }),
    async start(ctx) {
      const cfg = ctx.config()
      assert.equal(cfg.appId, '102001122')
      assert.equal(cfg.clientSecret, qqbotSecret)
      ctx.state('connected', 'fake qqbot connected')
    },
    async stop() {},
    async whoami() { return { account: 'qqbot_real_openid', name: 'Aurabot Official' } },
    async send() { return { messageId: 'qb_1' } },
  })

  const { fake, app } = await bootPhase1AuthHost(t, {
    cfg: {
      enabled: true,
      dryRun: false,
      setupDone: true,
      platforms: { qq: { enabled: false, wsUrl: 'ws://127.0.0.1:3001', selfId: '99999' } },
    },
    opts: {
      authVerifyTimeoutMs: 2000,
      adapters: [feishuAdapterFactory, qqbotAdapterFactory],
      feishuAuthFetch: async (url, init) => {
        const form = Object.fromEntries(new URLSearchParams(String(init.body || '')))
        if (form.action === 'begin') {
          return jsonResp({
            device_code: 'host_feishu_dc',
            verification_uri_complete: 'https://accounts.feishu.cn/oauth/v1/authorize?token=host_fs',
            expires_in: 600,
            interval: 1,
          })
        }
        feishuPollStep++
        if (feishuPollStep === 1) {
          return jsonResp({ error: 'authorization_pending', user_info: { tenant_brand: 'lark' } }, 400)
        }
        return jsonResp({
          client_id: 'cli_host_lark_123',
          client_secret: feishuSecret,
          user_info: { tenant_brand: 'lark' },
        })
      },
      qqbotAuthFetch: async (url, init) => {
        const body = JSON.parse(String(init.body || '{}'))
        if (url.endsWith('/lite/create_bind_task')) {
          qqbotBindKey = body.key
          return jsonResp({ retcode: 0, data: { task_id: 'host_qqbot_task' } })
        }
        return jsonResp({
          retcode: 0,
          data: {
            status: QQBOT_BIND_STATUS.COMPLETED,
            bot_appid: '102001122',
            bot_encrypt_secret: encryptQqbotSecret(qqbotSecret, qqbotBindKey),
            user_openid: 'qq_user_scan_1',
          },
        })
      },
    },
  })

  // 1) /platforms 应列出 wechat-clawbot / feishu / qqbot 的 authMethods
  const platList = (await fake.call('/platforms')).json()
  const authPlatforms = (platList.authMethods || []).map((x) => `${x.platform}:${x.method}`)
  assert.ok(authPlatforms.includes('wechat-clawbot:qr-link'))
  assert.ok(authPlatforms.includes('feishu:qr-app'))
  assert.ok(authPlatforms.includes('qqbot:qr-app'))

  // 2) 飞书扫码完整成功流程：domain_switched -> authorized -> whoami -> 不自动认主 -> 密钥脱敏
  const fsStart = (await fake.call('/platforms/auth/start', { platform: 'feishu', method: 'qr-app' })).json()
  assert.equal(fsStart.ok, true)
  const fsP1 = (await fake.call('/platforms/auth/poll', { sessionId: fsStart.sessionId })).json()
  assert.equal(fsP1.state, 'domain_switched')
  assert.equal(fsP1.domain, 'lark')
  const fsP2 = (await fake.call('/platforms/auth/poll', { sessionId: fsStart.sessionId })).json()
  assert.equal(fsP2.ok, true, fsP2.message)
  assert.equal(fsP2.state, 'succeeded')
  assert.equal(fsP2.self?.account, 'ou_lark_bot_identity')
  assert.equal(fsP2.configs?.feishu?.appId, 'cli_host_lark_123')
  assert.equal(fsP2.configs?.feishu?.baseUrl, LARK_API_BASE_URL)
  assert.equal(fsP2.configs?.feishu?.appSecret, '')
  assert.equal(fsP2.configs?.feishu?.appSecretSet, true)
  assert.equal(app.getConfig().platforms?.feishu?.appSecret, feishuSecret)
  assert.equal(app.getConfig().platforms?.feishu?.authMode, 'qr-app')
  assert.equal(JSON.stringify(fsP2).includes(feishuSecret), false)

  // 3) 飞书“已获凭证但应用待发布审批/未启用机器人”场景：返回 app-pending-publish，停用实例但保留凭证和 configs
  feishuConnectBehavior = 'pending-publish'
  feishuPollStep = 0
  const fsPendingStart = (await fake.call('/platforms/auth/start', { platform: 'feishu', method: 'qr-app', instance: 'feishu#pending' })).json()
  await fake.call('/platforms/auth/poll', { sessionId: fsPendingStart.sessionId }) // domain_switched
  const fsPendingEnd = (await fake.call('/platforms/auth/poll', { sessionId: fsPendingStart.sessionId })).json()
  assert.equal(fsPendingEnd.ok, false)
  assert.equal(fsPendingEnd.state, 'error')
  assert.equal(fsPendingEnd.error?.stage, 'auth.verify')
  assert.equal(fsPendingEnd.error?.code, 'app-pending-publish')
  assert.ok(fsPendingEnd.message.includes('发布') && fsPendingEnd.message.includes('无需重新扫码'))
  assert.equal(app.getConfig().platforms?.['feishu#pending']?.enabled, false)
  assert.equal(app.getConfig().platforms?.['feishu#pending']?.appId, 'cli_host_lark_123')
  assert.equal(app.getConfig().platforms?.['feishu#pending']?.appSecret, feishuSecret)
  assert.equal(fsPendingEnd.configs?.['feishu#pending']?.appId, 'cli_host_lark_123')
  assert.equal(fsPendingEnd.configs?.['feishu#pending']?.appSecretSet, true)

  // 4) QQBot 扫码成功流程：写入 platforms.qqbot（clientSecret），绝不修改 platforms.qq，绝不自动认主
  const qbStart = (await fake.call('/platforms/auth/start', { platform: 'qqbot', method: 'qr-app' })).json()
  assert.equal(qbStart.ok, true)
  const qbEnd = (await fake.call('/platforms/auth/poll', { sessionId: qbStart.sessionId })).json()
  assert.equal(qbEnd.ok, true, qbEnd.message)
  assert.equal(qbEnd.state, 'succeeded')
  assert.equal(qbEnd.self?.account, 'qqbot_real_openid')
  assert.equal(qbEnd.configs?.qqbot?.appId, '102001122')
  assert.equal(qbEnd.configs?.qqbot?.clientSecret, '')
  assert.equal(qbEnd.configs?.qqbot?.clientSecretSet, true)
  assert.equal(app.getConfig().platforms?.qqbot?.clientSecret, qqbotSecret)
  assert.equal(app.getConfig().platforms?.qqbot?.authMode, 'qr-app')
  assert.equal(app.getConfig().platforms?.qq?.selfId, '99999', 'qqbot 扫码不得覆盖个人号 qq 配置')
  assert.equal(app.getConfig().platforms?.qq?.enabled, false)
  assert.equal(app.getConfig().ownerPersonId, '', '扫码后不得自动认主')
  assert.equal(JSON.stringify(qbEnd).includes(qqbotSecret), false)
})

test('面板与设置向导源码契约：Platforms 卡片与 Wizard 接入 FeishuQrBox / QqbotQrBox 且明确隔离与不自动认主', () => {
  const client = readFileSync(new URL('../../client/client.js', import.meta.url), 'utf8')
  assert.ok(client.includes('function FeishuQrBox('), '缺少 FeishuQrBox 组件')
  assert.ok(client.includes('function QqbotQrBox('), '缺少 QqbotQrBox 组件')
  assert.ok(client.includes("platform: 'feishu'") && client.includes("method: 'qr-app'"), 'FeishuQrBox 未绑定 qr-app')
  assert.ok(client.includes("platform: 'qqbot'"), 'QqbotQrBox 未绑定 qqbot')
  assert.ok(client.includes("inst.platform === 'feishu'") && client.includes('h(FeishuQrBox'), 'Platforms 卡片未挂接 FeishuQrBox')
  assert.ok(client.includes("inst.platform === 'qqbot'") && client.includes('h(QqbotQrBox'), 'Platforms 卡片未挂接 QqbotQrBox')
  assert.ok(client.includes("mode === 'feishu'") && client.includes("mode === 'qqbot'"), 'Wizard 配置步骤未挂接飞书/QQBot 扫码')
  assert.ok(client.includes('与个人号 qq 隔离') || client.includes('与个人号 qq 完全隔离'), '面板缺少 qqbot 与个人号 qq 隔离提示')
  assert.ok(client.includes('不会自动认主'), '面板缺少扫码不自动认主提示')
})
