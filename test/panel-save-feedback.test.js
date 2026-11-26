// #89：面板保存点击必须给反馈，异常不能静默；重复点击也不能叠并发保存。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
const start = src.indexOf('const saveImpl = async (override) => {')
const end = src.indexOf('      saveRef.current = save', start)
assert.ok(start > 0 && end > start, '找不到面板 save 实现')
const block = src.slice(start, end)
const wrapperStart = src.indexOf('const save = async (override) => {', start)

test('面板保存有异常兜底、重复点击保护和反馈', () => {
  assert.ok(wrapperStart > 0 && wrapperStart < end, '缺 save 包装器')
  assert.match(src.slice(wrapperStart, end), /savingRef\.current/)
  assert.match(src.slice(wrapperStart, end), /保存失败：/)
})
