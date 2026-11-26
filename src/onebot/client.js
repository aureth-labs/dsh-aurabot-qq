// OneBot v11 客户端：HTTP 调接口，WS（Universal）收事件，断线自动重连。
// 只依赖 Node 自带的 fetch / WebSocket。

const RECONNECT_MIN = 2000
const RECONNECT_MAX = 30000
const STOP_TIMEOUT_MS = 5000
// 网关短暂不可用（SnowLuma 刚被重启、端口还没释放）时，发消息别直接丢：等一会儿再试
const RETRY_DELAYS = [1000, 3000, 5000]
// 同一个 message_id 在这个窗口内只处理一次：断开重连后网关重放、或旧 WS 还活着时，
// 同一条消息会从两条连接各来一遍，不去重的话主人一条命令会被执行两次。
const MESSAGE_DEDUPE_MS = 60_000

/** 消息事件的去重键；message_id 为空 / 0（本地合成的戳一戳、群文件等）时返回空串，不参与去重。 */
export function messageDedupeKey(event) {
  if (!event || event.post_type !== 'message') return ''
  const id = String(event.message_id ?? '')
  if (!id || id === '0') return ''
  const chat = event.message_type === 'group' ? `group:${event.group_id ?? ''}` : `private:${event.user_id ?? ''}`
  return `${chat}|${id}`
}

export class OneBotError extends Error {
  constructor(action, data, { transport = false, uncertain = false } = {}) {
    super(`${action} 失败：${data?.message || data?.wording || data?.retcode || '未知错误'}`)
    this.action = action
    this.data = data
    // transport = 根本没连上网关（可以重试）；业务错误（retcode 不为 0、超时但也可能已经发出去）不重试
    this.transport = transport
    this.uncertain = uncertain
  }
}

/** 只有确定没连上或网关明确拒绝时，才能换一种方式发送。 */
export function isDefiniteFailure(error) {
  if (error instanceof OneBotError && !error.uncertain && Number(error.data?.retcode || 0) !== 0 && /highway|upload/i.test(String(error.data?.message || error.message))) return true // 语音传不上去，消息肯定没发出去
  if (!(error instanceof OneBotError) || error.uncertain || /超时|timeout|timed?\s*out/i.test(String(error.data?.message || error.message))) return false
  return error.transport || error.data?.status === 'failed' || (error.data?.retcode != null && Number(error.data.retcode) !== 0)
}

// fetch 失败不一定是没连上：连接建立后断开时，网关可能已经收到了请求。
const notConnected = (error) => ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'].includes(error?.cause?.code)
const stoppedError = (action, uncertain = false) => new OneBotError(action, { message: 'QQ 网关客户端已停止' }, { uncertain })
const changedTransportError = (action) => Object.assign(
  new OneBotError(action, { message: 'QQ 网关连接或端点已变更，请重新核对' }),
  { code: 'ONEBOT_TRANSPORT_CHANGED' },
)

/**
 * @param {object} o
 * @param {() => {httpUrl:string, wsUrl:string, httpToken:string, wsToken:string}} o.endpoint 每次连接时现取
 * @param {(event: object) => void} o.onEvent
 * @param {(state: string, detail?: string) => void} [o.onState]
 * @param {{info:Function, warn:Function, debug:Function}} o.log
 */
export function createOneBotClient({ endpoint, onEvent, onState, log, retryDelays = RETRY_DELAYS }) {
  let ws = null
  let wsEndpoint = null
  let closingSocket = null
  let stopped = true
  let timer = null
  let backoff = RECONNECT_MIN
  let state = 'stopped'
  let echoSeq = 0
  let stopGeneration = 0
  let explicitlyStopped = false // 初次 start 前仍允许调用，stop 后须重新 start
  let hasConnected = false // 首次连上之前不要退避到 30 秒，网关一就绪就尽快接上
  const pending = new Map()
  const retryWaits = new Set()
  const closeWaiters = new Set()
  const httpRequests = new Set()
  const recentMessages = new Map() // messageDedupeKey → 过期时间

  function duplicateMessage(data) {
    const key = messageDedupeKey(data)
    if (!key) return false
    const now = Date.now()
    const expiresAt = recentMessages.get(key)
    if (expiresAt && expiresAt > now) return true
    recentMessages.set(key, now + MESSAGE_DEDUPE_MS)
    if (recentMessages.size > 1000) {
      for (const [k, exp] of recentMessages) if (exp <= now) recentMessages.delete(k)
      while (recentMessages.size > 1000) recentMessages.delete(recentMessages.keys().next().value)
    }
    return false
  }

  const setState = (s, detail) => {
    if (state === s) return
    state = s
    try { onState?.(s, detail) } catch (error) {}
  }

  const endpointFields = ['wsUrl', 'wsToken', 'httpUrl', 'httpToken']
  function readEndpoint() {
    const current = endpoint()
    return Object.fromEntries(endpointFields.map(key => [key, String(current?.[key] || '')]))
  }

  function bindingIsCurrent({ socket, ep }) {
    if (socket !== ws || socket.readyState !== 1 || state !== 'connected') return false
    const current = readEndpoint()
    return endpointFields.every(key => current[key] === ep[key])
  }

  /** 走一次 HTTP 或 WS；核对绑定的端点时不读取新的凭据发送。 */
  async function callOnce(action, params, timeoutMs, generation, { beforeDispatch, binding, transport }) {
    const ep = binding ? binding.ep : endpoint()
    function checkDispatch() {
      beforeDispatch?.()
      if (generation !== stopGeneration) throw stoppedError(action)
      if (binding && !bindingIsCurrent(binding)) throw changedTransportError(action)
    }
    checkDispatch()
    const socket = binding ? binding.socket : ws
    if (transport !== 'ws' && ep.httpUrl) {
      const ctrl = new AbortController()
      httpRequests.add(ctrl)
      const t = setTimeout(() => ctrl.abort(), timeoutMs)
      try {
        const headers = { 'content-type': 'application/json' }
        if (ep.httpToken) headers.authorization = `Bearer ${ep.httpToken}`
        const r = await fetch(`${ep.httpUrl.replace(/\/+$/, '')}/${action}`, {
          method: 'POST', headers, body: JSON.stringify(params), signal: ctrl.signal,
          ...(binding ? { redirect: 'error' } : {}),
        })
        let j
        try { j = await r.json() } catch (error) {
          if (error.name === 'AbortError') throw error
          throw new OneBotError(action, { message: `网关响应无法解析（HTTP ${r.status}）` }, { uncertain: true })
        }
        if (generation !== stopGeneration) throw stoppedError(action, true)
        if (j.status === 'ok' || j.retcode === 0) return j.data
        throw new OneBotError(action, j)
      } catch (error) {
        if (error instanceof OneBotError) throw error
        if (generation !== stopGeneration) throw stoppedError(action, !notConnected(error))
        // 超时可能是"已经发出去了只是没等到回执"，重试会重复发消息 —— 不重试
        if (error.name === 'AbortError') throw new OneBotError(action, { message: '超时' }, { uncertain: true })
        if (!notConnected(error)) throw new OneBotError(action, { message: describeNetError(error, ep) }, { uncertain: true })
        if (transport === 'auto' && socket && socket === ws && socket.readyState === 1) {
          checkDispatch()
          return await callWs(socket, action, params, timeoutMs)
        }
        throw new OneBotError(action, { message: describeNetError(error, ep) }, { transport: true })
      } finally {
        clearTimeout(t)
        httpRequests.delete(ctrl)
      }
    }
    if (transport === 'http') throw new OneBotError(action, { message: '未配置 HTTP 端点' })
    return callWs(socket, action, params, timeoutMs)
  }

  function describeNetError(error, ep) {
    const where = ep.httpUrl || ep.wsUrl || '(没配地址)'
    const why = error?.cause?.code || error?.cause?.message || error?.message || String(error)
    return `连不上 QQ 网关（${where}）：${why}`
  }

  async function callOnTransport(action, params = {}, { timeoutMs = 30000, retries = retryDelays.length, beforeDispatch } = {}, binding, transport = 'auto') {
    if (explicitlyStopped) throw stoppedError(action)
    const ep0 = binding ? binding.ep : endpoint()
    // 压根没配网关：立即失败，别让调用方白等重试（查群名之类的会立刻回退）
    if (!ep0.httpUrl && !ep0.wsUrl) {
      throw new OneBotError(action, { message: '还没配置 QQ 网关地址' }, { transport: true })
    }
    let lastError = null
    const generation = stopGeneration
    for (let i = 0; i <= retries; i++) {
      if (generation !== stopGeneration) throw stoppedError(action)
      try {
        return await callOnce(action, params, timeoutMs, generation, { beforeDispatch, binding, transport })
      } catch (error) {
        lastError = error
        if (generation !== stopGeneration) {
          throw error instanceof OneBotError && error.uncertain ? error : stoppedError(action)
        }
        // 业务错误（比如没权限、参数不对）重试也没用
        if (!(error instanceof OneBotError) || !error.transport) throw error
        if (i === retries) break
        const wait = retryDelays[i] ?? retryDelays[retryDelays.length - 1]
        log?.warn?.(`${action}：网关暂时连不上，${wait / 1000}s 后重试（${i + 1}/${retries}）`)
        if (generation !== stopGeneration) throw stoppedError(action)
        await new Promise((resolve) => {
          const done = () => { clearTimeout(timer); retryWaits.delete(done); resolve() }
          const timer = setTimeout(done, wait)
          retryWaits.add(done)
        })
      }
    }
    throw lastError
  }

  /** 捕获正在接收事件的 WS 与当前有效端点，供迁移核对和后续请求复用。 */
  function captureTransport() {
    const ep = readEndpoint()
    const socket = ws
    if (!socket || !wsEndpoint || state !== 'connected' || socket.readyState !== 1
      || ep.wsUrl !== wsEndpoint.wsUrl || ep.wsToken !== wsEndpoint.wsToken) {
      throw changedTransportError('get_login_info')
    }
    const binding = { socket, ep }
    return Object.freeze({
      hasHttp: Boolean(ep.httpUrl),
      isCurrent: () => bindingIsCurrent(binding),
      call(action, params, { transport = 'auto', ...opts } = {}) {
        if (transport !== 'auto' && transport !== 'http' && transport !== 'ws') {
          throw new TypeError('不支持的 OneBot 传输方式')
        }
        return callOnTransport(action, params, opts, binding, transport)
      },
    })
  }

  function callWs(socket, action, params, timeoutMs) {
    if (!socket || socket !== ws || socket.readyState !== 1) {
      return Promise.reject(new OneBotError(action, { message: '没连上 QQ 网关' }, { transport: true }))
    }
    const echo = `ab-${Date.now()}-${++echoSeq}`
    const frame = JSON.stringify({ action, params, echo })
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        pending.delete(echo)
        reject(new OneBotError(action, { message: '超时' }, { uncertain: true }))
      }, timeoutMs)
      pending.set(echo, { resolve, reject, t, action, socket })
      try {
        socket.send(frame)
      } catch (error) {
        clearTimeout(t)
        pending.delete(echo)
        reject(error)
      }
    })
  }

  function rejectSocketRequests(socket) {
    for (const [echo, request] of pending) {
      if (request.socket !== socket) continue
      clearTimeout(request.t)
      pending.delete(echo)
      request.reject(new OneBotError(request.action, { message: '连接断开' }, { uncertain: true }))
    }
  }

  function finishSocketClose() {
    closingSocket = null
    for (const done of closeWaiters) done()
  }

  function connect() {
    if (stopped || ws || closingSocket) return
    const ep = readEndpoint()
    if (!ep.wsUrl) {
      setState('unconfigured', '没有 WS 地址')
      schedule()
      return
    }
    setState('connecting')
    if (stopped || ws || closingSocket) return
    let url = ep.wsUrl
    if (ep.wsToken) url += (url.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(ep.wsToken)
    let sock
    try {
      sock = new WebSocket(url)
    } catch (error) {
      log.warn('WS 连接失败：', error.message)
      schedule()
      return
    }
    ws = sock
    wsEndpoint = ep
    sock.onopen = () => {
      if (ws !== sock) return
      hasConnected = true
      backoff = RECONNECT_MIN
      setState('connected')
      log.info('已连上 QQ 网关（WS）')
    }
    sock.onmessage = (ev) => {
      if (ws !== sock) return // 旧连接的残留消息不能再喂进来
      let data
      try { data = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')) } catch (error) { return }
      if (data && data.echo && pending.has(data.echo)) {
        const p = pending.get(data.echo)
        pending.delete(data.echo)
        clearTimeout(p.t)
        if (data.status === 'ok' || data.retcode === 0) p.resolve(data.data)
        else p.reject(new OneBotError(p.action, data))
        return
      }
      if (data && data.post_type) {
        if (duplicateMessage(data)) {
          log.debug?.(`忽略重复消息：${messageDedupeKey(data)}`)
          return
        }
        try { onEvent(data) } catch (error) { log.warn('处理事件出错：', error.message) }
      }
    }
    sock.onclose = (ev) => {
      if (closingSocket === sock) {
        finishSocketClose()
        connect()
        return
      }
      if (ws !== sock) return
      ws = null
      wsEndpoint = null
      rejectSocketRequests(sock)
      setState('disconnected', `code ${ev?.code ?? ''}`)
      schedule()
    }
    sock.onerror = () => {}
  }

  function schedule() {
    clearTimeout(timer)
    if (stopped || ws || closingSocket) return
    timer = setTimeout(connect, backoff)
    // 首次连接前（SnowLuma 正在登录 QQ、OneBot 端口还没起）最多等 3 秒；
    // 已经连过再断线才恢复到 30 秒，避免正常断线时刷屏。
    const cap = hasConnected ? RECONNECT_MAX : 3000
    backoff = Math.min(cap, Math.max(RECONNECT_MIN, backoff * 2))
  }

  function stop() {
    stopped = true
    explicitlyStopped = true
    stopGeneration++
    const socket = ws
    ws = null
    wsEndpoint = null
    if (socket && socket.readyState !== 3) closingSocket = socket
    for (const done of retryWaits) done()
    clearTimeout(timer)
    for (const request of httpRequests) request.abort()
    if (socket) {
      rejectSocketRequests(socket)
      if (closingSocket === socket) {
        try { socket.close() } catch (error) {}
      }
    }
    setState('stopped')
  }

  /** 等旧 WebSocket 真正关闭。超时后仍禁止在旧连接退场前启动新连接。 */
  async function stopAndWait({ timeoutMs = STOP_TIMEOUT_MS, signal } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError('timeoutMs 必须是有限的非负数')
    signal?.throwIfAborted()
    stop()
    if (!closingSocket) return
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(deadline)
        closeWaiters.delete(done)
        signal?.removeEventListener('abort', aborted)
      }
      const done = () => {
        cleanup()
        resolve()
      }
      const aborted = () => {
        cleanup()
        reject(signal.reason)
      }
      const deadline = setTimeout(() => {
        cleanup()
        reject(Object.assign(new Error('等待 QQ 网关 WebSocket 关闭超时'), { code: 'ONEBOT_CLOSE_TIMEOUT' }))
      }, timeoutMs)
      closeWaiters.add(done)
      signal?.addEventListener('abort', aborted, { once: true })
    })
  }

  function confirmStopped() {
    if (!explicitlyStopped || !stopped || ws || (closingSocket && closingSocket.readyState !== 3)) return false
    if (closingSocket) finishSocketClose()
    return true
  }

  return {
    call: (action, params, opts) => callOnTransport(action, params, opts),
    captureTransport,
    isConnected: () => state === 'connected',
    state: () => state,
    start() {
      if (!stopped) return
      explicitlyStopped = false
      stopped = false
      backoff = RECONNECT_MIN
      connect()
    },
    stop,
    stopAndWait,
    confirmStopped,
    restart() {
      this.stop()
      this.start()
    },
    get state() {
      return state
    },
  }
}
