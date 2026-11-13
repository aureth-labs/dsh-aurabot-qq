// 正文标记：把「哪句话是发给对方的」从猜变成读。
//
// 人格文件里已经要求「只留要说的话」，模型状态差时照样会把思考写进正文。
// 这里换一个更硬的办法：代码在系统提示里注入一条格式要求，模型必须把要发的话
// 包在 ⟦REPLY⟧ ... ⟦/REPLY⟧ 之间；标记外面的内容一律不当作正文。
//
// 标记用 U+27E6 / U+27E7（⟦ ⟧），正常聊天不会打出来，几乎不会误伤。

export const REPLY_OPEN = '⟦REPLY⟧'
export const REPLY_CLOSE = '⟦/REPLY⟧'

// 解析时宽容一点：模型偶尔会写成 [[REPLY]] / 【REPLY】 或带空格。
const OPEN_RE = /(?:⟦|\[\[|【)\s*REPLY\s*(?:⟧|\]\]|】)/gi
const CLOSE_RE = /(?:⟦|\[\[|【)\s*\/\s*REPLY\s*(?:⟧|\]\]|】)/gi

/** 注入给模型的格式要求（放在系统提示里，不动人格文件）。 */
export function markerInstruction () {
  return '【输出格式｜必须遵守】你要发给对方的话，整段包进这两个标记里：'
    + `${REPLY_OPEN}你要说的话${REPLY_CLOSE}。`
    + '标记外面写的东西（思考、草稿、计划、英文备注）不会被发出去；'
    + '没有任何标记＝这条消息发不出去，会要求你重写一次。'
    + '标记内只写对方能看到的话，不要带标记本身以外的格式说明。'
}

/**
 * 从一段输出里取出标记内的正文。
 *
 * 取最后一组标记：模型可能在思考里先草拟一版，最后再正式写定稿。
 * 只有开头没有结尾时，取到结尾（模型常忘写闭合标记）。
 * 没有标记就返回 { found: false }，交给调用方决定重写还是不发。
 *
 * @returns {{ found: boolean, text: string }}
 */
export function extractMarkedReply (text) {
  const s = String(text || '')
  if (!s) return { found: false, text: '' }
  const opens = [...s.matchAll(OPEN_RE)]
  if (!opens.length) return { found: false, text: '' }
  const lastOpen = opens[opens.length - 1]
  const closes = [...s.matchAll(CLOSE_RE)].filter((m) => m.index > lastOpen.index)
  const body = closes.length
    ? s.slice(lastOpen.index + lastOpen[0].length, closes[0].index)
    : s.slice(lastOpen.index + lastOpen[0].length)
  return { found: true, text: body.trim() }
}

/** 去掉标记本身（防止模型把标记留在正文里发出去）。 */
export function stripMarkers (text) {
  return String(text || '').replace(OPEN_RE, '').replace(CLOSE_RE, '').trim()
}
