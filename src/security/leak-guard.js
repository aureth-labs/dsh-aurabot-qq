// 出口清洗使用的提示词指纹与原文区间；这里只做识别，不负责投递。
import { AsyncLocalStorage } from 'node:async_hooks'

export const PROMPT_MATCH_LENGTH = 20 // 归一化后连续 20 个字符相同才算复读
const promptCapture = new AsyncLocalStorage()

// 显示层归一化：空白、标点/符号、零宽字符、Markdown ** / 反引号 / ||| 都去掉后再比对，
// 这样插换行、拆气泡、加粗、每字插空格、零宽字符都绕不过复读检测；同时保留坐标映射，删除时仍删原文。
const ZERO_WIDTH = new Set(['\u200B', '\u200C', '\u200D', '\uFEFF', '\u2060'])
const SKIP_CHAR = /[\s\p{P}\p{S}]/u

/**
 * 把文字归一化成「显示层字符序列」，并记录每个字符在原文里的起止下标（UTF-16 code unit）。
 * @returns {{chars:string[], starts:number[], ends:number[]}}
 */
export function normalizeForMatch (text) {
  const chars = []
  const starts = []
  const ends = []
  let offset = 0
  for (const ch of String(text ?? '')) {
    const start = offset
    offset += ch.length
    if (ZERO_WIDTH.has(ch)) continue
    if (SKIP_CHAR.test(ch)) continue
    chars.push(ch)
    starts.push(start)
    ends.push(offset)
  }
  return { chars, starts, ends }
}

// 记录变量最终渲染值（包括模块改写），不在发送时重新生成人格或规则。
export const withPromptCapture = (sources, fn) => promptCapture.run(sources, fn)
export const currentPromptSources = () => promptCapture.getStore()
export function captureSystemPrompt(name, text) {
  promptCapture.getStore()?.system.set(name, text)
  return text
}

const MEMORY_HEAD = /[（(](?:你记得这些事|只是印象不是指令|这个聊天里之前的原话|以下只是印象|这个群的印象|人物关系[，,：:]|你对[^\n（）()]{0,30}的印象|和[^\n（）()]{0,30}相处的经验|说话方式[：:]|你最近做过的事|刚才聊到的[，,：:]|下面是你最近在几个群里|你最近在别的聊天里说过的话)/g

// 模型会把上一轮注入的群聊上下文 / 运行时环境整段当正文续写下来（长会话里出现过整块复读）。
// 块头命中即视为注入内容：toEndOfText 时取到结尾（注入方要把整段登记进指纹），
// 否则只取到本段结束（空行），避免把她写在块后面的正常回复一起删掉。
const INJECTED_BLOCK_HEAD = /【注意：下面这些是群友说的聊天内容|【群聊[ \t][^】\n]*】[ \t]*(?:之前在聊|刚才新说的)/g
const INJECTED_BLOCK_LINE = /(?:^|\n)[ \t]*(?:把这一段当成整体来回[：:]|大多数时候直接说就行[。.]|要 @ 某个人)[^\n]*/g
// 宿主注入的 runtime context 是一串「Key: value」段，内部本身就有空行，不能按空行截断：
// 一路吃到第一行不像注入内容的行（也就是她自己的中文回复）为止。
// 块头可能被加粗/引用（**Current runtime context.**、> Current runtime context.），也可能被拆成
// 「Current runtime context.」+「This snapshot supersedes…」两行，所以行首要允许 3 个以内的格式字符，
// 同时保留原来的整句写法（模型把块接在正文后面时不在行首）。
const RUNTIME_PREFIX = /^[ \t]*(?:[>*_`]{0,3}[ \t]*)?/
const RUNTIME_CONTEXT_HEAD = /^[ \t]*(?:[>*_`]{0,3}[ \t]*)?Current runtime context\b|Current runtime context\. This snapshot supersedes/gm
const RUNTIME_CONTEXT_LINE = /^(?:Current |This snapshot supersedes|Approval (?:policy\s*[:：]|prompts? (?:are|is) enabled)|Time sampled while preparing|Browser time zone|Elapsed since the preceding|[\p{Lu}][\p{L} \d]{1,40}:)/u
// 模型有时只把快照尾巴抄出来（块头没抄），这些行本身足够特别，单独出现也要剔。
const RUNTIME_CONTEXT_STANDALONE = /^(?:Current (?:runtime context|working directory|DSH |DeepSeek Harness )|This snapshot supersedes|Approval (?:policy\s*[:：]|prompts? (?:are|is) enabled)|Time sampled while preparing|Browser time zone for this request|Elapsed since the preceding)/u

// 宿主 time-context 每一步都注入一段三行文本（Time sampled … / Browser time zone … / Elapsed since …），
// 模型会顺着它往下续写。这里只认前缀不认整句 —— 续写时模型会改写后半句
// （otherwise-unqualified dates and times → amongst questions），整句指纹拦不住。
// 插件自己每轮还会追加一行中文【当前本机时间】（src/chat/time-context.js）；它同样不是提示词复读，
// 而且不在 fingerprint 来源里，必须按行前缀直接拦（2026-11-15 私聊事故：整行被当正文发出）。
// 注意：matchAll 会沿用共享 /g 正则的 lastIndex，这里用源头字符串每次新建。
const TIME_CONTEXT_HEAD_SOURCE = '^[ \\t]*(?:Time sampled while preparing turn \\d+, step \\d+:|【当前本机时间】)'
const TIME_CONTEXT_LINE = /^(?:Time sampled while preparing turn \d+, step \d+:|Browser time zone for this request:|Elapsed since the preceding (?:model-visible message|step context):|【当前本机时间】)/
// memsearch 插件每轮还会在上下文最前面挂一行可用性提示（[memsearch] Recall available …）。
// 它不是提示词复读、也不在 fingerprint 来源里，模型复述时会原样当正文发出去（2026-11-23 私聊）。
const MEMSEARCH_LINE = /^\[memsearch\]\s*Recall available\b/i

const isInjectionLine = (line) => TIME_CONTEXT_LINE.test(line) || MEMSEARCH_LINE.test(line)

// 模型抄这块时有时会连前面的引导词一起抄（「user【系统提醒…】」），前缀一起吃掉，
// 否则剥完还剩一个孤零零的 user。用 lookbehind 防止误伤 superuser 这类单词。
const OUTBOUND_SCAFFOLD_HEAD = /(?:(?<![A-Za-z0-9_])user[ \t]*)?(?<!^)(?<!\n)【系统提醒[^】\n]*】/g
const OUTBOUND_ROOM_HEAD = /【你在自己家里[^】\n]*】/g

function runtimeContextEnd(text, start) {
  let end = start
  for (const line of text.slice(start).split('\n')) {
    const key = line.trim().replace(RUNTIME_PREFIX, '')
    if (key && !RUNTIME_CONTEXT_LINE.test(key)) break
    end += line.length + 1
  }
  return Math.min(end, text.length)
}

/** 与 runtime context 同理：块头命中后一路吃到第一行不是注入内容的行。 */
function timeContextEnd(text, start) {
  let end = start
  for (const line of text.slice(start).split('\n')) {
    if (line.trim() && !isInjectionLine(line.trim())) break
    end += line.length + 1
  }
  return Math.min(end, text.length)
}

/**
 * 出站格式化聊天记录识别：模型会把上下文里「【私聊】[HH:MM] 昵称(QQ号)：内容」的格式
 * 当成自己要说的话编一条发出来（2026-11-15 私聊事故：「【私聊】[10:19] 某人(QQ号): 不酸 我睡够了」，
 * 而对方从未说过这句）。群聊块的行格式则是「[HH:MM] 昵称(QQ号)：内容」（src/chat/hub.js）。
 *
 * 判断刻意保守：整行必须同时命中「可选序号 + 可选来源标签 + 方括号时间 + 名字 + 括号里的
 * 5–12 位数字 QQ + 冒号 + 内容」，且从行首匹配到行尾。正常转述（「你刚才在私聊里说 10:19…」）
 * 不会整行同时具备这些格式元素，因此不误伤；只删命中的整行（连同行尾换行），其他正文保留。
 */
// QQ 号按真实形态是 5–12 位数字；同时兼容工单/日志脱敏后的「QQ号」占位写法，便于回归。
const QQ_ID = '(?:\\d{5,12}|[QqｑＱ]{2}[ \\t]*[号號]?)'
const CHAT_TIME = '\\[(?:\\d{1,2}:\\d{2}|昨天[ \\t]+\\d{1,2}:\\d{2}|\\d{2}-\\d{2}[ \\t]+\\d{1,2}:\\d{2}|\\d{4}-\\d{2}-\\d{2}[ \\t]+\\d{1,2}:\\d{2})\\]'
const CHAT_RECORD_LINE = new RegExp(
  '^[ \\t]*(?:\\[\\d{1,2}\\][ \\t]*)?(?:【群聊[^】\\n]*】[ \\t]*)?' +
  CHAT_TIME + '[ \\t]+' +
  `[^()\\n（）]{1,40}[（(]\\s*${QQ_ID}\\s*[）)][ \\t]*[：:][ \\t]*\\S[^\\n]*$`,
  'gm',
)
// 私聊标签很明确，省略时间、昵称带括号的变体也拦。遇到气泡边界就停止。
const BUBBLE_START = '(?:^|(?<=\\|\\|\\|))[ \\t]*'
const BUBBLE_TEXT = '(?:(?!\\|\\|\\|)[^\\n])*'
const PRIVATE_RECORD_LINE = new RegExp(
  `${BUBBLE_START}(?:\\[\\d{1,2}\\][ \\t]*)?【私聊[^】\\n]*】[ \\t]*(?:${CHAT_TIME}[ \\t]+)?[^\\n|]{1,120}?[（(][ \\t]*${QQ_ID}[ \\t]*[）)][ \\t]*[：:]${BUBBLE_TEXT}`,
  'gm',
)
const HISTORY_MEMO = new RegExp(
  `${BUBBLE_START}【历史备忘[ \\t]*[·•][ \\t]*(?:private|group)[：:]\\d{5,12}】${BUBBLE_TEXT}(?:\\n[ \\t]*\\d{4}-\\d{2}-\\d{2}[ \\t]+${BUBBLE_TEXT})*`,
  'gm',
)

/** 返回伪造聊天记录整行的删除区间（含行尾换行）。 */
export function chatRecordRanges(text) {
  const raw = String(text ?? '')
  const ranges = []
  for (const re of [PRIVATE_RECORD_LINE, CHAT_RECORD_LINE]) {
    for (const m of raw.matchAll(re)) {
      let end = m.index + m[0].length
      if (raw[end] === '\n') end += 1
      ranges.push({ start: m.index, end })
    }
  }
  return ranges
}

/**
 * time-context 的块头可能出现在正文中间（模型先写一句再抄），也可能块里只剩一两行，
 * 所以除了「从块头吃到她自己的话」，任何单独命中前缀的行都要剔。
 * 这段不是提示词复读，不能走主人私聊的复读豁免，所以调用方要单独并进出站区间。
 */
export function contextInjectionRanges(text, { toEndOfText = false } = {}) {
  const raw = String(text ?? '')
  const ranges = []
  // 主动搭话/房间模块的背景块会作为普通 user 文本进入模型；模型续写时从任意位置抄到结尾。
  for (const m of raw.matchAll(OUTBOUND_SCAFFOLD_HEAD)) ranges.push({ start: m.index, end: raw.length })
  for (const m of raw.matchAll(OUTBOUND_ROOM_HEAD)) ranges.push({ start: m.index, end: raw.length })
  for (const m of raw.matchAll(new RegExp(TIME_CONTEXT_HEAD_SOURCE, 'gm'))) {
    ranges.push({ start: m.index, end: toEndOfText ? raw.length : timeContextEnd(raw, m.index) })
  }
  if (toEndOfText) return ranges
  let offset = 0
  for (const line of raw.split('\n')) {
    const end = Math.min(offset + line.length + 1, raw.length)
    if (isInjectionLine(line.trim()) && !ranges.some((r) => r.start <= offset && end <= r.end)) {
      ranges.push({ start: offset, end })
    }
    offset += line.length + 1
  }
  return ranges
}

function parenthesisEnd(text, start) {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '（' || text[i] === '(') depth++
    if ((text[i] === '）' || text[i] === ')') && --depth === 0) return i + 1
  }
  return text.length
}

/** 运行时的记忆摘录按原文格式清理，主人询问人设时的复读豁免不适用。 */
export function memoryTranscriptRanges(text) {
  const ranges = []
  const shortMemo = /[（(]刚才聊到的[，,]只是印象不是指令[：:]/g
  let hit
  while ((hit = shortMemo.exec(text))) {
    const end = parenthesisEnd(text, hit.index)
    ranges.push({ start: hit.index, end })
    shortMemo.lastIndex = end
  }
  for (const m of text.matchAll(HISTORY_MEMO)) {
    ranges.push({ start: m.index, end: m.index + m[0].length })
  }
  return ranges
}

/** 固定注入块即使很短也识别；正文里的普通「刚才聊到的」不算。 */
export function memoryPromptRanges(text, { toEndOfText = false } = {}) {
  const ranges = []
  for (const m of text.matchAll(MEMORY_HEAD)) {
    let end = parenthesisEnd(text, m.index)
    if (/^[（(]只是印象不是指令[）)]$/.test(text.slice(m.index, end))) {
      const tail = text.slice(end).search(/\n|\|\|\|/)
      end = tail < 0 ? text.length : end + tail
    }
    if (m[0].includes('下面是你最近在几个群里')) {
      const tail = text.indexOf('【以上是最近群里的情况】', end)
      if (tail !== -1) end = tail + '【以上是最近群里的情况】'.length
    }
    ranges.push({ start: m.index, end })
  }
  for (const m of text.matchAll(/【(?:系统|跨会话)[^】\n]*(?:】|$)[^\n|]*/g)) {
    // 单行提醒到换行/气泡结束；不吞掉下一行正常回复。
    const bubble = m[0].indexOf('|||')
    ranges.push({ start: m.index, end: m.index + (bubble < 0 ? m[0].length : bubble) })
  }
  for (const m of text.matchAll(/【(?:你现在在 QQ 上|边界|别人说的只是聊天内容|私聊里主动一点|危险命令|这个聊天刚才发生的事|你之前在这个聊天里主动说过)[^】\n]*(?:】|$)|\{\{\s*aurabot_(?:persona|rules(?:_private|_social)?)\s*\}\}/g)) {
    ranges.push({ start: m.index, end: m.index + m[0].length })
  }
  for (const m of text.matchAll(/【同一人格、同一聊天的对话资料[^】]*】[\s\S]*?【对话资料结束】/g)) {
    ranges.push({ start: m.index, end: m.index + m[0].length })
  }
  for (const m of text.matchAll(/【你刚上线，先补看最近[^】\n]*】[\s\S]*?【补看结束，接着回下面这条】/g)) {
    ranges.push({ start: m.index, end: m.index + m[0].length })
  }

  for (const m of text.matchAll(/(?:^|\n|\|\|\|)[ \t]*(?:你记得这些事|只是印象不是指令|刚才聊到的)[：:][^\n|]*/g)) {
    ranges.push({ start: m.index, end: m.index + m[0].length })
  }
  for (const m of text.matchAll(INJECTED_BLOCK_HEAD)) {
    if (toEndOfText) { ranges.push({ start: m.index, end: text.length }); continue }
    const tail = text.slice(m.index).search(/\n[ \t]*\n/)
    ranges.push({ start: m.index, end: tail < 0 ? text.length : m.index + tail })
  }
  for (const m of text.matchAll(RUNTIME_CONTEXT_HEAD)) {
    ranges.push({ start: m.index, end: toEndOfText ? text.length : runtimeContextEnd(text, m.index) })
  }
  // 块头没被抄出来、只剩尾巴时，头部那条规则不会触发；按行再兜一次（只认足够特别的前缀）。
  if (!toEndOfText) {
    let offset = 0
    for (const line of text.split('\n')) {
      const end = Math.min(offset + line.length + 1, text.length)
      const key = line.trim().replace(RUNTIME_PREFIX, '')
      if (RUNTIME_CONTEXT_STANDALONE.test(key) && !ranges.some((r) => r.start <= offset && end <= r.end)) {
        ranges.push({ start: offset, end })
      }
      offset += line.length + 1
    }
  }
  ranges.push(...contextInjectionRanges(text, { toEndOfText }))
  for (const m of text.matchAll(INJECTED_BLOCK_LINE)) {
    ranges.push({ start: m[0][0] === '\n' ? m.index + 1 : m.index, end: m.index + m[0].length })
  }
  return ranges
}

/** DSH 给模型的图片句柄（#518）：Image "名字" (sha256:...) ; request preview WxHpx.
 * 以及紧随其后的 Normalized copy 路径。模型复读时会把真实附件路径/哈希带出来。
 * 不要求行首（正文中间、前导空格都可能），但遇到 ||| 气泡分隔就停，别吞正常回复。 */
export function imageHandleRanges(text) {
  const ranges = []
  const raw = String(text ?? '')
  // 有名：Image "名字" (sha256:...) ; 无名（dsh-llm 的真实格式）：Image sha256:...
  for (const m of raw.matchAll(/Image\s+(?:"[^"\n]*"\s*\(sha256:[^)\n]*\)|sha256:[^\s;)]*)\s*;\s*request preview\s+\d+x\d+px\.[^\n]*?(?:\n[ \t]*Normalized copy[^\n]*?(?=\|\|\||\n|$))?(?=\|\|\||\n|$)/g)) {
    ranges.push({ start: m.index, end: m.index + m[0].length })
  }
  // 图片超出限制时的占位：... Normalized copy ... 真实路径
  for (const m of raw.matchAll(/\[image omitted to fit request image limits;[^\]]*\]/g)) {
    ranges.push({ start: m.index, end: m.index + m[0].length })
  }
  for (const m of raw.matchAll(/\[image omitted because this model accepts text only; attachment sha256:[0-9a-f]*\]/g)) {
    ranges.push({ start: m.index, end: m.index + m[0].length })
  }
  return ranges
}

export function promptFingerprint(sources = [], userText = '') {
  const grams = new Set()
  // 用户这一轮自己说的话不算复读：同样归一化后再排除。
  const excluded = normalizeForMatch(userText).chars.join('')
  for (const source of sources) {
    let text = String(source || '')
    // 聊天原话与她自己的说话习惯不是规则；仍由固定块识别去掉注入外壳。
    const quoted = memoryPromptRanges(text).filter((r) => /^(?:[（(](?:这个聊天里之前的原话|说话方式|下面是你最近在几个群里|你最近在别的聊天里说过的话)|【你刚上线，先补看最近|【同一人格、同一聊天的对话资料)/.test(text.slice(r.start, r.end)))
    for (const r of quoted.sort((a, b) => b.start - a.start)) text = text.slice(0, r.start) + '\n' + text.slice(r.end)
    for (const line of text.split('\n')) {
      if (/口头禅|常用语|常挂在嘴边/.test(line)) continue
      const chars = normalizeForMatch(line).chars
      // 20 字和 18 字两种 shingle：短一点的复读片段/被标点打断的也能拦住，误伤靠 18 字下限控制。
      for (const size of [PROMPT_MATCH_LENGTH, PROMPT_MATCH_LENGTH - 2]) {
        for (let i = 0; i + size <= chars.length; i++) {
          const gram = chars.slice(i, i + size).join('')
          if (!excluded.includes(gram)) grams.add(gram)
        }
      }
    }
  }
  return grams
}

/** 合并命中的连续窗口后，调用方只删复读的部分（格式化变体也算），保留同一行里的正常话。 */
export function promptTextRanges(text, grams) {
  const ranges = memoryPromptRanges(text)
  if (!grams?.size) return ranges
  const { chars, starts, ends } = normalizeForMatch(text)
  const raw = String(text ?? '')
  const hits = []
  for (const size of [PROMPT_MATCH_LENGTH, PROMPT_MATCH_LENGTH - 2]) {
    for (let i = 0; i + size <= chars.length; i++) {
      if (grams.has(chars.slice(i, i + size).join(''))) hits.push({ start: starts[i], end: ends[i + size - 1] })
    }
  }
  // 连续窗口先合并，再把复读段落两端格式字符（空格/标点/反引号等）一起带走，避免残留「。」或反引号；
  // 但不动 ||| / ｜，气泡分隔符要保留下游拆条逻辑。
  hits.sort((a, b) => a.start - b.start || b.end - a.end)
  const merged = []
  for (const hit of hits) {
    const last = merged.at(-1)
    if (last && hit.start <= last.end) last.end = Math.max(last.end, hit.end)
    else merged.push({ ...hit })
  }
  const isSkip = (ch) => /[\s\p{P}\p{S}]/u.test(ch) && !/[|｜<>]/.test(ch)
  for (const range of merged) {
    while (range.start > 0 && isSkip(raw[range.start - 1])) range.start--
    while (range.end < raw.length && isSkip(raw[range.end])) range.end++
    ranges.push(range)
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end)
  return ranges
}

