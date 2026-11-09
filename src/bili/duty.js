// 刷 B 站：定时挑她和你感兴趣的方向去搜视频，读简介、字幕、热评，再按她的人格决定评不评论、分不分享给你、记住什么；
// 定时看别人回她的评论并接着回；你在 QQ 里发链接，她也能点进去看完再聊。看过的、评过的都记成她的经历。

import { dataDir, readJson, writeJson } from '../core/store.js'
import { createBiliApi, findVideoId, parseCookie } from './api.js'
import { loginSessionKey, recoverLoginPause } from './login-pause.js'
import { lookWithVision, visionState } from './vision.js'
import { checkCommentStyle } from './style-guard.js'
import { appendLikeEvent, countToday, currentLike, judgeVerify, rememberVerify, listLikesForUi, readVerify } from './verify.js'
import { appendHistory, dayOf, groupByDay, hasDiaryToday, readDiary, readHistory, readReport, renderReport, reportDays, saveReport, writeDiary } from './history.js'

// 这些错误说明今天别再发了：没登录 / Cookie 过期、csrf 不对、风控、要验证码、太频繁
const PAUSE_CODES = { '-101': 'B 站没登录或 Cookie 过期了', '-111': 'Cookie 里的 bili_jct 不对', '-352': '被 B 站风控了', '-509': '发得太频繁', '12015': 'B 站要求验证码' }
import { isSilence, cleanOutboundText } from '../chat/reply.js'

const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const link = (bvid) => `https://www.bilibili.com/video/${bvid}`

/** 从模型输出里取 JSON（对象或数组），取不到返回 fallback。 */
export function pickJson(out, fallback) {
  const s = String(out || '')
  const m = s.match(/\[[\s\S]*\]/) || s.match(/\{[\s\S]*\}/)
  if (!m) return fallback
  try { return JSON.parse(m[0]) } catch (error) { return fallback }
}

/** 搜到的视频按门槛过滤：播放量够、不太老、没看过。 */
export function filterVideos(list, { minViews = 0, maxAgeDays = 0, seen = new Set(), now = Date.now() } = {}) {
  return (list || []).filter((v) => v.bvid && !seen.has(v.bvid) && (v.play || 0) >= minViews && (!maxAgeDays || !v.pubdate || now - v.pubdate <= maxAgeDays * 86400_000))
}

/** 一个视频交给她看的样子（标题、UP 主、简介、字幕节选、画面描述、热评）。 */
export function digestOf(v, { subtitle = '', comments = [], vision = '' } = {}) {
  return [
    `《${v.title}》 UP主：${v.author || '?'}  播放 ${v.play || 0}${v.tname ? '  分区：' + v.tname : ''}  ${v.bvid}`,
    v.desc ? `简介：${v.desc.slice(0, 300)}` : '',
    subtitle
      ? `字幕（节选）：${subtitle.slice(0, 2500)}`
      : `（没有字幕${vision ? '，只看了画面' : '，只能看标题、简介和评论'}）`,
    vision ? `画面（抽帧）：${vision.slice(0, 900)}` : '',
    comments.length ? '热评：\n' + comments.slice(0, 8).map((c) => `  ${c.name}：${c.text}`).join('\n') : '',
  ].filter(Boolean).join('\n')
}

export function createBili({ getConfig, hub, memory, log, dsh, api: injected, vision: see = lookWithVision, afterBrowse }) {
  const cfg = () => getConfig().bili
  const api = injected || createBiliApi({ getCookie: () => cfg().cookie, log, getThrottle: () => cfg().throttledMs })
  const file = () => dataDir('bili.json')
  const load = () => readJson(file(), () => ({ day: '', runs: 0, comments: 0, replies: 0, lastRun: 0, lastReplyCheck: 0, seen: [], repliedFeed: [], history: [] }))
  const save = (s) => writeJson(file(), s)
  const today = (s) => { if (s.day !== dayKey()) Object.assign(s, { day: dayKey(), runs: 0, comments: 0, replies: 0 }) ; return s }

  /**
   * 合并保存：把 s 里**属于这次流程**的键写回磁盘上的最新状态，其余键保留磁盘上的。
   *
   * 为什么非这样不可：这里每个流程都是「读一份快照 → await 一堆网络 / 模型调用 → 写回」，
   * 而 checkAts / checkReplies / checkDm / run 是各自的定时器、会同时跑。拿旧快照整份覆盖，
   * 就会把别人刚写进去的东西盖掉 —— 典型症状就是 atReplied（"这条 @ 回过了"）被抹掉，
   * 于是每隔 3 分钟把同一条老 @ 再回一遍（老大反馈的「重复回复之前的评论」）。
   *
   * 四类键分开处理：
   *   · history：按 (at,kind,bvid,text) 取并集，不整份替换，免得把别人刚记的一行冲掉；
   *   · 去重集合（atReplied / repliedFeed / dmSeen / circleReplied）：取并集，
   *     谁都别把别人记下的「已处理」抹掉（抹掉 = 重复回）；
   *   · 计数（comments / replies / runs …）：取较大的那个；
   *   · 其余：直接写。
   */
  const SET_KEYS = new Set(['atReplied', 'repliedFeed', 'dmSeen', 'circleReplied'])
  const mergeSave = (s, keys) => {
    const disk = today(load())
    for (const k of keys) {
      // s[k] 是 undefined = 本次流程把这个键清掉了（比如 recoverLoginPause 解除暂停时
      // delete state.pauseDay）。必须删掉磁盘上的同名字段，否则「暂停已解除」只活在内存里，
      // 下次 load() 又把 pauseDay 读回来 —— 登录明明恢复了却一直不发评论。
      // 注意不能用 `k in s` 判断：delete 之后 `in` 就是 false，区分不出「本来没有」和「刚删掉」。
      // 这两个键只有暂停逻辑会写，没值时本身就是「无需暂停」的同义，直接删是对的。
      if (s[k] === undefined) { delete disk[k]; continue }
      if (k === 'history') {
        const map = new Map()
        for (const row of [...(disk.history || []), ...(s.history || [])]) {
          if (!row) continue
          map.set(`${row.at}|${row.kind}|${row.bvid || ''}|${row.text || ''}`, row)
        }
        disk.history = [...map.values()].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 40)
        continue
      }
      if (SET_KEYS.has(k)) {
        const val = [...new Set([...(disk[k] || []), ...(s[k] || [])])]
        disk[k] = val.slice(-400)
        continue
      }
      if (typeof s[k] === 'number' && typeof disk[k] === 'number') { disk[k] = Math.max(disk[k], s[k]); continue }
      disk[k] = s[k]
    }
    save(disk)
    return disk
  }
  let busy = false
  let stopped = false
  let login = { at: 0, key: '', value: { isLogin: false, uname: '' } }
  // 同一个「看 @ / 看回复 / 看私信」不许并发：
  // 面板上手动点一下 + 定时器正好到点，两路会同时看到「这条还没回过」，
  // 然后各发一条 —— 这就是「重复回复」的另一条来路。文件锁在这里，谁先来谁跑。
  const running = new Set()
  const once = async (name, fn) => {
    if (running.has(name)) return { ok: false, message: '正在处理，这一跳跳过' }
    running.add(name)
    try { return await fn() } finally { running.delete(name) }
  }

  const owner = () => getConfig().ownerName || '主人'
  /** 她自己的名字（配置里的角色名）：圈地自萌认「邀请」时要用。
   *  取不到就返回空串 —— 此时只认内置的通用称呼（大肥鱼 / 鱼塘），不点名任何具体人设。 */
  const personaName = () => {
    try {
      const cfg = getConfig() || {}
      return String(cfg.personaName || cfg.botName || '').trim()
    } catch { return '' }
  }
  // 能不能发评论 / 回复：Cookie 里要有 bili_jct，今天也没因为风控之类暂停
  const canPost = (s) => Boolean(parseCookie(cfg().cookie).bili_jct) && s.pauseDay !== dayKey()
  const pauseIf = (s, error) => {
    const why = PAUSE_CODES[String(error.code)]
    if (!why) return
    s.pauseDay = dayKey()
    s.pauseReason = why
    log.warn(`今天先不在 B 站发评论了：${why}`)
  }
  const record = (s, item) => { s.history.unshift({ at: Date.now(), ...item }); s.history = s.history.slice(0, 40) }

  // ---------------------------------------------------------------- 点赞 / 收藏
  // 默认关，而且不是「见一个点一个」：
  //  · 必须写得出理由（至少 6 个字），写不出就不点 —— 没理由的赞就是刷数据；
  //  · 有额度（每轮 / 每天），撞风控（-352 / -412）冷却 30 分钟；
  //  · 一条视频最多一种表态（赞或收藏二选一），不做三连、不投币（硬币不可逆）。
  // 为什么不复用 bili.json 的 history：那份按 (date,bvid) 去重、记的是「看过什么」；
  // 点赞是可反复变的状态（赞了能撤），塞进同一套去重会把撤销记录吃掉，额度也算不准。

  const likeCooldownFile = () => dataDir('bili-like-cooldown.json')
  const likeCoolUntil = () => {
    try { return Number(readJson(likeCooldownFile(), {})?.until || 0) } catch (error) { return 0 }
  }
  const setLikeCool = (ms, why) => {
    try { writeJson(likeCooldownFile(), { until: Date.now() + ms, why }) } catch (error) { /* 写不进去就下次再说 */ }
    log.warn(`点赞/收藏先停 ${Math.round(ms / 60000)} 分钟：${why}`)
  }

  /**
   * 判断这条视频值不值得表态，以及能不能表态。
   * 返回 { ok:true, kind } 或 { ok:false, reason }。
   */
  function canExpress(s, v) {
    const c = cfg()
    if (!c.like) return { ok: false, reason: '点赞没开' }
    if (getConfig().dryRun) return { ok: true, kind: 'like', dryRun: true }
    if (Date.now() < likeCoolUntil()) return { ok: false, reason: '风控冷却中' }
    if (!canPost(s)) return { ok: false, reason: '今天先不发了' }
    const day = dayKey()
    const perRound = Math.max(0, Number(c.likePerRound ?? 3))
    if (countToday('like', day, s.lastRun || 0) >= perRound) return { ok: false, reason: `这轮点赞够了（${perRound}）` }
    const likeMax = Math.max(0, Number(c.likePerDay ?? 10))
    const favMax = Math.max(0, Number(c.favPerDay ?? 8))
    const liked = currentLike('like', v.bvid)
    const faved = currentLike('fav', v.bvid)
    if (liked?.like) return { ok: false, reason: '已经赞过' }
    if (faved?.like) return { ok: false, reason: '已经收藏过（一条视频只做一种表态）' }
    if (c.fav && countToday('fav', day) < favMax) return { ok: true, kind: 'fav' }
    if (countToday('like', day) < likeMax) return { ok: true, kind: 'like' }
    return { ok: false, reason: '今天额度用完了' }
  }

  /** 给一条视频点赞或收藏。reason 少于 6 个字直接拒（写不出理由就不许点）。 */
  async function maybeLike(s, v, { reason = '', force = '' } = {}) {
    const why = cleanOutboundText(reason, { warn: () => {} }).trim()
    if (why.replace(/[\s\p{P}]/gu, '').length < 6) return { ok: false, reason: '理由太短（至少 6 个字）' }
    const gate = canExpress(s, v)
    if (!gate.ok) return { ok: false, reason: gate.reason }
    const kind = force === 'fav' || force === 'like' ? force : gate.kind
    if (gate.dryRun) return { ok: true, dryRun: true, kind }
    try {
      if (kind === 'fav') await api.favVideo(v.aid, { fid: cfg().favFolderId || 0, on: true })
      else await api.likeVideo(v.aid, true)
    } catch (error) {
      const msg = String(error.message || '')
      if (/-352|-412|风控/.test(msg)) setLikeCool(30 * 60_000, msg)
      return { ok: false, reason: msg }
    }
    appendLikeEvent({ ts: Date.now(), day: dayKey(), kind, bvid: v.bvid, like: true, reason: why, title: String(v.title || ''), owner: String(v.author || '') })
    memory?.addEvent?.({ text: `在B站${kind === 'fav' ? '收藏' : '点赞'}了《${String(v.title || '').slice(0, 30)}》：${why.slice(0, 40)}`, tags: ['B站'], importance: 0.3 })
    record(s, { kind, title: v.title, bvid: v.bvid, text: why.slice(0, 60) })
    log.info(`B 站${kind === 'fav' ? '收藏' : '点赞'}：${v.bvid}（${why.slice(0, 20)}）`)
    return { ok: true, kind }
  }

  /** 撤销（只能撤自己赞过的；撤销不返还额度）。 */
  async function undoLike(kind, bvid) {
    const cur = currentLike(kind, bvid)
    if (!cur?.like) return { ok: false, reason: '没有可撤销的记录' }
    const v = await api.view(bvid).catch(() => null)
    if (!v?.aid) return { ok: false, reason: '取不到这个视频' }
    try {
      if (kind === 'fav') await api.favVideo(v.aid, { fid: cfg().favFolderId || 0, on: false })
      else await api.likeVideo(v.aid, false)
    } catch (error) { return { ok: false, reason: error.message } }
    appendLikeEvent({ ts: Date.now(), day: dayKey(), kind, bvid, like: false, reason: '撤销', title: String(v.title || ''), owner: String(v.author || '') })
    return { ok: true }
  }

  // ---------------------------------------------------------------- 日报 / 封面墙 / 肥鱼日记
  // 这一轮看了什么、挑中哪些、为什么 —— 记成长期历史，再渲染成日报。
  // 历史只存原始事实（时间/BV/标题/封面/UP/时长/播放/挑中与否/原因），
  // 分组和统计都在渲染时算，以后想改规则不用重写历史。

  /** 把这一轮的结果记进历史，并按天写日报 + 肥鱼日记。 */
  async function writeRoundDigest(s, looked = [], felt = new Map(), stats = {}) {
    const day = dayOf()
    const entries = []
    // 这一轮每个视频实际做了什么（看了 / 评论 / 收藏 / 点赞 / 分享）：
    // 面板一行一个视频，把这些动作并排标出来，而不是一个动作占一行。
    const actsOf = (bvid) => [...new Set((s.history || [])
      .filter((h) => h.bvid === bvid && h.kind !== 'error' && h.kind !== 'skip')
      .map((h) => h.kind))]
    for (const x of looked) {
      const info = x.info || {}
      const reason = String(felt.get(info.bvid) || '').trim()
      const myComment = (s.history || []).find((h) => h.kind === 'comment' && h.bvid === info.bvid)
      const e = appendHistory({
        day,
        bvid: info.bvid,
        title: info.title || '',
        owner: info.author || '',
        cover: String(info.cover || '').startsWith('//') ? 'https:' + String(info.cover || '') : String(info.cover || ''),
        duration: Number(info.duration) || 0,
        views: Number(info.stat?.view) || 0,
        // 挑中 = 她自己写了评论或分享了；只看了没说话的算跳过
        pick: myComment ? 'pick' : 'skip',
        kinds: actsOf(info.bvid),
        reason,
        comment: myComment ? myComment.text : '',
        link: link(info.bvid),
      })
      if (e) entries.push(e)
    }
    if (!entries.length) return null

    // 肥鱼日记：一天一篇，用她自己的口气写，不是操作日志
    let diary = null
    if (cfg().diary !== false && !hasDiaryToday(day)) {
      try {
        const picked = entries.filter((e) => e.pick === 'pick')
        const out = await think(`你今天在 B 站看了这几个视频：\n${entries.map((e) => `- 《${e.title}》${e.reason ? '（' + e.reason + '）' : ''}`).join('\n')}\n\n挑中 ${picked.length} 个。用你自己的口气写一小段今天的「鱼日记」：看了什么、为什么挑中、有什么感受。像写在日记本上，不要罗列、不要 Markdown、不要写操作过程。只输出正文，60-120 字。`)
        const text = cleanOutboundText(out, { warn: (m) => log.warn(`鱼日记：${m}`) }).trim()
        if (text && !isSilence(text)) diary = writeDiary({ day, text, picks: entries.filter((e) => e.pick === 'pick').map((e) => e.bvid) })
      } catch (error) { log.debug('鱼日记没写成：', error.message) }
    }
    if (!diary) diary = readDiary().find((x) => x.day === day) || null

    // 日报：按天覆盖写（一天一份，最新一轮会把当天所有条目重新渲染一遍）
    if (cfg().report !== false) {
      const todays = readHistory().filter((e) => e.day === day)
      const md = renderReport({ day, entries: todays, diary, stats })
      if (saveReport(day, md)) log.debug(`日报写好了：${day}`)
    }
    return { day, entries: entries.length, diary: Boolean(diary) }
  }

  /** 面板要的：封面墙（按天分组）+ 日报 + 日记。 */
  function historyView({ limitDays = 14 } = {}) {
    const all = readHistory()
    const days = groupByDay(all).slice(0, Math.max(1, Number(limitDays) || 14))
    return {
      ok: true,
      days,
      diary: readDiary().slice(0, 30),
      reports: reportDays().slice(0, 30),
      counts: { total: all.length, picked: all.filter((e) => e.pick === 'pick').length },
    }
  }

  /** 手动补写一份日报（面板「重新生成今天的日报」）。 */
  async function rebuildReport(day = dayOf()) {
    const entries = readHistory().filter((e) => e.day === day)
    const diary = readDiary().find((x) => x.day === day) || null
    const md = renderReport({ day, entries, diary, stats: { comments: entries.filter((e) => e.comment).length } })
    return saveReport(day, md) ? { ok: true, day, entries: entries.length } : { ok: false, message: '写不进去' }
  }

  // ---------------------------------------------------------------- 圈地自萌
  // 规矩（跟参考实现一致，理由也一致）：开了之后**绝不发新楼**，
  // 只回「视频 UP 主本人发的一级评论」里的明确邀请，而且同一个 (BV, 邀请 rpid) 只回一次。
  // 为什么这么严：她发出去的每个字都算在主人账号上，去别人评论区主动搭话最容易惹麻烦。

  const CIRCLE_NEG = /别来|不要来|不用来|别刷|不要刷|别评论|不要评论|别回|不要回|不欢迎|禁止|滚/
  // 正向邀请：名字 + 动作，或者 动作 + 名字。名字支持「大肥鱼 / 鱼塘」，
  // 也支持配置里她自己的名字（ownerName 不是她的名字，角色名由调用方传入）。
  const circlePos = (name) => {
    const n = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return [
      new RegExp(`(?:${n}|大肥鱼|鱼塘(?:的鱼)?)[^。！？!?\\n]{0,16}(?:快来|来评论|来玩|过来|来)(?!了|过|着|没|吗)`),
      new RegExp(`(?:^|[\\s@])(?:快来|来)[^。！？!?\\n]{0,12}(?:${n}|大肥鱼|鱼塘)`),
      // 「鱼来评论区玩」这种简写：鱼 + 来 + 可选场所，后面不能再接「了/过/着/没/吗」
      new RegExp(`(?:^|[\\s@])鱼(?:快来|来)(?:评论区|楼中楼|玩)?(?!了|过|着|没|吗)`),
    ]
  }

  /** 这条评论是不是对「她」的邀请。否定语义优先。 */
  function isInvite(text, name = '') {
    const v = String(text || '').replace(/\s+/g, ' ').trim()
    if (!v) return { ok: false, why: 'empty' }
    if (CIRCLE_NEG.test(v)) return { ok: false, why: 'negative' }
    if (circlePos(name).some((re) => re.test(v))) return { ok: true, why: 'invite' }
    return { ok: false, why: 'not-invite' }
  }

  /**
   * 扫一条视频的评论区，找出 UP 主本人发的邀请。
   * 只读，不发任何东西 —— 面板上「看看有哪些邀请」和自动跑都用它。
   */
  async function circleScan(bvidOrAid) {
    const c = cfg()
    const id = String(bvidOrAid || '').trim()
    if (!id) return { ok: false, message: '要给 BV 号或 aid' }
    let aid = Number(id)
    let bvid = ''
    if (!aid) {
      const found = findVideoId(id)
      bvid = found?.bvid || (String(id).match(/BV[0-9A-Za-z]{10}/) || [])[0] || ''
      if (!bvid) return { ok: false, message: '认不出这个 BV 号' }
      const v = await api.view(bvid)
      aid = v?.aid
      if (!aid) return { ok: false, message: '取不到这个视频' }
    }
    const owner = await api.videoOwner(aid)
    if (!owner.mid) return { ok: false, message: '取不到 UP 主' }
    const list = await api.commentsBy(aid, { order: 'time', limit: 100 })
    const done = new Set((load().circleReplied || []))
    const invites = []
    for (const x of list) {
      if (Number(x.mid) !== owner.mid) continue // 只认 UP 主本人
      const hit = isInvite(x.text, personaName())
      if (!hit.ok) continue
      invites.push({ ...x, bvid, aid, match: hit.why, replied: done.has(`${bvid}|${x.rpid}`) })
    }
    return { ok: true, bvid, aid, owner, scanned: list.length, invites }
  }

  /**
   * 圈地自萌的一跳：扫 UP 主自己最近投稿的评论区，看到邀请就回楼中楼。
   * 绝不发新楼；同一 (BV, 邀请 rpid) 只回一次；发完照样复核公开可见性。
   */
  const checkCircle = () => once('circle', checkCircleRun)
  async function checkCircleRun() {
    const c = cfg()
    if (!c.circleMode) return { ok: false, message: '圈地自萌没开' }
    if (!c.circleOwnerUid) return { ok: false, message: '还没填「谁的作品下可以回」的 UP 主 mid' }
    const s = today(load())
    const done = new Set(s.circleReplied || [])
    let n = 0
    try {
      const videos = await api.userVideos(c.circleOwnerUid, { ps: Math.max(1, Number(c.circleScope) || 5) })
      for (const v of videos) {
        if (n >= Math.max(1, Number(c.circlePerRound) || 2)) break
        if (s.replies >= c.maxRepliesPerDay || !canPost(s)) break
        let scan
        try { scan = await circleScan(v.bvid) } catch (error) { log.debug(`圈地：扫 ${v.bvid} 失败`, error.message); continue }
        if (!scan.ok) continue
        for (const inv of scan.invites) {
          if (n >= Math.max(1, Number(c.circlePerRound) || 2)) break
          const key = `${v.bvid}|${inv.rpid}`
          if (done.has(key)) continue
          let reply = ''
          try {
            const out = await think(`视频《${v.title}》的 UP 主在评论区邀请你：「${inv.text}」\n用你平时的口气回一句（像普通网友，短一点，别客套，别写 Markdown）。不想回就只输出 [沉默]。只输出回复正文。`)
            reply = cleanOutboundText(out, { warn: (m) => log.warn(`圈地回复：${m}`) }).trim().split(/\n+/)[0]
          } catch (error) { log.warn('圈地回复没想出来：', error.message); continue }
          if (!reply || isSilence(reply)) { done.add(key); continue }
          try {
            let sent = null
            if (getConfig().dryRun) log.info(`试运行：本来要回 UP 主邀请：${reply}`)
            // 关键：root/parent 都指向那条邀请评论 ⇒ 这是楼中楼，不是新楼
            else sent = await api.postComment(scan.aid, normalizeMention(reply).slice(0, 200), { root: inv.rpid, parent: inv.rpid })
            done.add(key)
            s.replies++
            n++
            const rpid = String(sent?.rpid || '')
            record(s, { kind: 'reply', title: v.title, bvid: v.bvid, text: `圈地回邀请：${inv.text.slice(0, 30)} → ${reply}`, rpid })
            memory?.addEvent?.({ text: `在B站回了UP主的邀请：${reply.slice(0, 50)}`, tags: ['B站'], importance: 0.4 })
            if (rpid && !getConfig().dryRun) {
              const vr = await api.verifyReply({ aid: scan.aid, rpid, root: inv.rpid }).catch(() => null)
              rememberVerify({ bvid: v.bvid, aid: scan.aid, rpid, root: inv.rpid, title: v.title, text: reply.slice(0, 60), ...judgeVerify(vr) })
            }
          } catch (error) {
            log.warn('圈地回复失败：', error.message)
            pauseIf(s, error)
          }
        }
      }
      s.circleReplied = [...done].slice(-300)
      return { ok: true, message: n ? `圈地回了 ${n} 条` : '没有新的邀请', replied: n }
    } catch (error) {
      log.warn('圈地出错：', error.message)
      return { ok: false, message: error.message, replied: n }
    } finally {
      mergeSave(s, ['circleReplied', 'replies', 'history', 'pauseDay', 'pauseReason'])
    }
  }


  async function account(force = false) {
    const key = loginSessionKey(cfg().cookie)
    if (!force && key === login.key && Date.now() - login.at < 10 * 60_000) return login.value
    try {
      const value = await api.nav()
      if (stopped || key !== loginSessionKey(cfg().cookie)) return { isLogin: false, uname: '', error: '登录态已变化，请重新检查' }
      login = { at: Date.now(), key, value }
      const s = load()
      if (recoverLoginPause(s, { isLogin: value.isLogin, sessionKey: key, day: dayKey() })) {
        // 只写回暂停相关的键：这份 s 是刚读的，但别的流程随时可能在写同一个文件
        mergeSave(s, ['pauseDay', 'pauseReason', 'loginPauseRecovery'])
        log.info('B 站登录核验通过，已解除登录失效导致的评论暂停')
      }
    } catch (error) {
      login = { at: Date.now(), key, value: { isLogin: false, uname: '', error: error.message } }
    }
    return login.value
  }

  async function think(prompt) {
    return hub.runSystemTurn('bili', 'QQ · 刷B站', `【刷 B 站，不是聊天，这一轮不会发到聊天里】\n${prompt}`, { timeoutMs: 180000 })
  }

  /** 这一轮搜什么：她自己的兴趣 + 记忆里你喜欢的东西 + 面板里填的关键词，让她挑 3 个。 */
  async function chooseKeywords() {
    const c = cfg()
    const interests = [...(c.keywords || []), ...(getConfig().group.interests || [])]
    const about = (memory?.list?.('') || []).filter((m) => String(m.about) === String(getConfig().ownerQQ) || /喜欢|爱|想|在玩|在看|追/.test(m.text)).slice(0, 12).map((m) => m.text)
    const recent = (memory?.recentEvents?.(72, 6) || []).filter((m) => (m.tags || []).includes('B站')).map((m) => m.text)
    try {
      const out = await think(`你想去 B 站刷点视频。你感兴趣的：${interests.join('、') || '随便看看'}。\n你记得的关于${owner()}和大家的事：\n${about.map((t) => '- ' + t).join('\n') || '（暂无）'}\n最近刷过的：\n${recent.map((t) => '- ' + t).join('\n') || '（暂无）'}\n\n挑 3 个这次想搜的关键词（可以是你自己想看的，也可以是${owner()}可能喜欢、你想分享给${owner()}的），别和最近刷过的重复。只输出 JSON 数组，例如 ["白米饭 做法","猫咪 搞笑"]。`)
      const arr = pickJson(out, []).map((k) => String(k).trim()).filter(Boolean)
      if (arr.length) return arr.slice(0, 3)
    } catch (error) {
      log.debug('挑关键词失败：', error.message)
    }
    return interests.sort(() => Math.random() - 0.5).slice(0, 3)
  }

  async function lookAt(v) {
    const rawInfo = await api.view({ bvid: v.bvid })
    const info = {
      ...rawInfo,
      title: cleanOutboundText(rawInfo.title, { warn: (message) => log.warn(`B 站标题：${message}`) }).trim(),
      author: cleanOutboundText(rawInfo.author, { warn: (message) => log.warn(`B 站作者：${message}`) }).trim(),
    }
    const [subtitle, comments] = await Promise.all([api.subtitle(info).catch(() => ''), api.comments(info.aid).catch(() => [])])
    // 开着「看画面」才抽帧：失败一律只记 debug，退回纯文本，不影响这一轮。
    // 抽到的帧只用来给视觉模型看，不再落盘 —— 那些图除了占硬盘没有别的用处。
    let vision = ''
    const c = cfg()
    if (c.vision) {
      try {
        const r = await see({ dsh, api, info, getConfig, log })
        vision = r.text || ''
        if (vision) log.debug(`看了《${info.title}》的画面：${vision.slice(0, 40)}…`)
      } catch (error) {
        log.debug(`看画面失败（${info.bvid}）：`, error.message)
      }
    }
    return { info, subtitle, comments, vision, digest: digestOf(info, { subtitle, comments, vision }) }
  }

  /**
   * 她写 @主人 时换成主人的 B 站昵称，名字后面要有空格才算结束。
   * 没填 ownerName 就把 @主人 删掉 —— 留着「@主人」发出去是死文本，B 站不会当 @，还很难看。
   *
   * 三个坑都踩过，这里一起兜住：
   *  ① `@ 主人`（@ 后面带空格）：模型写中文的习惯，老正则匹配不到 → 原样发出去 = 死文本。
   *  ② 全角 ＠：手机上打出来的常常是全角。
   *  ③ 名字后面留了空格 —— B 站其实认「@名字」后面跟空格，这里保留没问题；
   *     但**@ 和名字之间绝不能有空格**，B 站只认紧挨着的写法，带空格等于没 @ 到人（而且不报错）。
   */
  const atOwner = (text) => {
    const name = String(cfg().ownerName || '').trim()
    // @ 与「主人」之间允许夹任意空白（含全角空格）
    const re = /[@＠][\s\u3000]*主人/g
    const s = String(text)
    if (name) return s.replace(re, `@${name}`)
    return s.replace(re, '')
  }

  /**
   * 发评论前的最后一道：把「@ 昵称」压成「@昵称」。
   * B 站只认紧挨着的写法，`@ 风止雨却来` 会被当成普通文字，评论照发、接口照样返回成功，
   * 但对方收不到任何通知 —— 属于「看起来没问题、其实白发了」的坑，而且没有任何报错。
   * 只处理「@ + 空白 + 紧跟的非空白字符」，所以「单独一个 @ 号」和邮箱 a@b.com 都不会被误伤。
   */
  const normalizeMention = (text) => String(text || '').replace(/[@＠][\s\u3000]+(?=[^\s\u3000])/g, '@')

  /**
   * 把「@主人」从评论中间/结尾挪到**最前面**。
   * 老大要的格式：「@风止雨却来 老大，今天的饭好香」
   *   —— @ 在最前，正文跟在后面；不要「正文…… @风止雨却来」那种尾巴。
   * 只动「@ + 主人昵称」这一处（不碰评论里 @ 别人），且：
   *   · 昵称后面紧跟的空白/标点一起吃掉，免得留下「，」或双空格；
   *   · 正文为空时就不加（光一个 @ 没有意义）；
   *   · 已经顶在最前面就原样返回（幂等，重复调用不会堆多个 @）。
   * 注意：必须在 atOwner() 之后调（那时「@主人」已换成真昵称）。
   */
  const hoistOwnerMention = (text) => {
    const name = String(cfg().ownerName || '').trim()
    if (!name) return String(text || '')
    let s = String(text || '')
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // 只吃掉「@昵称」本身 + 紧邻的空白。
    // 不能连后面的标点一起吞：`正文。@昵称。` 里最后一个句号属于正文，吞了就丢标点。
    const re = new RegExp(`[@＠]\\s*${esc}[\\s\u3000]*`, 'g')
    let found = false
    s = s.replace(re, () => { found = true; return '' })
    // 摘掉 @ 之后可能留下「，，」「。。」这种双标点，收成一个
    s = s.replace(/([，,、。.！!？?：:；;])\s*\1+/g, '$1')
    // 多行收成单行：B 站评论里换行没意义，还会让 @ 前置后的正文看起来散
    s = s.replace(/\s*\n+\s*/g, ' ').replace(/[ \t\u3000]{2,}/g, ' ').trim()
    // 中文标点前后不留空格（`正文 。` → `正文。`，`正文 ，尾巴` → `正文，尾巴`）
    s = s.replace(/\s+([，,、。.！!？?：:；;）)】」』])/g, '$1')
    s = s.replace(/([（(【「『])\s+/g, '$1')
    if (!found) return String(text || '').trim() // 没 @ 主人：一个字都别动
    // 去掉 @ 位置残留的首尾标点（「@昵称，正文」摘掉 @ 后变成「，正文」）
    s = s.replace(/^[，,、。.！!？?：:；;\s\u3000]+/, '').trim()
    if (!s) return '' // 只有 @ 没有正文：整条不发（调用方会当空评论跳过）
    return `@${name} ${s}`
  }

  /**
   * 发评论前的收尾：确保「@主人」在**最前面**，且正文里不再有别的 @主人。
   * 和 hoistOwnerMention 的区别：这里连「模型压根没写 @」的情况也补上 ——
   * 老大要的是每条评论都 @ 他（这是他看到推荐的唯一途径），不能靠模型自觉。
   * 关掉：配置里 bili.alwaysAtOwner = false。
   */
  const finalizeComment = (raw) => {
    const name = String(cfg().ownerName || '').trim()
    const body = normalizeMention(atOwner(String(raw || ''))).trim()
    if (!name) return body
    if (cfg().alwaysAtOwner === false) return hoistOwnerMention(body)
    if (!body) return ''
    // 先按「有 @」的路子归一（去掉正文里的 @ 并提到最前）
    const hoisted = hoistOwnerMention(body)
    if (hoisted.startsWith(`@${name}`)) return hoisted
    // hoistOwnerMention 返回空 = 原文只有 @、没有正文（它自己判定「整条不发」）。
    // 这时**不能**再补一个 @，否则会变成「@昵称 @昵称」。
    if (!hoisted) return ''
    return `@${name} ${body}`
  }

  // ---------------------------------------------------------------- 私信
  // 读：列会话 + 拉某个会话的消息（只认主人）
  // 写：web_im/send_msg（必须互关、限 300 字、每天有限额、两条之间有间隔）

  /** 主人 mid 从配置里取（面板可以填），取不到就返回空。B 站私信只往这个号发，别的号一律不发。 */
  function loadOwnerMid() {
    const c = cfg()
    return String(c.ownerMid || '').trim()
  }

  /** 发一条私信给主人。classify = false 时不做「是不是主人」的判断（内部已经确定）。 */
  async function sendDm(text, { classify = true } = {}) {
    const c = cfg()
    const mid = loadOwnerMid()
    const body = cleanOutboundText(String(text || ''), { warn: (m) => log.warn(`B 站私信：${m}`) }).trim()
    if (!body) return { ok: false, message: '私信是空的' }
    if (!mid) return { ok: false, message: '还没填主人的 B 站 mid（面板「刷B站」里填）' }
    if (!canPost(today(load()))) return { ok: false, message: '今天先不发了（登录失效或风控暂停）' }
    if (body.length > 300) return { ok: false, message: `私信太长（${body.length} > 300 字）` }
    const s = today(load())
    if (Number(s.dmSent || 0) >= Number(c.dmMaxPerDay || 30)) return { ok: false, message: `今天的私信额度用完了（${c.dmMaxPerDay} 条）` }
    const gap = Number(c.dmGapSec || 15) * 1000
    if (s.dmLastAt && Date.now() - s.dmLastAt < gap) return { ok: false, message: `刚发过，间隔还没到（${c.dmGapSec} 秒）` }
    // 互关检查：不是互关 B 站会直接拒
    const rel = await api.relation(mid).catch(() => ({ ok: false, attribute: -1 }))
    if (rel.ok && rel.attribute !== 6) {
      return { ok: false, message: `没和主人互关（attribute=${rel.attribute}），B 站不让发私信` }
    }
    if (getConfig().dryRun) {
      log.info(`试运行：本来要私信主人「${body.slice(0, 40)}」`)
      return { ok: true, dryRun: true }
    }
    try {
      const r = await api.dmSend(mid, body)
      if (!r.ok) return { ok: false, message: `B 站没接受（code=${r.code}${r.message ? ' ' + r.message : ''}）` }
      const st = today(load())
      st.dmSent = Number(st.dmSent || 0) + 1
      st.dmLastAt = Date.now()
      // 先记录再存：以前 save() 写在 record() 前面，这条流水存完就被丢了
      record(st, { kind: 'dm', title: '私信主人', text: body.slice(0, 80) })
      mergeSave(st, ['dmSent', 'dmLastAt', 'history'])
      return { ok: true }
    } catch (error) {
      return { ok: false, message: '发私信失败：' + error.message }
    }
  }

  /**
   * 看有没有新私信并回。只看主人的会话（dmOnlyOwner=true 时），
   * 别人的私信记一笔但不回 —— 免得替主人社交、也免得被判定成骚扰。
   */
  const checkDm = () => once('dm', checkDmRun)
  async function checkDmRun() {
    const c = cfg()
    if (!c.dmEnabled) return { ok: false, message: '私信没打开' }
    const mid = loadOwnerMid()
    if (!mid) return { ok: false, message: '还没填主人的 B 站 mid' }
    const s = today(load())
    s.dmCheckedAt = Date.now()
    const seen = new Set(s.dmSeen || [])
    let replied = 0
    try {
      // 先花一次很轻的请求看有没有未读：会话列表里 unread>0 才值得往下拉 50 条消息。
      // 没有未读就直接返回 —— 平时大部分轮询都走这条路，省一半请求，也少踩风控。
      // （列会话这个接口本身没问题；之前 -509 是发得太密，现在有节流和冷却兜着。）
      // 兜底：unread 万一不准（B 站在某些端上不维护这个计数），每 5 次强制全量读一遍，
      // 免得「一直显示没有未读」把真消息永远漏掉。
      {
        const n = Number(s.dmChecks || 0) + 1
        s.dmChecks = n
        const forceFull = n % 5 === 0
        if (!forceFull) {
          const list = await api.dmSessions().catch(() => null)
          if (Array.isArray(list)) {
            const mine = list.find((x) => String(x.uid) === String(mid))
            if (!mine || Number(mine.unread) === 0) {
              const disk0 = today(load())
              disk0.dmCheckedAt = s.dmCheckedAt
              disk0.dmChecks = n
              save(disk0)
              return { ok: true, message: '没有新私信', replied: 0 }
            }
          }
        }
        // 列会话失败 / 到点强制全量：照常往下拉消息
      }
      // 只认主人一个：直接读和他的会话，不先列会话列表。
      {
        // size 要给够：只拉 10 条时，很容易被她自己的回复挤满，把主人真正说的话挤出窗口
        // （踩过：主人问「现在在了吗」，最新 10 条全是我发的测试消息，这句话根本不在里面）。
        // 50 是 B 站单次上限，多拉几条只是多比几次 key，不多发请求。
        const msgs = await api.dmMessages(mid, { size: 50 })
        // 时效窗口：只回最近 24 小时内的私信。
        // 积压的旧消息（插件没跑、被风控挡住那几天攒下的）如果全补回一遍，
        // 看起来就像隔了一天突然诈尸，反而吓人。旧的标成已读，不再补。
        const FRESH_MS = 24 * 3600_000
        const now = Date.now()
        const all = msgs.filter((m) => !m.fromMe && !seen.has(m.key))
        const stale = all.filter((m) => now - m.ts > FRESH_MS)
        if (stale.length) { for (const m of stale) seen.add(m.key); log.debug(`私信：${stale.length} 条超过 24 小时，跳过不补回`) }
        // 从新往旧挑，最多 3 条，再按时间正序回（这样对话顺序是对的）
        const fresh = all.filter((m) => now - m.ts <= FRESH_MS).slice(-3)
        for (const m of fresh) {
          // 只在「真处理完」之后才写进 seen。
          // 以前是先 seen.add 再发，一旦发送失败这条就永远算已读，再也不会重试 —— 主人发的话等于石沉大海。
          hub.logChat?.('bili', String(c.ownerName || getConfig().ownerName || '主人'), `B 站私信：${m.text}`, '')
          if (replied >= 3) break // 一轮最多回 3 条，剩下的留到下一轮（不写 seen）
          // 逐条兜住：模型这一句失败不能让整轮私信都断（不然一条卡住，后面永远轮不到）
          let reply = ''
          try {
            const out = await think(`主人在 B 站私信你：「${m.text}」\n用你平时的口气回一句（像手机聊天，短一点，别客套，别写 Markdown）。不想回就只输出 [沉默]。只输出回复正文。`)
            reply = cleanOutboundText(out, { warn: (msg) => log.warn(`B 站私信回复：${msg}`) }).trim().split(/\n+/)[0]
          } catch (error) {
            log.warn('私信回复没想出来：', error.message)
            continue // 不写 seen，下一轮重试
          }
          if (!reply || isSilence(reply)) { seen.add(m.key); continue } // 明确不想回，算处理完
          // 两条之间要留间隔（防 B 站判刷屏）。以前是撞上间隔就 break，一轮只回一条，
          // 剩下的要等下一轮 —— 表现就是「你说两句，她只回一句，另一句过几分钟才回」。
          // 这里改成**原地等够再发**：间隔只有 15 秒，等得起，一轮就能把话说完。
          {
            const gapMs = Math.max(0, Number(c.dmGapSec || 15)) * 1000
            const last = Number(today(load()).dmLastAt || 0)
            const wait = last + gapMs - Date.now()
            if (wait > 0 && wait < 90_000) {
              log.debug(`私信：等下 ${Math.ceil(wait / 1000)} 秒再发下一条`)
              await new Promise((r) => setTimeout(r, wait))
            }
          }
          const r = await sendDm(reply, { classify: false })
          if (r.ok) {
            seen.add(m.key)
            replied++
            memory?.addEvent?.({ text: `在 B 站私信里回了主人：${reply.slice(0, 50)}`, tags: ['B站'], importance: 0.4 })
          } else {
            log.debug('私信回复没发出去：', r.message)
            break // 不写 seen：这一轮停手，下一轮再试
          }
        }
      }
      // 只把 dmSeen 合回磁盘上的最新状态。
      // 不能直接 save(s)：s 是进函数时读的，而中途 sendDm() 已经改过 dmSent / dmLastAt，
      // 拿旧对象整份写回去会把「今天发了几条」「上次什么时候发的」抹掉 —— 日限额和间隔就都失效了。
      const disk = today(load())
      disk.dmSeen = [...seen].slice(-300)
      disk.dmCheckedAt = s.dmCheckedAt
      disk.dmChecks = s.dmChecks
      if (s.dmCoolUntil) disk.dmCoolUntil = s.dmCoolUntil
      save(disk)
      return { ok: true, message: replied ? `回了 ${replied} 条私信` : '没有新私信', replied }
    } catch (error) {
      // 被风控挡了（-509 / 频繁）：记一个冷却时间，20 分钟后再试，别在风控里越陷越深
      if (/-509|频繁|412/.test(String(error.message || ''))) {
        s.dmCoolUntil = Date.now() + 20 * 60_000
        log.warn('看私信被风控挡了，20 分钟后再试：', error.message)
      } else {
        log.warn('看私信失败：', error.message)
      }
      const disk = today(load())
      disk.dmSeen = [...seen].slice(-300)
      disk.dmCheckedAt = s.dmCheckedAt
      disk.dmChecks = s.dmChecks
      if (s.dmCoolUntil) disk.dmCoolUntil = s.dmCoolUntil
      save(disk)
      return { ok: false, message: '看私信失败：' + error.message, replied }
    }
  }

  /** 刷一轮。force = 面板里手动点的（不占每天的次数）。 */
  async function run({ force = false } = {}) {
    const c = cfg()
    if (busy) return { ok: false, message: '正在刷' }
    if (!c.enabled && !force) return { ok: false, message: 'B 站没打开' }
    busy = true
    const s = today(load())
    try {
      const seen = new Set(s.seen)
      const kws = await chooseKeywords()
      let pool = []
      for (const kw of kws) {
        try { pool.push(...filterVideos(await api.search(kw), { minViews: c.minViews, maxAgeDays: c.maxAgeDays, seen }).slice(0, 4).map((v) => ({ ...v, kw }))) } catch (error) { log.debug(`搜「${kw}」失败：`, error.message) }
      }
      if (pool.length < c.perRun) {
        try { pool.push(...filterVideos(await api.popular({ ps: 20 }), { seen }).slice(0, c.perRun).map((v) => ({ ...v, kw: '热门' }))) } catch (error) {}
      }
      // 每个关键词轮着取，避免一轮全是同一类
      const picked = []
      const byKw = new Map()
      for (const v of pool) { if (!byKw.has(v.kw)) byKw.set(v.kw, []); byKw.get(v.kw).push(v) }
      while (picked.length < c.perRun && [...byKw.values()].some((l) => l.length)) for (const l of byKw.values()) if (l.length && picked.length < c.perRun) { const v = l.shift(); if (!picked.some((p) => p.bvid === v.bvid)) picked.push(v) }
      if (!picked.length) return { ok: false, message: '这次没搜到合适的视频' }
      const looked = []
      for (const v of picked) {
        try { looked.push(await lookAt(v)) } catch (error) { log.debug(`看 ${v.bvid} 失败：`, error.message) }
        seen.add(v.bvid)
      }
      s.seen = [...seen].slice(-500)
      if (!looked.length) return { ok: false, message: '视频都打不开' }
      const commentLeft = c.comment && canPost(s) ? Math.max(0, c.maxCommentsPerDay - s.comments) : 0
      // 有填主人的 B 站昵称，才让她在评论里 @ 主人（否则 @ 不出来，等于白写）
      const ownerBili = String(c.ownerName || '').trim()
      const needAt = Boolean(ownerBili) && commentLeft > 0
      const out = await think(`你在 B 站刷到了这几个视频：\n\n${looked.map((x, i) => `【${i + 1}】${x.digest}`).join('\n\n')}\n\n` +
        `看完说说你的想法。对每个视频给一个对象：{"i":序号, "feeling":"一句你的真实感受", "comment":"想在视频下发的评论（像普通观众，一两句、别打广告，不想评就空字符串）", "share":"想分享给${owner()}的话（觉得${owner()}会喜欢才写，不然空字符串）", "remember":"值得记住的一件事（没有就空字符串）"}。` +
        (needAt
          ? `\n\n${owner()}的 B 站昵称是「${ownerBili}」。` +
            `每条评论都要带 @主人（系统会替换成 ${ownerBili} 并变成真 @），` +
            `写在**最前面**、正文跟在后面，像这样：「@主人 这句话真有意思」。` +
            `不要写成「正文…… @主人」，也不要额外加「想让你也看看」这类固定尾巴。`
          : '') +
        `\n这次最多评论 ${commentLeft} 个。只输出 JSON 数组。`)
      const decisions = pickJson(out, [])
      let commented = 0
      let shared = 0
      const felt = new Map() // bvid → 她自己的一句感受，发截图时配着用
      for (const d of Array.isArray(decisions) ? decisions : []) {
        const x = looked[(Number(d.i) || 0) - 1]
        if (!x) continue
        const v = x.info
        const feeling = cleanOutboundText(d.feeling, { warn: (message) => log.warn(`B 站感受：${message}`) }).trim()
        const remember = cleanOutboundText(d.remember, { warn: (message) => log.warn(`B 站见闻：${message}`) }).trim()
        if (feeling) felt.set(v.bvid, feeling)
        memory?.addEvent?.({ kind: 'seen', meta: { title: v.title, author: v.author, url: link(v.bvid), platform: 'bili', id: v.bvid }, text: [feeling, !isSilence(remember) ? remember : ''].filter(Boolean).join('；') || v.title, tags: ['B站'], importance: 0.4 })
        // 发之前把「@ 昵称」压成「@昵称」：带空格的 @ 在 B 站等于没 @ 到人（而且不报错）
        // 再把「@主人」提到最前面（没写就补上）：老大要的格式是「@昵称 正文」，不是「正文… @昵称」
        const comment = finalizeComment(cleanOutboundText(d.comment || '', { warn: (message) => log.warn(`B 站评论：${message}`) })).trim().slice(0, 200)
        if (comment && !isSilence(comment) && commented < commentLeft && canPost(s)) {
          // 查重闸门：开头套话 / 跟自己旧评论撞 / 跟这条视频热评撞 → 这一条不发
          const gate = c.styleGuard === false
            ? { ok: true }
            : checkCommentStyle(comment, {
              history: (s.history || []).filter((h) => h.kind === 'comment').map((h) => h.text),
              peers: (x.comments || []).map((p) => p.text),
            })
          if (!gate.ok) {
            log.info(`这条评论没发（${gate.reason}），按提示重写`)
            record(s, { kind: 'skip', title: v.title, bvid: v.bvid, text: `${gate.reason} → ${gate.hint || ''}` })
          } else {
            try {
              let sent = null
              if (getConfig().dryRun) log.info(`试运行：本来要在 B 站《${v.title}》下评论：${comment}`)
              else sent = await api.postComment(v.aid, comment)
              commented++
              s.comments++
              memory?.addEvent?.({ text: `在B站《${v.title}》下评论：${comment.slice(0, 60)}`, tags: ['B站'], importance: 0.4 })
              // rpid 一定要留下：它是事后「这条到底公开可见没有」的唯一线索。
              // 以前只存 text，等于发完就再也找不到了。
              const rpid = String(sent?.rpid || '')
              record(s, { kind: 'comment', title: v.title, bvid: v.bvid, text: comment, rpid, aid: v.aid })
              // 发完回头查一眼：B 站回 code=0 只代表「收下了」，不代表公开可见
              if (rpid && !getConfig().dryRun) {
                const vr = await api.verifyReply({ aid: v.aid, rpid, text: comment }).catch(() => null)
                const jd = judgeVerify(vr)
                rememberVerify({ bvid: v.bvid, aid: v.aid, rpid, title: v.title, text: comment.slice(0, 60), ...jd })
                if (jd.level === 'hidden') log.warn(`⚠️ 《${v.title}》这条评论进审核了（别人看不到）：${comment.slice(0, 40)}`)
                else if (jd.level === 'ok') log.debug(`评论已公开可见：《${v.title}》`)
              }
            } catch (error) {
              log.warn('B 站评论失败：', error.message)
              pauseIf(s, error)
              record(s, { kind: 'error', title: v.title, bvid: v.bvid, text: '评论没发出去：' + error.message })
            }
          }
        }
        // 点赞：走「有额度、要理由、会熔断」的那套，不再见一个点一个
        if (c.like) await maybeLike(s, v, { reason: cleanOutboundText(d.feeling, { warn: () => {} }).trim() }).catch((error) => log.debug('点赞跳过：', error.message))
        const share = cleanOutboundText(d.share, { warn: (message) => log.warn(`B 站分享：${message}`) }).trim()
        if (share && !isSilence(share) && c.shareToOwner) {
          const where = c.shareTo || 'bili'
          const text = `${share}\n${link(v.bvid)}`
          let did = 0
          // B 站私信：最自然的那条路（要互关）
          if (where === 'bili' || where === 'both') {
            const r = await sendDm(text, { classify: false })
            if (r.ok) { did++; record(s, { kind: 'share', title: v.title, bvid: v.bvid, text: share, via: 'bili' }) }
            else log.debug('B 站私信分享没发出去：', r.message)
          }
          // QQ 私聊：保留了，想两边都发或者只发 QQ 都行
          if (where === 'qq' || where === 'both' || (where === 'bili' && !did && c.dmEnabled === false)) {
            if (getConfig().ownerQQ) {
              await hub.sendText(`private:${getConfig().ownerQQ}`, text)
              did++
              record(s, { kind: 'share', title: v.title, bvid: v.bvid, text: share, via: 'qq' })
            }
          }
          if (did) shared++
        }
        record(s, { kind: 'watch', title: v.title, bvid: v.bvid, text: feeling })
      }
      if (!force) s.runs++
      s.lastRun = Date.now()
      if (afterBrowse) {
        try { await afterBrowse(looked.map(({ info }) => ({ bvid: info.bvid, title: info.title, text: felt.get(info.bvid) || '' }))) }
        catch (error) { log.debug('本轮弹幕未完成：', error.message) }
      }
      log.info(`刷了一轮 B 站：看了 ${looked.length} 个，评论 ${commented} 条，分享 ${shared} 个`)
      // 记历史 + 写日报 / 肥鱼日记（这一步失败不影响这一轮已经发出去的评论）
      try { await writeRoundDigest(s, looked, felt, { commented, shared }) }
      catch (error) { log.debug('写日报失败：', error.message) }
      return { ok: true, message: `看了 ${looked.length} 个视频，评论 ${commented} 条，分享给你 ${shared} 个`, watched: looked.length, commented, shared }
    } catch (error) {
      log.warn('刷 B 站出错：', error.message)
      return { ok: false, message: error.message }
    } finally {
      // 一整轮可能跑几分钟，期间 checkAts / checkDm 都可能写过盘：只合并自己改过的键
      mergeSave(s, ['runs', 'lastRun', 'seen', 'comments', 'replies', 'history', 'pauseDay', 'pauseReason'])
      busy = false
    }
  }

  /** 看别人回她的评论，接着回。 */
  const checkReplies = () => once('replies', checkRepliesRun)
  async function checkRepliesRun() {
    const c = cfg()
    if (!c.reply) return { ok: false, message: '回复没打开' }
    const s = today(load())
    s.lastReplyCheck = Date.now()
    let n = 0
    try {
      const done = new Set(s.repliedFeed)
      const fresh = (await api.replyFeed()).filter((x) => !done.has(x.id) && Number(x.type || 1) === 1 && x.oid).slice(0, 5)
      for (const item of fresh) {
        const x = {
          ...item,
          title: cleanOutboundText(item.title, { warn: (message) => log.warn(`B 站标题：${message}`) }).trim(),
          name: cleanOutboundText(item.name, { warn: (message) => log.warn(`B 站昵称：${message}`) }).trim(),
        }
        // 记下来：整理记忆时能知道 B 站上谁跟她聊过什么
        hub.logChat?.('bili', x.name, `在 B 站《${x.title}》下回复你：${x.text}`, '')
        if (s.replies >= c.maxRepliesPerDay || !canPost(s)) { done.add(x.id); continue }
        // 逐条兜住：模型这一句失败不能让整轮都断，也不能把这条记成「回过了」
        let reply = ''
        try {
          const out = await think(`你在 B 站视频《${x.title}》下发过评论：「${x.myText}」\n${x.name} 回复你：「${x.text}」\n想回就用你的口气回一句（像普通网友聊天，别太长），不想回就只输出 [沉默]。只输出回复正文。`)
          reply = cleanOutboundText(out, { warn: (message) => log.warn(`B 站回复：${message}`) }).trim().split(/\n+/)[0]
        } catch (error) {
          log.warn('B 站回复没想出来：', error.message)
          continue // 不记 done，下轮再试
        }
        if (!reply || isSilence(reply)) { done.add(x.id); continue }
        try {
          if (getConfig().dryRun) log.info(`试运行：本来要在 B 站回复 ${x.name}：${reply}`)
          else await api.postComment(x.oid, normalizeMention(`回复 @${x.name} :${reply}`).slice(0, 200), { root: x.root, parent: x.parent })
          done.add(x.id) // 真正发出去了才记账
          s.replies++
          n++
          memory?.addEvent?.({ text: `在B站回复了 ${x.name}：${reply.slice(0, 50)}`, tags: ['B站'], importance: 0.35 })
          record(s, { kind: 'reply', title: x.title, text: `${x.name}：${x.text} → ${reply}` })
        } catch (error) {
          log.warn('B 站回复失败：', error.message)
          pauseIf(s, error)
        }
      }
      s.repliedFeed = [...done].slice(-300)
      return { ok: true, message: `回了 ${n} 条`, replied: n }
    } catch (error) {
      return { ok: false, message: error.message }
    } finally {
      mergeSave(s, ['lastReplyCheck', 'repliedFeed', 'replies', 'history', 'pauseDay', 'pauseReason'])
    }
  }

  /**
   * 回「在 B 站评论里 @ 了她」的人（主要就是主人）。
   *
   * 为什么单开一个：checkReplies 走的是 /x/msgfeed/reply（别人回复我的评论），
   * 而「@ 我」是另一个接口 /x/msgfeed/at。以前只接了前者，所以主人在评论区 @ 她
   * ——哪怕 @ 得再准——她一条都不会回（踩过：主人连 @ 了 6 条，全都没反应）。
   *
   * 规矩：
   *  · 只回主人本人（别的网友 @ 她一律不理，免得替主人社交、也免得被当成刷评论）；
   *  · 只回「评论」类的 @，动态里 @ 她不管（那不在视频评论区，回起来是另一套）；
   *  · 已经回过的记在 atReplied 里，不重复回。
   */
  const checkAts = () => once('ats', checkAtsRun)
  async function checkAtsRun() {
    const c = cfg()
    const ownerMid = loadOwnerMid()
    if (!ownerMid) return { ok: false, message: '还没填主人的 B 站 mid' }
    const s = today(load())
    const done = new Set(s.atReplied || [])
    // 两条去重键一起认：
    //   · 消息流那条 id（B 站正常会给稳定 id）
    //   · 「视频 aid + 那条评论 rpid」——消息流偶尔会换 id（重新推送 / 刷新），
    //     只认 id 就会把同一条 @ 当成新的再回一遍。
    const doneKey = (x) => `a${x.aid}r${x.rpid}`
    const seenBefore = (x) => done.has(x.id) || done.has(doneKey(x))
    let n = 0
    try {
      const feed = await api.atFeed()
      // 只留：评论类、主人发的、真的 @ 到了她
      const mine = feed.filter((x) => x.business === '评论' && String(x.mid) === String(ownerMid) && !seenBefore(x) && x.aid && x.rpid)
      const fresh = mine.slice(0, 3)
      for (const x of fresh) {
        const title = cleanOutboundText(x.title, { warn: (m) => log.warn(`B 站标题：${m}`) }).trim()
        const name = cleanOutboundText(x.name, { warn: (m) => log.warn(`B 站昵称：${m}`) }).trim()
        hub.logChat?.('bili', name, `在 B 站《${title}》评论区 @ 了你：${x.text}`, '')
        if (s.replies >= c.maxRepliesPerDay || !canPost(s)) { done.add(x.id); done.add(doneKey(x)); continue }
        let reply = ''
        try {
          const out = await think(`主人在 B 站视频《${title}》的评论区 @ 了你，说：「${x.text}」\n用你平时的口气回他一句（像手机聊天，短一点，别客套，别写 Markdown）。不想回就只输出 [沉默]。只输出回复正文。`)
          reply = cleanOutboundText(out, { warn: (m) => log.warn(`B 站 @ 回复：${m}`) }).trim().split(/\n+/)[0]
        } catch (error) {
          log.warn('@ 回复没想出来：', error.message)
          continue // 模型失败不算处理过，下轮再试
        }
        if (!reply || isSilence(reply)) { done.add(x.id); done.add(doneKey(x)); continue }
        try {
          // 回到主人那条评论下面，并且 @ 他 —— 这样他手机上会收到通知
          const body = normalizeMention(`@${name} ${reply}`).slice(0, 200)
          if (getConfig().dryRun) log.info(`试运行：本来要在《${title}》回主人的 @：${body}`)
          else await api.postComment(x.aid, body, { root: x.rootId || x.rpid, parent: x.rpid })
          // 发出去了才算处理过：以前是先记后发，发失败那条就永远算已读、再也不会重试
          done.add(x.id)
          done.add(doneKey(x))
          s.replies++
          n++
          memory?.addEvent?.({ text: `在B站回了主人的@：${reply.slice(0, 50)}`, tags: ['B站'], importance: 0.45 })
          record(s, { kind: 'reply', title, text: `主人@我：${x.text} → ${reply}` })
        } catch (error) {
          log.warn('回 @ 失败：', error.message)
          pauseIf(s, error)
        }
      }
      s.atReplied = [...done].slice(-400)
      return { ok: true, message: n ? `回了 ${n} 条 @` : '没有新的 @', replied: n }
    } catch (error) {
      log.warn('看 @ 失败：', error.message)
      return { ok: false, message: error.message, replied: n }
    } finally {
      mergeSave(s, ['atReplied', 'replies', 'history', 'pauseDay', 'pauseReason'])
    }
  }

  /** 她看一个视频（你发的链接 / BV 号），返回给她看的内容。 */
  async function watch(text) {
    let id = findVideoId(text)
    if (!id) return { ok: false, message: '没认出视频链接或 BV 号' }
    if (id.short) {
      const real = await api.resolveShort(id.short).catch(() => '')
      id = findVideoId(real)
      if (!id || id.short) return { ok: false, message: '短链打不开' }
    }
    const x = await lookAt(id)
    memory?.addEvent?.({ kind: 'seen', meta: { title: x.info.title, author: x.info.author, url: link(x.info.bvid), platform: 'bili', id: x.info.bvid }, text: `看了别人发来的 B 站视频《${x.info.title}》`, tags: ['B站'], importance: 0.4 })
    return { ok: true, message: x.digest, bvid: x.info.bvid, aid: x.info.aid, title: x.info.title }
  }

  /** 在某个视频下发评论（主人让她发的）。
   *  这条路用 hoistOwnerMention 而不是 finalizeComment：内容是主人让她说的，
   *  她没写 @ 就别硬加（加了反而像自作主张）。 */
  async function comment(text, rawMessage) {
    const message = hoistOwnerMention(normalizeMention(cleanOutboundText(atOwner(rawMessage || ''), { warn: (message) => log.warn(`B 站评论：${message}`) }))).slice(0, 200)
    if (!message.trim()) return { ok: true, silent: true, message: '本轮保持沉默，未发送评论' }
    const w = await watch(text)
    if (!w.ok) return w
    if (getConfig().dryRun) return { ok: true, message: `试运行：本来要在《${w.title}》下评论：${message}` }
    const r = await api.postComment(w.aid, message)
    memory?.addEvent?.({ text: `在B站《${w.title}》下评论：${String(message).slice(0, 60)}`, tags: ['B站'], importance: 0.45 })
    const s = load(); record(s, { kind: 'comment', title: w.title, bvid: w.bvid, text: message }); mergeSave(s, ['history'])
    return { ok: true, message: `评论发出去了（《${w.title}》）${r?.missed?.length ? `；没找到 ${r.missed.join('、')}，这几个没 @ 上` : ''}` }
  }

  /** 改自己的 B 站签名（权限在模块里查）。 */
  async function setSign(text) {
    const sign = cleanOutboundText(text, { warn: (message) => log.warn(`B 站签名：${message}`) }).trim()
    if (!sign) return { ok: false, message: '签名不能是空的' }
    if ([...sign].length > 70) return { ok: false, message: 'B 站签名最多 70 个字' }
    if (getConfig().dryRun) return { ok: true, message: `试运行：本来要把 B 站签名改成：${sign}` }
    if (!parseCookie(cfg().cookie).bili_jct) return { ok: false, message: '没登录 B 站，改不了签名' }
    await api.setSign(sign)
    memory?.addEvent?.({ text: `把B站签名改成了：${sign.slice(0, 70)}`, tags: ['B站'], importance: 0.35 })
    return { ok: true, message: `B 站签名改好了：${sign}` }
  }

  /** 换 B 站头像。file 是已经过 avatarSource 校验的 http(s) 网址。 */
  async function setAvatar(file) {
    if (!/^https?:\/\//i.test(String(file || ''))) return { ok: false, message: '头像只能用网址图片，或者刚才发的那张图' }
    if (getConfig().dryRun) return { ok: true, message: `试运行：本来要把 B 站头像换成：${file}` }
    if (!parseCookie(cfg().cookie).bili_jct) return { ok: false, message: '没登录 B 站，换不了头像' }
    try {
      await api.setFace(file)
    } catch (error) {
      return { ok: false, message: `B 站头像没换成：${error.message}` }
    }
    memory?.addEvent?.({ text: '换了B站头像', tags: ['B站'], importance: 0.35 })
    return { ok: true, message: 'B 站头像换好了（B 站可能要审核一会儿才显示）' }
  }

  /** 每分钟调一次：醒着的时候按间隔刷、看回复、看 @。私信走自己的定时器（见 dmTick）。 */
  let tickBusy = false
  async function tick() {
    const g = getConfig()
    const c = g.bili
    if (!g.enabled || !c.enabled) return
    const h = new Date().getHours()
    if (h < g.speakUp.awakeFrom || h >= g.speakUp.awakeTo) return
    // 上一跳还没跑完就别叠上来：这里动辄要等模型（几十秒到几分钟），
    // 定时器 60 秒一跳，不挡就会两跳同时看见「还没回过」，把同一条 @ 回两遍。
    if (tickBusy) return
    tickBusy = true
    try {
      // ⚠️ 这个函数里**不要**在 await 之后拿开头读的 s 去 save(s)。
      // 踩过的坑：开头 s = load() 读一份快照，然后 await checkAts() —— 它自己已经把
      // atReplied（"这条 @ 回过了"）写进磁盘；回到这里再 save(s) 就把那份旧的整份盖回去，
      // atReplied 永远被抹掉 → 每 3 分钟把同一条老 @ 再回一遍（老大反馈的「重复回复」）。
      // 规矩：谁写的谁负责存；这里只在最后重新读一份，只补自己的时间戳。
      if (c.reply && Date.now() - (load().lastAtCheck || 0) > 3 * 60_000 && (await account()).isLogin) {
        await checkAts().catch((error) => log.warn('看 @ 出错：', error.message))
        const disk = today(load())
        disk.lastAtCheck = Date.now()
        save(disk)
      }
      if (c.reply && Date.now() - (load().lastReplyCheck || 0) > 20 * 60_000 && (await account()).isLogin) await checkReplies()
      // 圈地自萌：独立计时，开了才跑。它只回 UP 主邀请的楼中楼，不发新楼。
      if (c.circleMode && Date.now() - (load().lastCircleCheck || 0) > Math.max(1, Number(c.circlePollMinutes) || 10) * 60_000 && (await account()).isLogin) {
        await checkCircle().catch((error) => log.warn('圈地出错：', error.message))
        const disk = today(load())
        disk.lastCircleCheck = Date.now()
        save(disk)
      }
      const st = today(load())
      if (c.autoBrowse && st.runs < c.maxRunsPerDay && Date.now() - (st.lastRun || 0) > c.intervalHours * 3600_000) await run()
    } finally {
      tickBusy = false
    }
  }

  /**
   * 私信专用的一跳（每分钟被自己的定时器叫一次）。
   *
   * 为什么从 tick() 里拆出来：以前它排在 checkReplies() 后面，
   * 而 checkReplies 要拉回复流、逐条让模型判断，跑一次能占几十秒到几分钟 ——
   * 私信就被堵在后面，表现出来就是「私信回得很慢」。
   * 另外 tick() 还受作息窗口限制，半夜你发私信她完全不看。
   * 现在私信独立跑：不受刷视频/看回复拖累，也不受作息窗口限制（你人都在，她当然该回）。
   */
  let dmBusy = false
  async function dmTick() {
    const g = getConfig()
    const c = g.bili
    if (!g.enabled || !c.enabled || !c.dmEnabled) return
    if (dmBusy) return // 上一跳还没跑完，别叠上去（会重复回同一句）
    dmBusy = true
    try {
      const s = today(load())
      if (Date.now() <= (s.dmCoolUntil || 0)) return // 被风控教训过，还在冷却
      if (Date.now() - (s.dmCheckedAt || 0) < Math.max(1, Number(c.dmPollMinutes) || 1) * 60_000) return
      if (!(await account()).isLogin) return
      await checkDm()
    } catch (error) {
      log.warn('私信定时器这一跳出错（已兜住）：', error.message)
    } finally {
      dmBusy = false
    }
  }

  return {
    run, checkReplies, checkAts, checkCircle, watch, comment, setSign, setAvatar, tick, dmTick, account,
    checkDm, sendDm,
    relation: (mid) => api.relation(mid),
    atFeed: () => api.atFeed(),
    // 点赞 / 收藏：额度、理由、熔断都在里面
    maybeLike, undoLike,
    likes: () => listLikesForUi(),
    likeCooldown: () => likeCoolUntil(),
    // 圈地自萌
    circleScan,
    // 历史 / 日报 / 日记
    historyView, rebuildReport, readReport,
    dispose() { stopped = true },
    state: () => {
      const s = today(load())
      return {
        runs: s.runs, comments: s.comments, replies: s.replies, lastRun: s.lastRun,
        history: s.history.slice(0, 20), canPost: canPost(s),
        pauseReason: s.pauseDay === dayKey() ? s.pauseReason : '',
        vision: visionState(cfg()),
        dm: { sent: s.dmSent || 0, checkedAt: s.dmCheckedAt || 0, seen: (s.dmSeen || []).length },
        lastAtCheck: s.lastAtCheck || 0,
        atReplied: s.atReplied || [],
        circle: { replied: (s.circleReplied || []).length, lastCheck: s.lastCircleCheck || 0 },
        likes: { today: countToday('like', dayKey()), todayFav: countToday('fav', dayKey()), coolUntil: likeCoolUntil() },
        verify: readVerify().slice(0, 10),
      }
    },
  }
}
