// 内置模块：翻唱。点歌 → 网易云下载 → 分离人声 → RVC 换成她的音色 → 混音 → 发语音条。
// 换声这一步可以在「本地接口」里接你自己的推理（so-vits-svc、自己训练的 RVC……）；整个模块也可以替换掉。

import { createHash } from 'node:crypto'
import { createSongStudio, checkRoot, listDrives } from '../../song/studio.js'
import { privateCapabilityAllowed } from '../../chat/access.js'
import { defineTool, str, int, bool } from '../../tools/tools.js'

/** 翻唱完成后的心情变化：原因记到这次唱歌所在的聊天，别成为全局原因。 */
export function nudgeMoodAfterSong(mood, title, chatId) {
  mood?.nudge?.(8, `唱完了「${title}」`, chatId)
}

export default {
  id: 'song',
  name: '翻唱',
  version: '1.0.0',
  description: '用她的声音翻唱一首歌，做好发语音条（qq_song_cover、/sing）',
  tab: 'song',
  files: ['song/studio.js', 'song/segment.js'],
  setup(api) {
    const { hub, local, http } = api.core
    const mood = api.lazy('mood')
    const memory = api.lazy('memory')
    api.context?.(({ chat }) => {
      if (!api.config().song.enabled || !privateCapabilityAllowed(api.config(), chat, 'song')) return ''
      return '当前私聊对象已经获得主人的点歌授权。对方请求唱歌时可以使用 qq_song_cover，以当前授权为准。'
    })
    const song = createSongStudio({
      local,
      getConfig: api.config,
      log: api.log,
      sendVoiceFile: (chatId, file, note) => hub.sendVoiceFile(chatId, file, note),
      sendText: (chatId, text) => hub.sendText(chatId, text),
      // 翻唱失败那句话不写死：把歌名和可公开的失败原因给她，让她自己挑一句口语说。
      // 回合失败 / 超时 / 空输出直接抛，由 studio 那边发一句兜底短话（不会一声不吭）。
      say: async ({ chatId, title, why }) => {
        // 按聊天分会话：不同的群同时失败时互不排队，也不会把别人的失败混进同一段上下文
        const key = 'fail:' + createHash('md5').update(String(chatId)).digest('hex').slice(0, 8)
        const raw = await hub.runSystemTurn('song-fail', 'QQ · 翻唱失败', failPrompt(title, why), { noTools: true, timeoutMs: 30_000, key })
        const line = cleanFailLine(raw)
        if (!line) throw new Error('模型没说话（[沉默] 或空输出）')
        await hub.sendText(chatId, line)
      },
      onSung: (title, chatId) => {
        const cfg = api.config()
        nudgeMoodAfterSong(mood, title, chatId)
        // 唱过的歌记成她的经历：私聊记到对方头上
        const uid = String(chatId).startsWith('private:') ? String(chatId).slice(8) : ''
        const who = uid === String(cfg.ownerQQ) ? cfg.ownerName || '主人' : uid ? '对方' : '群里'
        memory.addEvent?.({ text: `给${who}唱了《${title}》`, about: uid, tags: ['唱歌'], importance: 0.5 })
        api.emit('song/sung', { title, chatId })
      },
    })

    // 面板里打开了才给她（没开就别让她答应唱歌）
    api.tool(({ chat, sessionId }) => (api.config().song.enabled && chat.kind !== 'system' ? defineTool({
      name: 'qq_song_cover',
      description: '仅在对方点歌、邀唱或要求续唱时使用。普通说话、朗读和语音回复使用 <voice>正文</voice>。用你自己的声音翻唱一首歌，做好后自动以语音条发到当前聊天（耗时取决于长度和电脑性能，成功排队后再说已开始准备）。song 只写歌名和用户指定的歌手，比如「小幸运 田馥甄」；没指定歌手就按歌名搜索，不臆造指定版本。pitch 一般不填：会听原唱人声自动判断男声女声、按你的声线定变调；只有别人明确要求升调降调时才填半音数。别人说清唱、不要伴奏时 acapella 填 true。只唱一段时用 start_sec 指定从第几秒开始，duration_sec 指定唱多少秒；只填时长则从头唱，两项都不填沿用面板截取设置，不能超过面板的最长时长。例如「红日，李克勤的，从第30秒开始，翻唱8秒」应填 song="红日 李克勤", start_sec=30, duration_sec=8。权限限制是限制谁能点歌，不是限制只能发到私聊；被拒时未开始制作。',
      properties: { song: str('歌名（可以带歌手）'), pitch: int('变调半音：一般不填，自动按原唱定；别人明确要求升降调时才填'), acapella: bool('清唱：只留人声，不要伴奏'), start_sec: int('开始位置，整数秒，0 表示从头'), duration_sec: int('唱多少秒，正整数；不能超过面板最长时长') },
      required: ['song'],
      slow: '好，我这就去弄，稍等一会儿（做好了发你）。',
      execute: async ({ song: name, pitch, acapella, start_sec, duration_sec }) => {
        if (api.config().song.ownerOnly && !hub.turnSendersAllOwner(sessionId) && !privateCapabilityAllowed(api.config(), chat, 'song')) return { ok: false, message: chat.kind === 'group' ? '本轮未通过点歌权限检查，未开始制作（合并了其他人的请求也会被拦）。主人可在本群直接发 /sing 歌名，或私聊点歌。' : '你还没有获得点歌权限' }
        return song.request({ song: name, pitch, acapella, startSec: start_sec, durationSec: duration_sec, chatId: chat.chatId })
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
      return song.request({ song: b.song, songId: b.songId, pitch: b.pitch, voice: b.voice, startSec: b.startSec, durationSec: b.durationSec, chatId: b.chatId || `private:${api.config().ownerQQ}` })
    })
    return song
  },
}

// 翻唱失败时给她的提示词：歌名 + 已整理过的失败原因，要一句口语。
// 原因写进来是让她知道「为什么没成」，不是让她复述——所以明说不许念技术细节。
export function failPrompt(title, why) {
  return [
    `有人点了一首《${title}》，但这次没唱成。`,
    `内部原因（只给你看，不要念出来，也不要提技术细节、额度、报错原文）：${why || '没说清'}`,
    '',
    '在 QQ 里跟对方说一句话：',
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
  if (!line || SILENT.test(line) || LEAK.test(line) || /[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|\/[^\s/]+\//.test(line)) return ''
  if (line.length <= 60) return line
  // 太长就截到第一个句末；实在没有句末就硬截
  const cut = line.search(/[。！？!?~～]/)
  return cut >= 4 ? line.slice(0, cut + 1) : line.slice(0, 60)
}
