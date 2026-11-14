// DSH 要授权时，在主人私聊里问一句，回复「确认」就批准这一次（#162）。
// 只处理主人私聊会话发起的请求：别的会话照旧交给 DSH 界面。网页也同时能点，谁先答算谁。

import { isOwnerPrivateChat, resolveConfirmChat } from '../chat/access.js'
import { sameChat } from '../gateway/address.js'

const APPROVE_RE = /^(确认|批准|同意|允许)$/
const REJECT_RE = /^(取消|拒绝)$/

/**
 * @param {object} o
 * @param {() => object} o.getConfig
 * @param {(chatId:string, text:string) => Promise<any>} o.deliver 发消息
 * @param {(sessionId:string) => string} o.chatOfSession DSH session → chatId
 * @param {object} [o.identity] 身份服务
 * @param {(platform?:string) => string|null} [o.routeOwner] 主人兜底路由
 * @param {number} [o.timeoutMs] 等主人回复多久（默认 5 分钟）
 * @param {object} [o.log]
 */
export function createApprovalRelay({ getConfig, deliver, chatOfSession, identity, routeOwner, timeoutMs = 5 * 60_000, log } = {}) {
  const queue = [] // 排队的请求：一次只问一条，「确认」只对正在问的这条生效
  let disposed = false
  let lastAsked = 0

  const resolveTargetChat = (sessionId) => {
    const rawChat = sessionId ? chatOfSession?.(sessionId) : ''
    if (!rawChat) return ''
    return resolveConfirmChat(identity, rawChat, routeOwner)
  }
  const sendTo = (targetChat, text) => Promise.resolve().then(() => deliver(targetChat, text)).catch((error) => log?.warn?.('审批消息没发出去：', error.message))

  /** 这个会话的授权请求归主人私聊问：通知那边就不用再发一条。 */
  function handles(sessionId) {
    const cfg = getConfig()
    return !disposed && cfg.enabled && !cfg.dryRun && cfg.approvalViaQQ === true && Boolean(identity?.owner?.()) && Boolean(resolveTargetChat(sessionId))
  }

  function ask(item) {
    const left = queue.length - 1
    const lines = ['【要授权】' + (item.toolName || '未知工具')]
    if (item.reason) lines.push('原因：' + String(item.reason).slice(0, 300))
    lines.push(`回复「确认」批准这一次，回复「取消」拒绝；${Math.round(timeoutMs / 60_000)} 分钟没回就不批。` + (left ? `后面还有 ${left} 条。` : ''))
    item.timer = setTimeout(() => {
      settle(item, 'unavailable')
      sendTo(item.targetChat, `「${item.toolName}」的授权超时了，没有批准。`)
    }, timeoutMs)
    sendTo(item.targetChat, lines.join('\n'))
  }

  function settle(item, outcome) {
    const i = queue.indexOf(item)
    if (i < 0) return false
    queue.splice(i, 1)
    clearTimeout(item.timer)
    item.signal?.removeEventListener?.('abort', item.onAbort)
    item.resolve(outcome)
    if (i === 0 && queue.length) ask(queue[0])
    return true
  }

  /** 不走私聊问的会话（开关关着、群聊、别人的私聊）：网页开着没人点时 DSH 会一直等，回合结束不了，后面的消息全堵死（#162）。 */
  function withDeadline(request, next) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        log?.warn?.(`「${request.toolName}」的授权一直没人答，按没批准处理`)
        resolve('unavailable')
      }, timeoutMs)
      Promise.resolve().then(next).then(resolve, reject).finally(() => clearTimeout(timer))
    })
  }

  function onRequest(request, next) {
    const sessionId = request?.agent?.session?.id
    if (!handles(sessionId)) return !disposed && chatOfSession(sessionId) ? withDeadline(request, next) : next()
    const targetChat = resolveTargetChat(sessionId)
    if (!targetChat) return withDeadline(request, next)
    lastAsked = Date.now()
    return new Promise((resolve) => {
      const item = { toolName: request.toolName, reason: request.reason, signal: request.signal, targetChat, resolve, timer: null }
      item.onAbort = () => settle(item, 'cancelled')
      request.signal?.addEventListener?.('abort', item.onAbort, { once: true })
      queue.push(item)
      if (queue.length === 1) ask(item)
      // 网页那边也能答：有结果就收掉私聊这边的问题；没人答（unavailable）就继续等主人回私聊
      Promise.resolve().then(next).then((outcome) => {
        if (outcome !== 'unavailable' && settle(item, outcome)) sendTo(item.targetChat, `「${item.toolName}」已经在 DSH 里处理了。`)
      }, () => {})
    })
  }

  /** 主人的私聊回复。是对审批的回答就返回 true，不再交给她。 */
  function handleReply(chatId, userId, text) {
    if (!queue.length) return false
    const item = queue[0]
    if (!sameChat(chatId, item.targetChat) || !isOwnerPrivateChat(identity, chatId, userId)) return false
    const word = String(text || '').trim()
    const outcome = APPROVE_RE.test(word) ? 'allowed-once' : REJECT_RE.test(word) ? 'rejected' : ''
    if (!outcome) return false
    settle(item, outcome)
    sendTo(item.targetChat, outcome === 'allowed-once' ? `批准了这一次：${item.toolName}` : `拒绝了：${item.toolName}`)
    return true
  }

  function dispose() {
    disposed = true
    for (const item of [...queue]) settle(item, 'unavailable')
  }

  return { onRequest, handleReply, handles, dispose, pending: () => queue.length, askedRecently: () => Date.now() - lastAsked < 10_000 }
}
