// 内置模块：B 站。别人发来链接时她能「看」视频（标题、简介、字幕、热评）；定时自己去刷、评论、回评论，看到好玩的分享给主人。

import { createBili } from '../../bili/duty.js'
import { defineTool, str } from '../../tools/tools.js'
import { permOf, profileToolVisible, profilePermits } from '../../chat/access.js'
import { avatarSource } from '../profile/index.js'
import { createDanmaku, danmakuPanelRequest } from './danmaku.js'

export default {
  id: 'bili',
  name: 'B站',
  version: '1.2.0',
  description: '看别人发的 B 站视频；定时自己刷、评论、回评论；可选发弹幕；抽帧看画面；按权限改自己的头像 / 签名（bili_watch / bili_comment / bili_danmaku / bili_set_avatar / bili_set_sign）',
  tab: 'bili',
  files: ['bili/duty.js', 'bili/api.js', 'bili/vision.js', 'bili/danmaku.js', 'bili/login-pause.js', 'bili/style-guard.js', 'bili/storyboard.js', 'bili/verify.js', 'bili/history.js'],
  setup(api) {
    const { hub, http } = api.core
    const lastImage = new Map() // chatId → 最近一张图的网址（给 bili_set_avatar 的 last 用）
    api.on('message', (msg) => {
      const url = (msg.images || []).slice(-1)[0]?.data?.url
      if (url && /^https?:\/\//i.test(url)) lastImage.set(msg.chatId, url)
      return false
    })
    const danmaku = createDanmaku(api)
    const bili = createBili({
      getConfig: api.config, hub, memory: api.lazy('memory'), log: api.log, dsh: api.dsh,
      afterBrowse: danmaku.afterBrowse,
    })
    api.every(60_000, () => bili.tick(), '刷B站')
    // 私信单独一条定时器：不跟刷视频 / 看回复抢时间，也不受作息窗口限制。
    // 每分钟跳一次，里面再按 dmPollMinutes 决定这次要不要真去查（查一次就是两个 B 站请求）。
    api.every(60_000, () => bili.dmTick(), 'B站私信')

    // 看视频谁发的链接都能看，评论要主人开口
    api.tool(({ chat, sessionId }) => {
      if (!api.config().bili.enabled || chat.kind === 'system') return []
      return [
        defineTool({
          name: 'bili_watch',
          description: '打开一个 B 站视频看看：读标题、简介、字幕和热评，看完再跟大家聊。别人发来 B 站链接、BV 号或分享卡片时用。link 填链接或 BV 号。',
          properties: { link: str('B 站链接、b23.tv 短链或 BV 号') },
          required: ['link'],
          execute: async ({ link }) => bili.watch(String(link || '')),
        }),
        defineTool({
          name: 'bili_comment',
          description: '在一个 B 站视频下发评论（只有主人让你发的时候才用）。link 填链接或 BV 号，text 是评论内容。要 @ 人就写 @完整昵称 并在后面空一格，@主人 会换成主人的 B 站号。',
          properties: { link: str('B 站链接或 BV 号'), text: str('评论内容') },
          required: ['link', 'text'],
          execute: async ({ link, text }) => {
            // 评论权限：off / owner / all；owner 模式要求本轮所有说话人都是主人
            const perm = permOf(api.config(), 'biliComment')
            if (perm === 'off') return { ok: false, message: '这个操作在面板里关掉了' }
            if (perm === 'owner' && !hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '只有主人能让我去发评论' }
            return bili.comment(String(link || ''), String(text || ''))
          },
        }),
      ]
    })

    // 改 B 站头像 / 签名：权限在面板「权限」页（关 / 仅主人私聊 / 所有人），默认仅主人私聊
    api.tool(({ chat, sessionId }) => {
      const cfg = api.config()
      if (!cfg.bili.enabled) return []
      const tools = []
      if (profileToolVisible(cfg, 'biliAvatar', chat)) tools.push(defineTool({
        name: 'bili_set_avatar',
        description: '换你自己 B 站账号的头像。image 填图片网址；填 last 就用这个聊天里刚才别人发的那张图（最大 2MB）。',
        properties: { image: str('图片网址（http/https），或 last 表示刚才发的那张图') },
        required: ['image'],
        execute: async ({ image }) => {
          const c = api.config()
          if (!c.bili.enabled) return { ok: false, message: 'B 站没打开' }
          const p = profilePermits(c, 'biliAvatar', chat, hub.turnSendersAllOwner(sessionId))
          if (!p.ok) return p
          const raw = String(image || '').trim()
          const useLast = !raw || /^(last|刚才|上一张|最近)/i.test(raw)
          const previous = lastImage.get(hub.chatOfSession?.(sessionId) || chat.chatId)
          if (useLast && !previous) return { ok: false, message: '这个聊天里还没人发过可用的图片网址' }
          // QQ 头像模块现在只校验网址；B站的 last 在这里解析，避免与画作编号混用。
          const src = avatarSource(useLast ? previous : raw)
          if (!src.ok) return src
          return bili.setAvatar(src.file)
        },
      }))
      if (!profileToolVisible(cfg, 'biliSign', chat)) return tools
      return [...tools, defineTool({
        name: 'bili_set_sign',
        description: '改你自己 B 站账号的个性签名（最多 70 字）。有人让你改 B 站签名时用。',
        properties: { text: str('新的签名') },
        required: ['text'],
        execute: async ({ text }) => {
          const c = api.config()
          if (!c.bili.enabled) return { ok: false, message: 'B 站没打开' }
          const p = profilePermits(c, 'biliSign', chat, hub.turnSendersAllOwner(sessionId))
          if (!p.ok) return p
          return bili.setSign(text)
        },
      })]
    })

    api.route('/bili/state', async () => ({ ok: true, ...bili.state(), account: await bili.account() }))
    api.route('/bili/account', async () => bili.account(true))
    api.route('/bili/run', async () => bili.run({ force: true }))
    api.route('/bili/replies', async () => bili.checkReplies())
    api.route('/bili/danmaku/state', async () => danmaku.state())
    for (const action of ['inspect', 'send']) {
      api.route('/bili/danmaku/' + action, async (req) => {
        if (!danmakuPanelRequest(req)) return { ok: false, message: '请从 B 站面板发起弹幕操作' }
        return danmaku[action](await http.body(req))
      })
    }
    api.tool(({ chat, level, sessionId }) => {
      const cfg = api.config()
      if (!cfg.bili.enabled || !cfg.bili.danmakuEnabled || level !== 'full'
        || chat.kind !== 'private' || String(chat.userId) !== String(cfg.ownerQQ)) return []
      return defineTool({
        name: 'bili_danmaku',
        description: '只有主人明确让你发弹幕时才用。link 为视频或番剧链接；seconds 为当前分P内的出现时间（秒），part 为分P或ss链接的选集序号。不要替主人猜时间或内容。',
        properties: {
          link: str('B站视频 / 番剧完整链接或 BV、av、ep、ss 编号'), text: str('一行弹幕文字，最多100字'),
          seconds: { type: 'number', minimum: 0, description: '出现时间（秒）' },
          part: { type: 'integer', minimum: 1, description: '分P / 选集序号，默认1' },
        },
        required: ['link', 'text', 'seconds'],
        execute: async ({ link, text, seconds, part }) => {
          if (!hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '只有主人私聊让我发弹幕才行' }
          return danmaku.send({ video: link, text, seconds, part })
        },
      })
    })
    // ---- 私信：面板上看状态 / 查互关 / 手动查一次 / 手动发一条 ----
    api.route('/bili/dm/state', async () => {
      const c = api.config().bili
      return {
        ok: true,
        enabled: c.dmEnabled, onlyOwner: c.dmOnlyOwner, ownerMid: String(c.ownerMid || ''),
        pollMinutes: c.dmPollMinutes, maxPerDay: c.dmMaxPerDay, gapSec: c.dmGapSec,
        ...(bili.state().dm || {}),
      }
    })
    api.route('/bili/dm/relation', async () => {
      const c = api.config().bili
      const mid = String(c.ownerMid || '').trim()
      if (!mid) return { ok: false, message: '还没填主人的 B 站 mid' }
      try {
        const rel = await bili.relation(mid)
        return { ok: true, mid, mutual: rel.attribute === 6, attribute: rel.attribute, beAttribute: rel.beAttribute }
      } catch (error) { return { ok: false, message: error.message } }
    })
    api.route('/bili/dm/check', async () => bili.checkDm())
    api.route('/bili/dm/send', async (req) => {
      const b = await http.body(req)
      return bili.sendDm(String(b.text || ''), { classify: false })
    })
    // ---- 评论区 @ 我：面板上看待回列表 / 手动回一次 ----
    api.route('/bili/at/state', async () => {
      const c = api.config().bili
      const s = bili.state()
      return {
        ok: true,
        replyEnabled: c.reply !== false,
        ownerMid: String(c.ownerMid || ''),
        ownerName: String(c.ownerName || ''),
        lastCheck: s.lastAtCheck || 0,
        replied: (s.atReplied || []).length,
        repliesToday: s.replies || 0,
        maxRepliesPerDay: c.maxRepliesPerDay,
      }
    })
    // 列出「@ 了我的评论」（只读，不回复）—— 面板上给她看现在有哪些待回
    api.route('/bili/at/list', async () => {
      const ownerMid = String(api.config().bili.ownerMid || '').trim()
      try {
        const feed = await bili.atFeed()
        const done = new Set(bili.state().atReplied || [])
        // 她自己的 mid：以前这里写死了一串数字，换号 / 换机器就对不上了，改成问一次 nav
        const me = String((await bili.account().catch(() => null))?.mid || '')
        const list = feed
          .filter((x) => x.business === '评论')
          .map((x) => ({
            id: x.id, time: x.time, name: x.name, mid: String(x.mid),
            text: x.text, title: x.title, uri: x.uri,
            mine: String(x.mid) === ownerMid,
            // 去重口径跟 checkAts 一致：消息流 id 或「视频 aid + 评论 rpid」任一对上就算回过
            replied: done.has(x.id) || done.has(`a${x.aid}r${x.rpid}`),
            atMe: me ? (x.ats || []).some((a) => String(a.mid) === me) : (x.ats || []).length > 0,
          }))
        return { ok: true, items: list.slice(0, 20), ownerMid }
      } catch (error) { return { ok: false, message: error.message } }
    })
    api.route('/bili/at/check', async () => bili.checkAts())
    // ---- 点赞 / 收藏 ----
    api.route('/bili/likes', async () => ({ ok: true, ...bili.likes(), coolUntil: bili.likeCooldown() }))
    api.route('/bili/like/undo', async (req) => {
      const b = await http.body(req)
      return bili.undoLike(String(b.kind || 'like'), String(b.bvid || ''))
    })
    // ---- 圈地自萌 ----
    api.route('/bili/circle/scan', async (req) => {
      const b = await http.body(req)
      return bili.circleScan(String(b.bvid || ''))
    })
    api.route('/bili/circle/check', async () => bili.checkCircle())
    // ---- 历史 / 日报 / 封面墙 / 鱼日记 ----
    api.route('/bili/history', async (req) => {
      const q = http.query(req)
      return bili.historyView({ limitDays: Number(q.days) || 14 })
    })
    api.route('/bili/report', async (req) => {
      const q = http.query(req)
      const day = String(q.day || '').trim()
      const md = bili.readReport(day)
      return md ? { ok: true, day, markdown: md } : { ok: false, message: '这天还没有日报' }
    })
    api.route('/bili/report/rebuild', async (req) => {
      const b = await http.body(req)
      return bili.rebuildReport(String(b.day || '').trim() || undefined)
    })
    return bili
  },
}
