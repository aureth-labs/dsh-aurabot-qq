// QQ 平台端 · 错误分类（SendError 的 certainty 在这里定）
//
// 契约：src/gateway/contracts.d.ts 第 5 节（SendError.certainty）、docs/CONTRACTS.md §七.3、§七.4。
// 口诀：**确定没发出去 → not-sent；有没有到不确定 → unknown；拿不准必须 unknown。**
//
// 这一份不是新写的判断：它是 src/onebot/client.js 里现成的两套判定的**外壳**——
//   - OneBotError.transport  → 根本没连上网关（可以重试）→ not-sent
//   - OneBotError.uncertain  → 超时 / 连接中途断开 / 响应读不懂 → unknown
//   - isDefiniteFailure()    → 已被测试保护过的「确定没发出去」综合判断（原样调用）
// 判断本身一行没改（改了就等于改防重复发送的地基），只把它翻译成契约要的形状。
//
// 为什么不直接把 OneBotError 抛给网关：契约要求 SendError 带 instance 和短标签 code，
// 且网关的 errors.js toSendError 只认 certainty / instance 两个字段；包一层最稳。

/**
 * 造一个 SendError 形状（普通 Error 挂 certainty / code / instance）。
 * 网关的 errors.js 还没合并到所有路径，这里生成的就是契约要的最终形状。
 */
export function makeSendError(certainty, code, instance, message) {
  const error = new Error(message || `发送失败（${certainty}${code ? ' / ' + code : ''}）`)
  error.certainty = certainty
  if (code) error.code = code
  error.instance = instance
  error.name = 'SendError'
  return error
}

/**
 * 把一次发送失败翻译成 SendError。
 * @param {any} error 客户端（OneBotError）或中途抛出的任何错误
 * @param {{ instance: string, isDefiniteFailure?: (e: any) => boolean }} ctx
 *        isDefiniteFailure：src/onebot/client.js 导出的同名函数，由调用方注入（平台端不复制它的逻辑）
 * @returns {Error & { certainty: 'not-sent'|'unknown', code?: string, instance: string }}
 */
export function toSendError(error, { instance, isDefiniteFailure } = {}) {
  // 已经是 SendError 形状的（我们自己刚造过、或客户端某处已经翻译过）：原样返回，别把判定改掉
  if (error && typeof error === 'object' && (error.certainty === 'not-sent' || error.certainty === 'unknown')) {
    if (!error.instance) error.instance = instance
    return error
  }

  const text = String(error?.data?.message || error?.message || error || '未知错误')
  // ① 现成的综合判定优先：它把「语音 highway 上传失败」这类特例都算进去了
  let definite = false
  try {
    definite = typeof isDefiniteFailure === 'function' ? Boolean(isDefiniteFailure(error)) : false
  } catch (inner) {
    definite = false
  }
  // ② 再按契约的三条硬判据补：transport → 确定没发出去；uncertain / 超时 / 连接断开 → unknown
  if (!definite && error?.transport === true && error?.uncertain !== true) definite = true
  const uncertain = error?.uncertain === true || /超时|timeout|timed?\s*out|连接断开|已停止|无法解析/i.test(text)
  if (uncertain) definite = false

  const certainty = definite ? 'not-sent' : 'unknown'
  // code 优先用网关给的 retcode（写日志时能对上），没有就用短标签
  const code = error?.data?.retcode !== undefined && error?.data?.retcode !== null && Number(error.data.retcode) !== 0
    ? String(error.data.retcode)
    : definite
      ? 'not-sent'
      : 'unknown'
  return makeSendError(certainty, code, instance, text)
}

/** 只有 not-sent 可以入补发队列 / 重试（网关会再判一次，这里是平台端自己的保险）。 */
export function isNotSent(error) {
  return Boolean(error) && typeof error === 'object' && error.certainty === 'not-sent'
}
