// QQ 官方机器人（qqbot）扫码创建与绑定 AuthDriver（Phase 1A）。
// 零第三方依赖：等价实现 @tencent-connect/qqbot-connector@1.2.0 底层协议（q.qq.com/lite/create_bind_task、
// /lite/poll_bind_result、/qqbot/openclaw/connect.html 与 32B 密钥 AES-256-GCM 解包），写入 platforms.qqbot（与个人号 OneBot qq 严格隔离）。
// 注：该 lite 接口属腾讯 QQBot 非官方连接器私有流程，目前经本地 AES-256-GCM 与状态机 mock 覆盖；若官方变更或下线接口，需回退面板手动填写 AppID / AppSecret。

import { createDecipheriv, randomBytes } from 'node:crypto'
import { AuthError } from '../../gateway/auth.js'

export const QQBOT_CONNECT_BASE_URL = 'https://q.qq.com'
export const QQBOT_PATH_CREATE_TASK = '/lite/create_bind_task'
export const QQBOT_PATH_POLL_RESULT = '/lite/poll_bind_result'
export const QQBOT_BIND_STATUS = Object.freeze({
  NONE: 0,
  PENDING: 1,
  COMPLETED: 2,
  EXPIRED: 3,
})
export const QQBOT_QR_TTL_MS = 5 * 60_000
export const QQBOT_POLL_INTERVAL_MS = 2000

const QQBOT_PLATFORM_ID = 'qqbot'

export function buildQqbotConnectUrl(taskId, source = 'aurabot') {
  return `${QQBOT_CONNECT_BASE_URL}/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(String(taskId || ''))}&source=${encodeURIComponent(String(source || ''))}&_wv=2`
}

/**
 * 使用绑定任务生成的一次性 32 字节密钥，按 AES-256-GCM（12B IV + cipher + 16B Tag）解密 bot_encrypt_secret。
 */
export function decryptQqbotSecret(encryptedBase64, keyBase64) {
  const key = Buffer.from(String(keyBase64 || '').trim(), 'base64')
  const raw = Buffer.from(String(encryptedBase64 || '').trim(), 'base64')
  if (key.length !== 32 || raw.length < 29) {
    throw new Error('QQBot 加密凭据长度无效')
  }
  const iv = raw.subarray(0, 12)
  const tag = raw.subarray(raw.length - 16)
  const ciphertext = raw.subarray(12, raw.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
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

async function postQqbotBindJson(fetchImpl, path, body, { stage, signal, timeoutMs }) {
  if (typeof fetchImpl !== 'function') {
    throw new AuthError({
      code: 'fetch-unavailable',
      stage,
      message: '当前运行环境不支持 fetch，无法请求 QQ 官方机器人绑定服务',
      retryable: false,
      platform: QQBOT_PLATFORM_ID,
    })
  }
  const { requestSignal, timeoutSignal } = buildCombinedSignal(signal, timeoutMs)
  let response
  try {
    response = await fetchImpl(`${QQBOT_CONNECT_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: requestSignal,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    if (timeoutSignal.aborted) {
      throw new AuthError({
        code: 'qqbot-timeout',
        stage,
        message: '请求 QQ 开放平台绑定服务超时，请稍后重试',
        retryable: true,
        platform: QQBOT_PLATFORM_ID,
        cause: error,
      })
    }
    throw new AuthError({
      code: 'qqbot-network-error',
      stage,
      message: '无法连接 QQ 开放平台绑定服务，请检查网络后重试',
      retryable: true,
      platform: QQBOT_PLATFORM_ID,
      cause: error,
    })
  }

  const status = Number(response?.status ?? (response?.ok === false ? 500 : 200))
  const data = await readJsonBody(response)
  if (status === 404 || status === 410) {
    throw new AuthError({
      code: 'qqbot-bind-unavailable',
      stage,
      message: `QQ 官方扫码绑定接口暂不可用或已变更（HTTP ${status}），请在下方手动填写 AppID / AppSecret`,
      retryable: false,
      platform: QQBOT_PLATFORM_ID,
    })
  }
  if (status === 429) {
    throw new AuthError({
      code: 'qqbot-rate-limited',
      stage,
      message: '请求 QQ 官方扫码绑定接口过于频繁，请稍后重试或改用手动填写 AppID / AppSecret',
      retryable: true,
      platform: QQBOT_PLATFORM_ID,
    })
  }
  if ((status < 200 || status >= 300) || !data || typeof data !== 'object' || Array.isArray(data)) {
    throw new AuthError({
      code: `qqbot-http-${status || 'error'}`,
      stage,
      message: `QQ 开放平台扫码绑定服务返回异常（HTTP ${status || '未知'}），请稍后重试或改用手动填写 AppID / AppSecret`,
      retryable: true,
      platform: QQBOT_PLATFORM_ID,
    })
  }
  if (Number(data.retcode) !== 0) {
    throw new AuthError({
      code: `qqbot-retcode-${Number.isFinite(Number(data.retcode)) ? Number(data.retcode) : 'err'}`,
      stage,
      message: `QQ 开放平台拒绝绑定请求（retcode=${Number.isFinite(Number(data.retcode)) ? Number(data.retcode) : 'err'}），请重试或改用手动填写 AppID / AppSecret`,
      retryable: true,
      platform: QQBOT_PLATFORM_ID,
    })
  }
  return data
}

/**
 * QQ 官方机器人统一认证驱动（实现 PlatformAuthDriver 契约，method = 'qr-app'）。
 */
export function createQqbotAuthDriver({
  fetchImpl,
  getFetch,
  source = 'aurabot',
  timeoutMs = 10_000,
} = {}) {
  const resolveFetch = () => (typeof getFetch === 'function' ? getFetch() : null) || fetchImpl || globalThis.fetch

  return {
    platform: QQBOT_PLATFORM_ID,
    methods: [
      {
        method: 'qr-app',
        label: 'QQ 官方扫码创建机器人',
        description: '通过手机 QQ 扫码创建并绑定 QQ 官方机器人（写入 qqbot，与个人号 OneBot qq 相互独立）',
        defaultTtlMs: QQBOT_QR_TTL_MS,
        defaultPollIntervalMs: QQBOT_POLL_INTERVAL_MS,
      },
    ],
    allowedConfigKeys: ['appId', 'transport'],
    sensitiveDriverSessionKeys: ['taskId', 'bindKey'],
    validateInstance: (instance) => /^qqbot(?:#[a-z0-9_-]+)?$/.test(String(instance || '')),

    async start({ params = {}, signal }) {
      const bindKey = randomBytes(32).toString('base64')
      const res = await postQqbotBindJson(
        resolveFetch(),
        QQBOT_PATH_CREATE_TASK,
        { key: bindKey },
        { stage: 'auth.begin', signal, timeoutMs },
      )
      const taskId = String(res?.data?.task_id || '').trim()
      if (!taskId) {
        throw new AuthError({
          code: 'missing-task-id',
          stage: 'auth.begin',
          message: 'QQ 开放平台未返回有效的绑定任务编号，请重试',
          retryable: true,
          platform: QQBOT_PLATFORM_ID,
        })
      }
      const qrUrl = buildQqbotConnectUrl(taskId, params?.source || source)
      return {
        state: 'qr_ready',
        driverSession: {
          taskId,
          bindKey,
        },
        qrContent: qrUrl,
        verificationUrl: qrUrl,
        expiresInMs: QQBOT_QR_TTL_MS,
        pollIntervalMs: QQBOT_POLL_INTERVAL_MS,
        message: '请使用手机 QQ 扫描二维码创建并绑定 QQ 官方机器人（仅写入 qqbot，不影响个人号 qq）',
      }
    },

    async poll({ driverSession = {}, signal }) {
      const taskId = String(driverSession?.taskId || '').trim()
      const bindKey = String(driverSession?.bindKey || '').trim()
      if (!taskId || !bindKey) {
        throw new AuthError({
          code: 'invalid-driver-session',
          stage: 'auth.poll',
          message: 'QQ 官方机器人扫码会话已失效，请重新生成二维码',
          retryable: true,
          platform: QQBOT_PLATFORM_ID,
        })
      }

      const res = await postQqbotBindJson(
        resolveFetch(),
        QQBOT_PATH_POLL_RESULT,
        { task_id: taskId },
        { stage: 'auth.poll', signal, timeoutMs },
      )
      const payload = res?.data && typeof res.data === 'object' ? res.data : {}
      const status = Number(payload.status ?? QQBOT_BIND_STATUS.NONE)

      if (status === QQBOT_BIND_STATUS.COMPLETED) {
        const botAppId = String(payload.bot_appid || '').trim()
        const encSecret = String(payload.bot_encrypt_secret || '').trim()
        if (!botAppId || !encSecret) {
          throw new AuthError({
            code: 'invalid-credentials',
            stage: 'auth.poll',
            message: 'QQ 开放平台返回的机器人凭据不完整，请重新扫码',
            retryable: true,
            platform: QQBOT_PLATFORM_ID,
          })
        }
        let appSecret = ''
        try {
          appSecret = String(decryptQqbotSecret(encSecret, bindKey) || '').trim()
        } catch {
          throw new AuthError({
            code: 'invalid-credentials',
            stage: 'auth.poll',
            message: 'QQ 官方机器人凭据解密失败，请重新生成二维码再试',
            retryable: true,
            platform: QQBOT_PLATFORM_ID,
          })
        }
        if (!appSecret) {
          throw new AuthError({
            code: 'invalid-credentials',
            stage: 'auth.poll',
            message: '解密后的 QQ 官方机器人密钥为空，请重新扫码',
            retryable: true,
            platform: QQBOT_PLATFORM_ID,
          })
        }

        const userOpenid = String(payload.user_openid || '').trim()
        // 注意：qqbot 适配器密钥键为 clientSecret（不是 appSecret），且 whoami 优先返回 READY/users/@me 的 user.id，不填 expectedSelf.account=appId
        return {
          state: 'authorized',
          completion: {
            configPatch: {
              appId: botAppId,
            },
            secretPatch: {
              clientSecret: appSecret,
            },
            meta: {
              appId: botAppId,
              ...(userOpenid ? { userOpenid } : {}),
            },
          },
          message: 'QQ 官方机器人扫码绑定成功，已保存凭证并启动连接',
        }
      }

      if (status === QQBOT_BIND_STATUS.EXPIRED) {
        return {
          state: 'expired',
          message: 'QQ 官方机器人绑定二维码已过期，请重新生成',
        }
      }

      return {
        state: 'polling',
        scanned: false,
        message: '等待手机 QQ 扫码确认绑定…',
      }
    },
  }
}
