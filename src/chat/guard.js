// 正文污染闸：消息真正发出去之前的最后一道检查。
//
// 为什么需要它：模型有时会把「思考」直接写进正文块（而不是 reasoning 块）——
// 典型样子是「英文判断 + 中文正文」混在一起，例如群里那两条真实泄露：
//   NSFW image + 筹集 joke. Not addressed to me. Silence.[沉默]
//   Godot's story about … is funny. I could react with a laugh line. One line.美服这局也太热闹了…
// 还有思考塌缩：同一句「做。」连着重复上百次。
//
// 这一层不猜模型在想什么，只做三件事：
//   1. 把「思考前缀」切掉，留下后面真正要说的话（切完没话就沉默）；
//   2. 拦住明显退化的复读；
//   3. 拦住草稿/自检标记。
// 全部是纯函数，不发请求、不读写文件，方便单测。

/** 插件约定的「这轮不说话」标记，和 reply.js 的 SILENCE 是同一个字符串。 */
export const SILENCE = '[沉默]'

const CJK = /[\u4e00-\u9fff]/

// 思考/草稿里的高频英文元话语。只认整句（以 . ! ? 结尾）里的这些词，
// 避免正文里偶尔出现的英文词被误判。
const META_WORDS = /(?:not addressed|silence|i could|i should|i need|i think|i'll|i will|let me|reply|draft|final|one line|\d+ lines?|no reply|skip|ignore)/i

// 中文元话语（模型用中文写思考时）：只认句首或标点后，且要求句子很短，避免误伤正常说话。
const META_ZH = /(?:^|[。！？；，\s])(?:这条不是对我说的|不用接|不想接|保持沉默|先不接|跟我没关系)/

// 草稿标记：出现在正文里就不是给人看的话。
const DRAFT_MARK = /(?:^|\n)[ \t]*(?:Reply|Careful|Note|Watch|Draft|Final|Plan|自检|注意|定稿|草稿|思考|内心)[ \t]*[:：]/i

// 英文句子：以字母开头、不含中文、以 . ! ? 结尾；长度限一下，避免贪婪跨越正文。
const EN_SENTENCE = /[A-Za-z][^\u4e00-\u9fff\n]{0,200}?[.!?]/g

const MAX_GUARD_CHARS = 2000
// 带代码围栏的消息放宽到 20k：干活时贴代码、命令行、日志是正常输出，不能按「超长思考」拦。
const MAX_CODE_CHARS = 20000
const CODE_FENCE = /```/
// base64 / 哈希 / 长 ID：连续 40 个以上字母数字，不按「复读」判断。
const LONG_TOKEN = /[A-Za-z0-9+/=_-]{40,}/

/**
 * 切掉思考前缀，只留后面真正要说的话。
 *
 * 找「最后一个元话语英文句子」的结尾，把它和前面的全部切掉；
 * 剩余部分不含中文（或只剩沉默标记/空白）时返回空字符串——意思是这轮不该说话。
 * 没找到任何元话语时原样返回，不主动改动正常内容。
 */
export function stripThinkingPrefix (text) {
  const s = String(text || '')
  if (!s.trim()) return ''
  let last = null
  for (const m of s.matchAll(EN_SENTENCE)) {
    if (META_WORDS.test(m[0])) last = m
  }
  // 中文元话语：整句都是判断时直接当思考，不保留。
  // 只在「很短的一条」上生效，避免误伤「这个跟我没关系吧」这种正常回答。
  if (!last) {
    const zh = META_ZH.exec(s)
    if (zh && zh.index <= 24 && s.length <= 40) return ''
    return s
  }
  const rest = s.slice(last.index + last[0].length).trim()
  // 剩下的不是中文（整条都是英文思考），或只剩沉默标记，就当这轮没话。
  if (!CJK.test(rest)) return ''
  if (rest.replace(/\[沉默\]|\[silence\]/gi, '').replace(/[\s\p{P}]/gu, '') === '') return ''
  return rest
}

/**
 * 判断是不是「同一句反复」的退化输出（做。做。做。…）。
 *
 * 阈值故意放得很松：至少重复 4 次、重复部分不少于 24 个字、且占全文一半以上。
 * 「好耶好耶好耶」「哈哈哈哈哈哈」这类正常重复过不了线，不会误杀。
 */
export function isDegenerate (text) {
  const s = String(text || '').replace(/\s+/g, '')
  if (s.length < 24) return false
  const max = Math.min(s.length, MAX_GUARD_CHARS)
  for (let len = 2; len <= 8; len++) {
    for (let i = 0; i + len * 4 <= max; i++) {
      const unit = s.slice(i, i + len)
      if (!unit.trim()) continue
      let n = 1
      while (i + (n + 1) * len <= s.length && s.slice(i + n * len, i + (n + 1) * len) === unit) n++
      if (n >= 4 && n * len >= 24 && (n * len) / s.length > 0.5) return true
    }
  }
  return false
}

/** 只有沉默标记 / 纯标点时算「没有内容」。 */
function isBlank (text) {
  const t = String(text || '').replace(/\[沉默\]|\[silence\]/gi, '')
  return t.replace(/[\s\p{P}\p{S}]/gu, '') === ''
}

// ---------- 协议残渣兜底（第二道保险，只判不剥） ----------
//
// 正常剥除在 reply.js 的 cleanOutboundText（所有出口的公共必经点）里做完了。
// 这里只回答一个问题：**整条剥完是不是只剩协议残渣**——是的话宁可沉默也不发。
// 存在的意义是兜住「将来出现新的标记形态、cleanOutboundText 还不认识」的情况：
// 那种时候正文里往往只剩标签/属性串，没有真正要说的话，发出去就是纯脏内容。
//
// 判据：把已知协议标签、属性串、编号都挖空之后，若既没有中文、也没有成词的字母数字，就算残渣。
// 刻意保守——正常句子（哪怕很短，如「在吗」「ok」）一定留得下成词的字母/中文，不会误判。

/** 已知协议标签：acp / state / poke 闭合 / DSML 系列 / tool 调用类。 */
const PROTO_TAG_ALL = /<\s*\/?\s*(?:acp|state|x?invoke|x?parameter|x?function_calls?|x?tool_calls?|x?tool_use|antml:[a-z_]+)(?=[\s/>])[^<>]*>/gi
/**
 * 任意标签（含开/闭/自闭合、带或不带属性）。
 * 挖掉它不会误伤合法标记——`<poke>` / `<voice>` / `<sticker:…>` 这类在上面已经按 LEGIT_MARKUP
 * 提前放行了，走不到这里。这样「将来出现不认识的新协议帧」（开标签带属性、闭标签不带）也能兜住。
 */
const ANY_TAG = /<\s*\/?\s*[A-Za-z][\w:-]*(?:\s[^<>]*)?>/g
/** 属性串形状：`tokens="86" type="text" time="…"`（可能带前导 `=`）。 */
const PROTO_ATTR_RUN = /(?:=\s*)?"[^"]*"\s*(?:(?:[a-z][\w:-]*)\s*=\s*"[^"]*"\s*)+>>?/gi
/** 消息编号：`m01990`。 */
const PROTO_MSG_ID = /\bm\d{4,8}\b/g
/**
 * 属性尾巴里的日期时间残片（实况 `6-11-22 17:26:55">`：`2026-…` 被截掉了头）。
 * 只有「时间 + 收尾引号尖括号」这种**残片形状**才挖掉；正文里正常写的时间不会带上 `">`，
 * 所以「我们约 2026-11-22 17:26:55 见」不受影响（已实测）。
 */
const PROTO_TIME_TAIL = /(?:\d{1,4}-)?\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s*">/g

/**
 * 插件自己的合法出站标记：`<poke>` `<voice>` `<sticker:…>` `<face:…>` `<reply:…>` `<at:…>`。
 * 它们本身就是「要说的内容」（发个戳一戳、发个表情），绝不能因为挖空后没剩字就判残渣。
 * 有它们在场时直接按「有人话」放行，交给后面的 parseReply 正常解析。
 */
const LEGIT_MARKUP = /<\s*\/?\s*(?:poke|voice|sticker|face|reply|at|state)\b[^<>]*>/i

/**
 * 整条是不是只剩协议残渣。
 * @returns {boolean} true = 没有真正要说的话，应当按沉默处理
 */
function isProtocolResidue (text) {
  const t = String(text || '')
  if (!t.trim()) return true
  // 只有插件自己的合法标记（发个戳一戳 / 发个语音 / 发个表情）：那是内容，不是残渣。
  if (LEGIT_MARKUP.test(t)) return false
  // 先把已知标记挖空；挖完什么都不剩 → 残渣。
  const hollow = t
    .replace(/```[\s\S]*?```/g, '') // 围栏内是正当内容，不参与判定
    .replace(PROTO_TAG_ALL, '')
    .replace(ANY_TAG, '') // 兜住将来出现的不认识的新协议帧（含不带属性的闭标签）
    .replace(PROTO_ATTR_RUN, '')
    .replace(PROTO_TIME_TAIL, '')
    .replace(PROTO_MSG_ID, '')
  // 剩下的必须还有「成词」的东西才算有人话：中文 ≥1 字，或 ≥2 个连续字母数字。
  // 都挖空之后什么都不剩 → 整条只有协议标记，按沉默处理。
  if (/[\u4e00-\u9fff]/.test(hollow)) return false
  return !/[A-Za-z0-9]{2,}/.test(hollow.replace(/[=<>/\\"'`\-_.:;,|]+/g, ' '))
}

/**
 * 注入给模型的格式提醒（由代码放进系统提示，不动人格文件）。
 * 目的是让「干活时贴的代码」能过闸：guard 对 ``` 围栏整段豁免，
 * 但模型得知道要加围栏，否则没包起来的长代码会被当成超长文本拦掉。
 */
export function codeFenceInstruction () {
  return '【贴代码/命令行时】回复里如果要给对方看代码、命令行、日志，请用 ``` 围栏包起来（例如 ```js … ```）。'
    + '没包起来的长文本会被当成超长内容拦下，包起来就不会。'
    + '\n【做动作时】想戳对方就单独写 <poke>（会变成 QQ 的戳一戳），不要用方括号写「[戳了戳你…]」——'
    + '方括号里的动作会原样当成文字发出去。'
}

/**
 * 出站文本的最后一道闸。
 *
 * @param {string} text 准备发出去的文字
 * @param {{ source?: 'message'|'reasoning'|'interim' }} [opts] 来源：正文块 / 从思考里捞的 / 分条中间段
 * @returns {{ ok: boolean, text: string, reason: string }}
 *   ok=false 时调用方应当不发这一条（宁可沉默），并把 reason 记日志。
 */
export function guardOutgoing (text, opts = {}) { // eslint-disable-line no-unused-vars
  const raw = String(text || '').trim()
  if (!raw) return { ok: false, text: '', reason: 'empty' }

  // 干活时贴的代码块整段豁免：她发给主人的代码、命令行、日志不是「思考」。
  // 只对围栏外面的部分切思考前缀，围栏里一个字都不动；长度上限也放宽。
  if (CODE_FENCE.test(raw)) {
    if (raw.length > MAX_CODE_CHARS) return { ok: false, text: '', reason: 'too-long' }
    const at = raw.indexOf('```')
    const head = stripThinkingPrefix(raw.slice(0, at))
    const body = raw.slice(at)
    const merged = [head, body].filter(Boolean).join('\n').trim()
    if (isBlank(merged)) return { ok: false, text: '', reason: 'blank' }
    return { ok: true, text: merged, reason: '' }
  }

  if (raw.length > MAX_GUARD_CHARS) return { ok: false, text: '', reason: 'too-long' }

  const work = stripThinkingPrefix(raw)
  if (!work) return { ok: false, text: '', reason: 'thinking-only' }

  if (isBlank(work)) return { ok: false, text: '', reason: 'blank' }
  // 整条只剩协议标记/属性串（cleanOutboundText 还不认识的新形态）：宁可沉默，也不发脏内容。
  // 放在退化检测之前：残渣常常带一长串属性，LONG_TOKEN 会把它从退化检测里豁免掉。
  if (isProtocolResidue(work)) return { ok: false, text: '', reason: 'protocol-residue' }
  // base64 / 哈希 / 长 ID 这类长串不按「复读」处理，否则贴一串数据就被当成退化了。
  if (!LONG_TOKEN.test(work) && isDegenerate(work)) return { ok: false, text: '', reason: 'degenerate' }
  if (DRAFT_MARK.test(work)) return { ok: false, text: '', reason: 'draft' }

  return { ok: true, text: work, reason: '' }
}
