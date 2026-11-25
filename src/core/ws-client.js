// 零第三方依赖 RFC 6455 WebSocket 客户端（仅使用 Node 内置 node:http / node:https / node:crypto）。
// 设计目的：发送标准 Title-Case 升级请求头（Host / Connection / Upgrade / Sec-WebSocket-Key / Sec-WebSocket-Version），
// 兼容对 HTTP Header 大小写敏感的网关（例如企业微信 wss://openws.work.weixin.qq.com 的 Wwebsvr 返回 404 问题），
// 同时避免 Node 内置 undici WebSocket 在非 101 握手失败时只抛出空 message 的裸 TypeError。

import http from 'node:http'
import https from 'node:https'
import { createHash, randomBytes } from 'node:crypto'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const DEFAULT_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024

export const WS_READY_STATE = Object.freeze({
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
})

export function normalizeWsError(errOrEvent, fallback = 'WebSocket 连接或握手失败') {
  const raw = errOrEvent && typeof errOrEvent === 'object' && 'error' in errOrEvent
    ? errOrEvent.error
    : errOrEvent
  const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '')
  const msg = clean(raw?.message)
    || clean(errOrEvent?.message)
    || clean(raw?.cause?.message)
    || clean(raw?.code)
  if (msg) {
    return raw instanceof Error && clean(raw.message) ? raw : new Error(msg)
  }
  const errName = clean(raw?.name)
  return new Error(errName ? `${errName}：${fallback}` : fallback)
}

function encodeClientFrame(opcode, payloadBuf, fin = true) {
  const data = Buffer.isBuffer(payloadBuf) ? payloadBuf : Buffer.from(payloadBuf || [])
  const len = data.length
  const b0 = (fin ? 0x80 : 0x00) | (opcode & 0x0f)

  let headerLen
  if (len < 126) headerLen = 6
  else if (len <= 0xffff) headerLen = 8
  else headerLen = 14

  const frame = Buffer.allocUnsafe(headerLen + len)
  frame[0] = b0
  if (len < 126) {
    frame[1] = 0x80 | len
  } else if (len <= 0xffff) {
    frame[1] = 0x80 | 126
    frame.writeUInt16BE(len, 2)
  } else {
    frame[1] = 0x80 | 127
    frame.writeBigUInt64BE(BigInt(len), 2)
  }

  const maskOffset = headerLen - 4
  const mask = randomBytes(4)
  mask.copy(frame, maskOffset)
  for (let i = 0; i < len; i++) {
    frame[headerLen + i] = data[i] ^ mask[i & 3]
  }
  return frame
}

function encodeCloseFrame(code, reason = '') {
  if (code === undefined || code === null) {
    return encodeClientFrame(0x08, Buffer.alloc(0), true)
  }
  const reasonBuf = Buffer.from(String(reason || ''), 'utf8').subarray(0, 123)
  const payload = Buffer.allocUnsafe(2 + reasonBuf.length)
  payload.writeUInt16BE(Number(code), 0)
  reasonBuf.copy(payload, 2)
  return encodeClientFrame(0x08, payload, true)
}

/**
 * 创建使用标准 Title-Case 握手头的轻量级 RFC 6455 WebSocket 客户端。
 * 同时兼容 DOM 风格（addEventListener/removeEventListener）与 Node/ws 风格（on/off/removeListener）。
 *
 * @param {string} rawUrl
 * @param {{ headers?: Record<string, string>, maxPayloadBytes?: number }=} options
 */
export function createTitleCaseWebSocket(rawUrl, options = {}) {
  const parsed = new URL(String(rawUrl || ''))
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new TypeError(`不支持的 WebSocket 协议：${parsed.protocol}`)
  }

  const isWss = parsed.protocol === 'wss:'
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
  const port = parsed.port ? Number(parsed.port) : (isWss ? 443 : 80)
  const hostHeader = parsed.host
  const path = (parsed.pathname || '/') + (parsed.search || '')
  const maxPayloadBytes = Math.max(1024, Number(options.maxPayloadBytes) || DEFAULT_MAX_PAYLOAD_BYTES)

  const wsKey = randomBytes(16).toString('base64')
  const expectedAccept = createHash('sha1').update(`${wsKey}${WS_GUID}`).digest('base64')
  const customHeaders = options.headers && typeof options.headers === 'object' ? options.headers : {}
  const headers = {
    Host: hostHeader,
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Key': wsKey,
    'Sec-WebSocket-Version': '13',
    ...customHeaders,
  }

  // 使用普通 Map 管理监听器（不继承 EventEmitter），保证未挂载 error 监听时不会引发未捕获异常崩溃。
  const listeners = new Map()
  let readyState = WS_READY_STATE.CONNECTING
  let handshakeSettled = false
  let closeEmitted = false
  let protocolStopped = false
  let closeCode = 1006
  let closeReason = ''
  let forceCloseTimer = null
  let socket = null

  let rxBuffer = Buffer.alloc(0)
  let fragOpcode = 0
  let fragChunks = []
  let fragTotalBytes = 0

  function addEntry(type, style, fn, once = false) {
    if (typeof fn !== 'function') return
    const key = String(type || '')
    let set = listeners.get(key)
    if (!set) {
      set = []
      listeners.set(key, set)
    }
    if (style === 'dom' && set.some((e) => e.style === 'dom' && e.fn === fn)) return
    set.push({ style, fn, once: Boolean(once) })
  }

  function removeEntry(type, style, fn) {
    const key = String(type || '')
    const set = listeners.get(key)
    if (!set || !set.length) return
    const next = set.filter((e) => !(e.fn === fn && (style === 'any' || e.style === style)))
    if (next.length) listeners.set(key, next)
    else listeners.delete(key)
  }

  function emitEvent(type, nodeArgs, domEvent) {
    const key = String(type || '')
    const set = listeners.get(key)
    if (!set || !set.length) return
    const snapshot = [...set]
    const onceList = snapshot.filter((e) => e.once)
    if (onceList.length) {
      const remaining = set.filter((e) => !e.once)
      if (remaining.length) listeners.set(key, remaining)
      else listeners.delete(key)
    }
    for (const entry of snapshot) {
      if (entry.style === 'dom') entry.fn(domEvent)
      else entry.fn(...nodeArgs)
    }
  }

  function clearForceCloseTimer() {
    if (forceCloseTimer) {
      clearTimeout(forceCloseTimer)
      forceCloseTimer = null
    }
  }

  function emitCloseOnce(code = closeCode, reason = closeReason) {
    if (closeEmitted) return
    closeEmitted = true
    readyState = WS_READY_STATE.CLOSED
    clearForceCloseTimer()
    emitEvent('close', [code, reason], { code, reason })
  }

  function armForceCloseTimer() {
    if (forceCloseTimer || closeEmitted) return
    forceCloseTimer = setTimeout(() => {
      forceCloseTimer = null
      try { socket?.destroy() } catch {}
      emitCloseOnce(closeCode, closeReason)
    }, 1000)
    forceCloseTimer.unref?.()
  }

  function failBeforeOpen(err) {
    if (handshakeSettled) return
    handshakeSettled = true
    readyState = WS_READY_STATE.CLOSED
    try { req?.destroy() } catch {}
    try { socket?.destroy() } catch {}
    const norm = normalizeWsError(err, 'WebSocket 握手失败')
    emitEvent('error', [norm], { error: norm, message: norm.message })
    emitCloseOnce(1006, '')
  }

  function failProtocol(errCode, message) {
    protocolStopped = true
    const err = new Error(message)
    emitEvent('error', [err], { error: err, message: err.message })
    if (readyState === WS_READY_STATE.OPEN) {
      closeCode = errCode
      closeReason = message
      readyState = WS_READY_STATE.CLOSING
      try { socket?.write(encodeCloseFrame(errCode, message)) } catch {}
      try { socket?.end() } catch {}
      armForceCloseTimer()
    } else {
      try { socket?.destroy() } catch {}
      emitCloseOnce(errCode, message)
    }
  }

  function emitDataPayload(opcode, payload) {
    if (opcode === 0x01) {
      const text = payload.toString('utf8')
      emitEvent('message', [text], { data: text })
      return
    }
    emitEvent('message', [payload], { data: payload })
  }

  function feedBytes(chunk) {
    if (protocolStopped || closeEmitted) return
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (!incoming.length) return
    rxBuffer = rxBuffer.length ? Buffer.concat([rxBuffer, incoming]) : incoming

    while (!protocolStopped && !closeEmitted && rxBuffer.length >= 2) {
      const b0 = rxBuffer[0]
      const b1 = rxBuffer[1]
      const fin = (b0 & 0x80) !== 0
      const rsv = b0 & 0x70
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let payloadLen = b1 & 0x7f

      if (rsv !== 0) {
        failProtocol(1002, '不支持非零 WebSocket RSV 扩展位')
        return
      }

      let offset = 2
      if (payloadLen === 126) {
        if (rxBuffer.length < 4) break
        payloadLen = rxBuffer.readUInt16BE(2)
        offset = 4
      } else if (payloadLen === 127) {
        if (rxBuffer.length < 10) break
        const bigLen = rxBuffer.readBigUInt64BE(2)
        if (bigLen > BigInt(maxPayloadBytes)) {
          failProtocol(1009, `WebSocket 单帧长度超限（${bigLen} > ${maxPayloadBytes}）`)
          return
        }
        payloadLen = Number(bigLen)
        offset = 10
      }

      if (payloadLen > maxPayloadBytes) {
        failProtocol(1009, `WebSocket 单帧长度超限（${payloadLen} > ${maxPayloadBytes}）`)
        return
      }

      if (opcode >= 0x08 && (!fin || payloadLen > 125)) {
        failProtocol(1002, 'WebSocket 控制帧格式无效')
        return
      }

      const maskLen = masked ? 4 : 0
      const frameTotal = offset + maskLen + payloadLen
      if (rxBuffer.length < frameTotal) break

      let payload = rxBuffer.subarray(offset + maskLen, frameTotal)
      if (masked) {
        const mask = rxBuffer.subarray(offset, offset + 4)
        const unmasked = Buffer.allocUnsafe(payloadLen)
        for (let i = 0; i < payloadLen; i++) {
          unmasked[i] = payload[i] ^ mask[i & 3]
        }
        payload = unmasked
      } else {
        payload = Buffer.from(payload)
      }
      rxBuffer = frameTotal === rxBuffer.length ? Buffer.alloc(0) : Buffer.from(rxBuffer.subarray(frameTotal))

      if (opcode === 0x09) {
        if (readyState === WS_READY_STATE.OPEN && socket && !socket.destroyed) {
          try { socket.write(encodeClientFrame(0x0a, payload, true)) } catch {}
        }
        continue
      }
      if (opcode === 0x0a) {
        emitEvent('pong', [payload], { data: payload })
        continue
      }
      if (opcode === 0x08) {
        let peerCode = 1005
        let peerReason = ''
        if (payload.length >= 2) {
          peerCode = payload.readUInt16BE(0)
          peerReason = payload.subarray(2).toString('utf8')
        } else if (payload.length === 1) {
          peerCode = 1002
        }
        closeCode = peerCode
        closeReason = peerReason
        if (readyState === WS_READY_STATE.OPEN) {
          readyState = WS_READY_STATE.CLOSING
          const echoPayload = payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0)
          try { socket?.write(encodeClientFrame(0x08, echoPayload, true)) } catch {}
          try { socket?.end() } catch {}
          armForceCloseTimer()
        } else if (readyState === WS_READY_STATE.CLOSING) {
          try { socket?.end() } catch {}
        }
        continue
      }
      if (opcode >= 0x08) {
        failProtocol(1002, `未知 WebSocket 控制帧 opcode=${opcode}`)
        return
      }

      if (opcode === 0x01 || opcode === 0x02) {
        if (fragOpcode !== 0) {
          failProtocol(1002, '收到未结束分片的新 WebSocket 数据帧')
          return
        }
        if (fin) {
          emitDataPayload(opcode, payload)
        } else {
          fragOpcode = opcode
          fragChunks = payload.length ? [payload] : []
          fragTotalBytes = payload.length
        }
        continue
      }

      if (opcode === 0x00) {
        if (fragOpcode === 0) {
          failProtocol(1002, '收到孤立的 WebSocket 延续帧')
          return
        }
        if (fragTotalBytes + payload.length > maxPayloadBytes) {
          failProtocol(1009, `WebSocket 分片消息总长度超限（>${maxPayloadBytes}）`)
          return
        }
        if (payload.length) {
          fragChunks.push(payload)
          fragTotalBytes += payload.length
        }
        if (fin) {
          const full = fragChunks.length === 1 ? fragChunks[0] : Buffer.concat(fragChunks, fragTotalBytes)
          const msgOpcode = fragOpcode
          fragOpcode = 0
          fragChunks = []
          fragTotalBytes = 0
          emitDataPayload(msgOpcode, full)
        }
        continue
      }

      failProtocol(1002, `未知 WebSocket 数据帧 opcode=${opcode}`)
      return
    }
  }

  const transport = isWss ? https : http
  const req = transport.request({
    hostname,
    port,
    path,
    method: 'GET',
    agent: false,
    headers,
  })

  req.on('response', (res) => {
    try { res.resume() } catch {}
    const status = res?.statusCode || '?'
    const reason = res?.statusMessage ? ` ${res.statusMessage}` : ''
    failBeforeOpen(new Error(`WebSocket 握手失败：HTTP ${status}${reason}`))
  })

  req.on('error', (err) => {
    if (!handshakeSettled) failBeforeOpen(normalizeWsError(err, 'WebSocket 连接失败'))
  })

  req.on('close', () => {
    if (!handshakeSettled) failBeforeOpen(new Error('WebSocket 握手期间连接意外关闭'))
  })

  req.on('upgrade', (res, sock, head) => {
    if (handshakeSettled || readyState !== WS_READY_STATE.CONNECTING) {
      try { sock?.destroy() } catch {}
      return
    }
    const status = Number(res?.statusCode || 0)
    const accept = String(res?.headers?.['sec-websocket-accept'] || '').trim()
    if (status !== 101 || accept !== expectedAccept) {
      try { sock?.destroy() } catch {}
      failBeforeOpen(new Error(`WebSocket 握手校验失败：HTTP ${status || '?'}（Sec-WebSocket-Accept 不匹配）`))
      return
    }

    handshakeSettled = true
    socket = sock
    sock.setNoDelay?.(true)
    sock.setTimeout?.(0)
    readyState = WS_READY_STATE.OPEN

    sock.on('data', (chunk) => feedBytes(chunk))
    sock.on('error', (err) => {
      const norm = normalizeWsError(err, 'WebSocket 传输错误')
      emitEvent('error', [norm], { error: norm, message: norm.message })
    })
    sock.on('close', () => {
      emitCloseOnce(closeCode, closeReason)
    })

    emitEvent('open', [], {})
    if (head && head.length > 0 && !closeEmitted) {
      feedBytes(head)
    }
  })

  req.end()

  return {
    CONNECTING: WS_READY_STATE.CONNECTING,
    OPEN: WS_READY_STATE.OPEN,
    CLOSING: WS_READY_STATE.CLOSING,
    CLOSED: WS_READY_STATE.CLOSED,
    url: parsed.href,
    get readyState() {
      return readyState
    },
    addEventListener(type, fn, opts) {
      addEntry(type, 'dom', fn, Boolean(opts?.once))
    },
    removeEventListener(type, fn) {
      removeEntry(type, 'dom', fn)
    },
    on(type, fn) {
      addEntry(type, 'node', fn, false)
    },
    once(type, fn) {
      addEntry(type, 'node', fn, true)
    },
    off(type, fn) {
      removeEntry(type, 'node', fn)
    },
    removeListener(type, fn) {
      removeEntry(type, 'node', fn)
    },
    send(data) {
      if (readyState !== WS_READY_STATE.OPEN || !socket || socket.destroyed) {
        throw new Error(`WebSocket 未处于 OPEN 状态（readyState=${readyState}），无法发送`)
      }
      let opcode = 0x01
      let buf
      if (typeof data === 'string') {
        buf = Buffer.from(data, 'utf8')
      } else if (Buffer.isBuffer(data)) {
        opcode = 0x02
        buf = data
      } else if (data instanceof ArrayBuffer) {
        opcode = 0x02
        buf = Buffer.from(data)
      } else if (ArrayBuffer.isView(data)) {
        opcode = 0x02
        buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      } else {
        buf = Buffer.from(String(data ?? ''), 'utf8')
      }
      socket.write(encodeClientFrame(opcode, buf, true))
    },
    ping(data = '') {
      if (readyState !== WS_READY_STATE.OPEN || !socket || socket.destroyed) return false
      const buf = Buffer.isBuffer(data)
        ? data.subarray(0, 125)
        : Buffer.from(String(data ?? ''), 'utf8').subarray(0, 125)
      socket.write(encodeClientFrame(0x09, buf, true))
      return true
    },
    close(code = 1000, reason = '') {
      if (readyState === WS_READY_STATE.CLOSED || readyState === WS_READY_STATE.CLOSING) return
      if (readyState === WS_READY_STATE.CONNECTING) {
        handshakeSettled = true
        readyState = WS_READY_STATE.CLOSED
        closeCode = 1006
        closeReason = ''
        try { req.destroy() } catch {}
        try { socket?.destroy() } catch {}
        emitCloseOnce(1006, '')
        return
      }
      if (readyState === WS_READY_STATE.OPEN) {
        readyState = WS_READY_STATE.CLOSING
        const validCode = Number.isInteger(code) && (code === 1000 || (code >= 3000 && code <= 4999))
          ? code
          : 1000
        const reasonText = String(reason || '')
        closeCode = validCode
        closeReason = reasonText
        try { socket?.write(encodeCloseFrame(validCode, reasonText)) } catch {}
        try { socket?.end() } catch {}
        armForceCloseTimer()
      }
    },
  }
}
