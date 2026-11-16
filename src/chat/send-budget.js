import { AsyncLocalStorage } from 'node:async_hooks'

// Tools and the final reply share one model-turn budget. Background jobs and
// explicit panel actions keep their existing lifecycle.
const scope = new AsyncLocalStorage()
const SEND_ACTIONS = new Set([
  'send_msg', 'send_group_msg', 'send_private_msg',
  'send_forward_msg', 'send_group_forward_msg', 'send_private_forward_msg',
  'forward_group_single_msg', 'forward_friend_single_msg',
  'send_custom_face', 'send_group_ai_record', 'send_tuwen_ark',
  'group_poke', 'friend_poke', 'send_poke',
  'upload_group_file', 'upload_private_file',
])

export const messageLimit = chatId => String(chatId).startsWith('group:') ? 3 : 5
export const createSendBudget = () => ({ counts: new Map(), delivered: new Map() })
export const currentSendBudget = () => scope.getStore()
export const withSendBudget = (budget, fn) => scope.run(budget, fn)
export const remainingMessages = chatId => Math.max(0, messageLimit(chatId) - (scope.getStore()?.counts.get(chatId) || 0))

/** Reserve before I/O so concurrent tools cannot overshoot. An uncertain
 * failure still spends its slot; HTTP retries inside one call share that slot.
 */
export function reserveMessage(action, params = {}) {
  const budget = scope.getStore()
  if (!budget || !SEND_ACTIONS.has(action)) return
  const privateTarget = /private|friend/.test(action) || params.message_type === 'private'
  const group = !privateTarget && params.group_id != null && params.group_id !== ''
  const id = group ? params.group_id : params.user_id ?? params.target_id
  if (id == null || id === '') return
  const chatId = `${group ? 'group' : 'private'}:${Number(id)}`
  const count = budget.counts.get(chatId) || 0
  if (count >= messageLimit(chatId)) {
    const error = new Error(`本轮向这个聊天发送的消息已达上限（${messageLimit(chatId)} 条），请停止发送；不能通过换工具或拆分调用继续发。`)
    error.code = 'AURABOT_MESSAGE_LIMIT'
    throw error
  }
  budget.counts.set(chatId, count + 1)
  return { budget, chatId }
}

/** Only gateway-confirmed deliveries satisfy a media-only request. */
export function confirmMessage(reservation, params) {
  if (!reservation) return
  const { budget, chatId } = reservation
  const types = budget.delivered.get(chatId) || new Set()
  for (const segment of Array.isArray(params.message) ? params.message : []) types.add(segment.type)
  budget.delivered.set(chatId, types)
}

/** A single requested image/voice already sent by a tool needs no final
 * acknowledgement or second copy. Multi-item requests keep their normal path.
 */
function singleRequestedMedia(userText) {
  const text = String(userText || '')
  if (!/(?:不要|不用|别)(?:再)?(?:发|配|加|补)?(?:文字版|文字|文本)|只(?:要|发)(?:图片|表情包|语音)/.test(text)) return false
  const quantities = text.match(/[零〇一二两三四五六七八九十百千万\d]+(?:张|个|条)/g) || []
  if (quantities.length !== 1 || !/^(?:一|1)(?:张|个|条)$/.test(quantities[0])) return false
  const image = /(?<![零〇一二两三四五六七八九十百千万\d])(?:一|1)(?:张|个)(?:[^。！？\n]{0,12})(?:图片|表情包)/.test(text)
  const voice = /(?<![零〇一二两三四五六七八九十百千万\d])(?:一|1)条语音/.test(text)
  if (image === voice) return false
  return image ? 'image' : 'record'
}

export function singleMediaDelivered(chatId, userText) {
  const requested = singleRequestedMedia(userText)
  return Boolean(requested && scope.getStore()?.delivered.get(chatId)?.has(requested))
}

/** Explicit reply formats also apply to automatically added decorations. Keep
 * a textual failure report when the requested media could not be produced.
 */
export function respectReplyMedia(items, userText) {
  const text = String(userText || '')
  if (/(?:不要|不用|别)(?:再|额外)?(?:发|加|配|带)?(?:图片|表情包)/.test(text)) {
    items = items.filter(it => it.kind !== 'sticker' && it.kind !== 'image')
  }
  const requested = singleRequestedMedia(text)
  const media = items.filter(it => requested === 'image' ? ['image', 'sticker'].includes(it.kind) : requested === 'record' && it.kind === 'voice')
  return media.length ? compactReplyItems(media, 1) : items
}

/** Keep complete prose in the last available bubble. Excess decorative media
 * must not displace the answer; a voice-only tail stays one voice message.
 */
export function compactReplyItems(items, limit) {
  if (limit <= 0) return []
  if (items.length <= limit) return items
  const head = items.slice(0, limit - 1)
  const tail = items.slice(limit - 1)
  const content = tail.filter(it => it.kind === 'text' || it.kind === 'voice')
  if (!content.length) return [...head, tail[0]]
  const voiceOnly = content.every(it => it.kind === 'voice')
  return [...head, { ...content[0], kind: voiceOnly ? 'voice' : 'text', value: content.map(it => it.value).join(voiceOnly ? '，' : '\n') }]
}
