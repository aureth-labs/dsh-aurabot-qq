// QQ 平台端 · 入站翻译（G2 产出）
//
// 作用：OneBot v11 事件 → 契约的 AdapterInbound / AdapterEvent。只做翻译，
//       不查身份、不拼给模型看的文字（`text` / `wakeText` 是网关 render.js 的活）。
// 契约：src/gateway/contracts.d.ts 第 3/4 节；文字规则：docs/CONTRACTS.md §六。
//
// ── 与 src/chat/inbound.js 的关系（为什么这里有一份等价实现）──
// `parseMessageEvent` 住在 src/chat（中枢层），契约 §二 明令平台端不许 import 中枢，
// 所以不能直接复用它，只能按它的判据做一份等价翻译：
//   - 段判据（isStickerSegment / segmentsOf / QQ 分享卡片 cardText）是**逐条抄**过来的，
//     抄的来源写在每个函数头；改那边必须同步改这里（G3 切换前以 inactive 的 beta 输出为准）。
//   - 出站方向没有可抄的现成代码（hub.js 是拼段不是翻 Part），见 outbound.js。
//   - 「等价」由 test/adapters/qq.test.js 里逐字段对照用例守住：
//     本文件翻译出的 parts 经 src/gateway/render.js 的 renderParts 得到的 text / wakeText，
//     与 parseMessageEvent 的 text / wakeText 相同；特殊段条目（图片数、表情包数、语音数、
//     文件列表、replyId、atOthers）由本文件底部的 specialEntries() 还原后对照。
//
// 已知的有意差异（都在测试里标注）：
//   1. 认不出的段：parseMessageEvent 直接丢弃；这里按契约「认不出的内容用 other 占位，不猜」
//      放一个 { type:'other', text:'[类型]' }，排障时能看到网关推了什么。现有测试语料里没有
//      这种段，所以逐字段对照不受影响。
//   2. sender.role：parseMessageEvent 原样透传 sender.role；契约要求「私聊是空串」，这里按契约给 ''。
//   3. 语音段：parseMessageEvent 只收集不进文字，renderParts 对 voice 也不进文字，两边一致。

/** 消息段数组（兼容字符串 CQ 码：只取纯文字）。抄自 src/chat/inbound.js segmentsOf。 */
export function segmentsOf(event) {
  const m = event && event.message
  if (Array.isArray(m)) return m.filter((s) => s && typeof s === 'object')
  if (typeof m === 'string') return [{ type: 'text', data: { text: m.replace(/\[CQ:[^\]]*\]/g, '') } }]
  return []
}

/** 这个段是不是「表情包」（不是普通照片）。判定必须严格。抄自 src/chat/inbound.js isStickerSegment。 */
export function isStickerSegment(seg) {
  if (!seg || !seg.data) return false
  if (seg.type === 'mface') return true
  if (seg.type !== 'image') return false
  const d = seg.data
  const sub = String(d.sub_type ?? d.subType ?? '')
  if (sub === '1') return true
  // 带文字说明的表情（比如「[啊？]」）是 sub_type 7；只认有说明的，普通图片的说明是「[图片]」
  if (sub === '7' && d.summary && d.summary !== '[图片]') return true
  if (d.emoji_id || d.emojiId) return true
  return false
}

/** QQ 分享卡片里认出标题和链接。抄自 src/chat/inbound.js cardText（口径必须一致）。 */
export function cardText(raw) {
  try {
    const j = typeof raw === 'string' ? JSON.parse(raw) : raw
    const meta = j?.meta || {}
    if (j?.app === 'com.tencent.map' && meta.Location) {
      const parts = [meta.Location.title, meta.Location.address].filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
      return `[位置${parts.length ? '：' + parts.join(' ') : ''}]`
    }
    if (j?.app === 'com.tencent.contact.lua' && meta.contact) {
      const id = meta.contact.id
      return `[联系人${id !== undefined && id !== null && String(id).trim() ? '：' + String(id).trim() : ''}]`
    }
    const m = meta.detail_1 || meta.news || meta.music || Object.values(meta)[0] || {}
    const title = String(m.desc || m.title || j.prompt || '').trim()
    const url = String(m.qqdocurl || m.jumpUrl || m.url || '').split('?')[0]
    const from = String(m.title && m.desc ? m.title : m.tag || '').trim()
    if (!title && !url) return '[卡片消息]'
    return `[分享卡片${from ? '（' + from + '）' : ''}：${title}${url ? ' ' + url : ''}]`
  } catch (error) {
    return '[卡片消息]'
  }
}

/** 图片/表情包的 MediaRef。四选一至少给一个：url / 平台文件标识 / 字节路径都没有就留空对象。 */
function imageMedia(d = {}) {
  const media = {}
  if (d.url) media.url = String(d.url)
  if (d.file) media.id = String(d.file)
  if (d.mime) media.mime = String(d.mime)
  const size = Number(d.size ?? d.file_size)
  if (size > 0) media.size = size
  const width = Number(d.width)
  const height = Number(d.height)
  if (width > 0) media.width = width
  if (height > 0) media.height = height
  return media
}

/**
 * 一个 face 段 → face Part。
 * 名字口径照 parseMessageEvent：有 resultId（骰子/猜拳）时用「骰子/猜拳：结果」，
 * 否则用表情名（网关 renderParts 输出「[名字]」），认不出才落到「表情」。
 */
function facePart(data, faceName) {
  const d = data || {}
  const id = String(d.id ?? '')
  const name = faceName?.(d.id)
  const label = id === '358' ? '骰子' : id === '359' ? '猜拳' : name || String(d.raw?.faceText || '').replace(/^\[|\]$/g, '') || '表情'
  const hasResult = d.resultId !== undefined && d.resultId !== null && String(d.resultId) !== ''
  return hasResult ? { type: 'face', name: label, value: String(d.resultId) } : { type: 'face', name: label }
}

/**
 * 消息段数组 → { parts, mentionedMe, replyTo }。
 * @param {any} message OneBot 的 message 字段（段数组或 CQ 码字符串）
 * @param {{ selfId?: string, faceName?: (id: any) => string|undefined }} [opts]
 *        selfId：机器人自己的号。@自己 不进 parts，只置 mentionedMe（契约 Part.mention 注释）。
 *        faceName：表情编号 → 名字（由调用方注入；平台端不自己维护表情表）。
 */
export function segmentsToParts(message, { selfId = '', faceName } = {}) {
  const self = String(selfId || '')
  const parts = []
  let mentionedMe = false
  let replyTo = ''
  for (const seg of segmentsOf({ message })) {
    const d = seg.data || {}
    switch (seg.type) {
      case 'text': {
        const text = String(d.text ?? '')
        if (text) parts.push({ type: 'text', text })
        break
      }
      case 'at':
        if (String(d.qq) === 'all') parts.push({ type: 'mention', account: 'all', name: '全体成员' })
        else if (self && String(d.qq) === self) mentionedMe = true
        else parts.push({ type: 'mention', account: String(d.qq ?? ''), name: d.name ? String(d.name) : undefined })
        break
      case 'reply':
        // 引用回复：是顶层字段，不是一条 part（契约 AdapterInbound.replyTo）
        replyTo = String(d.id ?? '')
        break
      case 'face':
        parts.push(facePart(d, faceName))
        break
      case 'image':
      case 'mface':
        if (isStickerSegment(seg)) {
          parts.push({
            type: 'sticker',
            media: imageMedia(d),
            label: d.summary ? String(d.summary) : undefined,
            native: seg, // 原样重发用（商城表情靠它）
          })
        } else {
          parts.push({ type: 'image', media: imageMedia(d) })
        }
        break
      case 'record':
        parts.push({
          type: 'voice',
          media: { url: d.url ? String(d.url) : undefined, id: d.file ? String(d.file) : undefined, mime: d.mime || 'audio/amr' },
          durationMs: Number(d.duration) > 0 ? Number(d.duration) * 1000 : undefined,
        })
        break
      case 'video':
        parts.push({ type: 'video', media: { url: d.url ? String(d.url) : undefined, id: d.file ? String(d.file) : undefined, name: d.file ? String(d.file) : undefined } })
        break
      case 'file':
        parts.push({
          type: 'file',
          media: {
            name: String(d.name || d.file || ''),
            size: Number(d.size ?? d.file_size) || undefined,
            id: String(d.id ?? d.file_id ?? '') || undefined,
            url: String(d.url || '') || undefined,
            md5: String(d.file_hash || '') || undefined,
          },
          // busid / file_hash 是出站取文件地址要用的，网关不读，原样留在 native 供模块用
          native: seg,
        })
        break
      case 'json': {
        const text = cardText(d.data)
        parts.push(text === '[卡片消息]' ? { type: 'other', text, native: seg } : { type: 'card', text, url: cardUrl(d.data) })
        break
      }
      case 'xml':
        // parseMessageEvent 对她只显示「[卡片消息]」；契约里 card 要有标题和链接，读不出就 other 占位
        parts.push({ type: 'other', text: '[卡片消息]', native: seg })
        break
      case 'flash_file':
        parts.push({ type: 'other', text: d.title ? `[闪传文件：${String(d.title)}]` : '[闪传文件]', native: seg })
        break
      case 'forward': {
        const id = String(d.id ?? d.res_id ?? d.forward_id ?? '')
        if (id) parts.push({ type: 'forward', id })
        else parts.push({ type: 'other', text: '[合并转发]', native: seg }) // 没 id 展不开，别丢占位
        break
      }
      case 'poke':
        parts.push({ type: 'poke' })
        break
      default:
        // 认不出的段：按契约用 other 占位（parseMessageEvent 会丢，这里保留以便排障）
        parts.push({ type: 'other', text: `[${String(seg.type || '未知')}]`, native: seg })
        break
    }
  }
  return { parts, mentionedMe, replyTo }
}

/** 从 card 的 json 里读一个可点的链接（读不出就是 undefined，不编）。 */
function cardUrl(raw) {
  try {
    const j = typeof raw === 'string' ? JSON.parse(raw) : raw
    const meta = j?.meta || {}
    const m = meta.detail_1 || meta.news || meta.music || Object.values(meta)[0] || {}
    const url = String(m.qqdocurl || m.jumpUrl || m.url || '').split('?')[0]
    return url || undefined
  } catch (error) {
    return undefined
  }
}

/**
 * PlatformAdapter.toParts 的实现：兼容旧接口 sendSegments 传进来的 OneBot 消息段。
 * 入参可以是段数组，也可以是一整条 { message: [...] }。
 */
export function toParts(nativeMessage, opts = {}) {
  const message = Array.isArray(nativeMessage) ? nativeMessage : nativeMessage?.message ?? nativeMessage
  return segmentsToParts(message, opts).parts
}

/** 群/私聊地址：notice 事件里可能只有 group_id 或 only user_id。 */
function chatOf(event) {
  const gid = event?.group_id
  if (gid !== undefined && gid !== null && String(gid) !== '') return { kind: 'group', id: String(gid) }
  const uid = event?.user_id ?? event?.operator_id ?? event?.target_id ?? ''
  return { kind: 'private', id: String(uid ?? '') }
}

/**
 * 一条 OneBot 消息事件 → AdapterInbound。
 * @param {object} event OneBot v11 事件（post_type='message'）
 * @param {{ selfId?: string, faceName?: Function, messageIdFallback?: number }} [opts]
 * @returns {import('../../gateway/contracts.d.ts').AdapterInbound}
 */
export function fromOneBotEvent(event, { selfId, faceName, messageIdFallback = 0 } = {}) {
  const self = String(selfId || event?.self_id || '')
  const kind = event?.message_type === 'group' ? 'group' : 'private'
  const groupId = kind === 'group' ? String(event?.group_id ?? '') : ''
  const sender = event?.sender || {}
  const userId = String(event?.user_id ?? sender.user_id ?? '')
  // 临时会话（私聊）的来源群：出站时要带回去，放 ext（契约：平台专属附加信息）
  const sourceGroupId = kind === 'private' && event?.sub_type === 'group' && /^\d+$/.test(String(sender.group_id ?? '')) && Number(sender.group_id) > 0 ? String(sender.group_id) : ''
  const { parts, mentionedMe, replyTo } = segmentsToParts(event?.message, { selfId: self, faceName })
  // 时间：OneBot 给秒级；契约要毫秒。已经有 13 位的按毫秒算（有些实现对 time 做了毫秒扩展）
  const rawTime = Number(event?.time)
  const at = Number.isFinite(rawTime) && rawTime > 0 ? (rawTime < 1e12 ? rawTime * 1000 : rawTime) : Date.now()
  const messageId = String(event?.message_id ?? '') || `qq-noid-${Date.now()}-${++messageIdFallback}`
  const ext = {}
  if (sourceGroupId) ext.sourceGroupId = sourceGroupId
  if (event?.sub_type) ext.subType = String(event.sub_type)
  return {
    chat: { kind, id: kind === 'group' ? groupId : userId },
    sender: {
      account: userId,
      // 群里优先用群名片（parseMessageEvent 同样口径：card || nickname || 号）
      name: String(sender.card || sender.nickname || userId),
      role: kind === 'group' ? String(sender.role || '') : '', // 契约：私聊是空串
    },
    messageId,
    at,
    replyTo: replyTo || undefined,
    mentionedMe,
    parts,
    ...(Object.keys(ext).length ? { ext } : {}),
    raw: event,
  }
}

/**
 * 一条 OneBot 非消息事件 → AdapterEvent；认不出的返回 null（不猜）。
 * 对照 host.js 里 handleEvent 现在的分支：戳一戳、离线、群文件、机器人自己发的、
 * 其余 notice / request 原样转给绑定该平台的模块。
 */
export function toAdapterEvent(event, { selfId } = {}) {
  if (!event || typeof event !== 'object') return null
  const postType = event.post_type
  const chat = chatOf(event)
  // 机器人自己发的消息：绝不走 emit（否则她会在记忆里看见自己对自己说话，CONTRACTS §六.4）
  if (postType === 'message_sent') {
    const { parts } = segmentsToParts(event.message, { selfId: String(selfId || event.self_id || '') })
    return { type: 'self-sent', chat, messageId: String(event.message_id ?? ''), parts, raw: event }
  }
  if (postType === 'notice') {
    const noticeType = String(event.notice_type || '')
    if (noticeType === 'notify' && event.sub_type === 'poke') {
      return { type: 'poke', chat, from: String(event.user_id ?? ''), to: String(event.target_id ?? ''), raw: event }
    }
    if (noticeType === 'bot_offline') {
      const reason = [event.tag, event.message].filter((x) => x !== undefined && x !== null && String(x).trim() !== '').map((x) => String(x)).join('：')
      return { type: 'offline', reason: reason || undefined, raw: event }
    }
    if (noticeType === 'group_upload') {
      const f = event.file || {}
      return {
        type: 'file',
        chat,
        from: String(event.user_id ?? ''),
        media: { name: String(f.name || ''), size: Number(f.size) || undefined, id: String(f.id || '') || undefined, md5: String(f.busid ? '' : f.busid || '') || undefined },
        raw: event,
      }
    }
    if (noticeType === 'group_recall' || noticeType === 'friend_recall') {
      return { type: 'recall', chat, messageId: String(event.message_id ?? ''), by: String(event.operator_id ?? event.user_id ?? ''), raw: event }
    }
    // 群管理变动、加好友……只转给声明了 platforms:['qq'] 的模块
    return { type: 'native', name: `notice.${noticeType || 'unknown'}`, raw: event }
  }
  if (postType === 'request') {
    return { type: 'native', name: `request.${String(event.request_type || 'unknown')}`, raw: event }
  }
  if (postType === 'meta_event') {
    // 心跳是噪声，不收；lifecycle 留给模块（上线/下线想看的话）
    if (event.meta_event_type === 'heartbeat') return null
    return { type: 'native', name: `meta_event.${String(event.meta_event_type || 'unknown')}`, raw: event }
  }
  return null
}

/**
 * 等价测试用：把 parts 还原成 parseMessageEvent 产出的特殊段条目。
 * 只被 test/adapters/qq.test.js 用来逐字段对照（运行时不调用）。
 * 语音/视频/闪传等 parseMessageEvent 只记文字或只收集，这里按它的规则还原同样的形状。
 */
export function specialEntries(parts) {
  const images = []
  const stickers = []
  const records = []
  const files = []
  const forwards = []
  let replyTo = ''
  for (const p of Array.isArray(parts) ? parts : []) {
    if (!p) continue
    if (p.type === 'image') images.push(p)
    else if (p.type === 'sticker') stickers.push(p)
    else if (p.type === 'voice') records.push(p)
    else if (p.type === 'file') files.push({ name: p.media?.name || '', size: p.media?.size || 0, id: p.media?.id || '', url: p.media?.url || '', hash: p.media?.md5 || '' })
    else if (p.type === 'forward') forwards.push(p.id)
    else if (p.type === 'mention' && p.account !== 'all') continue
  }
  return { images, stickers, records, files, forwards, replyTo }
}
