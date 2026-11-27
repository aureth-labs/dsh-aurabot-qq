import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { clockAt, clockLabel } from '../src/chat/reply.js'
import { flatHistory } from '../src/chat/identity.js'

test('钟点统一按东八区压成 HH:MM', () => {
  assert.equal(clockAt(Date.UTC(2026, 10, 9, 13, 34)), '21:34')
  assert.equal(clockAt(Date.UTC(2026, 10, 9, 0, 5)), '08:05')
  assert.equal(clockAt(Date.UTC(2026, 10, 9, 16, 1)), '00:01')
  assert.match(clockAt(), /^\d{2}:\d{2}$/)
  // 脏输入不该把提示词弄成 NaN
  assert.match(clockAt(undefined), /^\d{2}:\d{2}$/)
  assert.match(clockAt(0), /^\d{2}:\d{2}$/)
})

test('私聊与群聊拼提示词时都带上钟点', () => {
  const hub = readFileSync(new URL('../src/chat/hub.js', import.meta.url), 'utf8')
  // 私聊：钟点放在【私聊】之后，这样「去掉【私聊】某某(QQ)：头」的旧正则还能用
  assert.ok(
    hub.includes('`【私聊】[${clockLabel(now)}] ${msg.nickname}(${msg.userId})：`'),
    '私聊正文应挂 [HH:MM]',
  )
  // 群聊：每行都挂，之前的背景句和这一段新说的话都算
  assert.ok(hub.includes('const line = (x) => `[${clockLabel(x.t)}] ${x.nick}'), '群聊每行应挂 [HH:MM]')
  // 引入不必逐字对上（不同分支的 import 还带着 itemsToLine 之类），只要求从 reply.js 引进来
  assert.match(hub, /import \{[^}]*\bclockLabel\b[^}]*\} from '\.\/reply\.js'/)
})

test('跨天时补日期：昨天 / 更早 / 跨年', async () => {
  const { clockLabel } = await import('../src/chat/reply.js')
  // 以东八区 2026-11-09 23:34 为「现在」
  const now = Date.UTC(2026, 10, 9, 15, 34) // 23:34 +08
  assert.equal(clockLabel(Date.UTC(2026, 10, 9, 15, 0), now), '23:00')            // 当天
  assert.equal(clockLabel(Date.UTC(2026, 10, 8, 15, 5), now), '昨天 23:05')       // 前一天
  assert.equal(clockLabel(Date.UTC(2026, 10, 6, 1, 30), now), '11-06 09:30')      // 更早
  assert.equal(clockLabel(Date.UTC(2025, 11, 31, 15, 59), now), '2025-12-31 23:59') // 跨年
  // 跨午夜：23:50 与次日 00:10 必须能分出新旧
  const after = Date.UTC(2026, 10, 9, 16, 10) // 次日 00:10 +08
  assert.equal(clockLabel(Date.UTC(2026, 10, 9, 15, 50), after), '昨天 23:50')
  assert.equal(clockLabel(Date.UTC(2026, 10, 9, 16, 5), after), '00:05')
})

test('补看历史与跨会话转达也带时间标签', () => {
  const hub = readFileSync(new URL('../src/chat/hub.js', import.meta.url), 'utf8')
  // 补读已提取到 identity.js：检查调用方传入时钟，并直接验证历史日期行为。
  assert.match(hub, /flatHistory\(filterHistory\(chat.chatId, list\), selfId \|\| cfg.botQQ, \{ clockLabel \}\)/)
  const now = Date.UTC(2026, 10, 9, 15, 34)
  const rows = flatHistory([
    { user_id: 10002, time: Date.UTC(2026, 10, 8, 15, 5) / 1000, message: '昨天的消息' },
    { user_id: 10002, message: '缺少时间的消息' },
  ], '10001', { clockLabel: at => clockLabel(at, now) })
  assert.match(rows[0], /^昨天 23:05 群友·10002\(10002\)：昨天的消息$/)
  assert.match(rows[1], /^群友·10002\(10002\)：缺少时间的消息$/)
  // 跨会话转达：原来只有 HH:MM，跨天会错
  assert.match(hub, /earlier\.map\(\(x\) => `\$\{clockLabel\(x\.at\)\} 你：\$\{x\.text\}`\)/)
  assert.doesNotMatch(hub, /toTimeString\(\)\.slice\(0, 5\)/)
})

test('秒级时间戳（OneBot 的 time）也能喂给 clockLabel', async () => {
  const { clockLabel } = await import('../src/chat/reply.js')
  const now = Date.UTC(2026, 10, 9, 15, 34) // 东八区 11-09 23:34
  const sec = Math.floor(Date.UTC(2026, 10, 8, 15, 5) / 1000) * 1000
  assert.equal(clockLabel(sec, now), '昨天 23:05')
})
