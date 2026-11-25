// 钉钉机器人扫码创建与绑定 AuthDriver（Phase 1B：Device Registration Flow）。
// 零第三方依赖：基于 Node >= 22 内置 fetch，等价实现钉钉 /app/registration/init|begin|poll 流程，
// 只负责获取 Client ID (AppKey) / Client Secret (AppSecret)，不直接触碰运行时、主人身份或共享会话。

import { MAX_QR_UTF8_BYTES } from '../../core/qr.js'
import { AuthError } from '../../gateway/auth.js'

export const DINGTALK_REGISTRATION_BASE_URL = 'https://oapi.dingtalk.com'
export const DINGTALK_REGISTRATION_SOURCE = 'DING_DWS_CLAW'
export const DINGTALK_QR_TTL_MS = 7200 * 1000
export const DINGTALK_POLL_INTERVAL_MS = 5000

const DINGTALK_PLATFORM_ID = 'dingtalk'
const EXPIRED_POLL_STATUSES = new Set(['EXPIRED', 'TIMEOUT'])
const CANCELLED_POLL_STATUSES = new Set(['CANCELLED', 'CANCELED'])
const FAILED_POLL_STATUSES = new Set(['FAIL', 'FAILED', 'REJECTED', 'DENIED', 'ERROR'])
const SUCCESS_POLL_STATUSES = new Set(['SUCCESS', 'COMPLETED', 'AUTHORIZED', 'DONE'])
const WAITING_POLL_STATUSES = new Set(['WAITING', 'INIT', 'CREATED'])
const SCANNED_POLL_STATUSES = new Set([
  'SCANNED',
  'SCANNING',
  'CONFIRMING',
  'CONFIRMED',
  'CREATING',
  'PROCESSING',
  'PENDING',
  'AUTHORIZING',
  'IN_PROGRESS',
])

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function buildCombinedSignal(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(Math.max(100, Number(timeoutMs) || 15_000))
  if (!signal) return { requestSignal: timeoutSignal, timeoutSignal }
  if (typeof AbortSignal.any === 'function') {
    return { requestSignal: AbortSignal.any([signal, timeoutSignal]), timeoutSignal }
  }
  const ac = new AbortController()
  const onAbort = () => ac.abort(signal.reason || timeoutSignal.reason)
  if (signal.aborted || timeoutSignal.aborted) {
    ac.abort(signal.reason || timeoutSignal.reason)
  } else {
    signal.addEventListener('abort', onAbort, { once: true })
    timeoutSignal.addEventListener('abort', onAbort, { once: true })
  }
  return { requestSignal: ac.signal, timeoutSignal }
}

function isDingtalkHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '')
  return host === 'dingtalk.com' || host.endsWith('.dingtalk.com')
}

export function normalizeDingtalkRegistrationBaseUrl(rawUrl) {
  let parsed
  try {
    parsed = new URL(cleanString(rawUrl) || DINGTALK_REGISTRATION_BASE_URL)
  } catch {
    throw new AuthError({
      code: 'invalid-registration-url',
      stage: 'auth.begin',
      message: '钉钉扫码注册服务地址无效，必须是合法 HTTPS 地址',
      retryable: false,
      platform: DINGTALK_PLATFORM_ID,
    })
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.port
    || !isDingtalkHost(parsed.hostname)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new AuthError({
      code: 'invalid-registration-url',
      stage: 'auth.begin',
      message: '钉钉扫码注册服务地址不受信任（仅允许默认端口 HTTPS dingtalk.com 域名）',
      retryable: false,
      platform: DINGTALK_PLATFORM_ID,
    })
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '')
  return parsed.href.replace(/\/$/, '')
}

function assertSafeDingtalkQrUrl(rawUrl) {
  let parsed
  try {
    parsed = new URL(cleanString(rawUrl))
  } catch {
    throw new AuthError({
      code: 'invalid-qr-url',
      stage: 'auth.begin',
      message: '钉钉返回的授权二维码链接无效',
      retryable: false,
      platform: DINGTALK_PLATFORM_ID,
    })
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.port
    || !isDingtalkHost(parsed.hostname)
    || parsed.username
    || parsed.password
  ) {
    throw new AuthError({
      code: 'invalid-qr-url',
      stage: 'auth.begin',
      message: '钉钉返回了不受信任的授权二维码域名',
      retryable: false,
      platform: DINGTALK_PLATFORM_ID,
    })
  }
  const href = parsed.toString()
  if (Buffer.byteLength(href, 'utf8') > MAX_QR_UTF8_BYTES) {
    throw new AuthError({
      code: 'qr-too-long',
      stage: 'auth.qr.encode',
      message: '钉钉授权二维码链接超出编码长度上限',
      retryable: false,
      platform: DINGTALK_PLATFORM_ID,
    })
  }
  return href
}

async function readJsonBody(response) {
  if (!response) return null
  if (typeof response.json === 'function') {
    try { return await response.json() } catch { return null }
  }
  if (typeof response.text === 'function') {
    try {
      const txt = await response.text()
      return txt ? JSON.parse(txt) : null
    } catch {
      return null
    }
  }
  return null
}

async function postDingtalkRegistration(fetchImpl, baseUrl, path, body, { stage, action, signal, timeoutMs }) {
  if (typeof fetchImpl !== 'function') {
    throw new AuthError({
      code: 'fetch-unavailable',
      stage,
      message: '当前运行环境不支持 fetch，无法请求钉钉扫码注册服务',
      retryable: false,
      platform: DINGTALK_PLATFORM_ID,
    })
  }
  const { requestSignal, timeoutSignal } = buildCombinedSignal(signal, timeoutMs)
  let response
  try {
    response = await fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body ?? {}),
      redirect: 'error',
      signal: requestSignal,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    if (timeoutSignal.aborted) {
      throw new AuthError({
        code: 'dingtalk-timeout',
        stage,
        message: `请求钉钉${action}接口超时，请检查网络连接后重试`,
        retryable: true,
        platform: DINGTALK_PLATFORM_ID,
        cause: error,
      })
    }
    throw new AuthError({
      code: 'dingtalk-network-error',
      stage,
      message: `无法连接钉钉${action}服务，请检查网络或代理设置后重试`,
      retryable: true,
      platform: DINGTALK_PLATFORM_ID,
      cause: error,
    })
  }

  const status = Number(response?.status ?? (response?.ok === false ? 500 : 200))
  const data = await readJsonBody(response)
  if ((status < 200 || status >= 300) || response?.ok === false || !data || typeof data !== 'object' || Array.isArray(data)) {
    throw new AuthError({
      code: `dingtalk-http-${status || 'error'}`,
      stage,
      message: `钉钉${action}服务返回异常状态（HTTP ${status || '未知'}），请稍后重试或改用手动填写凭证`,
      retryable: true,
      platform: DINGTALK_PLATFORM_ID,
    })
  }
  if (Number(data.errcode) !== 0) {
    throw new AuthError({
      code: 'dingtalk-api-error',
      stage,
      message: `钉钉${action}请求被平台拒绝（errcode=${Number.isFinite(Number(data.errcode)) ? Number(data.errcode) : 'err'}），请重试或改用手动填写 Client ID / Client Secret`,
      retryable: true,
      platform: DINGTALK_PLATFORM_ID,
    })
  }
  return data
}

/**
 * 钉钉统一认证驱动（实现 PlatformAuthDriver 契约，method = 'device-code'）。
 */
export function createDingtalkAuthDriver({
  fetchImpl,
  getFetch,
  registrationBaseUrl = DINGTALK_REGISTRATION_BASE_URL,
  source = DINGTALK_REGISTRATION_SOURCE,
  timeoutMs = 15_000,
} = {}) {
  const resolveFetch = () => (typeof getFetch === 'function' ? getFetch() : null) || fetchImpl || globalThis.fetch
  const fixedSource = cleanString(source) || DINGTALK_REGISTRATION_SOURCE

  return {
    platform: DINGTALK_PLATFORM_ID,
    methods: [
      {
        method: 'device-code',
        label: '钉钉扫码创建机器人',
        description: '通过手机钉钉扫描二维码一键创建或绑定钉钉机器人，自动获取 Client ID / Client Secret',
        defaultTtlMs: DINGTALK_QR_TTL_MS,
        defaultPollIntervalMs: DINGTALK_POLL_INTERVAL_MS,
      },
    ],
    allowedConfigKeys: ['clientId', 'apiBaseUrl', 'oapiBaseUrl'],
    sensitiveDriverSessionKeys: ['deviceCode'],
    validateInstance: (instance) => /^dingtalk(?:#[a-z0-9_-]+)?$/.test(String(instance || '')),

    async start({ params = {}, currentConfig = {}, signal }) {
      const baseUrl = normalizeDingtalkRegistrationBaseUrl(
        params?.registrationBaseUrl || currentConfig?.oapiBaseUrl || registrationBaseUrl,
      )
      const fetchFn = resolveFetch()

      const initRes = await postDingtalkRegistration(
        fetchFn,
        baseUrl,
        '/app/registration/init',
        { source: fixedSource },
        { stage: 'auth.begin', action: '扫码初始化', signal, timeoutMs },
      )
      const nonce = cleanString(initRes.nonce)
      if (!nonce) {
        throw new AuthError({
          code: 'missing-nonce',
          stage: 'auth.begin',
          message: '钉钉扫码初始化未返回有效的 nonce，请重试',
          retryable: true,
          platform: DINGTALK_PLATFORM_ID,
        })
      }

      const beginRes = await postDingtalkRegistration(
        fetchFn,
        baseUrl,
        '/app/registration/begin',
        { nonce },
        { stage: 'auth.begin', action: '创建二维码会话', signal, timeoutMs },
      )
      const deviceCode = cleanString(beginRes.device_code)
      const rawUrl = cleanString(beginRes.verification_uri_complete)
      if (!deviceCode || !rawUrl) {
        throw new AuthError({
          code: 'incomplete-registration',
          stage: 'auth.begin',
          message: '钉钉扫码服务返回的会话参数不完整，请重试',
          retryable: true,
          platform: DINGTALK_PLATFORM_ID,
        })
      }

      const verificationUrl = assertSafeDingtalkQrUrl(rawUrl)
      const userCode = cleanString(beginRes.user_code)
      const rawExpires = Number(beginRes.expires_in)
      const expiresInMs = Number.isFinite(rawExpires) && rawExpires > 0
        ? Math.trunc(rawExpires * 1000)
        : DINGTALK_QR_TTL_MS
      const rawInterval = Number(beginRes.interval)
      const pollIntervalMs = Number.isFinite(rawInterval) && rawInterval > 0
        ? Math.max(1000, Math.trunc(rawInterval * 1000))
        : DINGTALK_POLL_INTERVAL_MS

      return {
        state: 'device_code_ready',
        driverSession: {
          deviceCode,
          registrationBaseUrl: baseUrl,
        },
        qrContent: verificationUrl,
        verificationUrl,
        ...(userCode ? { userCode } : {}),
        expiresInMs,
        pollIntervalMs,
        message: '请使用手机钉钉扫描二维码并确认创建机器人（也可点击下方授权链接）',
      }
    },

    async poll({ driverSession = {}, signal }) {
      const deviceCode = cleanString(driverSession?.deviceCode)
      if (!deviceCode) {
        throw new AuthError({
          code: 'invalid-driver-session',
          stage: 'auth.poll',
          message: '钉钉扫码会话已失效，请重新生成二维码',
          retryable: true,
          platform: DINGTALK_PLATFORM_ID,
        })
      }
      const baseUrl = normalizeDingtalkRegistrationBaseUrl(
        driverSession?.registrationBaseUrl || registrationBaseUrl,
      )

      const pollRes = await postDingtalkRegistration(
        resolveFetch(),
        baseUrl,
        '/app/registration/poll',
        { device_code: deviceCode },
        { stage: 'auth.poll', action: '轮询扫码状态', signal, timeoutMs },
      )

      const status = cleanString(pollRes.status).toUpperCase()
      const clientId = cleanString(pollRes.client_id || pollRes.result?.client_id)
      const clientSecret = cleanString(pollRes.client_secret || pollRes.result?.client_secret)

      if (EXPIRED_POLL_STATUSES.has(status)) {
        return {
          state: 'expired',
          message: '钉钉扫码二维码已过期，请重新生成',
        }
      }

      if (CANCELLED_POLL_STATUSES.has(status)) {
        return {
          state: 'cancelled',
          message: '已取消钉钉机器人扫码授权',
        }
      }

      if (FAILED_POLL_STATUSES.has(status)) {
        throw new AuthError({
          code: 'dingtalk-registration-failed',
          stage: 'auth.poll',
          message: '钉钉扫码创建机器人未成功，请重新生成二维码或改用手动填写 Client ID / Client Secret',
          retryable: true,
          platform: DINGTALK_PLATFORM_ID,
        })
      }

      if (SUCCESS_POLL_STATUSES.has(status) || (clientId && clientSecret)) {
        if (!clientId || !clientSecret) {
          throw new AuthError({
            code: 'incomplete-credentials',
            stage: 'auth.poll',
            message: '钉钉扫码已确认，但平台未返回完整的 Client ID / Client Secret',
            retryable: true,
            platform: DINGTALK_PLATFORM_ID,
          })
        }
        return {
          state: 'authorized',
          completion: {
            configPatch: { clientId },
            secretPatch: { clientSecret },
            self: { account: clientId },
            meta: { clientId },
          },
          message: '钉钉机器人扫码创建成功，已保存凭证并启动连接',
        }
      }

      if (WAITING_POLL_STATUSES.has(status)) {
        return {
          state: 'polling',
          scanned: false,
          message: '等待手机钉钉扫码确认创建机器人…',
        }
      }

      if (SCANNED_POLL_STATUSES.has(status)) {
        return {
          state: 'polling',
          scanned: true,
          message: '已扫码，正在等待手机钉钉确认并完成机器人创建…',
        }
      }

      const safeStatus = /^[A-Z0-9_-]{1,32}$/.test(status) ? status : ''
      return {
        state: 'polling',
        ...(safeStatus ? { meta: { status: safeStatus } } : {}),
        message: safeStatus
          ? `钉钉正在处理扫码状态（${safeStatus}），请继续在手机端完成确认…`
          : '等待钉钉返回扫码确认结果…',
      }
    },
  }
}
