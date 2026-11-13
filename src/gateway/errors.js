// Aurabot 多平台 · SendError 构造与判定（G1 产出）
// 契约来源：src/gateway/contracts.d.ts 第 5 节（SendError / certainty）；
// 文字规则：docs/CONTRACTS.md §七.3 —— 失败分类是防重复发送的根基：
//   'not-sent'：确定没发出去，可以入队、重试、换方式重发；
//   'unknown' ：超时 / 连接中途断开 / 响应读不懂，一律不重发；拿不准就是 'unknown'。

/**
 * 构造一个 SendError 形状的错误（普通 Error 挂 certainty / code / instance）。
 * @param {'not-sent'|'unknown'} certainty
 * @param {string=} code 平台的错误码或短标签，写日志用
 * @param {string=} instance 实例名
 * @param {string=} message 人话描述
 */
export function makeSendError(certainty, code, instance, message) {
  const error = new Error(message || `发送失败（${certainty}${code ? ' / ' + code : ''}）`)
  error.certainty = certainty
  if (code) error.code = code
  error.instance = instance
  error.name = 'SendError'
  return error
}

/** 这是不是一个「确定没发出去」的 SendError。只有它才可以入队 / 重试。 */
export function isNotSent(error) {
  return Boolean(error) && typeof error === 'object' && error.certainty === 'not-sent'
}

/**
 * 平台端抛的任何非 SendError（普通 Error、字符串、undefined……）一律包成 'unknown'。
 * 平台端按契约必须抛 SendError；包一层是网关对违约平台端的兜底（CONTRACTS §七.3）。
 */
export function toSendError(error, instance) {
  if (error && typeof error === 'object' && (error.certainty === 'not-sent' || error.certainty === 'unknown')) {
    // 形状对但缺 instance：补上
    if (!error.instance) error.instance = instance
    return error
  }
  const message = error instanceof Error ? error.message : String(error ?? '平台端抛了非 Error 的值')
  return makeSendError('unknown', 'unknown', instance, `平台端抛了非 SendError，按 unknown 处理：${message}`)
}
