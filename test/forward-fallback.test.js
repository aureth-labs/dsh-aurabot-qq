// #526：合并转发展开的回退顺序
//   1) 事件里自带 content → 直接用，一次接口都不调
//   2) 否则依次试 外层 message_id（outerId）→ 段内 id（私聊送达时 res_id 必失败，外层才解析）
//   3) status=ok 但 messages=[] 是空壳，不能当成成功，要换下一个候选
//   4) 一条都拉不到时给能看懂原因的占位，不再只写「内容没拉到」
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FORWARD_NOT_EXPANDED, forwardBody, readForward,
} from '../src/chat/forward.js'
import { parseMessageEvent } from '../src/chat/inbound.js'

const node = (name, message) => ({ sender: { nickname: name, user_id: 2 }, message })
const text = (t) => ({ type: 'text', data: { text: t } })

/** 记下每次 get_forward_msg 的 id，方便断言「调了几次、调了谁」。 */
function countingGateway(map) {
  const calls = []
  return {
    calls,
    call: async (action, params) => {
      calls.push(params.id)
      return { messages: map[params.id] || [] }
    },
  }
}

test('content 非空时不调 get_forward_msg（0 次接口调用）', async () => {
  const gw = countingGateway({})
  const r = await readForward(gw, { id: 'inner', outerId: 'outer', content: [node('甲', [text('自带内容')])] }, { selfId: 9 })
  assert.equal(gw.calls.length, 0)
  assert.equal(r.lines.length, 1)
  assert.match(r.lines[0], /自带内容/)
})

test('outerId 命中即停，不再试段内 id', async () => {
  const gw = countingGateway({
    outer: [node('乙', [text('外层 id 拿到的')])],
    inner: [node('丙', [text('不该走到这里')])],
  })
  const r = await readForward(gw, { id: 'inner', outerId: 'outer' }, { selfId: 9 })
  assert.deepEqual(gw.calls, ['outer'])
  assert.match(r.lines[0], /外层 id 拿到的/)
})

test('status=ok 但 messages 为空是空壳，要换下一个候选', async () => {
  const gw = countingGateway({
    outer: [], // 空壳
    inner: [node('丁', [text('第二个候选拿到的')])],
  })
  const r = await readForward(gw, { id: 'inner', outerId: 'outer' }, { selfId: 9 })
  assert.deepEqual(gw.calls, ['outer', 'inner'])
  assert.match(r.lines[0], /第二个候选拿到的/)
})

test('一条都拉不到时，占位文案能看出原因', async () => {
  const gw = countingGateway({})
  const r = await readForward(gw, { id: 'x', outerId: 'y' }, { selfId: 9 })
  assert.equal(r.lines.length, 0)
  const body = forwardBody(r)
  assert.equal(body, FORWARD_NOT_EXPANDED)
  assert.match(body, /已过期/)
  assert.match(body, /风控/)
})

test('字符串入参保持兼容（老的引用路径传的就是 id）', async () => {
  const gw = countingGateway({ a: [node('戊', [text('老调用方')])] })
  const r = await readForward(gw, 'a', { selfId: 9 })
  assert.deepEqual(gw.calls, ['a'])
  assert.match(r.lines[0], /老调用方/)
})

test('嵌套转发里只有 content 的那一层不调接口', async () => {
  const gw = countingGateway({ outer: [] })
  const outerNode = node('己', [{ type: 'forward', data: { content: [node('庚', [text('内层自带内容')])] } }])
  const r = await readForward(gw, { id: '', outerId: 'outer', content: [outerNode] }, { selfId: 9 })
  assert.equal(gw.calls.length, 0)
  assert.ok(r.lines.some((l) => l.includes('内层自带内容')))
})

test('inbound 把外层 message_id 和 content 一起带下去', () => {
  const seg = { type: 'forward', data: { id: 'seg-id', content: [node('辛', [text('节点')])] } }
  const m = parseMessageEvent({ message_type: 'private', user_id: 7, message_id: 'outer-msg', message: [seg] }, 9)
  assert.equal(m.forwards.length, 1)
  const [ref] = m.forwards
  assert.equal(ref.id, 'seg-id')
  assert.equal(ref.outerId, 'outer-msg')
  assert.ok(Array.isArray(ref.content) && ref.content.length === 1)
})
