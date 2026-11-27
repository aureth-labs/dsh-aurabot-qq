import { test } from 'node:test'
import assert from 'node:assert/strict'
import module, { isInputRejection } from '../src/modules/input-rejection-notice/index.js'

const end = (seq, message = 'gateway (HTTP 400, SensitiveContentDetected)') => ({ type: 'turn/end', seq,
  data: { reason: message ? { kind: 'error', error: { code: 'INVALID_REQUEST', message } } : { kind: 'completed' } } })
const settle = () => new Promise(setImmediate)
function fixture({ chat = 'group:123', owner = '456', fail = false } = {}) {
  const sends = [], warnings = [], session = { id: 's' }
  let listener, dispose
  const service = module.setup({
    dsh: { on: (_, fn) => { listener = fn; return () => { listener = null } } },
    core: { hub: { chatOfSession: () => chat } }, config: () => ({ enabled: true, ownerQQ: owner }),
    log: { warn: msg => warnings.push(msg) }, onDispose: fn => { dispose = fn },
    sendText: async (...args) => { sends.push(args); if (fail) throw Error('offline') },
  })
  return { sends, warnings, service, emit: event => listener?.(session, event), stop: () => dispose(), rebind: () => { chat = '' } }
}
test('only explicit gateway input rejection qualifies', () => {
  assert.equal(isInputRejection(end(1)), true)
  for (const text of ['timeout', 'HTTP 429', 'sensitive image', 'account blocked']) assert.equal(isInputRejection(end(1, text)), false)
  assert.equal(isInputRejection(end(1, '')), false)
  const e = end(1); e.data.reason.failure = e.data.reason.error; delete e.data.reason.error
  assert.equal(isInputRejection(e), true)
})
test('two different failures notify the owner once; success resets the streak', async () => {
  const f = fixture(), e = end(1)
  f.emit(e); f.emit(e); f.emit(end(1)); await settle(); assert.equal(f.sends.length, 0)
  f.emit(end(2)); f.emit(end(3)); await settle()
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0][0], 'private:456')
  assert.match(f.sends[0][1], /群 123/)
  f.emit(end(4, '')); f.emit(end(5)); f.emit(end(6)); await settle(); assert.equal(f.sends.length, 2)
  f.stop()
})
test('unrelated failures break the streak; unmanaged chats and missing owner do not send', async () => {
  const f = fixture(); f.emit(end(1)); f.emit(end(2, 'HTTP 429')); f.emit(end(3)); await settle(); assert.equal(f.sends.length, 0); f.stop()
  for (const opts of [{chat: ''}, {chat: 'system:memory'}, {owner: ''}]) {
    const f = fixture(opts); f.emit(end(1)); f.emit(end(2)); await settle(); assert.equal(f.sends.length, 0); f.stop()
  }
})
test('queued notice cannot outlive disposal, recovery or conversation reset', async () => {
  for (const action of [f => f.stop(), f => f.rebind(), f => f.emit(end(3, ''))]) {
    const f = fixture(); f.emit(end(1)); f.emit(end(2)); action(f); await settle(); assert.equal(f.sends.length, 0)
  }
})
test('notification failure stays isolated and does not repeatedly notify', async () => {
  const f = fixture({fail: true}); f.emit(end(1)); f.emit(end(2)); await settle(); f.emit(end(3)); await settle()
  assert.equal(f.sends.length, 1); assert.match(f.warnings.at(-1), /未送达/); f.stop()
})
