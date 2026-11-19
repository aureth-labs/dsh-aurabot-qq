// QQ 平台端（G2 产出）—— Aurabot 多平台的第二个平台端，id='qq'。
//
// 作用：把「怎么和 OneBot v11 网关说话」收进一个符合 PlatformAdapter 契约的平台端。
//   - 入站：OneBot 事件 → AdapterInbound / AdapterEvent（见 inbound.js）
//   - 出站：parts → OneBot 消息段 / upload_* / send_poke（见 outbound.js）
//   - 能力探测：连上后挨个问扩展动作，得出 caps 并缓存（见 probe.js，本包的核心）
//   - native：扩展动作透传（见 native.js）
//   - SnowLuma 管理：可选的「帮你启停本机网关」（见 snowluma.js，仅 Windows + 配了目录）
//   - 失败分类：transport → not-sent，uncertain → unknown（见 errors.js，判定全部复用 onebot/client.js）
//
// 契约：src/gateway/contracts.d.ts（PlatformAdapter / Caps / Part / SendError.certainty）
//       docs/CONTRACTS.md §六～§九；docs/ADAPTER.md 的六步清单。
// 任务书：Aurabot多平台实施拆分/包-G2-QQ平台端.md。
//
// ── 这一版**不改**任何现有代码 ──
// src/onebot/client.js、src/snowluma/**、src/chat/inbound.js 全部只 import 不修改（G3 切换后再删/搬）。
// 连接层复用 createOneBotClient：连接、重连、HTTP/WS 双通道、超时与 transport/uncertain 分类，
// 一行都没有重写（重写就等于把已经测过的防重复发送地基换成没人测过的）。
//
// ── 测试注入点（真实运行不会用到）──
// createQqAdapter({ client, fs, faceName, faceIdOf, probeTable, managerFactory })
//   都不给时按生产默认：真连 OneBot、真读写 caps.json、不维护表情名表。
//   client 只要求有 { start, stop, call, isConnected, state, restart } —— 就是 createOneBotClient 的返回。

import * as nodeFs from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createOneBotClient, isDefiniteFailure } from '../../onebot/client.js'
import { fromOneBotEvent, toAdapterEvent, segmentsToParts, toParts as partsOf } from './inbound.js'
import { buildParts } from './outbound.js'
import { createNative } from './native.js'
import { makeSendError, toSendError } from './errors.js'
import {
  CAPS_CONSERVATIVE, FILE_MAX_BYTES, cacheMatchesGateway, capsFromProbes, classifyProbeError,
  probeGateway, readCapsCache, supportedActions, writeCapsCache,
} from './probe.js'
import { createSnowlumaSidecar, snowlumaEnabled } from './snowluma.js'

const MAX_LOCAL_MEDIA_BYTES = 50 * 1024 * 1024
const SENSITIVE_MEDIA_NAME_RE = /^(?:outbox|caps|config|settings|webui|onebot|identity|secret|token|credential|auth|cookie|session|keystore|env)(?:[._-]|$)/i
const BLOCKED_MEDIA_EXTS = new Set([
  '.json', '.jsonc', '.json5', '.db', '.sqlite', '.sqlite3', '.wal', '.shm', '.log',
  '.txt', '.md', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.yml', '.yaml',
  '.toml', '.ini', '.env', '.cfg', '.conf', '.bak', '.key', '.pem', '.crt', '.p12',
  '.pfx', '.sh', '.bat', '.cmd', '.ps1', '.exe', '.dll', '.html', '.htm', '.xml',
  '.svg', '.csv',
])
const MAGIC_REQUIRED_MEDIA_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ogg', '.flac', '.wav', '.mp4', '.m4a', '.mov', '.webm', '.mkv',
])
const ALLOWED_MEDIA_EXTS = new Set([
  ...MAGIC_REQUIRED_MEDIA_EXTS,
  '.tiff', '.tif', '.avif', '.heic', '.ico', '.mp3', '.opus', '.amr', '.silk', '.slk', '.aac', '.pcm', '.avi', '.flv', '.m4v',
])
// Tencent Files / QQ 主目录只允许进入明确的缓存子目录，绝不放行账号数据库（nt_db/*.db）与配置文件
const TENCENT_CACHE_SUBDIR_RE = /^(?:\d+[\\/])?(?:nt_qq[\\/]nt_data[\\/](?:Pic|Emoji|Ptt|Video|FileRecv|Cache|Temp)|(?:Image|Audio|Video|Cache|Temp))[\\/]/i

function looksLikeMediaBytes(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 3) return false
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) return true
  if (buf[0] === 0x42 && buf[1] === 0x4d) return true
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF') {
    const tag = buf.subarray(8, 12).toString('ascii')
    if (tag === 'WEBP' || tag === 'WAVE' || tag === 'AVI ') return true
  }
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'OggS') return true
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'fLaC') return true
  if (buf.subarray(0, 3).toString('ascii') === 'ID3') return true
  if (buf[0] === 0xff && (buf[1] === 0xfb || buf[1] === 0xf3 || buf[1] === 0xf2)) return true
  if (buf.length >= 12 && buf.subarray(4, 8).toString('ascii') === 'ftyp') return true
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return true
  if (buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === '#!AMR') return true
  if (buf.length >= 9 && (buf.subarray(0, 10).toString('ascii') === '\x02#!SILK_V3' || buf.subarray(0, 9).toString('ascii') === '#!SILK_V3')) return true
  return false
}

function looksLikeSensitivePayload(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return true
  if (buf.length >= 16 && buf.subarray(0, 16).toString('ascii') === 'SQLite format 3\0') return true
  const s = buf.subarray(0, Math.min(buf.length, 256)).toString('utf8').replace(/^\uFEFF/, '').trimStart()
  return s.startsWith('{') || s.startsWith('[') || s.startsWith('<') || s.startsWith('-----BEGIN ')
}

function isSensitiveMediaPath(filePath) {
  const name = basename(filePath)
  const ext = extname(name).toLowerCase()
  return SENSITIVE_MEDIA_NAME_RE.test(name) || (Boolean(ext) && BLOCKED_MEDIA_EXTS.has(ext))
}

function isAllowedMediaContent(filePath, buf) {
  if (isSensitiveMediaPath(filePath) || looksLikeSensitivePayload(buf)) return false
  const ext = extname(basename(filePath)).toLowerCase()
  if (MAGIC_REQUIRED_MEDIA_EXTS.has(ext)) return looksLikeMediaBytes(buf)
  if (ALLOWED_MEDIA_EXTS.has(ext)) return true
  return looksLikeMediaBytes(buf)
}

function resolveRealDirs(dirs, fsApi) {
  const out = []
  for (const dir of dirs) {
    const s = String(dir || '').trim()
    if (!s) continue
    try {
      const resolved = resolve(s)
      out.push(typeof fsApi.realpathSync === 'function' ? fsApi.realpathSync(resolved) : resolved)
    } catch {}
  }
  return [...new Set(out)]
}

/**
 * 建一个 QQ 平台端实例。
 * @param {object} [options] 见文件头的「测试注入点」
 * @returns {import('../../gateway/contracts.d.ts').PlatformAdapter}
 */
export function createQqAdapter(options = {}) {
  const id = 'qq'
  let instance = id // start 时由 ctx.instance 给（qq#2 这种多实例也能跑）
  let ctx = null
  let running = false
  let connected = false
  let client = options.client || null
  let sidecar = null // SnowLuma 控制器（只有 backend=snowluma 才有）
  let caps = { ...CAPS_CONSERVATIVE, features: { ...CAPS_CONSERVATIVE.features } }
  let probeState = null // { probed, supported:Set, entries, gateway, unsupported, unknown }
  let probeCache = null
  let capsFile = null
  let selfId = '' // 机器人自己的号：@自己 要判定成 mentionedMe
  let probing = false
  let unbindClient = null
  const downgradedUnsupported = new Set()

  const fsImpl = options.fs || null // 测试注入的假 fs（决定 caps.json 走哪）
  const log = () => (ctx?.log || noopLog)

  function controlledMediaPolicy() {
    const cfg = config()
    const fsApi = fsImpl || nodeFs
    const userHome = String(options.homeDir || homedir())
    const snowlumaBase = String(cfg.snowlumaDir ?? cfg.dir ?? '').trim()
    const snowlumaSubs = snowlumaBase
      ? [join(snowlumaBase, 'media'), join(snowlumaBase, 'cache'), join(snowlumaBase, 'temp')]
      : []
    const dataSubs = typeof ctx?.dataDir === 'function'
      ? [ctx.dataDir('media'), ctx.dataDir('cache')]
      : []
    const fixedRaw = [
      ...dataSubs,
      ...snowlumaSubs,
      ...(Array.isArray(cfg.mediaDirs) ? cfg.mediaDirs : []),
      ...(Array.isArray(options.mediaDirs) ? options.mediaDirs : []),
      join(userHome, '.config', 'QQ', 'NapCat', 'temp'),
      join(userHome, '.config', 'QQ', 'NapCat', 'cache'),
      join(userHome, 'NapCat', 'temp'),
      join(userHome, 'NapCat', 'cache'),
      join(userHome, 'NapCat', 'media'),
      join(userHome, 'AppData', 'Roaming', 'NapCat', 'temp'),
      join(userHome, 'AppData', 'Roaming', 'NapCat', 'cache'),
      join(userHome, 'AppData', 'Roaming', 'LLOneBot', 'temp'),
      join(userHome, 'AppData', 'Roaming', 'LLOneBot', 'cache'),
      join(userHome, 'AppData', 'Roaming', 'LLOneBot', 'media'),
    ]
    const scopedParentsRaw = [
      join(userHome, 'Documents', 'Tencent Files'),
      join(userHome, '.config', 'QQ'),
    ]
    return {
      fixedRoots: resolveRealDirs(fixedRaw, fsApi),
      scopedParents: resolveRealDirs(scopedParentsRaw, fsApi),
    }
  }

  function isPathInsideMediaPolicy(candidatePath, policy) {
    for (const root of policy.fixedRoots) {
      const rel = relative(root, candidatePath)
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return true
    }
    for (const parent of policy.scopedParents) {
      const rel = relative(parent, candidatePath)
      if (rel && !rel.startsWith('..') && !isAbsolute(rel) && TENCENT_CACHE_SUBDIR_RE.test(rel)) return true
    }
    return false
  }

  function readControlledMediaBytes(rawPath) {
    const fsApi = fsImpl || nodeFs
    let target = String(rawPath || '').trim()
    if (target.startsWith('file://')) {
      try { target = fileURLToPath(target) } catch { throw makeSendError('not-sent', 'unsafe-media-path', instance, '非法 file:// 媒体路径') }
    }
    if (!isAbsolute(target)) throw makeSendError('not-sent', 'unsafe-media-path', instance, 'QQ 媒体路径必须是绝对路径')
    if (isSensitiveMediaPath(target)) {
      throw makeSendError('not-sent', 'unsafe-media-path', instance, 'QQ 媒体路径指向受保护文件类型或敏感文件名，拒绝读取')
    }
    const policy = controlledMediaPolicy()
    if (!policy.fixedRoots.length && !policy.scopedParents.length) {
      throw makeSendError('not-sent', 'unsafe-media-path', instance, 'QQ 未配置受控媒体目录，拒绝读取本机路径')
    }
    // 本机可信环境约束：lstatSync → realpathSync → readFileSync 之间存在常规文件系统 TOCTOU 窗口，
    // 这里依赖本机 OneBot/QQ 宿主的普通用户文件权限隔离，仅防静态符号链接与跨目录越界读取。
    let st
    try {
      st = typeof fsApi.lstatSync === 'function' ? fsApi.lstatSync(target) : fsApi.statSync(target)
    } catch {
      let realParent = ''
      try { realParent = typeof fsApi.realpathSync === 'function' ? fsApi.realpathSync(dirname(target)) : resolve(dirname(target)) } catch {}
      const probeTarget = realParent ? join(realParent, basename(target)) : resolve(target)
      if (!isPathInsideMediaPolicy(probeTarget, policy)) {
        throw makeSendError('not-sent', 'unsafe-media-path', instance, 'QQ 媒体路径不在受控媒体子目录内，拒绝读取')
      }
      throw makeSendError('not-sent', 'media-not-found', instance, `QQ 本机媒体文件不存在：${target}`)
    }
    if (typeof st?.isSymbolicLink === 'function' && st.isSymbolicLink()) {
      throw makeSendError('not-sent', 'unsafe-media-path', instance, 'QQ 媒体路径不允许符号链接')
    }
    if (typeof st?.isFile === 'function' && !st.isFile()) {
      throw makeSendError('not-sent', 'unsafe-media-path', instance, 'QQ 媒体路径不是普通文件')
    }
    if (Number(st?.size) > MAX_LOCAL_MEDIA_BYTES) {
      throw makeSendError('not-sent', 'too-large', instance, `QQ 媒体文件超过 ${Math.round(MAX_LOCAL_MEDIA_BYTES / 1048576)}MB 上限`)
    }
    const realTarget = typeof fsApi.realpathSync === 'function' ? fsApi.realpathSync(target) : resolve(target)
    if (isSensitiveMediaPath(realTarget) || !isPathInsideMediaPolicy(realTarget, policy)) {
      throw makeSendError('not-sent', 'unsafe-media-path', instance, 'QQ 媒体路径不在受控媒体子目录内，拒绝读取')
    }
    const buf = fsApi.readFileSync(realTarget)
    if (buf.length > MAX_LOCAL_MEDIA_BYTES) {
      throw makeSendError('not-sent', 'too-large', instance, `QQ 媒体文件超过 ${Math.round(MAX_LOCAL_MEDIA_BYTES / 1048576)}MB 上限`)
    }
    if (!isAllowedMediaContent(realTarget, buf)) {
      throw makeSendError('not-sent', 'unsafe-media-path', instance, 'QQ 媒体文件内容或扩展名不符合媒体白名单，拒绝读取')
    }
    return buf
  }

  // ───────────────────────── 配置 ─────────────────────────

  const config = () => (typeof ctx?.config === 'function' ? ctx.config() || {} : {})

  /**
   * 从配置里取 OneBot 端点。三档优先级：
   *   1. 用户手填的 wsUrl / httpUrl（backend='onebot' 就是这一档，接别人家的网关）
   *   2. SnowLuma 自己的配置文件里读出来的（backend='snowluma' 且没手填时）
   *   3. 都没有 → 空地址：客户端会立刻以 transport 失败，whoami/send 都按 not-sent 走，不会静默冒充在线
   */
  function endpoint() {
    const cfg = config()
    const wsUrl = String(cfg.wsUrl || '').trim()
    const httpUrl = String(cfg.httpUrl || '').trim()
    const token = String(cfg.token || cfg.accessToken || '').trim()
    if (wsUrl || httpUrl) {
      return {
        wsUrl,
        httpUrl,
        wsToken: String(cfg.wsToken || token).trim(),
        httpToken: String(cfg.httpToken || token).trim(),
      }
    }
    if (sidecar) {
      try {
        const ep = sidecar.endpoint()
        if (ep && (ep.wsUrl || ep.httpUrl)) return ep
      } catch (error) {
        log().debug?.('读 SnowLuma 的 OneBot 配置失败：', error?.message || error)
      }
    }
    return { wsUrl: '', httpUrl: '', wsToken: '', httpToken: '' }
  }

  // ───────────────────────── 客户端（可注入） ─────────────────────────

  /**
   * 真实客户端返回的是 OneBot 响应里的 data；有的假客户端（测试）直接回整个信封
   * { status, retcode, data }。两种都收，省得平台端里到处写 `?.data`。
   */
  function unwrap(result) {
    if (result && typeof result === 'object' && 'data' in result && ('retcode' in result || result.status === 'ok' || result.status === 'failed')) return result.data
    return result
  }

  /** 走一次动作（统一 unwrap + 统一错误形状）。 */
  const call = (action, params, opts) => {
    if (!client) return Promise.reject(makeSendError('not-sent', 'offline', instance, 'QQ 网关客户端还没建'))
    return Promise.resolve(client.call(action, params, opts)).then(unwrap)
  }

  /** 建生产用的 OneBot 客户端（复用 src/onebot/client.js，不重写连接层）。 */
  function makeClient() {
    return createOneBotClient({
      endpoint,
      log: log(),
      onState: (state, detail) => onClientState(state, detail),
      onEvent: (event) => onClientEvent(event),
    })
  }

  /**
   * 给客户端接上状态与事件回调。
   * makeClient() 走的是 createOneBotClient 的构造参数（onState/onEvent），注入的 client
   * （测试替身、宿主自带客户端）只能靠 on()/off() 订阅，两种形状都支持。
   */
  function bindClient() {
    if (!client || typeof client.on !== 'function') return
    try { unbindClient?.() } catch {}
    const offState = client.on('state', (state, detail) => onClientState(state, detail))
    const offEvent = client.on('event', (event) => onClientEvent(event))
    unbindClient = () => {
      try { offState?.() } catch {}
      try { offEvent?.() } catch {}
    }
  }

  function onClientState(state, detail) {    if (!running || !ctx) return
    if (state === 'connected') {
      if (connected) return // 已经处理过这次连上（避免 start 里与回调重复触发 afterConnect）
      connected = true
      ctx.state('connected')
      void afterConnect()
      return
    }
    connected = false
    // 客户端自己的状态词（connecting/disconnected/unconfigured/stopped）与契约的 ConnState 不完全重合，
    // 这里只翻译契约里有的三个值，stopped 交给平台端的 stop() 报，避免「停了又报一次 stopped」。
    if (state === 'connecting') ctx.state('connecting')
    else if (state === 'disconnected') ctx.state('disconnected', detail)
    else if (state === 'unconfigured') ctx.state('unconfigured', detail || '没有配置 OneBot 地址')
  }

  function onClientEvent(event) {
    // 停完就不许再 emit（CONTRACTS 第六节第 3 条、adapter-kit 用例 5）
    if (!running || !ctx) return
    try {
      if (event?.post_type === 'message') {
        const inbound = fromOneBotEvent(event, { selfId, faceName: options.faceName })
        if (inbound && inbound.messageId) ctx.emit(inbound)
        return
      }
      if (event?.post_type === 'message_sent') {
        // 机器人自己发的：走 emitEvent({type:'self-sent'})，绝不走 emit（CONTRACTS §六.4）
        const evt = toAdapterEvent(event, { selfId })
        if (evt) ctx.emitEvent(evt)
        return
      }
      const evt = toAdapterEvent(event, { selfId })
      if (evt) ctx.emitEvent(evt)
    } catch (error) {
      log().warn?.('处理 OneBot 事件出错：', error?.message || error)
    }
  }

  // ───────────────────────── 能力探测 ─────────────────────────

  /**
   * caps.json 的完整路径（在实例自己的数据目录里）。
   * 只接受**绝对路径**：ctx.dataDir 缺席、或返回的是相对路径（'caps.json' 这种）时一律不落盘。
   * 否则会把 caps.json 写进当前工作目录（污染仓库根目录），还会让不同实例/不同测试互相串用能力表。
   */
  function cacheFilePath() {
    if (capsFile !== null) return capsFile
    try {
      const p = ctx?.dataDir ? String(ctx.dataDir('caps.json') || '') : ''
      capsFile = isAbsolutePath(p) ? p : ''
    } catch (error) {
      capsFile = ''
    }
    if (!capsFile) log().debug?.('没有可用的数据目录（不是绝对路径），本次不缓存能力表')
    return capsFile
  }

  /**
   * 探测前先读缓存。命中就**立刻**把缓存的能力表装上（这一步不等探测、不等 whoami），
   * 这样「下次启动先用缓存、连上再后台复探」才是真的：启动瞬间中枢就能按上次的能力表工作。
   * 缓存只是加速；装错了会被随后的复探纠正（探测完调 capsChanged 让网关重读）。
   */
  function loadCapsCache() {
    const file = cacheFilePath()
    if (!file) return null // 没有数据目录：不缓存也不读缓存（保守表起步）
    probeCache = readCapsCache(file, { fs: fsImpl, log: log() })
    if (probeCache) {
      caps = {
        ...CAPS_CONSERVATIVE,
        ...probeCache.caps,
        features: { ...CAPS_CONSERVATIVE.features, ...(probeCache.caps?.features || {}) },
      }
      // 动作白名单也先用缓存里的：native 在复探完成之前就能用上次探到的扩展动作。
      // probed=true 是这里的语义：缓存就是一份「上次探到的结果」，
      // 所以别的东西（面板、native 白名单）现在就可以按它工作，等后台复探再纠正。
      probeState = { probed: true, supported: supportedActions({ supported: probeCache.supported }), entries: {}, unknown: [], unsupported: [], probedAt: probeCache.probedAt, fromCache: true }
      log().info?.(`读到了能力缓存（${probeCache.gateway?.app || '?'} ${probeCache.gateway?.version || ''}，${probeCache.supported.length} 个动作），先用它；连上后后台复探`)
    }
    return probeCache
  }

  /**
   * 跑一遍探测（连上之后调，或 native 前发现还没探完时调）。
   * @param {{ reason?: string }} [opts]
   */
  async function runProbe({ reason = 'connected' } = {}) {
    if (!client || probing) return probeState
    probing = true
    try {
      // 先读版本，用来判断缓存还能不能用
      let gateway = { app: '', version: '' }
      try {
        const v = await call('get_version_info', {}, { timeoutMs: 5000, retries: 0 })
        gateway = { app: String(v?.app_name || v?.appName || ''), version: String(v?.app_version || v?.appVersion || v?.version || '') }
      } catch (error) {
        log().debug?.('读网关注册信息失败，按「版本未知」处理')
      }
      const cacheOk = probeCache && cacheMatchesGateway(probeCache, gateway)
      if (cacheOk && reason === 'connected') {
        // 缓存命中且网关版本没变：先把缓存报上去（loadCapsCache 已经装过一次，这里补一次 capsChanged
        // 让网关知道「能力表定了」），然后后台再复探一次（用户换了网关也能自己发现）
        applyProbe({ caps: probeCache.caps, supported: probeCache.supported, entries: {}, unknown: [], unsupported: [], probedAt: probeCache.probedAt, fromCache: true })
        log().info?.('能力缓存命中，先用缓存报能力，后台继续复探')
        // 不 await：后台复探，失败只降级不抛
        void realProbe(gateway).catch((error) => log().warn?.('后台复探失败（继续用缓存）：', error?.message || error))
        return probeState
      }
      await realProbe(gateway)
      return probeState
    } finally {
      probing = false
    }
  }

  async function realProbe(gateway) {
    const result = await probeGateway((action, params, opts) => call(action, params, opts), {
      log: log(),
      table: options.probeTable,
      ...(options.probeTimeoutMs ? { timeoutMs: options.probeTimeoutMs } : {}),
    })
    const finalGateway = { ...result.gateway, ...(gateway || {}) }
    const payload = {
      gateway: finalGateway,
      caps: result.caps,
      supported: result.supported,
      probedAt: result.probedAt,
    }
    const file = cacheFilePath()
    if (file) writeCapsCache(file, payload, { fs: fsImpl, log: log() })
    probeCache = { ...payload, actions: result.supported, unknown: result.unknown }
    applyProbe({ ...result, gateway: finalGateway })
    log().info?.(`能力探测完成（${finalGateway.app || '?'} ${finalGateway.version || ''}）：支持 ${result.supported.length} 个动作，不支持 ${result.unsupported.length} 个`)
    // 探测失败的那些单项要能在面板看到（「当前网关不支持 X」）
    for (const entry of Object.values(result.entries)) {
      if (entry.exists === false) log().warn?.(`当前网关不支持「${entry.label}」（${entry.action}）`)
    }
  }

  /** 把探测结果装进 caps，并通知网关重读（capsChanged）。 */
  function applyProbe({ caps: probedCaps, supported, entries = {}, unknown = [], unsupported = [], probedAt = 0, fromCache = false }) {
    const nextFeatures = { ...CAPS_CONSERVATIVE.features, ...(probedCaps?.features || {}) }
    const supportedSet = supportedActions({ supported })
    for (const action of downgradedUnsupported) {
      supportedSet.delete(action)
      if (CUSTOM_FACE_ACTIONS.has(action)) nextFeatures['sticker.sync.native'] = false
      if (action === 'set_msg_emoji_like') nextFeatures['message.reaction'] = false
    }
    caps = {
      ...CAPS_CONSERVATIVE,
      ...(probedCaps || {}),
      features: nextFeatures,
    }
    probeState = { probed: true, supported: supportedSet, entries, unknown, unsupported, probedAt, fromCache }
    // 探测后才敢说「这个网关有哪些扩展动作」：通知网关重新读 caps（契约 §八.1）
    try { ctx?.capsChanged?.() } catch (error) { log().debug?.('capsChanged 回调出错：', error?.message || error) }
  }

  // ───────────────────────── 连接后 ─────────────────────────

  /**
   * 读登录信息（whoami 的实际实现）。放在这里而不是直接调 adapter.whoami()：
   * afterConnect 拿的是闭包里的函数，adapter 对象还没构造完（下面的对象字面量里才定义 whoami）。
   * 顺手把 selfId 记下来，@自己 要判定成 mentionedMe。
   */
  async function loginInfo() {
    if (!client) throw makeSendError('not-sent', 'offline', instance, 'QQ 网关未连接')
    try {
      const info = await call('get_login_info', {}, { timeoutMs: 10000, retries: 0 })
      const account = String(info?.user_id ?? info?.uin ?? '')
      const name = String(info?.nickname ?? info?.name ?? account)
      if (account) selfId = account
      return { account, name }
    } catch (error) {
      throw toSendError(error, { instance, isDefiniteFailure })
    }
  }

  async function afterConnect() {
    if (!running) return
    // ① 核对登录的是不是配置里的那个机器人；顺带拿到 selfId（@自己 要用）
    let me = null
    try {
      me = await loginInfo()
      selfId = String(me?.account || '')
    } catch (error) {
      log().warn?.('连上了但读不到登录信息：', error?.message || error)
    }
    if (!running) return
    // ② SnowLuma 场景：核对登录的号（不是机器人号就撤销注入、断开）
    if (sidecar && selfId) {
      try {
        const ok = await sidecar.confirmLogin(selfId)
        if (!ok) {
          log().warn?.('登录的号不是机器人号，已断开这个实例')
          try { client?.stop() } catch (inner) {}
          if (ctx) ctx.state('disconnected', '登录的号不是配置里的机器人号')
          return
        }
      } catch (error) {
        log().debug?.('SnowLuma 核对登录号失败（不影响连接）：', error?.message || error)
      }
    }
    // ③ 能力探测（缓存命中就先报缓存，后台复探）
    try {
      await runProbe()
    } catch (error) {
      log().warn?.('能力探测失败，继续按最保守的能力表运行：', error?.message || error)
    }
  }

  // ───────────────────────── 发送 ─────────────────────────

  /**
   * 出站主路径。
   * 失败分类的全部来源是 src/onebot/client.js 的 transport / uncertain（见 errors.js）。
   */
  async function send(message = {}) {
    const cfg = config()
    const chat = message?.chat || {}
    const parts = Array.isArray(message?.parts) ? message.parts : []
    const kind = chat.kind === 'group' ? 'group' : 'private'
    // 被动回复的平台才需要这层保险：本平台 proactive='free'，走到这里说明是配置把它改小了
    if (caps.proactive === 'none' && !message.inResponseTo) {
      throw makeSendError('not-sent', 'proactive-not-allowed', instance, '该实例被配置成只能被动回复')
    }
    if (!parts.length) throw makeSendError('not-sent', 'nothing-to-send', instance, '没有可发送的内容')
    if (!running || !client || !connected) throw makeSendError('not-sent', 'offline', instance, 'QQ 网关未连接')
    const targetId = String(chat.id ?? '')
    if (!targetId) throw makeSendError('not-sent', 'bad-chat-id', instance, '出站缺少聊天编号')

    const { segments, uploads, pokes, degraded } = buildParts(parts, {
      voiceMode: caps.voice,
      faceIdOf: options.faceIdOf,
      log: log(),
    })
    const timeoutMs = Math.max(1, Number(message.timeoutMs) || 15000)
    let messageId = ''

    try {
      // ① 文件：走 upload_private_file / upload_group_file（和 hub.js sendFile 同一条路）
      const uploaded = []
      for (const up of uploads) {
        const size = Number(parts.find((p) => p?.type === 'file' || p?.type === 'voice')?.media?.size) || 0
        if (size && caps.maxFileBytes > 0 && size > caps.maxFileBytes) {
          throw makeSendError('not-sent', 'too-large', instance, `文件 ${size} 字节超过该网关上限 ${caps.maxFileBytes}`)
        }
        const action = kind === 'group' ? 'upload_group_file' : 'upload_private_file'
        const params = kind === 'group'
          ? { group_id: Number(targetId), file: up.file, name: up.name || 'file' }
          : { user_id: Number(targetId), file: up.file, name: up.name || 'file' }
        const r = await call(action, params, { timeoutMs, retries: 0 })
        uploaded.push({ action, name: up.name || 'file', id: r?.file_id })
      }

      // ② 消息段：引用回复要放在最前面（OneBot 规定 reply 段必须在首位）
      const outSegments = [...segments]
      if (message.replyTo && caps.quoteReply) outSegments.unshift({ type: 'reply', data: { id: String(message.replyTo) } })
      if (outSegments.length || uploaded.length) {
        const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg'
        const params = kind === 'group'
          ? { group_id: Number(targetId), message: outSegments }
          : { user_id: Number(targetId), message: outSegments }
        // 群里的戳一戳要靠 send_poke 单独发；私聊的 poke 段直接算进消息里（对面网关自己认）
        if (outSegments.length) {
          const r = await call(action, params, { timeoutMs, retries: 0 })
          messageId = String(r?.message_id ?? '')
        }
      }

      // ③ 戳一戳：独立的动作（不是消息段）
      if (pokes.length) {
        try {
          // 群里要带 group_id；私聊只有 user_id
          await call('send_poke', kind === 'group' ? { group_id: Number(targetId), user_id: 0 } : { user_id: Number(targetId) }, { timeoutMs, retries: 0 })
        } catch (error) {
          degraded.push('poke dropped')
          log().debug?.('戳一戳没发出去（不影响这条消息）：', error?.message || error)
        }
      }

      if (!messageId && uploaded.length) messageId = String(uploaded[0].id || `file-${Date.now()}`)
      if (!messageId) throw makeSendError('not-sent', 'nothing-sent', instance, '降级后没有可发送的内容')
      return { messageId }
    } catch (error) {
      // 已经是 SendError 的直接抛；其余的按 onebot/client.js 的 transport/uncertain 判定翻译
      if (error?.certainty === 'not-sent' || error?.certainty === 'unknown') throw error
      throw toSendError(error, { instance, isDefiniteFailure })
    }
  }

  // ───────────────────────── fetch ─────────────────────────

  function toFetchedMessage(rawMsg, fallbackId = '') {
    const s = rawMsg?.sender || {}
    const rawUid = s.user_id ?? rawMsg?.user_id
    const hasSender = rawUid !== undefined && rawUid !== null && String(rawUid) !== ''
    const account = hasSender ? String(rawUid) : ''
    const senderName = String(s.card || s.nickname || account || '')
    const selfAcc = String(selfId || config().selfId || config().account || '')
    const rawTime = Number(rawMsg?.time)
    const at = Number.isFinite(rawTime) && rawTime > 0 ? (rawTime < 1e12 ? rawTime * 1000 : rawTime) : undefined
    const { parts } = segmentsToParts(rawMsg?.message ?? rawMsg?.raw_message ?? rawMsg?.content ?? [], { selfId, faceName: options.faceName })
    return {
      messageId: String(rawMsg?.message_id ?? rawMsg?.id ?? fallbackId),
      ...(at ? { at } : {}),
      ...(hasSender
        ? { sender: { account, ...(senderName ? { name: senderName } : {}), isBot: Boolean(selfAcc && account === selfAcc) } }
        : {}),
      parts,
    }
  }

  /** 把 OneBot 历史消息数组规整成按时间升序 [旧 → 新] 的 FetchedHistoryPage。 */
  function normalizeHistoryPage(rawList, { count, anchor }) {
    const mapped = (Array.isArray(rawList) ? rawList : [])
      .map((m, idx) => toFetchedMessage(m, `hist-${idx}`))
    // OneBot 网关偶见倒序返回（新 → 旧），统一转为 [旧 → 新]
    if (mapped.length >= 2) {
      const firstAt = Number(mapped[0]?.at) || 0
      const lastAt = Number(mapped[mapped.length - 1]?.at) || 0
      if (firstAt > 0 && lastAt > 0 && firstAt > lastAt) mapped.reverse()
    }
    let filtered = mapped
    if (anchor) {
      const anchorIdx = mapped.findIndex((m) => String(m.messageId) === anchor)
      filtered = anchorIdx >= 0
        ? mapped.slice(0, anchorIdx)
        : mapped.filter((m) => String(m.messageId) !== anchor)
    }
    const hasMore = filtered.length > count
    const messages = filtered.slice(-count)
    const before = messages.length > 0 && messages[0].messageId ? String(messages[0].messageId) : undefined
    return {
      messages,
      hasMore,
      ...(before ? { before } : {}),
    }
  }

  async function fetch(request = {}) {
    if (!running || !client || !connected) throw makeSendError('not-sent', 'offline', instance, 'QQ 网关未连接')
    const chat = request.chat || {}
    const kind = chat.kind === 'group' ? 'group' : 'private'
    const id = String(chat.id ?? '')
    try {
      switch (request.kind) {
        case 'media': {
          const media = request.media || {}
          // 图片和语音走不同的取文件动作；path-only 结果仅在受控目录下由本端读成 bytes，绝不向外透传本机路径
          const file = media.id || (media.url ? String(media.url) : '')
          if (!file) throw makeSendError('not-sent', 'no-media', instance, 'media 里没有可取的标识')
          const record = String(media.mime || '').startsWith('audio') || media.kind === 'voice'
          const action = record ? 'get_record' : 'get_image'
          const r = await call(action, record ? { file, out_format: 'wav' } : { file }, { timeoutMs: 30000 })
          const rawUrl = r?.url ? String(r.url).trim() : ''
          const rawB64 = r?.base64 ? String(r.base64).trim() : ''
          const rawFile = r?.file ? String(r.file).trim() : ''
          if (rawB64) return { ...(rawUrl ? { url: rawUrl } : {}), base64: rawB64 }
          if (rawUrl) return { url: rawUrl }
          if (rawFile) {
            if (/^https?:\/\//i.test(rawFile)) return { url: rawFile }
            if (rawFile.startsWith('base64://')) return { base64: rawFile.slice(9) }
            return { bytes: readControlledMediaBytes(rawFile) }
          }
          return {}
        }
        case 'message': {
          const mid = String(request.messageId ?? '').trim()
          if (!mid) throw makeSendError('not-sent', 'bad-fetch-request', instance, 'QQ fetch(message) 缺少 messageId')
          const m = await call('get_msg', { message_id: Number(mid) || mid }, { timeoutMs: 8000 })
          return toFetchedMessage(m, mid)
        }
        case 'forward': {
          const r = await call('get_forward_msg', { id: String(request.id ?? '') }, { timeoutMs: 20000 })
          // 按 Step 1A 契约统一返回 FetchedForwardResult ({ messages: FetchedMessage[] })
          const nodes = Array.isArray(r?.messages) ? r.messages : []
          return { messages: nodes.map((n, idx) => toFetchedMessage(n, `fwd-${idx}`)) }
        }
        case 'history': {
          if (!/^\d+$/.test(id)) throw makeSendError('not-sent', 'bad-fetch-request', instance, 'QQ fetch(history) 需要数字群号或 QQ 号')
          const count = Math.max(1, Math.min(100, Number(request.count) || 20))
          const anchor = request.before !== undefined && request.before !== null ? String(request.before).trim() : ''
          const anchorParam = anchor && /^-?\d+$/.test(anchor) && Number.isSafeInteger(Number(anchor)) ? Number(anchor) : anchor
          // 多要 1~2 条，用来判定 before 游标之前是否还有更早消息（hasMore）及剔除锚点本身
          const fetchCount = anchor ? count + 2 : count + 1
          const action = kind === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history'
          const base = kind === 'group' ? { group_id: Number(id) } : { user_id: Number(id) }
          const params = anchor
            ? { ...base, count: fetchCount, message_id: anchorParam, reverse_order: true }
            : { ...base, count: fetchCount }
          const r = await call(action, params, { timeoutMs: 20000 })
          const rawList = Array.isArray(r?.messages) ? r.messages : (Array.isArray(r) ? r : [])
          return normalizeHistoryPage(rawList, { count, anchor })
        }
        case 'member': {
          if (kind !== 'group') throw makeSendError('not-sent', 'no-member', instance, '私聊没有成员信息')
          return await call('get_group_member_info', { group_id: Number(id), user_id: Number(request.account), no_cache: true }, { timeoutMs: 10000 })
        }
        case 'members': {
          if (kind !== 'group') throw makeSendError('not-sent', 'no-member', instance, '私聊没有成员列表')
          return await call('get_group_member_list', { group_id: Number(id) }, { timeoutMs: 20000 })
        }
        case 'chats': {
          const groups = await call('get_group_list', {}, { timeoutMs: 15000 }).catch(() => [])
          const friends = await call('get_friend_list', {}, { timeoutMs: 15000 }).catch(() => [])
          return { groups: Array.isArray(groups) ? groups : [], friends: Array.isArray(friends) ? friends : [] }
        }
        default:
          throw makeSendError('not-sent', 'bad-fetch-kind', instance, `认不出的 fetch 类型：${String(request.kind)}`)
      }
    } catch (error) {
      if (error?.certainty === 'not-sent' || error?.certainty === 'unknown') throw error
      throw toSendError(error, { instance, isDefiniteFailure })
    }
  }

  // ───────────────────────── PlatformAdapter ─────────────────────────

  const CUSTOM_FACE_ACTIONS = new Set(['fetch_custom_face', 'add_custom_face', 'modify_custom_face', 'delete_custom_face'])

  const native = createNative({
    probeState: () => probeState,
    call: (action, params, opts) => {
      if (!client) return Promise.reject(makeSendError('not-sent', 'offline', instance, 'QQ 网关客户端还没建'))
      return call(action, params, opts)
    },
    instance: () => instance,
    log: log(),
    onUnsupported: (action) => {
      downgradedUnsupported.add(action)
      let changed = false
      if (CUSTOM_FACE_ACTIONS.has(action) && caps.features?.['sticker.sync.native']) {
        caps = { ...caps, features: { ...caps.features, 'sticker.sync.native': false } }
        changed = true
      } else if (action === 'set_msg_emoji_like' && caps.features?.['message.reaction']) {
        caps = { ...caps, features: { ...caps.features, 'message.reaction': false } }
        changed = true
      }
      if (changed) {
        try { ctx?.capsChanged?.() } catch (error) { log().debug?.('懒降级 capsChanged 回调出错：', error?.message || error) }
      }
    },
  })

  const ensureGroupAdminId = (groupId) => {
    if (!running || !connected || !client) throw makeSendError('not-sent', 'offline', instance, 'QQ 网关未连接')
    const gid = String(groupId || '').trim()
    if (!/^\d+$/.test(gid)) throw makeSendError('not-sent', 'bad-fetch-request', instance, 'QQ 群号必须为纯数字')
    return Number(gid)
  }

  const callGroupAdminAction = async (action, params, opts = { timeoutMs: 10000 }) => {
    try {
      return await call(action, params, opts)
    } catch (error) {
      if (classifyProbeError(error) === 'unsupported') {
        downgradedUnsupported.add(action)
        probeState?.supported?.delete?.(action)
        throw Object.assign(new Error(`当前 QQ 网关不支持 ${action}`), { code: 'group-admin-unsupported', certainty: 'not-sent', instance })
      }
      throw toSendError(error, { instance, isDefiniteFailure })
    }
  }

  const groupAdmin = {
    get supportedActions() {
      return {
        ban: !downgradedUnsupported.has('set_group_ban'),
        unban: !downgradedUnsupported.has('set_group_ban'),
        kick: !downgradedUnsupported.has('set_group_kick'),
        wholeBan: !downgradedUnsupported.has('set_group_whole_ban'),
        title: !downgradedUnsupported.has('set_group_special_title'),
        notice: !downgradedUnsupported.has('_send_group_notice'),
      }
    },
    async getBotState(groupId) {
      const gidNum = ensureGroupAdminId(groupId)
      const botId = selfId || (await loginInfo().catch(() => null))?.account || ''
      if (!/^\d+$/.test(botId)) throw makeSendError('not-sent', 'offline', instance, 'QQ 网关尚未获取到机器人 QQ 号')
      const r = await callGroupAdminAction('get_group_member_info', { group_id: gidNum, user_id: Number(botId), no_cache: true })
      const role = ['owner', 'admin', 'member'].includes(r?.role) ? r.role : 'member'
      return { role, groupOpenid: String(gidNum), memberOpenid: String(botId) }
    },
    async getGroupInfo(groupId) {
      const gidNum = ensureGroupAdminId(groupId)
      const r = await callGroupAdminAction('get_group_info', { group_id: gidNum })
      return {
        groupOpenid: String(gidNum),
        name: String(r?.group_name || r?.name || ''),
        ...(Number.isFinite(Number(r?.member_count)) ? { memberCount: Number(r.member_count) } : {}),
      }
    },
    async listMembers(groupId, { startIndex = 0, limit = 50 } = {}) {
      const gidNum = ensureGroupAdminId(groupId)
      const raw = await callGroupAdminAction('get_group_member_list', { group_id: gidNum }, { timeoutMs: 20000 })
      const arr = Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : [])
      const start = Math.max(0, Number(startIndex) || 0)
      const cap = Math.max(1, Math.min(200, Number(limit) || 50))
      return arr
        .slice(start, start + cap)
        .map((m) => ({
          openid: String(m?.user_id ?? '').trim(),
          nick: String(m?.card || m?.nickname || ''),
          role: String(m?.role || ''),
        }))
        .filter((m) => m.openid)
    },
    async muteMember(groupId, memberId, durationMs) {
      const gidNum = ensureGroupAdminId(groupId)
      const uidStr = String(memberId || '').trim()
      if (!/^\d+$/.test(uidStr)) throw makeSendError('not-sent', 'bad-fetch-request', instance, '成员 QQ 号无效')
      const secs = Math.max(60, Math.min(2592000, Math.round((Number(durationMs) || 600_000) / 1000)))
      await callGroupAdminAction('set_group_ban', { group_id: gidNum, user_id: Number(uidStr), duration: secs })
    },
    async unmuteMember(groupId, memberId) {
      const gidNum = ensureGroupAdminId(groupId)
      const uidStr = String(memberId || '').trim()
      if (!/^\d+$/.test(uidStr)) throw makeSendError('not-sent', 'bad-fetch-request', instance, '成员 QQ 号无效')
      await callGroupAdminAction('set_group_ban', { group_id: gidNum, user_id: Number(uidStr), duration: 0 })
    },
    async kickMember(groupId, memberId, opts = {}) {
      const gidNum = ensureGroupAdminId(groupId)
      const uidStr = String(memberId || '').trim()
      if (!/^\d+$/.test(uidStr)) throw makeSendError('not-sent', 'bad-fetch-request', instance, '成员 QQ 号无效')
      await callGroupAdminAction('set_group_kick', { group_id: gidNum, user_id: Number(uidStr), reject_add_request: Boolean(opts?.addBlackList) })
    },
  }

  const adapter = {
    id,
    name: 'QQ',

    contract: 1,

    /** 能力表。探测前是最保守的那一版；探测完会换成探测结果（并调过 ctx.capsChanged）。 */
    caps() {
      return { ...caps, features: { ...(caps.features || {}) } }
    },

    /** 面板表单。字段与契约 InstanceConfig 的约定一致：平台专属配置由平台端自己声明。 */
    settings: [
      { key: 'backend', label: '接入方式', type: 'select', options: [{ value: 'snowluma', label: 'SnowLuma（插件帮你启停本机网关，仅 Windows）' }, { value: 'onebot', label: '已有 OneBot 网关（NapCat / LLOneBot / 自己部署的）' }], default: 'onebot', description: 'snowluma 会替你启动、注入、核对机器人号；onebot 只按下面填的地址连，不碰本机进程' },
      { key: 'wsUrl', label: 'WebSocket 地址', type: 'text', default: '', placeholder: 'ws://127.0.0.1:3001', description: 'OneBot v11 正向 WS（Universal 模式）。留空时若接了 SnowLuma 就自动从它的配置里读' },
      { key: 'httpUrl', label: 'HTTP 地址', type: 'text', default: '', placeholder: 'http://127.0.0.1:3000', description: '留着也能用：WS 没连上时走 HTTP 调动作' },
      { key: 'token', label: '访问令牌', type: 'password', default: '', description: '对方设了 access_token 就填，没设留空（WS 和 HTTP 共用）' },
      { key: 'snowlumaManaged', label: '由插件管理 SnowLuma', type: 'switch', default: false, description: '只在 Windows + backend=snowluma 时生效：替你启停本机的 SnowLuma，并只给机器人号注入' },
      { key: 'snowlumaDir', label: 'SnowLuma 目录', type: 'text', default: '', placeholder: 'C:\\Aurabot\\snowluma', description: '主人自己下载解压的那一份（插件不下载、不解压、不替你同意协议）' },
    ],

    async start(context) {
      if (running) return
      ctx = context
      instance = String(ctx.instance || id)
      running = true
      ctx.state('connecting')

      const cfg = config()

      // ── 0. SnowLuma 子模块：只在这个实例显式选了 snowluma 后端时才建 ──
      const want = snowlumaEnabled({
        backend: cfg.backend,
        snowlumaManaged: cfg.snowlumaManaged,
        snowlumaDir: cfg.snowlumaDir ?? cfg.dir,
      })
      // snowlumaManaged=false 时完全不碰本机进程（用户自己开着 SnowLuma，我们只连它的端点）
      if (want.enabled && cfg.snowlumaManaged === true) {
        try {
          sidecar = createSnowlumaSidecar({
            config,
            account: () => selfId || String(cfg.selfId || cfg.account || ''),
            log: log(),
            savePassword: typeof cfg.savePassword === 'function' ? cfg.savePassword : undefined,
            managerFactory: options.managerFactory,
          })
          const r = await sidecar.start()
          if (r && r.ok === false) {
            // 启动不了不是致命错：用户可能已经把 SnowLuma 开着，照样去连它的端点
            log().warn?.('SnowLuma 没能替你启动：', r.message || '未知原因')
            ctx.state('connecting', `SnowLuma：${r.message || '启动失败'}，继续尝试连接已有网关`)
          } else if (r?.message) {
            log().info?.(`SnowLuma：${r.message}`)
          }
          if (cfg.autoAttach !== false) {
            const a = await sidecar.attachBot()
            if (a?.message) log().info?.(`SnowLuma 注入：${a.message}`)
          }
        } catch (error) {
          log().warn?.('SnowLuma 子模块出错（继续按纯 OneBot 连接）：', error?.message || error)
          sidecar = null
        }
      } else if (String(cfg.backend || '') === 'snowluma' && want.reason) {
        log().debug?.(`不启用 SnowLuma 管理：${want.reason}`)
      }

      // ── 1. 读 caps 缓存（先用缓存再后台复探）──
      loadCapsCache()

      // ── 2. 建客户端并连 ──
      if (!client) client = makeClient()
      // 注入的 client（测试替身 / 宿主自带的 OneBot 客户端）不会走 makeClient 里的 onState 接线，
      // 这里补一次：有 on() 就订阅状态与事件。不订阅的话，注入客户端永远报不出 connected，
      // 也推不出入站事件（历史上就是这么漏的：start 之后一直卡在 connecting）。
      bindClient()
      if (typeof client.start === 'function') client.start()

      // ② 连不上时不能假装连上：等一次连接结果（adapter-kit 要求 start 后状态到 connected）
      const ok = await waitConnected(client, Number(cfg.connectTimeoutMs) || 5000)
      if (!ok) {
        // 没有地址 / 对面没起：按「未连接」报，不抛错（网关会记成断线，之后自动重连）
        ctx.state('unconfigured', endpoint().wsUrl || endpoint().httpUrl ? 'QQ 网关暂时连不上（会自动重连）' : '还没配置 OneBot 地址')
        return
      }
      // 连上后的状态由 onClientState 报（它会触发 afterConnect：whoami + 探测）
    },

    async stop() {
      if (!running) return
      running = false
      connected = false
      if (typeof unbindClient === 'function') { try { unbindClient() } catch (error) {} unbindClient = null }
      try { client?.stop?.() } catch (error) { log().debug?.('停 OneBot 客户端出错：', error?.message || error) }
      if (sidecar) {
        try { sidecar.dispose?.() } catch (error) { log().debug?.('停 SnowLuma 出错：', error?.message || error) }
        sidecar = null
      }
      ctx?.state('stopped')
      // 停了之后绝不能再 emit：onClientEvent 里有 running 守卫，这里再把 ctx 留着给状态用
    },

    async whoami() {
      return loginInfo()
    },

    send,

    fetch,

    native,

    groupAdmin,

    /** 旧接口 sendSegments 的兼容口：OneBot 消息段 → parts（入站翻译用同一个函数）。 */
    toParts(nativeMessage) {
      return partsOf(nativeMessage, { selfId, faceName: options.faceName })
    },

    // ───────────── 测试 / 面板用的控制面（真实网关不会调）─────────────

    /** 当前探测状态（面板显示「当前网关不支持 X」用）。 */
    probeInfo() {
      return {
        probed: Boolean(probeState?.probed),
        entries: probeState?.entries || {},
        supported: [...(probeState?.supported || [])],
        unknown: probeState?.unknown || [],
        // 这次的能力表是缓存来的（还没被真探测覆盖）
        fromCache: Boolean(probeState?.fromCache),
        probedAt: Number(probeState?.probedAt) || 0,
      }
    },

    /** 手动重探（面板上的「重新探测」）。 */
    async reprobe() {
      probeCache = null
      return runProbe({ reason: 'manual' })
    },

    /** 测试用：直接拿到客户端对象（不经过平台端）。 */
    get __client() { return client },
    /** 测试用：把一条 OneBot 事件送进来（等价于 WS 推一条）。 */
    __push(event) { onClientEvent(event) },
    /** 测试用：模拟客户端状态变化。 */
    __state(state, detail) { onClientState(state, detail) },
    /**
     * 测试用：临时改 caps 并通知网关（等价于「探测结果变了」或「配置把能力关小了」）。
     * adapter-kit 的 setProactive 需要它。
     */
    __setCapsForTest(partial = {}) {
      caps = { ...caps, ...(partial || {}) }
      try { ctx?.capsChanged?.() } catch {}
      return { ...caps }
    },
  }

  return adapter
}

const noopLog = { debug() {}, info() {}, warn() {}, error() {} }

/** 绝对路径判定：Windows 盘符（C:\ / C:/）、UNC（\\）、POSIX（/）。相对路径一律不落盘。 */
function isAbsolutePath(p) {
  const s = String(p || '')
  return /^[a-zA-Z]:[\\/]/.test(s) || /^\\\\/.test(s) || s.startsWith('/')
}

/** 等客户端连上（连不上就返回 false，由调用方按「未连接」处理）。 */
function waitConnected(client, timeoutMs) {
  if (!client) return Promise.resolve(false)
  if (typeof client.isConnected === 'function' && client.isConnected()) return Promise.resolve(true)
  if (typeof client.state === 'function' ? client.state() === 'connected' : client.state === 'connected') return Promise.resolve(true)
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = () => {
      const now = typeof client.isConnected === 'function' ? client.isConnected() : client.state === 'connected'
      if (now) return resolve(true)
      if (Date.now() - started >= timeoutMs) return resolve(false)
      setTimeout(tick, 25).unref?.()
    }
    tick()
  })
}

/** 默认导出一个预配置实例（网关 register 时用工厂包一层：() => createQqAdapter()）。 */
export default createQqAdapter()

export { createQqAdapter as createAdapter }
export { FILE_MAX_BYTES, CAPS_CONSERVATIVE }
