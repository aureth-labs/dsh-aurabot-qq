// 「免打扰」：这段时间只有主人的消息能进，群里其他人 @、引用、唤醒词、追问都不起轮次。
// 与 quietHours 正交——那个管她别插话（对主人），这个管别人别叫醒她。
import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_GROUP_POLICY, decideGroupReply, policyFor } from '../src/chat/group-policy.js'

// 本地时间构造，避免时区把分钟算歪
const at = (h, m = 0) => new Date(2026, 0, 1, h, m, 0, 0).getTime()

function ask(over = {}) {
  return decideGroupReply({
    policy: { ...DEFAULT_GROUP_POLICY, ...(over.policy || {}) },
    mentioned: false,
    repliedToBot: false,
    fromOwner: false,
    lastIsBot: false,
    atOthersAny: false,
    text: '随便聊聊',
    now: at(12, 0),
    hour: 12,
    recentTimes: [],
    interjectTimes: [],
    botReplyTimes: [],
    mustTimes: [],
    ...over,
  })
}

test('没配窗口时不影响任何人', () => {
  assert.equal(DEFAULT_GROUP_POLICY.guestQuietFrom, null)
  assert.equal(DEFAULT_GROUP_POLICY.guestQuietTo, null)
  const out = ask({ mentioned: true, now: at(3), hour: 3 })
  assert.equal(out.reply, true)
  assert.equal(out.mode, 'must')
})

test('窗口内客人被 @ 也不起轮次', () => {
  const policy = { guestQuietFrom: '01:00', guestQuietTo: '08:00' }
  const out = ask({ policy, mentioned: true, now: at(3), hour: 3 })
  assert.equal(out.reply, false)
  assert.match(out.reason, /免打扰|静默/)
})

test('窗口内主人被 @ 照常叫得动', () => {
  const policy = { guestQuietFrom: '01:00', guestQuietTo: '08:00' }
  const out = ask({ policy, mentioned: true, fromOwner: true, now: at(3), hour: 3 })
  assert.equal(out.reply, true)
  assert.equal(out.mode, 'must')
})

test('窗口内叫名字、引用她的消息同样挡住', () => {
  const policy = { guestQuietFrom: '01:00', guestQuietTo: '08:00', wakeWords: ['大肥鱼'] }
  const byName = ask({ policy, text: '大肥鱼在吗', now: at(3), hour: 3 })
  assert.equal(byName.reply, false)
  const byQuote = ask({ policy, repliedToBot: true, now: at(3), hour: 3 })
  assert.equal(byQuote.reply, false)
})

test('窗口外不受影响', () => {
  const policy = { guestQuietFrom: '01:00', guestQuietTo: '08:00' }
  const out = ask({ policy, mentioned: true, now: at(12), hour: 12 })
  assert.equal(out.reply, true)
  assert.equal(out.mode, 'must')
})

test('跨夜窗口两头都算窗口内', () => {
  const policy = { guestQuietFrom: '23:00', guestQuietTo: '08:00' }
  assert.equal(ask({ policy, mentioned: true, now: at(2), hour: 2 }).reply, false)
  assert.equal(ask({ policy, mentioned: true, now: at(23), hour: 23 }).reply, false)
  assert.equal(ask({ policy, mentioned: true, now: at(12), hour: 12 }).reply, true)
})

test('按分钟判定，不是整点', () => {
  const policy = { guestQuietFrom: '01:30', guestQuietTo: '08:00' }
  assert.equal(ask({ policy, mentioned: true, now: at(1, 15), hour: 1 }).reply, true)
  assert.equal(ask({ policy, mentioned: true, now: at(1, 30), hour: 1 }).reply, false)
  assert.equal(ask({ policy, mentioned: true, now: at(7, 59), hour: 7 }).reply, false)
  assert.equal(ask({ policy, mentioned: true, now: at(8, 0), hour: 8 }).reply, true)
})

test('单群覆盖能单独开关', () => {
  const global = { ...DEFAULT_GROUP_POLICY, guestQuietFrom: null, guestQuietTo: null }
  const overrides = { 12345: { guestQuietFrom: '01:00', guestQuietTo: '08:00' } }
  const quiet = policyFor(global, overrides, 12345)
  assert.equal(quiet.guestQuietFrom, '01:00')
  assert.equal(ask({ policy: quiet, mentioned: true, now: at(3), hour: 3 }).reply, false)
  const other = policyFor(global, overrides, 99999)
  assert.equal(other.guestQuietFrom, null)
  assert.equal(ask({ policy: other, mentioned: true, now: at(3), hour: 3 }).reply, true)
})
