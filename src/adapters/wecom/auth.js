// 企业微信智能机器人（wecom）扫码创建与绑定 AuthDriver（Phase 1B）。
// 零第三方依赖：基于 Node >= 22 内置 fetch，对接官方 work.weixin.qq.com/ai/qc/* 扫码服务，
// 仅写入 platforms.wecom（与个人微信 wechat-clawbot 严格隔离，不自动认主）。

import { MAX_QR_UTF8_BYTES } from '../../core/qr.js'
import { AuthError } from '../../gateway/auth.js'

export const WECOM_QR_GENERATE_URL = 'https://work.weixin.qq.com/ai/qc/generate'
export const WECOM_QR_POLL_URL = 'https://work.weixin.qq.com/ai/qc/query_result'
export const WECOM_QR_TTL_MS = 5 * 60_000
export const WECOM_POLL_INTERVAL_MS = 3000

const WECOM_PLATFORM_ID = 'wecom'

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function defaultPlatformCode() {
  if (process.platform === 'win32') return 2
  if (process.platform === 'linux') return 3
  return 1
}

function buildCombinedSignal(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(Math.max(100, Number(timeoutMs) || 10_000))
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

function assertSafeWecomAuthUrl(rawUrl) {
  let parsed
  try {
    parsed = new URL(cleanString(rawUrl))
  } catch {
    throw new AuthError({
      code: 'invalid-qr-url',
      stage: 'auth.begin',
      message: '企业微信返回的授权二维码链接无效',
      retryable: false,
      platform: WECOM_PLATFORM_ID,
    })
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (
    parsed.protocol !== 'https:'
    || host !== 'work.weixin.qq.com'
    || (parsed.port && parsed.port !== '443')
    || parsed.username
    || parsed.password
  ) {
    throw new AuthError({
      code: 'invalid-qr-url',
      stage: 'auth.begin',
      message: '企业微信返回了不受信任的授权二维码域名',
      retryable: false,
      platform: WECOM_PLATFORM_ID,
    })
  }
  const href = parsed.href
  if (Buffer.byteLength(href, 'utf8') > MAX_QR_UTF8_BYTES) {
    throw new AuthError({
      code: 'qr-too-long',
      stage: 'auth.qr.encode',
      message: '企业微信授权二维码链接超出编码长度上限',
      retryable: false,
      platform: WECOM_PLATFORM_ID,
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

async function getWecomQrJson(fetchImpl, url, { stage, action, signal, timeoutMs }) {
  if (typeof fetchImpl !== 'function') {
    throw new AuthError({
      code: 'fetch-unavailable',
      stage,
      message: '当前运行环境不支持 fetch，无法请求企业微信扫码服务',
      retryable: false,
      platform: WECOM_PLATFORM_ID,
    })
  }
  const { requestSignal, timeoutSignal } = buildCombinedSignal(signal, timeoutMs)
  let response
  try {
    response = await fetchImpl(String(url), {
      method: 'GET',
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal: requestSignal,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    if (timeoutSignal.aborted) {
      throw new AuthError({
        code: 'wecom-timeout',
        stage,
        message: `请求企业微信${action}超时，请检查网络连接后重试`,
        retryable: true,
        platform: WECOM_PLATFORM_ID,
        cause: error,
      })
    }
    throw new AuthError({
      code: 'wecom-network-error',
      stage,
      message: `无法连接企业微信${action}服务，请检查网络后重试`,
      retryable: true,
      platform: WECOM_PLATFORM_ID,
      cause: error,
    })
  }

  const status = Number(response?.status ?? (response?.ok === false ? 500 : 200))
  const data = await readJsonBody(response)
  if ((status < 200 || status >= 300) || response?.ok === false || !data || typeof data !== 'object' || Array.isArray(data)) {
    throw new AuthError({
      code: `wecom-http-${status || 'error'}`,
      stage,
      message: `企业微信${action}服务返回异常（HTTP ${status || '未知'}），请稍后重试或改用手动填写 Bot ID / Secret`,
      retryable: true,
      platform: WECOM_PLATFORM_ID,
    })
  }
  if (data.errcode !== undefined && Number(data.errcode) !== 0) {
    throw new AuthError({
      code: `wecom-api-${Number.isFinite(Number(data.errcode)) ? Number(data.errcode) : 'err'}`,
      stage,
      message: `企业微信${action}请求被拒绝（errcode=${Number.isFinite(Number(data.errcode)) ? Number(data.errcode) : 'err'}），请重试或改用手动填写凭证`,
      retryable: true,
      platform: WECOM_PLATFORM_ID,
    })
  }
  return data
}

/**
 * 企业微信智能机器人统一认证驱动（实现 PlatformAuthDriver 契约，method = 'qr-link'）。
 */
export function createWecomAuthDriver({
  fetchImpl,
  getFetch,
  source = 'deepseek-harness',
  platform = defaultPlatformCode(),
  timeoutMs = 10_000,
} = {}) {
  const resolveFetch = () => (typeof getFetch === 'function' ? getFetch() : null) || fetchImpl || globalThis.fetch
  const platCode = [1, 2, 3].includes(Number(platform)) ? Number(platform) : defaultPlatformCode()
  const fixedSource = cleanString(source) || 'deepseek-harness'

  return {
    platform: WECOM_PLATFORM_ID,
    methods: [
      {
        method: 'qr-link',
        label: '企业微信扫码绑定机器人',
        description: '通过企业微信客户端扫码创建或绑定智能机器人（仅写入 wecom，与个人微信 wechat-clawbot 严格隔离）',
        defaultTtlMs: WECOM_QR_TTL_MS,
        defaultPollIntervalMs: WECOM_POLL_INTERVAL_MS,
      },
    ],
    allowedConfigKeys: ['botId', 'wsUrl'],
    sensitiveDriverSessionKeys: ['scode'],
    validateInstance: (instance) => /^wecom(?:#[a-z0-9_-]+)?$/.test(String(instance || '')),

    async start({ params = {}, signal }) {
      const url = new URL(WECOM_QR_GENERATE_URL)
      url.searchParams.set('source', cleanString(params?.source) || fixedSource)
      url.searchParams.set('plat', String(platCode))

      const res = await getWecomQrJson(resolveFetch(), url, {
        stage: 'auth.begin',
        action: '生成扫码二维码',
        signal,
        timeoutMs,
      })

      const scode = cleanString(res?.data?.scode)
      const rawAuthUrl = cleanString(res?.data?.auth_url)
      if (!scode || !rawAuthUrl) {
        throw new AuthError({
          code: 'incomplete-qr-response',
          stage: 'auth.begin',
          message: '企业微信扫码服务未返回完整的授权码或二维码链接，请重试',
          retryable: true,
          platform: WECOM_PLATFORM_ID,
        })
      }

      const verificationUrl = assertSafeWecomAuthUrl(rawAuthUrl)
      return {
        state: 'qr_ready',
        driverSession: {
          scode,
        },
        qrContent: verificationUrl,
        verificationUrl,
        expiresInMs: WECOM_QR_TTL_MS,
        pollIntervalMs: WECOM_POLL_INTERVAL_MS,
        message: '请使用企业微信客户端扫描二维码创建或绑定智能机器人（仅写入 wecom，与个人微信 wechat-clawbot 完全隔离）',
      }
    },

    async poll({ driverSession = {}, signal }) {
      const scode = cleanString(driverSession?.scode)
      if (!scode) {
        throw new AuthError({
          code: 'invalid-driver-session',
          stage: 'auth.poll',
          message: '企业微信扫码会话已失效，请重新生成二维码',
          retryable: true,
          platform: WECOM_PLATFORM_ID,
        })
      }

      const url = new URL(WECOM_QR_POLL_URL)
      url.searchParams.set('scode', scode)

      const res = await getWecomQrJson(resolveFetch(), url, {
        stage: 'auth.poll',
        action: '查询扫码状态',
        signal,
        timeoutMs,
      })

      const state = cleanString(res?.data?.status).toLowerCase()
      if (state === 'success') {
        const botId = cleanString(res?.data?.bot_info?.botid)
        const secret = cleanString(res?.data?.bot_info?.secret)
        if (!botId || !secret) {
          throw new AuthError({
            code: 'incomplete-credentials',
            stage: 'auth.poll',
            message: '企业微信扫码已确认，但未返回完整的机器人 Bot ID / Secret',
            retryable: true,
            platform: WECOM_PLATFORM_ID,
          })
        }
        return {
          state: 'authorized',
          completion: {
            configPatch: { botId },
            secretPatch: { secret },
            self: { account: botId },
            meta: { botId },
          },
          message: '企业微信智能机器人扫码绑定成功，已保存凭证并启动连接',
        }
      }

      if (state === 'expired' || state === 'timeout') {
        return {
          state: 'expired',
          message: '企业微信扫码二维码已过期，请重新生成',
        }
      }

      if (state === 'fail' || state === 'failed' || state === 'error') {
        throw new AuthError({
          code: 'wecom-qr-failed',
          stage: 'auth.poll',
          message: '企业微信扫码授权失败，请重新生成二维码或手动填写 Bot ID / Secret',
          retryable: true,
          platform: WECOM_PLATFORM_ID,
        })
      }

      if (state === 'scanned' || state === 'scaned') {
        return {
          state: 'polling',
          scanned: true,
          message: '已扫码，请在企业微信客户端确认绑定机器人…',
        }
      }

      return {
        state: 'polling',
        scanned: false,
        message: '等待企业微信客户端扫码确认…',
      }
    },
  }
}
