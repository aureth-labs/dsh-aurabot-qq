import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createOneBotClient } from '../src/onebot/client.js'

function createHarness(t, { httpUrl = '' } = {}) {
  const sockets = []
  const events = []
  const states = []
  const endpoint = { wsUrl: 'ws://127.0.0.1:3001', wsToken: '', httpUrl, httpToken: '' }
  const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket')
  class FakeSocket {
    constructor() {
      this.readyState = 0
      this.frames = []
      sockets.push(this)
    }

    open() {
      this.readyState = 1
      this.onopen()
    }

    send(frame) {
      this.frames.push(JSON.parse(frame))
    }

    receive(data) {
      this.onmessage({ data: JSON.stringify(data) })
    }

    close() {
      this.readyState = 2
    }

    finishClose() {
      this.readyState = 3
      this.onclose({ code: 1000 })
    }
  }
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FakeSocket })
  const client = createOneBotClient({
    endpoint: () => endpoint,
    onEvent: (event) => events.push(event),
    onState: (state) => states.push(state),
    log: { info() {}, warn() {} },
  })
  t.after(() => {
    client.stop()
    for (const socket of sockets) {
      if (socket.readyState !== 3) socket.finishClose()
    }
    Object.defineProperty(globalThis, 'WebSocket', originalWebSocket)
  })
  client.start()
  sockets[0].open()
  return { client, endpoint, events, sockets, states }
}

test('stopAndWait 等到旧 WS 实际关闭，停止后丢弃旧事件和在途回执', async (t) => {
  const { client, events, sockets } = createHarness(t)
  const [oldSocket] = sockets
  const delivery = assert.rejects(client.call('send_private_msg', {}), { uncertain: true })
  const [sent] = oldSocket.frames
  let completed = false
  const closing = client.stopAndWait().then(() => { completed = true })
  oldSocket.receive({ post_type: 'message', message_id: 1 })
  oldSocket.receive({ echo: sent.echo, status: 'ok', data: { message_id: 1 } })
  await delivery
  assert.equal(client.state, 'stopped')
  assert.equal(client.confirmStopped(), false)
  assert.equal(oldSocket.readyState, 2)
  assert.equal(completed, false)
  assert.deepEqual(events, [])
  oldSocket.readyState = 3
  assert.equal(client.confirmStopped(), true)
  await closing
  assert.equal(completed, true)
  client.start()
  oldSocket.finishClose()
  assert.equal(sockets.length, 2)
  assert.equal(client.state, 'connecting')
})

test('stopAndWait 超时后仍等待旧 WS 退出才能启动新连接', async (t) => {
  const { client, sockets } = createHarness(t)
  const [oldSocket] = sockets
  const abort = new AbortController()
  const stopped = client.stopAndWait({ signal: abort.signal })
  abort.abort()
  await assert.rejects(stopped, { name: 'AbortError' })
  await assert.rejects(client.stopAndWait({ timeoutMs: 5 }), { code: 'ONEBOT_CLOSE_TIMEOUT' })
  client.start()
  assert.equal(sockets.length, 1)
  assert.equal(oldSocket.readyState, 2)
  oldSocket.finishClose()
  assert.equal(sockets.length, 2)
  assert.equal(client.state, 'connecting')
})

test('restart 等待旧连接关闭，旧连接回调不会影响新连接', async (t) => {
  const { client, events, sockets, states } = createHarness(t)
  const [oldSocket] = sockets
  client.restart()
  assert.equal(client.state, 'stopped')
  assert.equal(sockets.length, 1)
  oldSocket.finishClose()
  const newSocket = sockets[1]
  newSocket.open()
  const delivery = client.call('get_login_info')
  const [sent] = newSocket.frames
  oldSocket.receive({ post_type: 'message', message_id: 1 })
  oldSocket.receive({ echo: sent.echo, status: 'ok', data: { user_id: 'stale' } })
  oldSocket.finishClose()
  newSocket.receive({ echo: sent.echo, status: 'ok', data: { user_id: 'current' } })
  newSocket.receive({ post_type: 'message', message_id: 2 })
  assert.deepEqual(await delivery, { user_id: 'current' })
  assert.deepEqual(events.map((event) => event.message_id), [2])
  assert.deepEqual(states, ['connecting', 'connected', 'stopped', 'connecting', 'connected'])
})

test('停止时取消旧 HTTP 请求，迟到的结果保留投递不确定语义', async (t) => {
  const { client } = createHarness(t, { httpUrl: 'http://127.0.0.1:3000' })
  let respond
  let signal
  const fetch = t.mock.method(globalThis, 'fetch', async (_url, options) => {
    signal = options.signal
    return await new Promise((resolve) => { respond = resolve })
  })
  const delivery = assert.rejects(client.call('send_private_msg', {}), { uncertain: true })
  client.restart()
  assert.equal(signal.aborted, true)
  respond(Response.json({ status: 'ok', data: { message_id: 1 } }))
  await delivery
  assert.equal(fetch.mock.callCount(), 1)
})

test('迁移核对按指定通道发送，HTTP 连不上时不能用 WS 证明 HTTP 身份', async (t) => {
  const { client, sockets } = createHarness(t, { httpUrl: 'http://127.0.0.1:3000' })
  const [socket] = sockets
  const fetch = t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.redirect, 'error')
    throw new Error('offline', { cause: { code: 'ECONNREFUSED' } })
  })
  const transport = client.captureTransport()
  const wsReply = transport.call('get_login_info', {}, { transport: 'ws', retries: 0 })
  assert.equal(fetch.mock.callCount(), 0)
  socket.receive({ echo: socket.frames[0].echo, status: 'ok', data: { user_id: 10000 } })
  assert.deepEqual(await wsReply, { user_id: 10000 })
  await assert.rejects(transport.call('get_login_info', {}, { transport: 'http', retries: 0 }), { transport: true })
  assert.equal(fetch.mock.callCount(), 1)
  assert.equal(socket.frames.length, 1)
})

test('迁移请求在端点或收消息的 WS 变更后拒绝使用旧快照', async (t) => {
  const { client, endpoint, sockets } = createHarness(t, { httpUrl: 'http://127.0.0.1:3000' })
  const [socket] = sockets
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'ok', data: {} }))
  const transport = client.captureTransport()
  await assert.rejects(transport.call('send_private_msg', {}, {
    beforeDispatch: () => { endpoint.httpToken = 'changed' },
  }), { code: 'ONEBOT_TRANSPORT_CHANGED' })
  assert.equal(transport.isCurrent(), false)
  assert.equal(fetch.mock.callCount(), 0)
  endpoint.httpToken = ''
  assert.equal(transport.isCurrent(), true)
  client.restart()
  socket.finishClose()
  sockets[1].open()
  assert.equal(transport.isCurrent(), false)
  await assert.rejects(transport.call('send_private_msg', {}), { code: 'ONEBOT_TRANSPORT_CHANGED' })
  assert.equal(socket.frames.length, 0)
  assert.equal(sockets[1].frames.length, 0)
  assert.equal(fetch.mock.callCount(), 0)
})
