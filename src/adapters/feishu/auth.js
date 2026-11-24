// 飞书开放平台一键扫码创建应用 AuthDriver（Phase 1A：RFC 8628 Device Registration Flow）。
// 零第三方依赖：仅使用 Node >= 22 内置 fetch 与 node:zlib，只负责获取 AppID / AppSecret，不直接触碰运行时或主人身份。

import { gzipSync } from 'node:zlib'
import { MAX_QR_UTF8_BYTES } from '../../core/qr.js'
import { AuthError } from '../../gateway/auth.js'

export const FEISHU_ACCOUNTS_BASE_URL = 'https://accounts.feishu.cn'
export const LARK_ACCOUNTS_BASE_URL = 'https://accounts.larksuite.com'
export const FEISHU_API_BASE_URL = 'https://open.feishu.cn'
export const LARK_API_BASE_URL = 'https://open.larksuite.com'
export const FEISHU_REGISTRATION_PATH = '/oauth/v1/app/registration'

const FEISHU_PLATFORM_ID = 'feishu'
const DEFAULT_TTL_MS = 10 * 60_000
const DEFAULT_POLL_INTERVAL_MS = 5000
const ALLOWED_QR_HOSTS = new Set([
  'accounts.feishu.cn',
  'accounts.larksuite.com',
  'open.feishu.cn',
  'open.larksuite.com',
])

export const FEISHU_QR_ADDONS = Object.freeze({
  preset: false,
  scopes: Object.freeze({
    tenant: Object.freeze([
      'im:message.p2p_msg:readonly',
      'im:message.group_at_msg:readonly',
      'im:message.group_at_msg.include_bot:readonly',
      'im:message:readonly',
      'im:message:send_as_bot',
      'im:resource',
    ]),
  }),
  events: Object.freeze({
    items: Object.freeze({
      tenant: Object.freeze(['im.message.receive_v1']),
    }),
  }),
})

/**
 * 将飞书应用创建增量配置编码为官方 URL-safe gzip base64 字符串。
 */
export function encodeFeishuAddons(addons = FEISHU_QR_ADDONS) {
  const json = JSON.stringify(addons)
  return gzipSync(Buffer.from(json, 'utf8'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
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

function pickInitialDomain(params = {}, currentConfig = {}) {
  const explicit = String(params?.domain || '').trim().toLowerCase()
  if (explicit === 'lark') return 'lark'
  const baseUrl = String(params?.baseUrl || currentConfig?.baseUrl || '').trim().toLowerCase()
  if (baseUrl.includes('larksuite.com')) return 'lark'
  return 'feishu'
}

function resolveAccountsBase(domain) {
  return domain === 'lark' ? LARK_ACCOUNTS_BASE_URL : FEISHU_ACCOUNTS_BASE_URL
}

function resolveApiBase(domain) {
  return domain === 'lark' ? LARK_API_BASE_URL : FEISHU_API_BASE_URL
}

function assertSafeFeishuQrUrl(rawUrl) {
  const s = String(rawUrl || '').trim()
  let parsed
  try {
    parsed = new URL(s)
  } catch {
    throw new AuthError({
      code: 'invalid-qr-url',
      stage: 'auth.begin',
      message: '飞书返回的授权二维码地址无效',
      retryable: false,
      platform: FEISHU_PLATFORM_ID,
    })
  }
  const host = parsed.hostname.toLowerCase()
  if (
    parsed.protocol !== 'https:'
    || (parsed.port && parsed.port !== '443')
    || parsed.username
    || parsed.password
    || !ALLOWED_QR_HOSTS.has(host)
  ) {
    throw new AuthError({
      code: 'invalid-qr-url',
      stage: 'auth.begin',
      message: '飞书返回了不受信任的授权二维码地址',
      retryable: false,
      platform: FEISHU_PLATFORM_ID,
    })
  }
  return parsed
}

function buildFeishuQrUrl(rawUrl, source = 'aurabot') {
  const qrUrlObj = assertSafeFeishuQrUrl(rawUrl)
  const customSource = String(source || 'aurabot').trim() || 'aurabot'
  qrUrlObj.searchParams.set('from', 'sdk')
  qrUrlObj.searchParams.set('source', `node-sdk/${customSource}`)
  qrUrlObj.searchParams.set('tp', 'sdk')
  qrUrlObj.searchParams.set('createOnly', 'true')
  qrUrlObj.searchParams.set('addons', encodeFeishuAddons(FEISHU_QR_ADDONS))

  const qrUrl = qrUrlObj.toString()
  if (Buffer.byteLength(qrUrl, 'utf8') > MAX_QR_UTF8_BYTES) {
    throw new AuthError({
      code: 'qr-too-long',
      stage: 'auth.qr.encode',
      message: '飞书授权二维码链接超出编码长度上限',
      retryable: false,
      platform: FEISHU_PLATFORM_ID,
    })
  }
  return qrUrl
}

async function readJsonBody(response) {
  if (!response) return null
  if (typeof response.json === 'function') {
    try {
      return await response.json()
    } catch {
      return null
    }
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

async function postRegistration(fetchImpl, accountsBaseUrl, params, { stage, signal, timeoutMs }) {
  if (typeof fetchImpl !== 'function') {
    throw new AuthError({
      code: 'fetch-unavailable',
      stage,
      message: '当前运行环境不支持 fetch，无法请求飞书扫码注册接口',
      retryable: false,
      platform: FEISHU_PLATFORM_ID,
    })
  }
  const { requestSignal, timeoutSignal } = buildCombinedSignal(signal, timeoutMs)
  let response
  try {
    response = await fetchImpl(`${accountsBaseUrl}${FEISHU_REGISTRATION_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams(params).toString(),
      redirect: 'error',
      signal: requestSignal,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    if (timeoutSignal.aborted) {
      throw new AuthError({
        code: 'feishu-timeout',
        stage,
        message: '请求飞书开放平台超时，请检查网络连接后重试',
        retryable: true,
        platform: FEISHU_PLATFORM_ID,
        cause: error,
      })
    }
    throw new AuthError({
      code: 'feishu-network-error',
      stage,
      message: '无法连接飞书开放平台，请检查网络连接后重试',
      retryable: true,
      platform: FEISHU_PLATFORM_ID,
      cause: error,
    })
  }

  const data = await readJsonBody(response)
  const status = Number(response?.status ?? (response?.ok === false ? 500 : 200))
  const isAcceptable = (status >= 200 && status < 300) || (status === 400 && data && typeof data === 'object')
  if (!isAcceptable || !data || typeof data !== 'object' || Array.isArray(data)) {
    throw new AuthError({
      code: `feishu-http-${status || 'error'}`,
      stage,
      message: `飞书开放平台返回异常状态（HTTP ${status || '未知'}），请稍后重试或改用手动填写凭证`,
      retryable: true,
      platform: FEISHU_PLATFORM_ID,
    })
  }
  return data
}

/**
 * 飞书统一认证驱动（实现 PlatformAuthDriver 契约，method = 'qr-app'）。
 */
export function createFeishuAuthDriver({
  fetchImpl,
  getFetch,
  source = 'aurabot',
  timeoutMs = 15_000,
} = {}) {
  const resolveFetch = () => (typeof getFetch === 'function' ? getFetch() : null) || fetchImpl || globalThis.fetch

  return {
    platform: FEISHU_PLATFORM_ID,
    methods: [
      {
        method: 'qr-app',
        label: '飞书扫码创建应用',
        description: '通过手机飞书 / Lark 扫码一键创建企业自建应用并获取 App ID / App Secret',
        defaultTtlMs: DEFAULT_TTL_MS,
        defaultPollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      },
    ],
    allowedConfigKeys: ['appId', 'baseUrl', 'transport'],
    sensitiveDriverSessionKeys: ['deviceCode'],
    validateInstance: (instance) => /^feishu(?:#[a-z0-9_-]+)?$/.test(String(instance || '')),

    async start({ params = {}, currentConfig = {}, signal }) {
      const domain = pickInitialDomain(params, currentConfig)
      const accountsBaseUrl = resolveAccountsBase(domain)
      const apiBaseUrl = resolveApiBase(domain)

      const beginRes = await postRegistration(
        resolveFetch(),
        accountsBaseUrl,
        {
          action: 'begin',
          archetype: 'PersonalAgent',
          auth_method: 'client_secret',
          request_user_info: 'open_id',
        },
        { stage: 'auth.begin', signal, timeoutMs },
      )

      if (beginRes.error) {
        throw new AuthError({
          code: String(beginRes.error || 'feishu-begin-failed'),
          stage: 'auth.begin',
          message: '飞书拒绝创建扫码注册会话，请稍后重试或改用手动配置凭证',
          retryable: true,
          platform: FEISHU_PLATFORM_ID,
        })
      }

      const deviceCode = String(beginRes.device_code || '').trim()
      if (!deviceCode || !beginRes.verification_uri_complete) {
        throw new AuthError({
          code: 'incomplete-registration',
          stage: 'auth.begin',
          message: '飞书返回的注册会话缺少必要参数，请重试',
          retryable: true,
          platform: FEISHU_PLATFORM_ID,
        })
      }

      const customSource = String(params?.source || source || 'aurabot').trim() || 'aurabot'
      const qrUrl = buildFeishuQrUrl(beginRes.verification_uri_complete, customSource)

      const rawInterval = Number(beginRes.interval)
      const pollIntervalMs = Number.isFinite(rawInterval) && rawInterval > 0
        ? Math.max(1000, Math.trunc(rawInterval * 1000))
        : DEFAULT_POLL_INTERVAL_MS
      const rawExpiresIn = Number(beginRes.expires_in)
      const expiresInMs = Number.isFinite(rawExpiresIn) && rawExpiresIn > 0
        ? Math.trunc(rawExpiresIn * 1000)
        : DEFAULT_TTL_MS

      return {
        state: 'qr_ready',
        driverSession: {
          deviceCode,
          accountsBaseUrl,
          apiBaseUrl,
          domain,
          domainSwitched: domain === 'lark',
          pollIntervalMs,
          source: customSource,
        },
        qrContent: qrUrl,
        verificationUrl: qrUrl,
        domain,
        expiresInMs,
        pollIntervalMs,
        message: '请使用手机飞书扫描二维码并确认创建机器人（预设基础收发与图片/文件读取权限；全群旁听、群管理或审批发布请在飞书开放平台补充）',
        meta: {
          domain,
          baseUrl: apiBaseUrl,
        },
      }
    },

    async poll({ driverSession = {}, signal }) {
      const deviceCode = String(driverSession?.deviceCode || '').trim()
      if (!deviceCode) {
        throw new AuthError({
          code: 'invalid-driver-session',
          stage: 'auth.poll',
          message: '飞书扫码会话已失效，请重新生成二维码',
          retryable: true,
          platform: FEISHU_PLATFORM_ID,
        })
      }

      const domain = driverSession.domain === 'lark' ? 'lark' : 'feishu'
      const accountsBaseUrl = String(driverSession.accountsBaseUrl || resolveAccountsBase(domain)).trim()
      const apiBaseUrl = String(driverSession.apiBaseUrl || resolveApiBase(domain)).trim()
      const domainSwitched = Boolean(driverSession.domainSwitched)
      const curPollIntervalMs = Math.max(1000, Number(driverSession.pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS)

      const pollRes = await postRegistration(
        resolveFetch(),
        accountsBaseUrl,
        {
          action: 'poll',
          device_code: deviceCode,
        },
        { stage: 'auth.poll', signal, timeoutMs },
      )

      const tenantBrand = String(pollRes?.user_info?.tenant_brand || '').trim().toLowerCase()
      if (pollRes.client_id && pollRes.client_secret) {
        const finalDomain = tenantBrand === 'lark' ? 'lark' : domain
        const finalApiBaseUrl = finalDomain === 'lark' ? LARK_API_BASE_URL : apiBaseUrl
        const appId = String(pollRes.client_id).trim()
        const appSecret = String(pollRes.client_secret)
        // 注意：绝不把 appId (cli_xxx) 填进 expectedSelf.account —— 飞书 whoami 返回 bot.open_id (ou_xxx)
        return {
          state: 'authorized',
          completion: {
            configPatch: {
              appId,
              baseUrl: finalApiBaseUrl,
            },
            secretPatch: {
              appSecret,
            },
            meta: {
              appId,
              domain: finalDomain,
              baseUrl: finalApiBaseUrl,
            },
          },
          message: '飞书扫码创建应用成功，已保存凭证并启动连接',
        }
      }

      if (tenantBrand === 'lark' && !domainSwitched) {
        // 对齐 @larksuiteoapi/node-sdk@1.73.0：domain_switched 发生在国际版用户扫码之后，
        // 只需把同一 deviceCode 的后续轮询切到 accounts.larksuite.com（若上游随响应附带新链接则一并校验刷新，否则保留当前二维码）。
        const refreshedUrl = pollRes.verification_uri_complete
          ? buildFeishuQrUrl(pollRes.verification_uri_complete, driverSession.source || source)
          : ''
        const nextDriverSession = {
          ...driverSession,
          accountsBaseUrl: LARK_ACCOUNTS_BASE_URL,
          apiBaseUrl: LARK_API_BASE_URL,
          domain: 'lark',
          domainSwitched: true,
        }
        return {
          state: 'domain_switched',
          domain: 'lark',
          driverSession: nextDriverSession,
          ...(refreshedUrl ? { qrContent: refreshedUrl, verificationUrl: refreshedUrl } : {}),
          message: refreshedUrl
            ? '检测到国际版 Lark 租户，已切换至 Lark 节点并刷新授权二维码'
            : '已检测到国际版 Lark 账号扫码，已切换至 Lark 节点继续等待手机确认（无需重新扫码）',
          meta: {
            domain: 'lark',
            baseUrl: LARK_API_BASE_URL,
          },
        }
      }

      switch (pollRes.error) {
        case 'authorization_pending':
          return {
            state: 'polling',
            scanned: false,
            message: '等待手机飞书扫码并确认创建应用…',
          }
        case 'slow_down': {
          const nextInterval = Math.min(60_000, curPollIntervalMs + 5000)
          return {
            state: 'slow_down',
            pollIntervalMs: nextInterval,
            driverSession: {
              ...driverSession,
              pollIntervalMs: nextInterval,
            },
            message: `飞书要求放慢轮询频率，${Math.ceil(nextInterval / 1000)} 秒后重试`,
          }
        }
        case 'expired_token':
          return {
            state: 'expired',
            message: '飞书注册二维码已过期，请重新生成',
          }
        case 'access_denied':
          throw new AuthError({
            code: 'access_denied',
            stage: 'auth.poll',
            message: '已在飞书端取消或拒绝创建应用授权',
            retryable: true,
            platform: FEISHU_PLATFORM_ID,
          })
        default:
          throw new AuthError({
            code: String(pollRes.error || 'registration-failed'),
            stage: 'auth.poll',
            message: '飞书应用创建未成功完成，请重试或改用手动填写 App ID / App Secret',
            retryable: true,
            platform: FEISHU_PLATFORM_ID,
          })
      }
    },
  }
}
