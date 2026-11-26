import { test } from 'node:test'
import assert from 'node:assert/strict'
import definition, { isImageRejection, lastImageRejection, imageTargets } from '../src/modules/image-recovery/index.js'

const image = (offloaded = false) => ({ type: 'image', attachment: { attachmentId: 'fixture' }, ...(offloaded ? { offloaded: true } : {}) })
const text = { type: 'text', text: '保留的文字' }
const rejection = (seq = 3, message = "lhub-minimax-lite: input new_sensitive, messages[456]'s content[5] image is sensitive, please check your input (1026)") =>
  ({ seq, type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'PI_AI_ERROR', message } } } })
const gatewayMessage = 'gateway: the content of image_url.url field is unsafe'
const user = (seq, content) => ({ seq, type: 'user/message', data: { role: 'user', content } })
const end = { seq: 4, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } }
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(setImmediate) }

function fixture(events = [user(0, [text, image(true), image()]), rejection()], { owned = true, delay } = {}) {
  const listeners = new Map(), disposers = [], appended = [], logs = []
  const messages = new Map(events.filter(x => x.type === 'user/message').map(e => [e.seq, structuredClone(e.data)]))
  let released = 0, flushed = 0, publishing = false
  const session = { id: 'session-fixture', surface: {
    nodes: [...messages.keys()], deriveEventMessage: e => messages.get(e.seq),
  }, append(type, data) {
    assert.equal(publishing, false, 'must not append reentrantly from session/event')
    assert.equal(type, 'image/offload')
    for (const t of data.targets) {
      let i = 0
      for (const b of messages.get(t.seq).content) if (b.type === 'image') {
        if (t.imageIndexes.includes(i)) { assert.notEqual(b.offloaded, true); b.offloaded = true }
        i++
      }
    }
    appended.push(data)
  } }
  const api = { log: Object.fromEntries(['info', 'warn'].map(k => [k, msg => logs.push(msg)])),
    core: { hub: { chatOfSession: () => owned ? 'group:12345' : '', sessions: () => owned ? { 'group:12345': { sessionId: session.id } } : {} } },
    onDispose: fn => disposers.push(fn),
    dsh: { sessions: { get: id => id === session.id ? session : undefined, flush: async () => { flushed++ } },
      get: () => ({ observeSession: async () => {
        if (delay) await delay
        return { events, [Symbol.dispose]: () => { released++ } }
      } }),
      on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name) },
    },
  }
  return { api, session, appended, messages, logs, events,
    counts: () => ({ released, flushed }),
    emit: event => { publishing = true; listeners.get('session/event')?.(session, event); publishing = false },
    stop: () => disposers.forEach(fn => fn()),
  }
}

test('only the observed explicit input-image moderation error qualifies', () => {
  assert.equal(isImageRejection(rejection()), true)
  assert.equal(isImageRejection(rejection(3, gatewayMessage)), true)
  for (const msg of ['network timeout', '500 server error', 'text is sensitive (1026)', 'text content is sensitive', 'account blocked', 'content policy violation', 'unsafe', 'image_url.url download blocked', 'the content of image_url.url field is not unsafe', 'output new_sensitive, image is sensitive (1026)']) assert.equal(isImageRejection(rejection(3, msg)), false, msg)
  const wrongCode = rejection(3, gatewayMessage)
  wrongCode.data.reason.error.code = 'TRANSPORT'
  assert.equal(isImageRejection(wrongCode), false)
  assert.equal(isImageRejection({ type: 'assistant/message', data: rejection(3, gatewayMessage).data }), false)
  assert.equal(isImageRejection(end), false)
  assert.equal(lastImageRejection([rejection(), end]), null)
  assert.equal(lastImageRejection([rejection(), { type: 'turn/start' }]), null)
})

test('legacy gateway rejection restores an idle failed session while preserving text and raw history', async () => {
  const f = fixture([user(0, [text, image()]), rejection(3, gatewayMessage)])
  const original = JSON.stringify(f.events), service = definition.setup(f.api)
  await settle()
  assert.deepEqual(f.appended, [{ targets: [{ seq: 0, imageIndexes: [0] }] }])
  assert.equal(JSON.stringify(f.events), original)
  assert.equal(f.messages.get(0).content[0].text, text.text)
  assert.deepEqual(service.status(), { recovered: 1, omitted: 1, pending: 0 })
  assert.deepEqual(f.counts(), { released: 1, flushed: 1 })
  f.stop()
})

test('live gateway rejection also accepts reason.failure and excludes later images', async () => {
  const f = fixture([user(0, [text, image()]), end]), service = definition.setup(f.api)
  await settle()
  const error = rejection(6, gatewayMessage)
  error.data.reason.failure = error.data.reason.error
  delete error.data.reason.error
  f.events.push(error); f.emit(error)
  const fresh = user(7, [image()]); f.events.push(fresh)
  f.messages.set(7, structuredClone(fresh.data)); f.session.surface.nodes.push(7)
  await settle()
  assert.deepEqual(f.appended, [{ targets: [{ seq: 0, imageIndexes: [0] }] }])
  assert.equal(f.messages.get(7).content[0].offloaded, undefined)
  f.emit(error); await settle()
  assert.equal(f.appended.length, 1)
  assert.deepEqual(service.status(), { recovered: 1, omitted: 1, pending: 0 })
  f.stop()
})

test('text moderation and account blocks never drop images even when images are present', async () => {
  for (const message of ['text content is sensitive', 'account blocked', 'content policy violation', 'image_url.url download blocked']) {
    const f = fixture([user(0, [text, image()]), end])
    definition.setup(f.api); await settle()
    const error = rejection(6, message); f.events.push(error); f.emit(error); await settle()
    assert.equal(f.appended.length, 0, message)
    assert.equal(f.messages.get(0).content[1].offloaded, undefined)
    f.stop()
  }
})

test('gateway rejection without retained images is a no-op', async () => {
  for (const content of [[text], [text, image(true)]]) {
    const f = fixture([user(0, content), rejection(3, gatewayMessage)])
    const service = definition.setup(f.api); await settle()
    assert.equal(f.appended.length, 0)
    assert.deepEqual(service.status(), { recovered: 0, omitted: 0, pending: 0 })
    assert.deepEqual(f.counts(), { released: 1, flushed: 0 })
    f.stop()
  }
})

test('target only current input images before failure; preserve image indexes and new input', () => {
  const events = [user(0, [text, image(true), image()]), user(1, [image()]), user(5, [image()]), { seq: 2, type: 'assistant/message' }, { seq: 3, type: 'tool/result' }]
  const s = { surface: { nodes: [0, 2, 3, 5], deriveEventMessage: e => e.type === 'tool/result' ? { content: [text, image()] } : e.data } }
  assert.deepEqual(imageTargets(s, events, 4), [{ seq: 0, imageIndexes: [1] }, { seq: 3, imageIndexes: [0] }])
})

test('startup restores a previously stuck session without resetting history or sending anything', async () => {
  const f = fixture(), original = JSON.stringify(f.events), service = definition.setup(f.api)
  await settle()
  assert.deepEqual(f.appended, [{ targets: [{ seq: 0, imageIndexes: [1] }] }])
  assert.equal(JSON.stringify(f.events), original)
  assert.equal(f.messages.get(0).content[0].text, text.text)
  assert.deepEqual(f.counts(), { released: 1, flushed: 1 })
  assert.deepEqual(service.status(), { recovered: 1, omitted: 1, pending: 0 })
  f.stop()
})

test('live rejection yields beyond event publication and clears old images once', async () => {
  const f = fixture([user(0, [image()]), end]), service = definition.setup(f.api)
  await settle(); assert.equal(f.appended.length, 0)
  const error = rejection(6); f.events.push(error)
  f.emit(error); f.emit(error)
  await settle()
  assert.equal(f.appended.length, 1); assert.equal(service.status().pending, 0)
  f.emit(error); await settle(); assert.equal(f.appended.length, 1)
  f.stop()
})

test('new images admitted while observation is pending survive recovery', async () => {
  let release
  const wait = new Promise(r => { release = r })
  const f = fixture(undefined, { delay: wait }); definition.setup(f.api)
  const fresh = user(5, [image()]); f.events.push(fresh); f.messages.set(5, structuredClone(fresh.data)); f.session.surface.nodes.push(5)
  release(); await settle()
  assert.equal(f.messages.get(5).content[0].offloaded, undefined)
  assert.equal(f.appended[0].targets.some(t => t.seq === 5), false)
  f.stop()
})

test('a stopped module releases its observation without writing late changes', async () => {
  let release; const wait = new Promise(r => { release = r })
  const f = fixture(undefined, { delay: wait }); definition.setup(f.api); f.stop(); release(); await settle()
  assert.equal(f.appended.length, 0); assert.equal(f.counts().released, 1)
})

test('other DSH sessions and ordinary errors are not changed', async () => {
  const f = fixture(undefined, { owned: false }); definition.setup(f.api); f.emit(rejection()); await settle()
  assert.equal(f.appended.length, 0); assert.equal(f.counts().released, 0); f.stop()
  const g = fixture([user(0, [image()]), rejection(3, 'fetch failed')]); definition.setup(g.api); await settle()
  assert.equal(g.appended.length, 0); g.stop()
})

test('recovery failures release leases and pending state without erasing history', async () => {
  const f = fixture(); f.session.append = () => { throw Error('projection unavailable') }
  const service = definition.setup(f.api); await settle()
  assert.equal(f.counts().released, 1); assert.equal(service.status().pending, 0)
  assert.equal(f.messages.get(0).content[2].offloaded, undefined); assert.equal(f.logs.length, 1); f.stop()
})
