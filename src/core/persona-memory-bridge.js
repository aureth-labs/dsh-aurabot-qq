import { randomUUID } from 'node:crypto'
import { dataOwner, safeId } from '../persona/personas.js'
import { confirmedChatDelivery } from '../chat/receipts.js'

export const PERSONA_MEMORY_MODULE = 'persona-memory'

const capabilities = Object.freeze(['native-memory-view', 'confirmed-delivery'])
const maxRecentReceipts = 4096

const sameScope = (a, b) => Boolean(a && b && a.chatId === b.chatId && a.personaId === b.personaId && a.botQQ === b.botQQ)

/**
 * Beta preview for the currently selected persona and the owner's exact QQ private chat.
 * The host keeps the transport side of this object. Modules get only forModule().
 */
export function createPersonaMemoryRuntime({ getConfig }) {
  let subscription = null
  let nativePreview = null

  function scope(chatId) {
    const cfg = getConfig()
    const owner = String(cfg.ownerQQ || '')
    const personaId = safeId(cfg.persona?.current)
    const botQQ = String(cfg.botQQ || '')
    if (cfg.safeMode || cfg.debug || !dataOwner(cfg) || !personaId || !/^\d+$/.test(owner) || chatId !== `private:${owner}`) return null
    return { chatId, personaId, botQQ }
  }

  function validSubscription() {
    return subscription?.active() && sameScope(subscription.scope, scope(subscription.scope.chatId))
  }

  return {
    registerNativePreview(read) {
      nativePreview = read
      return () => {
        if (nativePreview === read) nativePreview = null
      }
    },
    forModule(active, track) {
      function requireScope(chatId) {
        if (!active()) throw new Error('人设记忆模块实例已停止')
        const allowed = scope(chatId)
        if (!allowed) throw new Error('当前聊天不在记忆预览范围内')
        return allowed
      }

      return Object.freeze({
        api: 1,
        state: 'preview',
        get capabilities() { return active() ? capabilities : [] },
        readNativeMemory(chatId, page) {
          const allowed = requireScope(chatId)
          return nativePreview?.(allowed, page) ?? null
        },
        onDelivery(chatId, listener) {
          const allowed = requireScope(chatId)
          if (!/^\d+$/.test(allowed.botQQ)) throw new Error('当前 QQ 网关身份尚未确认')
          if (typeof listener !== 'function') throw new TypeError('送达回执监听器必须是函数')
          if (validSubscription()) throw new Error('人设记忆已订阅送达回执')
          const entry = { active, scope: allowed, listener, seen: new Set(), id: randomUUID() }
          subscription = entry
          return track(() => {
            if (subscription === entry) subscription = null
            entry.seen.clear()
          })
        },
      })
    },
    captureDelivery(chatId, personaId, botQQ) {
      const from = { chatId, personaId, botQQ: String(botQQ || '') }
      if (getConfig().dryRun || !validSubscription() || !sameScope(subscription.scope, from)) return null
      return Object.freeze({ ...from, subscriptionId: subscription.id })
    },
    confirmDelivery(chatId, messageId, from) {
      if (getConfig().dryRun || !validSubscription() || !from || subscription.id !== from.subscriptionId ||
          !sameScope(subscription.scope, from) || from.chatId !== chatId) return
      const receipt = confirmedChatDelivery(chatId, messageId, from.botQQ)
      const { listener, seen } = subscription
      if (!receipt || seen.has(receipt.originId)) return
      seen.add(receipt.originId)
      if (seen.size > maxRecentReceipts) seen.delete(seen.values().next().value)
      // A consumer must never affect the result of an already-sent message.
      try { Promise.resolve(listener(receipt)).catch(() => {}) } catch {}
    },
  }
}
