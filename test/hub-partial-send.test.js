// #349：网关中途断开时，流水不能把没发出去的半截记成「她说过的话」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const HUB = () => readFileSync(new URL('../src/chat/hub.js', import.meta.url), 'utf8')

test('流水只记实际发出去的条目，不记打算发的全部', () => {
  const src = HUB()
  assert.match(src, /const sentItems = \[\]/, '要维护一份真正发出去的条目')
  assert.match(src, /itemsToLine\(sentItems/, 'logChat 必须用 sentItems 而不是 items')
  assert.doesNotMatch(src, /const said = itemsToLine\(items,/, '旧的 itemsToLine(items) 不能再出现')
})

test('部分失败要留痕（日志里能看出少了几段）', () => {
  const src = HUB()
  assert.match(src, /这一轮有 \$\{unattempted\}\/\$\{items\.length\} 段没发出去/, '部分失败要 warn 出丢了几段')
})

test('lastBotToOwner 也只记真发出去的内容', () => {
  const src = HUB()
  assert.match(src, /lastBotToOwner = \{ at: Date\.now\(\), text: sentItems\.filter/, 'lastBotToOwner 要用 sentItems')
})
