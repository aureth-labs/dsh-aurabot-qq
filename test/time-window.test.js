// 日窗口纯函数测试：穷举小时，覆盖跨天、24:00/0:00 边界与 from==to 全天约定。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  inHourWindow, isFullDayWindow, nextWindowStart, quietWindowOf, inMinuteWindow, windowMinutes,
} from '../src/core/time-window.js'

const at = (h, m = 30) => new Date(2026, 0, 5, h, m, 0, 0)
const norm = (x) => ((x % 24) + 24) % 24

/** 独立实现的期望值：from === to（24:00 与 0:00 同端点）全天；否则左闭右开、跨天绕回。 */
function expected(h, from, to) {
  const f = norm(from)
  const t = norm(to)
  if (f === t) return true
  return f < t ? h >= f && h < t : h >= f || h < t
}

test('inHourWindow：穷举 0–23 点 × 0–24 起止，跨天 / 全天 / 24 点边界都对', () => {
  for (let from = 0; from <= 24; from++) {
    for (let to = 0; to <= 24; to++) {
      for (let h = 0; h < 24; h++) {
        assert.equal(inHourWindow(at(h), from, to), expected(h, from, to), `${from}→${to} @ ${h}:30`)
      }
    }
  }
})

test('inHourWindow：典型跨天窗口 9:00–次日 3:00', () => {
  for (const h of [9, 12, 18, 23, 0, 1, 2]) assert.equal(inHourWindow(at(h), 9, 3), true, `${h} 点应醒着`)
  for (const h of [3, 4, 8]) assert.equal(inHourWindow(at(h), 9, 3), false, `${h} 点应睡着`)
  // 边界：3:00 整点关窗、9:00 整点开窗
  assert.equal(inHourWindow(at(3, 0), 9, 3), false)
  assert.equal(inHourWindow(at(8, 59), 9, 3), false)
  assert.equal(inHourWindow(at(9, 0), 9, 3), true)
  assert.equal(inHourWindow(at(2, 59), 9, 3), true)
})

test('inHourWindow / isFullDayWindow：24:00 当终点，from==to 才是全天', () => {
  // 9:00–24:00 是到当天结束，不是全天
  assert.equal(inHourWindow(at(23), 9, 24), true)
  assert.equal(inHourWindow(at(3), 9, 24), false)
  // 0:00–24:00 / 0:00–0:00 / 8:00–8:00 都是全天（沿用 proactive-policy 的约定）
  assert.equal(inHourWindow(at(3), 0, 24), true)
  assert.equal(inHourWindow(at(3), 0, 0), true)
  assert.equal(inHourWindow(at(3), 8, 8), true)
  assert.equal(isFullDayWindow(8, 8), true)
  assert.equal(isFullDayWindow(0, 24), true)
  assert.equal(isFullDayWindow(9, 24), false)
  // 23:00–24:00 只覆盖 23 点
  assert.equal(inHourWindow(at(23), 23, 24), true)
  assert.equal(inHourWindow(at(0), 23, 24), false)
  // 23:00–0:00 与 23:00–24:00 等价
  assert.equal(inHourWindow(at(23), 23, 0), true)
  assert.equal(inHourWindow(at(0), 23, 0), false)
})

test('nextWindowStart：严格晚于 at，跨天窗口每天从 from 点重新开始', () => {
  assert.equal(nextWindowStart(at(2).getTime(), 9), new Date(2026, 0, 5, 9, 0, 0).getTime(), '凌晨 2 点 → 当天 9 点')
  assert.equal(nextWindowStart(at(9).getTime(), 9), new Date(2026, 0, 6, 9).getTime(), '9 点整 → 次日 9 点')
  assert.equal(nextWindowStart(at(23).getTime(), 22), new Date(2026, 0, 6, 22).getTime(), '23 点 → 次日 22 点')
  assert.equal(nextWindowStart(new Date(2026, 0, 5, 0, 30, 0).getTime(), 0), new Date(2026, 0, 6, 0, 0, 0).getTime())
})

test('quietWindowOf：醒着窗口的补集，跨天时 9→3 的安静时段是 3 点–9 点', () => {
  assert.deepEqual(quietWindowOf(8, 23), { quietStart: '23:00', quietEnd: '08:00' })
  assert.deepEqual(quietWindowOf(9, 22), { quietStart: '22:00', quietEnd: '09:00' })
  assert.deepEqual(quietWindowOf(9, 3), { quietStart: '03:00', quietEnd: '09:00' })
  assert.deepEqual(quietWindowOf(9, 24), { quietStart: '00:00', quietEnd: '09:00' })
  assert.deepEqual(quietWindowOf(0, 24), { quietStart: '00:00', quietEnd: '00:00' })
  assert.deepEqual(quietWindowOf(8, 8), { quietStart: '00:00', quietEnd: '00:00' })
})

test('inMinuteWindow / windowMinutes：分钟窗口同样支持跨天与 24:00', () => {
  assert.equal(windowMinutes(600, 1410), 810, '10:00–23:30')
  assert.equal(windowMinutes(1320, 120), 240, '22:00–02:00 跨天')
  assert.equal(windowMinutes(600, 600), 1440, 'from==to 全天')
  assert.equal(windowMinutes(600, 1440), 840, '10:00–24:00')
  assert.equal(inMinuteWindow(600, 600, 1410), true)
  assert.equal(inMinuteWindow(1409, 600, 1410), true)
  assert.equal(inMinuteWindow(1410, 600, 1410), false)
  assert.equal(inMinuteWindow(0, 1320, 120), true)
  assert.equal(inMinuteWindow(119, 1320, 120), true)
  assert.equal(inMinuteWindow(120, 1320, 120), false)
  assert.equal(inMinuteWindow(600, 1320, 120), false)
  assert.equal(inMinuteWindow(1439, 600, 1440), true)
  assert.equal(inMinuteWindow(0, 600, 1440), false)
  assert.equal(inMinuteWindow(0, 0, 0), true)
})
