// Aurabot 多平台 · 网关补发队列（G1 产出）
// 契约来源：src/gateway/contracts.d.ts（OutboundMessage / SendKind / SendError）；
// 文字规则：docs/CONTRACTS.md §七.4/§七.5 —— 补发队列只收 'not-sent'，
//   且只收不含媒体的消息；有效期按 SendKind：proactive 1 分钟 / diary 10 分钟 / 其余 5 分钟；
//   实例重新连上时网关自动补发这个实例名下的；补发成功后经 onFlushed 回调通知中枢留痕（G3 接上）。
// 逻辑源头：src/onebot/outbox.js（错误分类、大小上限、按种类有效期、原子落盘——照搬语义，
//   队列项从「OneBot 动作 + 参数」改成 OutboundMessage）。
// 队列项落盘格式：
//   { id, instance, message: OutboundMessage, createdAt, expiresAt, attempts, nextAt }
//   存成一个 JSON 数组，写在 <网关数据目录>/outbox.json；写法为「临时文件 + rename」原子替换。

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { ensureDir } from '../core/store.js'
import { isNotSent } from './errors.js'

const DEFAULT_TTL = 5 * 60_000
const DEFAULT_MAX_ITEMS = 100
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

const ttlForKind = (kind) => {
  if (kind === 'proactive') return 60_000
  if (kind === 'diary') return 10 * 60_000
  return DEFAULT_TTL
}

/** 不含媒体：parts 里除 text / mention / face 外没有别的类型（沿用 onebot/outbox.js 现规则） */
const TEXT_ONLY = new Set(['text', 'mention', 'face'])

export function hasMedia(parts) {
  return (Array.isArray(parts) ? parts : []).some((p) => !p || !TEXT_ONLY.has(p.type))
}

export function createOutbox({ file, log, now = Date.now, maxItems = DEFAULT_MAX_ITEMS, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  let items = []
  let loaded = false
  let flushedListener = null // onFlushed(message, result)

  function load() {
    if (loaded) return
    loaded = true
    try {
      if (!file || !existsSync(file)) return
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      // 只收形状完整的队列项：必须有 id / instance / message（OutboundMessage）
      items = Array.isArray(parsed) ? parsed.filter((x) => x && x.id && x.instance && x.message && Array.isArray(x.message.parts)) : []
    } catch (error) {
      log?.warn?.('补发队列读不出来，已忽略旧文件：', error?.message || error)
      items = []
    }
  }

  function save() {
    if (!file) return
    try {
      ensureDir(dirname(file))
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(items), { encoding: 'utf8', mode: 0o600 })
      try { chmodSync(tmp, 0o600) } catch {}
      renameSync(tmp, file)
    } catch (error) {
      log?.warn?.('补发队列落盘失败：', error?.message || error)
    }
  }

  function prune(at = now()) {
    load()
    const before = items.length
    items = items.filter((x) => Number(x.expiresAt) > at)
    if (items.length !== before) save()
  }

  function list() {
    prune()
    return items.map((x) => ({ ...x, message: { ...x.message } }))
  }

  /**
   * 入队一条 OutboundMessage。只收 'not-sent' 的场合由网关判断后才调这里；
   * 这里再兜两道底：含媒体的不入队、太大的不入队。
   * @returns {{ ok: boolean, id?: string, expiresAt?: number, message?: string }}
   */
  function add(message = {}, { instance } = {}) {
    if (!instance) return { ok: false, message: '缺实例名' }
    if (hasMedia(message.parts)) return { ok: false, message: '媒体消息不放进补发队列' }
    const text = JSON.stringify(message || {})
    if (Buffer.byteLength(text, 'utf8') > maxBytes) return { ok: false, message: '消息太大，不放进补发队列' }
    load()
    prune()
    if (items.length >= maxItems) {
      items.shift() // 丢最旧的一条，保证不无限增长
      log?.warn?.(`补发队列已满（${maxItems}），丢弃最旧一条`)
    }
    const at = now()
    const kind = message.kind || 'reply'
    const item = {
      id: randomUUID(),
      instance,
      message: { ...message, kind },
      createdAt: at,
      expiresAt: at + ttlForKind(kind),
      attempts: 0,
      nextAt: at,
    }
    items.push(item)
    save()
    return { ok: true, id: item.id, expiresAt: item.expiresAt }
  }

  function remove(id) {
    load()
    const before = items.length
    items = items.filter((x) => x.id !== id)
    if (items.length !== before) save()
  }

  /**
   * 补发。send(item) 由调用方提供（网关传「直接调平台端 send」的函数，不再走一遍降级/入队）。
   * 错误分类照 onebot/outbox.js 的语义：
   *   'not-sent'（仍连不上）：留队、指数退避，停下来等下次 flush；
   *   'unknown' / 其他：可能已经发出去或没意义了，丢弃防重复。
   * @param {(item) => Promise<{ messageId: string }>} send
   * @param {string=} onlyInstance 只补发这个实例名下的（实例重连时用）
   */
  // flush 串行化：自动补发（实例连上时）和手动 flush 可能同时进来，
  // 若并发跑，两边会各自读到同一条快照 → 同一条消息发两次。
  // 防重复发送是这个队列存在的根本目的，所以这里必须串行（排队执行，不并发）。
  let flushChain = Promise.resolve()

  async function flush(send, onlyInstance) {
    const run = flushChain.then(() => flushOnce(send, onlyInstance))
    // 无论成败都不让链条断掉，否则后续 flush 全部被拒
    flushChain = run.catch(() => {})
    return run
  }

  async function flushOnce(send, onlyInstance) {
    load()
    let sent = 0
    let dropped = 0
    // 注意：这里不能用 list()——它会先 prune 掉过期项，导致 dropped 永远统计不到。
    // 过期的判定留给下面的循环做一个明确的分支（过期丢弃也是「丢弃」的一种，要计数）。
    const snapshot = items.slice()
    for (const item of snapshot) {
      if (onlyInstance && item.instance !== onlyInstance) continue
      // 可能已被本轮前面的迭代删掉（极端情况下同一 id 重复）
      if (!items.some((x) => x.id === item.id)) continue
      const at = now()
      if (item.expiresAt <= at) {
        remove(item.id)
        dropped++
        log?.warn?.(`补发过期，丢弃：${item.message?.note || item.message?.chatId || item.id}`)
        continue
      }
      if (Number(item.nextAt) > at) continue
      try {
        const result = await send(item)
        remove(item.id)
        sent++
        log?.info?.(`补发成功：${item.message?.note || item.message?.chatId || item.id}`)
        try { flushedListener?.(item.message, result) } catch (error) { log?.warn?.('onFlushed 回调出错：', error?.message || error) }
      } catch (error) {
        if (isNotSent(error)) {
          // 还是没连上：留队重试，指数退避（这一轮停在这里）
          const raw = items.find((x) => x.id === item.id)
          if (!raw) continue
          raw.attempts = Number(raw.attempts || 0) + 1
          raw.nextAt = at + Math.min(60_000, 2 ** Math.min(raw.attempts, 5) * 1000)
          save()
          log?.warn?.(`补发时实例仍不可用，留队重试：${item.message?.note || item.message?.chatId || item.id}`)
          break
        }
        // 'unknown' 或别的：宁可少发一次，不能重复
        remove(item.id)
        dropped++
        log?.warn?.(`补发结果不确定，丢弃避免重复：${item.message?.note || item.message?.chatId || item.id}`)
      }
    }
    return { sent, dropped, left: list().length }
  }

  function status() {
    prune()
    return { count: items.length, oldestAt: items.length ? Math.min(...items.map((x) => x.createdAt)) : 0 }
  }

  /** 注册补发成功回调：onFlushed(message: OutboundMessage, result: SendResult)。G3 用它留痕。 */
  function onFlushed(fn) {
    if (typeof fn !== 'function') return () => {}
    flushedListener = fn
    return () => { if (flushedListener === fn) flushedListener = null }
  }

  return { add, list, remove, prune, flush, status, onFlushed }
}
