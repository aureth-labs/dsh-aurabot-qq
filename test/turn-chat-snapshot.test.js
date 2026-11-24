// #159：turn/end 定址不能只靠内存映射——回合开始时把 chatId 记在 turnState 上，
// 结束时按「快照 > 内存映射 > sessions.json」取，会话中途被重置或映射被清也不会丢轮次/串聊天。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = () => readFileSync(new URL('../src/chat/hub.js', import.meta.url), 'utf8')

test('pushToSession 在回合开始时快照 chatId', () => {
  const src = source()
  assert.match(src, /st\.chatId = chat\.chatId/, '回合开始时要把 chatId 记到 turnState 上')
})

test('turn/end 定址优先级：快照 > 内存映射 > sessions.json', () => {
  const src = source()
  assert.match(src, /const snap = turnState\.get\(key\)\?\.chatId/)
  assert.match(src, /const chatId = snap \|\| sessionToChat\.get\(key\) \|\| found\?\.chatId/)
})
