import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickAutoReply, pickDirectRequester, sameNameNote } from '../src/chat/group-policy.js'

const msg = (uid, mid, direct = false, nick = '小明') => ({ uid, mid, direct, nick })

test('只有一个人说话且 @ 了她：自动引用并 @', () => {
  assert.deepEqual(pickAutoReply([msg('1', 'a'), msg('1', 'b', true)]), { mid: 'b', uid: '1' })
})

test('多人说话时不自动 @，哪怕只有一个人 @ 了她（#160 情况 2）', () => {
  assert.equal(pickAutoReply([msg('2', 'a'), msg('3', 'b', true)]), null)
})

test('没人 @ 她不自动引用', () => {
  assert.equal(pickAutoReply([msg('1', 'a')]), null)
  assert.equal(pickAutoReply([]), null)
})

test('唯一直接请求者不受同批普通群聊和自动引用策略影响', () => {
  const fresh = [msg('2', 'a'), msg('1', 'b', true), msg('2', 'c')]
  assert.equal(pickAutoReply(fresh), null)
  assert.deepEqual(pickDirectRequester(fresh), { mid: 'b', uid: '1' })
})

test('多个直接请求者、没有直接请求、无真实消息 ID 均不选请求者', () => {
  for (const fresh of [[], [msg('1', 'a')], [msg('1', 'a', true), msg('2', 'b', true)], [msg('1', '0', true)]]) {
    assert.equal(pickDirectRequester(fresh), null)
  }
})

test('重名才提醒，名字不同或同一个人不提醒', () => {
  assert.match(sameNameNote([msg('1', 'a'), msg('2', 'b')]), /「小明」.*不同的人/)
  assert.equal(sameNameNote([msg('1', 'a'), msg('1', 'b')]), '')
  assert.equal(sameNameNote([msg('1', 'a'), msg('2', 'b', false, '小红')]), '')
})
