// Aurabot 多平台：各部分之间的约定（类型）
// 这个文件是唯一的权威。P0 把它原样放进新仓库 src/gateway/contracts.d.ts。
// 改它要单独提 PR，所有在做的包的负责人都看过才合。不许在自己的包里私下加字段。
// 配套的文字规则见同目录《约定.md》。

// ───────────────────────── 1. 地址 ─────────────────────────

/** 平台名：小写字母开头，小写字母 / 数字 / -。例：qq、feishu、telegram */
export type Platform = string
/** 平台实例：同平台多账号时带 #名字，只有一个时写法与 Platform 相同。例：qq、qq#2 */
export type Instance = string
export type ChatKind = 'private' | 'group'

/**
 * 聊天地址：`<实例>:<类型>:<编号>`。例：qq:private:10001、feishu:group:oc_xxx、qq#2:group:123
 * 私聊的编号是对方在该平台的账号（不是 personId）。
 * 另有 `system:<名字>`，是插件内部的后台会话，不属于任何平台，原样保留。
 */
export type ChatId = string

export interface ChatAddress {
  instance: Instance
  platform: Platform
  kind: ChatKind
  /** 平台内的编号：群号、对方账号 */
  id: string
}

/** 这三个函数由 P0 实现在 src/gateway/address.js，全仓库只许用它们处理地址。 */
export interface AddressApi {
  /**
   * 任何形态 → 规范形态。旧写法 private:10001 / group:123 视为 qq:private:10001 / qq:group:123。
   * system:* 原样返回。认不出返回 null。
   */
  normalizeChatId(input: string): ChatId | null
  /** 规范形态 → 拆开。system:* 和认不出的返回 null。 */
  parseChatId(input: string): ChatAddress | null
  /** 两个地址是不是同一个聊天（先各自规范化再比）。禁止用 === 比地址。 */
  sameChat(a: string, b: string): boolean
  /** 拼地址。只有网关和平台端可以调用。 */
  formatChatId(address: ChatAddress): ChatId
}

// ───────────────────────── 2. 人 ─────────────────────────

/**
 * 人的编号。不透明字符串：除了 Identity 模块，任何代码都不许解析它、不许拿它拼地址、
 * 不许用正则判断它「像不像 QQ 号」。从 QQ 版迁来的人是一串数字，其余是 p-xxxxxxxxxxxxxxxx。
 */
export type PersonId = string

export interface Account {
  platform: Platform
  account: string
  /** 备用标识，如飞书 union_id */
  alt?: string
  linkedAt: number
  linkedBy: 'import' | 'owner' | 'code' | 'auto'
}

/** I1 实现，G1 把它挂在 gateway.identity 上。所有方法同步（SQLite 同步接口）。 */
export interface Identity {
  /** 入站用：查到就返回，查不到就新建一个人（linkedBy='auto'）并返回。 */
  resolve(platform: Platform, account: string, hint?: { alt?: string }): PersonId
  /** 只查不建。 */
  lookup(platform: Platform, account: string): PersonId | null
  accountsOf(person: PersonId): Account[]
  /** 出站用：这个人在某平台的账号；没有返回 null。 */
  accountOn(person: PersonId, platform: Platform): string | null
  isValid(value: unknown): value is PersonId

  owner(): PersonId | null
  isOwner(person: PersonId): boolean
  /** 首次配置：把某个账号认作主人。已有主人时抛错，改主人走 link。 */
  claimOwner(platform: Platform, account: string): PersonId

  /** 把一个账号挂到已有的人名下。该账号已属于别人时抛 IdentityConflict，不静默改挂。 */
  link(platform: Platform, account: string, person: PersonId, by: 'owner' | 'code'): void
  unlink(platform: Platform, account: string): void
  /** 一次性口令：在已确认的平台上签发，在新平台上兑换。有效期 10 分钟，用一次作废。 */
  issueCode(person: PersonId): string
  redeemCode(platform: Platform, account: string, code: string): PersonId | null

  /** 导入用：把 QQ 号登记为 (qq, 号) → 号。幂等。 */
  importLegacyQQ(numbers: string[]): { added: number; existing: number }
  /** 合并的最后一步：把 from 名下的账号全部改挂到 into。记忆侧的改挂由 I4 先做完。 */
  repoint(from: PersonId, into: PersonId): { moved: Account[]; conflicts: Account[] }
}

// ───────────────────────── 3. 消息内容 ─────────────────────────

export interface MediaRef {
  /** 四选一至少有一个；平台端收到什么给什么，网关不替它下载 */
  url?: string
  path?: string
  bytes?: Uint8Array
  /** 平台内的文件标识，之后可用 adapter.fetch 换成字节 */
  id?: string
  mime?: string
  md5?: string
  size?: number
  width?: number
  height?: number
  name?: string
}

export type Part =
  | { type: 'text'; text: string }
  /** account='all' 是 @全体。入站时 @机器人自己 不出现在 parts 里，体现在 mentionedMe */
  | { type: 'mention'; account: string; name?: string }
  | { type: 'image'; media: MediaRef }
  /** 表情包。label 是平台给的文字说明（如「[啊？]」）；native 是平台原样重发需要的数据 */
  | { type: 'sticker'; media: MediaRef; label?: string; native?: unknown }
  | { type: 'voice'; media: MediaRef; durationMs?: number }
  | { type: 'video'; media: MediaRef }
  | { type: 'file'; media: MediaRef }
  /** 平台内置小表情，已经换成名字。value 是骰子点数这类结果 */
  | { type: 'face'; name: string; value?: string }
  /** 分享卡片，平台端已经读出标题和链接；读不出就只有 text */
  | { type: 'card'; text: string; title?: string; url?: string; from?: string }
  /** 合并转发，id 之后用 adapter.fetch({ kind: 'forward' }) 展开 */
  | { type: 'forward'; id: string }
  | { type: 'poke' }
  /** 平台端认不出的东西。text 是给她看的占位，如「[闪传文件]」 */
  | { type: 'other'; text: string; native?: unknown }

// ───────────────────────── 4. 入站 ─────────────────────────

/** 平台端交给网关的。平台端不查身份、不拼给模型看的文字。 */
export interface AdapterInbound {
  chat: { kind: ChatKind; id: string; title?: string }
  sender: {
    account: string
    name: string
    /** 群里的身份；私聊是空串 */
    role: 'owner' | 'admin' | 'member' | ''
    alt?: string
  }
  /** 平台内唯一。网关按 实例 + messageId 去重，平台端重连后重复推送不会进中枢两次 */
  messageId: string
  /** 毫秒时间戳，平台给的发送时间 */
  at: number
  replyTo?: string
  mentionedMe: boolean
  parts: Part[]
  /** 平台专属的附加信息（如 QQ 临时会话的来源群）。中枢和记忆不许读，只有绑定该平台的模块可以读 */
  ext?: Record<string, unknown>
  raw: unknown
}

/** 网关交给中枢的。 */
export interface InboundMessage extends Omit<AdapterInbound, 'chat' | 'sender'> {
  v: 1
  instance: Instance
  platform: Platform
  chatId: ChatId
  kind: ChatKind
  chat: { kind: ChatKind; id: string; title?: string }
  sender: AdapterInbound['sender'] & { person: PersonId; isOwner: boolean }
  /** 网关用同一个函数从 parts 拼出来的文字（图片写成「[图片]」等），所有平台口径一致 */
  text: string
  /** 去掉 @全体 之后的文字，判断「是不是在叫她」用 */
  wakeText: string
  /** @ 了别人（既不是她也不是全体） */
  mentionsOthers: boolean
}

/** 消息以外的事。平台没有的事件就不发。 */
export type AdapterEvent =
  | { type: 'poke'; chat: { kind: ChatKind; id: string }; from: string; to: string; raw: unknown }
  | { type: 'recall'; chat: { kind: ChatKind; id: string }; messageId: string; by: string; raw: unknown }
  | { type: 'file'; chat: { kind: ChatKind; id: string }; from: string; media: MediaRef; raw: unknown }
  | { type: 'self-sent'; chat: { kind: ChatKind; id: string }; messageId: string; parts: Part[]; raw: unknown }
  | { type: 'offline'; reason?: string; raw: unknown }
  /** 其余的平台原生事件（加好友申请、入群申请、成员变动……），只转给绑定该平台的模块 */
  | { type: 'native'; name: string; raw: unknown }

// ───────────────────────── 5. 出站 ─────────────────────────

/** 补发队列按它定有效期：proactive 1 分钟，diary 10 分钟，其余 5 分钟（沿用 outbox.js 现有规则） */
export type SendKind = 'reply' | 'proactive' | 'diary' | 'command' | 'module'

export interface OutboundMessage {
  chatId: ChatId
  parts: Part[]
  /** 引用回复哪一条；平台不支持时网关丢掉这个字段 */
  replyTo?: string
  /**
   * 这条是在回应哪条入站消息（那条的 messageId）。和 replyTo 不同：不一定要显示成引用。
   * 有的平台只允许「在收到消息后的一段时间内、带着那条消息的标识」回复（被动回复），
   * 平台端靠它取回复凭证。中枢在回合里发的每一条都要填；主动发言不填。
   */
  inResponseTo?: string
  kind: SendKind
  /** 写日志用的一句话 */
  note: string
  /** 总开关关着也发（命令回复） */
  force?: boolean
  /** 日志里不记正文 */
  sensitive?: boolean
  timeoutMs?: number
}

export interface SendResult {
  messageId: string
  /** 网关做了哪些降级，如 ['voice→file', 'quoteReply dropped'] */
  degraded: string[]
  /** 这次没有真发出去而是进了补发队列 */
  queued?: boolean
}

/**
 * 发送失败。certainty 是整个系统防重复发送的根基：
 *  - 'not-sent'：确定没发出去（没连上、平台明确拒绝）。只有这种可以入队、重试、换方式重发。
 *  - 'unknown'：超时、连接中途断开、响应读不懂。一律不重发。
 * 平台端拿不准时必须填 'unknown'。
 */
export interface SendError extends Error {
  certainty: 'not-sent' | 'unknown'
  /** 平台的错误码或短标签，写日志用 */
  code?: string
  instance: Instance
}

// ───────────────────────── 6. 能力表 ─────────────────────────

export interface Caps {
  image: boolean
  sticker: boolean
  /** native 语音条 / file 只能当音频文件发 / false 发不了 */
  voice: 'native' | 'file' | false
  video: boolean
  file: boolean
  /** 单个文件上限，字节；0 表示不能发文件 */
  maxFileBytes: number
  quoteReply: boolean
  mention: boolean
  mentionAll: boolean
  poke: boolean
  typing: boolean
  recall: boolean
  card: boolean
  /** 能不能收到群里没 @ 她的消息。false 时中枢在这个平台的群里只做「被叫必回」 */
  listenAllInGroup: boolean
  /**
   * 不是在回应某条消息时能不能发：
   *  free 随便发 / limited 有次数或对象限制，平台端自己记账，超了抛 SendError('not-sent', code:'proactive-limit')
   *  / none 只能被动回复
   */
  proactive: 'free' | 'limited' | 'none'
  /** 被动回复的时限，毫秒；0 表示没有时限。过了时限的回复按主动消息算 */
  replyWindowMs: number
  /** 一条入站消息最多能回几条；0 表示不限 */
  repliesPerMessage: number
  history: boolean
  memberList: boolean
  forwardExpand: boolean
}

// ───────────────────────── 7. 平台端 ─────────────────────────

export type ConnState = 'unconfigured' | 'connecting' | 'connected' | 'disconnected' | 'stopped'

export interface AdapterContext {
  instance: Instance
  /** 这个实例在 config.platforms 里的那一段（已去掉 enabled） */
  config(): Record<string, any>
  emit(message: AdapterInbound): void
  emitEvent(event: AdapterEvent): void
  state(state: ConnState, detail?: string): void
  /** 探测后能力变了（如换了一个 OneBot 网关）就调它，网关重新读 caps */
  capsChanged(): void
  log: { debug(...a: any[]): void; info(...a: any[]): void; warn(...a: any[]): void; error(...a: any[]): void }
  /** 这个平台端自己的数据目录 */
  dataDir(...parts: string[]): string
  /**
   * 给靠回调地址收事件的平台用：在插件的 HTTP 服务上挂一个路径，返回撤掉函数。
   * 实际路径是 /platform/<实例>/<path>。验签由平台端自己做，验不过必须拒绝且不 emit。
   */
  route(path: string, handler: (req: any, res: any) => any): () => void
}

export type FetchRequest =
  | { kind: 'media'; media: MediaRef }
  | { kind: 'forward'; id: string }
  | { kind: 'history'; chat: { kind: ChatKind; id: string }; count: number; before?: string }
  | { kind: 'member'; chat: { kind: ChatKind; id: string }; account: string }
  | { kind: 'members'; chat: { kind: ChatKind; id: string } }
  | { kind: 'chats' }

export interface PlatformAdapter {
  id: Platform
  name: string
  /** 按哪一版契约写的。现在是 1 */
  contract: 1
  caps(): Caps
  /** 面板表单，写法与模块的 settings 相同 */
  settings: any[]
  start(ctx: AdapterContext): Promise<void>
  stop(): Promise<void>
  /** 连上后核对「登录的是不是配置里的那个机器人」。不是就由网关断开这个实例 */
  whoami(): Promise<{ account: string; name: string }>
  /**
   * 网关已经按 caps 降级过，parts 里只会有这个平台声明支持的类型。
   * 失败必须抛 SendError；抛别的错误网关一律当 'unknown' 处理。
   */
  send(message: { chat: { kind: ChatKind; id: string }; parts: Part[]; replyTo?: string; inResponseTo?: string; timeoutMs?: number; ext?: Record<string, unknown> }): Promise<{ messageId: string }>
  fetch?(request: FetchRequest): Promise<any>
  /**
   * 把本平台的原生消息格式转成 parts。QQ 端用它接住旧接口 sendSegments 传进来的 OneBot 消息段，
   * 这样核心不用引用平台端的代码。没有原生格式要兼容的平台不用实现。
   */
  toParts?(nativeMessage: unknown): Part[]
  /** 平台独有的本事。只有声明了 platforms 含本平台的模块能经 api.native 调到这里 */
  native?(action: string, params?: any, opts?: { timeoutMs?: number }): Promise<any>
}

// ───────────────────────── 8. 网关 ─────────────────────────

export interface InstanceStatus {
  instance: Instance
  platform: Platform
  name: string
  enabled: boolean
  state: ConnState
  detail?: string
  self?: { account: string; name: string }
  caps: Caps | null
}

/** G1 实现。中枢、模块内核、面板只通过它和平台打交道。 */
export interface Gateway {
  /** 注册一种平台。只有内置平台端和声明了 platform 能力的平台模块可以调用 */
  register(factory: () => PlatformAdapter): () => void
  /** 按 config.platforms 启停实例；配置变了再调一次，只动有变化的实例 */
  sync(): Promise<void>
  instances(): InstanceStatus[]

  onMessage(fn: (message: InboundMessage) => void): () => void
  onEvent(fn: (event: AdapterEvent & { instance: Instance; platform: Platform; chatId?: ChatId }) => void): () => void
  onState(fn: (status: InstanceStatus) => void): () => void

  /**
   * 唯一的出站口。做的事按顺序：规范化地址 → 查实例是否在线 → 按 caps 降级 → 调平台端 →
   * 'not-sent' 且可入队的进补发队列。总开关、试运行、清洗、send 钩子仍由中枢在调用前做。
   * 实例没启用时抛 SendError('not-sent')。
   */
  send(message: OutboundMessage): Promise<SendResult>
  caps(chatIdOrInstance: string): Caps | null
  fetch(chatIdOrInstance: string, request: FetchRequest): Promise<any>
  native(instance: Instance, action: string, params?: any, opts?: { timeoutMs?: number }): Promise<any>
  /** 转给该实例平台端的 toParts；平台端没实现时抛错 */
  toParts(chatIdOrInstance: string, nativeMessage: unknown): Part[]

  /** 她主动找一个人时发到哪：这个人固定的平台 > 最近说过话的平台 > 任一在线的平台；proactive 为 none 的平台不参与。没有返回 null */
  routeTo(person: PersonId): ChatId | null
  /** 中枢每收到一条私聊消息调一次，路由据此知道「最近在哪说过话」 */
  noteSeen(person: PersonId, chatId: ChatId, at: number): void

  identity: Identity
  outbox: { status(): { count: number; oldestAt: number }; flush(instance?: Instance): Promise<{ sent: number; dropped: number; left: number }> }
}

// ───────────────────────── 9. 配置 ─────────────────────────

export interface PlatformsConfig {
  /**
   * 键是实例名。同一个平台可以开多个实例（qq、qq#2），网关从第一版起就按实例管理。
   * 实例名里 # 前面的部分是平台名，默认也决定用哪个平台端（可用 adapter 另行指定）。
   */
  [instance: string]: InstanceConfig
}

export interface InstanceConfig {
  enabled: boolean
  /**
   * 用哪个平台端来跑这个实例。不写就是实例名里 # 前面的部分（qq#2 → qq）。
   * 写了就可以让平台名和平台端不同名：`"mychat": { "adapter": "bridge" }` 表示
   * 平台叫 mychat（地址、身份表里都用这个名字），由通用接入端 bridge 来跑。
   * 这种写法下，实例名的前缀不许等于任何已注册平台端的 id，否则可以冒充那个平台上的人。
   */
  adapter?: string
  /**
   * 用户手动关掉这个实例的某些能力。只能往「更弱」改：把 true 改成 false、native 改成 file、
   * free 改成 limited 或 none。想打开平台端没声明的能力无效。网关把它叠在平台端的 caps() 上。
   */
  caps?: Partial<Caps>
  /** 这个实例上她的行为开关，全部可选，不写就用全局设置 */
  behavior?: {
    /** 群里没人叫时插不插话 */
    interject?: boolean
    /** 允不允许她在这个实例上主动找人 */
    proactive?: boolean
    /** 这个实例上的群消息进不进群记忆 */
    rememberGroups?: boolean
    /** 新聊天默认开放还是默认关闭 */
    openByDefault?: boolean
  }
  /** 其余键是平台端自己的设置，由它的 settings 声明 */
  [key: string]: any
}
/**
 * config.json 里新增 platforms。旧字段读入时自动换算，写回时只写新字段：
 *   gateway + snowluma.{httpUrl,wsUrl,httpToken,wsToken,dir,…}  →  platforms.qq.{backend,…}
 *   旧配置 QQ 号 → 启动时 identity.claimOwner('qq', rawOwner)（已有主人则跳过）
 */
