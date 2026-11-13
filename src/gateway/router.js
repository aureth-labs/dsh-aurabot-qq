// Aurabot 多平台 · 出站路由（G1 产出）
// 契约来源：src/gateway/contracts.d.ts（Gateway.routeTo / noteSeen）；
// 文字规则：docs/CONTRACTS.md §八之二.6 —— 路由可调：给某个人固定平台；
//   给某类消息（SendKind）指定优先实例；§八.4 —— routeTo 已经排除了 proactive='none' 的平台。
// 优先级（Gateway.routeTo 注释）：这个人固定的平台 > 最近说过话的平台 > 任一在线的平台；
//   都没有返回 null。
// 落盘（网关数据目录 router.json）：
//   { fixed: { <personId>: 平台名 }, seen: { <personId>: { chatId, at } }, kinds: { <SendKind>: 实例名 } }
// 注意：PersonId 不透明，这里只当键用，不解析（CONTRACTS §四.1）。
// 地址处理只用 address.js 的四个函数。

import { normalizeChatId, parseChatId, formatChatId } from './address.js'
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ensureDir } from '../core/store.js'

export function createRouter({ file, log, now = Date.now } = {}) {
  let data = { fixed: {}, seen: {}, kinds: {} }
  let loaded = false

  function load() {
    if (loaded) return
    loaded = true
    try {
      if (!file || !existsSync(file)) return
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      data = {
        fixed: parsed?.fixed && typeof parsed.fixed === 'object' ? parsed.fixed : {},
        seen: parsed?.seen && typeof parsed.seen === 'object' ? parsed.seen : {},
        kinds: parsed?.kinds && typeof parsed.kinds === 'object' ? parsed.kinds : {},
      }
    } catch (error) {
      log?.warn?.('路由数据读不出来，已忽略旧文件：', error?.message || error)
      data = { fixed: {}, seen: {}, kinds: {} }
    }
  }

  function save() {
    if (!file) return
    try {
      ensureDir(dirname(file))
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 })
      try { chmodSync(tmp, 0o600) } catch {}
      renameSync(tmp, file)
    } catch (error) {
      log?.warn?.('路由数据落盘失败：', error?.message || error)
    }
  }

  /** 给某个人固定平台（平台名，不是实例——同平台换实例不影响固定） */
  function setFixed(person, platform) {
    load()
    data.fixed[person] = String(platform || '')
    save()
  }
  function fixedPlatform(person) {
    load()
    return data.fixed[person] || null
  }

  /** 中枢每收到一条私聊消息调一次：记「最近在哪个实例说过话 + 时间」 */
  function noteSeen(person, chatId, at = now()) {
    const norm = normalizeChatId(chatId)
    if (!norm) return // system:* / 认不出的不记
    const addr = parseChatId(norm)
    if (!addr) return
    load()
    data.seen[person] = { chatId: norm, at: Number(at) || now() }
    save()
  }
  function lastSeen(person) {
    load()
    const s = data.seen[person]
    return s ? { ...s } : null
  }

  /** 给某类消息（SendKind）指定优先实例 */
  function setKindInstance(kind, instance) {
    load()
    if (instance) data.kinds[kind] = String(instance)
    else delete data.kinds[kind]
    save()
  }
  function instanceForKind(kind) {
    load()
    return data.kinds[kind] || null
  }

  /**
   * 她主动找一个人时发到哪。
   * @param {string} person
   * @param {{ identity, getInstances }} deps identity：Identity 形状；getInstances()：InstanceStatus[]
   * @returns {string|null} ChatId 或 null
   */
  function routeTo(person, { identity, getInstances }) {
    const statuses = typeof getInstances === 'function' ? getInstances() : []
    // 只考虑在线、启用、允许主动消息的实例
    const usable = (st) => Boolean(st) && st.enabled && st.state === 'connected' && st.caps && st.caps.proactive !== 'none'
    const addressOn = (st, fallback) => {
      const account = identity.accountOn(person, st.platform)
      if (!account) return null
      return formatChatId({ instance: st.instance, platform: st.platform, kind: 'private', id: account })
    }

    // 1. 这个人固定的平台
    const fixed = fixedPlatform(person)
    if (fixed) {
      const st = statuses.find((s) => s.platform === fixed && usable(s))
      const chatId = st ? addressOn(st) : null
      if (chatId) return chatId
    }

    // 2. 最近说过话的实例（优先实例里她有账号才用）
    const seen = lastSeen(person)
    if (seen) {
      const addr = parseChatId(seen.chatId)
      if (addr) {
        const st = statuses.find((s) => s.instance === addr.instance && usable(s))
        if (st) {
          const account = identity.accountOn(person, st.platform)
          if (account) return formatChatId({ instance: st.instance, platform: st.platform, kind: 'private', id: account })
        }
      }
    }

    // 3. 任一在线的、允许主动消息的、她在上面有账号的平台（按 instances() 的顺序取第一个）
    for (const st of statuses) {
      if (!usable(st)) continue
      const chatId = addressOn(st)
      if (chatId) return chatId
    }
    return null
  }

  return { setFixed, fixedPlatform, noteSeen, lastSeen, setKindInstance, instanceForKind, routeTo }
}
