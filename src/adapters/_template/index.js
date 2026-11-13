// 平台端最小模板：接一个新平台时复制这个目录改名，把「模拟平台」换成真实客户端。
//
// 来源：P0 工作包（Aurabot 多平台化）。许可：MIT（随本仓库）。
// 作用：示范一个符合 PlatformAdapter 契约的平台端长什么样——
//       启停、whoami、入站翻译、出站发送、错误分类、验签回调，全都给最小实现。
// 契约：src/gateway/contracts.d.ts（唯一权威）＋ docs/CONTRACTS.md 第六～八节。
//
// 这个模板没有真实平台可连，内置了一个极小的「模拟平台」（adapter.platform），
// 只用于跑 test/contract/adapter-kit 的通用测试包。真实平台端把它删掉，
// 换成自己的 HTTP / WebSocket 客户端即可，其余骨架不用动。

// ───────────────────────── 错误分类 ─────────────────────────

/**
 * 造一个 SendError。契约要求：certainty='not-sent'（确定没发出去，可以入队重试）或
 * 'unknown'（超时、连接中途断开、读不懂响应，一律不重发）。拿不准必须填 'unknown'。
 * 网关的 errors.js 还没实现（G1 的活），这里先用普通 Error 挂上字段，形状与契约一致。
 */
function sendError(certainty, code, instance, message) {
  const error = new Error(message || `发送失败（${certainty}${code ? ' / ' + code : ''}）`)
  error.certainty = certainty
  if (code) error.code = code
  error.instance = instance
  return error
}

// ───────────────────────── 平台原生格式（模板自己定义的，真实平台换成它的文档格式）─────────────────────────
//
// 模拟平台推来的原生消息长这样：
//   {
//     message_id: 'm-1',            平台内唯一
//     time: 1700000000000,          毫秒时间戳
//     chat_type: 'group' | 'private',
//     chat_id: '888',  chat_title?: '群名',
//     user_id: '10001', nickname: '张三', role?: 'owner' | 'admin' | 'member',
//     at_me?: true,                 @ 了机器人自己
//     reply_to?: 'm-0',
//     segments: [ { type: 'text', text: '嗨' }, { type: 'image', url: 'https://…' }, { type: 'at', account: '10002' } ]
//   }

/** 原生消息段 → 契约的 Part。翻译只做格式转换，不拼给模型看的文字（那是网关 renderParts 的活）。 */
function toParts(segments) {
  const parts = []
  for (const seg of segments || []) {
    switch (seg?.type) {
      case 'text': parts.push({ type: 'text', text: String(seg.text ?? '') }); break
      case 'image': parts.push({ type: 'image', media: { url: seg.url, mime: seg.mime } }); break
      case 'at': parts.push({ type: 'mention', account: String(seg.account ?? ''), name: seg.name }); break
      case 'face': parts.push({ type: 'face', name: String(seg.name ?? '表情') }); break
      // 认不出的：给一个占位，别丢信息
      default: parts.push({ type: 'other', text: `[${seg?.type || '未知'}]`, native: seg })
    }
  }
  return parts
}

/** 契约的 Part → 平台原生消息段（出站方向）。网关已经按 caps 降级过，这里只处理声明支持的类型。 */
function fromPart(part) {
  switch (part.type) {
    case 'text': return { type: 'text', text: part.text }
    case 'image': return { type: 'image', url: part.media?.url || '' }
    case 'mention': return { type: 'at', account: part.account, name: part.name }
    case 'sticker': return { type: 'image', url: part.media?.url || '' } // 表情包当图片发
    case 'voice': return { type: 'voice', url: part.media?.url || '' }
    case 'video': return { type: 'video', url: part.media?.url || '' }
    case 'file': return { type: 'file', url: part.media?.url || '', name: part.media?.name }
    case 'poke': return { type: 'poke' }
    case 'card': return { type: 'card', text: part.text, title: part.title, url: part.url }
    // 兜底：网关保证只送声明支持的类型，真遇到不认识的，留个占位并原样带上，方便排查
    default: return { type: 'other', native: part }
  }
}

/**
 * 建一个模板平台端。
 * options：
 *   id          平台名（默认 'template'）
 *   name        显示名（默认 '模板'）
 *   self        { account, name } 模拟登录的机器人账号
 *   token       回调验签口令（模拟平台回调头 x-template-signature 必须等于它才放行）
 *   capsOverride 覆盖默认 caps（测试用来切 proactive 等）
 */
export function createTemplateAdapter(options = {}) {
  const id = options.id || 'template'
  const instance = id // 单实例模板：实例名与平台名相同；多实例由网关按实例调 start
  const self = { account: options.self?.account || 'template-bot', name: options.self?.name || '模板机器人' }
  const token = options.token || 'template-token'
  // 运行期状态：模板用闭包变量就够了；真实平台端这里放你的客户端对象
  let ctx = null // AdapterContext，start 时给
  let running = false
  let connected = false
  let offs = [] // route 的撤掉函数等，stop 时统一清理
  // inResponseTo → 入站时间：被动回复时限用（replyWindowMs > 0 时才需要）
  const seenAt = new Map()
  // 模拟的发送故障：'refused' 连不上 / 'timeout' 超时，各注入一次后清掉
  let failSend = null
  // caps 手动覆盖（模拟「探测后能力变了」）
  let capsOverride = options.capsOverride || null

  // 默认能力表：caps() 必须说真话（CONTRACTS 第八节）。真实平台连不上对面时按最保守报。
  const baseCaps = () => ({
    image: true,
    sticker: true,
    voice: 'native',
    video: true,
    file: true,
    maxFileBytes: 10 * 1024 * 1024,
    quoteReply: true,
    mention: true,
    mentionAll: true,
    poke: true,
    typing: false,
    recall: true,
    card: true,
    listenAllInGroup: true,
    proactive: 'free',
    replyWindowMs: 0,
    repliesPerMessage: 0,
    history: false,
    memberList: false,
    forwardExpand: false,
  })

  // ───────────────────────── 模拟平台（测试专用，真实平台端删掉整段换真实客户端）─────────────────────────
  // 推送口：平台把一条原生消息递进来 → 平台端翻译成 AdapterInbound 后 ctx.emit
  const deliver = (native) => {
    if (!running || !connected || !ctx) return false // 没连上就收不到：这是平台侧行为，不是平台端要 dedupe
    ctx.emit({
      chat: { kind: native.chat_type === 'group' ? 'group' : 'private', id: String(native.chat_id), title: native.chat_title },
      sender: {
        account: String(native.user_id),
        name: String(native.nickname ?? ''),
        role: native.role || (native.chat_type === 'group' ? 'member' : ''),
        alt: native.alt,
      },
      messageId: String(native.message_id),
      at: Number(native.time) || Date.now(),
      replyTo: native.reply_to ? String(native.reply_to) : undefined,
      mentionedMe: Boolean(native.at_me),
      parts: toParts(native.segments),
      raw: native,
    })
    if (native.message_id != null) seenAt.set(String(native.message_id), Number(native.time) || Date.now())
    return true
  }

  const platform = {
    /** 模拟平台 WS 推一条原生消息。返回是否送达（没连上时 false）。 */
    deliver,
    /** 模拟平台 HTTP 回调的说明：真实调用走 ctx.route 挂的 handler（测试 harness 直接调它，见 adapter-kit 文件头）。 */
    __routeHandler: null,
    /** 模拟断线：状态到 disconnected，之后 deliver 不生效。 */
    break() {
      connected = false
      if (ctx) ctx.state('disconnected', '模拟断线')
    },
    /** 模拟重连。 */
    restore() {
      connected = true
      if (ctx) ctx.state('connected')
    },
    /** 下一次平台侧 send 模拟「连不上」。 */
    refuseNext() { failSend = 'refused' },
    /** 下一次平台侧 send 模拟「一直不返回」（平台端超时 → unknown）。 */
    hangNext() { failSend = 'timeout' },
    /** 换 caps 覆盖并通知网关能力变了（模拟探测后能力变化）。 */
    setCapsOverride(partial) {
      capsOverride = { ...(capsOverride || {}), ...partial }
      if (ctx) ctx.capsChanged()
    },
  }

  // ───────────────────────── PlatformAdapter ─────────────────────────

  const adapter = {
    id,
    name: options.name || '模板',
    contract: 1,

    /** 能力表。说真话：能力取决于对面网关时，连上探测，探测完调 ctx.capsChanged()。 */
    caps() {
      return { ...baseCaps(), ...(capsOverride || {}) }
    },

    /** 面板表单。写法与模块的 settings 相同（见 src/modules 里的模块）。 */
    settings: [
      { key: 'proactive', label: '主动消息', type: 'select', options: ['free', 'limited', 'none'], default: 'free', description: 'none = 只能被动回复（接平台限流时用）' },
      { key: 'token', label: '回调验签口令', type: 'password', default: token, description: '平台回调必须带上正确的签名才放行' },
    ],

    /** 启动：连平台 → 报状态 → 挂回调路由。失败要抛错，网关会把它记成启动失败。 */
    async start(context) {
      if (running) return
      ctx = context
      running = true
      ctx.state('connecting')
      // 真实平台端：在这里连接你的 HTTP/WS 服务；连不上就抛错（网关当启动失败）
      // 模拟平台：直接当连上了
      connected = true
      // 读配置里的 proactive / token（网关把实例 config 原样给 ctx.config()）
      const cfg = ctx.config() || {}
      if (cfg.proactive && cfg.proactive !== capsOverride?.proactive) {
        capsOverride = { ...(capsOverride || {}), proactive: cfg.proactive }
      }
      // 靠回调地址收事件的平台在这里挂路由：验签由平台端自己做，验不过必须拒绝且不 emit（CONTRACTS 第八节 5）
      if (typeof ctx.route === 'function') {
        const off = ctx.route('/callback', (req, res) => {
          const sig = req?.headers?.['x-template-signature']
          if (sig !== String(cfg.token ?? token)) {
            // 验签不过：拒绝，不 emit。这是硬规则。
            res.statusCode = 401
            res.end()
            return
          }
          deliver(req.body)
          res.statusCode = 200
          res.end()
        })
        offs.push(off)
      }
      ctx.state('connected')
    },

    /** 停止：撤路由、断连接、报 stopped。停了之后绝不能再 emit。 */
    async stop() {
      if (!running) return
      running = false
      connected = false
      for (const off of offs.splice(0)) { try { off() } catch {} }
      // 真实平台端：在这里断开你的客户端
      ctx?.state('stopped')
    },

    /** 连上后核对「登录的是不是配置里的那个机器人」。不是就由网关断开这个实例。 */
    async whoami() {
      return { account: self.account, name: self.name }
    },

    /**
     * 出站：parts → 平台调用。网关已按 caps 降级，parts 里只会有声明支持的类型。
     * 失败必须抛 SendError；抛别的错误网关一律当 'unknown' 处理。
     */
    async send(message) {
      const chatId = message?.chat
      const parts = message?.parts || []
      const caps = this.caps()

      // 没连上：确定没发出去 → not-sent
      if (!running || !connected) {
        throw sendError('not-sent', 'offline', instance, '平台端未连接')
      }
      // 被动回复的平台：没有 inResponseTo 的发送一律拒绝（网关也会先拦一道，这里是平台端自己的保险）
      if (caps.proactive === 'none' && !message.inResponseTo) {
        throw sendError('not-sent', 'proactive-not-allowed', instance, '该平台只能被动回复')
      }
      // 被动回复时限：带了 inResponseTo 但已超时 → 按主动消息算，proactive=none 时同样拒绝
      if (message.inResponseTo && caps.replyWindowMs > 0) {
        const at = seenAt.get(String(message.inResponseTo))
        if (at != null && Date.now() - at > caps.replyWindowMs && caps.proactive === 'none') {
          throw sendError('not-sent', 'proactive-not-allowed', instance, '回复已超出被动时限')
        }
      }
      if (!parts.length) {
        throw sendError('not-sent', 'nothing-to-send', instance, '没有可发送的内容')
      }

      // 注入的故障（测试用）：连不上 → not-sent；真实平台端对应「客户端未连接 / 平台明确拒绝」
      if (failSend === 'refused') {
        failSend = null
        throw sendError('not-sent', 'platform-refused', instance, '平台连接被拒绝')
      }

      // 组平台侧载荷
      const payload = {
        chat_type: chatId?.kind || 'private',
        chat_id: String(chatId?.id ?? ''),
        reply_to: message.replyTo,
        in_response_to: message.inResponseTo,
        segments: parts.map(fromPart),
      }

      // 发送：带超时。超时、连接中途断开、响应读不懂 → 'unknown'，绝不重发。
      const timeoutMs = Math.max(1, Number(message.timeoutMs) || 8000)
      let timer
      try {
        if (failSend === 'timeout') {
          failSend = null
          await new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(sendError('unknown', 'timeout', instance, `平台 ${timeoutMs}ms 内没有响应`)), timeoutMs)
          })
        }
        // 模拟平台：直接送进记录器。真实平台端：await client.call('send', payload)
        const result = await platform.__send(payload)
        return { messageId: String(result.message_id) }
      } catch (error) {
        // 平台侧已经分类过的错误原样抛；其余的一律按 'unknown'（拿不准必须 unknown）
        if (error?.certainty === 'not-sent' || error?.certainty === 'unknown') throw error
        throw sendError('unknown', error?.code || 'send-failed', instance, String(error?.message || error))
      } finally {
        clearTimeout(timer)
      }
    },

    /**
     * 可选：把平台原生格式转成 parts。模板的原生格式转换已经在 toParts 里，
     * 这里接住外部传来的原生消息（网关的 gateway.toParts 会调它）。
     */
    toParts(nativeMessage) {
      return toParts(nativeMessage?.segments || [])
    },
  }

  // 模拟平台的发送口：把 payload 记下来并回一个 messageId（测试断言「send 不抛错」用）
  platform.__sent = []
  platform.__send = async (payload) => {
    platform.__sent.push(payload)
    return { message_id: 'tpl-' + (platform.__sent.length) }
  }

  adapter.platform = platform
  return adapter
}

/** 默认导出一个预配置实例（register 时用工厂包一层：() => createTemplateAdapter()）。 */
export default createTemplateAdapter()
