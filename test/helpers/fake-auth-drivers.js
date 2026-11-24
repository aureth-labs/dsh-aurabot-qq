// Phase 0 通用认证驱动测试夹具（无网络依赖，用于状态机、安全边界与宿主路由回归测试）。

/**
 * 模拟标准 App 扫码（qr-app / qr-link）驱动：start 返回 qrContent，轮询一次 scanned，再次 authorized。
 */
export function createFakeQrAppDriver({
  platform = 'fake-qr',
  method = 'qr-app',
  qrContent = 'https://auth.example.com/qr/ticket_alpha_001',
  botToken = 'fake_qr_bot_token_secret_12345',
  account = 'bot_fake_qr_1',
  name = 'Fake QR Bot',
  pollSteps,
  allowedConfigKeys = ['botId', 'baseUrl', 'region'],
} = {}) {
  const cancelCalls = []
  const pollCalls = []
  let defaultStep = 0
  return {
    platform,
    methods: [
      {
        method,
        label: 'Fake QR Login',
        description: '测试用假扫码登录驱动',
        defaultTtlMs: 60_000,
        defaultPollIntervalMs: 1000,
      },
    ],
    allowedConfigKeys,
    cancelCalls,
    pollCalls,
    async start({ params = {} }) {
      defaultStep = 0
      return {
        state: 'qr_ready',
        driverSession: { ticket: 'ticket_alpha_001', region: params.region || 'cn' },
        qrContent: params.qrContent !== undefined ? params.qrContent : qrContent,
        verificationUrl: params.verificationUrl !== undefined ? params.verificationUrl : qrContent,
        message: '请扫码确认授权',
      }
    },
    async poll({ driverSession, signal }) {
      pollCalls.push({ ticket: driverSession.ticket, aborted: Boolean(signal?.aborted) })
      if (Array.isArray(pollSteps) && pollSteps.length) {
        const idx = Math.min(pollCalls.length - 1, pollSteps.length - 1)
        const step = pollSteps[idx]
        return typeof step === 'function' ? step({ driverSession, signal, callIndex: pollCalls.length }) : step
      }
      defaultStep++
      if (defaultStep === 1) {
        return { state: 'polling', scanned: true, message: '已扫码，等待手机确认' }
      }
      return {
        state: 'authorized',
        completion: {
          configPatch: { botId: account, region: driverSession.region || 'cn' },
          secretPatch: { botToken },
          self: { account, name },
          meta: { botId: account, region: driverSession.region || 'cn' },
        },
        message: '假扫码登录成功',
      }
    },
    cancel(ctx) {
      cancelCalls.push({ instance: ctx.instance, method: ctx.method, reason: ctx.reason, ticket: ctx.driverSession?.ticket })
    },
  }
}

/**
 * 模拟 RFC 8628 Device Code 驱动：device_code_ready（含 verificationUrl + userCode）→ slow_down → authorized。
 */
export function createFakeDeviceCodeDriver({
  platform = 'fake-device',
  verificationUrl = 'https://auth.example.com/device',
  userCode = 'ABCD-EFGH',
  deviceCodeSecret = 'dev_code_secret_xyz_9988',
  appSecret = 'dev_app_secret_should_never_leak_7766',
  account = 'bot_device_01',
  slowDownMs = 4000,
  includeSlowDown = true,
} = {}) {
  const pollCalls = []
  const cancelCalls = []
  return {
    platform,
    methods: [
      {
        method: 'device-code',
        label: '设备码授权登录',
        description: '模拟 RFC 8628 Device Flow 认证',
        defaultTtlMs: 120_000,
        defaultPollIntervalMs: 1000,
      },
    ],
    allowedConfigKeys: ['appId', 'endpoint'],
    pollCalls,
    cancelCalls,
    async start() {
      pollCalls.length = 0
      return {
        state: 'device_code_ready',
        driverSession: {
          deviceCode: deviceCodeSecret,
          clientSecret: 'internal_temp_secret_111',
          endpoint: 'https://api.example.com',
        },
        verificationUrl,
        userCode,
        expiresInMs: 120_000,
        pollIntervalMs: 1000,
        message: `请打开 ${verificationUrl} 并输入验证码 ${userCode}`,
      }
    },
    async poll({ driverSession }) {
      pollCalls.push(driverSession.deviceCode)
      if (includeSlowDown && pollCalls.length === 1) {
        return {
          state: 'slow_down',
          pollIntervalMs: slowDownMs,
          message: '授权等待中，请稍慢轮询',
        }
      }
      return {
        state: 'authorized',
        completion: {
          configPatch: { appId: account, endpoint: driverSession.endpoint },
          secretPatch: { appSecret },
          self: { account, name: 'Device Bot' },
          meta: { appId: account },
        },
        message: '设备码授权成功',
      }
    },
    cancel(ctx) {
      cancelCalls.push(ctx.reason)
    },
  }
}

/**
 * 模拟二维码过期驱动：start 成功，首次 poll 返回 expired。
 */
export function createFakeExpiredDriver({ platform = 'fake-expired' } = {}) {
  const cancelCalls = []
  return {
    platform,
    methods: [{ method: 'qr-app', label: '过期测试驱动', defaultTtlMs: 30_000, defaultPollIntervalMs: 500 }],
    cancelCalls,
    async start() {
      return {
        state: 'qr_ready',
        driverSession: { ticket: 'exp_1' },
        qrContent: 'https://auth.example.com/exp/1',
      }
    },
    async poll() {
      return { state: 'expired', message: '二维码已超时失效' }
    },
    cancel(ctx) {
      cancelCalls.push(ctx.reason)
    },
  }
}

/**
 * 模拟 slow_down 退避驱动：记录上游实际被调用次数。
 */
export function createFakeSlowDownDriver({ platform = 'fake-slow', intervalMs = 6000 } = {}) {
  let calls = 0
  return {
    platform,
    methods: [{ method: 'qr-link', label: '退避测试驱动', defaultPollIntervalMs: 1000 }],
    get pollCount() { return calls },
    async start() {
      calls = 0
      return {
        state: 'qr_ready',
        driverSession: { ticket: 'slow_1' },
        qrContent: 'https://auth.example.com/slow/1',
      }
    },
    async poll() {
      calls++
      if (calls === 1) {
        return { state: 'slow_down', pollIntervalMs: intervalMs, message: '请求过快，降频' }
      }
      return {
        state: 'authorized',
        completion: {
          configPatch: { botId: 'slow_bot' },
          secretPatch: { botToken: 'slow_bot_secret_tok_999' },
          self: { account: 'slow_bot' },
        },
      }
    },
  }
}

/**
 * 模拟可被 AbortSignal 中止的阻塞/延迟轮询驱动（检验 cancel 与重复 start 竞态隔离）。
 */
export function createFakeCancelDriver({ platform = 'fake-cancel' } = {}) {
  const signals = []
  const cancelCalls = []
  let releaseFirstPoll = null
  return {
    platform,
    methods: [{ method: 'qr-app', label: '可取消驱动', defaultPollIntervalMs: 1000 }],
    signals,
    cancelCalls,
    releaseFirstPollWith(result) {
      releaseFirstPoll?.(result)
      releaseFirstPoll = null
    },
    async start() {
      return {
        state: 'qr_ready',
        driverSession: { ticket: `c_${signals.length + 1}` },
        qrContent: `https://auth.example.com/cancel/${signals.length + 1}`,
      }
    },
    poll({ signal }) {
      signals.push(signal)
      return new Promise((resolve) => {
        if (signals.length === 1) {
          releaseFirstPoll = resolve
          return
        }
        resolve({ state: 'polling', message: '新会话等待扫码' })
      })
    },
    cancel(ctx) {
      cancelCalls.push(ctx.reason)
    },
  }
}

/**
 * 模拟域名切换（如中国区/海外区切换）导致重发新二维码的驱动。
 */
export function createFakeDomainSwitchDriver({ platform = 'fake-domain' } = {}) {
  let step = 0
  return {
    platform,
    methods: [{ method: 'qr-app', label: '域名切换驱动', defaultPollIntervalMs: 1000 }],
    async start() {
      step = 0
      return {
        state: 'qr_ready',
        driverSession: { ticket: 'd_cn', domain: 'open.feishu.cn' },
        domain: 'open.feishu.cn',
        qrContent: 'https://open.feishu.cn/qr/1',
      }
    },
    async poll() {
      step++
      if (step === 1) {
        return {
          state: 'domain_switched',
          domain: 'open.larksuite.com',
          driverSession: { ticket: 'd_global', domain: 'open.larksuite.com' },
          qrContent: 'https://open.larksuite.com/qr/2',
          verificationUrl: 'https://open.larksuite.com/qr/2',
          expiresInMs: 90_000,
          message: '已切换至国际版节点，请扫描新二维码',
        }
      }
      return {
        state: 'authorized',
        completion: {
          configPatch: { domain: 'open.larksuite.com' },
          secretPatch: { appSecret: 'lark_secret_8888' },
          self: { account: 'bot_lark_1' },
        },
      }
    },
  }
}
