// QQ 平台端 · 能力探测（G2 产出，本包的核心）
//
// 为什么需要探测：OneBot v11 只规定了很小的一套动作，「历史消息 / 文件地址 / 戳一戳 /
// 输入状态 / 改资料 / 空间 / 收藏表情 / 语音转文字」这些都是各家网关（SnowLuma、NapCat、
// LLOneBot、Lagrange……）自己加的扩展。能力取决于对面装的是哪个网关，所以只能连上之后问。
//
// 规矩（docs/CONTRACTS.md §八.1、docs/ADAPTER.md 第 3 步）：
//   1. 探测前按最保守的可用集报（CAPS_CONSERVATIVE），探测完调 ctx.capsChanged()。
//   2. 单个探针失败只把对应那一项降级为 false，并记一条日志（面板据此显示「当前网关不支持 X」），
//      不能让一次探测失败把整张能力表打成 false。
//   3. 探测结果按网关版本缓存到本实例数据目录的 caps.json，下次启动先用缓存、连上再复探。
//   4. **绝不发真消息、绝不改真资料**：只做只读调用，或者用「一定被拒」的参数去问
//      「这个动作存在吗」（改资料那几项用超长的昵称/签名和空头像，任何实现都会先拒掉，
//      真被接受了也改不动东西——见 MUTATING_PROBES 的注释）。
//
// 判定「不支持」的办法：各家对「没有这个动作」的措辞不统一（SnowLuma 回 retcode 1404，
// NapCat 回「不支持的API」，go-cqhttp 回 "unknown action"……），所以先看 retcode 1404/404，
// 再看文本里有没有「不支持 / 未实现 / unknown action」这类词。拿不准（超时、连不上）
// 记 unknown —— 宁可不声明这项能力，也不谎报。

import * as nodeFs from 'node:fs'

/** 单个探测的超时（网关忙的时候别把启动拖太久）。 */
export const PROBE_TIMEOUT_MS = 5000

/**
 * 文件大小上限。OneBot 没有「查询上限」的动作，这里取一个保守值：
 * 报小了只是让网关提前抛 too-large，报大了会把太大的文件真发出去才发现失败。
 */
export const FILE_MAX_BYTES = 30 * 1024 * 1024

/**
 * 探测前 / 探测不到时用的保守能力表。
 *
 * 取值理由（这一版按「OneBot v11 标准 + 绝不谎报」定）：
 *   - 文本、@、@全体、引用回复：v11 消息段标准，能连上就一定有 → true。
 *   - 图片、表情包（当图片发）、语音条：v11 的 image / record 段标准 → true / 'native'。
 *   - 视频：v11 没有 video 段的正式定义，也没有能安全试探的动作 → false（探测也不发真消息）。
 *   - 文件、历史消息、成员列表、合并转发展开、戳一戳、输入状态、撤回：各网关扩展 → false。
 *   - 卡片：出站方向 OneBot 没有可靠的卡片段 → false。
 *   - proactive：'free' —— 这是 QQ 个人号的性质（能主动发），不是对面网关的能力；
 *     探测期间也不该把主动消息全掐掉（否则中枢的主动消息会全进补发队列）。
 *   - listenAllInGroup：OneBot 的 WS 推送本来就带群里所有消息 → true。
 */
export const CAPS_CONSERVATIVE = Object.freeze({
  image: true,
  sticker: true,
  voice: 'native',
  video: false,
  file: false,
  maxFileBytes: 0,
  quoteReply: true,
  mention: true,
  mentionAll: true,
  poke: false,
  typing: false,
  recall: false,
  card: false,
  listenAllInGroup: true,
  proactive: 'free',
  replyWindowMs: 0,
  repliesPerMessage: 0,
  history: false,
  memberList: false,
  forwardExpand: false,
})

/** 「这个动作不存在」的文本特征（各家措辞差异都收进来）。 */
const UNSUPPORTED_TEXT = /不支持|未实现|未找到(该)?(动作|接口|api)|未知的?\s*(api|action|动作|接口)|没有(这个|该)?(动作|接口)|unsupported|not\s+(?:implemented|supported)|unknown\s+action|no\s+such\s+(?:api|action)|action\s+not\s+found/i

/**
 * 一次失败的调用 → 'unsupported' | 'unknown' | 'exists'。
 *   unsupported：对面明确说没这个动作
 *   unknown    ：超时 / 连不上 / 读不懂（不能据此下结论）
 *   exists     ：动作在，只是参数/权限不对（改资料用超长参数、戳一戳用不存在的号，
 *                失败本来就是预期结果）
 */
export function classifyProbeError(error) {
  const retcode = Number(error?.data?.retcode)
  if (retcode === 1404 || retcode === 404) return 'unsupported'
  const text = [error?.data?.message, error?.data?.wording, error?.message].filter(Boolean).join(' ')
  if (UNSUPPORTED_TEXT.test(text)) return 'unsupported'
  // 超时 / 连接中途断开 / 连不上：不知道对面有没有这个动作
  if (error?.transport || error?.uncertain) return 'unknown'
  if (/超时|timeout|timed?\s*out|连不上|没有响应/i.test(text)) return 'unknown'
  return 'exists'
}

/** 超长字符串：用来「问存在性但一定被拒」，不会真的改动资料。 */
const TOO_LONG = 'aurabot-probe-'.padEnd(400, 'x')

/**
 * 会改数据的动作的探针参数。设计原则：返回 true 只说明「动作存在」，绝不能让对面真改掉东西。
 *   - set_qq_profile / set_self_longnick：昵称/签名超长（QQ 侧长度校验先拒）；
 *   - set_qq_avatar：空 base64（不是合法图片，解码就失败）；
 *   - upload_*_file：空 file（必然 file not found）；
 *   - send_poke / set_input_status / delete_msg / get_msg：目标号填 0，不存在；
 *   - set_msg_emoji_like：message_id 0。
 * 这些都是各实现里「参数校验先于动作」的地方，所以既能证明动作存在，又碰不到真数据。
 */
const MUTATING_PROBES = {
  profile_nickname: () => ({ nickname: TOO_LONG }),
  profile_avatar: () => ({ file: 'base64://' }),
  longnick: () => ({ longNick: TOO_LONG }),
}

/**
 * 探针表。params 是对象或 (bag) => 对象（用前面探到的群号/好友号当目标）。
 * cap 写了就决定 caps 的哪一项；没写的只进扩展动作清单（供 native() 白名单和面板提示用）。
 */
export const PROBE_TABLE = [
  // ── 基础：连上就该有 ──
  { name: 'version', action: 'get_version_info', params: {}, label: '网关版本' },
  { name: 'status', action: 'get_status', params: {}, label: '运行状态' },
  { name: 'login', action: 'get_login_info', params: {}, label: '登录信息' },
  { name: 'can_send_image', action: 'can_send_image', params: {}, cap: 'image', label: '发图能力' },
  { name: 'can_send_record', action: 'can_send_record', params: {}, cap: 'voice', label: '发语音能力' },
  { name: 'friend_list', action: 'get_friend_list', params: {}, label: '好友列表' },
  { name: 'group_list', action: 'get_group_list', params: {}, label: '群列表' },

  // ── 历史消息（动作名取决于有没有群）──
  { name: 'history', action: '', params: historyParams, cap: 'history', label: '历史消息' },

  // ── 成员列表 / 合并转发 / 撤回 / 表情回应 ──
  { name: 'members', action: 'get_group_member_list', params: (bag) => ({ group_id: firstGroup(bag) }), cap: 'memberList', label: '群成员列表' },
  { name: 'forward', action: 'get_forward_msg', params: () => ({ id: 'aurabot-probe' }), cap: 'forwardExpand', label: '合并转发展开' },
  { name: 'recall', action: 'delete_msg', params: () => ({ message_id: 0 }), cap: 'recall', label: '撤回消息' },
  { name: 'emoji_like', action: 'set_msg_emoji_like', params: () => ({ message_id: 0, emoji_id: '1', set: true }), label: '表情回应' },

  // ── 戳一戳 / 输入状态（本包要求的探针）──
  { name: 'poke', action: 'send_poke', params: () => ({ user_id: 0 }), cap: 'poke', label: '戳一戳' },
  { name: 'typing', action: 'set_input_status', params: () => ({ user_id: 0, event_type: 1 }), cap: 'typing', label: '输入状态' },

  // ── 文件地址 / 上传（本包要求的探针）──
  { name: 'group_file_url', action: 'get_group_file_url', params: (bag) => ({ group_id: firstGroup(bag), file_id: 'aurabot-probe' }), label: '群文件下载地址' },
  { name: 'private_file_url', action: 'get_private_file_url', params: (bag) => ({ user_id: firstFriend(bag), file_id: 'aurabot-probe' }), label: '私聊文件下载地址' },
  { name: 'upload_group_file', action: 'upload_group_file', params: (bag) => ({ group_id: firstGroup(bag), file: '', name: '' }), cap: 'file', label: '发群文件' },
  { name: 'upload_private_file', action: 'upload_private_file', params: (bag) => ({ user_id: firstFriend(bag), file: '', name: '' }), label: '发私聊文件' },

  // ── 改资料（本包要求的探针；参数见 MUTATING_PROBES，改不动真数据）──
  { name: 'profile_nickname', action: 'set_qq_profile', params: MUTATING_PROBES.profile_nickname, label: '改昵称' },
  { name: 'profile_avatar', action: 'set_qq_avatar', params: MUTATING_PROBES.profile_avatar, label: '改头像' },
  { name: 'longnick', action: 'set_self_longnick', params: MUTATING_PROBES.longnick, label: '改个性签名' },

  // ── 空间（只用只读的列表接口，绝不发说说）──
  { name: 'qzone_list', action: 'get_qzone_msg_list', params: () => ({ num: 1 }), label: '空间说说列表' },

  // ── 收藏表情（只读）──
  { name: 'custom_faces', action: 'fetch_custom_face', params: () => ({ count: 1 }), label: '收藏表情' },

  // ── 语音转文字 ──
  { name: 'ptt_text', action: 'fetch_ptt_text', params: () => ({ message_id: 0 }), label: '语音转文字' },

  // ── 其余常用扩展动作（只进清单，供 native() 白名单与面板提示用）──
  { name: 'sys_faces', action: 'fetch_sys_faces', params: {}, label: '系统表情表' },
  { name: 'image_download', action: 'get_image', params: () => ({ file: '' }), label: '取图片' },
  { name: 'record_download', action: 'get_record', params: () => ({ file: '' }), label: '取语音' },
  { name: 'stranger_info', action: 'get_stranger_info', params: () => ({ user_id: 0 }), label: '查陌生人资料' },
  { name: 'group_info', action: 'get_group_info', params: () => ({ group_id: 0 }), label: '查群资料' },
  { name: 'friend_requests', action: 'get_doubt_friends_add_request', params: () => ({ count: 1 }), label: '好友申请列表' },
  { name: 'group_msg', action: 'get_msg', params: () => ({ message_id: 0 }), label: '取单条消息' },
]

/** 探测器至少要有的号：没有群/好友时用 0（让对方以「目标不存在」失败，不影响判定） */
function firstGroup(bag) {
  const g = bag?.group_list
  const id = Array.isArray(g) ? g.find((x) => x && x.group_id !== undefined)?.group_id : undefined
  return Number(id) || 0
}

function firstFriend(bag) {
  const f = bag?.friend_list
  const id = Array.isArray(f) ? f.find((x) => x && x.user_id !== undefined)?.user_id : undefined
  return Number(id) || 0
}

/** 历史消息没有统一动作名：有群就问群历史，没群就问好友历史。 */
function historyParams(bag) {
  const gid = firstGroup(bag)
  if (gid) return { group_id: gid, count: 1 }
  return { user_id: firstFriend(bag), count: 1 }
}

/**
 * 跑一遍探测。**只读**（除 MUTATING_PROBES 那些「一定被拒」的探针）。
 * @param {(action: string, params?: any, opts?: object) => Promise<any>} call 客户端的 call
 * @param {{ log?: object, timeoutMs?: number, table?: any[] }} [opts]
 * @returns {Promise<{
 *   gateway: { app: string, version: string, protocol: number, raw: unknown },
 *   entries: Record<string, { name: string, action: string, label: string, exists: boolean|'unknown', detail?: string }>,
 *   supported: string[], unsupported: string[], unknown: string[],
 *   caps: import('../../gateway/contracts.d.ts').Caps,
 *   probedAt: number,
 * }>}
 */
export async function probeGateway(call, { log, timeoutMs = PROBE_TIMEOUT_MS, table = PROBE_TABLE } = {}) {
  const entries = {}
  const bag = {} // 探到的中间结果（群列表、好友列表），后面的探针拿它当目标
  for (const probe of table) {
    const params = typeof probe.params === 'function' ? probe.params(bag) : probe.params || {}
    // 历史消息这种「动作名取决于有没有群」的探针，参数算完才定动作名
    const action = probe.action || (params.group_id ? 'get_group_msg_history' : 'get_friend_msg_history')
    let exists = 'unknown'
    let detail = ''
    let data
    try {
      // 平台端自己再套一层超时：有的网关对不认识的动作不回报错、也不回响应（socket 挂着不动），
      // 光靠客户端的 timeoutMs 不一定能收场。这里到点就按「结果不明」处理，绝不拖住整轮探测。
      data = await withTimeout(call(action, params, { timeoutMs, retries: 0 }), timeoutMs + 1000, () => {
        throw Object.assign(new Error(`探测 ${action} 超过 ${timeoutMs}ms 没有响应`), { uncertain: true })
      })
      exists = true
    } catch (error) {
      const verdict = classifyProbeError(error)
      if (verdict === 'unsupported') {
        exists = false
        detail = '网关没有这个动作'
      } else if (verdict === 'unknown') {
        exists = 'unknown'
        detail = String(error?.data?.message || error?.message || '探测结果不明')
      } else {
        exists = true // 动作存在，只是参数/权限不对：改资料用超长参数、戳一戳用不存在的号，失败是预期
        detail = String(error?.data?.message || error?.message || '调用失败（动作存在）')
      }
    }
    if (probe.name === 'group_list' && Array.isArray(data)) bag.group_list = data
    if (probe.name === 'friend_list' && Array.isArray(data)) bag.friend_list = data
    if (probe.name === 'version' && data && typeof data === 'object') bag.version = data
    if (probe.name === 'can_send_image' || probe.name === 'can_send_record') {
      // 这两个动作成功时返回 { yes: true/false }：明确 false 才算「不能发」
      if (data?.yes === false) { exists = false; detail = '网关明确回答不能发' }
    }
    entries[probe.name] = {
      name: probe.name,
      action,
      label: probe.label || probe.name,
      exists,
      ...(probe.cap ? { cap: probe.cap } : {}),
      ...(detail ? { detail } : {}),
    }
    if (exists === false) log?.warn?.(`QQ 网关不支持「${probe.label || probe.name}」（${action}），该项能力按不支持处理`)
    else if (exists === 'unknown') log?.debug?.(`QQ 网关「${probe.label || probe.name}」探测结果不明（${action}），按不支持处理`)
  }

  // 版本信息：探针表里已经问过 get_version_info，这里用它留下的结果，不再重复请求
  const gateway = { app: '', version: '', protocol: 11, raw: bag.version }
  try {
    const v = bag.version
    if (v && typeof v === 'object') {
      gateway.app = String(v.app_name || v.appName || v.app || '')
      gateway.version = String(v.app_version || v.appVersion || v.version || '')
      gateway.protocol = Number(v.protocol_version ?? v.protocolVersion ?? 11) || 11
    }
  } catch (error) {
    log?.debug?.('读不到网关版本信息（不影响能力判定）')
  }

  const list = Object.values(entries)
  const supported = list.filter((e) => e.exists === true).map((e) => e.action).filter(Boolean)
  const unsupported = list.filter((e) => e.exists === false).map((e) => e.action).filter(Boolean)
  const unknown = list.filter((e) => e.exists === 'unknown').map((e) => e.name)
  return { gateway, entries, supported, unsupported, unknown, caps: capsFromProbes(entries), probedAt: Date.now() }
}

/**
 * 探测结果 → 能力表。只有探到「确实有」才升级；探不到、结果不明一律保持保守值。
 * @param {Record<string, { exists: boolean|'unknown' }>} entries
 */
export function capsFromProbes(entries) {
  const has = (name) => entries?.[name]?.exists === true
  const caps = { ...CAPS_CONSERVATIVE }

  // 网关明确回答「不能发」才降级（这是它自己的答案，不是我们猜的）
  if (entries?.can_send_image?.exists === false) caps.image = false
  if (entries?.can_send_record?.exists === false) caps.voice = false

  // 文件：有任一上传动作就算能发；上限用 FILE_MAX_BYTES（OneBot 没有查询上限的动作）
  caps.file = has('upload_group_file') || has('upload_private_file')
  caps.maxFileBytes = caps.file ? FILE_MAX_BYTES : 0

  // 语音条发不了、但能发文件时，降级成「当音频文件发」（契约 Caps.voice = 'file'）
  if (caps.voice === false && caps.file) caps.voice = 'file'

  // 表情包当图片发：图片能发就还能发表情包
  caps.sticker = caps.image

  caps.poke = has('poke')
  caps.typing = has('typing')
  caps.recall = has('recall')
  caps.history = has('history')
  caps.memberList = has('members')
  caps.forwardExpand = has('forward')
  return caps
}

/**
 * 探测结果里有哪些动作可用（native() 的白名单用）。
 * 只硬编码 OneBot v11 的**标准动作**：探测失败也不该把「发消息 / 查资料」这条路堵死。
 * 扩展动作（send_poke、set_input_status、delete_msg、set_qq_profile……）**必须探到才放行**，
 * 这正是能力探测的意义：模块调 native 时能得到「当前网关不支持 X」的明确答复。
 */
export function supportedActions(probe) {
  const set = new Set(probe?.supported || [])
  for (const a of ['send_private_msg', 'send_group_msg', 'send_msg', 'get_login_info', 'get_version_info', 'get_status', 'get_friend_list', 'get_group_list', 'get_group_info', 'get_group_member_info', 'get_stranger_info', 'can_send_image', 'can_send_record']) set.add(a)
  return set
}

// ───────────────────────── 缓存（caps.json） ─────────────────────────

export const CAPS_CACHE_VERSION = 1

/** 缓存用的 fs：默认 node:fs，测试可注入假实现（只用到 existsSync / readFileSync / writeFileSync / mkdirSync）。 */
function fsOf(fsImpl) {
  return fsImpl || nodeFs
}

/**
 * 读缓存。任何异常都当「没有缓存」（不能因为缓存坏了就启动失败）。
 * @param {string} file caps.json 完整路径
 * @param {{ fs?: object, log?: object }} [opts]
 */
export function readCapsCache(file, { fs: fsImpl, log } = {}) {
  const f = fsOf(fsImpl)
  try {
    if (!f.existsSync(file)) return null
    const raw = JSON.parse(f.readFileSync(file, 'utf8'))
    if (!raw || raw.v !== CAPS_CACHE_VERSION || !raw.caps) return null
    const caps = {}
    for (const key of Object.keys(CAPS_CONSERVATIVE)) if (raw.caps[key] !== undefined) caps[key] = raw.caps[key]
    // 只认契约里有的取值；缓存里的怪值（比如 voice: 'yes'）丢掉，让它落回保守值
    if (!['native', 'file', false].includes(caps.voice)) delete caps.voice
    if (!['free', 'limited', 'none'].includes(caps.proactive)) delete caps.proactive
    return {
      gateway: raw.gateway && typeof raw.gateway === 'object' ? raw.gateway : {},
      caps: { ...CAPS_CONSERVATIVE, ...caps },
      supported: Array.isArray(raw.supported) ? raw.supported.map(String) : [],
      actions: Array.isArray(raw.actions) ? raw.actions.map(String) : [],
      probedAt: Number(raw.probedAt) || 0,
    }
  } catch (error) {
    log?.debug?.('能力缓存读不出来，忽略：', error?.message || error)
    return null
  }
}

/**
 * 写缓存。写失败只记 debug：缓存是加速用的，不能影响功能。
 * @param {string} file
 * @param {{ gateway?: object, caps?: object, supported?: string[], actions?: string[], probedAt?: number }} payload
 * @param {{ fs?: object, log?: object }} [opts]
 */
export function writeCapsCache(file, payload, { fs: fsImpl, log } = {}) {
  const f = fsOf(fsImpl)
  try {
    const dir = dirnameOf(file)
    if (dir && typeof f.mkdirSync === 'function') f.mkdirSync(dir, { recursive: true })
    const body = {
      v: CAPS_CACHE_VERSION,
      gateway: payload?.gateway || {},
      caps: payload?.caps || {},
      supported: payload?.supported || [],
      actions: payload?.actions || payload?.supported || [],
      probedAt: Number(payload?.probedAt) || Date.now(),
    }
    f.writeFileSync(file, JSON.stringify(body, null, 2), { encoding: 'utf8', mode: 0o600 })
    return true
  } catch (error) {
    log?.debug?.('能力缓存写不进去：', error?.message || error)
    return false
  }
}

/**
 * 缓存里的网关和现在连上的网关是不是同一个版本。
 * 版本读不出来就返回 false（→ 重探），宁多重探一次也别拿旧能力表骗网关。
 */
export function cacheMatchesGateway(cache, gateway) {
  if (!cache?.gateway || !gateway) return false
  const a = String(cache.gateway.version || '')
  const b = String(gateway.version || '')
  if (!a || !b) return false
  return a === b && String(cache.gateway.app || '') === String(gateway.app || '')
}

/** 不引 path 模块：只为了拆目录，Windows 的 \ 与 / 都要认。 */
function dirnameOf(file) {
  const s = String(file || '')
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return i > 0 ? s.slice(0, i) : ''
}
