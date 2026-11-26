import { parseChatId } from '../gateway/address.js'

const legacyPlatform = parseChatId('private:0').platform
// 兼容可选的 `qq:` 前缀，输出统一用无前缀的规范形态，保证同一平台消息的 originId 稳定。
const legacyChat = new RegExp(`^(?:${legacyPlatform}:)?(private|group):(\\d+)$`)

export function chatMessageOrigin(chatId, messageId, direction, botQQ) {
  if (typeof messageId !== 'string' && !Number.isSafeInteger(messageId)) return null
  const id = String(messageId)
  if (!/^-?[1-9]\d*$/.test(id)) return null
  const match = legacyChat.exec(String(chatId || ''))
  if (!match) return null
  const chat = `${match[1]}:${match[2]}`
  const account = String(botQQ || '')
  return {
    originId: JSON.stringify([direction, chat, account, id]),
    chatId: chat,
    platform: legacyPlatform,
    messageId: id,
  }
}

export function confirmedChatDelivery(chatId, messageId, botQQ) {
  const origin = chatMessageOrigin(chatId, messageId, 'out', botQQ)
  return origin ? Object.freeze({ ...origin, status: 'confirmed', at: Date.now() }) : null
}
