// Aurabot 多平台 · 入站去重（G1 产出）
// 契约来源：src/gateway/contracts.d.ts（AdapterInbound.messageId 注释）；
// 文字规则：docs/CONTRACTS.md §六.3 —— 去重在网关：键是「实例 + messageId」，
//   保留最近 2000 条；平台端重连后重复推送是允许的，但不会进中枢两次。

export function createDedupe({ max = 2000, log } = {}) {
  const set = new Set()
  const order = []

  /** 这条（实例+messageId）是不是第一次见。第一次返回 true 并记下；重复返回 false。 */
  function seen(instance, messageId) {
    const key = `${String(instance)}\u0000${String(messageId)}`
    if (set.has(key)) return false
    set.add(key)
    order.push(key)
    while (order.length > max) {
      const oldest = order.shift()
      set.delete(oldest)
    }
    return true
  }

  function size() {
    return order.length
  }

  return { seen, size }
}
