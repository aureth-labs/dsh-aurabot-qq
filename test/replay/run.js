// 回放测试的驱动器（P0 第 9 条：回放测试的架子）。
//
// 用法：
//   import { runScenario } from './run.js'
//   const snapshot = runScenario(JSON.parse(readFileSync(fixturePath, 'utf8')))
//   // 命令行单跑一个场景：node test/replay/run.js test/replay/fixtures/owner-private.json
//
// 输入：一份场景 JSON（fixtures/ 下），包含：
//   name / description  场景名与说明
//   seed                固定随机种子（喂给 mulberry32，替代 Math.random）
//   timeBase            固定时间基点（毫秒），替代 Date.now()
//   selfId / ownerId    机器人 QQ / 主人 QQ（假数据）
//   allow               白名单 { private: ['10002'], groups: ['20001'] }
//   caps                能力表（裁剪版，只认 voice: false 时丢语音段并记 degraded）
//   events              OneBot v11 事件数组；额外支持两个合成事件：
//                       { type: 'gateway-down' } / { type: 'gateway-up' }（演练补发队列）
//   script              模型桩：{ "<触发事件的 message_id>": "回复正文" 或 ["第1条","第2条"] }
//                       多条之间一条消息一个元素，逐条发出（模拟拆条）。
//
// 输出：确定性的 JSON 快照（stableStringify 键排序，零抖动）：
//   { scenario, description, seed, selfId, ownerId,
//     inbound:  [每条入站消息经【真 inbound.js parseMessageEvent】解析后的关键字段],
//     outbound: [发出去的每一条消息（动作 / 参数 / 模拟 message_id / 顺序号）],
//     chatlog:  [写进流水的每一行（同 hub logChat 的行形状）],
//     notices:  [通知事件翻出来的句子（真 notices.js noticeText）],
//     outbox:   [断线期间排队、重连后补发的消息],
//     skipped:  [被策略跳过的消息及原因] }
//
// ===================== 零抖动钩子 =====================
// 时间：clock.now() 从 timeBase 起每次 +1000ms 线性递增；入站行的时间戳直接取事件自带的
//       time 字段（秒）×1000。全程不调 Date.now()。
// 随机：random() 来自 mulberry32(seed)。全程不调 Math.random。
// 顺序：snapshot 各数组按处理顺序（事件序 / 补发 FIFO）；JSON 序列化键排序，
//       不依赖 Map/Set 迭代序或文件系统序（fixture 清单按文件名 sort）。
//
// ===================== 驱动桩裁剪说明（G3 接入必读） =====================
// 本驱动器是「按 hub.js 实际导出面裁剪的最小桩」，没有 import src/chat/hub.js
// （hub 全量驱动需要 DSH 宿主 sessionController / workspaceRegistry / onebot / TTS / ASR，
//   测试里起不动）。裁掉与补齐对照：
//   - 裁掉：DSH 会话挂载、真模型调用（用 script 桩代替）、TTS/ASR/图片缩放、
//           guard 清洗、群策略全量规则（group-policy.js）、心情/表情概率系统。
//   - 保留真代码：入站解析用【真 src/chat/inbound.js parseMessageEvent】（含图片/表情包/
//           语音/合并转发/戳一戳/卡片的文字化），通知翻译用【真 src/chat/notices.js noticeText】。
//   - 桩面（形状照抄 hub.js）：sendSegments(chatId, message, note, opts) →
//           onebot.call('send_group_msg'|'send_private_msg', params) → 返回固定 message_id；
//           logChat(chatId, who, text, uid) → 收集 chatlog 行；outbox.add/flush（数组桩，
//           只收不含媒体的消息，对齐 CONTRACT §7.4 的规则）。
//   - 回复决策桩只保留最小规则：私聊看白名单；群聊只「被 @ / 引用她」必回
//           （listenAllInGroup=false 模式），其余跳过并记原因。
// G3 接入时要补的：
//   1. 把驱动桩换成真 hub（createHub），场景 script 换成模型适配层桩（LLM 调用可注入）；
//   2. 基线必须重新生成（第一轮快照差异就是 G3 改动的预期面），之后按 CONTRACT §11.4
//      成为硬门槛：任何包让回放结果变了，要么是 bug，要么 PR 逐条说明；
//   3. 群策略、guard 清洗、出站门闸（outbound-policy）上线后，把对应场景的 skipped/outbound
//      期望值补进基线，不要放松排序与零抖动约束。
// 约束：本文件不改任何现有源码文件（CONTRACT §10：test/replay/ 归 P0）。

import { parseMessageEvent } from '../../src/chat/inbound.js'
import { noticeText } from '../../src/chat/notices.js'

/** mulberry32：小型可复现 PRNG，种子来自场景文件，替代 Math.random。 */
export function mulberry32 (seed) {
  let a = (Number(seed) || 0) >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 固定时钟：从 timeBase 起，每次调用 +1000ms。回放里一切「现在」都从这里来。 */
export function makeClock (timeBase) {
  let tick = 0
  return { base: Number(timeBase) || 1700000000000, now: () => (Number(timeBase) || 1700000000000) + (tick++) * 1000 }
}

/** 键排序的确定性 JSON 序列化：同一次回放无论跑几遍，字节都一致。 */
export function stableStringify (value, indent = 2) {
  const seen = new WeakSet()
  const enc = (v) => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v)
    if (seen.has(v)) return '"[circular]"'
    seen.add(v)
    if (Array.isArray(v)) return '[\n' + v.map((x) => ' '.repeat(indent) + enc(x)).join(',\n') + '\n' + ' '.repeat(indent - 2) + ']'
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort()
    const body = keys.map((k) => ' '.repeat(indent) + JSON.stringify(k) + ': ' + enc(v[k])).join(',\n')
    return '{\n' + body + '\n' + ' '.repeat(indent - 2) + '}'
  }
  return enc(value)
}

/** 是否含媒体段（补发队列只收不含媒体的消息，对齐 CONTRACT §7.4 / 旧 outbox.js 规则）。 */
const hasMedia = (message) => (message || []).some((s) => s && s.type !== 'text' && s.type !== 'face' && s.type !== 'reply' && s.type !== 'at')

/**
 * 跑一个回放场景，返回确定性快照对象（不含任何 Date.now / Math.random 结果）。
 * @param {object} scenario 场景 JSON（见文件头说明）
 */
export function runScenario (scenario) {
  const cfg = {
    selfId: String(scenario.selfId ?? '10000'),
    ownerId: String(scenario.ownerId ?? '10001'),
    allow: { private: (scenario.allow?.private || []).map(String), groups: (scenario.allow?.groups || []).map(String) },
    caps: scenario.caps || {},
  }
  const clock = makeClock(scenario.timeBase)
  const random = mulberry32(scenario.seed)
  const snapshot = { scenario: scenario.name, description: scenario.description || '', seed: Number(scenario.seed) || 0, selfId: cfg.selfId, ownerId: cfg.ownerId, inbound: [], outbound: [], chatlog: [], notices: [], outbox: [], skipped: [] }

  let seq = 0            // 发送顺序号（确定性）
  let simulatedId = 0    // 平台端桩返回的 message_id（确定性）
  let gatewayUp = true   // 网关在线状态（gateway-down / gateway-up 合成事件切换）
  const outbox = []      // 补发队列桩：{ action, params, chatId, note, kind }
  const outboxAdd = (item) => { outbox.push(item); return { ok: true, id: outbox.length } }

  /** 平台端桩：形状照抄 hub.sendSegments → onebot.call 的调用面，返回固定 message_id。 */
  function platformSend (chatId, message, note, { queued = false, flushed = false } = {}) {
    const [kind, id] = String(chatId).split(':')
    const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg'
    const params = kind === 'group' ? { group_id: Number(id), message } : { user_id: Number(id), message }
    const record = { seq: ++seq, at: clock.now(), chatId, action, params, note: note || '', messageId: queued ? '' : `replay-${String(++simulatedId).padStart(4, '0')}`, ...(queued ? { queued: true } : {}), ...(flushed ? { flushed: true } : {}) }
    snapshot.outbound.push(record)
    // 发成功才留痕（对齐 hub：真发出 / 补发成功都写 bot 行）
    snapshot.chatlog.push({ t: record.at, chatId, who: 'bot', text: note || message.filter((s) => s.type === 'text').map((s) => s.data?.text || '').join('') })
    return record
  }

  /** 清洗 + 降级（CONTRACT §7 裁剪表）：只实现语音在 caps.voice=false 时丢弃并记 degraded。 */
  function degrade (chatId, message) {
    const out = []
    const degraded = []
    for (const seg of message || []) {
      if (seg.type === 'record' && cfg.caps.voice === false) { degraded.push('voice-dropped'); continue }
      out.push(seg)
    }
    if (degraded.length) snapshot.chatlog.push({ t: clock.now(), chatId, who: '系统', text: `【降级】${degraded.join(',')}` })
    return out
  }

  /** 发送出口（裁剪版 sendSegments）：降级 → 补发队列判断 → 平台端桩。 */
  function sendSegments (chatId, message, note) {
    message = degrade(chatId, message)
    if (!message.length) return null
    if (!gatewayUp) {
      if (hasMedia(message)) { snapshot.chatlog.push({ t: clock.now(), chatId, who: '系统', text: '【发送失败】网关离线且含媒体，不进补发队列' }); return null }
      const q = outboxAdd({ action: String(chatId).startsWith('group:') ? 'send_group_msg' : 'send_private_msg', chatId, note: note || '', kind: 'reply', message })
      snapshot.outbound.push({ seq: ++seq, at: clock.now(), chatId, queued: true, queuedId: q.id, note: note || '' })
      return { queued: true, queuedId: q.id }
    }
    return platformSend(chatId, message, note)
  }

  /** 补发（网关重新连上时，按 FIFO 把队列里属于在线实例的消息发出去）。 */
  function flushOutbox () {
    while (outbox.length) {
      const item = outbox.shift()
      platformSend(item.chatId, item.message, item.note, { flushed: true })
      snapshot.outbox.push({ flushedId: seq, chatId: item.chatId, note: item.note, kind: item.kind })
    }
  }

  /** 模型桩：按触发事件的 message_id 取回话内容。
   *  元素可以是字符串，或对象 { text, media: true }（media: true 表示这条回复带一个图片段，
   *  用来演练「断线期间含媒体的消息不进补发队列」的规则）。数组表示拆成多条逐条发。 */
  const replyOf = (messageId) => {
    const r = (scenario.script || {})[String(messageId)]
    if (r === undefined || r === null) return null
    const items = Array.isArray(r) ? r : [r]
    return items.map((x) => (typeof x === 'object' && x !== null ? { text: String(x.text || ''), media: Boolean(x.media) } : String(x)))
  }

  /** 回复决策桩（最小规则）：返回 { deliver: boolean, reason }。 */
  function decide (parsed) {
    if (parsed.kind === 'private') {
      if (parsed.userId === cfg.selfId) return { deliver: false, reason: 'self-message' }
      if (parsed.userId === cfg.ownerId) return { deliver: true, reason: 'owner-private' }
      if (cfg.allow.private.includes(parsed.userId)) return { deliver: true, reason: 'allowed-private' }
      return { deliver: false, reason: 'private-not-allowed' }
    }
    if (!cfg.allow.groups.includes(parsed.groupId)) return { deliver: false, reason: 'group-not-allowed' }
    // 戳一戳（消息段形式的 poke）当互动看，必回；其余只有被 @ / 引用她才必回
    if (parsed.mentioned || parsed.replyId || parsed.text.includes('[戳一戳]')) {
      return { deliver: true, reason: parsed.mentioned ? 'mentioned-must-reply' : parsed.replyId ? 'quote-reply' : 'poke-interact' }
    }
    return { deliver: false, reason: 'not-mentioned' }
  }

  for (const ev of scenario.events || []) {
    // 合成事件：演练网关断线 / 重连补发
    if (ev && ev.type === 'gateway-down') { gatewayUp = false; snapshot.chatlog.push({ t: clock.now(), chatId: 'system:gateway', who: '系统', text: '【网关离线】' }); continue }
    if (ev && ev.type === 'gateway-up') { gatewayUp = true; snapshot.chatlog.push({ t: clock.now(), chatId: 'system:gateway', who: '系统', text: '【网关在线】补发队列开始冲队' }); flushOutbox(); continue }

    // 通知事件：走【真 notices.js noticeText】翻成一句话，记流水、攒到下一轮带给她
    const note = noticeText(ev, { botQQ: cfg.selfId, name: (qq) => String(qq), ownMessage: (id) => snapshot.outbound.some((o) => o.messageId === String(id)) })
    if (note) {
      snapshot.notices.push({ at: (Number(ev.time) || 0) * 1000, chatId: note.chatId, text: note.text })
      snapshot.chatlog.push({ t: (Number(ev.time) || 0) * 1000, chatId: note.chatId, who: '系统', text: `【系统】${note.text}` })
      continue
    }

    // 消息事件：入站解析必须用【真 inbound.js】
    if (ev?.post_type !== 'message') continue
    const parsed = parseMessageEvent(ev, cfg.selfId)
    const at = (Number(ev.time) || 0) * 1000
    snapshot.inbound.push({
      at, kind: parsed.kind, chatId: parsed.chatId, userId: parsed.userId, groupId: parsed.groupId,
      nickname: parsed.nickname, messageId: parsed.messageId, text: parsed.text, wakeText: parsed.wakeText,
      mentioned: parsed.mentioned, atOthers: parsed.atOthers, replyId: parsed.replyId,
      images: parsed.images.length, stickers: parsed.stickers.length, records: parsed.records.length,
      forwards: parsed.forwards, files: parsed.files.length,
    })
    snapshot.chatlog.push({ t: at, chatId: parsed.chatId, who: 'user', uid: parsed.userId, text: parsed.text })

    const decision = decide(parsed)
    if (!decision.deliver) { snapshot.skipped.push({ at, chatId: parsed.chatId, messageId: parsed.messageId, reason: decision.reason }); continue }
    const replies = replyOf(parsed.messageId)
    if (!replies) { snapshot.skipped.push({ at, chatId: parsed.chatId, messageId: parsed.messageId, reason: 'script-no-reply' }); continue }

    // 逐条发（模拟拆条）；带引用回复的第一条前面垫 reply 段（照抄 hub.quote 的形状）
    replies.forEach((reply, i) => {
      const text = typeof reply === 'object' ? reply.text : reply
      const segs = []
      if (i === 0 && parsed.replyId) segs.push({ type: 'reply', data: { id: parsed.replyId } })
      segs.push({ type: 'text', data: { text } })
      if (typeof reply === 'object' && reply.media) segs.push({ type: 'image', data: { url: 'https://example.invalid/fake-replay.png', file: 'fake-replay.png' } })
      sendSegments(parsed.chatId, segs, text)
    })
  }

  // 结束前如果网关还离线，队列里的消息留在快照的 outbound（queued:true），不冲队
  return JSON.parse(stableStringify(snapshot))
}

// 命令行单跑：node test/replay/run.js <fixture.json>（把快照打到 stdout，便于人工核对）
const isDirectRun = process.argv[1] && String(process.argv[1]).replace(/\\/g, '/').endsWith('/run.js')
if (isDirectRun && process.argv[2]) {
  const { readFileSync } = await import('node:fs')
  process.stdout.write(stableStringify(runScenario(JSON.parse(readFileSync(process.argv[2], 'utf8')))) + '\n')
}
