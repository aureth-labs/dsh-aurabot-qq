// 评论查重闸门：发之前先过三道，撞了就**不发**，把原因和改法还给模型让它重写。
//
// 为什么要在代码里拦：章程 / 提示词里写「要有具体细节、别客套」，模型照样会写「这条我认」「值得一看」。
// 禁令没有范例有效、自觉没有拦截可靠 —— 所以在执行层做最后一道（跟参考实现同一个思路）。
//
// 三道检查（都便宜，一个纯本地 / 一个读本地台账 / 一个轻请求）：
//   ① 开头八股黑名单（正则）
//   ② 跟**她自己以前发过的评论**太像（bigram 相似度）—— 治「每条一个味」
//   ③ 跟**这条视频现有热评**太像 —— 治「跟别人撞车」
//
// 关掉：配置里 bili.styleGuard = false。

/** 开头套话：命中就拒，让它直接说视频里的具体东西。 */
const STYLE_LEAD = /^\s*(?:这条(?:我认|我记下了|值得)|我记下了|值得一看|确实值得|不得不说|好家伙|这个(?:必须|真的要)|强烈推荐|感谢分享|学到了|受教了|作为一个|总之|综上)/

/** 只留中英文数字，bigram 用。 */
function bigrams(s) {
  const t = String(s || '').replace(/[^\w\u4e00-\u9fff]/g, '').replace(/\s+/g, '')
  if (t.length < 2) return new Set(t)
  const out = new Set()
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2))
  return out
}

/** bigram Jaccard：够用、够快、零依赖。 */
export function similarity(a, b) {
  const x = bigrams(a)
  const y = bigrams(b)
  if (!x.size || !y.size) return 0
  let inter = 0
  for (const g of x) if (y.has(g)) inter++
  return inter / (x.size + y.size - inter)
}

export const STYLE_LEAD_RE = STYLE_LEAD

/**
 * 检查一句评论。
 * @param {string} text 想发的评论正文
 * @param {object} o
 * @param {string[]} o.history 她自己最近发过的评论（新的在后）
 * @param {string[]} o.peers 这条视频下已有的热评
 * @param {number} [o.selfThreshold=0.55] 和自己旧评论的相似度阈值
 * @param {number} [o.peerThreshold=0.5] 和热评的相似度阈值
 * @returns {{ok:boolean, reason?:string, hint?:string}}
 */
export function checkCommentStyle(text, { history = [], peers = [], selfThreshold = 0.55, peerThreshold = 0.5 } = {}) {
  const body = String(text || '').replace(/\s+/g, ' ').trim()
  if (!body) return { ok: false, reason: '评论是空的', hint: '写一句具体的话' }

  const lead = STYLE_LEAD.exec(body)
  if (lead) {
    return {
      ok: false,
      reason: `开头「${lead[0].trim()}」是套话`,
      hint: '直接说这条视频里的具体东西：「这期讲了什么 + 一个只有看了才说得出的细节」，开头别用客套话',
    }
  }

  for (const old of history.slice(-30)) {
    const s = similarity(body, old)
    if (s >= selfThreshold) {
      return {
        ok: false,
        reason: `跟你以前发过的「${String(old).slice(0, 18)}…」太像了（相似度 ${s.toFixed(2)}）`,
        hint: '换开头、换关注点，别套同一个句式',
      }
    }
  }

  for (const other of peers.slice(0, 20)) {
    const s = similarity(body, other)
    if (s >= peerThreshold) {
      return {
        ok: false,
        reason: `这条视频底下已经有一句很像的（相似度 ${s.toFixed(2)}）：${String(other).slice(0, 24)}…`,
        hint: '撞车了 —— 换个角度写，或者这一轮不发',
      }
    }
  }

  return { ok: true }
}
