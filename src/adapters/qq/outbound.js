// QQ 平台端 · 出站翻译（G2 产出）
//
// 作用：契约的 Part[] → OneBot 消息段 / 需要单独调用的动作。
//       网关已经按 caps 降级过，这里只处理声明支持的类型；不做「该不该发」的判断。
// 契约：src/gateway/contracts.d.ts 第 3/5/7 节；降级表：docs/CONTRACTS.md §七.2。
//
// 三个方向：
//   1. messageSegments(parts) —— 能塞进 send_private_msg / send_group_msg 的段。
//   2. fileUploads(parts)     —— 必须走 upload_private_file / upload_group_file 的文件
//                                 （hub.js 现在就是这么发的，见 src/chat/hub.js sendFile）。
//   3. pokes(parts, chat)     —— 戳一戳是独立动作 send_poke，不是消息段。
//
// Part → OneBot 段对照（入站对照表的反向）：
//   text    → text                              mention → at（all → at qq='all'）
//   image   → image（media 的 bytes/path/url/id 按优先级取一个当 file）
//   sticker → 有 native 段就原样重发（商城表情/收藏表情靠它），否则当 image 发
//   voice   → record（caps.voice='native'）/ 走 upload_* 当音频文件（caps.voice='file'）
//   video   → video                             file    → upload_*（不走消息段）
//   face    → face（名字 → 编号要靠调用方给的 faceId；给不出就退回文字「[名字]」）
//   card    → 本平台端声明 card=false（见 probe.js 的能力依据表），正常走不到这里
//   forward → 出站方向不支持合并转发（caps 里没有对应键），退回一段文字提示
//   poke    → send_poke（只有私聊知道戳谁；群里没有目标就跳过并记日志）

/** media 里挑一个 OneBot 认的来源。priority 故意把 bytes 放最前：网关可能只拿到字节。 */
export function mediaSource(media) {
  if (!media || typeof media !== 'object') return ''
  if (media.bytes instanceof Uint8Array && media.bytes.length) return 'base64://' + Buffer.from(media.bytes).toString('base64')
  if (typeof media.bytes === 'string' && media.bytes) return media.bytes.startsWith('base64://') ? media.bytes : 'base64://' + media.bytes
  if (media.path) return String(media.path)
  if (media.url) return String(media.url)
  if (media.id) return String(media.id) // 平台内文件标识：有的网关支持直接重发
  return ''
}

/**
 * Part[] → { segments, uploads, pokes, degraded }。
 * @param {import('../../gateway/contracts.d.ts').Part[]} parts
 * @param {{ voiceMode?: 'native'|'file'|false, faceIdOf?: (name: string) => number|undefined, log?: object }} [opts]
 *        voiceMode：本平台端 caps().voice。'file' 时语音改走 upload_*（当音频文件发）。
 *        faceIdOf：表情名 → QQ 编号（由调用方注入表情表；平台端不自己维护）。
 * @returns {{ segments: any[], uploads: { file: string, name: string }[], pokes: any[], degraded: string[] }}
 */
export function buildParts(parts, { voiceMode = 'native', faceIdOf, log } = {}) {
  const segments = []
  const uploads = []
  const pokes = []
  const degraded = []
  for (const part of Array.isArray(parts) ? parts : []) {
    if (!part || typeof part !== 'object') continue
    switch (part.type) {
      case 'text': {
        const text = String(part.text ?? '')
        if (text) segments.push({ type: 'text', data: { text } })
        break
      }
      case 'mention': {
        const all = part.account === 'all'
        segments.push({ type: 'at', data: all ? { qq: 'all' } : { qq: String(part.account ?? ''), ...(part.name ? { name: String(part.name) } : {}) } })
        break
      }
      case 'image': {
        const file = mediaSource(part.media)
        if (!file) { degraded.push('image dropped (没有可发的内容)'); break }
        segments.push({ type: 'image', data: { file } })
        break
      }
      case 'sticker': {
        // 有原段就原样重发：收藏/商城表情只有它认得
        if (part.native && typeof part.native === 'object' && part.native.type) {
          segments.push(part.native)
          break
        }
        const file = mediaSource(part.media)
        if (!file) { degraded.push('sticker dropped (没有可发的内容)'); break }
        segments.push({ type: 'image', data: { file, ...(part.label ? { summary: String(part.label) } : {}) } })
        break
      }
      case 'voice': {
        const file = mediaSource(part.media)
        if (!file) { degraded.push('voice dropped (没有可发的内容)'); break }
        if (voiceMode === 'file') uploads.push({ file, name: `voice-${Date.now()}.mp3` })
        else segments.push({ type: 'record', data: { file } })
        break
      }
      case 'video': {
        const file = mediaSource(part.media)
        if (!file) { degraded.push('video dropped (没有可发的内容)'); break }
        segments.push({ type: 'video', data: { file } })
        break
      }
      case 'file': {
        const file = mediaSource(part.media)
        if (!file) { degraded.push('file dropped (没有可发的内容)'); break }
        uploads.push({ file, name: String(part.media?.name || '') })
        break
      }
      case 'face': {
        const id = faceIdOf?.(String(part.name ?? ''))
        if (id === undefined || id === null || id === '') {
          // 表情编号表里没有这个名字：退回文字，别发出一个空 face 段
          segments.push({ type: 'text', data: { text: `[${String(part.name ?? '表情')}]` } })
          degraded.push('face→text')
          break
        }
        segments.push({ type: 'face', data: { id: String(id), ...(part.value !== undefined && part.value !== null ? { resultId: String(part.value) } : {}) } })
        break
      }
      case 'card': {
        // 声明 card=false，网关会先换成文字；真走到这里说明上游违约，按文字发，别丢内容
        const text = `${part.text || ''}${part.url ? ' ' + part.url : ''}`
        if (text) segments.push({ type: 'text', data: { text } })
        degraded.push('card→text')
        break
      }
      case 'forward': {
        segments.push({ type: 'text', data: { text: '[合并转发]' } })
        degraded.push('forward→text')
        break
      }
      case 'poke':
        pokes.push({ type: 'poke' })
        break
      case 'other': {
        const text = String(part.text || '')
        if (text) segments.push({ type: 'text', data: { text } })
        break
      }
      default:
        log?.warn?.(`出站遇到认不出的 part 类型 ${String(part.type)}，已丢弃`)
        degraded.push(`unknown part (${String(part.type)}) dropped`)
        break
    }
  }
  return { segments, uploads, pokes, degraded }
}

/** PlatformAdapter.toParts 的反向：段 → Part[]（入站翻译用同一个函数，见 inbound.js）。 */
export { segmentsToParts, toParts } from './inbound.js'
