import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { createTitleCaseWebSocket, WS_READY_STATE } from '../../src/core/ws-client.js'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function encodeServerFrame(opcode, payloadBuf, fin = true) {
  const data = Buffer.isBuffer(payloadBuf) ? payloadBuf : Buffer.from(payloadBuf || [])
  const len = data.length
  const b0 = (fin ? 0x80 : 0x00) | (opcode & 0x0f)
  let header
  if (len < 126) {
    header = Buffer.from([b0, len])
  } else if (len <= 0xffff) {
    header = Buffer.allocUnsafe(4)
    header[0] = b0
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.allocUnsafe(10)
    header[0] = b0
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, data])
}

function createFrameDecoder(onFrame) {
  let buf = Buffer.alloc(0)
  return (chunk) => {
    buf = Buffer.concat([buf, chunk])
    while (buf.length >= 2) {
      const b0 = buf[0]
      const b1 = buf[1]
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let len = b1 & 0x7f
      let offset = 2
      if (len === 126) {
        if (buf.length < 4) break
        len = buf.readUInt16BE(2)
        offset = 4
      } else if (len === 127) {
        if (buf.length < 10) break
        len = Number(buf.readBigUInt64BE(2))
        offset = 10
      }
      const maskLen = masked ? 4 : 0
      const total = offset + maskLen + len
      if (buf.length < total) break
      let payload = buf.subarray(offset + maskLen, total)
      if (masked) {
        const mask = buf.subarray(offset, offset + 4)
        const out = Buffer.allocUnsafe(len)
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3]
        payload = out
      }
      buf = buf.subarray(total)
      onFrame({ fin, opcode, masked, payload })
    }
  }
}

async function startTestServer(onUpgrade, onRequest = null) {
  const server = http.createServer((req, res) => {
    if (onRequest) {
      onRequest(req, res)
      return
    }
    res.writeHead(404, 'Not Found')
    res.end()
  })
  server.on('upgrade', onUpgrade)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `ws://127.0.0.1:${port}/bot`,
    close: () => {
      server.closeAllConnections?.()
      return new Promise((resolve) => server.close(resolve))
    },
  }
}

test('createTitleCaseWebSocket 校验协议并拒绝非法 URL', () => {
  assert.throws(() => createTitleCaseWebSocket('not-a-url'), TypeError)
  assert.throws(() => createTitleCaseWebSocket('https://example.com/ws'), TypeError)
})

test('发送精确 Title-Case 握手头，且支持 7B/2000B/70000B 掩码往返', async (t) => {
  const seenHeaders = []
  const clientFrames = []
  const srv = await startTestServer((req, socket) => {
    seenHeaders.push(req.rawHeaders)
    const key = req.headers['sec-websocket-key']
    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    const feed = createFrameDecoder((f) => {
      clientFrames.push(f)
      if (f.opcode === 0x01) {
        socket.write(encodeServerFrame(0x01, f.payload, true))
      } else if (f.opcode === 0x08) {
        socket.write(encodeServerFrame(0x08, f.payload.subarray(0, 2), true))
        socket.end()
      }
    })
    socket.on('data', feed)
  })
  t.after(() => srv.close())

  const ws = createTitleCaseWebSocket(srv.url)
  assert.equal(ws.readyState, WS_READY_STATE.CONNECTING)

  const received = []
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', (ev) => reject(ev.error))
  })
  assert.equal(ws.readyState, WS_READY_STATE.OPEN)

  const headerNames = []
  for (let i = 0; i < seenHeaders[0].length; i += 2) headerNames.push(seenHeaders[0][i])
  for (const required of ['Host', 'Connection', 'Upgrade', 'Sec-WebSocket-Key', 'Sec-WebSocket-Version']) {
    assert.ok(headerNames.includes(required), `缺少精确 Title-Case 头：${required}（实际：${headerNames.join(', ')}）`)
    assert.equal(headerNames.filter((h) => h.toLowerCase() === required.toLowerCase()).length, 1)
  }

  ws.addEventListener('message', (ev) => received.push(ev.data))
  const payloads = ['hi-ws', 'M'.repeat(2000), 'L'.repeat(70_000)]
  for (const p of payloads) ws.send(p)

  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (received.length === payloads.length) {
        clearInterval(check)
        resolve()
      }
    }, 10)
  })
  assert.deepEqual(received, payloads)
  for (const f of clientFrames.filter((x) => x.opcode === 0x01)) {
    assert.equal(f.masked, true)
  }

  const closed = await new Promise((resolve) => {
    ws.addEventListener('close', (ev) => resolve(ev))
    ws.close(1000, 'done')
  })
  assert.equal(closed.code, 1000)
  assert.equal(ws.readyState, WS_READY_STATE.CLOSED)
})

test('非 101 握手响应与 Sec-WebSocket-Accept 不匹配返回明确错误并触发 1006 close', async (t) => {
  const srv404 = await startTestServer((_req, socket) => {
    socket.write('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
    socket.end()
  })
  t.after(() => srv404.close())

  const ws1 = createTitleCaseWebSocket(srv404.url)
  const events1 = []
  await new Promise((resolve) => {
    ws1.on('error', (err) => events1.push(['error', err.message]))
    ws1.on('close', (code) => {
      events1.push(['close', code])
      resolve()
    })
  })
  assert.equal(events1[0][0], 'error')
  assert.match(events1[0][1], /404/)
  assert.deepEqual(events1[1], ['close', 1006])

  const srvBadAccept = await startTestServer((_req, socket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: wrong==\r\n\r\n',
    )
    socket.end()
  })
  t.after(() => srvBadAccept.close())

  const ws2 = createTitleCaseWebSocket(srvBadAccept.url)
  const events2 = []
  await new Promise((resolve) => {
    ws2.addEventListener('error', (ev) => events2.push(['error', ev.message]))
    ws2.addEventListener('close', (ev) => {
      events2.push(['close', ev.code])
      resolve()
    })
  })
  assert.equal(events2[0][0], 'error')
  assert.match(events2[0][1], /Sec-WebSocket-Accept/)
  assert.deepEqual(events2[1], ['close', 1006])
})

test('支持 upgrade head 粘包帧、分片重组、穿插 Ping/Pong 与 Node 风格 on/off API', async (t) => {
  const serverSaw = []
  const srv = await startTestServer((req, socket) => {
    const key = req.headers['sec-websocket-key']
    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
    const piggyback = encodeServerFrame(0x01, Buffer.from('first-in-head', 'utf8'), true)
    socket.write(
      Buffer.concat([
        Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`),
        piggyback,
      ]),
    )

    const feed = createFrameDecoder((f) => {
      serverSaw.push(f)
      if (f.opcode === 0x0a) {
        // 收到客户端对穿插 ping 的 pong 后结束
        socket.write(encodeServerFrame(0x08, Buffer.from([0x03, 0xe8]), true))
        socket.end()
      }
    })
    socket.on('data', feed)

    setTimeout(() => {
      // 发送分片文本帧（hello + ping + world!），中间穿插控制帧 ping
      const part1 = encodeServerFrame(0x01, Buffer.from('hello-', 'utf8'), false)
      const ping = encodeServerFrame(0x09, Buffer.from('hb-1', 'utf8'), true)
      const part2 = encodeServerFrame(0x00, Buffer.from('world!', 'utf8'), true)
      // 刻意按单字节碎片拆写，覆盖半帧边界重组
      const combined = Buffer.concat([part1, ping, part2])
      socket.write(combined.subarray(0, 5))
      setTimeout(() => socket.write(combined.subarray(5)), 15)
    }, 20)
  })
  t.after(() => srv.close())

  const ws = createTitleCaseWebSocket(srv.url)
  const msgs = []
  const tempFn = () => {
    throw new Error('should have been removed')
  }
  ws.on('message', tempFn)
  ws.off('message', tempFn)
  ws.on('message', (data) => msgs.push(data))

  await new Promise((resolve, reject) => {
    ws.on('error', reject)
    ws.on('close', (code) => resolve(code))
  })

  assert.deepEqual(msgs, ['first-in-head', 'hello-world!'])
  const pongs = serverSaw.filter((f) => f.opcode === 0x0a)
  assert.equal(pongs.length, 1)
  assert.equal(pongs[0].masked, true)
  assert.equal(pongs[0].payload.toString('utf8'), 'hb-1')
})

test('支持在 CONNECTING 阶段调用 close(1000) 立即中止握手并触发 close(1006)', async (t) => {
  const pendingSockets = []
  const srv = await startTestServer((_req, socket) => {
    pendingSockets.push(socket)
  })
  t.after(async () => {
    for (const s of pendingSockets) s.destroy()
    await srv.close()
  })

  const ws = createTitleCaseWebSocket(srv.url)
  let errCount = 0
  ws.on('error', () => { errCount++ })
  const closedCode = await new Promise((resolve) => {
    ws.on('close', (code) => resolve(code))
    ws.close(1000, 'abort-early')
  })
  assert.equal(closedCode, 1006)
  assert.equal(errCount, 0)
  assert.equal(ws.readyState, WS_READY_STATE.CLOSED)
})

test('16-bit 长度帧超出 maxPayloadBytes 时立即报错并按 1009 关闭', async (t) => {
  const srvSockets = []
  const srv = await startTestServer((req, socket) => {
    srvSockets.push(socket)
    const key = req.headers['sec-websocket-key']
    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    socket.on('data', () => {})
    setTimeout(() => {
      socket.write(encodeServerFrame(0x01, Buffer.alloc(2000, 0x41), true))
    }, 10)
  })
  t.after(async () => {
    for (const s of srvSockets) s.destroy()
    await srv.close()
  })

  const ws = createTitleCaseWebSocket(srv.url, { maxPayloadBytes: 1024 })
  const events = []
  await new Promise((resolve) => {
    ws.on('error', (err) => events.push(['error', err.message]))
    ws.on('close', (code) => {
      events.push(['close', code])
      resolve()
    })
  })
  assert.equal(events[0][0], 'error')
  assert.match(events[0][1], /超限/)
  assert.deepEqual(events[1], ['close', 1009])
})

test('按 RFC 6455 拒绝服务端发送的 masked 帧并回发 1002 close', async (t) => {
  const srvSockets = []
  const clientFrames = []
  const srv = await startTestServer((req, socket) => {
    srvSockets.push(socket)
    const key = req.headers['sec-websocket-key']
    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    const feed = createFrameDecoder((f) => {
      clientFrames.push(f)
      if (f.opcode === 0x08) socket.end()
    })
    socket.on('data', feed)
    setTimeout(() => {
      const plain = Buffer.from('bad-masked', 'utf8')
      const mask = Buffer.from([0x12, 0x34, 0x56, 0x78])
      const frame = Buffer.allocUnsafe(6 + plain.length)
      frame[0] = 0x81
      frame[1] = 0x80 | plain.length
      mask.copy(frame, 2)
      for (let i = 0; i < plain.length; i++) frame[6 + i] = plain[i] ^ mask[i & 3]
      socket.write(frame)
    }, 10)
  })
  t.after(async () => {
    for (const s of srvSockets) s.destroy()
    await srv.close()
  })

  const ws = createTitleCaseWebSocket(srv.url)
  const messages = []
  const events = []
  ws.on('message', (data) => messages.push(data))
  await new Promise((resolve) => {
    ws.on('error', (err) => events.push(['error', err.message]))
    ws.on('close', (code, reason) => {
      events.push(['close', code, reason])
      resolve()
    })
  })
  assert.deepEqual(messages, [])
  assert.equal(events[0][0], 'error')
  assert.match(events[0][1], /MASK/)
  assert.equal(events[1][0], 'close')
  assert.equal(events[1][1], 1002)
  const closeFrame = clientFrames.find((f) => f.opcode === 0x08)
  assert.ok(closeFrame, '客户端应向服务端发送 close 帧')
  assert.equal(closeFrame.payload.readUInt16BE(0), 1002)
})

test('控制帧 ping/pong：服务端 ping 触发客户端 ping 事件并自动回 pong；ws.ping() 触发 pong 事件', async (t) => {
  const srvSockets = []
  const clientFrames = []
  const srv = await startTestServer((req, socket) => {
    srvSockets.push(socket)
    const key = req.headers['sec-websocket-key']
    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    const feed = createFrameDecoder((f) => {
      clientFrames.push(f)
      if (f.opcode === 0x09) {
        socket.write(encodeServerFrame(0x0a, f.payload, true))
      } else if (f.opcode === 0x08) {
        socket.write(encodeServerFrame(0x08, f.payload.subarray(0, 2), true))
        socket.end()
      }
    })
    socket.on('data', feed)
    setTimeout(() => {
      socket.write(encodeServerFrame(0x09, Buffer.from('srv-hb', 'utf8'), true))
    }, 10)
  })
  t.after(async () => {
    for (const s of srvSockets) s.destroy()
    await srv.close()
  })

  const ws = createTitleCaseWebSocket(srv.url)
  const nodePings = []
  const domPings = []
  const nodePongs = []
  ws.on('ping', (data) => nodePings.push(Buffer.from(data).toString('utf8')))
  ws.addEventListener('ping', (ev) => domPings.push(Buffer.from(ev.data).toString('utf8')))
  ws.on('pong', (data) => nodePongs.push(Buffer.from(data).toString('utf8')))

  await new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
  })
  for (let i = 0; i < 100 && nodePings.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
  for (let i = 0; i < 100 && !clientFrames.some((f) => f.opcode === 0x0a); i++) await new Promise((r) => setTimeout(r, 10))

  assert.deepEqual(nodePings, ['srv-hb'])
  assert.deepEqual(domPings, ['srv-hb'])
  const replyPong = clientFrames.find((f) => f.opcode === 0x0a)
  assert.ok(replyPong, '收到服务端 ping 应自动回发 pong')
  assert.equal(replyPong.masked, true)
  assert.equal(replyPong.payload.toString('utf8'), 'srv-hb')

  assert.equal(ws.ping('hb-client'), true)
  for (let i = 0; i < 100 && nodePongs.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(nodePongs, ['hb-client'])
  const clientPing = clientFrames.find((f) => f.opcode === 0x09)
  assert.ok(clientPing && clientPing.masked && clientPing.payload.toString('utf8') === 'hb-client')

  await new Promise((resolve) => {
    ws.on('close', resolve)
    ws.close(1000, 'done')
  })
})
