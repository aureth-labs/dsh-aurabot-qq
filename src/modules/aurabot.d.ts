// Aurabot 扩展模块的类型提示（插件每次启动会更新这个文件，别改它）。
// 用法：在模块入口文件 export default 的上一行写
//   /** @type {import('../aurabot').AurabotModule} */
// VS Code 等编辑器就会给 api.* 补全和参数说明。完整说明见同目录的 API.md。

export type Platform = 'qq' | 'feishu' | 'qqbot' | 'bridge' | (string & {})

export type ChatId =
  | `private:${string}`
  | `group:${string}`
  | `system:${string}`
  | `${string}:private:${string}`
  | `${string}:group:${string}`

export type Part =
  | { type: 'text'; text: string }
  | { type: 'image'; file?: string; url?: string; base64?: string; width?: number; height?: number }
  | { type: 'sticker'; id?: string; file?: string; url?: string; name?: string }
  | { type: 'voice'; file?: string; url?: string; base64?: string; durationMs?: number }
  | { type: 'video'; file?: string; url?: string; durationMs?: number }
  | { type: 'file'; file?: string; url?: string; name?: string; size?: number }
  | { type: 'mention'; userId?: string; name?: string; all?: boolean }
  | { type: 'face'; id: string; name?: string }
  | { type: 'reply'; messageId: string }
  | { type: 'card'; title: string; summary?: string; url?: string; image?: string }
  | { type: 'raw'; platform: string; data: unknown }

export interface Caps {
  image: boolean
  sticker: boolean
  voice: 'native' | 'file' | false
  video: boolean
  file: boolean
  maxFileBytes: number
  quoteReply: boolean
  mention: boolean
  mentionAll: boolean
  poke: boolean
  typing: boolean
  recall: boolean
  card: boolean
  listenAllInGroup: boolean
  proactive: 'free' | 'limited' | 'none'
  replyWindowMs: number
  repliesPerMessage: number
  history: boolean
  memberList: boolean
  forwardExpand: boolean
}

export interface InstanceStatus {
  instance: string
  platform: Platform
  name: string
  enabled: boolean
  state: 'stopped' | 'connecting' | 'connected' | 'reconnecting' | 'error'
  detail?: string
  self?: { account: string; name?: string } | null
  caps: Caps | null
}

export interface OutboundSendOpts {
  note?: string
  kind?: 'reply' | 'proactive' | 'diary'
  replyTo?: string
  inResponseTo?: string
  force?: boolean
  sensitive?: boolean
  throwOnError?: boolean
  timeoutMs?: number
  [key: string]: any
}

export interface Chat {
  chatId: ChatId
  kind: 'private' | 'group' | 'system'
  platform?: Platform
  userId?: string
  groupId?: string
  title?: string
}

/** 收到的一条消息（已解析）。 */
export interface Message {
  kind: 'private' | 'group'
  chatId: ChatId
  platform: Platform
  instance: string
  userId: string
  groupId: string
  nickname: string
  /** 在群里的身份：owner / admin / member，私聊是空串 */
  role: string
  messageId: string
  text: string
  /** 标准化消息段 */
  parts: Part[]
  /** 已核对的跨平台统一身份；未认领或未启用身份库时为 null */
  person: string | null
  /** @ 了她 */
  mentioned: boolean
  /** 引用的那条消息 id */
  replyId: string
  images: any[]
  stickers: any[]
  records: any[]
  forwards: any[]
  /** 原始平台事件 */
  raw: any
}

/** 拆好的一条回复。 */
export interface ReplyItem {
  kind: 'text' | 'voice' | 'sticker' | 'poke' | 'image'
  value: any
  /** 群里引用回复的编号 */
  replyTo?: string
}

/** OneBot v11 消息段，比如 { type: 'text', data: { text: '你好' } } */
export interface Segment { type: string; data: Record<string, any> }

export interface GroupDecision {
  reply: boolean
  /** must 被叫到必须回 / engaged 正在参与话题 / interject 插话 */
  mode?: 'must' | 'engaged' | 'interject'
  reason?: string
}

export interface ModelSelection { provider: string; model: string; reasoningEffort?: string }

/** 工具生成函数拿到的「在哪儿」。 */
export interface Where {
  chat: Chat
  /** full 主人私聊 / social 群聊和别人 */
  level: 'full' | 'social' | 'chat'
  sessionId: string
}

export interface Tool {
  name: string
  description: string
  parameters: any
  output: any
  execute(args: any, exec?: any): Promise<any>
}

export interface ToolSpec {
  name: string
  description: string
  /** 参数（JSON Schema 的 properties） */
  properties?: Record<string, any>
  required?: string[]
  /** 返回 { ok, message }：message 是给她看的结果 */
  execute(args: any, exec?: any): any | Promise<any>
}

export interface Command {
  name: string
  aliases?: string[]
  desc?: string
  /** 日志只记录命令名，发送失败时结束本次回执。 */
  sensitive?: boolean
  /** 返回的文字直接回给主人 */
  run(arg: string, msg: Message): string | void | Promise<string | void>
}

export interface Logger {
  debug(...a: any[]): void
  info(...a: any[]): void
  warn(...a: any[]): void
  error(...a: any[]): void
}

export type Off = () => void

/** 同一人物、同一聊天的原话；assistant 不是用户事实。 */
export interface ConversationMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  speakerId: string
  /** Unix milliseconds */
  at: number
  /** 原文进入本轮的时间；忘记请求也过滤仍在生成的旧上下文回复。 */
  contextAt?: number
}

/** 已落盘的聊天流水；与现有每日 JSONL 使用同一结构。 */
export interface ChatLogRow {
  t: number
  chatId: string
  who: string
  text: string
  uid?: string
  via?: string
  interaction?: string[]
  forgottenAt?: number
  /** 仅实时通知携带，不写入流水，用于来源端去重。 */
  originId?: string
  [key: string]: any
}

export interface OwnerMessageOptions {
  text?: string
  image?: Buffer
  /** PCM WAV；按现有 ASR 配置识别。 */
  wav?: Buffer
  /** 外部来源标签，最多 40 字；不改变聊天与记忆归属。 */
  via?: string
  /** 来源端的不透明标记，只进入实时通知。 */
  originId?: string
  /** 同步鉴权检查；入口、媒体准备完成、模型投递前都会调用，撤销时应抛错。 */
  assertAuthorized?: () => unknown
}

export interface ChatHub {
  [key: string]: any
  sessions(): Record<string, { sessionId: string; title?: string; [key: string]: any }>
  chatLogDays(): string[]
  chatLogOf(day: string): ChatLogRow[]
  /** 仅供已经验证主人身份的模块使用；仅接收已有且开放的 private/group 会话。 */
  receiveOwnerMessage(chatId: string, options?: OwnerMessageOptions): Promise<{ ok: true }>
}

export interface MediaAccess {
  mimeOf(bytes: Buffer): string
  /** 当前自定义头像，缺省使用插件默认头像；不返回文件路径。 */
  avatar(): { bytes: Buffer; type: string } | null
  /** 按当前运行的表情库精确匹配 md5；不存在或不是图片时返回 null。 */
  sticker(md5: string): { bytes: Buffer; type: string } | null
  /** 使用现有 ffmpeg 配置和本机探测；无可用程序时为空。 */
  ffmpegPath(): string
  parseWav(bytes: Buffer): { rate: number; channels: number; data: Buffer }
  toMono16k(bytes: Buffer): Buffer
}

/** 事件 → 监听函数的样子。返回值的意义见 API.md「事件」。 */
export interface Events {
  /** 返回 true = 接管这条消息，她不再处理 */
  message: (msg: Message) => boolean | void | Promise<boolean | void>
  /** 她要说的整段话：返回新文字改写，null 不发 */
  reply: (text: string, info: { chatId: ChatId; userText: string }) => string | null | void | Promise<string | null | void>
  /** 拆好的每一条（已经决定了哪条发语音、配不配表情）：返回新数组改写，null 不发 */
  'reply/items': (items: ReplyItem[], info: { chatId: ChatId; text: string; userText: string }) => ReplyItem[] | null | void | Promise<ReplyItem[] | null | void>
  /** 最终发给 QQ 的消息段（所有发送都经过这里，包括命令回复、模块发的）：返回新数组改写，null 不发 */
  send: (message: Segment[], info: { chatId: ChatId; note: string; force: boolean }) => Segment[] | null | void | Promise<Segment[] | null | void>
  /** 群里这条消息她回不回：返回对象覆盖决定，比如 { reply: true, mode: 'must' }（返回 null 无效，等于不改） */
  'group/decide': (decision: GroupDecision, info: { msg: Message; policy: any; recentTexts: string[]; memScore: number }) => Partial<GroupDecision> | void | Promise<Partial<GroupDecision> | void>
  /** 交给她的内容（[{ type: 'text', text }, { type: 'image', ... }]）：返回新数组改写，null 这次不交给她 */
  prompt: (content: any[], info: { chat: Chat; senderId: string; queryText?: string; sessionId: string; prevText: string; recentMessages: ConversationMessage[] }) => any[] | null | void | Promise<any[] | null | void>
  /** 这个聊天用哪个模型（同步）：返回 { provider, model, reasoningEffort } */
  model: (selection: ModelSelection | null, chat: Chat) => ModelSelection | void
  /** 她的人格全文（同步）：返回新文字改写 */
  persona: (text: string) => string | void
  /** 她的规则全文（同步）：返回新文字改写 */
  rules: (text: string, kind: 'private' | 'social') => string | void
  /** 有人戳她：返回 true = 接管 */
  poke: (event: any) => boolean | void | Promise<boolean | void>
  /** 收到的消息 / 她发出去的话（只看） */
  activity: (a: { kind: 'in' | 'out'; chatId: ChatId; userId?: string; nickname?: string; text?: string; reply?: string; direct?: boolean; owner?: boolean }) => void
  /** 每条成功落盘后的流水快照；只看不改，调试模式不产生此事件。 */
  'chat/log': (row: ChatLogRow) => void
  /** 平台实例状态变化（只对声明了对应平台或 ['*'] 的模块派发） */
  'platform/state': (status: InstanceStatus) => void
  /** 所有原始 OneBot 事件（仅限声明 'qq' 的模块且已启用 QQ；只看不改，不管白名单） */
  onebot: (event: any) => void
  /** QQ 网关连接状态变化（仅限声明 'qq' 的模块且已启用 QQ） */
  'onebot/state': (state: string) => void
  config: (cfg: any, before: any) => void
  'module/start': (id: string) => void
  'module/stop': (id: string) => void
  'song/sung': (info: { title: string; chatId: ChatId }) => void
  [custom: string]: (...args: any[]) => any
}

/** 平台是工具；确认平台账号对应的 QQ 后，才能写入和读取同一份私聊记忆。 */
export interface MemoryModule {
  [key: string]: any
  /** 不再记住由 profiles[qq].noMemory 控制；主人始终返回 true。 */
  remembers(qq: string | number): boolean
  /** 从直接互动流水、QQ 好友和个人白名单识别是否有交集。 */
  isAcquainted(qq: string | number): boolean
  deletePerson(qq: string | number, options?: { keepNoMemory?: boolean }): { ok: boolean; message: string; marked?: number }
  setNoMemory(qq: string | number, enabled: boolean, options?: { deleteExisting?: boolean }): { ok: boolean; message: string }
  /** 外部视频、帖子、网页用 seen；省略 kind 仍是原有做过的事。source 固定 event，仍存 items。
   * seen 不作为事实、画像或相处经验来源，也不挂到 about 人物名下。 */
  addEvent(args: {
    text?: string; about?: string; aboutName?: string; tags?: string[]; importance?: number
    saidAt?: number; chatId?: string; kind?: 'seen'
    /** 仅保留这些字段，长度上限依次为 160 / 80 / 500 / 40 / 100 字符。 */
    meta?: { title?: string; author?: string; url?: string; platform?: string; id?: string | number }
  }): { ok: boolean; message?: string; id?: string; updated?: string }
  /** 事实时间段可选；开始默认 saidAt；旧 invalidAt 读取时作为 validUntil。 */
  add(args: { text: string; about?: string; aboutName?: string; chatId?: string; source?: string; importance?: number; tags?: string[]; saidAt?: number; validFrom?: number | string; validUntil?: number | string; [key: string]: any }): { ok: boolean; id?: string; updated?: string; message?: string }
  update(id: string, patch: { text?: string; validFrom?: number | string | null; validUntil?: number | string | null; [key: string]: any }): { ok: boolean; item?: any; message?: string }
  timeline(filters?: { kind?: 'gist' | 'seen'; platform?: string; chatId?: string; level?: number | string; about?: string }): Array<{ id: string; kind: 'gist' | 'seen'; platforms: string[]; displayText: string; [key: string]: any }>
  /** 接聊天平台时用 noteVia；确认身份后写入同一个 QQ 的私聊流水，短期状态自动生效。 */
  noteVia(args: { via: string; qq: string | number; who: 'user' | 'bot'; text: string; at?: number }): { ok: boolean }
  contextVia(args: { qq: string | number; query?: string }): string
}

export interface Api {
  id: string
  source: 'builtin' | 'user'
  /** 模块自己的文件夹（读自带的数据文件用；import.meta.url 指向加载快照） */
  dir: string
  apiVersion: number
  /** 插件版本 */
  version: string
  log: Logger

  // ---- 配置 ----
  config(): any
  setConfig(patch: any | ((cfg: any) => any)): any
  settings(): Record<string, any>
  saveSettings(patch: Record<string, any>): Record<string, any>
  dataDir(...parts: string[]): string

  // ---- 发消息 ----
  send(chatId: ChatId | string, text: string): Promise<any>
  sendText(chatId: ChatId | string, text: string): Promise<any>
  /** 回某一条消息：群里以「引用回复」发出（对方能看到在回他），私聊直接发 */
  reply(msg: Message, text: string): Promise<any>
  /** 这个账号（按当前平台上下文）或 PersonId 是不是主人 */
  isOwner(userId: string | number | Record<string, any>, platform?: Platform): boolean
  sendImage(chatId: ChatId | string, src: string): Promise<any>
  /** 发文件：本机绝对路径，或网关能取到的网址 / base64://（网关看不到本机路径时，小文件会自动改用 base64） */
  sendFile(chatId: ChatId | string, file: string, name?: string): Promise<any>
  /** 把本机音频文件当语音条发出去 */
  sendVoiceFile(chatId: ChatId | string, file: string, note?: string): Promise<any>
  /** 统一多平台发送（经出站清洗与策略门闸，底层走 gateway.send） */
  sendParts(chatId: ChatId | string, parts: Part[], opts?: OutboundSendOpts): Promise<any>
  /** 从 chatId 解析平台名（例如 'qq' / 'feishu' / 'qqbot'），无法识别返回 '' */
  platformOf(chatId: ChatId | string): Platform | ''
  /** 查询当前聊天所属平台实例的能力表，实例未启动或不支持返回 null */
  caps(chatId: ChatId | string): Caps | null
  /** 调用指定平台专有原生动作（必须在模块 platforms 里显式声明该平台） */
  native(platform: Platform, action: string, params?: any, opts?: { timeoutMs?: number; [key: string]: any }): Promise<any>
  /** @deprecated 仅 QQ 兼容；请改用 api.sendParts */
  sendSegments(chatId: ChatId | string, segments: Segment[], note?: string): Promise<any>
  /** @deprecated 仅 QQ 兼容；请改用 api.native('qq', ...) */
  onebot(action: string, params?: any, opts?: { timeoutMs?: number }): Promise<any>

  // ---- 模型 ----
  ask(opts: string | { system?: string; text: string; maxTokens?: number }): Promise<string>
  think(prompt: string, opts?: { title?: string; timeoutMs?: number }): Promise<string>

  // ---- 往插件里加东西（都返回撤掉函数）----
  on<K extends keyof Events>(event: K, fn: Events[K]): Off
  emit(event: string, ...args: any[]): void
  tool(builder: Tool | Tool[] | ((where: Where) => Tool | Tool[] | null | undefined)): Off
  defineTool(spec: ToolSpec): Tool
  context(fn: (args: { chat: Chat; sessionId: string }) => string | void): Off
  rule(fn: string | ((kind: 'private' | 'social', cfg: any) => string | string[] | void)): Off
  command(c: Command): Off
  every(ms: number, fn: () => any, label?: string): Off
  later(ms: number, fn: () => any): Off
  /** access: panel 使模块管理路由复用宿主回环/可信代理、Host 与 CSRF 闸。 */
  route(path: string, handler: (req: any, res: any) => any, options?: { access?: 'panel' }): Off
  onDispose(fn: () => void): Off

  // ---- 别的模块和插件内部 ----
  use(id: 'memory'): MemoryModule | null
  use<T = any>(id: string): T | null
  lazy<T = any>(id: string): Partial<T>
  has(id: string): boolean
  core: {
    hub: ChatHub
    gateway?: any
    media: MediaAccess
    /** @deprecated 仅 QQ 兼容；请改用 api.native('qq', ...) 与 api.on('platform/state', ...) */
    onebot: { call(action: string, params?: any, opts?: any): Promise<any>; state: string }
    /** @deprecated 仅 QQ 兼容 */
    snowluma: any
    local: any
    groupRoles: any
    mutes: { muted(chatId: string): boolean; set(chatId: string, minutes: number): void; clear(chatId: string): void }
    logger: any
    ask(opts: any): Promise<string>
    listModels(): Promise<{ provider: string; model: string; name: string }[]>
    defaultModel(): ModelSelection | null
    http: { body(req: any): Promise<any>; raw(req: any, max: number): Promise<Buffer>; query(req: any): Record<string, string>; send(res: any, code: number, body: any, type?: string): void }
    personas: any
    modules: any
    root: string
    getConfig(): any
    setConfig(cfg: any): any
  }
  /** DSH 给插件的 ctx：dsh.get('服务名') 拿 DSH 的任何服务 */
  dsh: any
  /** 插件内部任何一个源码文件导出的东西：lib('features/memory.js') */
  lib(path: string): any
}

export interface Setting {
  key: string
  label?: string
  type?: 'text' | 'number' | 'switch' | 'select' | 'textarea' | 'password'
  hint?: string
  placeholder?: string
  min?: number
  max?: number
  step?: number
  options?: (string | { value: any; label: string })[]
}

export interface AurabotModule {
  /** 小写字母开头，小写字母 / 数字 / -；和文件夹名一样。和内置模块同名 = 替换它 */
  id: string
  name?: string
  version?: string
  /** 按哪一版扩展接口写的 */
  api?: 1 | 2 | number
  /** 声明支持的平台（例如 ['qq']、['qq', 'feishu'] 或 ['*'] 平台无关）；缺省为 ['qq'] */
  platforms?: (Platform | '*')[]
  description?: string
  defaults?: Record<string, any>
  settings?: Setting[]
  /** 自己画面板：模块文件夹里的文件名（默认 panel.js） */
  panel?: string | boolean
  /** 设置和面板放进哪个内置标签页（比如 'song'），不写就单独一页 */
  tab?: string
  /** 独立面板所在的导航分组，例如 'market' 对应「模块」。 */
  navGroup?: string
  /** 标签页状态点看哪个设置（相对这个模块的设置，比如 'loggedIn'）。不写时有 enabled 设置就看它，否则不显示点 */
  flag?: string
  setup(api: Api): any
}
