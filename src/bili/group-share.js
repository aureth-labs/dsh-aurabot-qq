// 刷 B 站刷到想发到群里的视频：不直接发，先攒成待批，私聊问主人一句「发不发」。
// 形状抄两处现成的：security/approval.js 的「私聊问一句 + handleReply 截流」、
// autotelic 的 say-pending.json 的数组落盘。不同点：这里带内容、带截图、能挑条、能选群、能过期。
//
// 两处话由模型来写/来读（群里发东西是公开场合，机器腔和口令都太生硬）：
//   ask        —— 她用自己的口气问「这条挺有意思，能发群里吗」，带群名
//   understand —— 主人回「那就发吧，多发几个群也行」这种自然话，交给模型听懂
// 规则快判（发 1 / 不发）仍然保留：秒回，也让模型挂掉时还有路可走。

import { dataDir, readJson, writeJson } from '../core/store.js'
import { reallySent } from '../chat/hub.js'

const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export const linkOf = (bvid) => (bvid ? `https://www.bilibili.com/video/${bvid}` : '')
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)

// 只认「发 / 发送」开头：批准、同意、允许、拒绝、取消这些词 DSH 的工具授权中继也在用
// （src/security/approval.js 的 APPROVE_RE / REJECT_RE，在消息进到模块之前就被它消费），
// 这里再用同一批词会抢词、让主人搞不清自己刚批准了哪件事。
const SEND_ONE = /^(?:发|发送)#?(\d{1,2})$/
const SEND_ALL = /^(?:都发|全发|全都发|(?:发|发送)(?:全部|所有|都发|全发))$/
const SEND_BARE = /^(?:发|发送)$/
const SKIP_ONE = /^(?:不发|别发)#?(\d{1,2})$/
const SKIP_ALL = /^(?:不发|别发)(?:全部|所有|都|全)?$/

/**
 * 解析主人对「群分享待批」的短命令。别的都返回 null（交给聊天/模型，别把正常聊天吞了）。
 * 返回 { action: 'send' | 'skip', index: number, all?: true }，index 从 1 开始；
 * index 为 0 表示没带编号（all 为真才是「全部」，否则只是裸「发」）。
 */
export function parseDecision(raw) {
  const text = String(raw || '').replace(/\s+/g, '').trim()
  if (!text || text.length > 12) return null
  let m
  if ((m = text.match(SEND_ONE))) { const i = Number(m[1]); return i > 0 ? { action: 'send', index: i } : null }
  if (SEND_ALL.test(text)) return { action: 'send', index: 0, all: true }
  if ((m = text.match(SKIP_ONE))) { const i = Number(m[1]); return i > 0 ? { action: 'skip', index: i } : null }
  if (SKIP_ALL.test(text)) return { action: 'skip', index: 0, all: true }
  if (SEND_BARE.test(text)) return { action: 'send', index: 0 }
  return null
}

/** 模型回的那段话：剥掉代码块、引号、常见的自称前缀，截到 200 字。 */
function cleanSpeech(raw) {
  let s = String(raw || '').trim()
  s = s.replace(/^```[\s\S]*?\n|```$/g, '').trim()
  s = s.replace(/^(?:我|大肥鱼|鲸鱼娘)\s*[:：]\s*/, '').trim()
  s = s.replace(/^["'「『]|["'」』]$/g, '').trim()
  return s.slice(0, 200)
}

/** 从模型的回答里抠出 { action, items, groups }。抠不出来返回 null。 */
export function parsePlan(raw) {
  const s = String(raw || '')
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  let obj
  try { obj = JSON.parse(s.slice(a, b + 1)) } catch { return null }
  const action = obj && obj.action
  if (action !== 'send' && action !== 'skip' && action !== 'none') return null
  const items = Array.isArray(obj.items) ? obj.items.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0) : []
  const groups = Array.isArray(obj.groups) ? obj.groups.map((x) => String(x).trim()).filter(Boolean) : []
  return { action, items, groups }
}

export function createGroupShare({ getConfig, hub, log = console, think: thinkInjected = null, groupNameOf, shotPathOf, captureShot } = {}) {
  // 默认借她自己的后台会话写话/读话：人设、语气都现成，不用另外拼 prompt 风格
  const think = thinkInjected || (async (kind, prompt) => {
    if (!hub?.runSystemTurn) return ''
    const title = kind === 'ask' ? 'QQ · 群分享问一句' : kind === 'receipt' ? 'QQ · 群分享回执' : 'QQ · 读懂回复'
    // 用「主人私聊」那档预设：她本人在跟主人说话，不是群里的样子
    return String(await hub.runSystemTurn('bili-groupshare', title, prompt, { level: 'full', timeoutMs: 60_000, key: kind }))
  })
  const file = () => dataDir('bili-group-share.json')
  const load = () => {
    const s = readJson(file(), () => ({ day: '', sentToday: 0, nextId: 1, items: [] }))
    if (!s || typeof s !== 'object') return { day: dayKey(), sentToday: 0, nextId: 1, items: [] }
    if (!Array.isArray(s.items)) s.items = []
    if (!Number.isFinite(Number(s.nextId))) s.nextId = 1
    if (s.day !== dayKey()) { s.day = dayKey(); s.sentToday = 0 }
    return s
  }
  const save = (s) => writeJson(file(), s)
  const cfg = () => getConfig().bili?.groupShare || {}
  const pendingOf = (s) => s.items.filter((x) => x.state === 'pending')
  // 所有「处理待批」的动作排一条链：decide 会 await 发群，期间再来一条命令（主人连发两次「发 1」）
  // 若各自拿一份内存状态副本，就会双发群、sentToday 互相覆盖。串行 + 每步重新 load 才稳。
  let chain = Promise.resolve()
  const enqueue = (task) => {
    chain = chain.then(task).catch((error) => log.warn('处理群分享出错：', error.message))
    return chain
  }
  const ownerChat = () => `private:${getConfig().ownerQQ}`

  /** 默认群 + 额外授权群；没配额外群就只认 groupId。 */
  function allowedGroups() {
    const c = cfg()
    const list = [String(c.groupId || '').trim(), ...(Array.isArray(c.groups) ? c.groups : [])]
      .map((x) => String(x || '').trim()).filter(Boolean)
    return [...new Set(list)]
  }

  async function nameOf(gid) {
    try {
      if (groupNameOf) return String(await groupNameOf(String(gid))) || String(gid)
      const m = hub?.groupNames
      if (m && typeof m.get === 'function') return String(m.get(String(gid)) || gid)
    } catch {}
    return String(gid)
  }

  /** 让她用自己的口气写问话；模型挂了或说废话就退回一句朴素模板。 */
  async function askSpeech(list, groups) {
    const names = []
    for (const gid of groups) names.push(`${await nameOf(gid)}（${gid}）`)
    const lines = list.map((it, i) => `${i + 1}.《${clip(it.title, 40)}》——我的点评：${clip(it.text, 80)}`)
    const prompt = [
      '【写一句私聊：问主人这批 B 站视频能不能发到群里】',
      '你刚刷完 B 站，挑出这几条想分享：',
      ...lines,
      `想发到：${names.join('、')}`,
      '请写一段发给主人的私聊：像平时聊天，口语、轻松，带上群名，问能不能发。',
      '不要用「待批」「编号」「回复发 1」这类说法，不要列表格，不要解释你在做什么。',
      '只输出这段话本身，60 字以内。',
    ].join('\n')
    let said = ''
    if (think) {
      try { said = cleanSpeech(await think('ask', prompt)) } catch (error) { log.debug?.('群分享问话生成失败：', error.message) }
    }
    if (said) return said
    const title = clip(list[0].title, 30)
    const where = names.join('、')
    return list.length === 1
      ? `看到《${title}》这条挺有意思的，想发到${where}，可以吗？`
      : `今天刷到 ${list.length} 条挺有意思的，想发到${where}：${list.map((x) => `《${clip(x.title, 20)}》`).join('、')}，发吗？`
  }

  /** 问主人一次：带群名、带每条的一句话点评；编号 → 条目 id 落盘做快照。 */
  async function ask(s) {
    const list = pendingOf(s)
    if (!list.length) return true
    const groups = allowedGroups().slice(0, 1)
    const speech = await askSpeech(list, groups)
    // 编号 → 条目 id 的快照：之后有过期或已处理，编号也不会错位到别的条目。
    // 必须在这里落盘：submit 是先 save 再 ask 的，不存的话主人回复时就只剩「当前顺序」。
    s.lastAsked = { at: Date.now(), ids: list.map((x) => x.id) }
    save(s)
    try {
      const r = await hub.sendText(ownerChat(), speech, undefined, undefined, undefined, { proactive: true, proactiveCause: 'bili-groupshare-ask' })
      const shown = reallySent(r)
      if (!shown) log.warn('群分享的审批消息没发出去，这批先作废')
      return shown
    } catch (error) {
      log.warn('群分享的审批消息没发出去，这批先作废：', error.message)
      return false
    }
  }

  /**
   * 把她想发到群的几条攒进待批，并问主人一次。items: [{ bvid, title, text, shotIds }]
   * 试运行 / 总开关关着 / 没配群号时一律不攒（审批消息本身也发不出去，攒了只会烂在文件里）。
   */
  async function submit(items = []) {
    const g = getConfig()
    const c = cfg()
    if (!c.enabled || !String(c.groupId || '').trim()) return { ok: false, why: '群分享没开（没配群号）' }
    if (!g.enabled) return { ok: false, why: '总开关关着' }
    if (g.dryRun) return { ok: false, why: '试运行，不攒待批' }
    if (!g.ownerQQ) return { ok: false, why: '没配主人的 QQ' }
    const s = load()
    if (s.sentToday >= Number(c.dailyLimit)) return { ok: false, why: `今天已经发够 ${c.dailyLimit} 条了` }
    const have = pendingOf(s)
    if (have.some((x) => String(x.groupId) !== String(c.groupId))) return { ok: false, why: '还有别的群的待批没回，先处理完' }
    const room = Math.max(0, Number(c.queueLimit) - have.length)
    if (!room) return { ok: false, why: '待批的还没回，先不攒新的' }
    const fresh = []
    for (const it of (Array.isArray(items) ? items : []).slice(0, room)) {
      const bvid = String(it.bvid || '').trim()
      const text = String(it.text || '').trim()
      if (!bvid || !text) continue
      // 同一条视频：待批里有了就不重复问，今天已经发过也不再问
      if (have.some((x) => x.bvid === bvid)) continue
      if (fresh.some((x) => x.bvid === bvid)) continue
      if (s.items.some((x) => x.bvid === bvid && x.state === 'sent')) continue
      const shotIds = Array.isArray(it.shotIds) ? it.shotIds.filter((x) => typeof x === 'string').slice(0, 2) : []
      const item = { id: s.nextId++, at: Date.now(), bvid, title: clip(it.title, 80), text: clip(text, 300), shotIds, groupId: String(c.groupId), state: 'pending', decidedAt: 0 }
      s.items.push(item)
      fresh.push(item)
    }
    s.items = s.items.slice(-50)
    if (!fresh.length) { save(s); return { ok: false, why: '没有能攒的新条目' } }
    save(s)
    if (!(await ask(s))) {
      // 问不出去就等于没有待批：留着只会 24 小时后静默过期
      const at = Date.now()
      for (const it of fresh) { it.state = 'failed'; it.decidedAt = at }
      save(s)
      return { ok: false, why: '审批消息没发出去' }
    }
    log.info(`B 站群分享：攒了 ${fresh.length} 条待批，已问主人`)
    return { ok: true, n: fresh.length }
  }

  /** 发一条到某个群：先发截图（有就发，失败不影响文字），再发文字+链接。 */
  async function sendOne(it, gid) {
    let shot = ''
    try {
      const name = Array.isArray(it.shotIds) ? it.shotIds[0] : ''
      if (name && shotPathOf) shot = String(shotPathOf(name) || '')
      // 攒的时候没抽到截图：发群前补一张，补不到就纯文字
      if (!shot && captureShot) shot = String((await captureShot(it.bvid)) || '')
    } catch (error) {
      log.debug?.('群分享补截图失败：', error.message)
    }
    if (shot) {
      try { await hub.sendImage(`group:${gid}`, shot, undefined, undefined, { proactive: true, proactiveCause: 'bili-groupshare' }) } catch (error) { log.warn('群分享的截图没发出去：', error.message) }
    }
    const r = await hub.sendText(`group:${gid}`, `${it.text}\n${linkOf(it.bvid)}`, undefined, undefined, undefined, { proactive: true, proactiveCause: 'bili-groupshare' })
    // 只有网关真给了 message_id 才算发出去：模拟返回（sim-*）和「排队补发」都不占额度
    return reallySent(r)
  }

  /** 让她用自己的口气回执：发了什么、发到哪、没发的为什么。模型挂了退回模板。 */
  async function receiptSpeech({ sent, dropped, failed, left, limit, illegal, sentTitles, groupNames }) {
    const facts = []
    const titles = sentTitles.map((t) => `《${clip(t, 24)}》`).join('')
    if (sent) facts.push(`已经发进群 ${sent} 条${titles}${groupNames.length ? `，发到 ${groupNames.join('、')}` : ''}`)
    if (!facts.length) return ''
    const prompt = [
      '【跟主人回一句：刚才的群分享办完了】',
      '处理结果：',
      ...facts.map((x) => `- ${x}`),
      '用你自己的口气跟主人说一声，像平时聊天，一两句话就够。',
      '别列清单、别用「待批」「回执」「额度」「队列」这些词，说人话。',
      '只输出这段话本身，40 字以内。',
    ].join('\n')
    let said = ''
    if (think) {
      try { said = cleanSpeech(await think('receipt', prompt)) } catch (error) { log.debug?.('群分享回执生成失败：', error.message) }
    }
    return said
  }

  async function decide(ids, action, groups) {
    // 每次进链都重新读文件：排队期间上一条命令可能已经处理过同一批
    const s = load()
    const touched = []
    let sent = 0
    let dropped = 0
    let failed = 0
    const ok = allowedGroups()
    // 默认群总要发；主人额外点名的群排后面（「多发几个群」= 默认 + 点名）
    const targets = [...new Set([String(cfg().groupId || ''), ...(Array.isArray(groups) ? groups : [])]
      .map((x) => String(x || '').trim()).filter(Boolean))]
    const legal = [...new Set(targets.filter((gid) => ok.includes(gid)))]
    const illegal = targets.filter((gid) => !ok.includes(gid))
    for (const id of ids) {
      const it = s.items.find((x) => x.id === id)
      if (!it || it.state !== 'pending') continue // 已经处理过 / 过期了，跳过，绝不再发一次
      const c = cfg()
      if (action === 'skip') { it.state = 'rejected'; it.decidedAt = Date.now(); save(s); dropped++; touched.push(it); continue }
      if (!legal.length) continue
      if (s.sentToday >= Number(c.dailyLimit)) continue // 额度用尽的留在 pending，等明天或主人处理
      if (getConfig().dryRun) { it.state = 'dry'; it.decidedAt = Date.now(); save(s); dropped++; touched.push(it); continue }
      let okThis = 0
      let failThis = 0
      for (const gid of legal) {
        if (s.sentToday >= Number(c.dailyLimit)) break
        try {
          const delivered = await sendOne(it, gid)
          if (delivered) { s.sentToday++; sent++; okThis++ } else { failed++; failThis++ }
        } catch (error) {
          failed++
          failThis++
          log.warn('群分享没发出去：', error.message)
        }
        save(s) // 每发一条就落盘：中途崩了也不会重复发
      }
      if (okThis) it.state = 'sent'
      else if (failThis) it.state = 'failed'
      it.decidedAt = Date.now()
      save(s)
      touched.push(it)
    }
    const left = ids.filter((id) => {
      const it = s.items.find((x) => x.id === id)
      return it && it.state === 'pending'
    }).length
    const limit = Number(cfg().dailyLimit)
    const lines = []
    if (sent) lines.push(`发到群了（${sent} 条${legal.length > 1 ? `，${legal.length} 个群` : ''}）`)
    if (dropped) lines.push(`按你说的没发 ${dropped} 条`)
    if (illegal.length) lines.push(`这几个群没授权，没发：${illegal.join('、')}`)
    if (left) lines.push(`还有 ${left} 条没发：今天的群分享额度用完了（${limit}）`)
    if (failed) lines.push(`${failed} 条没确认发出去（可能排在补发队里），看看群还在不在、网关通不通`)
    if (lines.length) {
      const sentTitles = touched.filter((x) => x.state === 'sent').map((x) => x.title)
      const groupNames = []
      for (const gid of legal) groupNames.push(await nameOf(gid))
      const spoken = await receiptSpeech({ sent, dropped, failed, left, limit, illegal, sentTitles, groupNames })
      // 没授权、没确认发出去这类硬事实不交给文笔兜着：模型那句后面补一行，免得被说得含糊
      const tail = []
      if (dropped) tail.push(`按你说的没发 ${dropped} 条`)
      if (illegal.length) tail.push(`没授权，没发：${illegal.join('、')}`)
      if (left) tail.push(`还有 ${left} 条没发，今天 ${limit} 条的额度用完了`)
      if (failed) tail.push(`${failed} 条没确认发出去`)
      const text = spoken ? [spoken, ...tail.map((x) => `（${x}）`)].join('\n') : lines.join('；')
      try { await hub.sendText(ownerChat(), text, undefined, undefined, undefined, { proactive: true, proactiveCause: 'bili-groupshare-receipt' }) } catch (error) { log.warn('群分享回执没发出去：', error.message) }
    }
    return { sent, dropped, failed, left }
  }

  /** 让模型读主人这句话：要发哪几条、发哪些群；读不懂返回 null（交回正常聊天）。 */
  async function understand(text, list) {
    if (!think) return null
    const names = []
    for (const gid of allowedGroups()) names.push(`${await nameOf(gid)}（${gid}）`)
    const lines = list.map((it, i) => `${i + 1}.《${clip(it.title, 40)}》——点评：${clip(it.text, 80)}`)
    const prompt = [
      '【读懂主人对「这批 B 站视频能不能发群」的回复】',
      `主人刚说：「${clip(text, 200)}」`,
      '当前待批（编号按问话顺序）：',
      ...lines,
      `可以发的群：${names.join('、')}`,
      '判断主人是想发（send）、不想发（skip），还是只在聊别的（none）。',
      '说「发吧」「可以」「那就发」= send，但只挑 1 条最值得分享的（items 填它的编号）；说「都发」「全部发」= send 全部；说「不发」「算了」= skip；点名某条就只选那几条。',
      '发多了像刷屏、不像分享，所以主人没明说「都发」时一律只发 1 条。',
      '没提别的群就别填 groups。拿不准就 none。',
      '只输出 JSON，不要解释：{"action":"send|skip|none","items":[编号],"groups":["群号"]}',
    ].join('\n')
    let plan = null
    try { plan = parsePlan(await think('understand', prompt)) } catch (error) { log.debug?.('群分享读懂回复失败：', error.message) }
    return plan
  }

  /** 主人的私聊回复。认出来就返回 true（不再交给她），认不出返回 false。 */
  async function handleReply(chatId, userId, text) {
    const g = getConfig()
    if (!g.ownerQQ || chatId !== ownerChat() || String(userId) !== String(g.ownerQQ)) return false
    const s = load()
    if (expireIn(s)) save(s) // 网关断线时 tick 可能很久没跑，回话前先清一次，别把过期的发出去
    const list = pendingOf(s)
    if (!list.length) return false
    const askedIds = Array.isArray(s.lastAsked?.ids) ? s.lastAsked.ids : null
    const byNumber = (n) => (askedIds ? askedIds[n - 1] : list[n - 1]?.id)

    // 规则快判：口令仍认，秒回
    const d = parseDecision(text)
    if (d) {
      if (d.all) {
        enqueue(() => decide(list.map((x) => x.id), d.action))
        return true
      }
      if (d.index === 0) {
        // 裸「发」只发一条：发多了像刷屏，主人明确说「都发」才全发
        enqueue(() => decide([list[0].id], d.action))
        return true
      }
      const id = byNumber(d.index)
      const one = list.find((x) => x.id === id)
      if (!one) {
        Promise.resolve().then(() => hub.sendText(ownerChat(), `第 ${d.index} 条已经不在了（过期或已经处理过），现在有 ${list.length} 条。`, undefined, undefined, undefined, { proactive: true, proactiveCause: 'bili-groupshare-receipt' })).catch(() => {})
        return true
      }
      enqueue(() => decide([one.id], d.action))
      return true
    }

    // 听不懂口令就交给模型：理解成「发哪些、发哪个群」
    const plan = await understand(text, list)
    if (!plan || plan.action === 'none') return false
    // 模型没点名就发第一条：默认一次只挑一条，别刷屏
    const ids = (plan.items.length ? plan.items.map(byNumber) : [list[0].id]).filter((id) => list.some((x) => x.id === id))
    if (!ids.length) return false
    enqueue(() => decide(ids, plan.action, plan.groups))
    return true
  }

  /** 在已载入的状态上扫一遍过期：过了 pendingTtlHours 的待批标 expired（不发、不吵主人）。 */
  function expireIn(s) {
    const ttl = Math.max(1, Number(cfg().pendingTtlHours) || 24) * 3600_000
    let n = 0
    for (const it of s.items) {
      if (it.state !== 'pending') continue
      if (Date.now() - Number(it.at || 0) <= ttl) continue
      it.state = 'expired'
      it.decidedAt = Date.now()
      n++
    }
    return n
  }

  /** 每分钟顺手调（tick 里）；主人回话时 handleReply 也会先扫一遍，免得网关断线期间 tick 没跑。 */
  function expire() {
    const s = load()
    const n = expireIn(s)
    if (n) { save(s); log.info(`有 ${n} 条群分享待批过期了，没发`) }
    return n
  }

  return { submit, handleReply, expire, pending: () => pendingOf(load()), linkOf }
}
