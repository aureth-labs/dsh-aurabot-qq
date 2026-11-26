import test from 'node:test'
import assert from 'node:assert/strict'
import { registerSharedTurnGuard } from '../src/chat/shared-turn-guard.js'

const user = id => ({ id, role: 'user', source: { kind: 'aurabot' }, content: [{ type: 'text', text: id }] })
const hostContext = { ...user('runtime'), source: { kind: 'runtime-context' } }

function fixture() {
  const turn = { dshTurn: 1, message: user('first'), injectedMessages: new Map() }
  const acceptedCalls = []
  let listen
  registerSharedTurnGuard({ on: (_event, handler) => { listen = handler } }, {
    lookup: () => turn,
    isAuthorized: () => true,
    onAccepted(_active, info) { acceptedCalls.push(info) },
    onRejected() {},
  })
  const step = (step, messages, downstream = messages) => listen(
    { step, turn: 1, messages, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: downstream }),
  )
  const register = (message, claimed = true) => {
    turn.injectedMessages.set(message.id, { message: structuredClone(message), claimed, accepted: false })
  }
  return { turn, step, register, acceptedCalls }
}

test('共享守卫核对首条与每一步中真实领取的插入批次', async () => {
  const { turn, step, register, acceptedCalls } = fixture()
  const second = user('second')
  const third = user('third')
  register(second)
  register(third)
  assert.equal((await step(1, [turn.message, second])).kind, 'reject')
  assert.equal((await step(1, [turn.message], [turn.message, hostContext])).kind, 'enter')
  assert.deepEqual(acceptedCalls.at(-1), { first: true, acceptedSteers: [] })
  assert.equal((await step(2, [third, second])).kind, 'reject')
  assert.equal((await step(2, [second, third], [second])).kind, 'reject')
  assert.equal((await step(2, [second, third], [second, hostContext, third])).kind, 'enter')
  assert.equal(acceptedCalls.at(-1).first, false)
  assert.deepEqual(acceptedCalls.at(-1).acceptedSteers.map(e => e.message.id), ['second', 'third'])
  assert.equal((await step(3, [second])).kind, 'reject')
  assert.equal((await step(3, [turn.message])).kind, 'reject')
  assert.equal((await step(3, [], [hostContext])).kind, 'enter')
  assert.deepEqual(acceptedCalls.at(-1), { first: false, acceptedSteers: [] })
})

test('共享守卫拒绝未领取、修改、替换和移除登记的普通消息', async () => {
  const { turn, step, register } = fixture()
  const second = user('second')
  register(second, false)
  assert.equal((await step(2, [second])).kind, 'reject')
  turn.injectedMessages.get(second.id).claimed = true
  assert.equal((await step(2, [second], [{ ...second, source: { kind: 'user' } }])).kind, 'reject')
  assert.equal((await step(2, [{ ...second, content: user('改写').content }])).kind, 'reject')
  assert.equal((await step(2, [second], [user('unknown')])).kind, 'reject')
  turn.injectedMessages.delete(second.id)
  assert.equal((await step(2, [second])).kind, 'reject')
})
