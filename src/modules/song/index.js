// 内置模块：翻唱。点歌 → 网易云下载 → 分离人声 → RVC 换成她的音色 → 混音 → 发语音条。
// 换声这一步可以在「本地接口」里接你自己的推理（so-vits-svc、自己训练的 RVC……）；整个模块也可以替换掉。

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { createSongStudio, checkRoot, listDrives } from '../../song/studio.js'
import { isOwnerPrivateChat, privateCapabilityAllowed } from '../../chat/access.js'
import { normalizeChatId, parseChatId } from '../../gateway/address.js'
import { defineTool, str, int, bool } from '../../tools/tools.js'

export function recordSungEvent({ cfg, identity, mood, memory, emit, title, chatId }) {
  mood?.nudge?.(8, `唱完了「${title}」`)
  // 唱过的歌记成她的经历：私聊按规范 ChatId 解析并通过 identity.lookup 关联统一档案 PersonId
  const addr = parseChatId(chatId)
  const uid = addr?.kind === 'private' ? String(addr.id || '') : ''
  const person = uid && addr?.platform ? (identity?.lookup?.(addr.platform, uid) || '') : ''
  const ownerChat = isOwnerPrivateChat(identity, chatId)
  const who = ownerChat ? cfg?.ownerName || '主人' : uid ? '对方' : '群里'
  const about = person || (ownerChat ? (identity?.owner?.() || uid) : uid)
  memory?.addEvent?.({ text: `给${who}唱了《${title}》`, about, tags: ['唱歌'], importance: 0.5, chatId: normalizeChatId(chatId) || String(chatId || '') })
  emit?.('song/sung', { title, chatId })
}

export default {
  id: 'song',
  name: '翻唱',
  version: '1.0.0',
  api: 3,
  platforms: ['*'],
  description: '用她的声音翻唱一首歌，做好发语音条（qq_song_cover、/sing）',
  tab: 'song',
  files: ['song/studio.js'],
  setup(api) {
    const { hub, local, http } = api.core
    const mood = api.lazy('mood')
    const memory = api.lazy('memory')
    api.context?.(({ chat }) => {
      if (!api.config().song.enabled || !privateCapabilityAllowed(api.config(), chat, 'song')) return ''
      return '当前私聊对象已经获得主人的点歌授权。对方请求唱歌时可以使用 qq_song_cover，以当前授权为准。'
    })
    async function deliverVoice(chatId, file, note) {
      const caps = typeof api.caps === 'function' ? api.caps(chatId) : null
      if (!caps || typeof api.sendParts !== 'function') {
        return await hub.sendVoiceFile(chatId, file, note)
      }
      const media = { bytes: readFileSync(file), name: basename(String(file || '')) || 'song.mp3', mime: 'audio/mpeg' }
      const titleLabel = String(note || '').replace(/^\[[^\]]+\]\s*/, '').trim()
      if (!caps.voice) {
        if (!caps.file) throw new Error('当前平台不支持发送语音或音频文件')
        api.log.warn(`平台不支持语音能力，点歌「${titleLabel || '音频'}」改用文件发送`)
        const res = await api.sendParts(chatId, [{ type: 'file', media }], { note: note || '[音频文件]', throwOnError: true })
        await hub.sendText?.(chatId, '（当前平台不支持语音条，已改发音频文件）').catch(() => {})
        return res
      }
      const res = await api.sendParts(chatId, [{ type: 'voice', media }], { note: note || '[语音]', throwOnError: true })
      if (res?.degraded?.some((d) => String(d).startsWith('voice dropped'))) {
        if (!caps.file) throw new Error('当前平台不支持发送语音或音频文件')
        api.log.warn(`语音条能力已降级，点歌「${titleLabel || '音频'}」改用文件发送`)
        const fileRes = await api.sendParts(chatId, [{ type: 'file', media }], { note: note || '[音频文件]', throwOnError: true })
        await hub.sendText?.(chatId, '（当前平台不支持语音条，已改发音频文件）').catch(() => {})
        return fileRes
      }
      return res
    }
    const song = createSongStudio({
      local,
      getConfig: api.config,
      log: api.log,
      sendVoiceFile: deliverVoice,
      sendText: (chatId, text) => hub.sendText(chatId, text),
      // 翻唱失败那句话不写死：把歌名和真实原因给她，让她自己挑一句口语说。
      // 回合失败 / 超时 / 空输出直接抛，由 studio 那边发一句兜底短话（不会一声不吭）。
      say: async ({ chatId, title, why }) => {
        // 按聊天分会话：不同的群同时失败时互不排队，也不会把别人的失败混进同一段上下文
        const key = 'fail:' + createHash('md5').update(String(chatId)).digest('hex').slice(0, 8)
        const raw = await hub.runSystemTurn('song-fail', '翻唱失败', failPrompt(title, why), { noTools: true, timeoutMs: 30_000, key })
        const line = cleanFailLine(raw)
        if (!line) throw new Error('模型没说话（[沉默] 或空输出）')
        await hub.sendText(chatId, line)
      },
      onSung: (title, chatId) => recordSungEvent({
        cfg: api.config(),
        identity: api.core.identity,
        mood,
        memory,
        emit: (ev, payload) => api.emit(ev, payload),
        title,
        chatId,
      }),
    })

    // 面板里打开了才给她（没开就别让她答应唱歌）
    api.tool(({ chat, sessionId }) => (api.config().song.enabled && chat.kind !== 'system' ? defineTool({
      name: 'qq_song_cover',
      description: '用你自己的声音翻唱一首歌，做好后自动以语音或音频发到当前聊天（要两三分钟，调用后先简单回一句「等我一下」就好）。song 写歌名，最好带上歌手，比如「小幸运 田馥甄」。pitch 是变调半音：你是女声，原唱是男声时一般 +12，原唱是女声时 0。别人说清唱、不要伴奏时 acapella 填 true。',
      properties: { song: str('歌名（可以带歌手）'), pitch: int('变调半音：原唱男声 +12，女声 0'), acapella: bool('清唱：只留人声，不要伴奏') },
      required: ['song'],
      slow: '好，我这就去弄，稍等一会儿（做好了发你）。',
      execute: async ({ song: name, pitch, acapella }) => {
        if (api.config().song.ownerOnly && !hub.turnSendersAllOwner(sessionId) && !privateCapabilityAllowed(api.config(), chat, 'song')) return { ok: false, message: '你还没有获得点歌权限' }
        const caps = typeof api.caps === 'function' ? api.caps(chat.chatId) : null
        if (caps && !caps.voice && !caps.file) return { ok: false, message: '当前平台不支持发送语音或音频文件，无法在这里发翻唱' }
        const r = song.request({ song: name, pitch, acapella, chatId: chat.chatId })
        if (r?.ok && caps && !caps.voice && caps.file) {
          return { ...r, degraded: 'voice->file', message: `${r.message}（当前平台不支持语音条，做好后将改用音频文件发出）` }
        }
        return r
      },
    }) : []))

    api.route('/song/status', async () => ({ ok: true, ...song.status() }))
    api.route('/song/install', async () => song.install())
    api.route('/song/root/check', async (req) => ({ ok: true, ...checkRoot(http.query(req).path || '') }))
    api.route('/song/drives', async () => ({ ok: true, list: listDrives() }))
    api.route('/song/search', async (req) => {
      try { return { ok: true, list: await song.search(http.query(req).q || '') } } catch (error) { return { ok: false, message: error.message, list: [] } }
    })
    api.route('/song/account', async () => song.account())
    // 导入音色：面板把文件原样传上来（.zip / .pth / .index），文件名放在 ?name= 里
    api.route('/song/import', async (req) => {
      const name = http.query(req).name || ''
      try {
        const buf = await http.raw(req, 1024 * 1024 * 1024)
        if (!buf.length) return { ok: false, message: '文件是空的' }
        const r = song.importModels(name, buf)
        if (r.ok) api.log.info('导入音色：' + r.message)
        return r
      } catch (error) {
        return { ok: false, message: '导入失败：' + error.message }
      }
    })
    api.route('/song/voice/delete', async (req) => song.deleteVoice(String((await http.body(req)).id || '')))
    // 面板里试唱：发到主人私聊
    api.route('/song/request', async (req) => {
      const b = await http.body(req)
      let to = String(b.chatId || '').trim()
      if (!to) {
        const route = typeof api.core.resolveOwnerRoute === 'function'
          ? api.core.resolveOwnerRoute({ purpose: 'proactive' })
          : (typeof api.ownerRoute === 'function' ? api.ownerRoute({ purpose: 'proactive' }) : null)
        if (route) {
          if (route.blocked || !route.chatId) {
            return {
              ok: false,
              blocked: Boolean(route.blocked),
              reason: route.reason || 'no-route',
              message: route.blocked
                ? `主账号当前不可用（${route.reason}），已停止发送`
                : '当前联系不上主人',
            }
          }
          to = route.chatId
        } else {
          to = String(api.ownerChat?.() || api.core.routeOwner?.() || '').trim()
          if (!to) return { ok: false, blocked: false, reason: 'no-route', message: '当前联系不上主人' }
        }
      }
      const caps = typeof api.caps === 'function' ? api.caps(to) : null
      if (caps && !caps.voice && !caps.file) {
        return { ok: false, message: '当前平台不支持发送语音或音频文件，无法试唱' }
      }
      return song.request({ song: b.song, songId: b.songId, pitch: b.pitch, voice: b.voice, chatId: to })
    })
    return { ...song, deliverVoice }
  },
}

// 翻唱失败时给她的提示词：歌名 + 真实原因（标明是内部信息），要一句口语。
// 原因写进来是让她知道「为什么没成」，不是让她复述——所以明说不许念技术细节。
export function failPrompt(title, why) {
  return [
    `有人点了一首《${title}》，但这次没唱成。`,
    `内部原因（只给你看，不要念出来，也不要提技术细节、额度、报错原文）：${why || '没说清'}`,
    '',
    '在聊天里跟对方说一句话：',
    '- 一句话，口语，像你自己在说话；别用客服腔（「抱歉给您带来不便」那种）',
    '- 可以说得含糊、可以撒个娇、可以说回头再试；别编一个具体的技术理由',
    '- 不要出现路径、英文报错、错误码、额度数字',
    '- 只输出这一句话，别加引号，别解释你在做什么',
    '- 实在不想说，就只输出 [沉默]',
  ].join('\n')
}

const SILENT = /^[\[【(（]\s*沉默\s*[\]】)）]$/
// 模型万一把内部信息念出来了（报错原文、路径、额度），这句就不能发，交给兜底
const LEAK = /error|enoent|traceback|http:\/\/|https:\/\/|api[ _-]?key|token|额度|字节|\d+\s*(?:mb|gb)\b/i

/** 把她那一轮说的话洗成一句能直接发出去的：去引号/前缀/多余行，[沉默] 或念了内部信息就当没说话。 */
export function cleanFailLine(text) {
  const first = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s>*#-]+/, '').trim())
    .find(Boolean) || ''
  if (!first || SILENT.test(first)) return ''
  const line = first
    .replace(/^(?:大肥鱼|小鲸鱼|鲸鱼娘|我)\s*[：:]\s*/, '')
    .replace(/^[「"'“”『』]+|[」"'“”『』]+$/g, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!line || SILENT.test(line) || LEAK.test(line)) return ''
  if (line.length <= 60) return line
  // 太长就截到第一个句末；实在没有句末就硬截
  const cut = line.search(/[。！？!?~～]/)
  return cut >= 4 ? line.slice(0, cut + 1) : line.slice(0, 60)
}
