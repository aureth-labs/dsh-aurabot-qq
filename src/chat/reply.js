// 把模型的一轮回复拆成要发到 QQ 的「一条条消息」。
//
// 模型输出约定（写在人格卡里）：
//   - `|||` 分隔多条气泡
//   - `<voice>…</voice>` 包住的内容发成语音
//   - `<sticker:标签>` 发一张表情（可写 `<sticker:标签></sticker>`）
//   - `<poke>` = 戳一戳对方
//   - `<reply:编号>` 写在某句前面 = 这句以「引用回复」发出（群聊里引用提示词中带编号的那条消息）
//   - 整轮只输出 `[沉默]`（或空）= 这次不说话（群聊插话用）
// 另外顺手把模型偶尔漏出来的 Markdown 洗掉——QQ 不渲染 Markdown。

import { chatRecordRanges, contextInjectionRanges, currentPromptSources, imageHandleRanges, memoryTranscriptRanges, promptFingerprint, promptTextRanges } from '../security/leak-guard.js'
import { stripMarkers } from './reply-marker.js'
import { stripHtmlFragments, fenceRanges } from './html-fragments.js'

export const SILENCE = '[沉默]'

// 提示词里每条消息前挂的时刻，统一按东八区。
// 拼进正文是为了让她判断「多久以前」——提示词里只有每轮开头的「当前时间」，
// 消息体本身原来不带时刻，跨几轮就容易把十几分钟前的事说成「昨天」。
// 只给 HH:MM 跨天会失真（23:50 与次日 00:10 看起来像同一段时间倒着走），
// 所以 clockLabel 在跨天时补上日期：当天 `21:34`、前一天 `昨天 21:34`、更早 `11-07 21:34`。
const CLOCK = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })
// 用完整日期再裁出 MM-DD，比单取月/日稳妥：sv-SE 单独取月日会给出 06/11（日在前）
const DAY = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })

export function clockAt(at = Date.now()) {
  const t = Number(at)
  return CLOCK.format(new Date(Number.isFinite(t) && t > 0 ? t : Date.now()))
}

/** 当天只给时刻，跨天补日期：`21:34` / `昨天 21:34` / `11-06 21:34` / `2025-12-31 23:59`。 */
export function clockLabel(at, now = Date.now()) {
  const t = Number(at)
  const then = new Date(Number.isFinite(t) && t > 0 ? t : now)
  const cur = new Date(now)
  const day = DAY.format(then)
  if (day === DAY.format(cur)) return clockAt(then.getTime())
  if (day === DAY.format(new Date(cur.getTime() - 86400000))) return `昨天 ${clockAt(then.getTime())}`
  const sameYear = day.slice(0, 4) === DAY.format(cur).slice(0, 4)
  return `${sameYear ? '' : day.slice(0, 4) + '-'}${day.slice(5)} ${clockAt(then.getTime())}`
}

/** 去掉 Markdown 痕迹，保留文字本身。 */
export function stripMarkdown(text) {
  return String(text || '')
    .replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 $2')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// 假媒体动作：模型声称「图片/照片已经发出」或「刚拍了一张」，但回复里根本没有对应的
// 图片段/工具调用（这台机器也没有拍照硬件）。这些动作描写原样发到 QQ，主人会以为图在路上，
// 实际永远收不到，所以要在出站清洗时剥掉。
//
// 只认「整个括号内容都是这类短动作短语」的圆括号/方括号：普通括号动作（（笑）、（凑近看了看））、
// 颜文字（（￣▽￣））、[图片] 这类占位，以及代码示例里的字面量都不动。
const FAKE_MEDIA_NOUN = '(?:图片|照片|相片|自拍照?|截图|图)'
const FAKE_MEDIA_TAIL = '[\\s，。！!？?、~～…]*$'
const FAKE_MEDIA_SEND = [
  // 图片发出 / 图片已发出 / 图片发出来了 / 图片发送成功 / 照片发你了 / 图片给你发过去了 / 图发你了
  new RegExp(
    '^(?:我|这边|现在)?(?:已经|已|刚刚|刚才|刚|这就|就|先)?' + FAKE_MEDIA_NOUN + '(?:我)?' +
    '(?:已经|已|刚刚|刚才|刚)?(?:给你)?' +
    '(?:发出(?:出去|过去|给|你|给你)?(?:了|啦|哦|喔|呀|哈|呢)?(?:成功|完毕)?' +
    '|(?:发|传)出来(?:了|啦|哦|喔|呀|哈|呢)?(?:成功|完毕)?' +
    '|发送(?:出去|过去|给|你|给你)?(?:了|啦|哦|喔|呀|哈|呢|成功|完毕)?' +
    '|(?:发|传)(?:出去|过去|给你|给|你)(?:了|啦|哦|喔|呀|哈|呢)?(?:成功|完毕)?' +
    '|(?:发|传)(?:了|啦|哦|喔|呀|哈|呢)(?:出去|过去)?(?:成功|完毕)?' +
    '|(?:发|传)(?:了|啦|哦|喔|呀|哈|呢)?(?:成功|完毕)?)' + FAKE_MEDIA_TAIL,
  ),
  // 发了图 / 发了一张新图 / 发图了 / 传图了
  new RegExp(
    '^(?:我)?(?:已经|已|刚刚|刚才|刚|这就|就)?(?:给你)?(?:发送|发出|发|传)(?:出去|过去)?' +
    '(?:了|过)(?:一?[张个])?(?:新(?:的)?)?' + FAKE_MEDIA_NOUN + FAKE_MEDIA_TAIL,
  ),
  new RegExp(
    '^(?:我)?(?:已经|已|刚刚|刚才|刚|这就|就)?(?:给你)?(?:发送|发出|发|传)(?:出去|过去)?' +
    '(?:一?[张个])?(?:新(?:的)?)?' + FAKE_MEDIA_NOUN + '(?:了|啦|哦|喔|呀)' + FAKE_MEDIA_TAIL,
  ),
  // 我发图给你 / 发照片给你了
  new RegExp(
    '^(?:我)?(?:已经|已|刚刚|刚才|刚|这就|就|先)?(?:给你)?(?:发送|发出|发|传)(?:出去|过去)?' +
    '(?:了|过)?(?:一?[张个])?(?:新(?:的)?)?' + FAKE_MEDIA_NOUN +
    '(?:给你|给|你)(?:了|啦|哦|喔|呀|哈|呢)?' + FAKE_MEDIA_TAIL,
  ),
]
// 拍了一张新的 / 拍了张新照片 / 刚拍了一张 / 拍照了 / 拍了张照片给你 / 照了张照片
// 注意：裸「拍好了」「拍到了」「拍完了」「照了」没有量词/媒体名词，按正常叙述保留。
const FAKE_PHOTO_ACTION = new RegExp(
  '^(?:我)?(?:已经|已|刚刚|刚才|刚|又|才|这就|就|先)?' +
  '(?:' +
    '(?:拍照|自拍)(?:了|啦|哦|喔|呀|哈|呢)' +
    '|拍(?:(?:了|过)(?:一?[张个])?(?:新(?:的)?)?(?:的)?' + FAKE_MEDIA_NOUN + '?' +
      '|(?:一?[张个])(?:新(?:的)?)?(?:的)?' + FAKE_MEDIA_NOUN + '?' +
      '|(?:新(?:的)?)?(?:的)?' + FAKE_MEDIA_NOUN + ')' +
    '|照(?:(?:了|好|到|完)(?:一?[张个])?(?:新(?:的)?)?(?:的)?)?' + FAKE_MEDIA_NOUN +
  ')' +
  '(?:给你)?(?:了|啦|哦|喔|呀|哈|呢)?' + FAKE_MEDIA_TAIL,
)
// 照片拍好了 / 图片已经拍完了
const FAKE_PHOTO_DONE = new RegExp(
  '^(?:这张|新的)?' + FAKE_MEDIA_NOUN + '(?:已经|已)?拍(?:好|完|到|了)(?:了|啦|哦|呀)?' + FAKE_MEDIA_TAIL,
)
// 照片拍给你了 / 图片拍给你了
const FAKE_PHOTO_GIVE = new RegExp(
  '^(?:这张|新的)?' + FAKE_MEDIA_NOUN + '(?:已经|已)?拍(?:给你|给|你)(?:了|啦|哦|喔|呀|哈|呢)?' + FAKE_MEDIA_TAIL,
)
// 圆括号/中文方括号与 ASCII 方括号分开配对：不能把「（图片发出]」这种混括号当动作，
// 也不能漏掉模型常写的 [图片发出] / [照片发你了]；[图片] 仍是占位，不在动作词表里所以保留。
const FAKE_MEDIA_BRACKETS = [
  /[（(【]\s*([^（）()【】\n]{1,40}?)\s*[）)】]/gu,
  /\[([^\[\]\n]{1,40}?)\]/gu,
]
const isFakeMediaPhrase = (value) => FAKE_MEDIA_SEND.some((re) => re.test(value)) ||
  FAKE_PHOTO_ACTION.test(value) || FAKE_PHOTO_DONE.test(value) || FAKE_PHOTO_GIVE.test(value)

/** 假媒体动作在原文里的删除区间；代码块/行内代码中的示例保持原样。 */
function fakeMediaActionRanges(raw) {
  const text = String(raw || '')
  if (!text) return []
  // 代码围栏（``` / ~~~）和行内代码里的示例原样保留。
  const code = [...codeRanges(text), ...fenceRanges(text)]
  const ranges = []
  for (const pattern of FAKE_MEDIA_BRACKETS) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index
      const end = start + match[0].length
      if (insideCode(code, start, end)) continue
      if (!isFakeMediaPhrase(match[1].trim())) continue
      ranges.push({ start, end })
    }
  }
  return ranges
}

// 模型偶尔把自己那边的内部语法漏进正文，这些都不能发到 QQ，得在解析入口洗掉：
//   - 工具调用的收尾标记，比如 </｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>（全角竖线包着关键字）
//   - 上下文插件给历史消息挂的编号（m00896 / m00896b），提示词里说了不许抄，但它会抄
// 编号是 5 位起（补零写法 m00xxx）；4 位的 m1005、m1136 是打印机型号，不能误伤。
const SPECIAL_TOKEN = /<\/?[｜|]{1,2}\s*[A-Za-z_]+\s*[｜|]{1,2}[^<>]*>/g
const CONTEXT_REF = '(?:m0\\d{3,5}|m[1-9]\\d{4,6})[a-z]{0,2}'
const REF_AT_HEAD = new RegExp(`^[ \\t]*(?:${CONTEXT_REF})[ \\t]*[，,：:、]?[ \\t]*`)
const REF_INLINE = new RegExp(`(?<![A-Za-z0-9])(?:${CONTEXT_REF})(?![A-Za-z0-9])`, 'g')
const REF_IN_BAD_TAG = new RegExp(`<reply\\s*[:：]\\s*(?:${CONTEXT_REF})\\s*>`, 'gi')

/** 洗掉模型漏出来的内部标记与消息编号：行首连标点一起清，行中行尾留个空格；洗完是空的就当「这次不说话」。 */
export function stripModelArtifacts(text) {
  const cleaned = String(text || '')
    .replace(SPECIAL_TOKEN, '')
    .replace(REF_IN_BAD_TAG, '')
    .split('\n')
    .map((line) => line.replace(REF_AT_HEAD, '').replace(REF_INLINE, ''))
    .join('\n')
  // 收空格只在代码块外面做：代码里的缩进是内容（YAML、Python），
  // 一律把连续空格压成一个会把 4 空格缩进压成 1 个，发出去就不是原来那段代码了（#599）。
  const code = codeRanges(cleaned)
  const squeeze = (chunk) => chunk.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n')
  if (!code.length) return squeeze(cleaned).trim()
  let out = ''
  let last = 0
  for (const range of code) {
    out += squeeze(cleaned.slice(last, range.start)) + cleaned.slice(range.start, range.end)
    last = range.end
  }
  return (out + squeeze(cleaned.slice(last))).trim()
}

const SILENCE_MARK_SOURCE = '\\[沉默\\]|［沉默］|\\(沉默\\)|（沉默）'

// 模型内部状态标签：<state> / </state>（2026-11-08 群友反馈消息结尾带 <state></state>）。
// 仓库里的提示词没有要求输出这个标签，属于模型自身内部格式漏进正文；无论来源，出站都不能露出。
// 只认完整标签名 state（后面必须是空白、/ 或 >），<statement>、<stateful> 这类正常文字不误伤；
// 代码块/行内代码里的示例保留。
const STATE_TAG = /<\/?\s*state(?=[\s/>])[^<>]*>/gi

/** 收集 state 标签的删除区间：成对的开闭标签连中间内容一起删，孤立标签只删标签本身。 */
function stateTagRanges(raw) {
  const code = codeRanges(raw)
  const tokens = []
  for (const m of raw.matchAll(STATE_TAG)) {
    if (insideCode(code, m.index, m.index + m[0].length)) continue
    tokens.push({ start: m.index, end: m.index + m[0].length, closing: /^<\s*\//.test(m[0]), selfClose: /\/\s*>$/.test(m[0]) })
  }
  const ranges = []
  const stack = []
  for (const t of tokens) {
    if (t.closing) {
      const open = stack.pop()
      ranges.push({ start: open ? open.start : t.start, end: t.end })
    } else if (t.selfClose) {
      ranges.push({ start: t.start, end: t.end })
    } else {
      stack.push(t)
    }
  }
  for (const open of stack) ranges.push({ start: open.start, end: open.end })
  return ranges
}

/** 是不是「这次不说话」：整条只由沉默标记、空白、标点组成才算。 */
const SILENCE_MARK = new RegExp(SILENCE_MARK_SOURCE, 'g')
// 标记周边通常还跟着空格：一起带走，免得剥完正文留下「嗯  我在」这种多空格。
const SILENCE_MARK_WITH_SPACE = new RegExp(`[ \\t]*(?:${SILENCE_MARK_SOURCE})[ \\t]*`, 'g')
export function isSilence(text) {
  const t = String(text || '').trim()
  if (t === '') return true
  return t.replace(SILENCE_MARK, '').replace(/[\s\p{P}]/gu, '') === ''
}

/**
 * 收尾标点后面又跟了逗号（「。，」「！，」）：人格卡要求每句有收尾标点，模型想停顿时会再补一个逗号。
 * 只在紧邻的位置收掉逗号，正常的中文逗号不受影响；语音条和文字气泡共用这一份（#546）。
 */
export function tidyPunctuation(text) {
  const raw = String(text || '')
  const tidy = (chunk) => chunk.replace(/([。！？…]+)[ \t]*[，,]+/g, '$1')
  const code = codeRanges(raw)
  if (!code.length) return tidy(raw)
  let out = ''
  let last = 0
  for (const range of code) {
    out += tidy(raw.slice(last, range.start)) + raw.slice(range.start, range.end)
    last = range.end
  }
  return out + tidy(raw.slice(last))
}

/** 剥掉正文里残留的沉默标记；整条只有标记时会变成空串，由 isSilence 判沉默。 */
export function stripSilenceMarks(text) {
  return String(text || '').replace(SILENCE_MARK_WITH_SPACE, '')
}

/** 沉默标记的删除区间：统一出站清洗按原文坐标并进 cuts，消息段映射才不会错位。 */
function silenceMarkRanges(text) {
  const ranges = []
  const re = new RegExp(SILENCE_MARK_WITH_SPACE.source, 'g')
  for (const m of String(text || '').matchAll(re)) ranges.push({ start: m.index, end: m.index + m[0].length })
  return ranges
}

// 戳一戳只有 <poke> / <poke/> 是动作；</poke> 是模型收尾时漏出来的闭合标签，
// 任何出口都不能把标签文字发出去（2026-11 群友截图：「嗯？ <poke>」）。
// 只删闭合标签，<poke> 原样留给 parseReply 触发真戳一戳。
const POKE_CLOSE_TAG = /[ \t]*<\s*\/\s*poke\s*>[ \t]*/gi

// 目的引擎内部备忘（【目的】【需求】【情绪】【感受】【类型】【状态】【待续】【持续】）。
// #446 之后目的回合直接在她的聊天会话里跑，提示词模板和带备忘的回答会留在会话历史里；
// 之后普通回复模型照猫画虎也写备忘，而普通回复不走目的模块的 cleanReply——
// 所以统一出站清洗必须自己兜底（2026-11-19 实测：对方都看见「状态栏」并问起来了）。
// 判据要保守：正文里出现 ≥2 个不同备忘头才当备忘块（只出现 1 个可能是真在聊「目的」二字），
// 命中就从第一个备忘头连到消息末尾整段删（备忘永远在回答末尾）。
const MEMO_HEADER = /[【\[]\s*(?:目的|需求|情绪|感受|类型|状态|待续|持续)\s*[】\]]/g

/** 收集目的引擎备忘块的删除区间：≥2 个备忘头时，从第一个头删到末尾；不足 2 个不动。 */
function memoLeakRanges(raw) {
  const text = String(raw || '')
  const hits = []
  for (const m of text.matchAll(MEMO_HEADER)) hits.push({ start: m.index, end: m.index + m[0].length })
  if (hits.length < 2) return []
  return [{ start: hits[0].start, end: text.length }]
}

/** 收集 poke 闭合标签的删除区间；统一出站清洗和 parseReply 共用。 */
function pokeCloseTagRanges(text) {
  const ranges = []
  const re = new RegExp(POKE_CLOSE_TAG.source, 'gi')
  for (const m of String(text || '').matchAll(re)) ranges.push({ start: m.index, end: m.index + m[0].length })
  return ranges
}

// ---------- ACP 协议标记（DSH 上下文代理的传输层包装） ----------
//
// DSH 的上下文代理会给每条消息套一层 ACP 包装：`<acp tokens="86" type="text" time="…">mNNNNN</acp>`。
// 模型状态差时会把这层标记当正文**模仿复述**出来，于是带属性串原样漏进 QQ（2026-11-22 实况三形态：
// 完整空标签 `<acp …></acp>`、属性尾巴 `="text" time="…">>`、截断残片 `6-11-22 17:26:55">`）。
//
// 为什么必须单独写一套规则：
//   · html-fragments 的 TAG_RE 要求 `<` 开头，**删不掉没有 `<` 的半截尾巴**；
//   · toolTag 的 PROTO_NAMES 是工具协议名白名单，语义是「删标签连中间内容」，与这里不同；
//   · 整条只剩标记时必须能变成空串，交给 isSilence 判沉默（不能发一条空气泡）。
//
// 这里只认 acp 这一个名字，且要求名字后紧跟空白 / `/` / `>`（`(?=[\s/>])`），
// 所以正文里正常写 `acp`、`acpxxx`、`<acpx>` 都不受影响。
const ACP_NAME = /acp(?=[\s/>])/i

/**
 * ACP 开标签 + 紧随其后的消息编号 `mNNNNN`（闭合参数可选）。
 * 编号是代理侧的流水号，对读消息的人没有任何意义，所以连编号一起删；
 * 模型常常只复述了开标签、没写闭合标签，闭合段必须是可选的。
 *
 * 末尾的 `[ \t]*\r?\n?` 是为了吃掉「标签独占一行」时留下的空行：
 * 否则 `前\n<acp…>m1</acp>\n后` 剥完会变成 `前\n\n后`（多一个空气泡行）。
 * 只有在序列后紧跟着换行时才吃，行中间的行内标记不受影响。
 */
const ACP_PAIRED = /<\s*acp\b[^<>]*>\s*m\d{1,8}\s*(?:<\s*\/\s*acp\s*>)?[ \t]*\r?\n?/gi
/** 落单的 ACP 开/闭标签（含自闭合），只删标签本身。 */
const ACP_TAG = /<\s*\/?\s*acp(?=[\s/>])[^<>]*>/gi
/**
 * 属性尾巴残片：真标签的头被截掉了，只剩属性串和收尾尖括号。
 * 两种形态都要覆盖：
 *   · `="text" time="2026-11-22 17:26:47">>` —— 属性名 `type` 被截掉，只剩它的值；
 *   · `tokens="86" type="text" time="…">` —— 头被截掉但属性名还在。
 * 只锚 tokens / type / time 这三个 ACP 属性名，且必须以 `">` 或 `">>` 收尾。
 * **不做通用的「任意 xxx="…"」匹配**——那样会误伤正文里正常引用的一段配置/JSON 片段。
 */
const ACP_ATTR_TAIL = /(?:^|[\s(【\[])(?:=\s*"[^"]*"\s*)?(?:(?:tokens|type|time)\s*=\s*"[^"]*"\s*)+>>?/gi
/**
 * 只剩日期时间 + 收尾尖括号的极短残片（实况 `6-11-22 17:26:55">`，是 `2026-…` 被截掉的尾巴）。
 * 必须带 `">` 尾锚定：正常聊天里写「我们约 2026-11-22 17:26:55 见」不会被误删（实测通过）。
 */
const ACP_TIME_TAIL = /(?:^|[\s(【\[])\d{1,4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s*">/g

/**
 * 文本里是否还有「标签 / 属性串」形状的东西（给模型兜底的触发条件用，不做删除）。
 * 判据故意宽于 acpLeakRanges：它的用途是「正则剥完还像有残渣吗」，宁可多问一次模型。
 */
export function hasSuspectTagShape(text) {
  const s = String(text || '')
  return /<\s*\/?\s*[A-Za-z][\w:-]*\s+[\w:-]+\s*=/i.test(s) || /=\s*"[^"]*"\s+[\w:-]+\s*=\s*"/i.test(s)
}

/**
 * 收集 ACP 协议标记的删除区间（原文坐标）。
 * 代码块 / 行内代码内一律不碰——模型可能在教人写标签，那是正当输出。
 */
function acpLeakRanges(raw) {
  const text = String(raw || '')
  if (!text) return []
  const code = codeRanges(text)
  // 完整标签的区间：属性尾巴/时间残片**只处理 `<` 已经被截掉的残片**，
  // 绝不进到完好的 `<...>` 里面去切属性——否则 `<future-mark tokens="9" …>` 会被切成
  // `<future-mark </future-mark>` 这种更脏的半截标签（自测踩过）。
  const tagSpans = [...text.matchAll(/<[^<>]*>/g)].map((m) => ({ start: m.index, end: m.index + m[0].length }))
  const inTag = (start, end) => tagSpans.some((t) => start >= t.start && end <= t.end)
  const out = []
  const push = (start, end) => {
    if (end <= start) return
    if (insideCode(code, start, end)) return
    out.push({ start, end })
  }
  // 顺序有讲究：先整段配对的（含编号），再落单标签，最后才是属性尾巴。
  for (const m of text.matchAll(ACP_PAIRED)) push(m.index, m.index + m[0].length)
  for (const m of text.matchAll(ACP_TAG)) push(m.index, m.index + m[0].length)
  // 属性尾巴与时间残片都带了前导空白/括号：只删残片本身，前导字符留着（它是正文里的正常分隔）。
  for (const re of [ACP_ATTR_TAIL, ACP_TIME_TAIL]) {
    for (const m of text.matchAll(re)) {
      const lead = /^[\s(【\[]/.exec(m[0])
      const start = m.index + (lead ? lead[0].length : 0)
      const end = m.index + m[0].length
      if (inTag(start, end)) continue // 完好标签内部：交给上面的 acp 标签规则，别切一半
      push(start, end)
    }
  }
  return out
}

/** 这段文本里还有没有 ACP 标记可剥（出口断言与日志用，不做删除）。 */
export function hasAcpResidue(text) {
  return acpLeakRanges(text).length > 0
}

/** 剥掉 ACP 标记（幂等）：出口层用，返回剥干净的文本。 */
export function stripAcpLeak(text) {
  const raw = String(text || '')
  if (!raw) return raw
  const ranges = acpLeakRanges(raw)
  if (!ranges.length) return raw
  return withoutToolRanges(raw, mergeRanges(ranges)).trim()
}

const ZERO_WIDTH_CHARS = new Set(['\u200B', '\u200C', '\u200D', '\uFEFF', '\u2060'])
const stripZeroWidth = (s) => { let out = ''; for (const ch of String(s || '')) if (!ZERO_WIDTH_CHARS.has(ch)) out += ch; return out }
const FULLWIDTH = (s) => String(s || '').replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))

// 「解释格式/示例」的上下文：这类回答里的代码块/示例不该被工具删除掏空。
const EXPLAIN_CONTEXT = /(?:例如|比如|示例|例子|举例|解释|说明|格式|写法|怎么写|怎样写|如何写|这样写|这么写|写成|教我|模板|代码如下|代码块|演示|demo|example|提示词|标签)/i
const PROTO_ATTRS = /^(?:name|arguments?|input|id|callid|type|function|parameters?|parameter|prompt|content|text|json|args|new|old|value|tool|query|q)$/
const PROTO_NAMES = ['functioncalls', 'functioncall', 'toolcalls', 'toolcall', 'tooloutputs', 'tooloutput', 'toolsection', 'tooluse', 'parameter', 'parameters', 'invoke', 'calls', 'call', 'prompt', 'outputs', 'output', 'results', 'result', 'observations', 'observation']

/** 代码围栏 / 行内代码范围：解释语境下里面的工具示例保留。 */
function codeRanges (raw) {
  const ranges = []
  const chars = String(raw).split('')
  // 代码围栏既可能从行首开始（~~~ / 未闭合 ```，由 fenceRanges 认），
  // 也可能夹在行内（```js…```）；两路合并后再挖掉，避免收尾 ``` 与后面的行内反引号误配。
  const fences = []
  for (const m of raw.matchAll(/```[\s\S]*?```/g)) fences.push({ start: m.index, end: m.index + m[0].length })
  for (const f of fenceRanges(raw)) fences.push({ start: f.start, end: f.end })
  const mergedFences = []
  for (const f of fences.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const prev = mergedFences[mergedFences.length - 1]
    if (prev && f.start <= prev.end) prev.end = Math.max(prev.end, f.end)
    else mergedFences.push({ ...f })
  }
  for (const f of mergedFences) {
    ranges.push({ ...f, fence: true })
    for (let i = f.start; i < f.end; i++) chars[i] = ' '
  }
  const masked = chars.join('')
  for (const m of masked.matchAll(/`[^`\n]+`/g)) {
    ranges.push({ start: m.index, end: m.index + m[0].length, fence: false })
  }
  // 行内代码可能出现在围栏前面；后续按区间切分必须按起点排序并合并重叠。
  const sorted = ranges.sort((a, b) => a.start - b.start || a.end - b.end)
  const merged = []
  for (const r of sorted) {
    const prev = merged[merged.length - 1]
    if (prev && r.start <= prev.end) prev.end = Math.max(prev.end, r.end)
    else merged.push({ ...r })
  }
  return merged
}
const insideCode = (code, start, end) => code.some((r) => start >= r.start && end <= r.end)

/** 跨聊天工具的发送前校验：代码示例不算指令，残缺/嵌套/跨气泡的语音标签不直接外发。 */
export function hasInvalidVoiceMarkup(text) {
  const raw = String(text || '')
  const code = codeRanges(raw)
  let masked = raw
  for (const r of [...code].sort((a, b) => b.start - a.start)) masked = masked.slice(0, r.start) + ' '.repeat(r.end - r.start) + masked.slice(r.end)
  let open = false
  for (const [token] of masked.matchAll(/<\/?voice\b[^>]*(?:>|$)|\|\|\|/gi)) {
    if (token === '|||') { if (open) return true }
    else if (token === '<voice>' && !open) open = true
    else if (token === '</voice>' && open) open = false
    else return true
  }
  return open
}

/** 只识别工具协议标签；普通的 <、|、HTML 和聊天控制标签不在这里处理。 */
function toolTag (token) {
  let body = FULLWIDTH(stripZeroWidth(token)).slice(1).replace(/>$/, '').trim()
  if (!body) return null
  // 闭合标签可能是 </invoke>、</|DSML|invoke>、<|DSML|/invoke>：斜杠可能在前缀前或前缀后
  const closing = /^[|｜]*\s*\//.test(body) ||
    /^(?:(?:[|｜]\s*)+d\s*s\s*m\s*l(?=\s|[|｜]|$)\s*(?:[|｜]\s*)+)\s*\//i.test(body) ||
    /^antml\s*:\s*\//i.test(body)
  // 先去掉最前面的斜杠（</invoke>、</|DSML|invoke>），再剥 DSML / antml 前缀，最后再处理前缀后的多余斜杠。
  body = body.replace(/^[|｜]*\s*\/\s*/, '')
  const prefix = /^(?:(?:[|｜]\s*)+d\s*s\s*m\s*l(?=\s|[|｜]|$)\s*(?:[|｜]\s*)*|antml\s*:\s*)/i.exec(body)
  const hadPrefix = Boolean(prefix)
  if (hadPrefix) body = body.slice(prefix[0].length)
  body = body.replace(/^[|｜]*\s*\/\s*/, '').replace(/\/\s*$/, '') // </|DSML|/invoke> 这类多余斜杠；<tool_call/> 自闭合
  const compact = body.replace(/[\s\u3000]+/g, '')
  // 成对开始/结束标记：|tool_calls_begin|、<|tool▁calls▁begin|>、DSML 前缀版
  const boundary = /^(?:[|｜]+)?(tool(?:[▁_]*(?:calls?|outputs?|section))*)[▁_]*(begin|end)(?:[|｜]+)?$/i.exec(compact)
  if (boundary) return { key: boundary[1].toLowerCase().replace(/[▁_]/g, ''), closing: boundary[2].toLowerCase() === 'end' }
  if (/^[|｜]*tool[▁_]*sep[|｜]*$/i.test(compact)) return { key: 'toolsep', closing: true }
  const bare = compact.replace(/^[|｜]+|[|｜]+$/g, '')
  // 内部推理标记：begin_of_thought / end_of_thought / thinking / <|/thinking|>
  if (/^(?:begin[\s_-]*of[\s_-]*thought|end[\s_-]*of[\s_-]*thought)$/i.test(bare)) return { key: 'thinking', closing: /^end/i.test(bare) }
  if (/^think(?:ing)?$/i.test(bare)) return { key: 'thinking', closing }
  // 标签名内部可能被插了全角空格/换行（<in　voke>、<in\nvoke>）；去掉属性部分再认协议名
  const eq = body.indexOf('=')
  const head = FULLWIDTH(eq >= 0 ? body.slice(0, eq) : body).replace(/[\s\u3000_:-]+/g, '').toLowerCase()
  for (const name of [...PROTO_NAMES].sort((a, b) => b.length - a.length)) {
    if (!head.startsWith(name)) continue
    const rest = head.slice(name.length)
    if (!rest || PROTO_ATTRS.test(rest)) return { key: name, closing }
  }
  if (hadPrefix) return { key: 'protocol:' + compact.toLowerCase(), closing }
  return null
}

/** 单次线性括号扫描：只收集配平的 {…} / […] 区间（含单引号/双引号字符串边界）。 */
function balancedSpans (raw, maxLen) {
  const spans = []
  const stack = []
  let quote = ''
  let escaped = false
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (quote) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === quote) quote = ''
      else if (c === '\n' && quote === "'") quote = '' // 单引号不跨行，避免句子里的撇号吞掉后面
      continue
    }
    if ((c === '"' || c === "'") && stack.length > 0) { quote = c; continue }
    if (c === '{' || c === '[') { stack.push({ i, c }); continue }
    if (c === '}' || c === ']') {
      const top = stack.pop()
      if (!top) continue
      if ((c === '}' && top.c !== '{') || (c === ']' && top.c !== '[')) { stack.length = 0; continue }
      const span = { start: top.i, end: i + 1 }
      if (span.end - span.start <= maxLen) spans.push(span)
    }
  }
  return spans
}

/** 严格 JSON 不行时，容忍单引号 / 无引号 key / Python 的 True/False/None（模型常这么写调用）。 */
function parseJsonLoose (text) {
  try { return JSON.parse(text) } catch (error) {}
  let t = String(text)
  t = t.replace(/'((?:[^'\\]|\\.)*)'/g, (m, inner) => JSON.stringify(inner.replace(/\\'/g, "'")))
  t = t.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null')
  t = t.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
  try { return JSON.parse(t) } catch (error) { return null }
}

function isToolCallValue (v) {
  const toolName = (name) => typeof name === 'string' && /^[a-z][a-z0-9_.:-]*$/i.test(name)
  const isCall = (x) => x && typeof x === 'object' && !Array.isArray(x) && (
    (toolName(x.name) && Object.hasOwn(x, 'arguments') && Object.keys(x).every((k) => ['name', 'arguments', 'id', 'type'].includes(k))) ||
    (x.type === 'tool_use' && toolName(x.name) && Object.hasOwn(x, 'input')) ||
    (x.type === 'function' && isCall(x.function)) || isCall(x.function_call) ||
    (x.functionCall && toolName(x.functionCall.name) && Object.hasOwn(x.functionCall, 'args')) ||
    (Array.isArray(x.tool_calls) && x.tool_calls.length && x.tool_calls.every(isCall))
  )
  return Boolean(isCall(v)) || Boolean(Array.isArray(v) && v.length && v.every(isCall))
}

/** 解释/示例语境里，代码块或示例里的工具写法保留；其余照旧删除。 */
function rangeExempt (range, { explain, code, ownerPrivate, raw }) {
  const inCode = insideCode(code, range.start, range.end)
  const fenceOnly = /^\s*```[\s\S]*```\s*$/.test(raw)
  if (range.kind === 'tag') {
    if (inCode && (explain || (ownerPrivate && !fenceOnly))) return true
    // 解释句里提到的单个标签名（「在提示词里写 <invoke> 会怎样」）不当调用删
    if (!range.paired && explain && !inCode) return true
    return false
  }
  if (range.kind === 'json') return inCode ? (explain || (ownerPrivate && !fenceOnly)) : (explain && ownerPrivate)
  if (range.kind === 'generic') return inCode && (explain || ownerPrivate)
  if (range.kind === 'thinking') return inCode
  return false
}


/** 无标记思考的保守清洗：只删明确的思考标签/括号段、带元信息的标签行，以及「最终回答」前的推理开场。 */
function thinkingTextRanges (raw) {
  const found = []
  const add = (start, end) => { if (end > start) found.push({ start, end, kind: 'thinking', paired: true }) }

  // 【思考】…【/思考】、[analysis]…[/analysis] 这类显式块
  for (const m of raw.matchAll(/(?:【|\[)\s*(?:思考|分析|推理|内心|思路|thinking|analysis|reasoning)\s*(?:】|\])[\s\S]*?(?:【|\[)\s*\/\s*(?:思考|分析|推理|内心|思路|thinking|analysis|reasoning)\s*(?:】|\])/gi)) add(m.index, m.index + m[0].length)

  // （思考：…）/（分析：…）这类括号内心段
  for (const m of raw.matchAll(/[（(]\s*(?:思考|分析|推理|内心活动)\s*[：:][\s\S]{0,2000}?[）)]/g)) add(m.index, m.index + m[0].length)

  // 单独成行的「思考过程：/分析：…」；只在带元信息时删，避免误伤正常回答里的“分析：这个方案…”
  for (const m of raw.matchAll(/(^|\n)([ \t]*(?:\*\*)?(?:思考过程|分析过程|推理过程|思考|分析|推理|内心活动|内心|思路|回复策略|回答策略|意图分析|用户意图)\s*[：:][^\n]*)(?=\n|$)/g)) {
    const line = m[2]
    if (/(?:用户|对方|她|他|我|需要|先|然后|回复|回答|意图|情绪|场景|判断|想)/.test(line)) add(m.index + m[1].length, m.index + m[0].length)
  }

  // 结构化推理开场 + 「最终回答：」：只保留最终回答，前面有明确元信息才触发
  const final = /(?:^|\n)[ \t]*(?:最终回答|最终回复|最终答复|回复用户|答复)\s*[：:][ \t]*/i.exec(raw)
  if (final && final.index > 0) {
    const prefix = raw.slice(0, final.index)
    if (/(?:用户|对方|提问者|需要|让我|首先|接下来|分析|判断|回复|回答)/.test(prefix)) add(0, final.index + final[0].length)
  }

  // 「用户说…」+ 空行 + 正文：把纯推理开场段落去掉
  const meta = /^\s*(?:用户|对方|提问者)(?:说|问|想|希望|要求)[\s\S]{0,300}?(?:。|！|？)\s*\n\s*\n/.exec(raw)
  if (meta) add(0, meta[0].length)

  return found
}

/** 成对调用连同参数一起去掉；孤立开/闭标签、缺少 > 的尾片只去标记，保留旁边的正常话。 */
function toolTextRanges (raw, { ownerPrivate = false } = {}) {
  const found = [] // { start, end, kind, paired }
  // 1) 协议标签：成对的连同中间参数一起删，孤立的只删标记；未闭合的内部推理整段吞掉
  const stack = []
  for (const match of raw.matchAll(/[<＜][^<>＜＞]*(?:[>＞]|(?=[<＜])|$)/g)) {
    const tag = toolTag(match[0])
    if (!tag) continue
    const range = { start: match.index, end: match.index + match[0].length, kind: 'tag', paired: false }
    found.push(range)
    if (tag.closing) {
      let hit = -1
      for (let i = stack.length - 1; i >= 0; i--) if (stack[i].key === tag.key) { hit = i; break }
      if (hit !== -1) {
        found.push({ start: stack[hit].start, end: range.end, kind: 'tag', paired: true })
        stack.splice(hit)
      }
    } else if (/[>＞]$/.test(match[0]) && !/[\/／]\s*[>＞]$/.test(match[0])) {
      stack.push({ key: tag.key, start: range.start })
    }
  }
  for (const open of stack) if (open.key === 'thinking') found.push({ start: open.start, end: raw.length, kind: 'tag', paired: true })

  // 2) JSON 调用对象：单次线性括号扫描 + 长度/预算上限，避免 O(n²)
  const budget = { chars: 300_000, parses: 400 }
  const parsed = []
  for (const span of balancedSpans(raw, 8000).sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (parsed.some((r) => span.start >= r.start && span.end <= r.end)) continue
    const slice = raw.slice(span.start, span.end)
    if (!/(?:name|arguments|tool_use|function_call|functionCall|tool_calls|input)/.test(slice)) continue
    if (budget.chars < slice.length || budget.parses <= 0) break
    budget.chars -= slice.length
    budget.parses--
    if (!isToolCallValue(parseJsonLoose(slice))) continue
    found.push({ start: span.start, end: span.end, kind: 'json', paired: true })
    parsed.push(span)
  }

  // 3) 只拦整段都是「调用工具 xxx(参数)」的输出，讨论工具的正常句子保留。
  const invocation = stripMarkdown(raw)
    .replace(/<\/?(?:voice|reply|at)\b[^>]*>/gi, '').replace(/\|\|\|/g, '').trim()
    .replace(/^[「“"']+|[」”"']+$/g, '')
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  const call = /^调用工具\s*[a-z][a-z0-9_.:-]*\s*\(/i.exec(invocation)
  if (call) {
    let depth = 1, quote = '', escaped = false
    for (let i = call[0].length; i < invocation.length; i++) {
      const c = invocation[i]
      if (quote) {
        if (escaped) escaped = false
        else if (c === '\\') escaped = true
        else if (c === quote) quote = ''
      } else if (c === '"' || c === "'") quote = c
      else if (c === '(') depth++
      else if (c === ')' && --depth === 0) {
        if (/^[。.!！]?$/.test(invocation.slice(i + 1).trim())) found.push({ start: 0, end: raw.length, kind: 'natural', paired: true })
        break
      }
    }
  }

  // 4) 通用下划线标签：只认 tool/param/invoke 类名（<x_1>、<snake_case> 这类正常文字不删）
  // 只认协议类名和本插件已知的工具名前缀（qq_/bili_/...），避免 <x_1>、<snake_case> 这类正常文字被误删。
  for (const match of raw.matchAll(/[<＜]\s*[\/／]?\s*(?:tool|function|invoke|param(?:eter)?|antml|dsml|arguments?|call|outputs?|results?|observations?|qq|bili|qzone|song|pet|memory|mood|sticker|diary|video|voice|contact|profile|purpose|speak|draw|image|send|get|set)[_:\s]+[a-z0-9_]+["＂]?\s*[>＞]/gi)) {
    if (toolTag(match[0])) continue // 已知协议标签已单独处理，这里只补通用下划线形式
    found.push({ start: match.index, end: match.index + match[0].length, kind: 'generic', paired: false })
  }

  found.push(...thinkingTextRanges(raw))

  // 5) 解释/示例语境豁免
  const explain = EXPLAIN_CONTEXT.test(raw)
  const code = codeRanges(raw)
  const ranges = found
    .filter((range) => !rangeExempt(range, { explain, code, ownerPrivate, raw }))
    .map(({ start, end }) => ({ start, end }))

  // 删除只包着调用的代码围栏，避免 JSON 被删后留下 ```json 发出去。
  for (const m of raw.matchAll(/```[a-z0-9_-]*\s*\n?([\s\S]*?)```/gi)) {
    const start = m.index + m[0].indexOf(m[1])
    if (ranges.some((r) => r.start >= start && r.end <= start + m[1].length) && !withoutToolRanges(raw, ranges.sort((a, b) => a.start - b.start || b.end - a.end), start, start + m[1].length).trim()) ranges.push({ start: m.index, end: m.index + m[0].length })
  }
  return ranges.sort((a, b) => a.start - b.start || b.end - a.end)
}

function withoutToolRanges(raw, ranges, start = 0, end = raw.length) {
  let clean = '', last = start
  for (const range of ranges) {
    if (range.end <= last) continue
    if (range.start >= end) break
    if (range.start > last) clean += raw.slice(last, range.start)
    last = Math.min(end, range.end)
  }
  return clean + raw.slice(last, end)
}

/** 合并区间：排序后重叠/相接的合成一段，避免同一段文字被删两次。 */
function mergeRanges (ranges) {
  const out = []
  for (const r of [...ranges].sort((a, b) => a.start - b.start || b.end - a.end)) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end)
    else out.push({ start: r.start, end: r.end })
  }
  return out
}

export function stripToolText(text) {
  const raw = String(text || '')
  return withoutToolRanges(raw, toolTextRanges(raw))
}

function visibleContent(text) {
  const content = stripMarkdown(text)
    .replace(/<\/?(?:voice|reply|at|poke|sticker|face|state)\b[^>]*>/gi, '')
    .replace(/[@＠][^\s@＠<>|｜]+/g, '')
    .replace(/\|\|\|/g, '')
    .trim()
  return isSilence(content) ? '' : content.replace(/^[\s\p{P}]*|[\s\p{P}]*$/gu, '').trim()
}

/** 所有投递路径共用这一份清洗，区间也交给消息段出口使用。 */
export function cleanOutboundText(text, { warn, promptSources, fingerprint, userText, ownerPrivate = false, allowPromptEcho = false, onPromptDecision, onRanges } = {}) {
  const active = currentPromptSources()
  const sources = promptSources ?? [...(active?.system.values() || []), active?.context || '', ...(active?.memory || [])]
  const raw = String(text || '')
  // 先剥 HTML 残片：它们和工具调用、提示词复读互不重叠，按原文坐标并进同一份区间表。
  const { cuts: htmlCuts } = stripHtmlFragments(raw)
  // 假媒体动作（「（图片发出）」「（拍了一张新的）」）是纯文字描写，按原文坐标并进同一份区间表。
  const mediaCuts = fakeMediaActionRanges(raw)
  // time-context 注入不是提示词复读，主人私聊的复读豁免不该放过它，这里直接并进必删区间。
  const toolRanges = toolTextRanges(raw, { ownerPrivate })
  const contextRanges = contextInjectionRanges(raw)
  // 沉默标记也按区间删：turn/end 之外（空间说说、模块代发等）同样不能把标记当正文发出去。
  const silence = silenceMarkRanges(raw)
  const stateRanges = stateTagRanges(raw)
  // 模型自己编的格式化聊天记录同样不是提示词复读，按整行删除，避免冒充「对方发言」。
  const recordRanges = [...chatRecordRanges(raw), ...memoryTranscriptRanges(raw)]
  const pokeRanges = pokeCloseTagRanges(raw)
  const memoRanges = memoLeakRanges(raw)
  // ACP 协议标记（DSH 上下文代理的传输层包装）被模型复述时漏进正文：
  // 这是所有出站口的**公共必经点**，放这里一次就覆盖 deliver / sendText / sendSegments / 语音 /
  // 模块快捷 API 全部出口，不必在每个出口各写一遍。
  const acpRanges = acpLeakRanges(raw)
  // 图片句柄与真实附件路径（#518）同样在这一层一次收干净。
  const imageRanges = imageHandleRanges(raw)
  const noiseCount = toolRanges.length + contextRanges.length + htmlCuts.length + acpRanges.length + imageRanges.length
  const tools = [...toolRanges, ...contextRanges, ...silence, ...stateRanges, ...recordRanges, ...pokeRanges, ...memoRanges, ...acpRanges, ...imageRanges]
    .sort((a, b) => a.start - b.start || b.end - a.end)
  const baseRanges = mergeRanges([...tools, ...htmlCuts, ...mediaCuts])
  const toolClean = withoutToolRanges(raw, baseRanges)
  const prompts = (allowPromptEcho ? [] : promptTextRanges(toolClean, fingerprint || promptFingerprint(sources, userText ?? active?.userText ?? '')))
    .sort((a, b) => a.start - b.start || b.end - a.end)
  const promptClean = withoutToolRanges(toolClean, prompts)
  // 主人问设定时保留带解释的完整回答，仅整条复读才拦。
  const removePrompts = prompts.length && (!ownerPrivate || isSilence(visibleContent(promptClean)))
  onPromptDecision?.(Boolean(ownerPrivate && prompts.length && !removePrompts))
  let ranges = baseRanges
  if (removePrompts) {
    // 将清洗后的坐标映射回原消息，防止跨文字段或工具与复读混排时错删。
    const offsets = []
    let r = 0
    for (let i = 0; i < raw.length; i++) {
      while (r < baseRanges.length && baseRanges[r].end <= i) r++
      if (r < baseRanges.length && baseRanges[r].start <= i) continue
      offsets.push(i)
    }
    ranges = mergeRanges([...baseRanges, ...prompts.map((p) => ({ start: offsets[p.start], end: offsets[p.end - 1] + 1 }))])
  }
  let clean = withoutToolRanges(raw, ranges)
  // 只有沉默标记/state 标签/中文时间注入/伪造聊天记录/poke 闭合标签/假媒体动作时按正常沉默或内部残留处理，不要误报成工具调用或提示词复读。
  const fakeMediaOnly = mediaCuts.length > 0 && isSilence(visibleContent(withoutToolRanges(raw, mediaCuts)))
  if ((noiseCount > 0 || removePrompts || fakeMediaOnly) && isSilence(visibleContent(clean))) {
    warn?.(removePrompts ? '模型输出整段都是提示词复读，已拦下并按沉默处理'
      : fakeMediaOnly ? '模型输出整段都是假媒体动作，已拦下并按沉默处理'
        : '模型输出整段都是工具调用文字，已拦下并按沉默处理')
    clean = ''
  }
  onRanges?.(ranges)
  // 出站统一兜底：正文标记本身不能发出去。turn/end 已经解析过标记，
  // 但空间说说、B 站评论、命令回复这些不走 turn/end 的出口也要剥一次（没有标记时原样返回）。
  return stripMarkers(clean)
}

/** 出站正文上限：模型失控时（2026-11-13 08:02 一次吐出 48263 字「在吗」）别把整段原样甩给 OneBot。 */
export const MAX_OUTBOUND_CHARS = 1500

/** 超过上限就把文字段按顺序截断，引用/@/媒体段原样保留。 */
export function capOutboundSegments (message, max = MAX_OUTBOUND_CHARS) {
  const total = message.filter((seg) => seg.type === 'text').reduce((n, seg) => n + String(seg.data?.text || '').length, 0)
  if (total <= max) return { message, trimmed: false, total }
  let left = max
  const out = []
  for (const seg of message) {
    if (seg.type !== 'text') { out.push(seg); continue }
    if (left <= 0) continue
    const text = String(seg.data?.text || '')
    const keep = text.slice(0, left)
    left -= keep.length
    if (keep) out.push({ ...seg, data: { ...seg.data, text: keep } })
  }
  if (!out.some((seg) => seg.type === 'text')) return { message: [], trimmed: true, total }
  return { message: out, trimmed: true, total }
}

/** 最终平台出口：合并检查整条消息的文字段，避免调用被拆段绕过；引用、@ 和媒体段原样保留。 */
export function cleanOutboundSegments(message, options) {
  const texts = message.filter((seg) => seg.type === 'text')
  if (!texts.length) return message
  // 相邻 text 段直接拼；中间隔着 image / at / reply 时插入换行当段边界。
  // 假媒体动作的括号正则不跨换行，所以「（图片」+ 真图 +「发出）」不会被拼成假动作；
  // 工具调用/提示词等其它清洗仍允许跨段识别（它们本来就可能在多个 text 段里被拆开）。
  let raw = ''
  const spans = []
  let prevText = false
  for (const seg of message) {
    if (seg.type !== 'text') { prevText = false; continue }
    if (raw && !prevText) raw += '\n'
    const start = raw.length
    const value = String(seg.data?.text || '')
    raw += value
    spans.push({ seg, start, end: start + value.length })
    prevText = true
  }
  let ranges
  const clean = cleanOutboundText(raw, { ...options, onRanges: (value) => { ranges = value } })
  if (clean === raw) return message
  const result = []
  let spanIndex = 0
  for (const seg of message) {
    if (seg.type !== 'text') { result.push(seg); continue }
    const span = spans[spanIndex++]
    const value = clean ? withoutToolRanges(raw, ranges, span.start, span.end) : ''
    if (value) result.push({ ...seg, data: { ...seg.data, text: value } })
  }
  // 只剩引用和 @ 不能单独发，尤其是自动 @ 后面只跟着一个结束标记时。
  return result.some((seg) => seg.type === 'text' ? seg.data.text.trim() : !['reply', 'at'].includes(seg.type)) ? result : []
}

/** 模型偶尔把协议标签写成中文参数语法（<参数 name="sticker">名字<参数>）；转成可解析标签。 */
function normalizeParamTags (text) {
  return String(text || '').replace(/[<＜]\s*参数\s+name\s*=\s*["'“”]?\s*(sticker|voice|poke)\s*["'“”]?\s*[>＞]([\s\S]*?)[<＜]\s*\/?\s*参数\s*[>＞]/gi, (match, name, body) => {
    if (name.toLowerCase() === 'sticker') return `<sticker:${body.trim()}>`
    if (name.toLowerCase() === 'voice') return `<voice>${body.trim()}</voice>`
    return '<poke>'
  })
}

/** 完整语音块中的分条标记作为停顿，不能先拆断标签；代码示例和嵌套标签不改写。 */
function joinVoiceBubbles(text) {
  return text.replace(/```[\s\S]*?```|`[^`\n]+`|<voice>([\s\S]*?)<\/voice>/g, (block, speech) => {
    if (speech === undefined || /<\/?voice\b/i.test(speech)) return block
    return `<voice>${speech.replace(/\|{3,}/g, '\n')}</voice>`
  })
}

/** 解析一轮回复；在拆气泡/语音前清洗，避免协议里的竖线被误作气泡分隔符。 */
export function parseReply(text, options) {
  const original = String(text || '')
  const quotedCode = codeRanges(original)
  // Repair a model's missing '<' only at a bubble/line prefix; preserve code examples.
  const repaired = original.replace(/(^|\n|\|{3,})([ \t]*)\/reply:\s*(\d+)\s*>/gi, (tag, boundary, space, id, offset) =>
    insideCode(quotedCode, offset + boundary.length, offset + tag.length) ? tag : `${boundary}${space}<reply:${id}>`)

  // 模型偶尔把「戳人」写成方括号动作（[戳了戳你：尾巴往回一收]），插件不认这种写法，
  // 会原样当文字发出去。这里统一转成 <poke>，让戳一戳变成真的系统动作。
  // 模型偶尔写中文参数标签 <参数 name="sticker">…<参数>，同样在解析前归一成协议标签。
  const forwarded = normalizeParamTags(repaired).replace(/[[【]\s*戳了戳(?:你|他|她)?[^\]】]*[\]】]/g, '<poke>')
  // 模型偶尔把换行写成 HTML `<br>`：当真正的换行处理；代码示例里的字面量保留。
  const cleaned = stripModelArtifacts(cleanOutboundText(forwarded, options))
  const code = codeRanges(cleaned)
  const raw = cleaned.replace(/<br\s*\/?>/gi, (tag, offset) => insideCode(code, offset, offset + tag.length) ? tag : '\n').trim()
  if (isSilence(raw)) return { silent: true, items: [] }
  // 工具显式指定语音：仍经过同一份清洗，但正文不再当作媒体/气泡指令解析。
  if (options?.voice === true) {
    const value = stripSilenceMarks(stripMarkdown(tidyPunctuation(raw)))
    return { silent: !value, items: value ? [{ kind: 'voice', value }] : [] }
  }
  const items = []
  let replyTo = '' // 等着挂到下一条气泡上的「引用回复」编号
  const attach = (from) => {
    if (replyTo && items.length > from) {
      items[from].replyTo = replyTo
      replyTo = ''
    }
  }
  // 连续多写的竖线仍是同一个分隔符，避免 |||| 拆完残留一条 | 消息。
  for (const bubble of joinVoiceBubbles(raw).split(/\|{3,}/)) {
    const part = bubble.trim()
    if (!part) continue
    // 依次切出 poke / reply / voice / sticker / markdown 图片，其余是文字
    const re = /<poke\s*\/?>|<\/poke\s*>|<reply:\s*(\d+)\s*>|<voice>([\s\S]*?)<\/voice>|<sticker:([^>]+?)>(?:\s*<\/sticker>)?|!\[[^\]]*\]\(\s*([^)\s]+)\s*\)|\[表情[:：]\s*([^\]\n]+?)\s*\]/g
    let last = 0
    let m
    while ((m = re.exec(part)) !== null) {
      let from = items.length
      pushText(items, part.slice(last, m.index))
      attach(from)
      from = items.length
      if (m[0].startsWith('<poke')) {
        if (!items.some((i) => i.kind === 'poke')) items.push({ kind: 'poke', value: '' })
      } else if (m[1] !== undefined) {
        replyTo = m[1]
      } else if (m[2] !== undefined) {
        const v = stripSilenceMarks(stripMarkdown(tidyPunctuation(m[2])))
        if (v) items.push({ kind: 'voice', value: v })
      } else if (m[3] !== undefined) {
        const v = m[3].trim()
        if (v) items.push({ kind: 'sticker', value: v })
      } else if (m[4] !== undefined) {
        items.push({ kind: 'image', value: m[4] })
      } else if (m[5] !== undefined) {
        // 模型常写成「[表情: 无语死鱼脸]」而不是 <sticker:…>：按表情名尝试匹配，匹配不到宁可不发，也不能把描述当文字发出去。
        const v = m[5].trim()
        if (v) items.push({ kind: 'sticker', value: v })
      }
      attach(from)
      last = re.lastIndex
    }
    const from = items.length
    pushText(items, part.slice(last))
    attach(from)
  }
  // 一轮最多引用一次，多的去掉（大多数时候正常发就好）
  let quoted = false
  for (const it of items) {
    if (!it.replyTo) continue
    if (quoted) delete it.replyTo
    quoted = true
  }
  if (items.length === 0) return { silent: true, items: [] }
  return { silent: false, items: capBubbles(items) }
}

const MAX_BUBBLES = 5

/** 优先合并靠后的相邻文字，尽量收在 5 条内。媒体和新的引用各自保留位置。 */
function capBubbles(items) {
  let excess = items.filter(item => item.kind === 'text').length - MAX_BUBBLES
  if (excess <= 0) return items

  // 从后往前挑可以合并的边界，纯文字仍然先保留前四条。
  const joinPrevious = new Set()
  for (let i = items.length - 1; i > 0 && excess > 0; i--) {
    if (items[i].kind === 'text' && !items[i].replyTo && items[i - 1].kind === 'text') {
      joinPrevious.add(i)
      excess--
    }
  }
  const out = []
  for (let i = 0; i < items.length; i++) {
    const first = items[i]
    if (!joinPrevious.has(i + 1)) { out.push(first); continue }
    const lines = [first.value]
    while (joinPrevious.has(i + 1)) lines.push(items[++i].value)
    out.push({ ...first, value: lines.join('\n') })
  }
  return out
}

/**
 * 一段文字拆成几条气泡：真人打字是一行一条发出去的。
 * 有代码块、或者是长篇内容（比如帮主人查东西的结果）就整段发，不拆。
 */
export function splitLines(text) {
  const t = String(text || '').trim()
  if (!t) return []
  if (t.includes('```') || t.length > 240) return [t]
  const lines = t.split(/\n+/).map((s) => s.trim()).filter(Boolean)
  if (lines.length <= 1) return lines
  // 像列表 / 步骤的多行内容（一大半以数字或符号开头）也整段发
  const listy = lines.filter((l) => /^(\d+[.、)]|[-*•·])/.test(l)).length
  if (listy >= Math.ceil(lines.length / 2)) return [t]
  return lines
}

/**
 * 把这一轮真发出去的东西写成一行（聊天流水、记忆、下次交给她时「我说过什么」都看这行）。
 * 表情必须留名字：只写 `[sticker]` 的话，她事后认不出自己发的是哪一张——
 * 被说「乱贴表情」时连自查都做不到。
 */
export function itemsToLine(items, resolveSticker = () => null) {
  return (items || [])
    .map((i) => {
      if (!i) return ''
      if (i.kind === 'text' || i.kind === 'voice') return String(i.value ?? '')
      if (i.kind === 'sticker') {
        const item = i.value && typeof i.value === 'object' ? i.value : resolveSticker(i.value)
        const name = item?.name || (item?.md5 ? String(item.md5).slice(0, 8) : '')
        return name ? `[表情：${name}]` : '[表情]'
      }
      return `[${i.kind}]`
    })
    .filter((s) => s !== '')
    .join(' ')
}

function pushText(items, s) {
  // 写坏的引用标签直接去掉；混在正文里的沉默标记也全部剥掉，整行只剩标记时按沉默跳过。
  const raw = String(s || '').replace(/<\/?reply[^>]*>/g, '')
  const t = stripSilenceMarks(stripMarkdown(tidyPunctuation(raw)))
  if (!t || isSilence(t)) return
  // 代码块在 stripMarkdown 之后围栏就没了，必须在原文里先判断，整段保留不拆行。
  const lines = /```|~~~/.test(raw) ? [t] : splitLines(t)
  for (const line of lines) if (!isSilence(line)) items.push({ kind: 'text', value: line })
}

/** 对方是不是明确要她发语音（「用语音说」「发个语音」「语音回我」……）。 */
export function wantsVoice(text) {
  const t = String(text || '')
  if (t.includes('不要语音') || t.includes('别发语音')) return false
  return /(用|发|来|给我|录)[^，。？！\n]{0,4}语音|语音[^，。？！\n]{0,4}(说|发|讲|回|念|唱)/.test(t)
}

/**
 * 发下一条之前停多久（毫秒）：按「打字速度」算——下一条越长停越久，再加一点随机抖动。
 * @param {string} [next] 下一条要发的内容
 */
export function bubbleDelay(next = '', rand = Math.random) {
  if (typeof next === 'function') { rand = next; next = '' }
  const len = String(next || '').length
  const typing = 350 + len * 110 // 大约每秒 9 个字
  return Math.round(Math.min(4500, Math.max(700, typing)) * (0.8 + rand() * 0.5))
}
