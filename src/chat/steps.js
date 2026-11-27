/**
 * 一轮里的多段正文。
 *
 * 上游现在的做法是「一轮只发最后一段」：模型一次回答被拆成多个 step 时（调了工具、或者人插话进来），
 * 前面的正文被后一段覆盖，永远发不出去（#205）。这在干活时是对的——前面多半是工具调用前后的过程话；
 * 但私聊里大多数时间是闲聊，连着说的几句可能各说各的，只发最后一段会让人以为「她只回了一个话题」。
 *
 * 这里两个补法，都默认关，由 chat.everyStep / chat.rescueFromThinking 控制：
 *   - takeInterim：每收到一段正文，就把「上一段」先发出去，最后一段照旧交给 turn/end。
 *     发的是上一段而不是当前段，是为了在不知道后面还有没有话的时候，不把最后一句提前发掉。
 *   - rescueFromThinking：整轮一段正文都没有时，从思考里捞出她自己写定的那段。
 */

/** 从一条 assistant 消息里取出思考文本（reasoning 块）。 */
export function reasoningOf(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((b) => b && b.type === 'reasoning' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

/**
 * 记下当前这段正文，返回「应该现在发出去的上一段」。
 *
 * 判据只有三条：同一轮、step 递增、内容不同。是不是被工具调用劈开的不管——开关本身就是「每段都发」，
 * 由用户自己选。跨轮不发（上一轮的最后一段已经由 turn/end 发过了），两段一模一样也不发（重复刷屏）。
 */
export function takeInterim(st, { turn, step, text }) {
  const said = String(text || '').trim()
  if (!said) return null
  const sameTurn = st.interimTurn === turn
  const laterStep = Number.isFinite(step) && (st.interimStep < 0 || step > st.interimStep)
  const prev = sameTurn && st.interimText && laterStep && st.interimText !== said ? st.interimText : null
  st.interimTurn = turn
  st.interimText = said
  st.interimStep = Number.isFinite(step) ? step : -1
  return prev
}

/**
 * 从思考里捞出定稿。
 *
 * 模型有时把要说的话全写在思考里（`Reply:` 起草 → `Careful:` 自检 → `N lines:` 定稿），正文块是空的，
 * 于是这一轮什么都发不出去。只认「行数标记」后面那段——那是过完自检的版本；没有这个标记就返回空，
 * 宁可不发，也不把草稿或内心独白当话发出去。
 */
const FINAL_MARK_RE = /(?:^|\n)[ \t]*(?:最终(?:回复)?|定稿|Final|(?:[0-9０-９]+|[一二三四五六七八九十两]+)[ \t]*(?:lines?|行))[ \t]*[:：]/gi
const TRAILING_RE = /\n[ \t]*(?:Careful|Note|Watch|Beware|自检|注意|注意点)[ \t]*[:：]/i

export function rescueFromThinking(thinking) {
  const s = String(thinking || '').trim()
  if (!s) return ''
  // 定稿可能改过几版，取最后一个标记之后的内容
  let last = null
  for (const m of s.matchAll(FINAL_MARK_RE)) last = m
  if (!last) return ''
  const body = s.slice(last.index + last[0].length)
  // 定稿后面还跟着新一段自检/旁白时截掉——那不是要说的话
  const cut = body.search(TRAILING_RE)
  return (cut >= 0 ? body.slice(0, cut) : body).trim()
}

/**
 * chat.everyStep 的取值判定：
 *   true    每段都发
 *   false   只发最后一段
 *   'auto'  这一轮出现过工具调用就并成一条，纯对话轮才分条
 * 判据只看结构（本轮有没有 tool-call 块），不猜语义，所以不会因为措辞变化抖。
 */
export function everyStepMode(value, st) {
  if (value === 'auto') return !(st && st.sawToolCall)
  return Boolean(value)
}

/**
 * 'auto' 中途翻成「并条」时，把同一轮里还没发出去的那段正文收回来。
 *
 * 场景：纯对话轮先说了第一段（记在 interim 里等下一段），随后这一轮调了工具，
 * 模式从「分条」变成「并条」——并条分支不会再经过 takeInterim，那段就永远发不出去。
 * 返回要并进 mergedText 的文本；不是同一轮、已发过、或没有待发文本时返回 ''。
 */
export function adoptInterim (st, { turn = 0, step = -1 } = {}) {
  if (!st || st.interimTurn !== turn) return ''
  const text = String(st.interimText || '').trim()
  if (!text) return ''
  // interimStep 记录的是「上一步发/存了什么」；当前步比它新才需要收，避免把当前段重复收一次。
  if (!(Number(st.interimStep) < Number(step))) return ''
  st.interimText = ''
  st.interimStep = -1
  return text
}

/**
 * 不分条（everyStep=false，或 'auto' 判成「这一轮调过工具」）时，把没单独发出去的段落攒起来。
 * 早先的实现是「只留最后一段」，工具轮里先说的那段就被整段吃掉了（2026-11-24 现场：
 * step5 回了提问、step6 才是结论，结果只发出 step6）。这里只做去重拼接，不改措辞。
 */
export function mergeStepText(prev, next) {
  const a = String(prev || '').trim()
  const b = String(next || '').trim()
  if (!b) return a
  if (!a) return b
  if (a === b || a.endsWith(b)) return a
  if (b.includes(a)) return b
  return `${a}\n\n${b}`
}

/**
 * 两段话是不是「同一件事说两遍」。
 *
 * 判据只看字面：去空白与标点后取二元组集合的 Jaccard。模型把同一份结果复述两遍时，
 * 字面重合度通常在 0.7 以上；真补充（"另外还有一点"）一般在 0.2 以下。
 * 阈值由 chat.dupSimilarity 控制，默认 0.45——2026-11-24 那对真重复实测 0.49，真补充 0.03。
 */
export function similarText(a, b) {
  const norm = (x) => String(x || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return 0
  if (x === y) return 1
  const grams = (s) => {
    const set = new Set()
    if (s.length === 1) set.add(s)
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
    return set
  }
  const gx = grams(x)
  const gy = grams(y)
  let inter = 0
  for (const g of gx) if (gy.has(g)) inter++
  const union = gx.size + gy.size - inter
  return union ? inter / union : 0
}
