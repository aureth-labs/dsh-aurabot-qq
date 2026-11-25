// 通用平台认证会话管理器（Phase 0：QR / Device Code / OAuth 状态机、取消、退避、防泄漏与落盘校验）。
// 严守分层边界（docs/PLATFORM-INTEGRATION.md）：不直接 import src/adapters/*，由宿主通过 register() 注入各平台 AuthDriver。

import { randomUUID } from 'node:crypto'
import { PLATFORM_SECRET_KEYS } from '../core/config.js'
import { isSafeQrImageDataUri, renderQrDataUri } from '../core/qr.js'
import { redact as globalRedact } from '../core/redact.js'

export const AUTH_METHODS = Object.freeze([
  'qr-app',
  'qr-link',
  'device-code',
  'oauth-callback',
  'manual',
])

export const AUTH_STATES = Object.freeze([
  'starting',
  'qr_ready',
  'device_code_ready',
  'polling',
  'slow_down',
  'domain_switched',
  'authorized',
  'saving',
  'succeeded',
  'expired',
  'cancelled',
  'error',
])

export const AUTH_ERROR_STAGES = Object.freeze([
  'auth.begin',
  'auth.qr.encode',
  'auth.qr.expire',
  'auth.poll',
  'auth.slow_down',
  'auth.cancel',
  'auth.verify',
  'auth.save',
  'auth.connect',
])

export const TERMINAL_AUTH_STATES = Object.freeze(new Set(['succeeded', 'expired', 'cancelled', 'error']))
export const DISPLAY_QR_AUTH_STATES = Object.freeze(new Set([
  'qr_ready',
  'device_code_ready',
  'polling',
  'slow_down',
  'domain_switched',
]))

const AUTH_METHOD_SET = new Set(AUTH_METHODS)
const AUTH_ERROR_STAGE_SET = new Set(AUTH_ERROR_STAGES)
const PLATFORM_SECRET_KEY_SET = new Set(PLATFORM_SECRET_KEYS)
const PROTOTYPE_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const INSTANCE_RE = /^[a-z][a-z0-9-]*(?:#[a-z0-9_-]+)?$/
const FORBIDDEN_SECRET_NAME_RE = /(?:secret|token|password|passwd|cookie|private_?key|aes_?key|encrypt_?key|api_?key|credential|auth_?code)/i
const TRANSIENT_AUTH_CONFIG_KEYS = new Set([
  'deviceCode',
  'device_code',
  'qrCodeUrl',
  'qrcodeUrl',
  'qrDataUri',
  'qr_data_uri',
  'qrContent',
  'qr_content',
  'qrcode',
  'verificationUrl',
  'verificationUri',
  'verificationUriComplete',
  'verification_url',
  'verification_uri',
  'verification_uri_complete',
  'userCode',
  'user_code',
  'driverSession',
  'expiresIn',
  'expires_in',
  'expiresAt',
  'expires_at',
  'sessionId',
])
const DRIVER_SESSION_SECRET_KEY_RE = /(?:device_?code|qr_?code|s_?code|bind_?key|secret|token|password|passwd|cookie|private_?key|aes_?key|encrypt_?key|api_?key|credential|auth_?code|ticket)/i

const DEFAULT_TTL_MS = 10 * 60_000
const DEFAULT_POLL_INTERVAL_MS = 2000
const MIN_POLL_INTERVAL_MS = 500
const MAX_POLL_INTERVAL_MS = 60_000
const DEFAULT_MAX_SESSIONS = 50

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/**
 * 统一认证阶段化错误对象。
 */
export class AuthError extends Error {
  constructor({
    code = 'auth-failed',
    stage = 'auth.begin',
    message = '认证失败',
    retryable = false,
    platform = '',
    cause,
  } = {}) {
    super(String(message || '认证失败'), cause !== undefined ? { cause } : undefined)
    this.name = 'AuthError'
    this.code = String(code || 'auth-failed')
    this.stage = AUTH_ERROR_STAGE_SET.has(stage) ? stage : 'auth.begin'
    this.retryable = Boolean(retryable)
    this.platform = String(platform || '').trim()
  }

  toDetail(redactFn = globalRedact) {
    const clean = typeof redactFn === 'function' ? redactFn : globalRedact
    return {
      code: this.code,
      stage: this.stage,
      message: String(clean(this.message || '认证失败')),
      retryable: Boolean(this.retryable),
      ...(this.platform ? { platform: this.platform } : {}),
    }
  }
}

function makeRedactor(baseRedact, extraSecrets) {
  const fn = typeof baseRedact === 'function' ? baseRedact : globalRedact
  return (text) => {
    let out = String(text ?? '')
    if (!out) return ''
    if (extraSecrets && extraSecrets.size > 0) {
      const sorted = [...extraSecrets].filter((s) => typeof s === 'string' && s.length >= 4).sort((a, b) => b.length - a.length)
      for (const secret of sorted) {
        if (out.includes(secret)) out = out.split(secret).join('[redacted]')
      }
    }
    return String(fn(out))
  }
}

function collectDriverSessionSecrets(obj, out, extraKeys = null, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return
  for (const [key, val] of Object.entries(obj)) {
    if (PROTOTYPE_POLLUTION_KEYS.has(key)) continue
    const markedSensitive = extraKeys instanceof Set && extraKeys.has(key)
    if (typeof val === 'string' && (markedSensitive || DRIVER_SESSION_SECRET_KEY_RE.test(key)) && val.length >= 4) {
      out.add(val)
    } else if (val && typeof val === 'object' && !Array.isArray(val)) {
      collectDriverSessionSecrets(val, out, extraKeys, depth + 1)
    }
  }
}

function sanitizeHttpUrl(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  let u
  try { u = new URL(s) } catch { return '' }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return ''
  return s
}

function sanitizeMetaValue(val, redactFn, depth = 0) {
  if (depth > 4) return undefined
  if (val === null || val === undefined) return undefined
  if (typeof val === 'string') return redactFn(val)
  if (typeof val === 'number' || typeof val === 'boolean') return val
  if (Array.isArray(val)) {
    return val.map((item) => sanitizeMetaValue(item, redactFn, depth + 1)).filter((item) => item !== undefined)
  }
  if (isPlainObject(val)) {
    const out = {}
    for (const [k, v] of Object.entries(val)) {
      if (PROTOTYPE_POLLUTION_KEYS.has(k)) continue
      if (PLATFORM_SECRET_KEY_SET.has(k) || FORBIDDEN_SECRET_NAME_RE.test(k) || TRANSIENT_AUTH_CONFIG_KEYS.has(k)) continue
      const cleanVal = sanitizeMetaValue(v, redactFn, depth + 1)
      if (cleanVal !== undefined) out[k] = cleanVal
    }
    return out
  }
  return undefined
}

function sanitizeMeta(meta, redactFn) {
  if (!isPlainObject(meta)) return undefined
  const clean = sanitizeMetaValue(meta, redactFn, 0)
  if (!clean || !Object.keys(clean).length) return undefined
  return clean
}

function normalizeAuthError(error, {
  code = 'auth-failed',
  stage = 'auth.poll',
  retryable = false,
  platform = '',
  redactFn = globalRedact,
} = {}) {
  if (error instanceof AuthError) {
    return new AuthError({
      code: error.code,
      stage: error.stage,
      message: redactFn(error.message || '认证失败'),
      retryable: error.retryable,
      platform: error.platform || platform,
      cause: error,
    })
  }
  const errStage = AUTH_ERROR_STAGE_SET.has(error?.stage) ? error.stage : stage
  const errCode = String(error?.code || code || 'auth-failed')
  const errRetryable = typeof error?.retryable === 'boolean' ? error.retryable : Boolean(retryable)
  const rawMessage = error?.message || String(error || '认证失败')
  return new AuthError({
    code: errCode,
    stage: errStage,
    message: redactFn(rawMessage),
    retryable: errRetryable,
    platform: error?.platform || platform,
    cause: error,
  })
}

function clampPollInterval(val, minMs, maxMs, fallbackMs) {
  const n = Number(val)
  if (!Number.isFinite(n) || n <= 0) return fallbackMs
  return Math.max(minMs, Math.min(maxMs, Math.trunc(n)))
}

/**
 * 过滤并投影对前端/日志可见的 AuthSessionView（严格白名单，绝不泄漏凭证与内部驱动会话）。
 */
export function sanitizeAuthSessionView(session, redactFn = globalRedact) {
  if (!session || typeof session !== 'object') return null
  const clean = typeof redactFn === 'function' ? redactFn : globalRedact
  const state = AUTH_STATES.includes(session.state) ? session.state : 'error'
  const showDisplay = DISPLAY_QR_AUTH_STATES.has(state)

  const view = {
    sessionId: String(session.sessionId || ''),
    platform: String(session.platform || ''),
    instance: String(session.instance || ''),
    method: String(session.method || ''),
    state,
    expiresAt: Number(session.expiresAt || 0),
    pollIntervalMs: Number(session.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS),
    message: clean(String(session.message || '')),
  }

  if (showDisplay) {
    if (session.qrDataUri && isSafeQrImageDataUri(session.qrDataUri)) {
      view.qrDataUri = session.qrDataUri
    }
    if (session.verificationUrl) {
      const safeUrl = sanitizeHttpUrl(session.verificationUrl)
      if (safeUrl) view.verificationUrl = safeUrl
    }
    if (session.userCode) {
      view.userCode = String(session.userCode)
    }
  }

  if (session.domain) view.domain = clean(String(session.domain))
  if (typeof session.scanned === 'boolean') view.scanned = session.scanned

  if (session.self && typeof session.self === 'object' && session.self.account !== undefined) {
    const account = clean(String(session.self.account || '').trim())
    if (account) {
      view.self = {
        account,
        ...(session.self.name ? { name: clean(String(session.self.name)) } : {}),
      }
    }
  }

  if (session.error && typeof session.error === 'object') {
    const stage = AUTH_ERROR_STAGE_SET.has(session.error.stage) ? session.error.stage : 'auth.poll'
    view.error = {
      code: String(session.error.code || 'auth-failed'),
      stage,
      message: clean(String(session.error.message || '认证失败')),
      retryable: Boolean(session.error.retryable),
      ...(session.error.platform || view.platform ? { platform: String(session.error.platform || view.platform) } : {}),
    }
  }

  const cleanMeta = sanitizeMeta(session.meta, clean)
  if (cleanMeta) view.meta = cleanMeta

  return view
}

function resolveQrFromDriverResult(res, platform) {
  if (res.qrContent !== undefined && res.qrContent !== null && String(res.qrContent).trim() !== '') {
    try {
      return renderQrDataUri(res.qrContent)
    } catch (error) {
      throw new AuthError({
        code: 'qr-encode-failed',
        stage: 'auth.qr.encode',
        message: `本地生成二维码失败：${error?.message || error}`,
        retryable: true,
        platform,
        cause: error,
      })
    }
  }
  if (res.qrDataUri !== undefined && res.qrDataUri !== null && String(res.qrDataUri).trim() !== '') {
    const uri = String(res.qrDataUri).trim()
    if (!isSafeQrImageDataUri(uri)) {
      throw new AuthError({
        code: 'qr-encode-failed',
        stage: 'auth.qr.encode',
        message: '平台返回的二维码图片格式不安全或不受支持',
        retryable: true,
        platform,
      })
    }
    return uri.replace(/\s+/g, '')
  }
  return ''
}

function validateAndSanitizeCompletion(completion, driver, platform, redactFn) {
  if (!isPlainObject(completion)) {
    throw new AuthError({
      code: 'invalid-auth-completion',
      stage: 'auth.save',
      message: '认证驱动返回了无效的完成结果',
      retryable: false,
      platform,
    })
  }
  const rawConfigPatch = completion.configPatch ?? {}
  const rawSecretPatch = completion.secretPatch ?? {}
  if (!isPlainObject(rawConfigPatch)) {
    throw new AuthError({
      code: 'invalid-config-patch',
      stage: 'auth.save',
      message: 'configPatch 必须是普通对象',
      retryable: false,
      platform,
    })
  }
  if (!isPlainObject(rawSecretPatch)) {
    throw new AuthError({
      code: 'invalid-secret-patch',
      stage: 'auth.save',
      message: 'secretPatch 必须是普通对象',
      retryable: false,
      platform,
    })
  }

  const allowedConfigSet = Array.isArray(driver?.allowedConfigKeys) && driver.allowedConfigKeys.length
    ? new Set(driver.allowedConfigKeys.map((k) => String(k)))
    : null

  const configPatch = {}
  for (const [key, val] of Object.entries(rawConfigPatch)) {
    if (PROTOTYPE_POLLUTION_KEYS.has(key)) {
      throw new AuthError({
        code: 'invalid-config-patch',
        stage: 'auth.save',
        message: `configPatch 包含非法键：${key}`,
        retryable: false,
        platform,
      })
    }
    if (TRANSIENT_AUTH_CONFIG_KEYS.has(key)) {
      throw new AuthError({
        code: 'invalid-config-patch',
        stage: 'auth.save',
        message: `禁止将临时认证字段 ${key} 写入配置`,
        retryable: false,
        platform,
      })
    }
    if (PLATFORM_SECRET_KEY_SET.has(key) || FORBIDDEN_SECRET_NAME_RE.test(key)) {
      throw new AuthError({
        code: 'invalid-config-patch',
        stage: 'auth.save',
        message: `敏感字段 ${key} 必须通过 secretPatch 提交，禁止写入 configPatch`,
        retryable: false,
        platform,
      })
    }
    if (allowedConfigSet && !allowedConfigSet.has(key)) {
      throw new AuthError({
        code: 'invalid-config-patch',
        stage: 'auth.save',
        message: `configPatch 包含未允许的配置键：${key}`,
        retryable: false,
        platform,
      })
    }
    configPatch[key] = val
  }

  const secretPatch = {}
  for (const [key, val] of Object.entries(rawSecretPatch)) {
    if (PROTOTYPE_POLLUTION_KEYS.has(key) || !PLATFORM_SECRET_KEY_SET.has(key)) {
      throw new AuthError({
        code: 'invalid-secret-patch',
        stage: 'auth.save',
        message: `secretPatch 包含未登记在白名单中的键：${key}`,
        retryable: false,
        platform,
      })
    }
    if (typeof val !== 'string') {
      throw new AuthError({
        code: 'invalid-secret-patch',
        stage: 'auth.save',
        message: `secretPatch.${key} 必须为字符串`,
        retryable: false,
        platform,
      })
    }
    secretPatch[key] = val
  }

  let self
  if (completion.self !== undefined) {
    if (!isPlainObject(completion.self) || !String(completion.self.account || '').trim()) {
      throw new AuthError({
        code: 'invalid-auth-completion',
        stage: 'auth.verify',
        message: '认证返回的账号标识无效',
        retryable: false,
        platform,
      })
    }
    self = {
      account: String(completion.self.account).trim(),
      ...(completion.self.name ? { name: String(completion.self.name).trim() } : {}),
    }
  }

  const meta = sanitizeMeta(completion.meta, redactFn)
  return { configPatch, secretPatch, self, meta }
}

/**
 * 创建跨平台通用认证会话管理器。
 */
export function createPlatformAuthManager({
  getInstanceConfig = () => ({}),
  applyCompletion = async () => {},
  syncInstance = async () => {},
  verifyInstance = async ({ expectedSelf }) => ({ ok: true, self: expectedSelf }),
  registerSecret = () => {},
  redact = globalRedact,
  now = () => Date.now(),
  log = console,
  defaultTtlMs = DEFAULT_TTL_MS,
  defaultPollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  minPollIntervalMs = MIN_POLL_INTERVAL_MS,
  maxPollIntervalMs = MAX_POLL_INTERVAL_MS,
  maxSessions = DEFAULT_MAX_SESSIONS,
} = {}) {
  const drivers = new Map() // platform -> driver
  const sessions = new Map() // sessionId -> session record
  const activeBySlot = new Map() // `${instance}\0${method}` -> sessionId

  function sessionRedact(session) {
    return makeRedactor(redact, session?.secretValues)
  }

  function clearDisplayAndDriverFields(session) {
    session.qrDataUri = ''
    session.verificationUrl = ''
    session.userCode = ''
    session.driverSession = null
  }

  function releaseSlot(session) {
    if (!session?.slotKey) return
    if (activeBySlot.get(session.slotKey) === session.sessionId) {
      activeBySlot.delete(session.slotKey)
    }
  }

  function pruneSessions() {
    if (sessions.size < maxSessions) return
    const t = now()
    for (const [sid, s] of sessions) {
      if (TERMINAL_AUTH_STATES.has(s.state) || (s.expiresAt && t >= s.expiresAt && !s.inFlightPoll)) {
        if (activeBySlot.get(s.slotKey) !== sid) sessions.delete(sid)
        if (sessions.size < maxSessions) return
      }
    }
    while (sessions.size >= maxSessions) {
      const oldestKey = sessions.keys().next().value
      if (!oldestKey) break
      const oldest = sessions.get(oldestKey)
      if (oldest && !TERMINAL_AUTH_STATES.has(oldest.state)) {
        try { oldest.controller?.abort?.() } catch {}
        releaseSlot(oldest)
      }
      sessions.delete(oldestKey)
    }
  }

  function validateDriver(driver) {
    if (!driver || typeof driver !== 'object') throw new TypeError('auth driver 必须是对象')
    const platform = String(driver.platform || '').trim()
    if (!platform || !/^[a-z][a-z0-9-]*$/.test(platform)) {
      throw new TypeError(`非法认证驱动平台名：${driver.platform}`)
    }
    if (!Array.isArray(driver.methods) || !driver.methods.length) {
      throw new TypeError(`认证驱动 ${platform} 至少声明一个 method`)
    }
    for (const desc of driver.methods) {
      if (!desc || !AUTH_METHOD_SET.has(desc.method)) {
        throw new TypeError(`认证驱动 ${platform} 包含未知认证方式：${desc?.method}`)
      }
    }
    if (typeof driver.start !== 'function' || typeof driver.poll !== 'function') {
      throw new TypeError(`认证驱动 ${platform} 必须实现 start 与 poll 方法`)
    }
    return platform
  }

  function register(driver) {
    const platform = validateDriver(driver)
    drivers.set(platform, driver)
    return () => {
      if (drivers.get(platform) === driver) drivers.delete(platform)
    }
  }

  function methodsFor(platform) {
    const p = String(platform || '').trim()
    const driver = drivers.get(p)
    if (!driver) return []
    return driver.methods.map((m) => ({
      ...m,
      platform: p,
    }))
  }

  function listMethods() {
    const out = []
    for (const platform of drivers.keys()) {
      for (const m of methodsFor(platform)) out.push(m)
    }
    return out
  }

  async function terminateSession(session, targetState, { reason = '', errorDetail = null, message = '' } = {}) {
    if (!session) return null
    const wasTerminal = TERMINAL_AUTH_STATES.has(session.state)
    const driver = drivers.get(session.platform)
    const driverSessionSnapshot = isPlainObject(session.driverSession) ? { ...session.driverSession } : null

    try { session.controller?.abort?.(reason || targetState) } catch {}
    releaseSlot(session)
    clearDisplayAndDriverFields(session)

    if (!wasTerminal) {
      session.state = targetState
      if (errorDetail) session.error = errorDetail
      if (message) session.message = message
      if (!wasTerminal && driver && typeof driver.cancel === 'function' && driverSessionSnapshot) {
        try {
          await driver.cancel({
            instance: session.instance,
            method: session.method,
            driverSession: driverSessionSnapshot,
            reason: reason || targetState,
          })
        } catch (cancelErr) {
          log?.debug?.('取消认证会话回调失败：', makeRedactor(redact, session.secretValues)(cancelErr?.message || cancelErr))
        }
      }
    }
    return sanitizeAuthSessionView(session, sessionRedact(session))
  }

  async function safeCancelRawDriverSession(driver, { instance, method, driverSession, reason }) {
    if (!driver || typeof driver.cancel !== 'function' || !isPlainObject(driverSession)) return
    try {
      await driver.cancel({ instance, method, driverSession: { ...driverSession }, reason })
    } catch {}
  }

  async function start({ platform, instance, method, params = {} } = {}) {
    const plat = String(platform || '').trim()
    const m = String(method || '').trim()
    if (!plat) {
      throw new AuthError({ code: 'auth-unsupported', stage: 'auth.begin', message: '缺少 platform 参数', retryable: false })
    }
    const driver = drivers.get(plat)
    if (!driver) {
      throw new AuthError({
        code: 'auth-unsupported',
        stage: 'auth.begin',
        message: `平台 ${plat} 未注册认证驱动`,
        retryable: false,
        platform: plat,
      })
    }
    const methodDesc = driver.methods.find((x) => x.method === m)
    if (!methodDesc || !AUTH_METHOD_SET.has(m)) {
      throw new AuthError({
        code: 'auth-unsupported',
        stage: 'auth.begin',
        message: `平台 ${plat} 不支持认证方式 ${m || '(空)'}`,
        retryable: false,
        platform: plat,
      })
    }

    const inst = String(instance || plat).trim() || plat
    const instPrefix = inst.split('#')[0]
    if (!INSTANCE_RE.test(inst) || instPrefix !== plat) {
      throw new AuthError({
        code: 'invalid-instance',
        stage: 'auth.begin',
        message: `实例名必须为 ${plat} 或 ${plat}#<别名>`,
        retryable: false,
        platform: plat,
      })
    }
    if (typeof driver.validateInstance === 'function' && !driver.validateInstance(inst)) {
      throw new AuthError({
        code: 'invalid-instance',
        stage: 'auth.begin',
        message: `实例名 ${inst} 未通过平台 ${plat} 校验`,
        retryable: false,
        platform: plat,
      })
    }

    const slotKey = `${inst}\0${m}`
    const prevSid = activeBySlot.get(slotKey)
    if (prevSid && sessions.has(prevSid)) {
      await terminateSession(sessions.get(prevSid), 'cancelled', {
        reason: 'replaced',
        message: '已发起新的认证会话，旧会话已取消',
      })
    }

    pruneSessions()
    const createdAt = now()
    const ttlMs = clampPollInterval(methodDesc.defaultTtlMs, 5_000, 30 * 60_000, defaultTtlMs)
    const pollIntervalMs = clampPollInterval(methodDesc.defaultPollIntervalMs, minPollIntervalMs, maxPollIntervalMs, defaultPollIntervalMs)
    const sessionId = randomUUID()
    const controller = new AbortController()
    const session = {
      sessionId,
      slotKey,
      platform: plat,
      instance: inst,
      method: m,
      state: 'starting',
      createdAt,
      expiresAt: createdAt + ttlMs,
      pollIntervalMs,
      nextPollAt: 0,
      qrDataUri: '',
      verificationUrl: '',
      userCode: '',
      domain: '',
      scanned: undefined,
      message: '正在创建认证会话…',
      self: undefined,
      error: undefined,
      meta: undefined,
      driverSession: null,
      controller,
      secretValues: new Set(),
      inFlightPoll: null,
    }
    sessions.set(sessionId, session)
    activeBySlot.set(slotKey, sessionId)

    let currentConfig = {}
    try {
      const cfg = getInstanceConfig(inst)
      if (isPlainObject(cfg)) currentConfig = cfg
    } catch {}

    let startRes
    try {
      startRes = await driver.start({
        instance: inst,
        method: m,
        params: isPlainObject(params) ? { ...params } : {},
        currentConfig: { ...currentConfig },
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted || session.state === 'cancelled') {
        releaseSlot(session)
        throw new AuthError({
          code: 'auth-cancelled',
          stage: 'auth.cancel',
          message: '认证启动已被新请求或取消操作中断',
          retryable: true,
          platform: plat,
          cause: error,
        })
      }
      const authErr = normalizeAuthError(error, {
        code: 'auth-start-failed',
        stage: 'auth.begin',
        retryable: true,
        platform: plat,
        redactFn: sessionRedact(session),
      })
      session.state = 'error'
      session.error = authErr.toDetail(sessionRedact(session))
      session.message = authErr.message
      releaseSlot(session)
      clearDisplayAndDriverFields(session)
      throw authErr
    }

    if (controller.signal.aborted || session.state === 'cancelled' || activeBySlot.get(slotKey) !== sessionId) {
      if (isPlainObject(startRes?.driverSession)) {
        await safeCancelRawDriverSession(driver, {
          instance: inst,
          method: m,
          driverSession: startRes.driverSession,
          reason: 'superseded',
        })
      }
      releaseSlot(session)
      throw new AuthError({
        code: 'auth-cancelled',
        stage: 'auth.cancel',
        message: '认证启动已被替代或取消',
        retryable: true,
        platform: plat,
      })
    }

    if (!startRes || !isPlainObject(startRes.driverSession)) {
      const authErr = new AuthError({
        code: 'invalid-driver-session',
        stage: 'auth.begin',
        message: '认证驱动 start 必须返回有效的 driverSession',
        retryable: false,
        platform: plat,
      })
      session.state = 'error'
      session.error = authErr.toDetail(sessionRedact(session))
      session.message = authErr.message
      releaseSlot(session)
      clearDisplayAndDriverFields(session)
      throw authErr
    }

    session.driverSession = { ...startRes.driverSession }
    const sensitiveKeys = Array.isArray(driver.sensitiveDriverSessionKeys)
      ? new Set(driver.sensitiveDriverSessionKeys.map((k) => String(k)))
      : null
    collectDriverSessionSecrets(session.driverSession, session.secretValues, sensitiveKeys)
    const redactFn = sessionRedact(session)

    let qrDataUri = ''
    try {
      qrDataUri = resolveQrFromDriverResult(startRes, plat)
    } catch (qrErr) {
      const authErr = normalizeAuthError(qrErr, {
        code: 'qr-encode-failed',
        stage: 'auth.qr.encode',
        retryable: true,
        platform: plat,
        redactFn,
      })
      await terminateSession(session, 'error', {
        reason: 'qr-encode-failed',
        errorDetail: authErr.toDetail(redactFn),
        message: authErr.message,
      })
      throw authErr
    }

    const verificationUrl = startRes.verificationUrl ? sanitizeHttpUrl(startRes.verificationUrl) : ''
    if (startRes.verificationUrl && !verificationUrl) {
      const authErr = new AuthError({
        code: 'invalid-verification-url',
        stage: 'auth.begin',
        message: '认证驱动返回了不安全的授权链接',
        retryable: false,
        platform: plat,
      })
      await terminateSession(session, 'error', {
        reason: 'invalid-verification-url',
        errorDetail: authErr.toDetail(redactFn),
        message: authErr.message,
      })
      throw authErr
    }

    let nextState = startRes.state
    if (!['qr_ready', 'device_code_ready', 'polling'].includes(nextState)) {
      if (qrDataUri) nextState = 'qr_ready'
      else if (startRes.userCode || verificationUrl) nextState = 'device_code_ready'
      else nextState = 'polling'
    }

    session.state = nextState
    session.qrDataUri = qrDataUri
    session.verificationUrl = verificationUrl
    session.userCode = startRes.userCode ? String(startRes.userCode).trim() : ''
    session.domain = startRes.domain ? redactFn(String(startRes.domain).trim()) : ''
    session.pollIntervalMs = clampPollInterval(startRes.pollIntervalMs, minPollIntervalMs, maxPollIntervalMs, pollIntervalMs)
    if (Number.isFinite(Number(startRes.expiresAt)) && Number(startRes.expiresAt) > createdAt) {
      session.expiresAt = Number(startRes.expiresAt)
    } else if (Number.isFinite(Number(startRes.expiresInMs)) && Number(startRes.expiresInMs) > 0) {
      session.expiresAt = createdAt + Number(startRes.expiresInMs)
    }
    session.message = redactFn(startRes.message || (
      nextState === 'device_code_ready'
        ? '请在浏览器打开授权链接并输入验证码完成授权'
        : '请使用手机扫描二维码并确认授权'
    ))
    session.meta = sanitizeMeta(startRes.meta, redactFn)

    return sanitizeAuthSessionView(session, redactFn)
  }

  async function executePoll(session) {
    const redactFn = sessionRedact(session)
    if (TERMINAL_AUTH_STATES.has(session.state)) {
      return sanitizeAuthSessionView(session, redactFn)
    }

    const currentTime = now()
    if (currentTime >= session.expiresAt) {
      const expireErr = new AuthError({
        code: 'auth-expired',
        stage: 'auth.qr.expire',
        message: '认证会话已过期，请重新开始',
        retryable: true,
        platform: session.platform,
      })
      return terminateSession(session, 'expired', {
        reason: 'expired',
        errorDetail: expireErr.toDetail(redactFn),
        message: expireErr.message,
      })
    }

    if (session.state === 'slow_down' && currentTime < session.nextPollAt) {
      return sanitizeAuthSessionView(session, redactFn)
    }

    const driver = drivers.get(session.platform)
    if (!driver) {
      const err = new AuthError({
        code: 'auth-driver-missing',
        stage: 'auth.poll',
        message: `平台 ${session.platform} 认证驱动已卸载`,
        retryable: true,
        platform: session.platform,
      })
      return terminateSession(session, 'error', {
        reason: 'driver-missing',
        errorDetail: err.toDetail(redactFn),
        message: err.message,
      })
    }

    let currentConfig = {}
    try {
      const cfg = getInstanceConfig(session.instance)
      if (isPlainObject(cfg)) currentConfig = cfg
    } catch {}

    let pollRes
    try {
      pollRes = await driver.poll({
        instance: session.instance,
        method: session.method,
        driverSession: session.driverSession ? { ...session.driverSession } : {},
        currentConfig: { ...currentConfig },
        signal: session.controller.signal,
      })
    } catch (error) {
      if (session.controller.signal.aborted || session.state === 'cancelled') {
        return sanitizeAuthSessionView(session, redactFn)
      }
      const authErr = normalizeAuthError(error, {
        code: 'auth-poll-failed',
        stage: 'auth.poll',
        retryable: false,
        platform: session.platform,
        redactFn,
      })
      return terminateSession(session, 'error', {
        reason: 'poll-error',
        errorDetail: authErr.toDetail(redactFn),
        message: authErr.message,
      })
    }

    if (session.controller.signal.aborted || session.state === 'cancelled') {
      return sanitizeAuthSessionView(session, redactFn)
    }

    if (pollRes && isPlainObject(pollRes.driverSession)) {
      session.driverSession = { ...pollRes.driverSession }
      const sensitiveKeys = Array.isArray(driver.sensitiveDriverSessionKeys)
        ? new Set(driver.sensitiveDriverSessionKeys.map((k) => String(k)))
        : null
      collectDriverSessionSecrets(session.driverSession, session.secretValues, sensitiveKeys)
    }

    const refreshedRedact = sessionRedact(session)
    const afterTime = now()
    if (afterTime >= session.expiresAt && pollRes?.state !== 'authorized') {
      const expireErr = new AuthError({
        code: 'auth-expired',
        stage: 'auth.qr.expire',
        message: '认证会话已过期，请重新开始',
        retryable: true,
        platform: session.platform,
      })
      return terminateSession(session, 'expired', {
        reason: 'expired',
        errorDetail: expireErr.toDetail(refreshedRedact),
        message: expireErr.message,
      })
    }

    const nextState = pollRes?.state
    if (nextState === 'expired') {
      const expireErr = new AuthError({
        code: 'auth-expired',
        stage: 'auth.qr.expire',
        message: pollRes.message || '二维码已过期，请重新生成',
        retryable: true,
        platform: session.platform,
      })
      return terminateSession(session, 'expired', {
        reason: 'expired',
        errorDetail: expireErr.toDetail(refreshedRedact),
        message: expireErr.message,
      })
    }

    if (nextState === 'cancelled') {
      return terminateSession(session, 'cancelled', {
        reason: 'cancelled-by-platform',
        message: pollRes.message || '认证已取消',
      })
    }

    if (nextState === 'slow_down') {
      const backedOff = Math.min(maxPollIntervalMs, Math.max(session.pollIntervalMs + 5000, session.pollIntervalMs * 2))
      session.pollIntervalMs = pollRes.pollIntervalMs !== undefined
        ? Math.max(session.pollIntervalMs, clampPollInterval(pollRes.pollIntervalMs, minPollIntervalMs, maxPollIntervalMs, backedOff))
        : backedOff
      session.nextPollAt = afterTime + session.pollIntervalMs
      session.state = 'slow_down'
      session.error = undefined
      if (typeof pollRes.scanned === 'boolean') session.scanned = pollRes.scanned
      session.message = refreshedRedact(pollRes.message || `平台要求放慢轮询频率，${Math.ceil(session.pollIntervalMs / 1000)} 秒后重试`)
      if (pollRes.meta !== undefined) session.meta = sanitizeMeta(pollRes.meta, refreshedRedact)
      return sanitizeAuthSessionView(session, refreshedRedact)
    }

    if (nextState === 'domain_switched' || nextState === 'polling') {
      let updatedQr = ''
      if (pollRes.qrContent !== undefined || pollRes.qrDataUri !== undefined) {
        try {
          updatedQr = resolveQrFromDriverResult(pollRes, session.platform)
        } catch (qrErr) {
          const authErr = normalizeAuthError(qrErr, {
            code: 'qr-encode-failed',
            stage: 'auth.qr.encode',
            retryable: true,
            platform: session.platform,
            redactFn: refreshedRedact,
          })
          return terminateSession(session, 'error', {
            reason: 'qr-encode-failed',
            errorDetail: authErr.toDetail(refreshedRedact),
            message: authErr.message,
          })
        }
      }
      if (pollRes.verificationUrl !== undefined) {
        const safeUrl = pollRes.verificationUrl ? sanitizeHttpUrl(pollRes.verificationUrl) : ''
        if (pollRes.verificationUrl && !safeUrl) {
          const err = new AuthError({
            code: 'invalid-verification-url',
            stage: 'auth.poll',
            message: '平台返回了不安全的授权链接',
            retryable: false,
            platform: session.platform,
          })
          return terminateSession(session, 'error', {
            reason: 'invalid-verification-url',
            errorDetail: err.toDetail(refreshedRedact),
            message: err.message,
          })
        }
        session.verificationUrl = safeUrl
      }
      if (updatedQr) session.qrDataUri = updatedQr
      if (pollRes.userCode !== undefined) session.userCode = String(pollRes.userCode || '').trim()
      if (pollRes.domain !== undefined) session.domain = refreshedRedact(String(pollRes.domain || '').trim())
      if (Number.isFinite(Number(pollRes.expiresAt)) && Number(pollRes.expiresAt) > afterTime) {
        session.expiresAt = Number(pollRes.expiresAt)
      } else if (Number.isFinite(Number(pollRes.expiresInMs)) && Number(pollRes.expiresInMs) > 0) {
        session.expiresAt = afterTime + Number(pollRes.expiresInMs)
      }
      if (pollRes.pollIntervalMs !== undefined) {
        session.pollIntervalMs = clampPollInterval(pollRes.pollIntervalMs, minPollIntervalMs, maxPollIntervalMs, session.pollIntervalMs)
      }
      session.nextPollAt = 0
      session.state = nextState === 'domain_switched'
        ? 'domain_switched'
        : ((session.qrDataUri || session.verificationUrl || session.userCode) ? 'polling' : session.state)
      if (typeof pollRes.scanned === 'boolean') session.scanned = pollRes.scanned
      if (pollRes.message) session.message = refreshedRedact(pollRes.message)
      if (pollRes.meta !== undefined) session.meta = sanitizeMeta(pollRes.meta, refreshedRedact)
      return sanitizeAuthSessionView(session, refreshedRedact)
    }

    if (nextState === 'authorized') {
      let validated
      try {
        validated = validateAndSanitizeCompletion(pollRes.completion, driver, session.platform, refreshedRedact)
      } catch (valErr) {
        const authErr = normalizeAuthError(valErr, {
          code: 'invalid-auth-completion',
          stage: 'auth.save',
          retryable: false,
          platform: session.platform,
          redactFn: refreshedRedact,
        })
        return terminateSession(session, 'error', {
          reason: 'invalid-completion',
          errorDetail: authErr.toDetail(refreshedRedact),
          message: authErr.message,
        })
      }

      for (const secretVal of Object.values(validated.secretPatch)) {
        if (secretVal) {
          session.secretValues.add(secretVal)
          try { registerSecret(secretVal) } catch {}
        }
      }
      const postSecretRedact = sessionRedact(session)

      if (session.controller.signal.aborted || session.state === 'cancelled') {
        return sanitizeAuthSessionView(session, postSecretRedact)
      }

      session.state = 'saving'
      session.qrDataUri = ''
      session.verificationUrl = ''
      session.userCode = ''
      session.message = '正在保存凭证并校验连接…'

      try {
        await applyCompletion({
          platform: session.platform,
          instance: session.instance,
          method: session.method,
          configPatch: validated.configPatch,
          secretPatch: validated.secretPatch,
          self: validated.self,
          meta: validated.meta,
          session: sanitizeAuthSessionView(session, postSecretRedact),
        })
      } catch (saveErr) {
        const authErr = normalizeAuthError(saveErr, {
          code: 'auth-save-failed',
          stage: 'auth.save',
          retryable: false,
          platform: session.platform,
          redactFn: postSecretRedact,
        })
        return terminateSession(session, 'error', {
          reason: 'save-failed',
          errorDetail: authErr.toDetail(postSecretRedact),
          message: authErr.message,
        })
      }

      if (session.controller.signal.aborted || session.state === 'cancelled') {
        return sanitizeAuthSessionView(session, postSecretRedact)
      }

      try {
        await syncInstance({
          platform: session.platform,
          instance: session.instance,
          method: session.method,
          self: validated.self,
          session: sanitizeAuthSessionView(session, postSecretRedact),
        })
      } catch (connErr) {
        const authErr = normalizeAuthError(connErr, {
          code: 'auth-connect-failed',
          stage: 'auth.connect',
          retryable: true,
          platform: session.platform,
          redactFn: postSecretRedact,
        })
        return terminateSession(session, 'error', {
          reason: 'connect-failed',
          errorDetail: authErr.toDetail(postSecretRedact),
          message: authErr.message,
        })
      }

      let verifiedResult
      try {
        verifiedResult = await verifyInstance({
          platform: session.platform,
          instance: session.instance,
          method: session.method,
          expectedSelf: validated.self,
          session: sanitizeAuthSessionView(session, postSecretRedact),
        })
      } catch (verErr) {
        const authErr = normalizeAuthError(verErr, {
          code: 'auth-verify-failed',
          stage: 'auth.verify',
          retryable: true,
          platform: session.platform,
          redactFn: postSecretRedact,
        })
        return terminateSession(session, 'error', {
          reason: 'verify-failed',
          errorDetail: authErr.toDetail(postSecretRedact),
          message: authErr.message,
        })
      }

      if (verifiedResult && verifiedResult.ok === false) {
        const authErr = new AuthError({
          code: verifiedResult.code || 'whoami-mismatch',
          stage: 'auth.verify',
          message: postSecretRedact(verifiedResult.message || '账号身份核验未通过'),
          retryable: verifiedResult.retryable !== undefined ? Boolean(verifiedResult.retryable) : true,
          platform: session.platform,
        })
        return terminateSession(session, 'error', {
          reason: 'verify-failed',
          errorDetail: authErr.toDetail(postSecretRedact),
          message: authErr.message,
        })
      }

      if (session.controller.signal.aborted || session.state === 'cancelled') {
        return sanitizeAuthSessionView(session, postSecretRedact)
      }

      const verifiedSelf = (verifiedResult && isPlainObject(verifiedResult.self) && verifiedResult.self.account)
        ? verifiedResult.self
        : validated.self
      session.self = verifiedSelf
      session.meta = sanitizeMeta(validated.meta, postSecretRedact)
      session.state = 'succeeded'
      session.error = undefined
      session.message = postSecretRedact(pollRes.message || '认证成功，已保存凭证并启动连接')
      releaseSlot(session)
      clearDisplayAndDriverFields(session)
      return sanitizeAuthSessionView(session, postSecretRedact)
    }

    const unexpectedErr = new AuthError({
      code: 'invalid-poll-state',
      stage: 'auth.poll',
      message: `认证驱动返回了无效状态：${String(nextState)}`,
      retryable: false,
      platform: session.platform,
    })
    return terminateSession(session, 'error', {
      reason: 'invalid-poll-state',
      errorDetail: unexpectedErr.toDetail(refreshedRedact),
      message: unexpectedErr.message,
    })
  }

  async function poll({ sessionId } = {}) {
    const sid = String(sessionId || '').trim()
    const session = sid ? sessions.get(sid) : null
    if (!session) {
      throw new AuthError({
        code: 'session-not-found',
        stage: 'auth.qr.expire',
        message: '认证会话不存在或已过期，请重新生成',
        retryable: true,
      })
    }
    if (session.inFlightPoll) return session.inFlightPoll
    session.inFlightPoll = executePoll(session).finally(() => {
      session.inFlightPoll = null
    })
    return session.inFlightPoll
  }

  async function cancel({ sessionId, reason = 'cancelled' } = {}) {
    const sid = String(sessionId || '').trim()
    const session = sid ? sessions.get(sid) : null
    if (!session) {
      return {
        sessionId: sid,
        platform: '',
        instance: '',
        method: '',
        state: 'cancelled',
        expiresAt: 0,
        pollIntervalMs: defaultPollIntervalMs,
        message: '认证会话已关闭',
      }
    }
    return terminateSession(session, 'cancelled', {
      reason: String(reason || 'cancelled'),
      message: '已取消本次认证',
    })
  }

  function getSession(sessionId) {
    const sid = String(sessionId || '').trim()
    const session = sid ? sessions.get(sid) : null
    return session ? sanitizeAuthSessionView(session, sessionRedact(session)) : null
  }

  async function dispose() {
    const active = [...sessions.values()]
    for (const s of active) {
      if (!TERMINAL_AUTH_STATES.has(s.state)) {
        await terminateSession(s, 'cancelled', {
          reason: 'disposed',
          message: '宿主已停止，认证会话关闭',
        })
      } else {
        clearDisplayAndDriverFields(s)
      }
    }
    activeBySlot.clear()
    sessions.clear()
  }

  return {
    register,
    methodsFor,
    listMethods,
    start,
    poll,
    cancel,
    getSession,
    dispose,
  }
}
