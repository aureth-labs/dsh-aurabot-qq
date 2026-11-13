// QQ 平台端 · 扩展动作透传（native）
//
// 契约：src/gateway/contracts.d.ts §九（只有清单里 platforms 含 'qq' 的模块能经 api.native 调到这里）。
// 作用：把模块要的 OneBot 扩展动作（空间、收藏表情、改资料、群管理……）原样转给对面的网关，
//       但在**探测清单里没有这个动作时直接抛错不发请求** —— 这正是能力探测的用处：
//       模块问「能不能」时要么看 caps，要么干脆调这里，得到「当前网关不支持 X」的明确答复。
//
// 规矩：
//   1. 不发请求就能判定的，先判定（白名单）。
//   2. SendError 的三要素（certainty / code / instance）在透传时保留原判定：
//      transport → not-sent，其余（超时/业务错/读不懂）→ unknown（CONTRACTS §七.3）。
//      模块拿到的错误和平台端 send 拿到的是同一套语义，写代码的人不用记两套。

/** 现行 OneBot 里「发消息」这一类动作用到的参数形状（只用来判断必填参数，不做严格校验）。 */
const MESSAGE_ACTIONS = new Set(['send_private_msg', 'send_group_msg', 'send_msg'])

/**
 * 造一个 native 用的 SendError 形状（普通 Error 挂 certainty / code / instance）。
 * @param {'not-sent'|'unknown'} certainty
 */
function nativeError(certainty, code, instance, message) {
  const error = new Error(message || `原生动作调用失败（${certainty}${code ? ' / ' + code : ''}）`)
  error.certainty = certainty
  if (code) error.code = code
  error.instance = instance
  error.name = 'SendError'
  return error
}

/**
 * 建 native() 的实现。
 * @param {object} o
 * @param {() => (null | { supported: Set<string>, unknown: string[], probed: boolean })} o.probeState
 *        探测状态：supported = 探到的动作集合（含标准动作），probed = 是否已经探完
 * @param {(action: string, params?: any, opts?: object) => Promise<any>} o.call 客户端的 call
 * @param {() => string} o.instance 实例名（填进 SendError）
 * @param {object} [o.log]
 */
export function createNative({ probeState, call, instance, log }) {
  /**
   * @param {string} action OneBot 动作名
   * @param {any} params 原样透传
   * @param {{ timeoutMs?: number }} [opts]
   */
  return async function native(action, params, opts = {}) {
    const name = String(action || '').trim()
    if (!name) throw nativeError('not-sent', 'bad-action', instance(), 'native 需要一个动作名')
    const state = probeState ? probeState() : null
    // 探测完才敢判定「不支持」：探测没跑完之前放行（探测失败不该把模块的活全堵死）
    if (state?.probed && state.supported && !state.supported.has(name)) {
      throw nativeError('not-sent', 'unsupported-action', instance(), `当前网关不支持 ${name}（能力探测里没有它）`)
    }
    if (MESSAGE_ACTIONS.has(name)) {
      // 发消息必须走平台端 send（那里才有降级、被动回复、messageId 回填），不从这里绕过去
      throw nativeError('not-sent', 'use-send', instance(), `发消息请走网关的 send（${name} 不走 native）`)
    }
    const timeoutMs = Math.max(1, Number(opts?.timeoutMs) || 15000)
    try {
      return await call(name, params || {}, { timeoutMs })
    } catch (error) {
      // 保留客户端的原始判定：transport → 确定没发出去；其余一律 unknown（绝不重发）
      const transport = Boolean(error?.transport)
      const code = transport ? 'transport' : String(error?.data?.retcode ?? error?.code ?? 'native-failed')
      log?.debug?.(`native ${name} 失败：${error?.message || error}`)
      throw nativeError(transport ? 'not-sent' : 'unknown', code, instance(), `${name} 失败：${error?.message || error}`)
    }
  }
}
